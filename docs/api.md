# HTTP API

Base URL: `http://<server>:8080`. All bodies are JSON. Times are in
milliseconds, timestamps are ISO 8601.

**Auth levels**

| Level | Rule |
|---|---|
| open | anyone who can reach the server |
| token | header `Authorization: Bearer <SIMDASH_TOKEN>` |
| LAN | client IP is private or loopback, **or** the token is sent |

Interactive docs: FastAPI serves them at `/docs` (Swagger) and `/redoc`.

## Laps

| Method & path | Auth | Description |
|---|---|---|
| `POST /api/laps` | token | Add laps (list of lap objects, see below). Laps with a known `uid` are ignored, and so is the same lap under another `uid` (same combination, time and lap number, at most 2 s apart). Returns `{"received", "added"}` |
| `GET /api/laps` | open | Laps, newest first. Filters: `game`, `track`, `layout`, `car`, `driver`, `session_uid`, `limit` (≤ 5000, default 100). Each lap has `has_trace` |
| `GET /api/bests` | open | Per combination: `laps`, `last_driven`, `best_valid` (fastest valid, non-estimated lap), `best_any`. Filters: `game`, `track`, `car`, `driver` |
| `GET /api/traces` | open | Laps of one combination **with** `trace`. Required: `game`, `track`, `car`. Optional: `layout`, `driver`, `limit` (≤ 1000). All traces are resampled to the same point count |
| `GET /api/stats` | open | Key figures: laps, valid laps, tracks, cars, games, sessions, `drive_ms`, `last_lap` |
| `GET /api/filters` | open | Distinct `games`, `tracks`, `cars`, `drivers`, `total` |
| `PATCH /api/laps/{id}` | token | `{"note": "…"}` |
| `DELETE /api/laps/{id}` | token | Delete a lap and its trace |
| `POST /api/laps/driver` | LAN | `{"driver": "Max", "ids": [1, 2]}` or `{"driver": "Max", "session_uid": "…"}` |

Lap object (`POST /api/laps`):

```json
{
  "uid": "8f1c…",                 // unique, 8–64 chars (collector: uuid4 hex)
  "game": "acevo", "track": "Road Atlanta", "layout": "GP", "car": "BMW M4 GT3 Evo",
  "session_uid": "…", "session_type": "time_attack", "lap_number": 7,
  "lap_time_ms": 80466,
  "valid": true,                  // true / false / null = unknown
  "estimated": false, "outlap": false, "inlap": false, "online": true,
  "sectors": [27100, 30020, 23346],
  "driver": "", "note": "",
  "recorded_at": "2026-11-03T22:03:13+00:00",
  "trace": { "step": 0.00125, "t": [], "v": [], "thr": [], "brk": [], "x": [], "z": [], "g": [], "st": [] }
}
```

`game` is one of `acevo`, `acc`, `ac`, `acrally`, `iracing`. Trace arrays hold
at most 1000 values. See [architecture.md](architecture.md#trace-format).

## Coach and maps

| Method & path | Auth | Description |
|---|---|---|
| `GET /api/corners` | open | Corner names of a track: `game`, `track`, `layout` → `[{npos, name}]` |
| `POST /api/corners` | LAN | `{game, track, layout, npos, name}` – set a name (replaces one within 1.2 %), empty name deletes |
| `GET /api/handling` | open | Handling/setup diagnosis. Required: `game`, `track`, `car`. Optional: `layout`, `driver`, `session_uid`. Returns `corners[].phases[]` (`steer_extra`, `countersteer_laps`, `kind`: under/over), `findings[]` (title, corners, setup `hints`) |
| `GET /api/coach/lap` | open | Auto insights: lap `id` against `ref_id` (optional; default PB, or previous PB if `id` is the PB). Per corner: `loss_ms`, `phases` (brake/turnin/apex/exit), `tips`, `line` (x/z of both laps, `apex_offset_m`: + inside, − outside). Also `problems`, `gained`, `phase_totals` |
| `GET /api/coach` | open | Coach analysis. Required: `game`, `track`, `car`. Optional: `layout`, `driver`, `session_uid` (only this session) |
| `GET /api/trackmap` | open | Track outline: `game`, `track`, `layout`, `points` (50–1000, default 200) → `{x, z, step, coverage, source: "live" or "lap"}` |

`/api/coach` response (shortened):

```json
{
  "laps_total": 23, "laps_counting": 12, "laps_used": 12,
  "pb_ms": 80466, "ideal_ms": 79685, "potential_ms": 781,
  "track_length_m": 4045, "step": 0.00125, "least_consistent": 1,
  "consistency": {"laps": 12, "median_ms": 80997, "stdev_ms": 444, "within_05": 6, "within_1": 10},
  "ref": {"id": 74, "lap_number": 13, "lap_time_ms": 80466, "recorded_at": "…"},
  "corners": [{
    "no": 3, "start": 0.175, "apex": 0.21, "end": 0.32,      // fraction of the lap
    "ref_ms": 12487, "best_ms": 12192, "gain_ms": 295, "median_ms": 12530, "spread_ms": 152,
    "best_lap": {"id": 61, "lap_number": 7, "lap_time_ms": 80559},
    "ref_metrics":  {"v_min": 122, "v_entry": 199, "v_exit": 185, "brake_m": 133, "brake_max": 62, "full_throttle_m": 16},
    "best_metrics": {"v_min": 123, "v_entry": 204, "v_exit": 187, "brake_m": 115, "brake_max": 83, "full_throttle_m": 10},
    "phase": {"entry_ms": 186, "exit_ms": 109},
    "tips": [{"kind": "brake_later", "value": 18, "score": 2.25, "text": "Bremse etwa 18 m später"}],
    "history": [{"id": 50, "lap_number": 2, "recorded_at": "…", "session_uid": "…", "ms": 12610, "clean": true, "v_min": 120, "brake_m": 131}]
  }]
}
```

`corners[].gear` is `{"ref", "best"}` or `null` without gear data. Metrics also
contain `gear`, `steer_peak` and `steer_work` when available.

`tips[].kind` is one of `brake_later`, `brake_earlier`, `carry_speed`,
`throttle_earlier`, `better_exit`, `entry_speed`, `brake_later_ok`, `gear_higher`,
`gear_lower`, `steer_calmer`, `less_lock`, `entry`, `exit`. The `text` field is German.

## Live

| Method & path | Auth | Description |
|---|---|---|
| `POST /api/live` | token | Newest collector state (≤ 16 KB). Fields: `state` (`no_game`, `menu`, `paused`, `live`), `version`, game/track/car, `lap_count`, `current_ms`, `last_ms`, `best_ms`, `npos`, `speed_kmh`, `throttle`, `brake`, `pos_x`, `pos_z`, `gear`, `rpm`, `session_uid`, `lap_invalid`, `tele` … |
| `GET /api/live` | open | `{data, age_s, seq, driver, me}` |
| `GET /api/live/stream` | open | Server-Sent Events. One `data:` line with the same object on every update, plus keep-alives |

## Drivers

| Method & path | Auth | Description |
|---|---|---|
| `GET /api/drivers` | open | `{me, current, aliases, drivers: [{name, laps, last}]}` |
| `POST /api/drivers/alias` | LAN | `{"alias": "Nickname", "driver": "Name"}`. Laps with this game name count for that driver, including existing ones. An empty `driver` removes the alias |
| `POST /api/drivers/current` | LAN | `{"driver": "Max"}`. New laps get this name. An empty string or your own name means you |
| `POST /api/drivers/me` | LAN | `{"driver": "Name"}`. Sets your own name |

## Setup notes

| Method & path | Auth | Description |
|---|---|---|
| `GET /api/notes` | open | `game`, `track`, `layout`, `car` → newest first `[{id, text, driver, created, …}]` |
| `POST /api/notes` | LAN | `{game, track, layout, car, text, driver?}` → `{id, created}` |
| `DELETE /api/notes/{id}` | LAN | Delete a note |

## Misc

| Method & path | Auth | Description |
|---|---|---|
| `GET /api/health` | open | `{"ok": true}` |
| `GET /` | open | Web UI. Static files are under `/static/` |
