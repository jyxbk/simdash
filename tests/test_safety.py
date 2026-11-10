import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

import safety  # noqa: E402


def lap(i, session, valid=True, v=None, note="", inv_at=None, **kw):
    tr = None
    if v is not None:
        tr = {"step": 1 / len(v), "t": list(range(len(v))), "v": v, "brk": [0] * len(v)}
        if inv_at is not None:
            tr["inv_at"] = inv_at
    d = {"id": i, "session_uid": session, "recorded_at": f"2026-11-01T10:{i:02d}:00", "game": "acevo",
         "track": "rbr", "layout": "", "car": "bmw", "valid": valid, "outlap": False, "inlap": False,
         "estimated": False, "note": note, "trace": tr}
    d.update(kw)
    return d


FLAT = [150.0] * 200


def test_incident_kinds():
    off = FLAT[:50] + [125.0, 100.0] + [100.0] * 148                           # -50 km/h auf ~1 % Strecke
    crash = FLAT[:50] + [60.0] * 150                                           # -90 km/h sofort
    assert [i["kind"] for i in safety.lap_incidents(lap(1, "s", v=off))] == ["off"]
    assert safety.lap_incidents(lap(1, "s", v=crash))[0]["pts"] == 4
    inv = safety.lap_incidents(lap(1, "s", valid=False, v=FLAT, inv_at=0.5))
    assert inv == [{"kind": "invalid", "pts": 1, "idx": 100}]
    assert safety.lap_incidents(lap(1, "s", valid=False, note="+4x Incidents"))[0]["pts"] == 4
    assert safety.lap_incidents(lap(1, "s", v=FLAT)) == []


def test_clean_driving_promotes_after_min_sessions():
    laps = [lap(s * 10 + k, f"s{s}", v=FLAT) for s in range(8) for k in range(10)]
    r = safety.compute(laps, lambda l: (10, [0.1 * i for i in range(10)]))
    assert r["history"][0]["klass"] == "R"
    assert r["history"][1]["event"] is None                 # erst nach 3 Sessions möglich
    assert any(h["event"] == "promotion" for h in r["history"]) and r["klass"] != "R"


def test_messy_session_lowers_rating_and_finds_corner():
    laps = [lap(k, "s1", valid=False, v=FLAT, inv_at=0.35) for k in range(10)]
    r = safety.compute(laps, lambda l: (10, [0.1 * i for i in range(10)]))
    assert r["sr"] < safety.START_SR and r["recent"]["cpi"] == 10.0
    assert r["hot_corners"][0]["corner"] == 4 and r["hot_corners"][0]["points"] == 10


def test_target_scale():
    assert safety.target_sr(float("inf"), "C") == 4.99
    assert safety.target_sr(8, "C") == 0.0
    assert safety.target_sr(30, "R") > safety.target_sr(30, "C")    # höhere Klasse = strenger
