SimDash collector
=================

Reads lap times and telemetry from AC EVO, ACC, Assetto Corsa, iRacing,
Le Mans Ultimate, Automobilista 2 and AC Rally (experimental) and sends them to
your SimDash server (address in simdash.ini). Deutsch: siehe LIESMICH.txt.

Setup (once)
1. Install Python if you don't have it. In PowerShell:
     winget install Python.Python.3.12
2. Put this folder at C:\SimDash.
3. Open simdash.ini and enter the token after token= (the server keeps it in
   /etc/simdash.env as SIMDASH_TOKEN).
4. Create desktop shortcuts (right-click > New > Shortcut):
     "SimDash Test":      py -3 C:\SimDash\simdash_collector.py --dump
     "SimDash Collector": pyw -3 C:\SimDash\simdash_collector.py
   (No .bat files: Smart App Control blocks them, Python itself is signed.)

Test in the game
- Start "SimDash Test", get in the car and drive. Once per second you see the
  lap count, running time, track and car.
  Track/car/time correct -> fine. Otherwise post the output in an issue.

Autostart
- Win+R, shell:startup, put a copy of the "SimDash Collector" shortcut there.
- Important: the collector must run in the logged-in desktop session (the games
  only provide their data there), not as a service.

Game settings
- Automobilista 2: Options -> System -> Shared Memory = "Project CARS 2".
- Le Mans Ultimate: the shared-memory interface must be enabled.

Where is what?
- Every lap is stored locally first:   %LOCALAPPDATA%\SimDash\laps.csv
- Laps not yet sent:                    %LOCALAPPDATA%\SimDash\queue.jsonl
  (sent automatically as soon as the server is reachable)
- Log:                                  %LOCALAPPDATA%\SimDash\collector.log
  (log messages are in German)

Notes
- iRacing doesn't report validity. A lap counts as invalid when all four wheels
  were off track; incidents are added as a note to the lap.
- Assetto Corsa (2014) doesn't report validity -> "unknown".
- "estimated" = the game's lap counter didn't arrive (e.g. a disconnect); the
  time comes from the running lap timer at the line (accurate to ~20 ms).
- Remove autostart: open shell:startup and delete the shortcut.
