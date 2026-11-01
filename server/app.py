"""SimDash – sammelt Rundenzeiten aus allen Sims und zeigt sie an.

Der Collector auf dem Gaming-PC schickt jede fertige Runde per POST /api/laps.
Lesen ist im LAN offen, Schreiben braucht den Token aus SIMDASH_TOKEN.
"""
from __future__ import annotations

import json
import os
import secrets
import sqlite3
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse
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
    return {"received": len(laps), "added": added}


def _filters(game: str | None, track: str | None, car: str | None) -> tuple[str, list]:
    where, args = [], []
    for col, val in (("game", game), ("track", track), ("car", car)):
        if val:
            where.append(f"{col} = ?")
            args.append(val)
    return (" WHERE " + " AND ".join(where)) if where else "", args


@app.get("/api/laps")
def list_laps(
    game: str | None = None,
    track: str | None = None,
    car: str | None = None,
    limit: int = Query(default=100, ge=1, le=2000),
) -> list[dict]:
    where, args = _filters(game, track, car)
    with db() as con:
        rows = con.execute(
            f"SELECT * FROM laps{where} ORDER BY recorded_at DESC, id DESC LIMIT ?",
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
        cur = con.execute("DELETE FROM laps WHERE id=?", (lap_id,))
    if not cur.rowcount:
        raise HTTPException(404, "Runde nicht gefunden")
    return {"ok": True}


app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(BASE / "static" / "index.html")
