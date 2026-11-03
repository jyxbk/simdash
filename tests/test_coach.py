import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

import coach  # noqa: E402

N = 200
LENGTH = 4000.0


def profile(corners):
    """Tempo-Profil: Geraden mit 250 km/h, Kurven als V mit Mindesttempo; corners = [(apex, vmin, breite)]."""
    v = [250.0] * N
    for apex, vmin, w in corners:
        for d in range(-w, w + 1):
            i = (apex + d) % N
            v[i] = min(v[i], vmin + (250 - vmin) * abs(d) / w)
    return v


def make_lap(i, corners, brake_shift=0, **kw):
    v = profile(corners)
    t, acc = [], 0.0
    for k in range(N):
        t.append(round(acc))
        acc += (LENGTH / N) / (v[k] / 3.6) * 1000
    brk = [0] * N
    thr = [100] * N
    for apex, vmin, w in corners:
        for d in range(-w + brake_shift, 0):
            brk[(apex + d) % N] = 80
            thr[(apex + d) % N] = 0
        for d in range(0, w // 2):
            thr[(apex + d) % N] = 40
    lap = {"id": i, "lap_number": i, "lap_time_ms": round(acc), "valid": True, "estimated": False,
           "outlap": False, "inlap": False, "recorded_at": f"2026-11-01T10:{i:02d}:00",
           "trace": {"step": 1 / N, "t": t, "v": [round(x, 1) for x in v], "thr": thr, "brk": brk}}
    lap.update(kw)
    return lap


BASE = [(30, 90, 10), (90, 140, 8), (150, 70, 12)]


def test_find_corners():
    cs = coach.find_corners(profile(BASE))
    assert sorted(c["apex"] for c in cs) == [30, 90, 150]


def test_potential_and_tips():
    pb = make_lap(1, [(30, 90, 10), (90, 130, 8), (150, 70, 12)])          # langsam in Kurve 2
    other = make_lap(2, [(30, 80, 10), (90, 145, 8), (150, 70, 12)])       # schneller in Kurve 2, langsamer in 1
    slow = make_lap(3, BASE, lap_time_ms=999999, valid=False)               # ungültig, zählt nicht
    r = coach.analyze([pb, other, slow])
    assert r["ref"]["id"] == 1 and r["laps_used"] == 2
    assert abs(r["track_length_m"] - LENGTH) < 100
    k2 = next(c for c in r["corners"] if abs(c["apex"] - 90 / N) < 0.02)
    assert k2["best_lap"]["id"] == 2 and k2["gain_ms"] > 100
    assert any(t["kind"] == "carry_speed" for t in k2["tips"])
    k1 = next(c for c in r["corners"] if abs(c["apex"] - 30 / N) < 0.02)
    assert k1["gain_ms"] == 0 and not k1["tips"]
    assert r["ideal_ms"] < pb["lap_time_ms"]
    assert r["potential_ms"] == pb["lap_time_ms"] - r["ideal_ms"]


def test_no_traces():
    r = coach.analyze([{"id": 1, "lap_time_ms": 80000, "valid": True, "trace": {"t": [None] * N}}])
    assert r["laps_used"] == 0 and r["corners"] == [] and r["pb_ms"] == 80000


def test_coach_endpoint(tmp_path, monkeypatch):
    import importlib
    from fastapi.testclient import TestClient
    monkeypatch.setenv("SIMDASH_DB", str(tmp_path / "t.db"))
    monkeypatch.setenv("SIMDASH_TOKEN", "geheim")
    import app as app_module
    importlib.reload(app_module)
    laps = []
    for i, cs in enumerate([[(30, 90, 10), (90, 130, 8), (150, 70, 12)], [(30, 80, 10), (90, 145, 8), (150, 70, 12)]], 1):
        l = make_lap(i, cs)
        laps.append({"uid": f"lapuid00{i}", "game": "acevo", "track": "t", "car": "c", "lap_number": i,
                     "lap_time_ms": l["lap_time_ms"], "valid": True, "recorded_at": l["recorded_at"] + "+00:00",
                     "trace": {**l["trace"], "step": 0.005}})
    with TestClient(app_module.app) as c:
        c.post("/api/laps", json=laps, headers={"Authorization": "Bearer geheim"})
        r = c.get("/api/coach", params={"game": "acevo", "track": "t", "car": "c"}).json()
    assert r["laps_used"] == 2 and len(r["corners"]) == 3 and r["potential_ms"] > 0
