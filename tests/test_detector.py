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

    def feed(self, **kw):
        self.laps += self.det.update(snap(lap_count=self.count, last_ms=self.last, **kw))
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
                                              npos=0.001, valid_now=False if f == 0 else True))
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
