#!/usr/bin/env bash
#
# Nurofen control plane installer (Ubuntu 22.04/24.04, Debian 12+).
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/nurofen/main/server/install/install.sh | bash -s -- --host <ip>
#
# Options:
#   --host <ip>        public IPv4 of this server (auto-detected when omitted)
#   --port <udp>       AmneziaWG listen port (default: random high port)
#   --pool <list>      extra obfuscation ports redirected to the main one
#   --api-port <tcp>   control plane port (default: 8787)
#   --no-firewall      do not touch ufw
#
set -Eeuo pipefail

ROOT=/etc/nurofen
APP=/opt/nurofen
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT=8787
AWG_PORT=""
PUBLIC_HOST=""
POOL="443,500,4500,8443"
TOUCH_FIREWALL=1

log()  { printf '\033[38;5;42m[nurofen]\033[0m %s\n' "$*"; }
warn() { printf '\033[38;5;214m[nurofen]\033[0m %s\n' "$*"; }
die()  { printf '\033[38;5;196m[nurofen]\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) PUBLIC_HOST="$2"; shift 2 ;;
    --port) AWG_PORT="$2"; shift 2 ;;
    --pool) POOL="$2"; shift 2 ;;
    --api-port) API_PORT="$2"; shift 2 ;;
    --no-firewall) TOUCH_FIREWALL=0; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "run as root"

if [[ ! -f /etc/os-release ]]; then die "unsupported OS (no /etc/os-release)"; fi
. /etc/os-release
log "os: ${PRETTY_NAME:-unknown} / $(uname -m)"

case "${ID:-}" in
  ubuntu|debian) ;;
  *) warn "tested on ubuntu/debian, continuing anyway" ;;
esac

export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------- base packages
log "installing base packages"
apt-get update -qq || warn "apt-get update reported errors (broken third-party repo?), continuing"
apt-get install -y -qq curl ca-certificates gnupg lsb-release iproute2 iptables \
  software-properties-common dkms build-essential "linux-headers-$(uname -r)" \
  libmnl-dev libelf-dev pkg-config git >/dev/null

# ------------------------------------------------------------------------ node
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [[ "$major" -ge 22 ]]; then need_node=0; log "node $(node -v) already installed"; fi
fi
if [[ "$need_node" -eq 1 ]]; then
  log "installing nodejs 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -e 'if (parseInt(process.versions.node) < 22) process.exit(1)' || die "node >= 22 required"

# ------------------------------------------------------------------ amneziawg
install_awg_ppa() {
  add-apt-repository -y ppa:amnezia/ppa >/dev/null 2>&1 || return 1
  apt-get update -qq || return 1
  apt-get install -y -qq amneziawg amneziawg-tools >/dev/null || return 1
  command -v awg >/dev/null 2>&1
}

install_awg_source() {
  log "building amneziawg from source (dkms)"
  rm -rf /usr/src/amneziawg
  git clone --quiet --depth 1 https://github.com/amnezia-vpn/amneziawg-linux-kernel-module.git /usr/src/amneziawg
  ( cd /usr/src/amneziawg/src && make -j"$(nproc)" >/dev/null && make install >/dev/null )
  depmod -a
  echo amneziawg > /etc/modules-load.d/amneziawg.conf
  modprobe amneziawg || warn "modprobe amneziawg failed (kernel $(uname -r))"

  rm -rf /tmp/amneziawg-tools
  git clone --quiet --depth 1 https://github.com/amnezia-vpn/amneziawg-tools.git /tmp/amneziawg-tools
  ( cd /tmp/amneziawg-tools/src && make -j"$(nproc)" >/dev/null && make install >/dev/null )
  command -v awg >/dev/null 2>&1
}

if command -v awg >/dev/null 2>&1; then
  log "amneziawg tools already present ($(awg --version 2>/dev/null | head -n1))"
else
  log "installing amneziawg"
  if [[ "${ID:-}" == "ubuntu" ]] && install_awg_ppa; then
    log "amneziawg installed from ppa"
  else
    warn "ppa not available, falling back to source build"
    install_awg_source || die "amneziawg installation failed"
    log "amneziawg installed from source"
  fi
fi

modprobe amneziawg 2>/dev/null || modprobe wireguard 2>/dev/null || true
echo amneziawg > /etc/modules-load.d/amneziawg.conf

# --------------------------------------------------------------- kernel knobs
cat > /etc/sysctl.d/99-nurofen.conf <<EOF
net.ipv4.ip_forward = 1
net.ipv4.conf.all.src_valid_mark = 1
EOF
sysctl -q --system || warn "sysctl apply failed"

# --------------------------------------------------------------------- payload
log "installing control plane into $APP"
install -d -m 0755 "$APP"
rm -rf "$APP/server"
install -d -m 0755 "$APP/server"
cp -a "$SRC_DIR/src" "$APP/server/src"
cp -a "$SRC_DIR/package.json" "$APP/server/package.json"
chown -R root:root "$APP/server"
chmod -R go-w "$APP/server"

install -d -m 0700 "$ROOT"

# ------------------------------------------------------------ pick free ports
port_is_free() {
  local port="$1"
  ! ss -H -lun 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${port}\$"
}

if [[ -z "$AWG_PORT" ]]; then
  AWG_PORT=0
  for candidate in $(shuf -i 20000-60000 -n 40); do
    if port_is_free "$candidate"; then AWG_PORT="$candidate"; break; fi
  done
  [[ "$AWG_PORT" -ne 0 ]] || AWG_PORT=51820
fi
log "amneziawg port: udp/$AWG_PORT"

FREE_POOL=""
IFS=',' read -ra requested <<< "$POOL"
for candidate in "${requested[@]}"; do
  candidate="$(echo "$candidate" | tr -d '[:space:]')"
  [[ -n "$candidate" ]] || continue
  [[ "$candidate" == "$AWG_PORT" ]] && continue
  if port_is_free "$candidate"; then FREE_POOL="${FREE_POOL:+$FREE_POOL,}$candidate"; else warn "udp/$candidate busy, skipped"; fi
done

if [[ -z "$PUBLIC_HOST" ]]; then
  PUBLIC_HOST="$(curl -4 -fsS --max-time 6 https://api.ipify.org || true)"
fi
if [[ -z "$PUBLIC_HOST" ]]; then
  PUBLIC_HOST="$(ip -4 route get 1.1.1.1 | awk '{print $7; exit}')"
fi
[[ -n "$PUBLIC_HOST" ]] || die "cannot detect public ip, pass --host"
log "public endpoint: $PUBLIC_HOST:$AWG_PORT/udp"

# ---------------------------------------------------------------- init config
NUROFEN_ROOT="$ROOT" NUROFEN_PUBLIC_HOST="$PUBLIC_HOST" \
  node "$APP/server/src/cli.js" init --host "$PUBLIC_HOST" --port "$AWG_PORT" --pool "$FREE_POOL" --api-port "$API_PORT" >/dev/null

INVITE="$(NUROFEN_ROOT="$ROOT" node "$APP/server/src/cli.js" invite)"
ADMIN_TOKEN="$(node -e 'const c=require(process.argv[1]); process.stdout.write(c.adminToken)' "$ROOT/nurofen.json")"

# ------------------------------------------------------------------- systemd
cat > /etc/systemd/system/nurofen.service <<EOF
[Unit]
Description=Nurofen virtual LAN control plane
Documentation=https://github.com/VI3I0NN/nurofen
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node $APP/server/src/index.js
Environment=NUROFEN_ROOT=$ROOT
Environment=NUROFEN_API_PORT=$API_PORT
Restart=always
RestartSec=2
LimitNOFILE=65535
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$ROOT
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable nurofen >/dev/null 2>&1
systemctl restart nurofen

for _ in $(seq 1 40); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${API_PORT}/healthz" >/dev/null 2>&1; then
    HEALTHY=1; break
  fi
  sleep 0.5
done
[[ "${HEALTHY:-0}" -eq 1 ]] || die "control plane did not start, check: journalctl -u nurofen -n 80 --no-pager"

# ------------------------------------------------------------------ firewall
if [[ "$TOUCH_FIREWALL" -eq 1 ]] && command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  log "opening firewall ports in ufw"
  ufw allow "${API_PORT}/tcp" >/dev/null
  ufw allow "${AWG_PORT}/udp" >/dev/null
  # ICMP and peer traffic inside the tunnel: without this the client cannot tell
  # a working tunnel from a blocked port.
  ufw allow in on "${IFACE:-nurofen0}" >/dev/null
  IFS=',' read -ra pool_ports <<< "$FREE_POOL"
  for candidate in "${pool_ports[@]}"; do
    [[ -n "$candidate" ]] && ufw allow "${candidate}/udp" >/dev/null
  done
fi

# -------------------------------------------------------------------- summary
cat <<EOF

  Nurofen is up.

  API / admin panel   http://${PUBLIC_HOST}:${API_PORT}/admin
  Admin token         ${ADMIN_TOKEN}
  Invite code         ${INVITE}
  Tunnel endpoint     ${PUBLIC_HOST}:${AWG_PORT}/udp
  Extra ports         ${FREE_POOL:-none}

  Save the admin token: it is the only way into the panel.
  Friends install the Nurofen client and enter the invite code above.

  Logs     journalctl -u nurofen -f
  CLI      cd $APP/server && node src/cli.js info

EOF
