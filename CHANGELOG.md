# Changelog

Server/UI and collector have separate version numbers. The collector version is
in `collector/simdash_collector.py` (`VERSION`), the UI version is the `?v=` in
`server/static/index.html`.

## UI 0.20.0 — 2026-11-27
- **English UI.** Language switch **DE | EN** at the bottom of the menu; the
  default follows the browser language, `?lang=en` / `?lang=de` sets it.
  Translation happens in the browser (`i18n.js` + dictionary `i18n-en.js`), so
  coach tips, setup diagnosis and server messages are translated too. Numbers
  and dates use the matching locale, voice callouts speak English with an
  English voice, corners are abbreviated T1, T2 … in English.
- Collector package: English `README.txt` next to `LIESMICH.txt`.

## Collector 0.10.2 / server — 2026-11-14
- Race formation lap crossing the line (counter still 0) no longer creates an
  estimated lap.
- `/api/acc_results` matches per session (the one with most equal lap times),
  so a lap time that also occurred in the previous race is no longer skipped.

## Collector 0.10.1 / server — 2026-11-14
- **ACC result-file check:** after an offline session the collector reads ACC's
  own `Results/*.json` (player car = Steam ID) and sends it to the new
  `POST /api/acc_results`. The server matches laps by exact time within the
  session window and fixes validity (flag 1), outlap (4) and inlap (8). ACC
  invalidates some laps only at the line while shared memory still says valid.
- **Reset to pits mid-lap:** the clock jumps to ~0 on track while the lap
  counter stays; the partial lap is now discarded, so the next lap no longer
  inherits its invalid flag and trace.
- **ACC online race start:** the lap clock runs from the grid/formation, so
  lap 1 reported e.g. 7:30. Such laps (time > 1.4 × the extrapolated driven
  time) are marked as outlap with a note.

## UI 0.19.0 — 2026-11-11
- **Driving technique** (brake, steering and throttle together), per corner
  against your fastest run there, following the usual coaching rules: brake
  hard and straight, trail-brake (less brake as steering increases), no
  coasting, pick up throttle once you stop adding lock, full throttle as the
  steering opens, build throttle smoothly, stay flat where possible.
  New metrics: brake build-up, brake at turn-in, trail length, brake with
  high lock, coasting, throttle pick-up, throttle at peak steering, lifts,
  minimum throttle. Downshift blips are removed (opening filter, throttle
  ignored while braking); short lifts are kept.
  New tips: brake_build, trail_more, less_brake_lock, coast_less,
  throttle_pickup, throttle_smooth, less_throttle_lock, lift_brief,
  lift_softer, flat_out.
- Sub tab "Lenkung" became **Fahrtechnik**: four cards (Anbremsen, Einlenken
  & Trail-Braking, Scheitel, Ausgang) with rule and affected corners, corner
  detail with tips and brake/steering/throttle traces of both runs, table.
  Old link `#coach/lenkung` still works.

## UI 0.18.0 — 2026-11-11
- **Steering analysis** per corner (coach): turn-in point (|steer| over 35 %
  of the corner's peak, metres before the apex), unwinding (below 50 % after
  the peak, metres after the apex), peak lock, corrections (direction changes
  over 8 % of the peak, smoothed signal, minus the natural one), countersteer
  (steer against the car's yaw; sign per game from correlation). Compared
  with the fastest run through the corner (or the fastest newer run with
  steering data). New tips: turn in earlier/later, unwind earlier, fewer
  corrections, avoid countersteer. `corner.steer` in `/api/coach`.
- New sub tab **Coach & Setup → Lenkung**: summary of steering patterns,
  per-corner table you vs fastest, steering trace of both runs through the
  selected corner. Ghost coach knows the new hints.

## UI 0.17.0 · Collector 0.10.0 — 2026-11-11
- **Ghost coach** in the cockpit: about 220 m before every corner where your
  best run through that corner was faster (≥ 30 ms), a short hint from the
  coach appears ("+3 km/h im Scheitel", "10 m später bremsen", …).
- **Voice announcements** (browser speech, per device, off by default):
  coach hint before the corner, lap time with gap to the best lap / new best,
  "Runde ungültig", fuel warning at 3 and 1.5 laps. Toggle in the cockpit,
  options under "🔊 Ansagen" in the live view.
- **Le Mans Ultimate** (`lmu`) via the built-in shared memory `LMU_Data`
  (headers in `Support/SharedMemoryInterface`; offsets computed with clang for
  the Windows ABI). Lap times, validity (`mLapInvalidated`), pit lane,
  position, speed, pedals, steering, yaw rate, lateral g, gear/rpm, fuel,
  tyre pressure, carcass and inner/middle/outer temperatures, brake
  temperatures, brake bias, TC/ABS level and activity.

## UI 0.16.0 — 2026-11-11
- **New layout**: collapsible sidebar (icons only when collapsed, drawer on
  phones) with groups Fahren (Übersicht, Live, Cockpit), Auswerten (Sessions,
  Bestzeiten, Coach & Setup, Rundenvergleich), Fahrer (Safety Rating,
  Fortschritt), System (Collector & Spiele). Pages via hash (`#coach/setup`;
  old `#analyse` links still work). Calmer flat design, page titles,
  breadcrumbs. Cockpit stays full screen without menu.
- **New logo** "Apex" (racing line with apex point), new app icons.
- **Safety Rating page**: license card, progress to promotion, CPI, incident
  points, history per session, tracks and hot corners, driver comparison,
  rules. Driver card with rating in the sidebar, rating tile on the overview.
- **Coach & Setup** with sub tabs: Wo Zeit liegt, Setup-Diagnose,
  Setup-Logbuch (new: log a change, automatic before/after comparison of best,
  median, spread, invalid share; `/api/setup_changes`), Reifen & Bremsen (new:
  per-wheel pressure, inner/middle/outer and brake temperatures from
  collector 0.9, editable pressure window, hints for pressure, camber, ABS/TC
  per corner).
- **Track pictures** everywhere a track is named (bests, sessions, coach
  header, safety): outline from your own laps (`/api/trackmap`).

## Server · Collector 0.9.1 — 2026-11-11
- **Safety Rating** modelled on iRacing (own formulas): incident points per
  corner (CPI), license classes R/D/C/B/A with 0.00–4.99, the rating moves
  per session towards the session's target (longer sessions weigh more),
  promotion at 4.00 after at least 3 sessions in the class (rating −1.00),
  demotion below 1.00 (back to 2.50). Higher classes need a better CPI.
  Incidents: invalid lap 1x, loss of control/off 2x, impact 4x (from the
  speed trace), iRacing laps use the game's own incident points.
  `GET /api/safety[?driver=]`, module `server/safety.py`.
- Collector 0.9.1: the trace stores where a lap became invalid (`inv_at`),
  so invalid laps can be tied to a corner.

## Collector 0.9.0 — 2026-11-11
- **Per-lap car data** (`stats`): average tyre pressure, core temperature and
  inner/middle/outer temperature per wheel, brake temperature (average and
  peak), brake bias, TC/ABS/map level (most common value), share of the lap
  with ABS/TC active (and wheel lock in AC EVO), fuel used, tyre compound.
  Only counted on track above 30 km/h. Needs at least 50 samples.
- Trace: new `abs` and `tcx` channels (0/1 per point) show where ABS and TC
  intervene, so the coach can tie them to corners.
- Server: new table `lap_stats`, `GET /api/lapstats`, `Trace.abs/tcx`;
  older servers ignore the new fields.

## Collector 0.8.1 — 2026-11-11
- **Fix: ACC was never detected while SimHub was running.** SimHub keeps the
  AC EVO shared memory names open even when AC EVO is closed. The collector
  checks AC EVO first, so it picked the stale EVO memory again and again and
  never reached ACC. A game that stops delivering new data is now skipped for
  30 s (`STALE_SKIP_S`) and the other games are checked first; if nothing else
  is running, the stale game is still watched so a new drive is picked up.

## UI 0.15.0 · Collector 0.8.0 — 2026-11-10
- **Automobilista 2** (`ams2`): read through the Project CARS 2 shared memory
  (`$pcars2$`, SharedMemory.h version 14). Lap times, validity
  (`mLapInvalidated`), pit lane, position on track, world position (track map),
  speed, pedals, gear, rpm, steering, lateral g and yaw rate (coach and
  handling), fuel, tyre/brake temperatures, tyre pressures, brake bias,
  TC/ABS settings. Consistent reads via `mSequenceNumber`. No session id in the
  API: a new session starts when the lap counter goes back or the session type
  changes. **In AMS2: Options → System → Shared Memory = "Project CARS 2".**

## UI 0.14.1 — 2026-11-08
- On phones (narrow, or landscape with little height) the live tab *is* the
  cockpit. "Details" shows the full live view, "⛶ Cockpit" goes back,
  "Übersicht" leaves. Desktop and tablet keep the full live view.

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
