import importlib
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SIMDASH_DB", str(tmp_path / "t.db"))
    monkeypatch.setenv("SIMDASH_TOKEN", "geheim")
    import app as app_module
    importlib.reload(app_module)
    with TestClient(app_module.app) as c:
        yield c


AUTH = {"Authorization": "Bearer geheim"}


def lap(uid, ms, **kw):
    d = {
        "uid": uid, "game": "acevo", "track": "road_atlanta", "car": "bmw_m4_gt3",
        "session_uid": "s1", "session_type": "practice", "lap_number": 1,
        "lap_time_ms": ms, "valid": True, "recorded_at": "2026-11-01T14:00:00+01:00",
    }
    d.update(kw)
    return d


def test_post_needs_token(client):
    r = client.post("/api/laps", json=[lap("aaaaaaaa1", 81234)])
    assert r.status_code == 401


def test_post_and_dedupe(client):
    r = client.post("/api/laps", json=[lap("aaaaaaaa1", 81234)], headers=AUTH)
    assert r.json() == {"received": 1, "added": 1}
    r = client.post("/api/laps", json=[lap("aaaaaaaa1", 81234)], headers=AUTH)
    assert r.json() == {"received": 1, "added": 0}
    assert len(client.get("/api/laps").json()) == 1


def test_bests_ignore_invalid_and_estimated(client):
    client.post("/api/laps", headers=AUTH, json=[
        lap("aaaaaaaa1", 82000),
        lap("aaaaaaaa2", 80500, valid=False),
        lap("aaaaaaaa3", 80900, estimated=True),
        lap("aaaaaaaa4", 81250),
    ])
    b = client.get("/api/bests").json()
    assert len(b) == 1
    assert b[0]["best_valid"]["lap_time_ms"] == 81250
    assert b[0]["best_any"]["lap_time_ms"] == 80500
    assert b[0]["laps"] == 4


def test_unknown_validity_counts_as_valid(client):
    # AC1 liefert keine Gültigkeit -> valid=None zählt für die Bestzeit
    client.post("/api/laps", headers=AUTH, json=[lap("aaaaaaaa1", 90000, game="ac", valid=None)])
    b = client.get("/api/bests").json()
    assert b[0]["best_valid"]["lap_time_ms"] == 90000
    assert b[0]["best_valid"]["valid"] is None


def test_filters_and_delete(client):
    client.post("/api/laps", headers=AUTH, json=[lap("aaaaaaaa1", 81000), lap("aaaaaaaa2", 99000, game="acc", track="spa")])
    f = client.get("/api/filters").json()
    assert f["games"] == ["acc", "acevo"] and f["total"] == 2
    assert len(client.get("/api/laps?game=acc").json()) == 1
    lap_id = client.get("/api/laps?game=acc").json()[0]["id"]
    assert client.delete(f"/api/laps/{lap_id}").status_code == 401
    assert client.delete(f"/api/laps/{lap_id}", headers=AUTH).status_code == 200
    assert client.get("/api/filters").json()["total"] == 1


def test_index_served(client):
    r = client.get("/")
    assert r.status_code == 200 and "SimDash" in r.text


def test_note_is_stored(client):
    client.post("/api/laps", headers=AUTH, json=[lap("aaaaaaaa1", 81000, game="iracing", note="+2x Incidents")])
    assert client.get("/api/laps").json()[0]["note"] == "+2x Incidents"


def test_stats_and_layout_filter(client):
    client.post("/api/laps", headers=AUTH, json=[
        lap("aaaaaaaa1", 81000, layout="gp"), lap("aaaaaaaa2", 82000, valid=False, layout="gp"),
        lap("aaaaaaaa3", 90000, layout="short", session_uid="s2"),
    ])
    st = client.get("/api/stats").json()
    assert st["laps"] == 3 and st["valid_laps"] == 2 and st["tracks"] == 2
    assert st["drive_ms"] == 253000 and st["sessions"] == 2
    assert len(client.get("/api/laps?layout=gp").json()) == 2


def test_trace_roundtrip(client):
    tr = {"step": 0.005, "t": [i * 400 for i in range(200)], "v": [150.0] * 200, "thr": [100] * 200, "brk": [0] * 200}
    client.post("/api/laps", headers=AUTH, json=[lap("aaaaaaaa1", 81000, trace=tr), lap("aaaaaaaa2", 82000)])
    laps = {l["uid"]: l for l in client.get("/api/laps").json()}
    assert laps["aaaaaaaa1"]["has_trace"] is True and laps["aaaaaaaa2"]["has_trace"] is False
    t = client.get("/api/traces", params={"game": "acevo", "track": "road_atlanta", "car": "bmw_m4_gt3"}).json()
    assert len(t) == 1 and t[0]["trace"]["t"][10] == 4000 and t[0]["lap_time_ms"] == 81000
    lap_id = laps["aaaaaaaa1"]["id"]
    assert client.delete(f"/api/laps/{lap_id}", headers=AUTH).status_code == 200
    assert client.get("/api/traces", params={"game": "acevo", "track": "road_atlanta", "car": "bmw_m4_gt3"}).json() == []


def test_live_roundtrip(client):
    assert client.get("/api/live").json()["data"] is None
    assert client.post("/api/live", json={"state": "live"}).status_code == 401
    r = client.post("/api/live", headers=AUTH, json={"state": "live", "npos": 0.5, "current_ms": 12000})
    assert r.status_code == 200
    got = client.get("/api/live").json()
    assert got["data"]["npos"] == 0.5 and got["age_s"] < 5 and got["seq"] >= 1
    assert client.post("/api/live", headers=AUTH, content="x" * 20000).status_code == 413


def test_trackmap_from_other_car(client):
    tr = {"step": 0.005, "t": [i * 400 for i in range(200)], "x": [float(i) for i in range(200)], "z": [0.0] * 200}
    lp = lap("cccccccc1", 81000, trace=tr)
    lp["car"] = "anderes_auto"
    client.post("/api/laps", headers=AUTH, json=[lp])
    m = client.get("/api/trackmap", params={"game": "acevo", "track": "road_atlanta"}).json()
    assert m["x"][199] == 199.0
    assert client.get("/api/trackmap", params={"game": "acevo", "track": "spa"}).json()["x"] is None


def test_drivers_assign_and_current(client):
    client.post("/api/laps", headers=AUTH, json=[lap("dddddddd1", 81000, driver="Alex"), lap("dddddddd2", 80000, driver="Alex")])
    d = client.get("/api/drivers").json()
    me = d["me"]
    assert me == "Alex"
    laps = client.get("/api/laps").json()
    fast = next(l for l in laps if l["lap_time_ms"] == 80000)
    assert client.post("/api/laps/driver", json={"driver": "Max", "ids": [fast["id"]]}).json()["updated"] == 1
    mine = client.get("/api/bests", params={"driver": me}).json()
    assert mine[0]["best_valid"]["lap_time_ms"] == 81000
    assert client.get("/api/bests", params={"driver": "Max"}).json()[0]["best_valid"]["lap_time_ms"] == 80000
    # wer fährt: neue Runden bekommen den Namen
    assert client.post("/api/drivers/current", json={"driver": "Max"}).json()["current"] == "Max"
    client.post("/api/laps", headers=AUTH, json=[lap("dddddddd3", 79000)])
    assert client.get("/api/laps", params={"driver": "Max"}).json()[0]["lap_time_ms"] == 79000
    assert client.post("/api/drivers/current", json={"driver": me}).json()["current"] == ""
    assert "Max" in client.get("/api/filters").json()["drivers"]


def test_trackmap_from_live_positions(client):
    import math
    for k in range(400):
        n = 0.01 + k * 0.0012          # Touristenfahrt: nur halbe Strecke, keine fertige Runde
        r = client.post("/api/live", headers=AUTH, json={
            "state": "live", "game": "acevo", "track": "Nurburgring", "layout": "Touristenfahrten",
            "npos": n, "pos_x": 1000 * math.cos(n * 6.28), "pos_z": 800 * math.sin(n * 6.28),
            "speed_kmh": 150, "in_pit_lane": False, "paused": False})
        assert r.status_code == 200
    m = client.get("/api/trackmap", params={"game": "acevo", "track": "Nurburgring", "layout": "Touristenfahrten", "points": 1000}).json()
    assert m["source"] == "live" and 0.3 < m["coverage"] < 0.6
    assert m["x"][100] is not None and m["x"][900] is None


def test_setup_notes(client):
    combo = {"game": "acevo", "track": "road_atlanta", "car": "bmw_m4_gt3"}
    r = client.post("/api/notes", json={**combo, "text": "BB 57 % besser"})
    assert r.status_code == 200
    nid = r.json()["id"]
    notes = client.get("/api/notes", params=combo).json()
    assert [n["text"] for n in notes] == ["BB 57 % besser"]
    assert client.delete(f"/api/notes/{nid}").status_code == 200
    assert client.get("/api/notes", params=combo).json() == []
