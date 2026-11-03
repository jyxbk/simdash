"""Fahr-Coach: findet Kurven im Verlauf und vergleicht jede Kurve mit deiner besten Fahrt dort.

Eingabe sind Runden mit Verlauf (`trace`: t/v/thr/brk auf festem Raster entlang der Runde).
Jede Kurve reicht vom Bremspunkt davor bis zum Bremspunkt der nächsten Kurve. So zählt der
Ausgang auf die folgende Gerade mit, denn ein besserer Ausgang bringt dort die meiste Zeit.

Die beste Zeit in jeder Kurve, aus allen sauberen Runden, ergibt die „ideale Runde“. Der
Abstand der Bestzeit dazu ist das Potenzial, also Zeit, die du schon einmal gefahren bist.
"""
from __future__ import annotations

import statistics
from typing import Any

DROP_KMH = 12.0       # so viel muss das Tempo fallen und wieder steigen, damit es eine Kurve ist
CLEAN_FACTOR = 1.07   # Runden über 107 % der Bestzeit (Dreher, Verkehr) fließen nicht ein
MIN_COVER = 0.95      # Anteil Rasterpunkte mit Zeit
BRAKE_ON = 15         # % Bremse = Bremspunkt
THROTTLE_FULL = 90    # % Gas = voll am Gas


def _counting(l: dict) -> bool:
    return l.get("valid") is not False and not l.get("estimated") and not l.get("outlap") and not l.get("inlap")


def _usable(l: dict) -> bool:
    tr = l.get("trace") or {}
    t, v = tr.get("t") or [], tr.get("v") or []
    if not t or len(v) != len(t):
        return False
    return sum(x is not None for x in t) / len(t) >= MIN_COVER and sum(x is not None for x in v) / len(v) >= MIN_COVER


def _filled(arr: list | None, n: int) -> list[float] | None:
    """Lücken linear schließen (am Rand mit dem nächsten Wert); None, wenn fast leer."""
    if not arr or len(arr) != n or sum(x is not None for x in arr) < n * 0.5:
        return None
    out = list(arr)
    known = [i for i, x in enumerate(out) if x is not None]
    for i in range(n):
        if out[i] is None:
            lo = max((k for k in known if k < i), default=None)
            hi = min((k for k in known if k > i), default=None)
            if lo is None:
                out[i] = arr[hi]
            elif hi is None:
                out[i] = arr[lo]
            else:
                out[i] = arr[lo] + (arr[hi] - arr[lo]) * (i - lo) / (hi - lo)
    return [float(x) for x in out]


def _smooth(v: list[float]) -> list[float]:
    n = len(v)
    return [(v[(i - 1) % n] + 2 * v[i] + v[(i + 1) % n]) / 4 for i in range(n)]


def track_length(lap: dict) -> float:
    """Streckenlänge in m aus Tempo × Zeit entlang der Runde."""
    tr = lap["trace"]
    t, v = tr["t"], tr["v"]
    dist = 0.0
    for i in range(len(t) - 1):
        if None in (t[i], t[i + 1], v[i], v[i + 1]):
            continue
        dist += (v[i] + v[i + 1]) / 2 / 3.6 * (t[i + 1] - t[i]) / 1000
    covered = sum(1 for i in range(len(t) - 1) if None not in (t[i], t[i + 1], v[i], v[i + 1]))
    return dist * (len(t) - 1) / max(1, covered) * len(t) / (len(t) - 1) if covered else 0.0


def find_corners(v: list[float], drop: float = DROP_KMH) -> list[dict]:
    """Kurven = Tempo-Minima (Spitzen-Suche mit Hysterese), rundum ab der schnellsten Stelle.

    Liefert je Kurve apex (Mindesttempo) und start (Tempo-Spitze davor = Anbremsen)."""
    n = len(v)
    s = _smooth(v)
    off = max(range(n), key=lambda i: s[i])
    r = s[off:] + s[:off]
    maxima, minima = [], []
    mx, mxpos, mn, mnpos, look_max = r[0], 0, r[0], 0, True
    for i, x in enumerate(r):
        if x > mx:
            mx, mxpos = x, i
        if x < mn:
            mn, mnpos = x, i
        if look_max and x < mx - drop:
            maxima.append(mxpos)
            mn, mnpos, look_max = x, i, False
        elif not look_max and x > mn + drop:
            minima.append(mnpos)
            mx, mxpos, look_max = x, i, True
    return [{"apex": (mi + off) % n, "start": (ma + off) % n} for ma, mi in zip(maxima, minima)]


def _seg_time(t: list, a: int, b: int, lap_ms: int) -> float | None:
    """Zeit von Rasterpunkt a bis b (rundum über die Ziellinie)."""
    n = len(t)
    def at(i):
        return lap_ms if i == n else t[i]
    if a <= b:
        ta, tb = at(a), at(b)
        return tb - ta if None not in (ta, tb) and tb >= ta else None
    p, q = _seg_time(t, a, n, lap_ms), _seg_time(t, 0, b, lap_ms)
    return p + q if None not in (p, q) else None


def _cross(arr: list | None, a: int, b: int, thr: float, rising: bool = True) -> float | None:
    """Erste Stelle (mit Nachkomma, rundum) in a..b, an der arr die Schwelle überschreitet."""
    if arr is None:
        return None
    n = len(arr)
    span = (b - a) % n or n
    prev = arr[a % n]
    for k in range(1, span + 1):
        i = (a + k) % n
        cur = arr[i]
        if prev is not None and cur is not None:
            hit = (prev < thr <= cur) if rising else (prev > thr >= cur)
            if hit:
                return a + k - 1 + (thr - prev) / (cur - prev)
        prev = cur
    return None


def _metrics(lap: dict, c: dict, n: int) -> dict:
    tr = lap["trace"]
    v = _filled(tr.get("v"), n)
    brk = _filled(tr.get("brk"), n)
    thr = _filled(tr.get("thr"), n)
    a, apex, end = c["start"], c["apex"], c["end"]
    # Mindesttempo in der Nähe des Scheitels suchen (eigene Linie kann leicht verschoben sein)
    win = [(apex + d) % n for d in range(-4, 5)]
    vmin_i = min(win, key=lambda i: v[i])
    m: dict[str, Any] = {"v_min": round(v[vmin_i], 1), "v_entry": round(max(v[(a + d) % n] for d in range(-2, 3)), 1)}
    exit_i = (vmin_i + max(2, ((end - vmin_i) % n) // 2)) % n
    m["v_exit"] = round(v[exit_i], 1)
    if brk is not None and max(brk[(a + k) % n] for k in range((apex - a) % n + 1)) >= BRAKE_ON:
        m["brake"] = _cross(brk, (a - 6) % n, apex, BRAKE_ON)
        m["brake_max"] = round(max(brk[(a + k) % n] for k in range((apex - a) % n + 1)))
    if thr is not None:
        m["full_throttle"] = _cross(thr, vmin_i - 2, end, THROTTLE_FULL)
    return m


def _dist(i1: float | None, i2: float | None, n: int, m_per_idx: float) -> float | None:
    """Abstand i2 − i1 in m (positiv = i2 liegt später), rundum korrekt."""
    if i1 is None or i2 is None:
        return None
    d = (i2 - i1) % n
    if d > n / 2:
        d -= n
    return d * m_per_idx


def tips_for(ref: dict, best: dict, n: int, m_per_idx: float) -> list[dict]:
    """Was die beste Fahrt in dieser Kurve anders macht als die Bestzeit-Runde."""
    out = []
    db = _dist(ref.get("brake"), best.get("brake"), n, m_per_idx)
    dvmin = best["v_min"] - ref["v_min"]
    dthr = _dist(ref.get("full_throttle"), best.get("full_throttle"), n, m_per_idx)
    dexit = best["v_exit"] - ref["v_exit"]
    dentry = best["v_entry"] - ref["v_entry"]
    if db is not None and db >= 8:
        out.append({"kind": "brake_later", "value": round(db), "score": db / 8,
                    "text": f"Bremse etwa {round(db)} m später"})
    elif db is not None and db <= -8 and dvmin > 2:
        out.append({"kind": "brake_earlier", "value": round(-db), "score": -db / 10 + dvmin / 3,
                    "text": f"Bremse etwa {round(-db)} m früher und nimm mehr Tempo mit"})
    if dvmin >= 2:
        out.append({"kind": "carry_speed", "value": round(dvmin), "score": dvmin / 2.5,
                    "text": f"Nimm {round(dvmin)} km/h mehr Tempo durch den Scheitel ({best['v_min']:.0f} statt {ref['v_min']:.0f} km/h)"})
    if dthr is not None and dthr <= -8:
        out.append({"kind": "throttle_earlier", "value": round(-dthr), "score": -dthr / 8,
                    "text": f"Geh etwa {round(-dthr)} m früher voll aufs Gas"})
    if dexit >= 3 and not any(t["kind"] == "throttle_earlier" for t in out):
        out.append({"kind": "better_exit", "value": round(dexit), "score": dexit / 3,
                    "text": f"Besserer Ausgang: {round(dexit)} km/h mehr auf der Geraden danach"})
    if dentry >= 4 and not out:
        out.append({"kind": "entry_speed", "value": round(dentry), "score": dentry / 4,
                    "text": f"Komm mit {round(dentry)} km/h mehr an (Gerade davor sauberer)"})
    if not out and db is not None and db <= -8:
        out.append({"kind": "brake_later_ok", "value": round(-db), "score": 0.5,
                    "text": f"Die schnellere Fahrt hat {round(-db)} m früher gebremst und war trotzdem schneller (ruhiger rein)"})
    return sorted(out, key=lambda t: -t["score"])


def analyze(laps: list[dict]) -> dict:
    """laps: Runden einer Kombination mit trace. Gibt Kurven, Potenzial und Tipps zurück."""
    counting = [l for l in laps if _counting(l)]
    usable = [l for l in counting if _usable(l)]
    result: dict[str, Any] = {"laps_total": len(laps), "laps_counting": len(counting), "laps_used": 0, "corners": []}
    if counting:
        times = sorted(l["lap_time_ms"] for l in counting)
        result["pb_ms"] = times[0]
        clean_t = [t for t in times if t <= times[0] * CLEAN_FACTOR]
        result["consistency"] = {
            "laps": len(clean_t),
            "median_ms": round(statistics.median(clean_t)),
            "stdev_ms": round(statistics.pstdev(clean_t)) if len(clean_t) > 1 else 0,
            "within_05": sum(t <= times[0] + 500 for t in times),
            "within_1": sum(t <= times[0] + 1000 for t in times),
        }
    if not usable:
        return result
    for l in usable:
        t = list(l["trace"]["t"])
        if t[0] is None:
            t[0] = 0
        l["_t"] = _filled(t, len(t))
    ref = min(usable, key=lambda l: l["lap_time_ms"])
    clean = [l for l in usable if l["lap_time_ms"] <= ref["lap_time_ms"] * CLEAN_FACTOR]
    n = len(ref["trace"]["t"])
    clean = [l for l in clean if len(l["trace"]["t"]) == n]
    v_ref = _filled(ref["trace"]["v"], n)
    corners = find_corners(v_ref)
    length = statistics.median([track_length(l) for l in clean])
    m_per_idx = length / n
    result.update({"laps_used": len(clean), "ref": {"id": ref["id"], "lap_number": ref.get("lap_number"),
                   "lap_time_ms": ref["lap_time_ms"], "recorded_at": ref.get("recorded_at")},
                   "track_length_m": round(length), "step": ref["trace"].get("step", 1 / n)})
    if not corners:
        return result
    # Kurve k: vom Bremspunkt davor (Tempo-Spitze) bis zur Spitze vor der nächsten Kurve
    for k, c in enumerate(corners):
        c["end"] = corners[(k + 1) % len(corners)]["start"]
    if len(corners) == 1:
        corners[0]["end"] = corners[0]["start"]

    ideal = 0.0
    out = []
    for k, c in enumerate(corners):
        a, b = c["start"], c["end"]
        if len(corners) == 1:
            seg = [(l, l["lap_time_ms"]) for l in clean]
        else:
            seg = [(l, _seg_time(l["_t"], a, b, l["lap_time_ms"])) for l in clean]
        seg = [(l, s) for l, s in seg if s is not None and s > 0]
        ref_t = next((s for l, s in seg if l is ref), None)
        if ref_t is None or not seg:
            continue
        best_l, best_t = min(seg, key=lambda x: x[1])
        ideal += best_t
        times = [s for _, s in seg]
        rm = _metrics(ref, c, n)
        bm = _metrics(best_l, c, n) if best_l is not ref else rm
        gain = ref_t - best_t
        ap = c["apex"]
        phase = None
        if best_l is not ref and len(corners) > 1:
            e_r, e_b = _seg_time(ref["_t"], a, ap, ref["lap_time_ms"]), _seg_time(best_l["_t"], a, ap, best_l["lap_time_ms"])
            if None not in (e_r, e_b):
                phase = {"entry_ms": round(e_r - e_b), "exit_ms": round(gain - (e_r - e_b))}
        tips = tips_for(rm, bm, n, m_per_idx) if gain >= 30 else []
        frac = lambda i: round((i % n) / n, 4)
        out.append({
            "no": k + 1, "start": frac(a), "apex": frac(c["apex"]), "end": frac(b),
            "ref_ms": round(ref_t), "best_ms": round(best_t), "gain_ms": round(gain),
            "median_ms": round(statistics.median(times)),
            "spread_ms": round(statistics.pstdev(times)) if len(times) > 1 else 0,
            "best_lap": {"id": best_l["id"], "lap_number": best_l.get("lap_number"), "lap_time_ms": best_l["lap_time_ms"]},
            "ref_metrics": _round_metrics(rm, c["apex"], n, m_per_idx), "best_metrics": _round_metrics(bm, c["apex"], n, m_per_idx),
            "phase": phase, "tips": tips or _phase_tip(phase, gain),
        })
    result["corners"] = out
    covered = sum(c["ref_ms"] for c in out)
    if out and abs(covered - ref["lap_time_ms"]) < 50:
        result["ideal_ms"] = round(ideal)
        result["potential_ms"] = round(ref["lap_time_ms"] - ideal)
    # Wo streust du am meisten (Konstanz je Kurve)
    if len(clean) >= 3 and out:
        worst = max(out, key=lambda c: c["spread_ms"])
        result["least_consistent"] = worst["no"]
    return result


def _phase_tip(phase: dict | None, gain: float) -> list[dict]:
    """Ohne klares Merkmal wenigstens sagen, ob die Zeit rein oder raus verloren geht."""
    if not phase or gain < 30:
        return []
    if phase["entry_ms"] >= phase["exit_ms"]:
        return [{"kind": "entry", "value": phase["entry_ms"], "score": 0.3,
                 "text": "Die Zeit geht beim Anbremsen und Einlenken verloren, also bis zum Scheitel"}]
    return [{"kind": "exit", "value": phase["exit_ms"], "score": 0.3,
             "text": "Die Zeit geht nach dem Scheitel verloren: sauberer und früher rausbeschleunigen"}]


def _round_metrics(m: dict, apex: int, n: int, m_per_idx: float) -> dict:
    """Positionen als Meter relativ zum Scheitel (Bremspunkt: davor, Vollgas: danach)."""
    out = {k: m[k] for k in ("v_min", "v_entry", "v_exit", "brake_max") if k in m}
    if m.get("brake") is not None:
        out["brake_m"] = round(((apex - m["brake"]) % n) * m_per_idx)
    if m.get("full_throttle") is not None:
        out["full_throttle_m"] = max(0, round(_dist(apex, m["full_throttle"], n, m_per_idx)))
    return out
