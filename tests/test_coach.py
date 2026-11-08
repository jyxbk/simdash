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


def _with_controls(lap, gear, steer):
    lap["trace"]["g"] = [gear] * N
    lap["trace"]["st"] = list(steer)
    return lap


CALM = [0.2] * N
WOBBLY = [0.2 + (0.15 if i % 2 else -0.15) for i in range(N)]


def test_gear_and_steer_tips():
    pb = _with_controls(make_lap(1, [(30, 90, 10), (90, 130, 8), (150, 70, 12)]), 3, WOBBLY)
    other = _with_controls(make_lap(2, [(30, 80, 10), (90, 145, 8), (150, 70, 12)]), 4, CALM)
    k2 = next(c for c in coach.analyze([pb, other])["corners"] if abs(c["apex"] - 90 / N) < 0.02)
    kinds = {t["kind"] for t in k2["tips"]}
    assert "gear_higher" in kinds and "steer_calmer" in kinds
    assert k2["gear"] == {"ref": 3, "best": 4}
    assert next(t for t in k2["tips"] if t["kind"] == "gear_higher")["text"].startswith("Nimm die Kurve einen Gang höher (4. statt 3.")


def test_gear_ignores_neutral_while_shifting():
    lap = _with_controls(make_lap(1, BASE), 3, CALM)
    lap["trace"]["g"][30] = 0
    c = {"start": 20, "apex": 30, "end": 80}
    assert coach._metrics(lap, c, N)["gear"] == 3


def test_old_pb_uses_newer_laps_for_gear():
    """Alte Bestzeit ohne Gang: Tipp kommt aus dem Vergleich der neueren Runden und sagt das auch."""
    pb = make_lap(1, [(30, 95, 10), (90, 125, 8), (150, 70, 12)])                      # alt, ohne Daten
    new1 = _with_controls(make_lap(2, [(30, 80, 10), (90, 130, 8), (150, 70, 12)]), 3, CALM)
    new2 = _with_controls(make_lap(3, [(30, 70, 10), (90, 145, 8), (150, 70, 12)]), 4, CALM)
    k2 = next(c for c in coach.analyze([pb, new1, new2])["corners"] if abs(c["apex"] - 90 / N) < 0.02)
    tip = next(t for t in k2["tips"] if t["kind"] == "gear_higher")
    assert tip["text"].endswith("(laut neueren Runden)")


def test_no_controls_no_control_tips():
    pb = make_lap(1, [(30, 90, 10), (90, 130, 8), (150, 70, 12)])
    other = make_lap(2, [(30, 80, 10), (90, 145, 8), (150, 70, 12)])
    k2 = next(c for c in coach.analyze([pb, other])["corners"] if abs(c["apex"] - 90 / N) < 0.02)
    assert k2["gear"] is None and not {t["kind"] for t in k2["tips"]} & {"gear_higher", "gear_lower", "steer_calmer", "less_lock"}


def _with_line(lap, offset=0.0):
    import math
    lap["trace"]["x"] = [round(math.cos(2 * math.pi * i / N) * 600 + offset, 2) for i in range(N)]
    lap["trace"]["z"] = [round(math.sin(2 * math.pi * i / N) * 600, 2) for i in range(N)]
    return lap


def test_compare_laps_phases_and_tips():
    ref = _with_line(make_lap(1, BASE))
    slow = _with_line(make_lap(2, [(30, 90, 10), (90, 125, 8), (150, 70, 12)]), offset=1.5)  # Kurve 2 langsamer
    r = coach.compare_laps(slow, ref)
    assert r["ok"] and r["delta_ms"] > 100
    k2 = next(c for c in r["corners"] if abs(c["apex"] - 90 / N) < 0.02)
    assert k2["loss_ms"] > 100 and r["problems"][0] == k2["no"]
    assert [p["key"] for p in k2["phases"]] == ["brake", "turnin", "apex", "exit"]
    assert abs(sum(p["ms"] for p in k2["phases"]) - k2["loss_ms"]) <= 2      # Phasen ergeben den Kurvenverlust
    assert k2["tips"] and "Scheitel" in " ".join(t["text"] for t in k2["tips"])
    assert k2["line"] and len(k2["line"]["lap"]) >= 5
    assert sum(p["ms"] for p in r["phase_totals"]) == sum(sum(p["ms"] for p in c["phases"]) for c in r["corners"])


def test_phase_text_brake_and_exit():
    lm = {"brake": 40.0, "v_entry": 250, "v_min": 90, "v_exit": 150, "full_throttle": 60.0}
    rm = {"brake": 44.0, "v_entry": 250, "v_min": 90, "v_exit": 156, "full_throttle": 56.0}
    assert "früher" in coach._phase_text("brake", lm, rm, N, 20.0)
    assert "später voll aufs Gas" in coach._phase_text("exit", lm, rm, N, 20.0)


def test_compare_laps_without_trace():
    ref = make_lap(1, BASE)
    bad = make_lap(2, BASE)
    bad["trace"] = {"t": [], "v": []}
    assert coach.compare_laps(bad, ref)["ok"] is False


def test_analyze_has_four_phases():
    pb = make_lap(1, [(30, 90, 10), (90, 130, 8), (150, 70, 12)])
    other = make_lap(2, [(30, 80, 10), (90, 145, 8), (150, 70, 12)])
    r = coach.analyze([pb, other])
    k2 = next(c for c in r["corners"] if abs(c["apex"] - 90 / N) < 0.02)
    assert k2["phases"] and len(k2["phases"]) == 4


def test_apex_offset_inside_outside():
    import math
    def ring(r, cw=False):
        sgn = -1 if cw else 1
        return {"trace": {"x": [math.cos(2 * math.pi * i / N) * r for i in range(N)],
                          "z": [sgn * math.sin(2 * math.pi * i / N) * r for i in range(N)]}}
    for cw in (False, True):
        ref = ring(600, cw)
        assert coach._apex_offset(ring(598, cw), ref, 50, N)["apex_offset_m"] == 2.0     # innen
        assert coach._apex_offset(ring(603, cw), ref, 50, N)["apex_offset_m"] == -3.0    # außen
