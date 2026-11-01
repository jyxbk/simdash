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
