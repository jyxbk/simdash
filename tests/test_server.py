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


def test_second_collector_twin_is_ignored(client):
    """Zwei Collector gleichzeitig: dieselbe Runde kommt mit anderer uid, ms später."""
    a = lap("twinuid01", 81000, session_uid="s1", lap_number=5, recorded_at="2026-11-01T14:00:00.100+00:00")
    b = lap("twinuid02", 81000, session_uid="s2", lap_number=5, recorded_at="2026-11-01T14:00:00.117+00:00")
    assert client.post("/api/laps", json=[a], headers=AUTH).json()["added"] == 1
    assert client.post("/api/laps", json=[b], headers=AUTH).json() == {"received": 1, "added": 0}
    # gleiche Zeit später (eigene Runde) zählt
    c = lap("twinuid03", 81000, session_uid="s1", lap_number=6, recorded_at="2026-11-01T14:01:21+00:00")
    assert client.post("/api/laps", json=[c], headers=AUTH).json()["added"] == 1


def test_driver_alias(client):
    client.post("/api/laps", headers=AUTH, json=[lap("aliasuid1", 81000, driver="Alex", lap_number=1),
                                                 lap("aliasuid2", 82000, driver="Alex", lap_number=2)])
    assert client.get("/api/drivers").json()["me"] == "Alex"
    # AC meldet einen Nickname: ohne Alias wäre die Runde im Standardfilter unsichtbar
    nick = {"game": "ac", "track": "monza", "car": "c"}
    client.post("/api/laps", headers=AUTH, json=[lap("aliasuid3", 90000, driver="Nick", lap_number=1, **nick)])
    assert client.get("/api/laps", params={"driver": "Alex", "game": "ac"}).json() == []
    r = client.post("/api/drivers/alias", json={"alias": "Nick", "driver": "Alex"}).json()
    assert r["updated"] == 1 and r["aliases"] == {"Nick": "Alex"}
    assert len(client.get("/api/laps", params={"driver": "Alex", "game": "ac"}).json()) == 1
    # neue Runden unter dem Nickname zählen direkt
    client.post("/api/laps", headers=AUTH, json=[lap("aliasuid4", 89000, driver="Nick", lap_number=2, **nick)])
    assert len(client.get("/api/laps", params={"driver": "Alex", "game": "ac"}).json()) == 2
    # „Es fährt“ hat Vorrang vor dem Alias
    client.post("/api/drivers/current", json={"driver": "Gast"})
    client.post("/api/laps", headers=AUTH, json=[lap("aliasuid5", 88000, driver="Nick", lap_number=3, **nick)])
    assert len(client.get("/api/laps", params={"driver": "Gast", "game": "ac"}).json()) == 1
    # Alias entfernen, ungültige Eingabe
    assert client.post("/api/drivers/alias", json={"alias": "Nick", "driver": ""}).json()["aliases"] == {}
    assert client.post("/api/drivers/alias", json={"alias": "X", "driver": "X"}).status_code == 400


def test_corner_names(client):
    base = {"game": "acevo", "track": "road_atlanta", "layout": ""}
    assert client.post("/api/corners", json={**base, "npos": 0.115, "name": "T1"}).status_code == 200
    assert client.post("/api/corners", json={**base, "npos": 0.209, "name": "Esses"}).status_code == 200
    # nah dran = dieselbe Kurve, ersetzt den Namen
    client.post("/api/corners", json={**base, "npos": 0.118, "name": "Turn 1"})
    names = client.get("/api/corners", params=base).json()
    assert [n["name"] for n in names] == ["Turn 1", "Esses"]
    import app as app_module
    res = app_module._name_corners({"corners": [{"no": 1, "apex": 0.112}, {"no": 2, "apex": 0.5}]}, "acevo", "road_atlanta", "")
    assert res["corners"][0]["name"] == "Turn 1" and "name" not in res["corners"][1]
    client.post("/api/corners", json={**base, "npos": 0.21, "name": ""})        # löschen
    assert [n["name"] for n in client.get("/api/corners", params=base).json()] == ["Turn 1"]


def test_lap_stats_roundtrip(client):
    st = {"samples": 900, "tp": [27.6, 27.9, 27.1, 26.4], "ti": [86, 80, 82, 79], "tm": [82, 84, 81, 80],
          "to": [78, 85, 80, 81], "bt_max": [610, 600, 420, 430], "bb": 0.565, "abs_pct": 3.2, "tc_pct": 1.1,
          "abs_lvl": 4, "tc_lvl": 3}
    tr = {"step": 0.005, "t": [i * 400 for i in range(200)], "abs": [0] * 199 + [1], "tcx": [0] * 200}
    r = client.post("/api/laps", json=[lap("stats0001", 81000, stats=st, trace=tr), lap("stats0002", 82000)], headers=AUTH)
    assert r.json()["added"] == 2
    rows = client.get("/api/lapstats", params={"game": "acevo", "track": "road_atlanta", "car": "bmw_m4_gt3"}).json()
    assert len(rows) == 1 and rows[0]["stats"]["tp"][3] == 26.4 and rows[0]["valid"] is True
    t = client.get("/api/traces", params={"game": "acevo", "track": "road_atlanta", "car": "bmw_m4_gt3"}).json()
    assert t[0]["trace"]["abs"][-1] == 1


def test_lap_stats_too_big_rejected(client):
    r = client.post("/api/laps", json=[lap("stats0003", 81000, stats={"x": "y" * 5000})], headers=AUTH)
    assert r.status_code == 422


def test_setup_changes_crud(client):
    q = {"game": "acevo", "track": "road_atlanta", "car": "bmw_m4_gt3"}
    r = client.post("/api/setup_changes", json={**q, "part": "Stabilisator hinten", "before": "5", "after": "4",
                                                 "at": "2026-11-01T14:30:00+01:00"}, headers=AUTH)
    assert r.status_code == 200 and r.json()["at"].startswith("2026-11-01T13:30")
    rows = client.get("/api/setup_changes", params=q).json()
    assert len(rows) == 1 and rows[0]["after"] == "4"
    assert client.delete(f"/api/setup_changes/{rows[0]['id']}", headers=AUTH).status_code == 200
    assert client.get("/api/setup_changes", params=q).json() == []


def test_acc_results_fix_validity(client):
    """ACC 14.11.: Runde 12 war live gültig, ACC verwirft sie in der Ergebnisdatei (flags 1)."""
    laps = [lap("accaaaa1", 91382, game="acc", recorded_at="2026-11-14T13:44:52+00:00"),
            lap("accaaaa2", 91465, game="acc", recorded_at="2026-11-14T13:46:24+00:00"),
            lap("accaaaa3", 95310, game="acc", valid=False, outlap=True, recorded_at="2026-11-14T13:19:30+00:00"),
            lap("accaaaa4", 91382, game="acc", recorded_at="2026-11-01T13:44:52+00:00")]  # alte Session
    client.post("/api/laps", json=laps, headers=AUTH)
    body = {"file_time": "2026-11-14T13:46:30+00:00",
            "laps": [{"lap_time_ms": 91382, "flags": 1}, {"lap_time_ms": 91465, "flags": 1024}]}
    assert client.post("/api/acc_results", json=body).status_code == 401
    r = client.post("/api/acc_results", json=body, headers=AUTH).json()
    assert r == {"matched": 2, "updated": 1}
    got = {l["uid"]: l for l in client.get("/api/laps?limit=50").json()}
    assert got["accaaaa1"]["valid"] is False
    assert got["accaaaa2"]["valid"] is True
    assert got["accaaaa4"]["valid"] is True                 # andere Session unberührt
    # Q2 Runde 3: ACC sagt gültig + Outlap (1028) -> gültig, Outlap bleibt
    r = client.post("/api/acc_results", headers=AUTH, json={
        "file_time": "2026-11-14T13:19:35+00:00", "laps": [{"lap_time_ms": 95310, "flags": 1028}]}).json()
    assert r["updated"] == 1
    got = {l["uid"]: l for l in client.get("/api/laps?limit=50").json()}
    assert got["accaaaa3"]["valid"] is True and got["accaaaa3"]["outlap"] is True
