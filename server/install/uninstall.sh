#!/usr/bin/env bash
#
# Removes the Nurofen control plane from this server.
#   bash uninstall.sh          keep /etc/nurofen (keys, networks, devices)
#   bash uninstall.sh --purge  remove everything
#
set -Eeuo pipefail

ROOT=/etc/nurofen
APP=/opt/nurofen
PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1

log() { printf '\033[38;5;42m[nurofen]\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

log "stopping service"
systemctl stop nurofen 2>/dev/null || true
systemctl disable nurofen 2>/dev/null || true
rm -f /etc/systemd/system/nurofen.service
systemctl daemon-reload

log "bringing the tunnel down"
if [[ -f "$ROOT/nurofen0.conf" ]]; then
  awg-quick down "$ROOT/nurofen0.conf" 2>/dev/null || true
fi

log "removing port redirection rules"
iptables -t nat -D PREROUTING -j NUROFEN_PORTS 2>/dev/null || true
iptables -t nat -F NUROFEN_PORTS 2>/dev/null || true
iptables -t nat -X NUROFEN_PORTS 2>/dev/null || true

log "removing $APP"
rm -rf "$APP"

if [[ "$PURGE" -eq 1 ]]; then
  log "purging $ROOT and sysctl settings"
  rm -rf "$ROOT"
  rm -f /etc/sysctl.d/99-nurofen.conf
  sysctl -q --system || true
else
  log "kept $ROOT (use --purge to delete keys and devices)"
fi

log "done. amneziawg packages were left installed on purpose."
