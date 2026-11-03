# Installation

SimDash has two parts:

- **Server**: Linux, Python 3.11+, FastAPI and SQLite. It stores the laps and serves the web UI.
- **Collector**: Windows, Python 3.11+, standard library only. It runs on the gaming PC.

## Server

### With the deploy script (recommended)

Requirements: a Debian/Ubuntu host or LXC container with `python3`, `python3-venv`
and root SSH access from the machine you deploy from.

```sh
git clone <this repo> && cd simdash
./deploy/deploy.sh root@<server-ip>
```

The script does the following:

1. It builds `server/static/simdash-collector.zip`, the collector download, with
   the server address already filled into `simdash.ini`.
2. It copies `server/`, `requirements.txt` and the systemd unit to `/opt/simdash`.
3. It creates the system user `simdash` and a virtualenv in `/opt/simdash/.venv`.
4. On the first run only, it creates `/etc/simdash.env` with a random write token:
   ```
   SIMDASH_TOKEN=…
   SIMDASH_DB=/var/lib/simdash/simdash.db
   ```
5. It installs and restarts `simdash.service` (uvicorn on port **8080**).

Run the same command again to update. The database and the token are kept.

### Manual

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cd server
SIMDASH_TOKEN=$(python3 -c "import secrets;print(secrets.token_urlsafe(24))") \
SIMDASH_DB=/var/lib/simdash/simdash.db \
../.venv/bin/uvicorn app:app --host 0.0.0.0 --port 8080
```

| Variable | Default | Meaning |
|---|---|---|
| `SIMDASH_TOKEN` | – (writes disabled) | Bearer token the collector uses for `POST /api/laps` and `/api/live` |
| `SIMDASH_DB` | `server/simdash.db` | SQLite file. Tables are created automatically on start |

### Reverse proxy

Behind nginx or Caddy, disable buffering for `/api/live/stream`. It is a
Server-Sent Events stream:

```nginx
location /api/live/stream { proxy_pass http://127.0.0.1:8080; proxy_buffering off; proxy_read_timeout 1h; }
location / { proxy_pass http://127.0.0.1:8080; }
```

Edits from the UI (drivers, notes) are only accepted from private IP addresses.
Behind a proxy, uvicorn's `--proxy-headers` (already set in the unit) passes the
real client address through.

### Backup

Back up `/var/lib/simdash/simdash.db`. Use `sqlite3 … ".backup file"` while the
service is running.

## Collector (Windows)

### Install

1. Install Python 3.11 or newer: `winget install Python.Python.3.12`
2. Open `http://<server-ip>:8080` and click **"Collector für Windows
   herunterladen"** at the bottom of the page. Unpack it to `C:\SimDash`.
3. Open `C:\SimDash\simdash.ini` and enter the token from the server's `/etc/simdash.env`:

```ini
[server]
url = http://<server-ip>:8080
token = <SIMDASH_TOKEN>

[live]
# live tab: send the current state up to hz times per second
enabled = true
hz = 10

[processes]
# executable = game; used to tell ACC/AC/AC Rally apart (they share the mapping names)
ac2-win64-shipping.exe = acc
acs.exe = ac
```

### Test

Run `py -3 C:\SimDash\simdash_collector.py --dump` in a console and start
driving. Once per second it prints the detected game, track, car, lap and timer.
`--selftest` prints struct sizes and offsets.

### Autostart

Press Win+R, type `shell:startup`, and create a shortcut there:

- Target: `C:\Users\<you>\AppData\Local\Programs\Python\Launcher\pyw.exe -3 C:\SimDash\simdash_collector.py`
- Start in: `C:\SimDash`

`pyw` runs without a console window.

> **Important:** the collector must run in your **logged-in desktop session**.
> Windows creates the games' shared memory (`Local\…`) per logon session, so the
> collector cannot run as a service or be started directly over SSH. To start it
> remotely, use a one-off scheduled task with `-LogonType Interactive`
> (see [development.md](development.md#updating-the-collector-remotely)).

> **Smart App Control** blocks `.bat` and `.cmd` files. Shortcuts that start
> the signed Python launcher work.

### Files on the PC

| Path | Content |
|---|---|
| `%LOCALAPPDATA%\SimDash\laps.csv` | Every lap ever recorded (local backup) |
| `%LOCALAPPDATA%\SimDash\queue.jsonl` | Laps not yet accepted by the server. They are resent automatically |
| `%LOCALAPPDATA%\SimDash\collector.log` | Log |

### Updating the collector

Download the zip again, or copy `collector/simdash_collector.py` over the old
file. Then stop the running `pyw.exe` process for SimDash (Task Manager → Details)
and start the shortcut again. `simdash.ini` is not overwritten if you only copy
the `.py` file.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Collector log shows `401 Falscher Token` | Token in `simdash.ini` doesn't match `/etc/simdash.env`. Also check that the autostart points to the right folder |
| `503 SIMDASH_TOKEN ist auf dem Server nicht gesetzt` | Server started without a token |
| No laps, `--dump` shows nothing | Collector not running in the desktop session, or the game process name is unknown (add it under `[processes]`) |
| Laps arrive, but no map | The track shape is learned from position data. Drive one lap with collector ≥ 0.3 (any car). iRacing has no world position |
| Live tab says "Keine Verbindung zum Collector" | `[live] enabled = false`, collector < 0.4, or the server is unreachable from the PC |
| A lap is missing or "≈ geschätzt" | The game reported no lap (disconnect, pit exit glitch). The time comes from the running timer at the line |
