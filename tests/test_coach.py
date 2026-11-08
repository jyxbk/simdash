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


def _handling_lap(i, extra_steer=None, counter=None, noise=0.0):
    """Runde auf einer echten Linie: Krümmung aus Quer-g, Lenkung = 12·k + 0,06·g (+ Störungen)."""
    import math, random
    rnd = random.Random(i)
    corners = [(30, 90, 10), (90, 140, 8), (150, 70, 12)]
    lap = make_lap(i, corners)
    v = lap["trace"]["v"]
    ds = LENGTH / N
    # Krümmung: in Kurven Quer-g ≈ 1,5 g, Vorzeichen abwechselnd (links/rechts)
    k = [0.0] * N
    for ci, (apex, vmin, w) in enumerate(corners):
        sgn = 1 if ci % 2 == 0 else -1
        for d in range(-w, w + 1):
            j = (apex + d) % N
            k[j] = sgn * 1.5 * 9.81 / (v[j] / 3.6) ** 2 * (1 - abs(d) / (w + 1))
    # Rest auf volle Umdrehung bringen, damit die Linie sich schließt (für den Test egal)
    x, z, hd = [], [], 0.0
    px = pz = 0.0
    for j in range(N):
        x.append(round(px, 2)); z.append(round(pz, 2))
        hd += k[j] * ds
        px += math.cos(hd) * ds; pz += math.sin(hd) * ds
    st = []
    for j in range(N):
        g = (v[j] / 3.6) ** 2 * abs(k[j]) / 9.81
        val = (12 * abs(k[j]) + 0.06 * g) * (1 if k[j] >= 0 else -1) + rnd.uniform(-noise, noise)
        st.append(val)
    if extra_steer:
        lo, hi, f = extra_steer
        for j in range(lo, hi):
            st[j] *= f
    if counter:
        for j in counter:
            st[j] = -0.08 * (1 if k[j] >= 0 else -1)
    lap["trace"].update(x=x, z=z, st=[round(s_, 3) for s_ in st])
    return lap


def test_handling_under_and_oversteer():
    laps = [_handling_lap(i, extra_steer=(87, 94, 1.8), counter=[152, 153] if i % 2 else None, noise=0.005)
            for i in range(1, 7)]
    r = coach.handling(laps)
    assert r["ok"] and r["laps_used"] == 6
    k2 = next(c for c in r["corners"] if abs(c["apex"] - 90 / N) < 0.02)
    k3 = next(c for c in r["corners"] if abs(c["apex"] - 150 / N) < 0.02)
    assert any(p["kind"] == "under" for p in k2["phases"])
    assert any(p["kind"] == "over" for p in k3["phases"])
    titles = [f["title"] for f in r["findings"]]
    assert any("Schiebt" in t for t in titles) and any("Heck" in t for t in titles)


def test_handling_needs_steering_and_position():
    laps = [make_lap(i, BASE) for i in range(1, 5)]
    assert coach.handling(laps)["ok"] is False


def _esses_lap(i=1, with_xz=True, with_yaw=False):
    """Gerade, dann Links-Rechts-Wechsel ohne Tempo-Spitze dazwischen, dann eine Haarnadel."""
    import math
    v = [250.0] * N
    k = [0.0] * N
    # Esses bei 40..70: Tempo fällt auf 160 und bleibt, Krümmung erst +, dann −
    for j in range(36, 76):
        v[j] = 160.0
    for j in range(40, 55):
        k[j] = 1 / 120
    for j in range(55, 70):
        k[j] = -1 / 120
    # Haarnadel bei 140
    for d in range(-12, 13):
        v[140 + d] = min(v[140 + d], 70 + 180 * abs(d) / 12)
    for j in range(134, 147):
        k[j] = 1 / 40
    t, acc, x, z, hd, px, pz = [], 0.0, [], [], 0.0, 0.0, 0.0
    ds = LENGTH / N
    for j in range(N):
        t.append(round(acc)); acc += ds / (v[j] / 3.6) * 1000
        x.append(round(px, 2)); z.append(round(pz, 2))
        hd += k[j] * ds; px += math.cos(hd) * ds; pz += math.sin(hd) * ds
    tr = {"step": 1 / N, "t": t, "v": v, "thr": [100] * N, "brk": [0] * N}
    if with_xz:
        tr.update(x=x, z=z)
    if with_yaw:
        tr["yaw"] = [round(k[j] * v[j] / 3.6, 4) for j in range(N)]
    return {"id": i, "lap_number": i, "lap_time_ms": round(acc), "valid": True, "estimated": False,
            "outlap": False, "inlap": False, "recorded_at": f"2026-11-01T10:{i:02d}:00", "trace": tr}


def test_detect_corners_splits_esses():
    lap = _esses_lap()
    speed_only = coach.find_corners(coach._filled(lap["trace"]["v"], N))
    cs = coach.detect_corners(lap, N)
    apexes = sorted(c["apex"] for c in cs)
    assert len(cs) == len(speed_only) + 1 == 3          # Esses als zwei Kurven
    assert any(40 <= a < 55 for a in apexes) and any(55 <= a < 70 for a in apexes)
    assert any(abs(a - 140) <= 3 for a in apexes)
    # Grenze zwischen den Esses liegt am Richtungswechsel
    second = next(c for c in cs if 55 <= c["apex"] < 70)
    assert 52 <= second["start"] <= 58


def test_detect_corners_from_yaw_without_positions():
    lap = _esses_lap(with_xz=False, with_yaw=True)
    assert len(coach.detect_corners(lap, N)) == 3


def test_geometry_lap_prefers_line_and_resolution():
    a, b = _esses_lap(1), _esses_lap(2, with_xz=False)
    b["lap_time_ms"] -= 1000                              # schneller, aber ohne Linie
    assert coach.geometry_lap([a, b])["id"] == 1


def test_handling_reports_cost():
    laps = [_handling_lap(i, counter=[152, 153] if i % 2 else None, noise=0.005) for i in range(1, 7)]
    for l in laps:                                         # Runden mit Gegenlenken 200 ms langsamer in Kurve 3
        if l["id"] % 2:
            t = l["trace"]["t"]
            l["trace"]["t"] = [x + (200 if k > 155 else 0) for k, x in enumerate(t)]
            l["lap_time_ms"] += 200
    r = coach.handling(laps)
    over = next(f for f in r["findings"] if f["kind"] == "over")
    assert 150 <= over["cost_ms"] <= 250
