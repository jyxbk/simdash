# How the coach works

Code: [`server/coach.py`](../server/coach.py) · endpoint `GET /api/coach`

The coach answers one question: **where is your PB lap slower than you have
already driven?** It doesn't compare you with an alien lap or a theoretical
optimum, only with your own best run through each corner. Every tip is
therefore something you have already done once.

## 1. Choosing laps

- **Counting laps**: valid (or validity unknown), not estimated, not out or in
  laps.
- **Usable**: at least 95 % of the trace points have a time and a speed.
- **Clean**: no slower than 107 % of the PB. Laps with spins or traffic are
  left out.
- The **reference** is the fastest usable lap, normally your PB.

Old laps (200 trace points) and new laps (800 points, collector ≥ 0.6) are
resampled onto the finer grid, so all laps can be compared point by point.

## 2. Finding corners

Corners are found in the reference lap's speed trace:

1. Smooth the trace with a triangle filter (±1 point per 200-point resolution).
2. Rotate it so it starts at the fastest point, usually the main straight.
3. Find peaks and valleys with **hysteresis**: speed must fall by at least
   **12 km/h** and rise again by the same amount. Each valley is a corner
   apex. The peak before it marks where braking starts.

A **corner segment** runs from the braking point of this corner to the braking
point of the next one. The exit and the following straight therefore count
toward the corner. That is intended, because a better exit gains most of its
time on the straight.

Flat-out kinks without a 12 km/h dip are not corners. Their time is part of the
neighbouring segment.

## 3. Potential

For each corner and each clean lap, the segment time is the difference between
the trace times at its start and end (wrapping across the finish line where
needed).

- **best** = fastest segment time over all clean laps, from the "model lap"
  ("Vorbild").
- **gain** = reference segment time − best.
- **Ideal lap** = sum of all best segment times. **Potential** = PB − ideal lap.
- **Phase split**: the same comparison only up to the apex gives the loss in
  *braking & turn-in*. The rest is *exit*.
- **Spread** = standard deviation of the segment times across clean laps. The
  corner with the largest spread is reported as the least consistent.

## 4. Metrics per corner

Measured on both the reference lap and the model lap:

| Metric | Definition |
|---|---|
| Apex speed | minimum speed within ±4 points (200-point grid) of the apex |
| Entry speed | maximum speed around the segment start |
| Exit speed | speed halfway between apex and segment end |
| Braking point | first point where brake ≥ 15 %, interpolated between grid points, shown in metres before the apex |
| Full throttle | first point after the apex where throttle ≥ 90 %, shown in metres after the apex |
| Gear | most frequent real gear around the apex; neutral during a shift is ignored (collector ≥ 0.6) |
| Steering peak | largest steering value from braking to just after the apex (collector ≥ 0.6) |
| Steering work | sum of all steering movements over the same stretch (collector ≥ 0.6) |

Metres come from the track length, which is estimated by integrating speed ×
time over the clean laps (median).

## 5. Tips

A corner gets tips only if the gain is at least **30 ms**. The rules, from the
model lap's point of view:

| Condition | Tip |
|---|---|
| brakes ≥ 8 m later | "Bremse etwa N m später" (brake later) |
| brakes ≥ 8 m earlier **and** ≥ 2 km/h more apex speed | "Bremse früher und nimm mehr Tempo mit" (brake earlier, carry more speed) |
| ≥ 2 km/h more apex speed | "Nimm N km/h mehr Tempo durch den Scheitel" (more apex speed) |
| full throttle ≥ 8 m earlier | "Geh etwa N m früher voll aufs Gas" (full throttle earlier) |
| ≥ 3 km/h more exit speed | "Besserer Ausgang" (better exit), unless the throttle tip already covers it |
| ≥ 4 km/h more entry speed | "Komm mit N km/h mehr an" (arrive with more speed), only if nothing else applies |
| different gear at the apex | "Nimm die Kurve einen Gang höher/tiefer" (a gear higher or lower) |
| ≥ 35 % less steering work, at least 0.5 less | "Lenke ruhiger" (calmer steering) |
| ≥ 6 points less steering **and** ≥ 2 km/h more apex speed | "Du lenkst stärker ein und bist trotzdem langsamer" (too much lock) |
| none of the above | which phase loses the time (entry or exit) |

Laps from before collector 0.6 have no gear or steering data. If the PB lap or
the model lap is such a lap, the coach compares the fastest newer lap with the
fastest newer run through that corner, and the tip ends with *"(laut neueren
Runden)"* (according to newer laps). It needs a difference of at least 30 ms.

Tips are sorted by a score: the difference divided by its threshold, or a fixed
weight for gear and steering. The UI shows the top three.

## 6. Session report and corner history

- `GET /api/coach?…&session_uid=…` runs the same analysis on one session only.
  The session's best lap becomes the reference.
- Each corner includes a `history`: segment time, apex speed and braking point
  for every usable lap, in order. The UI shows the last 40.

## 7. Auto insights: one lap against a reference

`GET /api/coach/lap?id=…[&ref_id=…]` compares a single lap with a reference lap
(default: your PB; if the lap *is* the PB, the previous PB). Corners come from
the reference lap. Each corner is split into four phases using the reference:

| Phase | From → to |
|---|---|
| Braking | start of the corner → two thirds of the speed drop done |
| Turn-in | → shortly before the apex |
| Apex | apex ± two grid windows |
| Exit | → start of the next corner (the straight counts) |

The phase times add up to the corner loss, and the corner losses add up to the
lap delta. The worst phase gets a sentence (braking point, entry/apex/exit speed,
full throttle point, or as fallback: where in the phase speed was missing and
whether you were on full throttle). For the racing line, x/z of both laps around
the corner is returned, plus the sideways distance at the apex (+ inside,
− outside), using the reference's curvature to decide which side is inside.

Shown in the live tab after every lap and in the lap comparison.

## 8. Handling and setup diagnosis

`GET /api/handling` estimates understeer and oversteer without lateral-g data:
the curvature of the driven line comes from smoothed x/z positions, lateral
acceleration is v²·k. Over the best (up to 12) clean laps a linear model
`steering = c1·k + c2·g` is fitted (steering sign is taken from its correlation
with curvature, so it works for every game). For each corner the phases
turn-in, apex and exit (≈150 m) are checked:

- **Understeer:** on average clearly more steering than the model expects
  (≥ 35 % of the kinematic steering, and more than the spread between laps).
- **Oversteer:** real countersteer (steering against the corner, not during a
  change of direction, at least 2 points or ≥ 8 % of the range) in at least a
  quarter of the laps. With throttle ≥ 50 % it counts as power oversteer, with
  brake ≥ 10 % as oversteer on the brakes.

Findings are grouped by cause and come with generic setup suggestions (GT-style
cars). It is an estimate: change one thing, drive 5 laps, then pick that
session to compare.

## Limits

- **Resolution**: collector 0.6 records a point every 0.125 % of the lap
  (≈ 5 m on a 4 km track). Older laps have 0.5 % (≈ 20 m). Braking points
  from old laps are good to about ±5–10 m.
- **Steering tips are hints, not proof.** Less steering in a faster run doesn't
  show that calmer steering caused the gain.
- **Line choice is not measured.** Speed and pedals show *what* differs, not
  *where on the road* you drove.
- **Corners are found on the reference lap.** If the PB changes, the corner
  numbering can change too, for example when a chicane splits into two corners.
- A corner can be faster in a lap that was slower overall because of a mistake
  elsewhere. That is exactly what the coach looks for. A segment time can also
  benefit from a cut, though only valid laps are used.
