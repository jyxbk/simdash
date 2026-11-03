"""SimDash – sammelt Rundenzeiten aus allen Sims und zeigt sie an.

Der Collector auf dem Gaming-PC schickt jede fertige Runde per POST /api/laps.
Lesen ist im LAN offen, Schreiben braucht den Token aus SIMDASH_TOKEN.
"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import sqlite3
import time
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi import Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("SIMDASH_DB", BASE / "simdash.db"))
TOKEN = os.environ.get("SIMDASH_TOKEN", "")

SCHEMA = """
CREATE TABLE IF NOT EXISTS laps (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    uid          TEXT NOT NULL UNIQUE,
    game         TEXT NOT NULL,
    track        TEXT NOT NULL,
    layout       TEXT NOT NULL DEFAULT '',
    car          TEXT NOT NULL,
    session_uid  TEXT NOT NULL DEFAULT '',
    session_type TEXT NOT NULL DEFAULT '',
    lap_number   INTEGER,
    lap_time_ms  INTEGER NOT NULL,
    valid        INTEGER,            -- 1 gültig, 0 ungültig, NULL unbekannt
    estimated    INTEGER NOT NULL DEFAULT 0,
    outlap       INTEGER NOT NULL DEFAULT 0,
    inlap        INTEGER NOT NULL DEFAULT 0,
    online       INTEGER,
    sectors      TEXT,               -- JSON-Liste in ms
    driver       TEXT NOT NULL DEFAULT '',
    note         TEXT NOT NULL DEFAULT '',
    recorded_at  TEXT NOT NULL,
    received_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_laps_combo ON laps(game, track, layout, car);
CREATE INDEX IF NOT EXISTS idx_laps_recorded ON laps(recorded_at);
-- Verlauf entlang der Runde (Zeit/Tempo/Pedale auf festem Raster), getrennt wegen Größe
CREATE TABLE IF NOT EXISTS lap_traces (
    uid   TEXT PRIMARY KEY REFERENCES laps(uid) ON DELETE CASCADE,
    data  TEXT NOT NULL
);
"""


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with db() as con:
        con.executescript(SCHEMA)


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    try:
        yield con
        con.commit()
    finally:
        con.close()


class Trace(BaseModel):
    step: float = Field(gt=0, le=0.1)
    t: list[int | None] = Field(max_length=1000)
    v: list[float | None] | None = Field(default=None, max_length=1000)
    thr: list[int | None] | None = Field(default=None, max_length=1000)
    brk: list[int | None] | None = Field(default=None, max_length=1000)
    x: list[float | None] | None = Field(default=None, max_length=1000)   # Weltkoordinaten (m)
    z: list[float | None] | None = Field(default=None, max_length=1000)


class LapIn(BaseModel):
    uid: str = Field(min_length=8, max_length=64)
    game: str = Field(min_length=1, max_length=40)
    track: str = Field(min_length=1, max_length=80)
    layout: str = Field(default="", max_length=80)
    car: str = Field(min_length=1, max_length=120)
    session_uid: str = Field(default="", max_length=64)
    session_type: str = Field(default="", max_length=40)
    lap_number: int | None = None
    lap_time_ms: int = Field(gt=0, lt=3 * 3600 * 1000)
    valid: bool | None = None
    estimated: bool = False
    outlap: bool = False
    inlap: bool = False
    online: bool | None = None
    sectors: list[int] | None = None
    driver: str = Field(default="", max_length=80)
    note: str = Field(default="", max_length=200)
    trace: Trace | None = None
    recorded_at: datetime


class NoteIn(BaseModel):
    note: str = Field(default="", max_length=200)


def require_token(authorization: str = Header(default="")) -> None:
    if not TOKEN:
        raise HTTPException(503, "SIMDASH_TOKEN ist auf dem Server nicht gesetzt")
    given = authorization.removeprefix("Bearer ").strip()
    if not secrets.compare_digest(given, TOKEN):
        raise HTTPException(401, "Falscher Token")


def _bool(v: bool | None) -> int | None:
    return None if v is None else int(v)


def row_to_lap(r: sqlite3.Row) -> dict:
    d = dict(r)
    if "has_trace" in d:
        d["has_trace"] = bool(d["has_trace"])
    for k in ("valid", "online"):
        d[k] = None if d[k] is None else bool(d[k])
    for k in ("estimated", "outlap", "inlap"):
        d[k] = bool(d[k])
    d["sectors"] = json.loads(d["sectors"]) if d["sectors"] else None
    return d


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(title="SimDash", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Live: der Collector schickt ~10x/s den aktuellen Zustand, die Oberfläche liest per SSE.
# Nur im Speicher – nach einem Neustart ist einfach nichts live, bis neue Daten kommen.
# ---------------------------------------------------------------------------
LIVE: dict = {"data": None, "at": 0.0, "seq": 0}
LIVE_MAX_BYTES = 16384


def live_view() -> dict:
    age = time.time() - LIVE["at"] if LIVE["at"] else None
    return {"data": LIVE["data"], "age_s": None if age is None else round(age, 2), "seq": LIVE["seq"]}


@app.post("/api/live", dependencies=[Depends(require_token)])
async def post_live(request: Request) -> dict:
    body = await request.body()
    if len(body) > LIVE_MAX_BYTES:
        raise HTTPException(413, "zu groß")
    try:
        data = json.loads(body)
    except ValueError:
        raise HTTPException(400, "kein JSON")
    if not isinstance(data, dict):
        raise HTTPException(400, "Objekt erwartet")
    LIVE.update(data=data, at=time.time(), seq=LIVE["seq"] + 1)
    return {"ok": True}


@app.get("/api/live")
def get_live() -> dict:
    return live_view()


@app.get("/api/live/stream")
async def live_stream(request: Request) -> StreamingResponse:
    async def gen():
        last, beat = -1, 0.0
        yield "retry: 2000\n\n"
        while not await request.is_disconnected():
            now = time.monotonic()
            if LIVE["seq"] != last or now - beat > 2:
                last, beat = LIVE["seq"], now
                yield f"data: {json.dumps(live_view(), separators=(',', ':'))}\n\n"
            await asyncio.sleep(0.05)
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.post("/api/laps", dependencies=[Depends(require_token)])
def add_laps(laps: list[LapIn]) -> dict:
    """Nimmt Runden an. Doppelt geschickte Runden (gleiche uid) werden ignoriert."""
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    added = 0
    with db() as con:
        for lap in laps:
            cur = con.execute(
                """INSERT OR IGNORE INTO laps (uid, game, track, layout, car, session_uid,
                   session_type, lap_number, lap_time_ms, valid, estimated, outlap, inlap,
                   online, sectors, driver, note, recorded_at, received_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    lap.uid, lap.game, lap.track, lap.layout, lap.car, lap.session_uid,
                    lap.session_type, lap.lap_number, lap.lap_time_ms, _bool(lap.valid),
                    int(lap.estimated), int(lap.outlap), int(lap.inlap), _bool(lap.online),
                    json.dumps(lap.sectors) if lap.sectors else None, lap.driver, lap.note,
                    lap.recorded_at.astimezone(timezone.utc).isoformat(timespec="milliseconds"),
                    now,
                ),
            )
            added += cur.rowcount
            if cur.rowcount and lap.trace:
                con.execute("INSERT OR REPLACE INTO lap_traces (uid, data) VALUES (?, ?)",
                            (lap.uid, lap.trace.model_dump_json()))
    return {"received": len(laps), "added": added}


def _filters(game: str | None, track: str | None, car: str | None,
             layout: str | None = None) -> tuple[str, list]:
    where, args = [], []
    for col, val in (("game", game), ("track", track), ("car", car), ("layout", layout)):
        if val:
            where.append(f"{col} = ?")
            args.append(val)
    return (" WHERE " + " AND ".join(where)) if where else "", args


@app.get("/api/laps")
def list_laps(
    game: str | None = None,
    track: str | None = None,
    car: str | None = None,
    layout: str | None = None,
    limit: int = Query(default=100, ge=1, le=5000),
) -> list[dict]:
    where, args = _filters(game, track, car, layout)
    with db() as con:
        rows = con.execute(
            f"""SELECT laps.*, EXISTS(SELECT 1 FROM lap_traces t WHERE t.uid = laps.uid) AS has_trace
                FROM laps{where} ORDER BY recorded_at DESC, id DESC LIMIT ?""",
            [*args, limit],
        ).fetchall()
    return [row_to_lap(r) for r in rows]


@app.get("/api/bests")
def bests(game: str | None = None, track: str | None = None, car: str | None = None) -> list[dict]:
    """Pro Spiel/Strecke/Layout/Auto: beste gültige Runde, beste Runde insgesamt, Anzahl."""
    where, args = _filters(game, track, car)
    with db() as con:
        combos = con.execute(
            f"""SELECT game, track, layout, car, COUNT(*) AS laps,
                       MAX(recorded_at) AS last_driven
                FROM laps{where} GROUP BY game, track, layout, car
                ORDER BY last_driven DESC""",
            args,
        ).fetchall()
        out = []
        for c in combos:
            key = (c["game"], c["track"], c["layout"], c["car"])
            base = "SELECT * FROM laps WHERE game=? AND track=? AND layout=? AND car=?"
            best_valid = con.execute(
                base + " AND COALESCE(valid,1)=1 AND estimated=0 ORDER BY lap_time_ms LIMIT 1", key
            ).fetchone()
            best_any = con.execute(base + " ORDER BY lap_time_ms LIMIT 1", key).fetchone()
            out.append({
                **dict(c),
                "best_valid": row_to_lap(best_valid) if best_valid else None,
                "best_any": row_to_lap(best_any) if best_any else None,
            })
    return out


@app.get("/api/traces")
def traces(game: str, track: str, car: str, layout: str = "",
           limit: int = Query(default=200, ge=1, le=1000)) -> list[dict]:
    """Runden mit Verlauf für eine Kombination (neueste zuerst) – für Delta, Sektoren, Ideallauf."""
    with db() as con:
        rows = con.execute(
            """SELECT l.*, t.data AS trace FROM laps l JOIN lap_traces t ON t.uid = l.uid
               WHERE l.game=? AND l.track=? AND l.layout=? AND l.car=?
               ORDER BY l.recorded_at DESC LIMIT ?""",
            (game, track, layout, car, limit),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        trace = json.loads(d.pop("trace"))
        lap = row_to_lap(d)
        lap["trace"] = trace
        out.append(lap)
    return out


@app.get("/api/trackmap")
def trackmap(game: str, track: str, layout: str = "") -> dict:
    """Streckenform (x/z je 0,5 % der Runde) aus der neuesten Runde mit Positionsdaten –
    egal mit welchem Auto. So bekommen auch alte Runden ohne Position eine Karte."""
    with db() as con:
        rows = con.execute(
            """SELECT t.data FROM laps l JOIN lap_traces t ON t.uid = l.uid
               WHERE l.game=? AND l.track=? AND l.layout=? AND t.data LIKE '%"x":[%'
               ORDER BY COALESCE(l.valid,1) DESC, l.recorded_at DESC LIMIT 20""",
            (game, track, layout),
        ).fetchall()
    best = None
    for r in rows:
        d = json.loads(r["data"])
        n = sum(v is not None for v in (d.get("x") or []))
        if n > 100 and (best is None or n > best[0]):
            best = (n, {"step": d["step"], "x": d["x"], "z": d["z"]})
    return best[1] if best else {"x": None, "z": None}


@app.get("/api/stats")
def stats(game: str | None = None, track: str | None = None, car: str | None = None) -> dict:
    """Kennzahlen für die Kopfzeile."""
    where, args = _filters(game, track, car)
    with db() as con:
        r = con.execute(
            f"""SELECT COUNT(*) AS laps,
                       SUM(CASE WHEN COALESCE(valid,1)=1 AND estimated=0 THEN 1 ELSE 0 END) AS valid_laps,
                       COUNT(DISTINCT game || '|' || track || '|' || layout) AS tracks,
                       COUNT(DISTINCT car) AS cars,
                       COUNT(DISTINCT game) AS games,
                       COUNT(DISTINCT session_uid) AS sessions,
                       COALESCE(SUM(lap_time_ms), 0) AS drive_ms,
                       MAX(recorded_at) AS last_lap
                FROM laps{where}""",
            args,
        ).fetchone()
    return dict(r)


@app.get("/api/filters")
def filters() -> dict:
    with db() as con:
        def distinct(col: str) -> list[str]:
            return [r[0] for r in con.execute(f"SELECT DISTINCT {col} FROM laps ORDER BY {col}")]
        total = con.execute("SELECT COUNT(*) FROM laps").fetchone()[0]
        return {"games": distinct("game"), "tracks": distinct("track"), "cars": distinct("car"), "total": total}


@app.patch("/api/laps/{lap_id}", dependencies=[Depends(require_token)])
def set_note(lap_id: int, body: NoteIn) -> dict:
    with db() as con:
        cur = con.execute("UPDATE laps SET note=? WHERE id=?", (body.note, lap_id))
    if not cur.rowcount:
        raise HTTPException(404, "Runde nicht gefunden")
    return {"ok": True}


@app.delete("/api/laps/{lap_id}", dependencies=[Depends(require_token)])
def delete_lap(lap_id: int) -> dict:
    with db() as con:
        con.execute("DELETE FROM lap_traces WHERE uid=(SELECT uid FROM laps WHERE id=?)", (lap_id,))
        cur = con.execute("DELETE FROM laps WHERE id=?", (lap_id,))
    if not cur.rowcount:
        raise HTTPException(404, "Runde nicht gefunden")
    return {"ok": True}


app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(BASE / "static" / "index.html")
