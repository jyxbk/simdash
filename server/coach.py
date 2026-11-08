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
    if sum(x is not None for x in t) / len(t) < MIN_COVER or sum(x is not None for x in v) / len(v) < MIN_COVER:
        return False
    # Verlauf muss zur Rundenzeit passen (sonst z. B. zwei Runden in einem Verlauf, Uhr nicht zurückgesetzt)
    last = next((x for x in reversed(t) if x is not None), None)
    lap_ms = l.get("lap_time_ms") or 0
    return last is not None and lap_ms > 0 and 0.85 * lap_ms <= last <= 1.02 * lap_ms


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


def _smooth(v: list[float], w: int = 1) -> list[float]:
    """Dreiecks-Glättung über ±w Punkte (rundum)."""
    n = len(v)
    ks = [(d, w + 1 - abs(d)) for d in range(-w, w + 1)]
    tot = sum(k for _, k in ks)
    return [sum(v[(i + d) % n] * k for d, k in ks) / tot for i in range(n)]


def resample(trace: dict, n: int) -> dict:
    """Verlauf auf n Punkte bringen (alte Runden mit 200, neue mit 800 Punkten vergleichbar)."""
    m = len(trace.get("t") or [])
    if not m or m == n:
        return trace
    out = {"step": 1 / n}
    for k, arr in trace.items():
        if not isinstance(arr, list) or len(arr) != m:
            continue
        res = []
        for i in range(n):
            pos = i * m / n
            lo = int(pos)
            hi = min(lo + 1, m - 1)
            f = pos - lo
            a, b = arr[lo], arr[hi]
            if k == "g":
                res.append(a if f < 0.5 or b is None else b)
            elif a is None or b is None or hi == lo:
                res.append(a if f < 0.5 else (b if hi != lo else a))
            else:
                val = a + (b - a) * f
                res.append(int(round(val)) if k in ("t", "thr", "brk") else round(val, 2))
        out[k] = res
    return out


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


def find_corners(v: list[float], drop: float = DROP_KMH, w: int = 1) -> list[dict]:
    """Kurven = Tempo-Minima (Spitzen-Suche mit Hysterese), rundum ab der schnellsten Stelle.

    Liefert je Kurve apex (Mindesttempo) und start (Tempo-Spitze davor = Anbremsen)."""
    n = len(v)
    s = _smooth(v, w)
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


def path_curvature(lap: dict, n: int) -> list[float] | None:
    """Krümmung der gefahrenen Linie (1/m): aus Gierrate/Tempo, sonst aus den x/z-Positionen.

    Das Vorzeichen ist je Quelle beliebig, aber innerhalb einer Runde einheitlich."""
    tr = lap["trace"]
    yaw, v = _filled(tr.get("yaw"), n), _filled(tr.get("v"), n)
    if yaw is not None and v is not None and sum(x is not None for x in tr["yaw"]) >= 0.9 * n:
        k = [y / (s / 3.6) if s > 30 else 0.0 for y, s in zip(yaw, v)]
        return _smooth(k, max(1, round(2 * n / 800)))
    return curvature(lap, n)


CURVE_K = 1 / 400       # ab Radius < 400 m ist die Linie „in einer Kurve“
CURVE_MIN_M = 50        # so lang muss der Bogen mindestens sein
CURVE_MAX_R = 300       # engster Radius des Bogens höchstens so groß (sonst Vollgas-Knick)


def detect_corners(lap: dict, n: int, m_per_idx: float | None = None) -> list[dict]:
    """Kurven aus Tempo UND Linie: Tempo-Minima finden die Bremskurven, die Krümmung trennt
    Wechselkurven (Esses) und findet Kurven ohne großen Tempoeinbruch. Nummeriert ab Ziellinie.

    Liefert je Kurve apex (Scheitel) und start (Grenze zur Kurve davor: Tempo-Spitze, in
    Wechselkurven ohne Spitze die gerade Stelle dazwischen)."""
    v = _filled(lap["trace"].get("v"), n)
    q = max(1, round(n / 200))
    speed = find_corners(v, w=q)
    apexes = [(c["apex"], "v") for c in speed]
    k = path_curvature(lap, n)
    ks = None
    if k is not None:
        ks = _smooth(k, max(1, round(3 * n / 800)))
        m = m_per_idx or (track_length(lap) / n)
        # Bögen mit gleichbleibender Richtung
        regions, i = [], 0
        while i < n:
            if abs(ks[i]) > CURVE_K:
                j, sg = i, ks[i] > 0
                while j + 1 < n and abs(ks[j + 1]) > CURVE_K and (ks[j + 1] > 0) == sg:
                    j += 1
                pk = max(range(i, j + 1), key=lambda x: abs(ks[x]))
                if (j - i + 1) * m >= CURVE_MIN_M and 1 / abs(ks[pk]) <= CURVE_MAX_R:
                    regions.append((i, j, pk))
                i = j + 1
            else:
                i += 1
        # Tempo-Minimum auf gerader Strecke direkt vor/nach einem Bogen ist kein Scheitel
        # (z. B. Bremsende vor dem Einlenken) → der Bogen bestimmt dort die Kurven
        apexes = [(a, src) for a, src in apexes
                  if abs(ks[a]) >= CURVE_K / 2 or not any(i - 6 * q <= a <= j + 6 * q for i, j, _ in regions)]
        for i, j, pk in regions:
            inside = [a for a, _ in apexes if i - q <= a <= j + q]
            if inside:
                continue
            # Scheitel: echtes Tempo-Minimum mitten im Bogen, sonst die engste Stelle (am Rand
            # liegt das Minimum oft nur, weil das Auto noch von der Kurve davor verzögert)
            seg = range(i + q, j - q + 1)
            vm = min(seg, key=lambda x: v[x]) if len(seg) else pk
            dip = min(v[i], v[j]) - v[vm]
            apexes.append((vm if dip >= 3 else pk, "k"))
    if not apexes:
        return []
    apexes.sort()
    uniq: list[tuple[int, str]] = []
    for a, src in apexes:
        if uniq and a - uniq[-1][0] < 2 * q:
            if src == "v":
                uniq[-1] = (a, src)
            continue
        uniq.append((a, src))
    if len(uniq) > 1 and (uniq[0][0] + n) - uniq[-1][0] < 2 * q:
        uniq.pop()
    idx = [a for a, _ in uniq]
    if len(idx) == 1:
        return [{"apex": idx[0], "start": max(range(n), key=lambda x: v[x])}]
    out = []
    for t, a in enumerate(idx):
        p = idx[t - 1]
        between = [(p + d) % n for d in range(1, (a - p) % n)]
        if not between:
            out.append({"apex": a, "start": a})
            continue
        vmax = max(between, key=lambda x: v[x])
        rise = min(v[vmax] - v[p], v[vmax] - v[a])
        if rise >= 5 or ks is None:
            b = vmax
        else:
            b = min(between, key=lambda x: abs(ks[x]))
        out.append({"apex": a, "start": b})
    return out


def geometry_lap(laps: list[dict]) -> dict | None:
    """Die Runde, aus der die Kurven einer Kombination bestimmt werden – für alle Auswertungen
    dieselbe, damit „Kurve 7“ überall dieselbe Kurve ist: feinster Verlauf mit Linie
    (Gierrate oder x/z), davon die schnellste saubere Runde."""
    cand = [l for l in laps if _counting(l) and _usable(l)]
    if not cand:
        return None
    def score(l):
        tr = l["trace"]
        has_line = bool(tr.get("yaw") or tr.get("x"))
        return (has_line, l.get("points") or len(tr.get("t") or []), -l["lap_time_ms"])
    return max(cand, key=score)


def _corners_from(geo: dict | None, ref: dict, n: int, m_per_idx: float | None = None) -> list[dict]:
    src = ref
    if geo is not None and _usable(geo):
        src = dict(geo, trace=resample(geo["trace"], n))
    return detect_corners(src, n, m_per_idx)


def corners_with_end(corners: list[dict], n: int) -> list[dict]:
    for i, c in enumerate(corners):
        c["end"] = corners[(i + 1) % len(corners)]["start"]
    if len(corners) == 1:
        corners[0]["end"] = corners[0]["start"]
    return corners


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
    q = max(1, round(n / 200))          # Fenster in Punkten, auf 200er-Raster abgestimmt
    tr = lap["trace"]
    v = _filled(tr.get("v"), n)
    brk = _filled(tr.get("brk"), n)
    thr = _filled(tr.get("thr"), n)
    a, apex, end = c["start"], c["apex"], c["end"]
    # Mindesttempo in der Nähe des Scheitels suchen (eigene Linie kann leicht verschoben sein)
    win = [(apex + d) % n for d in range(-4 * q, 4 * q + 1)]
    vmin_i = min(win, key=lambda i: v[i])
    m: dict[str, Any] = {"v_min": round(v[vmin_i], 1), "v_entry": round(max(v[(a + d) % n] for d in range(-2 * q, 2 * q + 1)), 1)}
    exit_i = (vmin_i + max(2 * q, ((end - vmin_i) % n) // 2)) % n
    m["v_exit"] = round(v[exit_i], 1)
    if brk is not None and max(brk[(a + k) % n] for k in range((apex - a) % n + 1)) >= BRAKE_ON:
        m["brake"] = _cross(brk, (a - 6 * q) % n, apex, BRAKE_ON)
        m["brake_max"] = round(max(brk[(a + k) % n] for k in range((apex - a) % n + 1)))
    if thr is not None:
        m["full_throttle"] = _cross(thr, (vmin_i - 2 * q) % n, end, THROTTLE_FULL)
    # Gang am Scheitel: häufigster echter Gang (kurzes N beim Schalten zählt nicht)
    g = tr.get("g")
    if g and len(g) == n:
        gears = [g[(vmin_i + d) % n] for d in range(-2 * q, 2 * q + 1)]
        gears = [x for x in gears if x is not None and x > 0]
        if gears:
            m["gear"] = max(set(gears), key=gears.count)
    st = _filled(tr.get("st"), n)
    if st is not None:
        vals = [st[(a + k) % n] for k in range((apex - a) % n + 10 * q)]
        if len(vals) > 1:
            m["steer_peak"] = round(max(abs(x) for x in vals), 2)
            m["steer_work"] = round(sum(abs(vals[i + 1] - vals[i]) for i in range(len(vals) - 1)), 2)
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


def control_tips(ref: dict, best: dict) -> list[dict]:
    """Gang und Lenkung: was die schnellere Fahrt anders macht (nur wenn beide Runden Daten haben)."""
    out = []
    a, b = ref.get("gear"), best.get("gear")
    if a and b and a != b:
        d = abs(b - a)
        word = "einen Gang" if d == 1 else f"{d} Gänge"
        out.append({"kind": "gear_higher" if b > a else "gear_lower", "value": b - a, "score": 1.6 * d,
                    "text": f"Nimm die Kurve {word} {'höher' if b > a else 'tiefer'} ({b}. statt {a}. Gang)"})
    wa, wb = ref.get("steer_work"), best.get("steer_work")
    if wa is not None and wb is not None and wa >= wb * 1.35 and wa - wb >= 0.5:
        pct = round((1 - wb / wa) * 100)
        out.append({"kind": "steer_calmer", "value": pct, "score": 1.2,
                    "text": f"Lenke ruhiger: die schnellere Fahrt kommt mit {pct} % weniger Lenkbewegung aus"})
    pa, pb = ref.get("steer_peak"), best.get("steer_peak")
    if pa is not None and pb is not None and pa - pb >= 0.06 and best["v_min"] - ref["v_min"] >= 2:
        out.append({"kind": "less_lock", "value": round((pa - pb) * 100), "score": 1.1,
                    "text": f"Du lenkst stärker ein ({round(pa * 100)} statt {round(pb * 100)} %) und bist trotzdem langsamer: sanfter einlenken"})
    return out


def analyze(laps: list[dict], geo: dict | None = None) -> dict:
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
    n = max(len(l["trace"]["t"]) for l in usable)
    for l in usable:
        l["trace"] = resample(l["trace"], n)
    for l in usable:
        t = list(l["trace"]["t"])
        if t[0] is None:
            t[0] = 0
        l["_t"] = _filled(t, len(t))
    ref = min(usable, key=lambda l: l["lap_time_ms"])
    clean = [l for l in usable if l["lap_time_ms"] <= ref["lap_time_ms"] * CLEAN_FACTOR]
    length = statistics.median([track_length(l) for l in clean])
    m_per_idx = length / n
    corners = _corners_from(geo or geometry_lap(usable), ref, n, m_per_idx)
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
        phases4 = None
        if best_l is not ref and len(corners) > 1:
            bounds = phase_bounds(best_l, c, n)
            pr, pb = _phase_times(ref, a, bounds, n), _phase_times(best_l, a, bounds, n)
            phases4 = [{"key": key, "label": label, "ms": round(x - y) if None not in (x, y) else None}
                       for (key, label), x, y in zip(PHASES, pr, pb)]
        tips = tips_for(rm, bm, n, m_per_idx) if gain >= 30 else []
        # Gang/Lenkung: alte Runden haben das nicht. Fehlt es bei Bestzeit oder Vorbild, vergleichen
        # wir die schnellste neuere Runde mit der schnellsten neueren Fahrt in dieser Kurve.
        ca, cb, note = rm, bm, ""
        has = lambda x: "gear" in x or "steer_work" in x
        if not (has(rm) and has(bm)):
            newer = [(l, t) for l, t in seg if l["trace"].get("g") or l["trace"].get("st")]
            ca, cb = None, None
            if newer:
                la, ta = min(newer, key=lambda x: x[0]["lap_time_ms"])
                lb, tb = min(newer, key=lambda x: x[1])
                ca, cb = _metrics(la, c, n), _metrics(lb, c, n)
                if ta - tb < 30:
                    cb = ca                      # kein echter Unterschied, also kein Tipp
                note = " (laut neueren Runden)"
        if gain >= 30 and ca is not None:
            tips += [{**t, "text": t["text"] + note} for t in control_tips(ca, cb)]
            tips.sort(key=lambda t: -t["score"])
        frac = lambda i: round((i % n) / n, 4)
        out.append({
            "no": k + 1, "start": frac(a), "apex": frac(c["apex"]), "end": frac(b),
            "ref_ms": round(ref_t), "best_ms": round(best_t), "gain_ms": round(gain),
            "median_ms": round(statistics.median(times)),
            "spread_ms": round(statistics.pstdev(times)) if len(times) > 1 else 0,
            "best_lap": {"id": best_l["id"], "lap_number": best_l.get("lap_number"), "lap_time_ms": best_l["lap_time_ms"]},
            "ref_metrics": _round_metrics(rm, c["apex"], n, m_per_idx), "best_metrics": _round_metrics(bm, c["apex"], n, m_per_idx),
            "gear": {"ref": ca.get("gear"), "best": cb.get("gear")} if ca is not None and ca.get("gear") else None,
            "phase": phase, "phases": phases4, "tips": tips or _phase_tip(phase, gain),
            "history": _history(usable, c, n, m_per_idx, ref["lap_time_ms"] * CLEAN_FACTOR),
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


def _history(laps: list[dict], c: dict, n: int, m_per_idx: float, clean_max: float) -> list[dict]:
    """Je Runde (chronologisch): Kurvenzeit, Mindesttempo, Bremspunkt – zeigt, ob ein Tipp wirkt."""
    out = []
    for l in sorted(laps, key=lambda l: l.get("recorded_at") or ""):
        ms = _seg_time(l["_t"], c["start"], c["end"], l["lap_time_ms"]) if c["start"] != c["end"] else l["lap_time_ms"]
        if ms is None or ms <= 0:
            continue
        m = _round_metrics(_metrics(l, c, n), c["apex"], n, m_per_idx)
        out.append({"id": l["id"], "lap_number": l.get("lap_number"), "recorded_at": l.get("recorded_at"),
                    "session_uid": l.get("session_uid") or "", "ms": round(ms), "clean": l["lap_time_ms"] <= clean_max,
                    "v_min": m.get("v_min"), "brake_m": m.get("brake_m"), "gear": m.get("gear"),
                    "steer_work": m.get("steer_work")})
    return out


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
    out = {k: m[k] for k in ("v_min", "v_entry", "v_exit", "brake_max", "gear", "steer_peak", "steer_work") if k in m}
    if m.get("brake") is not None:
        out["brake_m"] = round(((apex - m["brake"]) % n) * m_per_idx)
    if m.get("full_throttle") is not None:
        out["full_throttle_m"] = max(0, round(_dist(apex, m["full_throttle"], n, m_per_idx)))
    return out


# ---------------------------------------------------------------------------
# Runde gegen Referenz („Auto-Insights“): eine beliebige Runde Kurve für Kurve gegen eine
# Referenzrunde (Standard: deine Bestzeit), aufgeteilt in Anbremsen, Einlenken, Scheitel, Ausgang.
# ---------------------------------------------------------------------------
PHASES = (("brake", "Anbremsen"), ("turnin", "Einlenken"), ("apex", "Scheitel"), ("exit", "Ausgang"))


def phase_bounds(ref: dict, c: dict, n: int) -> list[int]:
    """Grenzen der 4 Phasen als Abstände (Rasterpunkte) ab Kurvenbeginn, aus der Referenzrunde.

    Anbremsen bis der größte Teil des Tempos abgebaut ist, Einlenken bis kurz vorm Scheitel, Scheitel ±2 Fenster,
    Ausgang bis zum Ende der Kurve (Gerade danach zählt mit)."""
    q = max(1, round(n / 200))
    w = 2 * q
    a = c["start"]
    span = (c["end"] - a) % n or n
    v = _filled(ref["trace"].get("v"), n)
    win = [(c["apex"] + d) % n for d in range(-4 * q, 4 * q + 1)]
    o_ap = (min(win, key=lambda i: v[i]) - a) % n if v else (c["apex"] - a) % n
    o_ap = min(max(o_ap, 1), span - 1)
    # Anbremsen = Kurvenbeginn bis 2/3 des Tempoabbaus geschafft sind (klappt auch ohne Pedaldaten
    # und bei Trailbraking, wo die Bremse erst am Scheitel ganz loslässt)
    o_rel = (o_ap - w) // 2
    if v:
        v0, vmin = max(v[(a + k) % n] for k in range(o_ap + 1)), v[(a + o_ap) % n]
        thr_v = vmin + (v0 - vmin) / 3
        o_rel = next((k for k in range(o_ap + 1) if v[(a + k) % n] <= thr_v), o_rel)
    b = [0, o_rel, o_ap - w, o_ap + w, span]
    b[1] = min(max(b[1], 0), max(0, o_ap - w))
    b[2] = max(b[2], b[1])
    b[3] = min(max(b[3], b[2]), span)
    return b


def _phase_times(lap: dict, a: int, bounds: list[int], n: int) -> list[float | None]:
    out = []
    for o1, o2 in zip(bounds, bounds[1:]):
        if o2 <= o1:
            out.append(0.0)
        else:
            out.append(_seg_time(lap["_t"], (a + o1) % n, (a + o2) % n, lap["lap_time_ms"]))
    return out


def _line(lap: dict, a: int, o1: int, o2: int, n: int, maxpts: int = 90) -> list[list[float]] | None:
    """x/z-Punkte der Runde zwischen zwei Abständen ab Kurvenbeginn (für den Linienvergleich)."""
    x, z = lap["trace"].get("x"), lap["trace"].get("z")
    if not x or not z or len(x) != n or len(z) != n:
        return None
    step = max(1, (o2 - o1) // maxpts)
    pts = []
    for o in range(o1, o2 + 1, step):
        i = (a + o) % n
        if x[i] is not None and z[i] is not None:
            pts.append([round(x[i], 2), round(z[i], 2)])
    return pts if len(pts) >= 5 else None


def _phase_text(key: str, lm: dict, rm: dict, n: int, m_per_idx: float) -> str | None:
    """Ein Satz, was in der Phase mit dem größten Verlust anders ist als bei der Referenz."""
    if key == "brake":
        db = _dist(lm.get("brake"), rm.get("brake"), n, m_per_idx)
        if db is not None and db >= 5:
            return f"Du bremst {round(db)} m früher als die Referenz"
        if db is not None and db <= -5:
            return f"Du bremst {round(-db)} m später, verlierst aber danach: zu spät oder zu stark angebremst"
        if lm.get("brake_max") and rm.get("brake_max") and lm["brake_max"] < rm["brake_max"] - 10:
            return f"Du bremst weniger hart ({lm['brake_max']} statt {rm['brake_max']} %) und dafür länger"
        dv = rm["v_entry"] - lm["v_entry"]
        if dv >= 3:
            return f"Du kommst mit {round(dv)} km/h weniger an"
    elif key in ("turnin", "apex"):
        dv = rm["v_min"] - lm["v_min"]
        if dv >= 2:
            return f"Dein Scheiteltempo ist {round(dv)} km/h niedriger ({lm['v_min']:.0f} statt {rm['v_min']:.0f} km/h)"
        if dv <= -3:
            return f"Du bist am Scheitel {round(-dv)} km/h schneller, aber verlierst: zu viel Tempo reingetragen, Linie leidet"
    elif key == "exit":
        dthr = _dist(rm.get("full_throttle"), lm.get("full_throttle"), n, m_per_idx)
        dv = rm["v_exit"] - lm["v_exit"]
        if dthr is not None and dthr >= 5:
            return f"Du gehst {round(dthr)} m später voll aufs Gas" + (f", {round(dv)} km/h weniger am Ausgang" if dv >= 2 else "")
        if dv >= 2:
            return f"Dein Ausgangstempo ist {round(dv)} km/h niedriger"
    return None


def _phase_fallback(lap: dict, ref: dict, a: int, bounds: list[int], k: int, n: int, m_per_idx: float, apex: int) -> str | None:
    """Ohne klares Merkmal: wo in der Phase fehlt am meisten Tempo, und bist du voll am Gas?"""
    vl, vr = _filled(lap["trace"].get("v"), n), _filled(ref["trace"].get("v"), n)
    tl, tr = _filled(lap["trace"].get("thr"), n), _filled(ref["trace"].get("thr"), n)
    idx = [(a + o) % n for o in range(bounds[k], bounds[k + 1] + 1)]
    if not idx or vl is None or vr is None:
        return None
    worst = max(idx, key=lambda i: vr[i] - vl[i])
    dv = vr[worst] - vl[worst]
    parts = []
    if tl is not None and tr is not None:
        al, ar = sum(tl[i] for i in idx) / len(idx), sum(tr[i] for i in idx) / len(idx)
        if ar - al >= 8:
            parts.append(f"weniger Gas als die Referenz (Ø {al:.0f} statt {ar:.0f} %)")
    if dv >= 2:
        where = round(_dist(apex, worst, n, m_per_idx) or 0)
        pos = f"{where} m nach dem Scheitel" if where >= 0 else f"{-where} m vor dem Scheitel"
        parts.append(f"bis zu {round(dv)} km/h langsamer ({pos})")
    if not parts:
        return None
    label = dict(PHASES)[PHASES[k][0]]
    return f"{label}: " + ", ".join(parts)


def _apex_offset(lap: dict, ref: dict, i: int, n: int) -> dict:
    """Seitlicher Abstand deiner Linie zur Referenz am Scheitel: + = weiter innen, − = weiter außen."""
    def xy(l, k):
        x, z = l["trace"].get("x"), l["trace"].get("z")
        return (x[k % n], z[k % n]) if x and z and x[k % n] is not None and z[k % n] is not None else None
    d = max(2, round(n / 100))
    p0, p1, p2, me = xy(ref, i - d), xy(ref, i), xy(ref, i + d), xy(lap, i)
    if None in (p0, p1, p2, me):
        return {}
    tx, tz = p2[0] - p0[0], p2[1] - p0[1]
    norm = (tx * tx + tz * tz) ** 0.5
    if norm < 1e-6:
        return {}
    # Seite der Kurve aus der Krümmung der Referenz, Abstand senkrecht zur Fahrtrichtung
    turn = (p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0])
    side = ((me[0] - p1[0]) * tz - (me[1] - p1[1]) * tx) / norm
    if abs(turn) < 1e-6:
        return {}
    inner = -side if turn > 0 else side
    return {"apex_offset_m": round(inner, 1), "apex_point": [round(p1[0], 2), round(p1[1], 2)]}


def compare_laps(lap: dict, ref: dict, geo: dict | None = None) -> dict:
    """Eine Runde gegen eine Referenzrunde: Verlust je Kurve und Phase, Tipps, Linien."""
    if not (_usable(lap) and _usable(ref)):
        return {"ok": False, "reason": "no_trace"}
    lap, ref = dict(lap), dict(ref)
    n = max(len(lap["trace"]["t"]), len(ref["trace"]["t"]))
    for l in (lap, ref):
        l["trace"] = resample(l["trace"], n)
        t = list(l["trace"]["t"])
        if t[0] is None:
            t[0] = 0
        l["_t"] = _filled(t, n)
    corners = _corners_from(geo, ref, n)
    res: dict[str, Any] = {"ok": True, "lap": {k: lap.get(k) for k in ("id", "lap_number", "lap_time_ms", "recorded_at", "driver")},
                           "ref": {k: ref.get(k) for k in ("id", "lap_number", "lap_time_ms", "recorded_at", "driver")},
                           "delta_ms": lap["lap_time_ms"] - ref["lap_time_ms"], "corners": []}
    if len(corners) < 2:
        return res
    for k, c in enumerate(corners):
        c["end"] = corners[(k + 1) % len(corners)]["start"]
    m_per_idx = track_length(ref) / n
    res["track_length_m"] = round(m_per_idx * n)
    q = max(1, round(n / 200))
    for k, c in enumerate(corners):
        a = c["start"]
        tl, tr = _seg_time(lap["_t"], a, c["end"], lap["lap_time_ms"]), _seg_time(ref["_t"], a, c["end"], ref["lap_time_ms"])
        if tl is None or tr is None:
            continue
        bounds = phase_bounds(ref, c, n)
        pl, pr = _phase_times(lap, a, bounds, n), _phase_times(ref, a, bounds, n)
        phases = [{"key": key, "label": label, "ms": round(x - y) if None not in (x, y) else None}
                  for (key, label), x, y in zip(PHASES, pl, pr)]
        lm, rm = _metrics(lap, c, n), _metrics(ref, c, n)
        loss = tl - tr
        tips: list[dict] = []
        main = None
        if loss >= 30:
            known = [p for p in phases if p["ms"] is not None]
            main = max(known, key=lambda p: p["ms"]) if known else None
            pt = _phase_text(main["key"], lm, rm, n, m_per_idx) if main and main["ms"] > 0 else None
            if not pt and main and main["ms"] > 0:
                pt = _phase_fallback(lap, ref, a, bounds, PHASES.index(next(x for x in PHASES if x[0] == main["key"])), n, m_per_idx, c["apex"])
            if pt:
                tips.append({"kind": f"phase_{main['key']}", "score": 99, "text": pt})
            same = {"brake": {"brake_later", "brake_earlier", "entry_speed"}, "turnin": {"carry_speed"},
                    "apex": {"carry_speed"}, "exit": {"throttle_earlier", "better_exit"}}
            skip = same.get(main["key"], set()) if tips and main else set()
            tips += [t for t in tips_for(lm, rm, n, m_per_idx) + control_tips(lm, rm) if t["kind"] not in skip]
        span = bounds[-1]
        mi = lambda m: max(1, round(m / m_per_idx)) if m_per_idx > 0 else 4 * q
        o_end = min(span, bounds[3] + mi(120))          # Kurve plus ~120 m Ausgang, nicht die ganze Gerade
        o_start = max(0, bounds[1] - mi(80))            # ~80 m vor Ende des Anbremsens
        line = None
        ll, lr = _line(lap, a, o_start, o_end, n), _line(ref, a, o_start, o_end, n)
        if ll and lr:
            line = {"lap": ll, "ref": lr, **_apex_offset(lap, ref, (a + (bounds[2] + bounds[3]) // 2) % n, n)}
        res["corners"].append({
            "no": k + 1, "start": round(a / n, 4), "apex": round(c["apex"] / n, 4), "end": round(c["end"] / n, 4),
            "lap_ms": round(tl), "ref_ms": round(tr), "loss_ms": round(loss), "phases": phases,
            "main_phase": main["key"] if main and main["ms"] > 0 else None, "tips": tips[:3],
            "lap_metrics": _round_metrics(lm, c["apex"], n, m_per_idx), "ref_metrics": _round_metrics(rm, c["apex"], n, m_per_idx),
            "line": line,
        })
    lost = sorted((c for c in res["corners"] if c["loss_ms"] >= 30), key=lambda c: -c["loss_ms"])
    res["problems"] = [c["no"] for c in lost]
    res["gained"] = [c["no"] for c in sorted(res["corners"], key=lambda c: c["loss_ms"]) if c["loss_ms"] <= -30]
    # Summe je Phase über die ganze Runde: wo verlierst du generell (Bremsen? Ausgänge?)
    tot = {key: 0 for key, _ in PHASES}
    for c in res["corners"]:
        for p in c["phases"]:
            if p["ms"] is not None:
                tot[p["key"]] += p["ms"]
    res["phase_totals"] = [{"key": key, "label": label, "ms": tot[key]} for key, label in PHASES]
    return res


# ---------------------------------------------------------------------------
# Fahrverhalten / Setup-Diagnose: Lenkung gegen die tatsächlich gefahrene Kurve.
# Aus x/z ergibt sich die Krümmung der Linie (1/Radius), daraus die Querbeschleunigung v²·k.
# Ein Modell „Lenkung = c1·k + c2·Quer-g“ wird über alle sauberen Runden angepasst; wer an
# einer Stelle deutlich mehr lenkt, als das Modell erwartet, schiebt dort (Untersteuern).
# Gegenlenken (Lenkung entgegen der Kurve) heißt: das Heck kommt (Übersteuern).
# ---------------------------------------------------------------------------
K_MIN = 0.002            # 1/m – darunter (Radius > 500 m) ist es keine Kurve
CS_K = 0.003             # Gegenlenken nur in echten Kurven werten
CS_ST = 0.02             # so viel Gegenlenken (Anteil Lenkbereich) zählt
US_RESID = 0.35          # normierte Mehr-Lenkung ab der wir „schiebt“ sagen
OS_SHARE = 0.25          # in so vielen Runden Gegenlenken → Übersteuern
HANDLING_PHASES = (("entry", "Einlenken"), ("mid", "Scheitel"), ("exit", "Ausgang"))


def curvature(lap: dict, n: int) -> list[float] | None:
    """Krümmung (1/m, mit Vorzeichen) entlang der Runde aus geglätteten x/z."""
    x, z = _filled(lap["trace"].get("x"), n), _filled(lap["trace"].get("z"), n)
    if x is None or z is None:
        return None
    w = max(1, round(4 * n / 800))
    d = max(1, round(3 * n / 800))
    x, z = _smooth(x, w), _smooth(z, w)
    import math
    k = []
    for i in range(n):
        a, b = (i - d) % n, (i + d) % n
        h1 = math.atan2(z[i] - z[a], x[i] - x[a])
        h2 = math.atan2(z[b] - z[i], x[b] - x[i])
        dh = (h2 - h1 + math.pi) % (2 * math.pi) - math.pi
        ds = math.hypot(x[b] - x[i], z[b] - z[i]) + math.hypot(x[i] - x[a], z[i] - z[a])
        k.append(2 * dh / ds if ds > 0.5 else 0.0)
    return k


def _countersteer(k: list[float], st: list[float], sgn: int, lag: int, n: int) -> set[int]:
    """Rasterpunkte mit echtem Gegenlenken: Lenkung gegen die Kurve, nicht beim Richtungswechsel
    (Krümmung hat ±6 Punkte dasselbe Vorzeichen) und entweder ≥2 Punkte lang oder deutlich (≥8 %)."""
    sign = lambda x: 1 if x > 0 else -1
    w = max(1, round(6 * n / 800))
    raw = []
    for i in range(n):
        kj = k[(i + lag) % n]
        if abs(kj) > CS_K and sgn * st[i] * sign(kj) < -CS_ST:
            raw.append(i)
    out: set[int] = set()
    k_run: list[int] = []
    for i in raw + [None]:
        if i is not None and (not k_run or i == k_run[-1] + 1):
            k_run.append(i)
            continue
        if k_run:
            kj = k[(k_run[0] + lag) % n]
            steady = all(sign(k[x % n]) == sign(kj) for x in range(k_run[0] - w, k_run[-1] + w + 1))
            deep = min(sgn * st[x] * sign(k[(x + lag) % n]) for x in k_run) <= -0.08
            if steady and (len(k_run) >= 2 or deep):
                out.update(k_run)
        k_run = [i] if i is not None else []
    return out


def _ls2(xs: list[tuple[float, float]], ys: list[float]) -> tuple[float, float] | None:
    a11 = sum(p[0] * p[0] for p in xs); a12 = sum(p[0] * p[1] for p in xs); a22 = sum(p[1] * p[1] for p in xs)
    b1 = sum(p[0] * y for p, y in zip(xs, ys)); b2 = sum(p[1] * y for p, y in zip(xs, ys))
    det = a11 * a22 - a12 * a12
    if abs(det) < 1e-12:
        return None
    return (b1 * a22 - b2 * a12) / det, (a11 * b2 - a12 * b1) / det


SETUP_HINTS = {
    ("entry", "under"): ("Schiebt beim Einlenken",
                         ["Bremsbalance 0,5–1 % nach hinten", "Stabilisator vorn eine Stufe weicher",
                          "Fahrer: etwas früher fertig bremsen oder beim Einlenken leicht auf der Bremse bleiben (Trailbraking)"]),
    ("mid", "under"): ("Schiebt am Scheitel",
                       ["Stabilisator vorn weicher oder hinten härter", "Mehr Abtrieb vorn (Frontflügel/Splitter, vorn tiefer)",
                        "Reifendruck vorn prüfen (im Fenster?)", "Fahrer: etwas weniger Tempo rein, früher gerade aufmachen"]),
    ("exit", "under"): ("Schiebt am Ausgang",
                        ["Weniger Differenzialsperre unter Last (Power)", "Stabilisator hinten eine Stufe härter",
                         "Fahrer: Gas erst aufbauen, wenn die Lenkung aufgeht"]),
    ("entry", "over"): ("Heck kommt beim Anbremsen/Einlenken",
                        ["Bremsbalance 0,5–1 % nach vorn", "Mehr Differenzialsperre im Schub (Coast/Preload)",
                         "Motorbremse (EBB) reduzieren, falls einstellbar", "Fahrer: Bremse sanfter lösen"]),
    ("mid", "over"): ("Heck kommt am Scheitel",
                      ["Stabilisator hinten weicher", "Mehr Heckflügel", "Fahrer: Scheiteltempo leicht senken, Lenkung ruhiger"]),
    ("exit", "over"): ("Heck kommt unter Gas",
                       ["Traktionskontrolle eine Stufe höher", "Stabilisator hinten weicher", "Heckflügel +1",
                        "Fahrer: Gas weicher und erst mit aufgehender Lenkung voll"]),
}


def handling(laps: list[dict], max_laps: int = 12, geo: dict | None = None) -> dict:
    """Fahrverhalten je Kurve und Phase aus Lenkung, Linie und Tempo.

    Braucht Lenkung und entweder Gierrate (Collector ≥ 0.7, auch iRacing) oder x/z-Positionen.
    Gemessene Querbeschleunigung (ay) wird bevorzugt, sonst aus v²·Krümmung berechnet."""
    pool = [l for l in laps if _counting(l) and _usable(l) and l["trace"].get("st")
            and (l["trace"].get("x") or l["trace"].get("yaw"))]
    res: dict[str, Any] = {"ok": False, "laps_used": 0}
    if len(pool) < 3:
        res["reason"] = "too_few_laps"
        res["laps_with_data"] = len(pool)
        return res
    pool.sort(key=lambda l: l["lap_time_ms"])
    pool = [l for l in pool if l["lap_time_ms"] <= pool[0]["lap_time_ms"] * CLEAN_FACTOR][:max_laps]
    if len(pool) < 3:
        res["reason"] = "too_few_laps"
        res["laps_with_data"] = len(pool)
        return res
    n = max(len(l["trace"]["t"]) for l in pool)
    data = []
    for l in pool:
        l = dict(l, trace=resample(l["trace"], n))
        k = path_curvature(l, n)
        st, v = _filled(l["trace"].get("st"), n), _filled(l["trace"].get("v"), n)
        if k is None or st is None or v is None:
            continue
        ay = _filled(l["trace"].get("ay"), n)
        if ay is not None and sum(x is not None for x in l["trace"]["ay"]) < 0.9 * n:
            ay = None
        g = [abs(x) for x in ay] if ay is not None else [(v[i] / 3.6) ** 2 * abs(k[i]) / 9.81 for i in range(n)]
        t = list(l["trace"]["t"])
        if t[0] is None:
            t[0] = 0
        l["_t"] = _filled(t, n)
        data.append({"lap": l, "k": k, "st": st, "v": v, "g": g, "measured_g": ay is not None,
                     "thr": _filled(l["trace"].get("thr"), n), "brk": _filled(l["trace"].get("brk"), n)})
    if len(data) < 3:
        res["reason"] = "too_few_laps"
        return res
    # Krümmung aus Gierrate und aus x/z haben verschiedene Vorzeichen-Konventionen → nur eine Quelle
    yaw_laps = [d for d in data if d["lap"]["trace"].get("yaw")]
    if len(yaw_laps) >= 3 and len(yaw_laps) < len(data):
        data = yaw_laps
    elif len(yaw_laps) < 3:
        for d in data:
            if d["lap"]["trace"].get("yaw"):
                d["k"] = curvature(d["lap"], n) or d["k"]
        data = [d for d in data if d["k"] is not None]
    lag = max(0, round(n / 800))                       # Lenkung kommt ~1 Punkt vor der Linie
    for d in data:
        d["cs"] = set()
    # Vorzeichen der Lenkung je Spiel unbekannt → aus der Korrelation mit der Krümmung bestimmen
    corr = sum(d["st"][i] * d["k"][(i + lag) % n] for d in data for i in range(n))
    sgn = 1 if corr >= 0 else -1
    sign = lambda x: 1 if x > 0 else -1
    xs, ys = [], []
    for d in data:
        for i in range(n):
            j = (i + lag) % n
            kj = d["k"][j]
            if abs(kj) > K_MIN:
                xs.append((abs(kj), d["g"][j]))
                ys.append(sgn * d["st"][i] * sign(kj))
    fit = _ls2(xs, ys)
    if not fit or fit[0] <= 0:
        res["reason"] = "no_fit"
        return res
    c1, c2 = fit
    for d in data:
        d["cs"] = _countersteer(d["k"], d["st"], sgn, lag, n)
    ref = data[0]["lap"]
    corners = _corners_from(geo or geometry_lap(laps), ref, n)
    if len(corners) < 2:
        res["reason"] = "no_corners"
        return res
    for i, c in enumerate(corners):
        c["end"] = corners[(i + 1) % len(corners)]["start"]
    m_per_idx = track_length(ref) / n
    exit_len = max(4, round(150 / m_per_idx)) if m_per_idx > 0 else n // 25
    out = []
    totals = {(p, kind): [] for p, _ in HANDLING_PHASES for kind in ("under", "over")}
    costs = {key: 0 for key in totals}
    for ci, c in enumerate(corners):
        b = phase_bounds(ref, c, n)
        a = c["start"]
        segs = {"entry": (b[0], b[2]), "mid": (b[2], b[3]), "exit": (b[3], min(b[4], b[3] + exit_len))}
        phases = []
        for key, label in HANDLING_PHASES:
            o1, o2 = segs[key]
            per, cs_laps, cs_thr, cs_brk, cs_fast = [], 0, [], [], []
            per_lap = []                                    # (Mehr-Lenkung, Gegenlenken?, Kurvenzeit)
            for di, d in enumerate(data):
                rs, kin, cs = [], [], []
                for o in range(o1, o2):
                    i = (a + o) % n
                    j = (i + lag) % n
                    kj = d["k"][j]
                    if abs(kj) <= K_MIN:
                        continue
                    stv = sgn * d["st"][i] * sign(kj)
                    pred = c1 * abs(kj) + c2 * d["g"][j]
                    rs.append(stv - pred)
                    kin.append(c1 * abs(kj))
                    if i in d["cs"]:
                        cs.append(i)
                if len(rs) >= 3:
                    per.append(statistics.mean(rs) / (statistics.mean(kin) + 0.02))
                    ct = _seg_time(d["lap"]["_t"], c["start"], c["end"], d["lap"]["lap_time_ms"])
                    if ct is not None and ct > 0:
                        per_lap.append((per[-1], bool(cs), ct))
                if cs:
                    cs_laps += 1
                    cs_fast.append(di)
                    if d["thr"] is not None:
                        cs_thr.append(statistics.mean(d["thr"][i] for i in cs))
                    if d["brk"] is not None:
                        cs_brk.append(statistics.mean(d["brk"][i] for i in cs))
            if not per:
                continue
            resid = statistics.mean(per)
            spread = statistics.pstdev(per) if len(per) > 1 else 0
            share = cs_laps / len(data)
            kind = None
            if share >= OS_SHARE:
                kind = "over"
            elif resid >= US_RESID and resid > spread:
                kind = "under"
            ph = {"key": key, "label": label, "steer_extra": round(resid, 2), "spread": round(spread, 2),
                  "countersteer_laps": cs_laps, "kind": kind}
            cost = _phase_cost(kind, per_lap)
            if cost is not None:
                ph["cost_ms"] = cost
            if cs_thr:
                ph["countersteer_throttle"] = round(statistics.mean(cs_thr))
            if cs_brk:
                ph["countersteer_brake"] = round(statistics.mean(cs_brk))
            if cs_laps:
                # Gegenlenken in den schnellen oder langsamen Runden? (Liste ist nach Zeit sortiert)
                ph["countersteer_in_fastest"] = sum(1 for x in cs_fast if x < max(1, len(data) // 3))
            if kind:
                # Ursache zählt mehr als der Ort: Gegenlenken unter Gas ist Leistungsübersteuern,
                # auf der Bremse ist es Bremsübersteuern – egal in welcher Phase es auftritt
                cause = key
                if kind == "over" and ph.get("countersteer_throttle", 0) >= 50:
                    cause = "exit"
                elif kind == "over" and ph.get("countersteer_brake", 0) >= 10:
                    cause = "entry"
                if ci + 1 not in totals[(cause, kind)]:
                    totals[(cause, kind)].append(ci + 1)
                costs[(cause, kind)] += max(0, ph.get("cost_ms") or 0)
            phases.append(ph)
        flags = [p for p in phases if p["kind"]]
        out.append({"no": ci + 1, "apex": round(c["apex"] / n, 4), "start": round(c["start"] / n, 4),
                    "end": round(c["end"] / n, 4), "phases": phases,
                    "text": [_handling_text(p, len(data)) for p in flags]})
    # Gesamtbild: was tritt in mehreren Kurven auf → Setup-Vorschlag
    findings = []
    for (key, kind), nos in totals.items():
        if not nos:
            continue
        title, hints = SETUP_HINTS[(key, kind)]
        findings.append({"key": key, "kind": kind, "title": title, "corners": nos,
                         "weight": len(nos) / len(corners), "cost_ms": costs[(key, kind)], "hints": hints})
    # Was am meisten Zeit kostet zuerst; ohne messbare Kosten nach Häufigkeit
    findings.sort(key=lambda f: (-f["cost_ms"], -f["weight"]))
    res.update({"ok": True, "laps_used": len(data), "model": {"c1": round(c1, 3), "c2": round(c2, 4)},
                "source": {"curvature": "yaw" if data[0]["lap"]["trace"].get("yaw") else "xz",
                           "lateral_g": "measured" if all(d["measured_g"] for d in data) else "computed"},
                "corners": out, "findings": findings,
                "laps": [{"id": d["lap"]["id"], "lap_time_ms": d["lap"]["lap_time_ms"]} for d in data]})
    return res


def _phase_cost(kind: str | None, per_lap: list[tuple[float, bool, float]]) -> int | None:
    """Was kostet das Problem in dieser Kurve? Runden mit gegen Runden ohne (Übersteuern) bzw.
    die Hälfte mit der meisten Mehr-Lenkung gegen die mit der wenigsten (Untersteuern)."""
    if kind == "over":
        w = [t for _, cs, t in per_lap if cs]
        wo = [t for _, cs, t in per_lap if not cs]
        if w and len(wo) >= 2:
            return round(statistics.mean(w) - statistics.mean(wo))
    elif kind == "under" and len(per_lap) >= 4:
        srt = sorted(per_lap, key=lambda x: x[0])
        h = len(srt) // 2
        return round(statistics.mean(t for _, _, t in srt[-h:]) - statistics.mean(t for _, _, t in srt[:h]))
    return None


def _handling_text(p: dict, nlaps: int) -> str:
    if p["kind"] == "over":
        how = ""
        if p.get("countersteer_throttle", 0) >= 50:
            how = " unter Gas"
        elif p.get("countersteer_brake", 0) >= 10:
            how = " auf der Bremse"
        txt = f"{p['label']}: Heck kommt{how} (Gegenlenken in {p['countersteer_laps']} von {nlaps} Runden)"
        if p.get("countersteer_in_fastest") == 0:
            txt += ", in deinen schnellsten Runden nicht"
        return txt + _cost_text(p)
    return f"{p['label']}: schiebt über die Vorderräder (du lenkst {round(p['steer_extra'] * 100)} % mehr, als die Kurve verlangt)" + _cost_text(p)


def _cost_text(p: dict) -> str:
    c = p.get("cost_ms")
    if c is None:
        return ""
    if c >= 30:
        return f" – kostet dort etwa {c / 1000:.2f} s".replace(".", ",")
    return " – kostet dort messbar keine Zeit"
