# SimDash

Self-hosted lap time tracker for sim racing. A small collector on your gaming PC
reads every finished lap from the game's shared memory and sends it to a server
in your home lab, which shows personal bests per game, track and car.

> **Beta.** The collector has been checked against the official shared-memory
> documentation, but not yet against every game in real driving. Feedback welcome.

## Why

Online sessions drop. When the server connection is lost right after your best
lap, the time is gone. SimDash stores every lap locally on the PC first, then
syncs it to the server – and if the game never reports the lap (e.g. disconnect
at the line), it records the lap from the running timer and marks it *estimated*.

## Supported games

| Game | Source | Lap validity | Status |
|---|---|---|---|
| Assetto Corsa EVO | `Local\acevo_pmf_*` (Kunos SharedFileOut v1, 2026-04) | from game | beta |
| iRacing | iRacing SDK memory map | derived: all four wheels off track = invalid; incidents per lap as note | beta |
| Assetto Corsa Competizione | `Local\acpmf_*` (ACC shared memory v1.8.12) | from game | beta |
| Assetto Corsa Rally | `Local\acpmf_*` (ACC layout) | unknown | experimental |
| Assetto Corsa (2014) | `Local\acpmf_*` | not available | beta |

ACC, AC and AC Rally share the mapping names; the collector tells them apart by
the running process.

## Features

- Personal best per game / track / layout / car (valid laps only), fastest lap overall
- Recent laps grouped by session, with *invalid*, *estimated*, *out lap*, *in lap* and *PB* markers
- Mobile-friendly web UI, read-only on the LAN; writes need a token
- Collector uses only the Python standard library; offline queue with automatic resend
- Full local log of every lap in `%LOCALAPPDATA%\SimDash\laps.csv`

## Architecture

```
Gaming PC (Windows)                      Home lab (Linux / LXC)
simdash_collector.py  ── HTTP POST ──▶   FastAPI + SQLite  ──▶  web UI :8080
  reads shared memory                    /api/laps, /api/bests
  laps.csv + queue.jsonl
```

## Server setup

Any Debian/Ubuntu host or LXC with Python 3.11+ and root SSH access:

```sh
./deploy/deploy.sh root@<server-ip>
```

This installs the app to `/opt/simdash`, creates a `simdash` system user and a
systemd service on port 8080, generates a write token in `/etc/simdash.env`, and
builds a collector download package that is linked at the bottom of the web UI.

## Collector setup (Windows)

1. Install Python 3.11+ (`winget install Python.Python.3.12`).
2. Download the collector from the web UI and unpack it to `C:\SimDash`.
3. Put the token from `/etc/simdash.env` into `simdash.ini`.
4. Create shortcuts:
   - test window: `py -3 C:\SimDash\simdash_collector.py --dump`
   - background: `pyw -3 C:\SimDash\simdash_collector.py` (copy into `shell:startup` for autostart)

The collector has to run inside your logged-in desktop session – games publish
their shared memory per session, so it cannot run as a Windows service or over SSH.

If **Smart App Control** is enabled, `.bat` files are blocked; shortcuts that start
the signed Python launcher directly work fine.

`--selftest` prints struct sizes and offsets, `--dump` shows the live values once per second.

## Development

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt pytest httpx
.venv/bin/python -m pytest
```

The lap detector, struct layouts and the iRacing reader are covered by tests that
run on Linux (wide strings are modelled as `uint16` arrays so offsets match Windows).

## Credits

- Struct layouts follow Kunos' official shared-memory documentation for AC EVO and ACC.
- Offsets were cross-checked against the independent structs in
  [live-telemetry-evo](https://github.com/albertowd/live-telemetry-evo) (no code copied).

## License

MIT
