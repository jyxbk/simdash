import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "collector"))

import simdash_collector as sc  # noqa: E402
from simdash_collector import STATUS_LIVE, STATUS_OFF, STATUS_PAUSE, LapDetector, Snapshot  # noqa: E402


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def snap(**kw):
    d = dict(game="acevo", status=STATUS_LIVE, packet_id=1, lap_count=0, current_ms=0, last_ms=-1,
             best_ms=-1, valid_now=True, npos=0.0, in_pit_lane=False, track="road_atlanta",
             layout="", car="bmw_m4_gt3", session_type="time_attack", online=True)
    d.update(kw)
    return Snapshot(**d)


class Drive:
    """Fährt Runden im 20-ms-Takt nach."""

    def __init__(self):
        self.clock = Clock()
        self.det = LapDetector(clock=self.clock)
        self.laps = []
        self.count = 0
        self.last = -1
        self.kw = {}

    def feed(self, **kw):
        self.laps += self.det.update(snap(lap_count=self.count, last_ms=self.last, **{**self.kw, **kw}))
        self.clock.t += 0.02

    def lap(self, ms, invalid_at=None, pit_start=False, pit_end=False, counter=True, counter_delay=0,
            last_delay=0):
        steps = ms // 1000
        for i in range(steps):
            cur = i * 1000 + 500
            valid = not (invalid_at is not None and cur >= invalid_at)
            pit = (pit_start and i < 3) or (pit_end and i > steps - 3)
            self.feed(current_ms=cur, npos=min(cur / ms, 0.999), valid_now=valid, in_pit_lane=pit)
        self.feed(current_ms=ms - 5, npos=0.9995, valid_now=invalid_at is None, in_pit_lane=pit_end)
        # Ziellinie: Zeit springt auf 0; Zähler/last_ms kommen evtl. ein paar Frames später
        for f in range(max(counter_delay, last_delay) + 1):
            if counter and f >= counter_delay:
                self.count_target = True
            c = self.count + (1 if counter and f >= counter_delay else 0)
            last = ms if counter and f >= last_delay else self.last
            self.laps += self.det.update(snap(lap_count=c, last_ms=last, current_ms=20 * (f + 1),
                                              npos=0.001, valid_now=False if f == 0 else True, **self.kw))
            self.clock.t += 0.02
        if counter:
            self.count += 1
            self.last = ms

    def settle(self):
        for _ in range(100):
            self.feed(current_ms=3000, npos=0.03)


def test_normal_laps():
    d = Drive()
    d.feed()                     # Session-Start
    d.lap(81234)
    d.lap(81999)
    d.settle()
    assert [l.lap_time_ms for l in d.laps] == [81234, 81999]
    assert all(l.valid is True and not l.estimated for l in d.laps)
    assert [l.lap_number for l in d.laps] == [1, 2]
    assert len({l.session_uid for l in d.laps}) == 1


def test_invalid_lap_latched_and_reset_for_next():
    d = Drive()
    d.feed()
    d.lap(82000, invalid_at=40000)
    d.lap(81500)
    d.settle()
    assert [l.valid for l in d.laps] == [False, True]


def test_last_time_arrives_late():
    d = Drive()
    d.feed()
    d.lap(81234, last_delay=5)
    d.settle()
    assert d.laps[0].lap_time_ms == 81234 and not d.laps[0].estimated


def test_counter_arrives_after_time_reset_keeps_flags():
    d = Drive()
    d.feed()
    d.lap(83000, invalid_at=10000, pit_start=True, counter_delay=4)
    d.settle()
    assert len(d.laps) == 1
    lap = d.laps[0]
    assert lap.lap_time_ms == 83000 and not lap.estimated
    assert lap.valid is False and lap.outlap is True


def test_no_counter_gives_estimated_lap():
    # z. B. Server weg: Zeit springt an der Linie auf 0, Zähler bleibt stehen
    d = Drive()
    d.feed()
    d.lap(81260, counter=False)
    d.settle()
    assert len(d.laps) == 1
    assert d.laps[0].estimated and abs(d.laps[0].lap_time_ms - 81260) <= 50


def test_game_off_flushes_pending_lap():
    d = Drive()
    d.feed()
    d.lap(81234, last_delay=50)   # last_ms kommt nie, weil das Spiel vorher weg ist
    d.laps += d.det.update(snap(status=STATUS_OFF))
    assert len(d.laps) == 1 and d.laps[0].lap_time_ms >= 81000


def test_pause_does_not_split_session():
    d = Drive()
    d.feed()
    d.lap(81000)
    for _ in range(10):
        d.laps += d.det.update(snap(status=STATUS_PAUSE, lap_count=1, last_ms=81000))
    d.lap(82000)
    d.settle()
    assert len({l.session_uid for l in d.laps}) == 1 and len(d.laps) == 2


def test_new_session_on_track_change():
    d = Drive()
    d.feed()
    d.lap(81000)
    d.settle()
    first = d.laps[0].session_uid
    d.count, d.last = 0, -1
    d.laps += d.det.update(snap(track="spa"))
    d.clock.t += 0.02
    d.lap(140000)
    d.settle()
    assert d.laps[1].session_uid != first and d.laps[1].track == "road_atlanta" or d.laps[1].track == "spa"


def test_inlap_flag():
    d = Drive()
    d.feed()
    d.lap(95000, pit_end=True)
    d.settle()
    assert d.laps[0].inlap is True


def test_struct_layout_sizes():
    # feste Unterblöcke laut Kunos-Doku
    assert sc.ctypes.sizeof(sc.EvoTyre) == 256 and sc.ctypes.sizeof(sc.EvoSession) == 256
    # AC1/ACC: gemeinsamer Anfang gleich
    assert sc.AccGraphics.normalizedCarPosition.offset == sc.Ac1Graphics.normalizedCarPosition.offset
    assert sc.AccGraphics.completedLaps.offset == 132 and sc.AccGraphics.iCurrentTime.offset == 140


def test_trace_on_lap():
    d = Drive()
    d.feed()
    d.lap(80000)
    d.settle()
    tr = d.laps[0].trace
    assert tr and len(tr["t"]) == 800 and tr["v"] is None
    # bei 50 % der Runde ungefähr 40 s
    assert abs(tr["t"][400] - 40000) < 1500
    assert all(a is None or b is None or a <= b for a, b in zip(tr["t"], tr["t"][1:]))


def test_build_trace_gaps_and_wrap():
    # Outlap ab 40 %: davor None; Werte vom alten Rundenende (npos 0.99 bei t<5 s) ignoriert
    samples = [(0.99, 100, 200.0, 1.0, 0.0)] + [(0.4 + i * 0.004, 30000 + i * 400, 150.0, 0.5, 0.0) for i in range(150)]
    tr = sc.build_trace(samples)
    assert tr["t"][0] is None and tr["t"][319] is None and tr["t"][324] is not None
    assert tr["thr"][600] == 50 and tr["v"][600] == 150.0


def test_build_trace_too_short():
    assert sc.build_trace([(i / 100, i * 100, None, None, None) for i in range(10)]) is None


def test_build_trace_positions():
    samples = [(i / 100, i * 800, 150.0, 1.0, 0.0, 100.0 + i, -50.0 - 2 * i) for i in range(101)]
    tr = sc.build_trace(samples)
    assert tr["x"][400] == 150.0 and tr["z"][400] == -150.0
    # alte 5er-Proben: keine Positionen
    tr = sc.build_trace([s[:5] for s in samples])
    assert tr["x"] is None and tr["z"] is None


def test_coords_player_and_missing():
    arr = [0.0] * 180
    arr[3:6] = [12.5, 3.0, -7.25]
    assert sc.coords(arr, 1) == {"pos_x": 12.5, "pos_z": -7.25}
    assert sc.coords(arr, 0) == {"pos_x": None, "pos_z": None}


def test_evo_substructs_and_physics():
    import ctypes
    assert ctypes.sizeof(sc.EvoTyre) == 256 and ctypes.sizeof(sc.EvoDamage) == 128
    assert ctypes.sizeof(sc.EvoElectronicsS) == 128 and sc.EvoElectronicsS.brake_bias.offset == 8
    assert sc.EvoGraphics.npos.offset == 1244 and sc.EvoGraphics.total_lap_count.offset == 2384
    import struct

    class M:
        size = 800
        def open(self): return True
        def read_bytes(self, o, n):
            b = bytearray(800)
            struct.pack_into("<3f", b, 44, 0.5, 1.0, -1.2)
            struct.pack_into("<4f", b, 152, 80, 81, 79, 78)
            struct.pack_into("<f", b, 564, 0.56)
            return bytes(b[o:o + n])
    t = sc.kunos_physics(M())
    assert t["g"] == [0.5, -1.2] and t["tc"] == [80, 81, 79, 78] and t["bb"] == 0.56 and t["tp"] is None


def test_build_trace_gear_steer():
    samples = [(i / 100, i * 800, 150.0, 1.0, 0.0, None, None, 3 if i < 50 else 4, -0.5 + i / 100) for i in range(101)]
    tr = sc.build_trace(samples)
    assert tr["g"][100] == 3 and tr["g"][600] == 4 and tr["x"] is None
    assert abs(tr["st"][400] - 0.0) < 0.02


def test_build_trace_lateral_g_and_yaw():
    samples = [(i / 100, i * 800, 150.0, 1.0, 0.0, 0.0, 0.0, 3, 0.1, 1.2, 0.35) for i in range(101)]
    tr = sc.build_trace(samples)
    assert tr["ay"][400] == 1.2 and tr["yaw"][400] == 0.35
    tr = sc.build_trace([s[:9] for s in samples])          # ältere Proben ohne die Werte
    assert tr["ay"] is None and tr["yaw"] is None


class _FakeMap:
    def __init__(self, d):
        self.d = d

    def read(self, _t):
        return self.d

    def open(self):
        return True

    def close(self):
        pass


def _p2(**kw):
    d = sc.P2Shared()
    d.mVersion, d.mGameState, d.mSessionState, d.mViewedParticipantIndex = 14, 2, 1, 0
    me = d.mParticipantInfo[0]
    me.mName = b"Alex"
    me.mCurrentLapDistance, me.mLapsCompleted = 1000.0, 3
    me.mWorldPosition[0], me.mWorldPosition[2] = 12.5, -40.0
    d.mTrackLength = 4000.0
    d.mTrackLocation, d.mTrackVariation, d.mCarName = b"Interlagos", b"GP", b"Formula Classic"
    d.mCurrentTime, d.mLastLapTime, d.mBestLapTime = 21.5, 80.25, 79.9
    d.mSpeed, d.mThrottle, d.mBrake, d.mSteering, d.mGear, d.mRpm, d.mMaxRPM = 50.0, 0.8, 0.0, -0.2, 4, 9000, 10000
    d.mAngularVelocity[1], d.mLocalAcceleration[0] = 0.4, 19.6
    d.mFuelLevel, d.mFuelCapacity, d.mSequenceNumber = 0.5, 100.0, 42
    for k, v in kw.items():
        setattr(d, k, v)
    return d


def test_ams2_snapshot():
    src = sc.Ams2Source()
    src.m = _FakeMap(_p2())
    s = src.snapshot()
    assert (s.game, s.status, s.track, s.layout, s.car, s.driver) == ("ams2", sc.STATUS_LIVE, "Interlagos", "GP", "Formula Classic", "Alex")
    assert s.lap_count == 3 and s.current_ms == 21500 and s.last_ms == 80250 and s.best_ms == 79900
    assert abs(s.npos - 0.25) < 1e-6 and s.valid_now is True and not s.in_pit_lane
    assert s.speed_kmh == 180.0 and s.gear == 4 and s.pos_x == 12.5 and s.pos_z == -40.0 and s.session_type == "practice"
    assert s.tele["yaw"] == 0.4 and s.tele["fuel"] == 50.0 and abs(s.tele["g"][0] - 2.0) < 0.01
    # Rundenzähler springt zurück (Neustart) → neue Session
    sid = s.session_id
    me = src.m.d.mParticipantInfo[0]
    me.mLapsCompleted = 0
    assert src.snapshot().session_id != sid
    # Pause, ungültige Runde, Box
    src.m.d.mGameState, src.m.d.mLapInvalidated, src.m.d.mPitMode = 3, True, 2
    s = src.snapshot()
    assert s.status == sc.STATUS_PAUSE and s.valid_now is False and s.in_pit_lane


def test_ams2_layout_offsets():
    # Bekannte Offsets der pCARS2/AMS2-Schnittstelle (SharedMemory.h, Version 14)
    P = sc.P2Shared
    assert P.mParticipantInfo.offset == 28 and ctypes_size(sc.P2Participant) == 100
    assert P.mUnfilteredThrottle.offset == 6428 and P.mTrackLength.offset == 6704 and P.mLapInvalidated.offset == 6712


def ctypes_size(t):
    import ctypes
    return ctypes.sizeof(t)


class FakeSource:
    def __init__(self, name, avail=True):
        self.name, self.avail, self.closed = name, avail, 0

    def available(self):
        return self.avail

    def close(self):
        self.closed += 1


def test_pick_source_skips_stale_evo_for_acc():
    # SimHub hält die EVO-Mappings offen, ACC läuft wirklich: ACC muss gewählt werden.
    evo, acc = FakeSource("evo"), FakeSource("acc")
    stale = {id(evo): 100.0}
    assert sc.pick_source([evo, acc], stale, now=50.0) is acc
    assert evo.closed == 1


def test_pick_source_falls_back_to_stale_when_nothing_else():
    # Nur EVO da (z. B. Menü): trotzdem weiter beobachten, damit eine neue Fahrt erkannt wird.
    evo, acc = FakeSource("evo"), FakeSource("acc", avail=False)
    assert sc.pick_source([evo, acc], {id(evo): 100.0}, now=50.0) is evo
    assert evo.closed == 0


def test_pick_source_order_after_pause():
    evo, acc = FakeSource("evo"), FakeSource("acc")
    assert sc.pick_source([evo, acc], {id(evo): 100.0}, now=150.0) is evo
    assert sc.pick_source([FakeSource("x", False)], {}, now=0.0) is None


def test_lap_stats_averages_and_ignores_pit():
    s = sc.LapStats()
    te = {"tp": [27.0, 28.0, 26.0, 26.0], "ti": [80, 80, 80, 80], "bt": [500, 500, 400, 400], "bb": 0.56,
          "abs_on": True, "tc_on": False, "abs_lvl": 4, "fuel": 50.0}
    for i in range(60):
        s.add(dict(te, bt=[500 + i, 500, 400, 400], fuel=50.0 - i * 0.05, abs_on=i % 2 == 0), 150, False)
    s.add(dict(te, tp=[99, 99, 99, 99]), 150, True)   # Box: zählt nicht
    s.add(dict(te, tp=[99, 99, 99, 99]), 10, False)   # zu langsam: zählt nicht
    r = s.result()
    assert r["samples"] == 60 and r["tp"] == [27.0, 28.0, 26.0, 26.0]
    assert r["bt_max"][0] == 559 and r["abs_pct"] == 50.0 and r["abs_lvl"] == 4 and r["fuel_used"] == 2.95


def test_lap_stats_needs_enough_samples():
    s = sc.LapStats()
    for _ in range(10):
        s.add({"tp": [27, 27, 27, 27]}, 150, False)
    assert s.result() is None


def test_build_trace_abs_flags():
    smp = [(i / 100, i * 800, 150.0, 1.0, 0.0, None, None, 3, 0.0, 0.0, 0.0, i in (40, 41), False) for i in range(101)]
    tr = sc.build_trace(smp)
    assert tr["abs"] is not None and max(tr["abs"]) == 1 and max(tr["tcx"]) == 0


class FakeMap:
    """Nachgebauter LMU-Speicher; Positionen direkt aus der clang-Ausgabe (nicht aus sc.LMU)."""
    def __init__(self):
        self.buf = bytearray(324824)
        self.size = len(self.buf)

    def open(self):
        return True

    def close(self):
        pass

    def read_bytes(self, off, n):
        return bytes(self.buf[off:off + n])

    def put(self, off, fmt, *v):
        import struct
        struct.pack_into(fmt, self.buf, off, *v)


def test_lmu_snapshot_reads_expected_offsets():
    m = FakeMap()
    SI, VEH, TEL = 1632, 2192, 128468
    m.buf[SI:SI + 9] = b"Le Mans\0\0"
    m.put(SI + 64, "<i", 1)            # Session: Training
    m.put(SI + 88, "<d", 13626.0)      # Streckenlänge
    m.put(SI + 104, "<i", 3)           # Fahrzeuge
    m.buf[SI + 115] = 1                # Realtime
    m.put(128464, "<BB?", 3, 2, True)  # aktiv, Spieler-Index 2, hat Auto
    v = VEH + 1 * 584                  # Spieler ist Wertungseintrag 1
    m.buf[v + 4:v + 9] = b"Jere\0"
    m.buf[v + 36:v + 48] = b"Toyota GR010"
    m.put(v + 100, "<h", 5)
    m.put(v + 104, "<d", 6813.0)
    m.put(v + 144, "<d", 211.5)
    m.put(v + 168, "<d", 212.25)
    m.buf[v + 196] = 1
    m.put(v + 464, "<d", 100.0)
    t = TEL + 2 * 1888
    m.put(t + 12, "<d", 5000.0)
    m.put(t + 160, "<3d", 10.0, 2.0, -30.0)
    m.put(t + 184, "<3d", 30.0, 0.0, 40.0)        # 50 m/s
    m.put(t + 304, "<3d", 0.0, 0.42, 0.0)
    m.put(t + 352, "<i", 4)
    m.put(t + 356, "<d", 8000.0)
    m.put(t + 388, "<d", 0.8)
    m.put(t + 532, "<d", 10000.0)
    m.put(t + 664, "<d", 0.45)
    m.buf[t + 745] = 1
    m.buf[t + 746] = 1
    m.buf[t + 750] = 3
    w = t + 848 + 1 * 260                         # vorne rechts
    m.put(w + 120, "<d", 186.0)                   # kPa
    m.put(w + 128, "<3d", 353.15, 358.15, 363.15) # links/mitte/rechts K
    m.put(w + 24, "<d", 450.0)
    src = sc.LmuSource(mapping=m)
    assert src.available()
    s = src.snapshot()
    assert s.status == sc.STATUS_LIVE and s.track == "Le Mans" and s.car == "Toyota GR010" and s.driver == "Jere"
    assert s.lap_count == 5 and s.last_ms == 212250 and s.best_ms == 211500 and s.current_ms == 100000
    assert abs(s.npos - 0.5) < 1e-9 and s.valid_now is False and s.session_type == "practice"
    assert round(s.speed_kmh) == 180 and s.gear == 4 and s.rpm_pct == 0.8 and s.pos_z == -30.0
    te = s.tele
    assert te["yaw"] == 0.42 and te["bb"] == 0.55 and te["abs_on"] is True and te["tc_lvl"] == 3
    assert te["tp"][1] == 27.0 and te["bt"][1] == 450
    assert te["ti"][1] == 80 and te["to"][1] == 90 and te["tm"][1] == 85   # rechtes Rad: links = innen


def test_reset_to_pits_mid_lap_discards_partial_lap():
    """ACC 14.11.: Runde bei 17 % ungültig, dann "Zurück in die Box": Uhr -> 0, npos -> 1.0,
    Zähler bleibt. Die nächste (gültige) Runde darf die Ungültigkeit nicht erben."""
    d = Drive()
    d.feed()
    d.lap(91000)
    for i in range(18):                       # angefangene Runde, ab 5 s ungültig
        cur = i * 1000 + 500
        d.feed(current_ms=cur, npos=cur / 91000, valid_now=cur < 5000)
    d.feed(current_ms=32, npos=1.0, valid_now=True, in_pit_lane=True)   # Box
    d.feed(current_ms=1000, npos=0.002, valid_now=True, in_pit_lane=True)
    d.lap(95000, pit_start=True)
    d.settle()
    assert [l.lap_time_ms for l in d.laps] == [91000, 95000]
    out = d.laps[1]
    assert out.valid is True
    assert out.outlap is True
    assert out.lap_number == 2


def test_line_crossing_time_reset_before_counter_keeps_lap():
    """ACC setzt die Uhr an der Linie oft ein paar Frames vor dem Zähler zurück (npos ~1.0)."""
    d = Drive()
    d.feed()
    d.lap(91000, invalid_at=30000, counter_delay=3)
    d.settle()
    assert len(d.laps) == 1 and d.laps[0].valid is False


def test_race_start_lap_with_running_clock_is_outlap():
    """ACC online Spa 13.11.: Uhr lief seit der Startaufstellung, Runde 1 = 7:30 bei ~2:30 Fahrzeit."""
    d = Drive()
    d.kw = {"game": "acc"}
    d.feed(current_ms=0, npos=0.9)
    for i in range(150):                       # 150 s Fahrt, Uhr steht schon bei 300 s
        cur = 300_000 + i * 1000
        d.feed(current_ms=cur, npos=min(i / 150, 0.999))
    d.laps += d.det.update(snap(lap_count=1, last_ms=450_000, current_ms=20, npos=0.001, game="acc"))
    d.count, d.last = 1, 450_000
    d.lap(146000)
    d.settle()
    assert [l.lap_time_ms for l in d.laps] == [450_000, 146000]
    assert d.laps[0].outlap is True and "Startrunde" in d.laps[0].note
    assert d.laps[1].outlap is False and d.laps[1].note == ""


def test_acc_result_laps_player_only(tmp_path):
    import json as _json
    d = {"snapShot": {"leaderBoardLines": [
            {"car": {"carId": 0, "drivers": [{"playerId": "S7656"}, {"playerId": "S7656"}]}},
            {"car": {"carId": 5, "drivers": [{"playerId": "0"}]}}]},
         "laps": [{"carId": 0, "lapTime": 92270, "flags": 0}, {"carId": 5, "lapTime": 91000, "flags": 0},
                  {"carId": 0, "lapTime": 91382, "flags": 1}]}
    raw = _json.dumps(d).encode("utf-16-le")             # ACC schreibt UTF-16 ohne BOM
    assert sc.acc_result_laps(raw) == [{"lap_time_ms": 92270, "flags": 0}, {"lap_time_ms": 91382, "flags": 1}]
    f = tmp_path / "Race_1.json"
    f.write_bytes(raw)
    import os as _os, time as _time
    old = _time.time() - 60
    _os.utime(f, (old, old))
    w = sc.AccResults([tmp_path])
    ch = w.changed()
    assert [p for p, _ in ch] == [f]
    w.done(*ch[0])
    assert w.changed() == []


def test_formation_lap_crossing_is_no_lap():
    """ACC-Rennen 14.11.: Formationsrunde über die Linie (Uhr -> 0, Zähler bleibt 0) ergab 1:23.492 geschätzt."""
    d = Drive()
    d.kw = {"game": "acc", "session_type": "race"}
    d.feed(current_ms=0, npos=0.85)
    for i in range(84):
        d.feed(current_ms=i * 1000 + 500, npos=min(0.85 + i * 0.0018, 0.999))
    d.feed(current_ms=20, npos=0.001)          # Startlinie, Zähler bleibt 0
    d.lap(91392)
    d.settle()
    assert [l.lap_time_ms for l in d.laps] == [91392]
    assert d.laps[0].lap_number == 1 and not d.laps[0].estimated
