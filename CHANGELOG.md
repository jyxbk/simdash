# Changelog

Server/UI and collector have separate version numbers. The collector version is
in `collector/simdash_collector.py` (`VERSION`), the UI version is the `?v=` in
`server/static/index.html`.

## UI 0.9.1 — 2026-11-04
- Fix: the live tab stayed empty after the analysis tab was added.
- Documentation (README, docs/).

## UI 0.9.0 · Collector 0.6.0 — 2026-11-04
- **Session report** on the overview: best lap, consistency, change from the
  previous session, ideal lap of the session, biggest time gain, latest note.
- **Setup notes** per track and car (`/api/notes`).
- **Corner history**: corner time and braking point per lap.
- **Progress**: best and median lap per session.
- Collector 0.6: trace with 800 points (≈ 5 m) instead of 200, plus gear and
  steering. The server resamples old and new laps onto one grid.
- `/api/coach?session_uid=` for per-session analysis.

## UI 0.8.0 — 2026-11-04
- **Coach**: automatic corner detection, PB compared with your best own run per
  corner, ideal lap and potential, top 3 corners with tips (braking point, apex
  speed, throttle), entry/exit split, spread per corner, map with corner
  numbers. Endpoint `/api/coach`.
- New **Analyse** tab (car/track picker, coach, lap comparison, lap times). The
  overview only shows summaries. Potential on the best-lap cards.

## UI 0.7 — 2026-11-03
- **Drivers**: assign laps or sessions to other drivers, driver filter
  (default: me), "who is driving" in the live tab.
- Track shape learned from live positions (also for point-to-point drives such
  as Nordschleife Touristenfahrten).
- Compact layout: the live tab fits one 1080p screen, the overview is denser
  with collapsible sessions.
- Fix: overview key figures were missing because of a name clash with the
  live tab.

## UI 0.6 · Collector 0.5 — 2026-11-03
- Extended live telemetry: tyres, brakes, G-forces, assists, steering, engine
  and fuel, last 20 s trace.
- No flicker: ABS/TC/locking are held briefly, value rows stay visible, neutral
  is not shown while shifting.

## UI 0.5 · Collector 0.4 — 2026-11-03
- **Live tab**: state at ≈ 10 Hz over SSE, live delta, prediction, map with
  trail, sectors, inputs.
- Track map in GPS-track style (speed difference, callouts). Track shape per
  track for old laps (`/api/trackmap`).

## UI 0.4 · Collector 0.3 — 2026-11-03
- Track map from world positions (x/z), linked to the charts.

## UI 0.3 · Collector 0.2 — 2026-11-02
- Lap analysis: trace per lap, delta curve, 10 mini sectors, speed comparison,
  ideal lap.
- New overview: PB history, key figures, cards with sparklines, lap time chart.
- iRacing: laps with an incident or without an official time are invalid.

## 0.1 — 2026-11-01
- Server, web UI and Windows collector for AC EVO, iRacing, ACC, AC Rally and
  AC. Offline queue, estimated laps, MIT license.
