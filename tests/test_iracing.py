import ctypes
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "collector"))

import simdash_collector as sc  # noqa: E402

YAML = """---
WeekendInfo:
 TrackName: roadatlanta full
 TrackID: 127
 TrackDisplayName: Michelin Raceway Road Atlanta
 TrackConfigName: Full Course
 SessionID: 123456
 SubSessionID: 7654321
 WeekendOptions:
  NumStarters: 30
SessionInfo:
 Sessions:
 - SessionNum: 0
   SessionLaps: unlimited
   SessionType: Practice
   ResultsPositions:
   - Position: 1
     CarIdx: 3
 - SessionNum: 1
   SessionType: Lone Qualify
DriverInfo:
 DriverCarIdx: 5
 Drivers:
 - CarIdx: 0
   UserName: Pace Car
   CarScreenName: safety pcporsche911cup
 - CarIdx: 5
   UserName: Max Mustermann
   CarScreenName: BMW M4 GT3
...
"""


def test_session_info_parser():
    i = sc.ir_session_info(YAML)
    assert i["track"] == "Michelin Raceway Road Atlanta"
    assert i["layout"] == "Full Course"
    assert i["online"] is True
    assert i["sessions"] == {"0": "Practice", "1": "Lone Qualify"}
    assert i["drivers"]["5"] == {"car": "BMW M4 GT3", "name": "Max Mustermann"}


class FakeMapping:
    def __init__(self, data: bytes):
        self.data = data
        self.size = len(data)

    def open(self):
        return True

    def read_bytes(self, off, n):
        return self.data[off:off + n]

    def close(self):
        pass


def build_memory(values: dict, session_num=1) -> bytes:
    types = {"SessionNum": 2, "IsOnTrack": 1, "IsReplayPlaying": 1, "LapCompleted": 2,
             "LapLastLapTime": 4, "LapBestLapTime": 4, "LapCurrentLapTime": 4, "LapDistPct": 4,
             "OnPitRoad": 1, "PlayerTrackSurface": 2, "PlayerCarMyIncidentCount": 2}
    fmt = {1: "?", 2: "i", 4: "f"}
    hsize, vsize = ctypes.sizeof(sc.IrHeader), ctypes.sizeof(sc.IrVarHeader)
    var_off = hsize
    yaml = YAML.encode("cp1252") + b"\x00"
    info_off = var_off + vsize * len(types)
    buf_off = info_off + len(yaml)
    row = bytearray(64)
    vhs = b""
    pos = 0
    for name, t in types.items():
        vh = sc.IrVarHeader(type=t, offset=pos, count=1, name=name.encode())
        vhs += bytes(vh)
        val = values.get(name, session_num if name == "SessionNum" else 0)
        struct.pack_into("<" + fmt[t], row, pos, val)
        pos += 4
    hdr = sc.IrHeader(ver=2, status=1, tickRate=60, sessionInfoUpdate=1, sessionInfoLen=len(yaml),
                      sessionInfoOffset=info_off, numVars=len(types), varHeaderOffset=var_off,
                      numBuf=1, bufLen=len(row))
    hdr.varBuf[0][0] = 1000
    hdr.varBuf[0][1] = buf_off
    return bytes(hdr) + vhs + yaml + bytes(row)


def source_with(values):
    src = sc.IRacingSource()
    src.m = FakeMapping(build_memory(values))
    return src


def test_snapshot_values():
    s = source_with({"IsOnTrack": True, "LapCompleted": 4, "LapLastLapTime": 81.234,
                     "LapCurrentLapTime": 12.5, "LapDistPct": 0.15, "PlayerTrackSurface": 3,
                     "PlayerCarMyIncidentCount": 2}).snapshot()
    assert s.status == sc.STATUS_LIVE
    assert s.lap_count == 4 and s.last_ms == 81234 and s.current_ms == 12500
    assert s.valid_now is True and s.incidents == 2
    assert s.car == "BMW M4 GT3" and s.track == "Michelin Raceway Road Atlanta"
    assert s.session_type == "qualify" and s.session_id == "7654321:1" and s.online is True


def test_off_track_and_garage():
    s = source_with({"IsOnTrack": True, "PlayerTrackSurface": 0}).snapshot()
    assert s.valid_now is False
    s = source_with({"IsOnTrack": False}).snapshot()
    assert s.status == sc.STATUS_PAUSE
    s = source_with({"IsOnTrack": True, "IsReplayPlaying": True}).snapshot()
    assert s.status == sc.STATUS_REPLAY


def test_incidents_note():
    clock = [0.0]
    det = sc.LapDetector(clock=lambda: clock[0], settle_s=3.0)

    def snap(**kw):
        d = dict(game="iracing", status=sc.STATUS_LIVE, packet_id=1, lap_count=0, current_ms=0,
                 last_ms=-1, best_ms=-1, valid_now=True, npos=0.0, in_pit_lane=False,
                 track="Road Atlanta", layout="Full Course", car="BMW M4 GT3",
                 session_type="practice", incidents=0)
        d.update(kw)
        return sc.Snapshot(**d)

    laps = det.update(snap())
    for i in range(80):
        clock[0] += 1
        laps += det.update(snap(current_ms=i * 1000 + 500, npos=i / 81, incidents=0 if i < 40 else 2))
    clock[0] += 0.02
    laps += det.update(snap(lap_count=1, current_ms=20, npos=0.001, incidents=2))
    for i in range(5):   # iRacing liefert LapLastLapTime etwas später
        clock[0] += 0.5
        laps += det.update(snap(lap_count=1, last_ms=81500 if i >= 3 else -1, current_ms=500 * i, npos=0.01, incidents=2))
    assert len(laps) == 1
    assert laps[0].lap_time_ms == 81500 and laps[0].note == "+2x Incidents"
