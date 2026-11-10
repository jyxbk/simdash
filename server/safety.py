"""Safety Rating nach dem Vorbild von iRacing (eigene Umsetzung, keine Kopie der iRacing-Formeln).

Grundidee wie bei iRacing:
- Zwischenfälle werden in Punkten gezählt und auf die gefahrenen **Kurven** bezogen
  (CPI = Kurven pro Zwischenfall-Punkt; höher = sauberer).
- Lizenzklassen R, D, C, B, A mit je einem Rating 0,00–4,99.
- Das Rating bewegt sich **pro Session** nur ein Stück in Richtung der dort gezeigten Leistung;
  lange Sessions zählen mehr. Ein einzelner guter oder schlechter Abend kippt nichts.
- Aufstieg ab 4,00 (und Mindestzahl Sessions in der Klasse), Abstieg unter 1,00.
- Höhere Klassen verlangen eine bessere CPI für dasselbe Rating.

Zwischenfälle je Runde (aus Spiel-Flag und Tempoverlauf):
- 1x  ungültige Runde (Track Limits / Off-Track; iRacing: tatsächliche Incident-Punkte aus der Notiz)
- 2x  Kontrollverlust / Abflug: > 45 km/h Tempoverlust auf ~1 % der Strecke ohne Bremse
- 4x  Einschlag: > 80 km/h Tempoverlust auf ~0,5 % der Strecke ohne Bremse
"""
from __future__ import annotations

import math
import re
from collections import defaultdict

CLASSES = ["R", "D", "C", "B", "A"]
START_SR = 2.50
PROMOTE_AT = 4.00
DEMOTE_BELOW = 1.00
MIN_SESSIONS_FOR_PROMOTION = 3
SESSION_WEIGHT_K = 300          # Kurven, bei denen eine Session halb so stark zählt wie „unendlich lang“
MAX_STEP = 0.5                  # höchstens die Hälfte des Abstands zum Ziel pro Session
# CPI, die in der jeweiligen Klasse 0,00 bzw. 4,99 ergibt (log-skaliert dazwischen)
CPI_RANGE = {"R": (3, 60), "D": (5, 90), "C": (8, 130), "B": (12, 180), "A": (16, 250)}

INC_OFF = 2
INC_CRASH = 4


def lap_incidents(lap: dict) -> list[dict]:
    """Zwischenfälle einer Runde: [{kind, pts, idx}] (idx = Position im Verlauf oder None)."""
    out: list[dict] = []
    tr = lap.get("trace") or {}
    v, b = tr.get("v") or [], tr.get("brk") or []
    step = tr.get("step") or 0
    if v and step:
        n = len(v)
        win, win_crash = max(1, int(round(0.01 / step))), max(1, int(round(0.005 / step)))
        i = 0
        while i < n - win:
            vi = v[i]
            if vi and vi > 60:
                def drop(w):
                    seg = [x for x in v[i:i + w + 1] if x is not None]
                    bb = [x for x in b[i:i + w + 1] if x is not None] if b else []
                    return (vi - min(seg) if seg else 0), (max(bb) if bb else 0)
                d_o, br_o = drop(win)
                if d_o > 45 and br_o < 30:
                    # Einschlag, wenn irgendwo in diesem Abschnitt > 80 km/h auf ~0,5 % wegbrechen
                    seg = [x for x in v[i:i + win + win_crash + 1]]
                    hard = max((seg[j] - min(x for x in seg[j:j + win_crash + 1] if x is not None)
                                for j in range(len(seg)) if seg[j] is not None), default=0)
                    kind = "crash" if hard > 80 else "off"
                    out.append({"kind": kind, "pts": INC_CRASH if kind == "crash" else INC_OFF, "idx": i})
                    i += win + win_crash
                    continue
            i += 1
    m = re.search(r"\+(\d+)x Incidents", lap.get("note") or "")
    if m:                                             # iRacing zählt selbst
        out.append({"kind": "iracing", "pts": int(m.group(1)), "idx": None})
    elif lap.get("valid") is False and not out:
        inv = tr.get("inv_at")
        out.append({"kind": "invalid", "pts": 1, "idx": int(inv / step) if inv is not None and step else None})
    return out


def target_sr(cpi: float, klass: str) -> float:
    lo, hi = CPI_RANGE[klass]
    if cpi == math.inf:
        return 4.99
    if cpi <= lo:
        return 0.0
    return round(min(4.99, 4.99 * math.log(cpi / lo) / math.log(hi / lo)), 2)


def rated(lap: dict) -> bool:
    return not lap.get("outlap") and not lap.get("inlap") and not lap.get("estimated")


def compute(laps: list[dict], corners_for) -> dict:
    """laps: alle Runden eines Fahrers (beliebige Reihenfolge, mit trace wenn vorhanden).
    corners_for(lap) -> (Kurvenanzahl, Kurven-Startpositionen 0..1 oder None)."""
    sessions: dict[str, list[dict]] = defaultdict(list)
    for l in laps:
        if rated(l):
            sessions[l.get("session_uid") or f"lap{l['id']}"].append(l)
    order = sorted(sessions.values(), key=lambda ls: min(x["recorded_at"] for x in ls))
    klass, sr, in_class = "R", START_SR, 0
    hist = []
    for ls in order:
        ls.sort(key=lambda x: x["recorded_at"])
        corners = pts = 0
        kinds: dict[str, int] = defaultdict(int)
        events = []
        for l in ls:
            nc, starts = corners_for(l)
            corners += nc
            for inc in lap_incidents(l):
                pts += inc["pts"]
                kinds[inc["kind"]] += 1
                corner = None
                if inc["idx"] is not None and starts:
                    pos = inc["idx"] * (l["trace"].get("step") or 0)
                    corner = max((k + 1 for k, s in enumerate(starts) if s <= pos), default=len(starts))
                events.append({"lap_id": l["id"], "kind": inc["kind"], "pts": inc["pts"], "corner": corner,
                               "game": l["game"], "track": l["track"], "layout": l.get("layout", "")})
        if corners == 0:
            continue
        cpi = corners / pts if pts else math.inf
        tgt = target_sr(cpi, klass)
        w = min(MAX_STEP, corners / (corners + SESSION_WEIGHT_K))
        before = sr
        sr = round(max(0.0, min(4.99, sr + w * (tgt - sr))), 2)
        in_class += 1
        event = None
        ci = CLASSES.index(klass)
        if sr >= PROMOTE_AT and ci < len(CLASSES) - 1 and in_class >= MIN_SESSIONS_FOR_PROMOTION:
            klass, sr, in_class, event = CLASSES[ci + 1], round(sr - 1.0, 2), 0, "promotion"
        elif sr < DEMOTE_BELOW and ci > 0:
            klass, sr, in_class, event = CLASSES[ci - 1], START_SR, 0, "demotion"
        hist.append({
            "session_uid": ls[0].get("session_uid"), "at": ls[-1]["recorded_at"], "game": ls[0]["game"],
            "track": ls[0]["track"], "layout": ls[0].get("layout", ""), "car": ls[0]["car"],
            "laps": len(ls), "corners": corners, "points": pts, "kinds": dict(kinds),
            "cpi": None if cpi == math.inf else round(cpi, 1), "target": tgt,
            "sr_before": before, "sr": sr, "klass": klass, "event": event, "incidents": events,
        })
    recent = hist[-10:]
    rc = sum(h["corners"] for h in recent)
    rp = sum(h["points"] for h in recent)
    kinds: dict[str, int] = defaultdict(int)
    by_track: dict[tuple, dict] = {}
    by_corner: dict[tuple, int] = defaultdict(int)
    for h in recent:
        for k, c in h["kinds"].items():
            kinds[k] += c
        t = by_track.setdefault((h["game"], h["track"], h["layout"]), {"game": h["game"], "track": h["track"],
                                                                       "layout": h["layout"], "corners": 0, "points": 0, "laps": 0})
        t["corners"] += h["corners"]
        t["points"] += h["points"]
        t["laps"] += h["laps"]
        for e in h["incidents"]:
            if e["corner"]:
                by_corner[(e["game"], e["track"], e["layout"], e["corner"])] += e["pts"]
    tracks = []
    for t in by_track.values():
        t["cpi"] = round(t["corners"] / t["points"], 1) if t["points"] else None
        tracks.append(t)
    tracks.sort(key=lambda t: (t["cpi"] is None, t["cpi"] or 0))
    hot = [{"game": k[0], "track": k[1], "layout": k[2], "corner": k[3], "points": p}
           for k, p in sorted(by_corner.items(), key=lambda kv: -kv[1])[:5]]
    return {
        "klass": klass, "sr": sr, "sessions_in_class": in_class,
        "to_promotion": None if klass == "A" else round(max(0.0, PROMOTE_AT - sr), 2),
        "sessions": len(hist), "history": [{k: v for k, v in h.items() if k != "incidents"} for h in hist],
        "recent": {"sessions": len(recent), "corners": rc, "points": rp,
                   "cpi": round(rc / rp, 1) if rp else None, "kinds": dict(kinds)},
        "tracks": tracks, "hot_corners": hot,
        "last_change": round(hist[-1]["sr"] - hist[-1]["sr_before"], 2) if hist and not hist[-1]["event"] else None,
    }


RULES = {
    "classes": CLASSES, "start": START_SR, "promote_at": PROMOTE_AT, "demote_below": DEMOTE_BELOW,
    "min_sessions": MIN_SESSIONS_FOR_PROMOTION, "cpi_range": CPI_RANGE,
    "points": {"invalid": 1, "off": INC_OFF, "crash": INC_CRASH, "iracing": "wie im Spiel"},
}
