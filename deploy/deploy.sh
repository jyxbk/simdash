#!/bin/sh
# Spielt den Server in den LXC 112 (simdash) ein. Daten (DB) bleiben unter /var/lib/simdash.
set -e
HOST=${1:-root@SERVER-IP}
cd "$(dirname "$0")/.."
# Windows-Paket für den Download über die Weboberfläche
python3 - <<'PY'
import zipfile, pathlib
src = pathlib.Path("collector")
with zipfile.ZipFile("server/static/simdash-collector.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(src.iterdir()):
        if f.is_file():
            z.write(f, f"SimDash/{f.name}")
PY
tar czf - --exclude='*.db*' --exclude=__pycache__ server requirements.txt deploy/simdash.service | ssh "$HOST" '
set -e
id simdash >/dev/null 2>&1 || useradd --system --home /var/lib/simdash --create-home simdash
mkdir -p /opt/simdash && tar xzf - -C /opt/simdash
[ -d /opt/simdash/.venv ] || python3 -m venv /opt/simdash/.venv
/opt/simdash/.venv/bin/pip install -q -r /opt/simdash/requirements.txt
if [ ! -f /etc/simdash.env ]; then
  umask 077
  printf "SIMDASH_TOKEN=%s\nSIMDASH_DB=/var/lib/simdash/simdash.db\n" "$(python3 -c "import secrets;print(secrets.token_urlsafe(24))")" > /etc/simdash.env
  chown root:simdash /etc/simdash.env; chmod 640 /etc/simdash.env
fi
cp /opt/simdash/deploy/simdash.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now simdash >/dev/null 2>&1
systemctl restart simdash
'
