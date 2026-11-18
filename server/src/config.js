import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { inviteCode, id, nowIso, token } from './util.js';

export const CONFIG_VERSION = 1;

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
      subnet: '10.66.0.0/24',
      ...overrides.server,
    },
    awg: {
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      obfuscation: generateObfuscation(),
      ...overrides.awg,
    },
    networks: [
      {
        id: id(),
        name: 'Nurofen',
        invite: inviteCode(),
        createdAt: nowIso(),
      },
    ],
    peers: [],
  };
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
    networks: Array.isArray(raw.networks) && raw.networks.length ? raw.networks : base.networks,
    peers: Array.isArray(raw.peers) ? raw.peers : [],
  };
  cfg.awg.obfuscation = { ...base.awg.obfuscation, ...(raw.awg?.obfuscation || {}) };
  if (!cfg.adminToken) cfg.adminToken = base.adminToken;
  return cfg;
}

/** Splits "10.66.0.0/24" into the parts the allocator needs. */
export function subnetInfo(cfg) {
  const [addr, mask] = String(cfg.server.subnet).split('/');
  const prefix = Number(mask || 24);
  const octets = addr.split('.').map(Number);
  const network = [...octets];
  if (prefix === 24) network[3] = 0;
  const serverIp = `${network[0]}.${network[1]}.${network[2]}.1`;
  return {
    prefix,
    network: `${network[0]}.${network[1]}.${network[2]}.0`,
    cidr: `${network[0]}.${network[1]}.${network[2]}.0/${prefix}`,
    serverIp,
    // .1 is the hub, .2..8 are reserved for future use (DNS, NAT gateway).
    firstClient: 10,
    lastClient: 254,
  };
}
