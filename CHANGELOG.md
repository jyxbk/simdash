# Changelog

Server/UI and collector have separate version numbers. The collector version is
in `collector/simdash_collector.py` (`VERSION`), the UI version is the `?v=` in
`server/static/index.html`.

## UI 0.14.0 — 2026-11-08
- **Cockpit** (`/#cockpit`, button "⛶ Cockpit" in the live tab): full-screen
  one-pager for the phone at the rig, landscape and portrait, no scrolling.
  Huge delta to the PB (tinted blue/red by size), prediction, lap time, last
  lap and PB, speed, gear, rpm/throttle/brake bars, 10 sectors vs. PB, fuel
  laps, valid/pit/outlap flags, and after each lap the biggest loss with tip.
- **Screen stays on over plain HTTP**: Wake Lock only works on HTTPS, so the
  cockpit also plays a tiny muted looping video (works on iPhone and Android).
- **Reconnects by itself**: if no data arrives for 6 s, or the page comes back
  from the background, the live stream is rebuilt; connection state is shown.
- Home-screen app: web manifest (start in cockpit, full screen, landscape),
  Apple touch icon; on iPhone "Add to Home Screen" gives real full screen.

## UI 0.13.1 — 2026-11-08
- Verified collector 0.7 on real AC EVO laps (Red Bull Ring): lateral g and yaw
  rate fill 97 % of the trace, lateral g ≈ speed × yaw rate (r = 0.98), so
  byte 296 (`localAngularVel`) is right for AC EVO too.
- Handling: oversteer needs countersteer in at least 2 laps (one lap can be a
  slip). Time cost is shown as "not measurable yet" below 4 laps instead of
  "costs nothing".

## UI 0.13.0 · Collector 0.7.0 — 2026-11-08
- **Corners from the driven line**: corners now come from speed minima *and*
  the curvature of the line (yaw rate / speed, or x/z). Esses and chicanes are
  split at the change of direction, corners without a big speed drop are found
  (Road Atlanta: 11 instead of 6). Flat-out kinks (R > 300 m or < 50 m long)
  are ignored.
- **Same corners everywhere**: one reference lap per track (any car, any
  driver; finest trace with a line) defines the corners for coach, lap report,
  handling and session reports, so "corner 7" always means the same corner.
- **Corner names** (`/api/corners`): name a corner with ✎ (e.g. "T1",
  "Esses"); stored per track by apex position and shown everywhere.
- **Handling**: uses measured lateral g and yaw rate when the trace has them
  (collector 0.7) – then it also works for iRacing. Each finding shows what it
  costs: laps with countersteer vs. laps without, or the half with the most
  extra steering vs. the half with the least. Findings are sorted by cost.
- **Collector 0.7.0**: trace also records lateral g (`ay`) and yaw rate
  (`yaw`, Kunos `localAngularVel` y at byte 296, iRacing `YawRate`).

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
