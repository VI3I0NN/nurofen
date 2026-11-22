#!/usr/bin/env bash
#
# Updates the control plane code on a server that install.sh already set up.
# Keeps config, keys, networks and peers untouched: only src/ is replaced.
#
#   sudo bash server/install/update.sh
#
set -Eeuo pipefail

APP=/opt/nurofen
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '\033[38;5;42m[nurofen]\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -d "$APP/server" ]] || { echo "not installed: $APP/server missing, run install.sh" >&2; exit 1; }

log "updating $APP/server/src"
rm -rf "$APP/server/src.new"
cp -a "$SRC_DIR/src" "$APP/server/src.new"
rm -rf "$APP/server/src.old"
[[ -d "$APP/server/src" ]] && mv "$APP/server/src" "$APP/server/src.old"
mv "$APP/server/src.new" "$APP/server/src"
cp -a "$SRC_DIR/package.json" "$APP/server/package.json"
rm -rf "$APP/server/src.old"
chown -R root:root "$APP/server"
chmod -R go-w "$APP/server"

log "restarting service"
systemctl restart nurofen

for _ in $(seq 1 40); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${NUROFEN_API_PORT:-8787}/healthz" >/dev/null 2>&1; then
    log "ok"
    NUROFEN_ROOT=/etc/nurofen node "$APP/server/src/cli.js" info
    exit 0
  fi
  sleep 0.5
done

echo "service did not come back, check: journalctl -u nurofen -n 60 --no-pager" >&2
exit 1
