# Development

## Setup

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt pytest httpx
.venv/bin/python -m pytest
```

The tests run on Linux, without a game:

| File | Covers |
|---|---|
| `tests/test_detector.py` | Lap detection (counter, fallback, validity, out/in laps, sessions), `build_trace`, struct sizes and offsets (EVO, ACC, AC), physics block |
| `tests/test_iracing.py` | iRacing session-info parser, snapshot values from a fake memory map, off-track/garage and incident rules |
| `tests/test_server.py` | API: posting and duplicate laps, bests, filters, drivers, traces, track map, live round trip |
| `tests/test_coach.py` | Corner detection, potential and tips on synthetic laps, `/api/coach` |

Windows wide strings are modelled as `uint16` arrays, so the struct offsets
match Windows even when tests run on Linux.

## Running locally

```sh
cd server
SIMDASH_DB=/tmp/simdash-dev.db SIMDASH_TOKEN=test ../.venv/bin/uvicorn app:app --reload --port 8099
```

Open <http://127.0.0.1:8099>. To get data:

- Post laps with `Authorization: Bearer test` to `/api/laps` (format: [api.md](api.md)).
- Or copy laps from another SimDash server: read `GET /api/laps` and `GET /api/traces`
  there, then `POST /api/laps` here.
- For the live tab, POST a fake state to `/api/live` about 10 times a second.

There is no build step. Edit the files in `server/static/` and reload the page.

## Conventions

- **Language**: the UI, log messages and code comments are German. The
  documentation is English.
- **Frontend**: the classic scripts share one global scope, so function and
  `const` names must be unique across `app.js`, `coach.js`, `progress.js` and
  `live.js`. Bump `?v=` in `index.html` after frontend changes.
- **Collector**: standard library only, and it must run on Python 3.11 on
  Windows. Bump `VERSION` when the trace format or the payload changes.
- **Trace format changes**: keep old laps readable. The server resamples, and
  missing fields are `null`.

## Release

1. Run `.venv/bin/python -m pytest`.
2. Bump `VERSION` in the collector and `?v=` in `index.html`, and update
   `CHANGELOG.md`.
3. Run `./deploy/deploy.sh root@<server>`. This also rebuilds the collector zip
   that the UI offers for download.
4. Update the collector on the PC (see below).

## Updating the collector remotely

The collector must run in the interactive desktop session (see
[installation](installation.md#autostart)). Over SSH (OpenSSH server on
Windows), copy the new file and start it with a one-off scheduled task:

```powershell
Get-CimInstance Win32_Process -Filter "name like 'py%'" |
  ? { $_.CommandLine -like '*simdash_collector*' } | % { Stop-Process -Id $_.ProcessId -Force }
Copy-Item C:\SimDash\simdash_collector.py C:\SimDash\simdash_collector.py.bak -Force
Copy-Item $HOME\simdash_collector.py C:\SimDash\simdash_collector.py -Force
$a = New-ScheduledTaskAction -Execute "pyw.exe" -Argument '-3 C:\SimDash\simdash_collector.py' -WorkingDirectory C:\SimDash
$p = New-ScheduledTaskPrincipal -UserId (whoami) -LogonType Interactive
Register-ScheduledTask -TaskName SimDashStartOnce -Action $a -Principal $p -Force | Out-Null
Start-ScheduledTask SimDashStartOnce; Start-Sleep 8
Unregister-ScheduledTask SimDashStartOnce -Confirm:$false
Get-Content "$env:LOCALAPPDATA\SimDash\collector.log" -Tail 3
```

Use the full path to `pyw.exe` if it isn't on `PATH`, e.g.
`C:\Users\<you>\AppData\Local\Programs\Python\Launcher\pyw.exe`. `-UserId`
needs the `DOMAIN\user` form that `whoami` prints.
