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
| none of the above | which phase loses the time (entry or exit) |

Tips are sorted by a score: the difference divided by its threshold. The UI
shows the top two.

## 6. Session report and corner history

- `GET /api/coach?…&session_uid=…` runs the same analysis on one session only.
  The session's best lap becomes the reference.
- Each corner includes a `history`: segment time, apex speed and braking point
  for every usable lap, in order. The UI shows the last 40.

## Limits

- **Resolution**: collector 0.6 records a point every 0.125 % of the lap
  (≈ 5 m on a 4 km track). Older laps have 0.5 % (≈ 20 m). Braking points
  from old laps are good to about ±5–10 m.
- **Line choice is not measured.** Speed and pedals show *what* differs, not
  *where on the road* you drove.
- **Corners are found on the reference lap.** If the PB changes, the corner
  numbering can change too, for example when a chicane splits into two corners.
- A corner can be faster in a lap that was slower overall because of a mistake
  elsewhere. That is exactly what the coach looks for. A segment time can also
  benefit from a cut, though only valid laps are used.
