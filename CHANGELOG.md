# Changelog

Server/UI and collector have separate version numbers. The collector version is
in `collector/simdash_collector.py` (`VERSION`), the UI version is the `?v=` in
`server/static/index.html`.

## UI 0.12.0 — 2026-11-08
- **Handling & setup** (`/api/handling`, analysis tab): from steering and the
  driven line (curvature from x/z, lateral g = v²·k) a model "steering =
  c1·k + c2·g" is fitted over the best 12 clean laps. Per corner and phase
  (turn-in, apex, exit): clearly more steering than the model → understeer;
  real countersteer (not at direction changes, ≥2 points or ≥8 %) in at least a
  quarter of the laps → oversteer, split by cause (on throttle / on the brakes).
  Findings that repeat across corners come with setup suggestions; each can be
  copied into the setup notes. Can be limited to one session to check a change.
  Needs steering + position (collector ≥ 0.6; AC EVO, ACC, AC – not iRacing).
- **Fuel calculator** (live tab): race length in minutes or laps, lap time,
  consumption, reserve, fuel in tank → fuel needed, laps, how much to add.
  Consumption is measured at every finish line (median of the last 5 laps),
  otherwise taken from the game. Inputs are remembered per track and car.

## UI 0.11.0 — 2026-11-08
- **Auto insights** (`/api/coach/lap`): any lap against a reference lap (default:
  your PB; if the lap is the PB, the previous PB), corner by corner. Each corner
  is split into four phases (braking, turn-in, apex, exit) with the time lost
  or gained in each, plus a sentence on what differs in the worst phase.
- **Racing line comparison** per corner (x/z, zoomed to the corner, scale bar,
  apex marked) and how many metres your line is inside/outside at the apex.
- Live tab: "Coach · last lap" card after every lap. Lap comparison: the same
  report for the chosen pair of laps (also against another driver's lap).
- Coach (analysis tab) also returns the four phases per corner.
- Traces whose clock does not match the lap time are ignored by the coach.

## UI 0.10.0 · Collector 0.6.1 — 2026-11-04
- **Gear and steering** in the lap comparison (charts linked to the other
  charts, values in the tooltip).
- **Coach**: gear per corner, tips for a higher or lower gear, calmer steering
  and too much steering lock. If the PB lap or the model lap has no such data
  yet, the tip compares newer laps and says so.
- **Driver aliases**: a name from a game (e.g. a nickname in AC) can be tied to a
  driver. Without this, such laps were hidden by the default driver filter.
- Fix: two collectors running at once stored every lap twice. The server now
  ignores the same lap arriving under another `uid` (same time and lap number,
  at most 2 s apart). Collector 0.6.1 refuses to start a second instance.

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
