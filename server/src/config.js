import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { cleanNetworkName, hashPassword, id, isValidKey, networkKey, nowIso, token } from './util.js';

export const CONFIG_VERSION = 2;

/**
 * All networks share one AmneziaWG interface. Every network owns a /24 inside
 * this /16, so a peer address tells the server which network it belongs to and
 * the destination subnet tells it whether the packet may leave the hub.
 */
export const SUPERNET = '10.66.0.0/16';
export const NETWORK_PREFIX = 24;
export const NETWORK_INDEX_MAX = 254;
export const MAX_NETWORKS = 128;

/** Address of the hub itself when no network exists yet. */
export const HUB_MANAGEMENT_IP = '10.66.255.254';

export function rootDir() {
  return process.env.NUROFEN_ROOT || '/etc/nurofen';
}

export function stateFile(root = rootDir()) {
  return path.join(root, 'nurofen.json');
}

export function awgConfFile(cfg, root = rootDir()) {
  return path.join(root, `${cfg.server.interface}.conf`);
}

/**
 * X25519 keypair in WireGuard's base64 raw form.
 * Node clamps the scalar internally on use, exactly like `wg genkey` does.
 */
export function generateKeypair() {
  const pair = generateKeyPairSync('x25519');
  const priv = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const pub = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { privateKey: priv.toString('base64'), publicKey: pub.toString('base64') };
}

function randBetween(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * AmneziaWG obfuscation profile.
 *
 * Rules that must hold for the handshake to work:
 *  - Jmin < Jmax, Jc between 3 and 10
 *  - S1 + 148 !== S2
 *  - H1..H4 are distinct 32 bit values
 *
 * Values are randomized per server so that a fingerprint learned from one
 * Nurofen deployment does not apply to the next one.
 */
export function generateObfuscation() {
  let s1 = randBetween(15, 150);
  let s2 = randBetween(15, 150);
  while (s1 + 148 === s2) s2 = randBetween(15, 150);
  const headers = new Set();
  while (headers.size < 4) headers.add(randBetween(100_000_000, 4_000_000_000));
  const [h1, h2, h3, h4] = [...headers];
  return {
    Jc: randBetween(3, 10),
    Jmin: 50,
    Jmax: 1000,
    S1: s1,
    S2: s2,
    H1: h1,
    H2: h2,
    H3: h3,
    H4: h4,
  };
}

export function defaultConfig(overrides = {}) {
  const keys = generateKeypair();
  return {
    version: CONFIG_VERSION,
    createdAt: nowIso(),
    adminToken: token(32),
    server: {
      publicHost: '',
      apiHost: '0.0.0.0',
      apiPort: 8787,
      interface: 'nurofen0',
      awgPort: 51820,
      portPool: [51820, 443, 500, 4500],
      mtu: 1280,
      keepalive: 25,
      supernet: SUPERNET,
      ...overrides.server,
    },
    awg: {
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      obfuscation: generateObfuscation(),
      ...overrides.awg,
    },
    // Fresh installations start empty: everyone creates or joins a network.
    networks: [],
    peers: [],
  };
}

/** "10.66.12.0/24" -> 12, or null when it is not our subnet shape. */
export function subnetIndex(subnet) {
  const match = /^10\.66\.(\d{1,3})\.0\/24$/.exec(String(subnet || ''));
  if (!match) return null;
  const index = Number(match[1]);
  return index >= 0 && index <= NETWORK_INDEX_MAX ? index : null;
}

export function subnetForIndex(index) {
  return `10.66.${index}.0/24`;
}

/** Everything the allocator, AWG config and client config need for one /24. */
export function networkSubnet(network) {
  const index = subnetIndex(network?.subnet) ?? 0;
  const base = `10.66.${index}`;
  return {
    index,
    prefix: NETWORK_PREFIX,
    network: `${base}.0`,
    cidr: `${base}.0/${NETWORK_PREFIX}`,
    serverIp: `${base}.1`,
    // .1 is the hub, .2..9 are reserved (DNS, NAT gateway, future use).
    firstClient: 10,
    lastClient: 254,
  };
}

function nextFreeIndex(used) {
  for (let index = 0; index <= NETWORK_INDEX_MAX; index += 1) {
    if (!used.has(index)) return index;
  }
  return null;
}

/**
 * Old installations stored one network with an invite code and one /24 in
 * server.subnet. The invite becomes the first password, so friends who still
 * know the code can join the same network after the upgrade.
 */
function migrateNetwork(rawNet, used, usedNames) {
  const net = { ...(rawNet || {}) };
  net.id = net.id || id();
  net.createdAt = net.createdAt || nowIso();

  let name = cleanNetworkName(net.name) || 'Сеть';
  let key = networkKey(name);
  let suffix = 2;
  while (usedNames.has(key)) {
    name = `${cleanNetworkName(net.name) || 'Сеть'} ${suffix}`.slice(0, 32);
    key = networkKey(name);
    suffix += 1;
  }
  net.name = name;
  net.nameKey = key;
  usedNames.add(key);

  let index = subnetIndex(net.subnet);
  if (index === null || used.has(index)) index = nextFreeIndex(used);
  if (index === null) return null;
  net.subnet = subnetForIndex(index);
  used.add(index);

  if (!net.passwordHash) {
    const legacy = String(net.invite || net.password || '');
    if (legacy) {
      const hashed = hashPassword(legacy);
      net.passwordSalt = hashed.salt;
      net.passwordHash = hashed.hash;
      net.passwordUpdatedAt = nowIso();
    }
  }
  delete net.invite;
  delete net.password;

  return net;
}

export function loadConfig(root = rootDir()) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = stateFile(root);
  if (!fs.existsSync(file)) {
    const cfg = defaultConfig({
      server: {
        publicHost: process.env.NUROFEN_PUBLIC_HOST || '',
        apiPort: Number(process.env.NUROFEN_API_PORT || 8787),
        awgPort: Number(process.env.NUROFEN_AWG_PORT || 51820),
      },
    });
    writeConfig(cfg, root);
    return cfg;
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = normalize(raw);
  // Persist migrations (invite -> password hash, subnet assignment) right away
  // so the CLI and the service agree on what is on disk.
  try {
    if (JSON.stringify(raw) !== JSON.stringify(cfg)) writeConfig(cfg, root);
  } catch {
    // A read-only root is not fatal: the in-memory config still works.
  }
  return cfg;
}

export function writeConfig(cfg, root = rootDir()) {
  const file = stateFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function normalize(raw) {
  const base = defaultConfig();
  const cfg = {
    ...base,
    ...raw,
    server: { ...base.server, ...(raw.server || {}) },
    awg: { ...base.awg, ...(raw.awg || {}) },
    peers: Array.isArray(raw.peers) ? raw.peers : [],
  };
  cfg.version = CONFIG_VERSION;
  cfg.server.supernet = SUPERNET;
  delete cfg.server.subnet;
  cfg.awg.obfuscation = { ...base.awg.obfuscation, ...(raw.awg?.obfuscation || {}) };
  if (!cfg.adminToken) cfg.adminToken = base.adminToken;

  const used = new Set();
  const usedNames = new Set();
  const networks = [];
  for (const rawNet of Array.isArray(raw.networks) ? raw.networks : []) {
    const net = migrateNetwork(rawNet, used, usedNames);
    if (net) networks.push(net);
  }
  cfg.networks = networks;

  // A peer is only usable when its key loads in `wg` and its network still
  // exists. Hand-edited or half-written entries are revoked instead of
  // breaking every future sync.
  const networkIds = new Set(networks.map((net) => net.id));
  cfg.peers = cfg.peers.filter((peer) => peer && typeof peer === 'object' && peer.id);
  for (const peer of cfg.peers) {
    if (!networkIds.has(peer.networkId) || !isValidKey(peer.publicKey)) peer.revoked = true;
  }
  return cfg;
}
