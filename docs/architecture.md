# Architecture

```
Gaming PC (Windows, desktop session)                    Server (Linux)
┌───────────────────────────────────────────┐           ┌─────────────────────────────────────┐
│ simdash_collector.py                       │           │ server/app.py (FastAPI, uvicorn)     │
│                                            │           │                                     │
│  GameSource ──Snapshot (50 Hz)──▶ LapDetector          │  POST /api/laps ─▶ SQLite laps,      │
│   AcEvoSource / AcFamilySource /    │      │  laps     │                    lap_traces        │
│   IRacingSource                     ▼      ├──────────▶│  POST /api/live ─▶ LIVE (memory)     │
│                            Store: laps.csv,│           │        │            ─▶ track_shapes   │
│                            queue.jsonl ─▶ Sender       │        ▼                             │
│  live_payload ─▶ LiveSender (≤10 Hz, keep-alive) ──────▶│  GET /api/live/stream (SSE)          │
└───────────────────────────────────────────┘           │  coach.py, /static (HTML/JS/SVG)    │
                                                         └─────────────────────────────────────┘
```

## Collector

One file, [`collector/simdash_collector.py`](../collector/simdash_collector.py),
standard library only (ctypes, threading, urllib, http.client).

### Game sources

Each source opens the game's named shared memory with `OpenFileMappingW` and
reads ctypes structs. It turns them into a common `Snapshot`: status, lap
count, current, last and best time, normalized track position (`npos`),
validity, pit lane, speed, pedals, world position, gear, rpm, plus a `tele`
dict for the live tab.

| Source | Mappings | Notes |
|---|---|---|
| `AcEvoSource` | `Local\acevo_pmf_graphics`, `_static`, `_physics` | EVO graphics struct (4900 B) with tyre, damage and electronics substructures; player index from `car_ids`; gear from the physics block |
| `AcFamilySource` | `Local\acpmf_graphics`, `_static`, `_physics` | ACC, AC (2014) and AC Rally share the names. The game is told apart by the running process (`[processes]` in the ini) |
| `IRacingSource` | `Local\IRSDKMemMapFileName` | iRacing SDK: header, variable headers, triple buffer, session-info YAML (parsed with regexes) |

The Kunos physics block has the same layout in AC, ACC and EVO up to byte 600.
`kunos_physics()` reads gas, brake, fuel, gear, rpm, steering, speed,
acceleration, wheel slip, tyre pressure and temperatures, TC, ABS, brake
temperatures and brake bias from it.

Shared memory exists per Windows logon session (`Local\`). That is why the
collector must run in the interactive desktop session.

### Lap detection (`LapDetector`)

- **Normal case**: the lap counter increases → time from `last_ms`. The detector
  waits up to 1.5 s until the game updates it.
- **Fallback**: the running timer jumps back to ~0 at the line without the
  counter increasing (disconnect, reset) → time from the last running value,
  `estimated = true`.
- **Validity**: taken from the game (EVO, ACC). It is ignored during the first
  second of a lap, because the old value lingers. iRacing: all four wheels off
  track, or any incident, = invalid. The incident count is stored as a note.
- **Out lap / in lap**: pit lane in the first half of the lap / ended in the
  pit lane.
- **One instance**: a named mutex (`Local\\SimDashCollector`, collector ≥ 0.6.1)
  stops a second collector in the same session. `--dump` is exempt.
- **Session**: a new `session_uid` when game, track, car or session type
  changes, or when the lap counter goes backwards.
- **Trace**: while a lap is running, every snapshot adds `(npos, ms, km/h, gas,
  brake, x, z, gear, steer)`. `build_trace()` resamples these onto a fixed grid,
  see [trace format](#trace-format).

### Storage and sending

- `Store` appends every lap to `laps.csv` (for humans) and `queue.jsonl`
  (pending).
- `Sender` thread: POSTs pending laps every 10 s, or right away after a lap.
  Laps that the server accepts (`uid` known) are removed from the queue.
- `LiveSender` thread: sends only the newest snapshot. It uses one keep-alive
  connection, sends at most `hz` times per second, and sends a heartbeat every
  5 s when idle. States: `no_game`, `menu`, `paused`, `live`.

## Trace format

Stored per lap in `lap_traces.data` (JSON):

```json
{
  "step": 0.00125,
  "t":   [0, 41, 83, …],      // lap time in ms at position i·step (null = no data)
  "v":   [201.3, …],          // speed km/h
  "thr": [100, …],            // throttle %
  "brk": [0, …],              // brake %
  "x":   [-312.4, …],         // world position (m); null for iRacing
  "z":   [118.0, …],
  "g":   [4, …],              // gear (-1 R, 0 N)            collector ≥ 0.6
  "st":  [-0.12, …]           // steering −1…1               collector ≥ 0.6
}
```

| Collector | Points | Spacing on 4 km | Fields |
|---|---|---|---|
| 0.2 | 200 | ~20 m | t, v, thr, brk |
| 0.3–0.5 | 200 | ~20 m | + x, z |
| ≥ 0.6 | 800 | ~5 m | + g, st |

`/api/traces` and the coach resample all laps of a combination to the largest
point count (`coach.resample`), so old and new laps can be compared index by
index.

## Server

[`server/app.py`](../server/app.py). It uses one SQLite connection per request
and WAL mode.

### Database

| Table | Content |
|---|---|
| `laps` | One row per lap: `uid` (from the collector, unique → duplicates are ignored), game, track, layout, car, `session_uid`, session type, lap number, `lap_time_ms`, `valid` (1/0/NULL), `estimated`, `outlap`, `inlap`, `online`, sectors, `driver`, `note`, timestamps |
| `lap_traces` | `uid` → trace JSON (kept separate because of its size) |
| `track_shapes` | Track outline learned from live positions: 1000 bins along the lap, coverage. This also works for tracks that are not a closed circuit, e.g. Nordschleife Touristenfahrten |
| `settings` | `me` (your driver name, fixed once), `current_driver`, `current_driver_active`, `driver_aliases` (game name → driver) |
| `setup_notes` | Notes per game, track, layout and car |

### Live

`POST /api/live` keeps the newest payload in memory (max 16 KB) and wakes all
SSE clients. Each payload with a position also updates the in-memory track
shape, which is saved every 15 s. Clients get `data`, `age_s`, `seq`, `driver`
and `me`.

### Track map source (`/api/trackmap`)

The server uses the learned live shape if its coverage is at least as good as
the best lap with positions. Otherwise it uses that lap, which can be any car.
The shape is sampled down to `points`, and small gaps are filled linearly.

### Drivers

- `me` is your own name. It is set from the most frequent driver name once,
  then kept.
- While `current_driver` is set, incoming laps are stored under that name. It
  expires after 3 hours without laps. Otherwise `driver_aliases` maps the name the
  game reports to a driver.
- Every filtered endpoint accepts `driver=`.

## Web UI

Plain HTML, CSS and JavaScript with no build step and no dependencies. Charts
are hand-written SVG.

| File | Content |
|---|---|
| `index.html` | Structure of the three tabs and the driver dialog |
| `app.js` | Helpers (`h`, `s`, `fmt` …), overview, filters, drivers, analysis: lap times chart, lap comparison, track map |
| `coach.js` | Coach: tiles, top corners, map with corner numbers, corner table |
| `progress.js` | Progress chart, corner history, setup notes, session report |
| `live.js` | Tab switching, SSE client, live rendering, wake lock |
| `style.css` | Dark theme, grid layouts for desktop, tablet and phone |

The scripts are classic scripts and share one global scope, so function names
must be unique across files. Asset URLs carry `?v=<version>` to bust caches.
Bump it when the frontend changes.

The colours come from a validated dark data-viz palette: blue `#3987e5` =
gain / series 1, red `#e66767` = loss, orange `#d95926` = series 2, grey
`#484844` = neutral.
