import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

import coach  # noqa: E402

N = 800


def lap(steer, yaw=None):
    tr = {"step": 1 / N, "t": [i * 100 for i in range(N)], "v": [150.0] * N, "st": steer}
    if yaw is not None:
        tr["yaw"] = yaw
    return {"trace": tr}


def bump(center, width, peak, wobble=0.0, n_wobble=0):
    out = []
    for i in range(N):
        x = (i - center) / width
        v = peak * math.exp(-x * x) if abs(x) < 3 else 0.0
        if n_wobble and abs(x) < 1.2:
            v += wobble * math.sin(i / 3.0)
        out.append(round(v, 3))
    return out


C = {"start": 360, "apex": 400, "end": 470}


def test_turn_in_unwind_and_clean_corner():
    m = coach._steer_detail(lap(bump(400, 25, 0.4))["trace"], bump(400, 25, 0.4), C, N, 4, None)
    assert m["turn_in"] < 400 < m["unwind"]
    assert m["corrections"] == 0


def ramp(points):
    """Lenkverlauf aus Stützpunkten (Index, Wert), linear dazwischen."""
    out = [0.0] * N
    for (i0, v0), (i1, v1) in zip(points, points[1:]):
        for i in range(i0, i1 + 1):
            out[i] = v0 + (v1 - v0) * (i - i0) / max(1, i1 - i0)
    return out


def test_corrections_counted():
    # rein, zurück, nach, zurück, nach, raus = 4 Wechsel → 3 Korrekturen
    st = ramp([(340, 0), (370, 0.3), (380, 0.2), (390, 0.4), (400, 0.3), (410, 0.42), (450, 0), (460, 0)])
    m = coach._steer_detail(lap(st)["trace"], st, C, N, 4, None)
    assert m["corrections"] >= 3


def test_countersteer_detected():
    st = bump(400, 25, 0.4)
    yaw = [s * 2 for s in st]
    yaw[430:445] = [-0.5] * 15                 # Heck kommt: Auto dreht gegen die Lenkung
    st2 = st[:]
    st2[430:445] = [0.1] * 15
    m = coach._steer_detail(lap(st2, yaw)["trace"], st2, C, N, 4, None)
    assert m["countersteer"] is True
    m2 = coach._steer_detail(lap(st, [s * 2 for s in st])["trace"], st, C, N, 4, None)
    assert m2["countersteer"] is False


def test_tips_turn_in_and_unwind():
    ref = {"turn_in": 370.0, "unwind": 440.0, "corrections": 4, "countersteer": True}
    best = {"turn_in": 380.0, "unwind": 425.0, "corrections": 1, "countersteer": False}
    kinds = {t["kind"]: t for t in coach.control_tips(ref, best, N, 5.0)}
    assert kinds["turn_in_later"]["value"] == 50
    assert kinds["unwind_earlier"]["value"] == 75
    assert "fewer_corrections" in kinds and "no_countersteer" in kinds
