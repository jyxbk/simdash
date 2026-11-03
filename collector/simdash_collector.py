"""SimDash-Collector für Windows.

Liest die Shared Memory von AC EVO, ACC und Assetto Corsa, erkennt fertige Runden
und schickt sie an den SimDash-Server. Jede Runde wird zuerst lokal gespeichert
(laps.csv + Warteschlange), damit nichts verloren geht, wenn Server oder Spiel
die Verbindung verlieren.

Nur Python-Standardbibliothek. Start:  py simdash_collector.py
Prüfen der Struktur-Offsets:           py simdash_collector.py --selftest
Live-Werte anzeigen (zum Testen):      py simdash_collector.py --dump
"""
from __future__ import annotations

import argparse
import configparser
import csv
import ctypes
import json
import logging
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from ctypes import (
    Structure, c_bool, c_char, c_float, c_int8, c_int16, c_int32, c_uint8, c_uint16,
    c_uint32, c_uint64,
)
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

VERSION = "0.6.0"
POLL_HZ = 50

log = logging.getLogger("simdash")


# ---------------------------------------------------------------------------
# Strukturen
# Breite Zeichen (wchar_t) sind auf Windows 2 Byte. ctypes.c_wchar wäre auf Linux
# 4 Byte, deshalb c_uint16-Arrays – so lassen sich die Offsets auch dort testen.
# ---------------------------------------------------------------------------

def wstr(arr) -> str:
    chars = []
    for c in arr:
        if c == 0:
            break
        chars.append(chr(c))
    return "".join(chars).strip()


def cstr(arr) -> str:
    return bytes(arr).split(b"\x00", 1)[0].decode("utf-8", "ignore").strip()


def _blob(name: str, size: int) -> type[Structure]:
    """Undurchsichtiger Unterblock fester Größe (laut Kunos-Doku), 4-Byte-ausgerichtet."""
    return type(name, (Structure,), {"_pack_": 4, "_layout_": "ms", "_fields_": [("raw", c_uint32 * (size // 4))]})


class EvoTyre(Structure):
    """SMEvoTyreState (256 B) – Aufbau wie in live-telemetry-evo. Druck in psi, Temperaturen °C,
    normalized_* = 1.0 im Idealbereich."""
    _layout_ = "ms"
    _pack_ = 4
    _fields_ = [
        ("slip", c_float), ("lock", c_bool), ("tyre_pressure", c_float),
        ("tyre_temperature_c", c_float), ("brake_temperature_c", c_float), ("brake_pressure", c_float),
        ("tyre_temperature_left", c_float), ("tyre_temperature_center", c_float),
        ("tyre_temperature_right", c_float),
        ("tyre_compound_front", c_char * 33), ("tyre_compound_rear", c_char * 33),
        ("tyre_normalized_pressure", c_float), ("tyre_normalized_temperature_left", c_float),
        ("tyre_normalized_temperature_center", c_float), ("tyre_normalized_temperature_right", c_float),
        ("brake_normalized_temperature", c_float), ("tyre_normalized_temperature_core", c_float),
        ("_reserved", c_uint8 * 128),
    ]


class EvoDamage(Structure):
    """SMEvoDamageState (128 B): 0 = heil, 1 = zerstört (laut live-telemetry-evo, ungeprüft)."""
    _layout_ = "ms"
    _pack_ = 4
    _fields_ = [(f"damage_{k}", c_float) for k in ("front", "rear", "left", "right", "center")] + \
        [(f"damage_suspension_{k}", c_float) for k in ("lf", "rf", "lr", "rr")] + [("_reserved", c_uint8 * 92)]


class EvoElectronicsS(Structure):
    """SMEvoElectronics (128 B) – Stufen der Fahrhilfen (laut live-telemetry-evo)."""
    _layout_ = "ms"
    _pack_ = 4
    _fields_ = [
        ("tc_level", c_int8), ("tc_cut_level", c_int8), ("abs_level", c_int8), ("esc_level", c_int8),
        ("ebb_level", c_int8), ("brake_bias", c_float), ("engine_map_level", c_int8), ("turbo_level", c_float),
        ("ers_deployment_map", c_int8), ("ers_recharge_map", c_float),
        ("is_ers_heat_charging_on", c_bool), ("is_ers_overtake_mode_on", c_bool), ("is_drs_open", c_bool),
        ("diff_power_level", c_int8), ("diff_coast_level", c_int8),
        ("front_bump_damper_level", c_int8), ("front_rebound_damper_level", c_int8),
        ("rear_bump_damper_level", c_int8), ("rear_rebound_damper_level", c_int8),
        ("is_ignition_on", c_bool), ("is_pitlimiter_on", c_bool), ("active_performance_mode", c_int8),
        ("_reserved", c_uint8 * 88),
    ]
EvoPit = _blob("EvoPit", 64)
EvoInstrumentation = _blob("EvoInstrumentation", 128)
EvoElectronics = EvoElectronicsS
EvoSession = _blob("EvoSession", 256)
EvoTiming = _blob("EvoTiming", 256)
EvoAssists = _blob("EvoAssists", 64)


class EvoGraphics(Structure):
    """SPageFileGraphicEvo laut ACE_SharedFileOut_Documentation_v1 (Stand 2026-04-01)."""
    _layout_ = "ms"
    _pack_ = 4
    _fields_ = [
        ("packetId", c_int32),
        ("status", c_int32),
        ("focused_car_id_a", c_uint64),
        ("focused_car_id_b", c_uint64),
        ("player_car_id_a", c_uint64),
        ("player_car_id_b", c_uint64),
        ("rpm", c_uint16),
        ("is_rpm_limiter_on", c_bool),
        ("is_change_up_rpm", c_bool),
        ("is_change_down_rpm", c_bool),
        ("tc_active", c_bool),
        ("abs_active", c_bool),
        ("esc_active", c_bool),
        ("launch_active", c_bool),
        ("is_ignition_on", c_bool),
        ("is_engine_running", c_bool),
        ("kers_is_charging", c_bool),
        ("is_wrong_way", c_bool),
        ("is_drs_available", c_bool),
        ("battery_is_charging", c_bool),
        ("is_max_kj_per_lap_reached", c_bool),
        ("is_max_charge_kj_per_lap_reached", c_bool),
        ("display_speed_kmh", c_int16),
        ("display_speed_mph", c_int16),
        ("display_speed_ms", c_int16),
        ("pitspeeding_delta", c_float),
        ("gear_int", c_int16),
        ("rpm_percent", c_float),
        ("gas_percent", c_float),
        ("brake_percent", c_float),
        ("handbrake_percent", c_float),
        ("clutch_percent", c_float),
        ("steering_percent", c_float),
        ("ffb_strength", c_float),
        ("car_ffb_multiplier", c_float),
        ("water_temperature_percent", c_float),
        ("water_pressure_bar", c_float),
        ("fuel_pressure_bar", c_float),
        ("water_temperature_c", c_int8),
        ("air_temperature_c", c_int8),
        ("oil_temperature_c", c_float),
        ("oil_pressure_bar", c_float),
        ("exhaust_temperature_c", c_float),
        ("g_forces_x", c_float),
        ("g_forces_y", c_float),
        ("g_forces_z", c_float),
        ("turbo_boost", c_float),
        ("turbo_boost_level", c_float),
        ("turbo_boost_perc", c_float),
        ("steer_degrees", c_int32),
        ("current_km", c_float),
        ("total_km", c_uint32),
        ("total_driving_time_s", c_uint32),
        ("time_of_day_hours", c_int32),
        ("time_of_day_minutes", c_int32),
        ("time_of_day_seconds", c_int32),
        ("delta_time_ms", c_int32),
        ("current_lap_time_ms", c_int32),
        ("predicted_lap_time_ms", c_int32),
        ("fuel_liter_current_quantity", c_float),
        ("fuel_liter_current_quantity_percent", c_float),
        ("fuel_liter_per_km", c_float),
        ("km_per_fuel_liter", c_float),
        ("current_torque", c_float),
        ("current_bhp", c_int32),
        ("tyre_lf", EvoTyre),
        ("tyre_rf", EvoTyre),
        ("tyre_lr", EvoTyre),
        ("tyre_rr", EvoTyre),
        ("npos", c_float),
        ("kers_charge_perc", c_float),
        ("kers_current_perc", c_float),
        ("control_lock_time", c_float),
        ("car_damage", EvoDamage),
        ("car_location", c_int32),
        ("pit_info", EvoPit),
        ("fuel_liter_used", c_float),
        ("fuel_liter_per_lap", c_float),
        ("laps_possible_with_fuel", c_float),
        ("battery_temperature", c_float),
        ("battery_voltage", c_float),
        ("instantaneous_fuel_liter_per_km", c_float),
        ("instantaneous_km_per_fuel_liter", c_float),
        ("gear_rpm_window", c_float),
        ("instrumentation", EvoInstrumentation),
        ("instrumentation_min_limit", EvoInstrumentation),
        ("instrumentation_max_limit", EvoInstrumentation),
        ("electronics", EvoElectronics),
        ("electronics_min_limit", EvoElectronics),
        ("electronics_max_limit", EvoElectronics),
        ("electronics_is_modifiable", EvoElectronics),
        ("total_lap_count", c_int32),
        ("current_pos", c_uint32),
        ("total_drivers", c_uint32),
        ("last_laptime_ms", c_int32),
        ("best_laptime_ms", c_int32),
        ("flag", c_int32),
        ("global_flag", c_int32),
        ("max_gears", c_uint32),
        ("engine_type", c_int32),
        ("has_kers", c_bool),
        ("is_last_lap", c_bool),
        ("performance_mode_name", c_char * 33),
        ("diff_coast_raw_value", c_float),
        ("diff_power_raw_value", c_float),
        ("race_cut_gained_time_ms", c_int32),
        ("distance_to_deadline", c_int32),
        ("race_cut_current_delta", c_float),
        ("session_state", EvoSession),
        ("timing_state", EvoTiming),
        ("player_ping", c_int32),
        ("player_latency", c_int32),
        ("player_cpu_usage", c_int32),
        ("player_cpu_usage_avg", c_int32),
        ("player_qos", c_int32),
        ("player_qos_avg", c_int32),
        ("player_fps", c_int32),
        ("player_fps_avg", c_int32),
        ("driver_name", c_char * 33),
        ("driver_surname", c_char * 33),
        ("car_model", c_char * 33),
        ("is_in_pit_box", c_bool),
        ("is_in_pit_lane", c_bool),
        ("is_valid_lap", c_bool),
        ("car_coordinates", c_float * 180),
        ("gap_ahead", c_float),
        ("gap_behind", c_float),
        ("active_cars", c_uint8),
        ("fuel_per_lap", c_float),
        ("fuel_estimated_laps", c_float),
        ("assists_state", EvoAssists),
        ("max_fuel", c_float),
        ("max_turbo_boost", c_float),
        ("use_single_compound", c_bool),
        ("car_ids", c_uint64 * 120),
    ]


class EvoStatic(Structure):
    _layout_ = "ms"
    _pack_ = 4
    _fields_ = [
        ("sm_version", c_char * 15),
        ("ac_evo_version", c_char * 15),
        ("session", c_int32),
        ("session_name", c_char * 33),
        ("event_id", c_uint8),
        ("session_id", c_uint8),
        ("starting_grip", c_int32),
        ("starting_ambient_temperature_c", c_float),
        ("starting_ground_temperature_c", c_float),
        ("is_static_weather", c_bool),
        ("is_timed_race", c_bool),
        ("is_online", c_bool),
        ("number_of_sessions", c_int32),
        ("nation", c_char * 33),
        ("longitude", c_float),
        ("latitude", c_float),
        ("track", c_char * 33),
        ("track_configuration", c_char * 33),
        ("track_length_m", c_float),
    ]


# AC1 und ACC teilen sich den Anfang von SPageFileGraphic.
_AC_GRAPHICS_HEAD = [
    ("packetId", c_int32),
    ("status", c_int32),
    ("session", c_int32),
    ("currentTime", c_uint16 * 15),
    ("lastTime", c_uint16 * 15),
    ("bestTime", c_uint16 * 15),
    ("split", c_uint16 * 15),
    ("completedLaps", c_int32),
    ("position", c_int32),
    ("iCurrentTime", c_int32),
    ("iLastTime", c_int32),
    ("iBestTime", c_int32),
    ("sessionTimeLeft", c_float),
    ("distanceTraveled", c_float),
    ("isInPit", c_int32),
    ("currentSectorIndex", c_int32),
    ("lastSectorTime", c_int32),
    ("numberOfLaps", c_int32),
    ("tyreCompound", c_uint16 * 33),
    ("replayTimeMultiplier", c_float),
    ("normalizedCarPosition", c_float),
]


class AccGraphics(Structure):
    """SPageFileGraphic laut ACC Shared Memory Documentation V1.8.12 (bis isValidLap)."""
    _layout_ = "ms"
    _pack_ = 4
    _fields_ = _AC_GRAPHICS_HEAD + [
        ("activeCars", c_int32),
        ("carCoordinates", c_float * 180),
        ("carID", c_int32 * 60),
        ("playerCarID", c_int32),
        ("penaltyTime", c_float),
        ("flag", c_int32),
        ("penalty", c_int32),
        ("idealLineOn", c_int32),
        ("isInPitLane", c_int32),
        ("surfaceGrip", c_float),
        ("mandatoryPitDone", c_int32),
        ("windSpeed", c_float),
        ("windDirection", c_float),
        ("isSetupMenuVisible", c_int32),
        ("mainDisplayIndex", c_int32),
        ("secondaryDisplayIndex", c_int32),
        ("TC", c_int32),
        ("TCCut", c_int32),
        ("EngineMap", c_int32),
        ("ABS", c_int32),
        ("fuelXLap", c_float),
        ("rainLights", c_int32),
        ("flashingLights", c_int32),
        ("lightsStage", c_int32),
        ("exhaustTemperature", c_float),
        ("wiperLV", c_int32),
        ("driverStintTotalTimeLeft", c_int32),
        ("driverStintTimeLeft", c_int32),
        ("rainTyres", c_int32),
        ("sessionIndex", c_int32),
        ("usedFuel", c_float),
        ("deltaLapTime", c_uint16 * 15),
        ("iDeltaLapTime", c_int32),
        ("estimatedLapTime", c_uint16 * 15),
        ("iEstimatedLapTime", c_int32),
        ("isDeltaPositive", c_int32),
        ("iSplit", c_int32),
        ("isValidLap", c_int32),
    ]


class Ac1Graphics(Structure):
    """SPageFileGraphic von Assetto Corsa (1) bis isInPitLane. AC1 meldet keine Gültigkeit."""
    _layout_ = "ms"
    _pack_ = 4
    _fields_ = _AC_GRAPHICS_HEAD + [
        ("carCoordinates", c_float * 3),
        ("penaltyTime", c_float),
        ("flag", c_int32),
        ("idealLineOn", c_int32),
        ("isInPitLane", c_int32),
    ]


class AcStatic(Structure):
    """SPageFileStatic von AC1/ACC (bis isOnline)."""
    _layout_ = "ms"
    _pack_ = 4
    _fields_ = [
        ("smVersion", c_uint16 * 15),
        ("acVersion", c_uint16 * 15),
        ("numberOfSessions", c_int32),
        ("numCars", c_int32),
        ("carModel", c_uint16 * 33),
        ("track", c_uint16 * 33),
        ("playerName", c_uint16 * 33),
        ("playerSurname", c_uint16 * 33),
        ("playerNick", c_uint16 * 33),
        ("sectorCount", c_int32),
        ("maxTorque", c_float),
        ("maxPower", c_float),
        ("maxRpm", c_int32),
        ("maxFuel", c_float),
        ("suspensionMaxTravel", c_float * 4),
        ("tyreRadius", c_float * 4),
        ("maxTurboBoost", c_float),
        ("deprecated_1", c_float),
        ("deprecated_2", c_float),
        ("penaltiesEnabled", c_int32),
        ("aidFuelRate", c_float),
        ("aidTireRate", c_float),
        ("aidMechanicalDamage", c_float),
        ("aidAllowTyreBlankets", c_int32),
        ("aidStability", c_float),
        ("aidAutoClutch", c_int32),
        ("aidAutoBlip", c_int32),
        ("hasDRS", c_int32),
        ("hasERS", c_int32),
        ("hasKERS", c_int32),
        ("kersMaxJ", c_float),
        ("engineBrakeSettingsCount", c_int32),
        ("ersPowerControllerCount", c_int32),
        ("trackSPlineLength", c_float),
        ("trackConfiguration", c_uint16 * 33),
        ("ersMaxJ", c_float),
        ("isTimedRace", c_int32),
        ("hasExtraLap", c_int32),
        ("carSkin", c_uint16 * 33),
        ("reversedGridPositions", c_int32),
        ("pitWindowStart", c_int32),
        ("pitWindowEnd", c_int32),
        ("isOnline", c_int32),
    ]


STATUS_OFF, STATUS_REPLAY, STATUS_LIVE, STATUS_PAUSE = 0, 1, 2, 3

EVO_SESSIONS = {0: "time_attack", 1: "race", 2: "hot_stint", 3: "cruise"}
ACC_SESSIONS = {0: "practice", 1: "qualify", 2: "race", 3: "hotlap", 4: "hot_stint", 5: "superpole"}
AC1_SESSIONS = {0: "practice", 1: "qualify", 2: "race", 3: "hotlap", 4: "time_attack", 5: "drift", 6: "drag"}


# ---------------------------------------------------------------------------
# Momentaufnahme – spielunabhängig
# ---------------------------------------------------------------------------

@dataclass
class Snapshot:
    game: str
    status: int
    packet_id: int
    lap_count: int
    current_ms: int
    last_ms: int
    best_ms: int
    valid_now: bool | None
    npos: float
    in_pit_lane: bool
    track: str
    layout: str
    car: str
    session_type: str
    driver: str = ""
    online: bool | None = None
    session_id: str = ""          # wechselt bei neuer Session (z. B. Training -> Quali)
    incidents: int | None = None  # nur iRacing
    speed_kmh: float | None = None
    throttle: float | None = None  # 0..1
    brake: float | None = None     # 0..1
    pos_x: float | None = None     # Weltkoordinaten des eigenen Autos (m), für die Streckenkarte
    pos_z: float | None = None
    gear: int | None = None        # -1 = R, 0 = N, 1.. = Gang
    rpm: int | None = None
    rpm_pct: float | None = None   # 0..1 bis Begrenzer (nur AC EVO)
    tele: dict | None = None       # erweiterte Telemetrie nur für den Live-Tab


TRACE_STEP = 0.00125  # Verlauf alle 0,125 % der Runde (800 Punkte, ~5 m auf 4 km)


def build_trace(samples: list[tuple]) -> dict | None:
    """Rohwerte (npos, ms, kmh, gas, bremse[, x, z[, gang, lenkung]]) auf ein festes Raster legen.

    t[i] = Rundenzeit in ms bei Position i*TRACE_STEP. Lücken (z. B. Outlap aus der Box)
    bleiben None. Rückwärts (Dreher) und Werte vom Rundenende davor werden verworfen.
    """
    pts, last_n = [], -1.0
    for smp in samples:
        n, t = smp[0], smp[1]
        if not (0.0 <= n <= 1.0) or (t < 5000 and n > 0.9):
            continue
        if n <= last_n:
            continue
        pts.append(tuple(smp) + (None,) * (9 - len(smp)))
        last_n = n
    if len(pts) < 20 or pts[-1][0] - pts[0][0] < 0.5:
        return None
    keys = ("t", "v", "thr", "brk", "x", "z", "g", "st")
    out = {"step": TRACE_STEP, **{k: [] for k in keys}}
    j = 0
    for i in range(int(round(1 / TRACE_STEP))):
        g = i * TRACE_STEP
        while j < len(pts) - 2 and pts[j + 1][0] < g:
            j += 1
        a, b = pts[j], pts[j + 1]
        if g < a[0] or g > b[0]:
            for k in keys:
                out[k].append(None)
            continue
        f = (g - a[0]) / (b[0] - a[0]) if b[0] > a[0] else 0.0

        def lerp(k, scale=1.0, nd=0):
            if a[k] is None or b[k] is None:
                return None
            val = (a[k] + (b[k] - a[k]) * f) * scale
            return round(val, nd) if nd else int(round(val))
        out["t"].append(lerp(1))
        out["v"].append(lerp(2, 1.0, 1))
        out["thr"].append(lerp(3, 100))
        out["brk"].append(lerp(4, 100))
        out["x"].append(lerp(5, 1.0, 1))
        out["z"].append(lerp(6, 1.0, 1))
        near = a if f < 0.5 else b                       # Gang nicht mitteln
        out["g"].append(near[7] if near[7] is not None else None)
        out["st"].append(lerp(8, 1.0, 2) if a[8] is not None and b[8] is not None else None)
    for k in ("v", "thr", "brk", "x", "z", "g", "st"):
        if all(x is None for x in out[k]):
            out[k] = None
    return out


@dataclass
class Lap:
    game: str
    track: str
    layout: str
    car: str
    session_uid: str
    session_type: str
    lap_number: int | None
    lap_time_ms: int
    valid: bool | None
    estimated: bool
    outlap: bool
    inlap: bool
    online: bool | None
    driver: str
    recorded_at: str
    uid: str = field(default_factory=lambda: uuid.uuid4().hex)
    sectors: list[int] | None = None
    note: str = ""
    trace: dict | None = None

    def as_dict(self) -> dict:
        return dict(self.__dict__)


# ---------------------------------------------------------------------------
# Rundenerkennung
# ---------------------------------------------------------------------------

class LapDetector:
    """Erkennt fertige Runden aus aufeinanderfolgenden Momentaufnahmen.

    Normalfall: Der Rundenzähler steigt -> Zeit aus last_ms.
    Ersatz: Die laufende Zeit springt an der Ziellinie auf ~0, ohne dass der Zähler
    steigt (z. B. Verbindungsabbruch) -> Zeit aus der letzten laufenden Zeit,
    markiert als "geschätzt".
    """

    SETTLE_S = 1.5          # so lange auf last_ms bzw. den Zähler warten
    VALID_GRACE_MS = 1000   # Gültigkeit am Rundenanfang ignorieren (alter Wert hängt nach)
    MIN_LAP_MS = 10_000

    def __init__(self, clock=time.monotonic, wallclock=None, settle_s: float | None = None):
        if settle_s is not None:
            self.SETTLE_S = settle_s
        self.clock = clock
        self.wallclock = wallclock or (lambda: datetime.now(timezone.utc))
        self.prev: Snapshot | None = None
        self.session_key = None
        self.session_uid = ""
        self.pending: dict | None = None
        self._new_lap_state(None)

    def _new_lap_state(self, snap: Snapshot | None) -> None:
        self.lap_invalid = False
        self.lap_valid_known = False
        self.lap_started_in_pit = bool(snap and snap.in_pit_lane)
        self.lap_max_current = 0
        self.lap_start_incidents = snap.incidents if snap else None
        self.samples: list[tuple] = []

    def _key(self, s: Snapshot):
        return (s.game, s.track, s.layout, s.car, s.session_type, s.session_id)

    def _make_lap(self, time_ms: int, estimated: bool, ref: Snapshot, lap_number, ended_in_pit: bool) -> Lap:
        note = ""
        if ref.incidents is not None and self.lap_start_incidents is not None:
            inc = ref.incidents - self.lap_start_incidents
            if inc > 0:
                note = f"+{inc}x Incidents"
                # iRacing wertet Runden mit Incident (Off-Track, Kontakt) nicht für die Bestzeit
                self.lap_invalid = self.lap_valid_known = True
        return Lap(note=note, trace=build_trace(self.samples),
            game=ref.game, track=ref.track, layout=ref.layout, car=ref.car,
            session_uid=self.session_uid, session_type=ref.session_type,
            lap_number=lap_number, lap_time_ms=int(time_ms),
            valid=(not self.lap_invalid) if self.lap_valid_known else None,
            estimated=estimated, outlap=self.lap_started_in_pit, inlap=ended_in_pit,
            online=ref.online, driver=ref.driver,
            recorded_at=self.wallclock().isoformat(timespec="milliseconds"),
        )

    def flush(self) -> list[Lap]:
        """Offene Runde sofort abschließen (Spiel beendet, Mapping weg)."""
        if not self.pending:
            return []
        p, self.pending = self.pending, None
        return [p["lap"]] if p["lap"] else []

    def update(self, s: Snapshot) -> list[Lap]:
        out: list[Lap] = []
        now = self.clock()

        if s.status in (STATUS_PAUSE, STATUS_REPLAY):
            return out
        if s.status != STATUS_LIVE:
            out += self.flush()
            self.prev = None
            return out

        key = self._key(s)
        prev = self.prev
        if key != self.session_key or (prev and s.lap_count < prev.lap_count):
            out += self.flush()
            self.session_key = key
            self.session_uid = uuid.uuid4().hex
            self.prev = s
            self._new_lap_state(s)
            return out
        if prev is None:
            self.prev = s
            self._new_lap_state(s)
            return out

        # Offene Runde abschließen, sobald last_ms da ist oder die Wartezeit um ist.
        if self.pending:
            p = self.pending
            if p["kind"] == "counter":
                if s.last_ms > 0 and s.last_ms != p["prev_last"]:
                    p["lap"].lap_time_ms = s.last_ms
                    out.append(p["lap"])
                    self.pending = None
                elif now >= p["deadline"]:
                    if s.last_ms > 0 and abs(s.last_ms - p["approx"]) < 1500:
                        p["lap"].lap_time_ms = s.last_ms   # gleiche Zeit wie die Runde davor
                    else:
                        p["lap"].estimated = True
                        if s.last_ms <= 0 and s.game == "iracing":
                            p["lap"].valid = False   # iRacing hat die Runde verworfen
                    out.append(p["lap"])
                    self.pending = None
            elif p["kind"] == "cross":
                if s.lap_count > p["count"]:
                    # Zähler kam doch (nur ein paar Frames später): dieselbe Runde mit
                    # ihren Merkmalen, Zeit jetzt aus last_ms.
                    p["lap"].estimated = False
                    p["lap"].lap_number = s.lap_count
                    self.pending = {"kind": "counter", "lap": p["lap"], "prev_last": p["prev_last"],
                                    "approx": p["lap"].lap_time_ms, "deadline": now + self.SETTLE_S}
                    self.prev = s
                    return out
                elif now >= p["deadline"]:
                    out.append(p["lap"])
                    self.pending = None

        # Gültigkeit und laufende Zeit der aktuellen Runde mitschreiben
        if s.lap_count == prev.lap_count:
            if s.valid_now is not None and s.current_ms >= self.VALID_GRACE_MS:
                self.lap_valid_known = True
                if not s.valid_now:
                    self.lap_invalid = True
            self.lap_max_current = max(self.lap_max_current, s.current_ms)
            if s.current_ms > 0:
                self.samples.append((s.npos, s.current_ms, s.speed_kmh, s.throttle, s.brake,
                                     s.pos_x, s.pos_z, s.gear, (s.tele or {}).get("steer")))
            # Boxenausfahrt liegt meist kurz hinter der Linie -> Boxengasse in der
            # ersten Rundenhälfte = Outlap
            if s.in_pit_lane and s.npos < 0.5:
                self.lap_started_in_pit = True

        if s.lap_count > prev.lap_count:
            out += self.flush()
            approx = self.lap_max_current or prev.current_ms
            if approx >= self.MIN_LAP_MS or s.last_ms >= self.MIN_LAP_MS:
                lap = self._make_lap(approx, False, prev, s.lap_count, s.in_pit_lane or prev.in_pit_lane)
                self.pending = {"kind": "counter", "lap": lap, "prev_last": prev.last_ms,
                                "approx": approx, "deadline": now + self.SETTLE_S}
            self._new_lap_state(s)
        elif (prev.current_ms >= self.MIN_LAP_MS and s.current_ms < prev.current_ms - 5000
              and prev.npos > 0.9 and s.npos < 0.1 and not self.pending):
            lap = self._make_lap(self.lap_max_current, True, prev,
                                 prev.lap_count + 1, prev.in_pit_lane)
            self.pending = {"kind": "cross", "lap": lap, "count": prev.lap_count,
                            "prev_last": prev.last_ms, "deadline": now + self.SETTLE_S}
            self._new_lap_state(s)

        self.prev = s
        return out


# ---------------------------------------------------------------------------
# Windows-Zugriff auf benannte Mappings
# ---------------------------------------------------------------------------

class NamedMapping:
    """Nur lesender Zugriff. Öffnet nur, wenn das Spiel das Mapping angelegt hat."""

    FILE_MAP_READ = 0x0004

    def __init__(self, name: str):
        self.name = name
        self.handle = None
        self.view = None
        self.size = 0

    def open(self) -> bool:
        if self.view:
            return True
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.OpenFileMappingW.restype = ctypes.c_void_p
        k32.OpenFileMappingW.argtypes = [ctypes.c_uint32, ctypes.c_bool, ctypes.c_wchar_p]
        k32.MapViewOfFile.restype = ctypes.c_void_p
        k32.MapViewOfFile.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_size_t]
        h = k32.OpenFileMappingW(self.FILE_MAP_READ, False, self.name)
        if not h:
            return False
        v = k32.MapViewOfFile(h, self.FILE_MAP_READ, 0, 0, 0)
        if not v:
            k32.CloseHandle(ctypes.c_void_p(h))
            return False

        class MBI(Structure):
            _fields_ = [("BaseAddress", ctypes.c_void_p), ("AllocationBase", ctypes.c_void_p),
                        ("AllocationProtect", ctypes.c_uint32), ("PartitionId", ctypes.c_uint16),
                        ("RegionSize", ctypes.c_size_t), ("State", ctypes.c_uint32),
                        ("Protect", ctypes.c_uint32), ("Type", ctypes.c_uint32)]
        mbi = MBI()
        k32.VirtualQuery.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
        k32.VirtualQuery(ctypes.c_void_p(v), ctypes.byref(mbi), ctypes.sizeof(mbi))
        self.handle, self.view, self.size = h, v, int(mbi.RegionSize)
        return True

    def read(self, struct_type):
        """Kopie der Struktur; was hinter dem Mapping-Ende läge, bleibt 0."""
        buf = (ctypes.c_ubyte * ctypes.sizeof(struct_type))()
        n = min(self.size, ctypes.sizeof(struct_type))
        ctypes.memmove(buf, self.view, n)
        return struct_type.from_buffer_copy(buf)

    def read_bytes(self, offset: int, n: int) -> bytes:
        if offset < 0 or offset + n > self.size:
            raise ValueError("außerhalb des Mappings")
        return ctypes.string_at(self.view + offset, n)

    def close(self) -> None:
        if not self.view:
            return
        k32 = ctypes.WinDLL("kernel32")
        k32.UnmapViewOfFile.argtypes = [ctypes.c_void_p]
        k32.CloseHandle.argtypes = [ctypes.c_void_p]
        k32.UnmapViewOfFile(ctypes.c_void_p(self.view))
        k32.CloseHandle(ctypes.c_void_p(self.handle))
        self.handle = self.view = None
        self.size = 0


# ---------------------------------------------------------------------------
# Spiele
# ---------------------------------------------------------------------------

def _r(v, nd=1):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return None if v != v or abs(v) > 1e7 else round(v, nd)


def kunos_physics(mapping) -> dict:
    """SPageFilePhysics (AC1, ACC und AC EVO teilen den Anfang bis Byte 600).
    Räder immer in der Reihenfolge VL, VR, HL, HR."""
    import struct
    try:
        if not mapping.open():
            return {}
        size = min(mapping.size, 600)
        raw = mapping.read_bytes(0, size)
    except (OSError, ValueError):
        return {}
    f = lambda off, n=1: list(struct.unpack_from(f"<{n}f", raw, off)) if off + 4 * n <= size else None
    i = lambda off: struct.unpack_from("<i", raw, off)[0] if off + 4 <= size else None
    acc = f(44, 3)
    out = {
        "fuel": _r((f(12) or [None])[0]),
        "steer": _r((f(24) or [None])[0], 3),
        "g": [_r(acc[0], 2), _r(acc[2], 2)] if acc else None,          # quer, längs (G)
        "tp": [_r(v, 1) for v in f(88, 4)] if f(88, 4) else None,       # Reifendruck psi
        "tc": [_r(v, 0) for v in f(152, 4)] if f(152, 4) else None,     # Kerntemperatur °C
        "slip": [_r(v, 2) for v in f(56, 4)] if f(56, 4) else None,
        "tc_act": _r((f(204) or [0])[0], 2),
        "abs_act": _r((f(252) or [0])[0], 2),
        "bt": [_r(v, 0) for v in f(348, 4)] if f(348, 4) else None,     # Bremstemperatur °C
        "ti": [_r(v, 0) for v in f(368, 4)] if f(368, 4) else None,
        "tm": [_r(v, 0) for v in f(384, 4)] if f(384, 4) else None,
        "to": [_r(v, 0) for v in f(400, 4)] if f(400, 4) else None,
        "bb": _r((f(564) or [None])[0], 3),
        "max_rpm": i(588),
    }
    # Unplausible/leere Werte weglassen (z. B. Felder, die ein Spiel nicht füllt)
    for k in ("tp", "tc", "bt", "ti", "tm", "to"):
        if out[k] and not any(v for v in out[k] if v is not None):
            out[k] = None
    if out["bb"] is not None and not (0.2 < out["bb"] < 0.9):
        out["bb"] = None
    if out["max_rpm"] is not None and not (1000 < out["max_rpm"] < 25000):
        out["max_rpm"] = None
    return out


def clamp01(v) -> float | None:
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    if v != v:
        return None
    if v > 1.5:          # manche Felder kommen als 0..100
        v /= 100
    return max(0.0, min(1.0, v))


def coords(arr, idx: int) -> dict:
    """x/z (Draufsicht, y ist oben) aus einem flachen [x, y, z]*n-Feld; 0/0 = keine Daten."""
    try:
        x, z = float(arr[3 * idx]), float(arr[3 * idx + 2])
    except (IndexError, TypeError, ValueError):
        return {"pos_x": None, "pos_z": None}
    if (x == 0.0 and z == 0.0) or x != x or z != z or abs(x) > 1e6 or abs(z) > 1e6:
        return {"pos_x": None, "pos_z": None}
    return {"pos_x": x, "pos_z": z}


class GameSource:
    game = ""
    settle_s: float | None = None
    graphics_name = ""
    static_name = ""

    def __init__(self):
        self.g = NamedMapping(self.graphics_name)
        self.st = NamedMapping(self.static_name)
        self.static = None
        self._static_at = 0.0

    def available(self) -> bool:
        return self.g.open() and self.st.open()

    def close(self) -> None:
        self.g.close()
        self.st.close()
        self.static = None

    def refresh_static(self) -> None:
        # Static wird manchmal erst nach dem Laden geschrieben -> alle 2 s neu lesen.
        if self.static is None or time.monotonic() - self._static_at > 2:
            self.static = self.st.read(self.static_type)
            self._static_at = time.monotonic()


class AcEvoSource(GameSource):
    game = "acevo"
    graphics_name = "Local\\acevo_pmf_graphics"
    static_name = "Local\\acevo_pmf_static"
    static_type = EvoStatic

    def __init__(self):
        super().__init__()
        self.ph = NamedMapping("Local\\acevo_pmf_physics")

    def snapshot(self) -> Snapshot:
        self.refresh_static()
        g, st = self.g.read(EvoGraphics), self.static
        driver = f"{cstr(g.driver_name)} {cstr(g.driver_surname)}".strip()
        return Snapshot(
            game=self.game, status=g.status, packet_id=g.packetId,
            lap_count=g.total_lap_count, current_ms=g.current_lap_time_ms,
            last_ms=g.last_laptime_ms, best_ms=g.best_laptime_ms,
            valid_now=bool(g.is_valid_lap), npos=g.npos, in_pit_lane=bool(g.is_in_pit_lane),
            track=cstr(st.track) or "unbekannt", layout=cstr(st.track_configuration),
            car=cstr(g.car_model) or "unbekannt",
            session_type=EVO_SESSIONS.get(st.session, str(st.session)),
            driver=driver, online=bool(st.is_online),
            session_id=f"{st.event_id}:{st.session_id}",
            speed_kmh=float(g.display_speed_kmh), throttle=g.gas_percent, brake=g.brake_percent,
            **coords(g.car_coordinates, self.player_index(g)),
            gear=self.gear(), rpm=int(g.rpm), rpm_pct=clamp01(g.rpm_percent),
            tele=self.tele(g),
        )

    def tele(self, g) -> dict:
        t = kunos_physics(self.ph)
        tyres = (g.tyre_lf, g.tyre_rf, g.tyre_lr, g.tyre_rr)
        el, dm = g.electronics, g.car_damage
        # Reifen aus dem Grafik-Block: links/mitte/rechts; bei linken Rädern ist links = außen
        t.update(
            tp=[_r(ty.tyre_pressure) for ty in tyres],
            tc=[_r(ty.tyre_temperature_c, 0) for ty in tyres],
            bt=[_r(ty.brake_temperature_c, 0) for ty in tyres],
            ti=[_r(ty.tyre_temperature_right if k in (0, 2) else ty.tyre_temperature_left, 0) for k, ty in enumerate(tyres)],
            tm=[_r(ty.tyre_temperature_center, 0) for ty in tyres],
            to=[_r(ty.tyre_temperature_left if k in (0, 2) else ty.tyre_temperature_right, 0) for k, ty in enumerate(tyres)],
            tn=[_r(ty.tyre_normalized_temperature_core, 2) for ty in tyres],
            pn=[_r(ty.tyre_normalized_pressure, 2) for ty in tyres],
            bn=[_r(ty.brake_normalized_temperature, 2) for ty in tyres],
            lock=[bool(ty.lock) for ty in tyres],
            compound=cstr(g.tyre_lf.tyre_compound_front) or None,
            g=[_r(g.g_forces_x, 2), _r(g.g_forces_z, 2)] if (g.g_forces_x or g.g_forces_z) else t.get("g"),
            steer=_r(g.steering_percent, 3), steer_deg=int(g.steer_degrees),
            tc_on=bool(g.tc_active), abs_on=bool(g.abs_active),
            tc_lvl=int(el.tc_level), tc_cut=int(el.tc_cut_level), abs_lvl=int(el.abs_level),
            map=int(el.engine_map_level), pit_lim=bool(el.is_pitlimiter_on),
            water=_r(g.water_temperature_c, 0), oil=_r(g.oil_temperature_c, 0), oil_p=_r(g.oil_pressure_bar, 2),
            boost=_r(g.turbo_boost, 2), bhp=int(g.current_bhp), torque=_r(g.current_torque, 0),
            fuel=_r(g.fuel_liter_current_quantity), fuel_lap=_r(g.fuel_liter_per_lap, 2),
            fuel_laps=_r(g.laps_possible_with_fuel), game_delta=int(g.delta_time_ms),
            predicted=int(g.predicted_lap_time_ms),
            dmg=[_r(getattr(dm, f"damage_{k}"), 2) for k in ("front", "rear", "left", "right", "center")],
        )
        for k in ("tp", "tc", "bt", "ti", "tm", "to", "tn", "pn", "bn"):
            if t.get(k) and not any(v for v in t[k] if v):
                t[k] = None                      # Menü/Box: Spiel liefert nur Nullen
        return t

    def gear(self) -> int | None:
        """Gang aus dem Physik-Block (@16, int32: 0 = R, 1 = N, 2 = 1. Gang – wie AC/ACC,
        so auch live-telemetry-evo). gear_int im Grafik-Block ist undokumentiert."""
        import struct
        try:
            if not self.ph.open():
                return None
            (g,) = struct.unpack_from("<i", self.ph.read_bytes(16, 4), 0)
        except (OSError, ValueError):
            return None
        return g - 1 if -1 <= g <= 12 else None

    def close(self) -> None:
        super().close()
        self.ph.close()

    def player_index(self, g) -> int:
        """Platz des eigenen Autos in car_coordinates: car_ids enthält je Auto (id_a, id_b)."""
        pa, pb = g.player_car_id_a, g.player_car_id_b
        for i in range(60):
            if g.car_ids[2 * i] == pa and g.car_ids[2 * i + 1] == pb:
                return i
        for i in range(120):                     # Ersatz: nur eine ID je Auto
            if pa and g.car_ids[i] == pa:
                return i
        return 0

    def info(self) -> dict:
        self.refresh_static()
        return {"sm_version": cstr(self.static.sm_version), "game_version": cstr(self.static.ac_evo_version)}


class AcFamilySource(GameSource):
    """AC1, ACC und AC Rally nutzen dieselben Mapping-Namen; unterschieden wird über den Prozess.

    AC Rally hat laut live-telemetry-evo dasselbe Layout wie ACC. Wie es Etappenzeiten
    meldet, ist noch nicht geprüft -> experimentell, Gültigkeit unbekannt.
    """
    graphics_name = "Local\\acpmf_graphics"
    static_name = "Local\\acpmf_static"
    static_type = AcStatic

    def __init__(self, processes: dict[str, str]):
        super().__init__()
        self.ph = NamedMapping("Local\\acpmf_physics")
        self.processes = processes
        self.game = ""
        self._proc_at = 0.0

    def detect_game(self) -> str:
        if not self.game or time.monotonic() - self._proc_at > 10:
            self._proc_at = time.monotonic()
            running = running_processes()
            found = next((g for exe, g in self.processes.items() if exe in running), "")
            if not found and any("rally" in p for p in running):
                found = "acrally"
            if not found and self.static is not None:
                # Ersatz: ACC meldet Shared-Memory-Version 1.8+, AC1 1.7
                found = "acc" if wstr(self.static.smVersion) >= "1.8" else "ac"
            self.game = found or self.game or "acc"
        return self.game

    def snapshot(self) -> Snapshot:
        self.refresh_static()
        game = self.detect_game()
        st = self.static
        if game in ("acc", "acrally"):
            g = self.g.read(AccGraphics)
            idx = next((i for i in range(min(max(g.activeCars, 1), 60)) if g.carID[i] == g.playerCarID), 0)
            pos = coords(g.carCoordinates, idx)
            valid = bool(g.isValidLap) if game == "acc" else None
            pit, session_id = bool(g.isInPitLane), str(g.sessionIndex)
            sessions = ACC_SESSIONS
        else:
            g = self.g.read(Ac1Graphics)
            pos = coords(g.carCoordinates, 0)
            valid, pit, session_id = None, bool(g.isInPitLane), ""
            sessions = AC1_SESSIONS
        driver = f"{wstr(st.playerName)} {wstr(st.playerSurname)}".strip()
        kmh, gas, brk, gear, rpm = self.pedals()
        return Snapshot(
            game=game, status=g.status, packet_id=g.packetId,
            lap_count=g.completedLaps, current_ms=g.iCurrentTime,
            last_ms=g.iLastTime, best_ms=g.iBestTime, valid_now=valid,
            npos=g.normalizedCarPosition, in_pit_lane=pit,
            track=wstr(st.track) or "unbekannt",
            layout=wstr(st.trackConfiguration) if game == "ac" else "",
            car=wstr(st.carModel) or "unbekannt",
            session_type=sessions.get(g.session, str(g.session)),
            driver=driver, online=bool(st.isOnline) if game == "acc" else None,
            session_id=session_id,
            speed_kmh=kmh, throttle=gas, brake=brk, **pos, gear=gear, rpm=rpm,
            tele=self.tele(g, game),
        )

    def tele(self, g, game: str) -> dict:
        t = kunos_physics(self.ph)
        if game in ("acc", "acrally"):
            t.update(tc_lvl=int(g.TC), tc_cut=int(g.TCCut), abs_lvl=int(g.ABS), map=int(g.EngineMap),
                     fuel_lap=_r(g.fuelXLap, 2))
            if t.get("fuel") and t.get("fuel_lap"):
                t["fuel_laps"] = _r(t["fuel"] / t["fuel_lap"])
        t["tc_on"] = bool(t.get("tc_act"))
        t["abs_on"] = bool(t.get("abs_act"))
        return t

    def info(self) -> dict:
        self.refresh_static()
        return {"sm_version": wstr(self.static.smVersion), "game_version": wstr(self.static.acVersion)}

    def close(self) -> None:
        super().close()
        self.ph.close()

    def pedals(self) -> tuple:
        """SPageFilePhysics: gas @4, brake @8, gear @16 (0 = R, 1 = N), rpms @20, speedKmh @28
        (AC1, ACC, AC Rally gleich)."""
        import struct
        try:
            if not self.ph.open():
                return None, None, None, None, None
            raw = self.ph.read_bytes(0, 32)
        except (OSError, ValueError):
            return None, None, None, None, None
        gas, brake = struct.unpack_from("<ff", raw, 4)
        gear, rpm = struct.unpack_from("<ii", raw, 16)
        (kmh,) = struct.unpack_from("<f", raw, 28)
        return kmh, gas, brake, gear - 1, rpm


# --- iRacing -----------------------------------------------------------------

class IrHeader(Structure):
    _layout_ = "ms"
    _fields_ = [
        ("ver", c_int32), ("status", c_int32), ("tickRate", c_int32),
        ("sessionInfoUpdate", c_int32), ("sessionInfoLen", c_int32), ("sessionInfoOffset", c_int32),
        ("numVars", c_int32), ("varHeaderOffset", c_int32), ("numBuf", c_int32), ("bufLen", c_int32),
        ("pad1", c_int32 * 2),
        ("varBuf", (c_int32 * 4) * 4),   # je Puffer: tickCount, bufOffset, pad[2]
    ]


class IrVarHeader(Structure):
    _layout_ = "ms"
    _fields_ = [
        ("type", c_int32), ("offset", c_int32), ("count", c_int32),
        ("countAsTime", c_bool), ("pad", c_char * 3),
        ("name", c_char * 32), ("desc", c_char * 64), ("unit", c_char * 32),
    ]


IR_TYPES = {0: ("c", 1), 1: ("?", 1), 2: ("i", 4), 3: ("I", 4), 4: ("f", 4), 5: ("d", 8)}
IR_SESSIONS = {"practice": "practice", "open practice": "practice", "lone qualify": "qualify",
               "open qualify": "qualify", "qualify": "qualify", "race": "race",
               "time trial": "time_trial", "offline testing": "testing", "warmup": "warmup"}
IR_TRACK_OFF = 0       # irsdk_TrkLoc: -1 nicht in der Welt, 0 neben der Strecke, 1 Box, 2 Boxeneinfahrt, 3 Strecke


def ir_session_info(text: str) -> dict:
    """Die paar Felder aus dem Session-YAML, die wir brauchen (ohne YAML-Bibliothek)."""
    import re

    def one(pat, src=text):
        m = re.search(pat, src, re.M)
        return m.group(1).strip() if m else ""

    info = {
        "track": one(r"^ TrackDisplayName: (.*)$") or one(r"^ TrackName: (.*)$"),
        "layout": one(r"^ TrackConfigName: (.*)$"),
        "online": one(r"^ SessionID: (\d+)") not in ("", "0"),
        "subsession": one(r"^ SubSessionID: (\d+)"),
        "car_idx": one(r"^ DriverCarIdx: (\d+)"),
        "sessions": {}, "drivers": {},
    }
    drivers = text.split("\n Drivers:\n", 1)[1] if "\n Drivers:\n" in text else ""
    for m in re.finditer(r"^ - CarIdx: (\d+)\n((?:   .*\n?)*)", drivers, re.M):
        info["drivers"][m.group(1)] = {
            "car": one(r"^   CarScreenName: (.*)$", m.group(2)),
            "name": one(r"^   UserName: (.*)$", m.group(2)),
        }
    sess = text.split("\n Sessions:\n", 1)[1] if "\n Sessions:\n" in text else ""
    for m in re.finditer(r"^ - SessionNum: (\d+)\n((?:   .*\n?)*)", sess, re.M):
        info["sessions"][m.group(1)] = one(r"^   SessionType: (.*)$", m.group(2))
    return info


class IRacingSource(GameSource):
    """iRacing-SDK-Speicher. Keine Gültigkeit vom Spiel: ungültig = alle vier Räder neben
    der Strecke (PlayerTrackSurface), Incidents pro Runde stehen in der Notiz."""
    game = "iracing"
    settle_s = 3.0
    VARS = ("SessionNum", "IsOnTrack", "IsReplayPlaying", "LapCompleted", "LapLastLapTime",
            "LapBestLapTime", "LapCurrentLapTime", "LapDistPct", "OnPitRoad",
            "PlayerTrackSurface", "PlayerCarMyIncidentCount", "Speed", "Throttle", "Brake",
            "Gear", "RPM", "LatAccel", "LongAccel", "SteeringWheelAngle", "SteeringWheelAngleMax",
            "FuelLevel", "FuelUsePerHour", "WaterTemp", "OilTemp", "OilPress", "dcBrakeBias",
            "dcTractionControl", "dcABS", "BrakeABSactive", "LFbrakeLinePress")

    def __init__(self):
        self.m = NamedMapping("Local\\IRSDKMemMapFileName")
        self.vars: dict[str, tuple[int, str]] = {}
        self.info_update = -1
        self.sinfo: dict = {}

    def available(self) -> bool:
        if not self.m.open():
            return False
        hdr = IrHeader.from_buffer_copy(self.m.read_bytes(0, ctypes.sizeof(IrHeader)))
        if not hdr.status & 1:          # irsdk_stConnected
            self.close()
            return False
        return True

    def close(self) -> None:
        self.m.close()
        self.vars, self.info_update, self.sinfo = {}, -1, {}

    def _load_vars(self, hdr: IrHeader) -> None:
        size = ctypes.sizeof(IrVarHeader)
        for i in range(hdr.numVars):
            vh = IrVarHeader.from_buffer_copy(self.m.read_bytes(hdr.varHeaderOffset + i * size, size))
            name = cstr(vh.name)
            if name in self.VARS:
                self.vars[name] = (vh.offset, IR_TYPES[vh.type][0])

    def snapshot(self) -> Snapshot:
        import struct
        hdr = IrHeader.from_buffer_copy(self.m.read_bytes(0, ctypes.sizeof(IrHeader)))
        if not self.vars:
            self._load_vars(hdr)
        if hdr.sessionInfoUpdate != self.info_update:
            raw = self.m.read_bytes(hdr.sessionInfoOffset, hdr.sessionInfoLen)
            self.sinfo = ir_session_info(raw.split(b"\x00", 1)[0].decode("cp1252", "ignore"))
            self.info_update = hdr.sessionInfoUpdate
        bufs = [hdr.varBuf[i] for i in range(min(hdr.numBuf, 4))]
        tick, off = max(((b[0], b[1]) for b in bufs), key=lambda x: x[0])
        row = self.m.read_bytes(off, hdr.bufLen)

        def v(name, default=0):
            if name not in self.vars:
                return default
            o, t = self.vars[name]
            return struct.unpack_from("<" + t, row, o)[0]

        connected = bool(hdr.status & 1)
        if not connected:
            status = STATUS_OFF
        elif v("IsReplayPlaying"):
            status = STATUS_REPLAY
        elif not v("IsOnTrack"):
            status = STATUS_PAUSE          # Garage/Menü: Session bleibt erhalten
        else:
            status = STATUS_LIVE
        si = self.sinfo
        me = si.get("drivers", {}).get(si.get("car_idx", ""), {})
        num = str(v("SessionNum"))
        stype = si.get("sessions", {}).get(num, "")
        surface = v("PlayerTrackSurface", -1)
        last = v("LapLastLapTime", -1.0)
        return Snapshot(
            game=self.game, status=status, packet_id=tick,
            lap_count=max(v("LapCompleted"), 0),
            current_ms=int(v("LapCurrentLapTime") * 1000),
            last_ms=int(last * 1000) if last > 0 else -1,
            best_ms=int(v("LapBestLapTime") * 1000),
            valid_now=None if surface < 0 else surface != IR_TRACK_OFF,
            npos=v("LapDistPct"), in_pit_lane=bool(v("OnPitRoad")),
            track=si.get("track") or "unbekannt", layout=si.get("layout", ""),
            car=me.get("car") or "unbekannt",
            session_type=IR_SESSIONS.get(stype.lower(), stype.lower()),
            driver=me.get("name", ""), online=si.get("online"),
            session_id=f"{si.get('subsession', '')}:{num}",
            incidents=v("PlayerCarMyIncidentCount"),
            speed_kmh=v("Speed", 0.0) * 3.6, throttle=v("Throttle", None), brake=v("Brake", None),
            gear=v("Gear", None), rpm=int(v("RPM", 0.0)),
            tele=self.tele(v),
        )

    def tele(self, v) -> dict:
        g0 = 9.80665
        smax = v("SteeringWheelAngleMax", 0.0) or 0.0
        sa = v("SteeringWheelAngle", None)
        t = {
            "g": [_r(-(v("LatAccel", 0.0)) / g0, 2), _r(v("LongAccel", 0.0) / g0, 2)],
            "steer": _r(-sa / (smax / 2), 3) if sa is not None and smax else None,
            "steer_deg": int(round(-sa * 57.2958)) if sa is not None else None,
            "fuel": _r(v("FuelLevel", None)), "water": _r(v("WaterTemp", None), 0),
            "oil": _r(v("OilTemp", None), 0), "oil_p": _r(v("OilPress", None), 2),
            "abs_on": bool(v("BrakeABSactive", False)),
        }
        bb = v("dcBrakeBias", None)
        if bb:
            t["bb"] = _r(bb / 100 if bb > 1 else bb, 3)
        for k, name in (("tc_lvl", "dcTractionControl"), ("abs_lvl", "dcABS")):
            if name in self.vars:
                t[k] = _r(v(name), 0)
        return t

    def info(self) -> dict:
        return {"vars": len(self.vars)}


def running_processes() -> set[str]:
    try:
        out = subprocess.run(["tasklist", "/FO", "CSV", "/NH"], capture_output=True, text=True,
                             timeout=10, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
    except (OSError, subprocess.SubprocessError):
        return set()
    return {row[0].lower() for row in csv.reader(out.splitlines()) if row}


# ---------------------------------------------------------------------------
# Speichern und Senden
# ---------------------------------------------------------------------------

CSV_FIELDS = ["recorded_at", "game", "track", "layout", "car", "session_type", "lap_number",
              "lap_time", "lap_time_ms", "valid", "estimated", "outlap", "inlap", "online",
              "driver", "session_uid", "uid"]


def fmt_ms(ms: int) -> str:
    return f"{ms // 60000}:{ms % 60000 // 1000:02d}.{ms % 1000:03d}"


class Store:
    """laps.csv = vollständiges lokales Protokoll, queue.jsonl = noch nicht gesendet."""

    def __init__(self, folder: Path):
        self.folder = folder
        folder.mkdir(parents=True, exist_ok=True)
        self.csv_path = folder / "laps.csv"
        self.queue_path = folder / "queue.jsonl"
        self.lock = threading.Lock()

    def add(self, lap: Lap) -> None:
        d = lap.as_dict()
        with self.lock:
            new = not self.csv_path.exists()
            with self.csv_path.open("a", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction="ignore")
                if new:
                    w.writeheader()
                w.writerow({**d, "lap_time": fmt_ms(lap.lap_time_ms)})
            with self.queue_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(d) + "\n")

    def pending(self) -> list[dict]:
        with self.lock:
            if not self.queue_path.exists():
                return []
            lines = self.queue_path.read_text(encoding="utf-8").splitlines()
        out = []
        for line in lines:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                log.warning("Kaputte Zeile in der Warteschlange übersprungen")
        return out

    def remove(self, uids: set[str]) -> None:
        with self.lock:
            if not self.queue_path.exists():
                return
            keep = [ln for ln in self.queue_path.read_text(encoding="utf-8").splitlines()
                    if ln.strip() and json.loads(ln).get("uid") not in uids]
            tmp = self.queue_path.with_suffix(".tmp")
            tmp.write_text("".join(k + "\n" for k in keep), encoding="utf-8")
            os.replace(tmp, self.queue_path)


class Sender(threading.Thread):
    def __init__(self, store: Store, server: str, token: str):
        super().__init__(daemon=True)
        self.store, self.server, self.token = store, server.rstrip("/"), token
        self.wake = threading.Event()
        self.online = None

    def run(self) -> None:
        while True:
            self.wake.wait(10)
            self.wake.clear()
            self.send_now()

    def send_now(self) -> None:
        laps = self.store.pending()
        if not laps:
            return
        req = urllib.request.Request(
            self.server + "/api/laps", data=json.dumps(laps).encode(), method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.token}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                json.loads(r.read())
            self.store.remove({lap["uid"] for lap in laps})
            if self.online is not True:
                log.info("Server erreichbar, %d Runde(n) übertragen", len(laps))
            self.online = True
        except urllib.error.HTTPError as e:
            log.error("Server lehnt ab (%s): %s", e.code, e.read()[:200].decode("utf-8", "ignore"))
            self.online = False
        except (urllib.error.URLError, OSError) as e:
            if self.online is not False:
                log.warning("Server nicht erreichbar (%s) – Runden bleiben lokal und werden nachgeschickt", e)
            self.online = False


class LiveSender(threading.Thread):
    """Schickt den aktuellen Zustand (max. `hz` mal pro Sekunde) an /api/live.

    Nur der jeweils neueste Stand zählt: Ist der Server langsam, wird nichts gepuffert.
    """

    def __init__(self, server: str, token: str, hz: float = 10.0):
        super().__init__(daemon=True)
        self.url, self.token = server.rstrip("/") + "/api/live", token
        self.period = 1.0 / max(1.0, min(30.0, hz))
        self.latest: dict | None = None
        self.sent_seq = -1
        self.seq = 0
        self.lock = threading.Lock()
        self.ok = None

    def put(self, data: dict) -> None:
        with self.lock:
            self.seq += 1
            self.latest = dict(data, seq=self.seq)

    def run(self) -> None:
        import http.client
        from urllib.parse import urlsplit
        u = urlsplit(self.url)
        conn = None
        last_idle = 0.0
        while True:
            t0 = time.monotonic()
            with self.lock:
                data = self.latest if self.latest and self.latest["seq"] != self.sent_seq else None
            # Ohne neue Daten nur alle 5 s ein Lebenszeichen
            if data is None and self.latest is not None and t0 - last_idle > 5:
                data = dict(self.latest)
            if data is not None:
                try:
                    if conn is None:
                        conn = http.client.HTTPConnection(u.hostname, u.port or 80, timeout=2)
                    conn.request("POST", u.path, body=json.dumps(data, separators=(",", ":")),
                                 headers={"Content-Type": "application/json",
                                          "Authorization": f"Bearer {self.token}"})
                    r = conn.getresponse()
                    r.read()
                    if r.status >= 400 and self.ok is not False:
                        log.warning("Live-Daten abgelehnt (%s)", r.status)
                        self.ok = False
                    elif r.status < 400:
                        self.ok = True
                    self.sent_seq, last_idle = data["seq"], t0
                except (OSError, http.client.HTTPException):
                    if conn is not None:
                        conn.close()
                    conn = None
                    self.ok = False
                    time.sleep(2)
                    continue
            time.sleep(max(0.0, self.period - (time.monotonic() - t0)))


def live_payload(snap: Snapshot | None, det: "LapDetector", status: str) -> dict:
    if snap is None:
        return {"state": status, "version": VERSION}
    d = {k: getattr(snap, k) for k in (
        "game", "status", "lap_count", "current_ms", "last_ms", "best_ms", "valid_now", "npos",
        "in_pit_lane", "track", "layout", "car", "session_type", "driver", "online", "speed_kmh",
        "throttle", "brake", "pos_x", "pos_z", "gear", "rpm", "rpm_pct", "incidents", "tele")}
    d.update(state=status, version=VERSION, session_uid=det.session_uid,
             lap_invalid=det.lap_invalid, lap_outlap=det.lap_started_in_pit,
             paused=snap.status in (STATUS_PAUSE, STATUS_REPLAY))
    for k in ("npos", "speed_kmh", "throttle", "brake", "pos_x", "pos_z", "rpm_pct"):
        if isinstance(d[k], float):
            d[k] = round(d[k], 4 if k == "npos" else 2)
    return d


# ---------------------------------------------------------------------------
# Hauptprogramm
# ---------------------------------------------------------------------------

DEFAULT_PROCESSES = {
    "ac2-win64-shipping.exe": "acc",
    "acs.exe": "ac",
    "acs_x86.exe": "ac",
}


def data_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home())
    return Path(base) / "SimDash"


def load_config(path: Path) -> configparser.ConfigParser:
    cfg = configparser.ConfigParser()
    if not path.exists():
        cfg["server"] = {"url": "http://SERVER-IP:8080", "token": "HIER_TOKEN_EINTRAGEN"}
        cfg["processes"] = DEFAULT_PROCESSES
        with path.open("w", encoding="utf-8") as f:
            cfg.write(f)
        print(f"Konfiguration angelegt: {path}\nBitte den Token eintragen und neu starten.")
        sys.exit(1)
    cfg.read(path, encoding="utf-8")
    return cfg


def selftest() -> None:
    for st in (EvoGraphics, EvoStatic, AccGraphics, Ac1Graphics, AcStatic):
        print(f"{st.__name__:12s} {ctypes.sizeof(st):6d} Byte")
    for name in ("current_lap_time_ms", "total_lap_count", "last_laptime_ms", "car_model",
                 "is_valid_lap", "car_ids"):
        print(f"  EvoGraphics.{name:22s} @ {getattr(EvoGraphics, name).offset}")
    for name in ("track", "track_configuration", "track_length_m"):
        print(f"  EvoStatic.{name:24s} @ {getattr(EvoStatic, name).offset}")
    for name in ("completedLaps", "iLastTime", "normalizedCarPosition", "isInPitLane", "isValidLap"):
        print(f"  AccGraphics.{name:22s} @ {getattr(AccGraphics, name).offset}")
    for name in ("carModel", "track", "trackConfiguration", "isOnline"):
        print(f"  AcStatic.{name:25s} @ {getattr(AcStatic, name).offset}")


def main() -> None:
    ap = argparse.ArgumentParser(description="SimDash-Collector")
    ap.add_argument("--config", type=Path, default=Path(__file__).with_name("simdash.ini"))
    ap.add_argument("--dump", action="store_true", help="Live-Werte einmal pro Sekunde anzeigen")
    ap.add_argument("--selftest", action="store_true", help="Strukturgrößen und Offsets anzeigen")
    args = ap.parse_args()

    if args.selftest:
        selftest()
        return
    if os.name != "nt":
        sys.exit("Der Collector läuft nur unter Windows (Shared Memory der Spiele).")

    folder = data_dir()
    folder.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S",
                        handlers=[logging.StreamHandler(),
                                  logging.FileHandler(folder / "collector.log", encoding="utf-8")])
    cfg = load_config(args.config)
    processes = {k.lower(): v for k, v in (cfg["processes"].items() if cfg.has_section("processes") else DEFAULT_PROCESSES.items())}
    store = Store(folder)
    sender = Sender(store, cfg["server"]["url"], cfg["server"]["token"])
    sender.start()
    sender.wake.set()
    live = None
    if cfg.getboolean("live", "enabled", fallback=True):
        live = LiveSender(cfg["server"]["url"], cfg["server"]["token"], cfg.getfloat("live", "hz", fallback=10))
        live.start()

    sources = [AcEvoSource(), IRacingSource(), AcFamilySource(processes)]
    detector = LapDetector()
    active: GameSource | None = None
    last_packet, last_packet_change = None, time.monotonic()
    announced = None      # zuletzt gemeldetes Spiel – nur Wechsel ins Log
    idle_logged = False   # "keine neuen Daten" nur einmal melden (EVO-Menü schreibt nichts)
    last_dump = 0.0
    log.info("SimDash-Collector %s gestartet. Daten: %s", VERSION, folder)

    def finish(laps: list[Lap]) -> None:
        for lap in laps:
            store.add(lap)
            flags = [x for x, on in (("UNGÜLTIG", lap.valid is False), ("geschätzt", lap.estimated),
                                     ("Outlap", lap.outlap), ("Inlap", lap.inlap)) if on]
            log.info("Runde %s  %s  %s | %s %s %s", lap.lap_number, fmt_ms(lap.lap_time_ms),
                     " ".join(flags), lap.game, lap.track + (f"/{lap.layout}" if lap.layout else ""), lap.car)
        if laps:
            sender.wake.set()

    while True:
        try:
            if active is None:
                for src in sources:
                    if src.available():
                        active = src
                        detector = LapDetector(settle_s=getattr(src, "settle_s", None))
                        if announced is not src:
                            log.info("Spiel erkannt: %s %s", type(src).__name__, src.info())
                            announced = src
                        last_packet, last_packet_change = None, time.monotonic()
                        break
                if active is None:
                    announced = None      # kein Spiel mehr da -> nächstes Mal wieder melden
                    if live:
                        live.put(live_payload(None, detector, "no_game"))
                    time.sleep(2)
                    continue

            snap = active.snapshot()
            if snap.packet_id != last_packet:
                if last_packet is not None:
                    idle_logged = False
                last_packet, last_packet_change = snap.packet_id, time.monotonic()
            elif time.monotonic() - last_packet_change > 5 and snap.status != STATUS_PAUSE:
                # Keine neuen Daten: Spiel vermutlich zu. Mapping freigeben, damit es verschwinden kann.
                finish(detector.flush())
                if not idle_logged:
                    log.info("Keine neuen Daten von %s (Menü oder beendet) – warte", snap.game)
                    idle_logged = True
                active.close()
                active = None
                detector = LapDetector()
                if live:
                    live.put(live_payload(None, detector, "no_game"))
                continue

            finish(detector.update(snap))
            if live:
                live.put(live_payload(snap, detector, {STATUS_LIVE: "live", STATUS_PAUSE: "paused",
                                                       STATUS_REPLAY: "paused"}.get(snap.status, "menu")))

            if args.dump and time.monotonic() - last_dump > 1:
                last_dump = time.monotonic()
                print(f"{snap.game} st={snap.status} laps={snap.lap_count} cur={fmt_ms(max(snap.current_ms, 0))} "
                      f"last={fmt_ms(max(snap.last_ms, 0))} best={fmt_ms(max(snap.best_ms, 0))} "
                      f"valid={snap.valid_now} npos={snap.npos:.3f} pit={snap.in_pit_lane} "
                      f"pos={snap.pos_x and round(snap.pos_x, 1)}/{snap.pos_z and round(snap.pos_z, 1)} "
                      f"gear={snap.gear} rpm={snap.rpm} rpm%={snap.rpm_pct} "
                      f"| {snap.track}/{snap.layout} {snap.car} {snap.session_type} online={snap.online}")
            time.sleep(1 / POLL_HZ)
        except KeyboardInterrupt:
            finish(detector.flush())
            break
        except Exception:
            log.exception("Fehler beim Lesen – starte die Erkennung neu")
            if active:
                active.close()
            active = None
            time.sleep(2)


if __name__ == "__main__":
    main()
