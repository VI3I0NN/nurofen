import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { ensureDir, confDir, dataDir, profileFile } from './paths.js';

const DEFAULT = {
  version: 3,
  deviceName: '',
  activeId: null,
  settings: {
    compactPeers: true,
    autoConnect: true,
    notifyWorlds: true,
    minecraftDir: '',
    minecraftServerDir: '',
    filesDir: '',
  },
  friends: [],
  networks: [],
};

export function keypair() {
  const pair = generateKeyPairSync('x25519');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64'),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
  };
}

/** Old profiles kept a single network at the top level; fold them into the list. */
function migrate(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT };
  if (Array.isArray(raw.networks)) {
    return {
      ...DEFAULT,
      ...raw,
      settings: {
        ...DEFAULT.settings,
        ...(raw.settings && typeof raw.settings === 'object' ? raw.settings : {}),
      },
      networks: raw.networks.filter((item) => item && item.network && item.self),
    };
  }
  if (raw.token && raw.serverUrl && raw.network && raw.self) {
    return {
      version: DEFAULT.version,
      deviceName: raw.deviceName || '',
      activeId: raw.network.id || null,
      settings: { ...DEFAULT.settings },
      networks: [
        {
          id: randomUUID(),
          deviceId: raw.deviceId || randomUUID(),
          serverUrl: raw.serverUrl,
          token: raw.token,
          network: raw.network,
          self: raw.self,
          server: raw.server,
          obfuscation: raw.obfuscation,
          mtu: raw.mtu || 1280,
          keepalive: raw.keepalive || 25,
          privateKey: raw.privateKey,
          publicKey: raw.publicKey,
          lastPort: raw.lastPort || null,
          interface: 'nurofen',
          listenPort: 57220,
          autoConnect: Boolean(raw.lastPort),
          direct: false,
          createdAt: raw.createdAt || new Date().toISOString(),
        },
      ],
    };
  }
  return { ...DEFAULT };
}

const INTERFACE_RE = /^nurofen(-(\d+))?$/;

/** nurofen, nurofen-2, nurofen-3… — unique interface per network. */
export function nextInterface(profile) {
  const used = new Set((profile.networks || []).map((item) => item.interface));
  if (!used.has('nurofen')) return 'nurofen';
  for (let n = 2; n < 100; n += 1) {
    const name = `nurofen-${n}`;
    if (!used.has(name)) return name;
  }
  return `nurofen-${randomUUID().slice(0, 8)}`;
}

function normalize(profile) {
  const used = new Set();
  const version = Number(profile.version) || 0;
  profile.settings = {
    ...DEFAULT.settings,
    ...(profile.settings && typeof profile.settings === 'object' ? profile.settings : {}),
  };
  // v3: compact list is the default. Older profiles get it once; a deliberate
  // opt-out after the migration is preserved.
  profile.settings.compactPeers = version < 3 ? true : profile.settings.compactPeers !== false;
  profile.settings.autoConnect = profile.settings.autoConnect !== false;
  profile.settings.notifyWorlds = profile.settings.notifyWorlds !== false;
  profile.settings.filesDir = String(profile.settings.filesDir || '').trim();
  profile.friends = (Array.isArray(profile.friends) ? profile.friends : [])
    .filter((item) => item && typeof item === 'object' && item.peerId)
    .map((item) => ({
      peerId: String(item.peerId),
      name: String(item.name || '').slice(0, 32),
      ip: String(item.ip || ''),
      networkId: item.networkId ? String(item.networkId) : '',
      networkName: String(item.networkName || '').slice(0, 32),
      addedAt: item.addedAt || new Date().toISOString(),
    }));
  profile.version = DEFAULT.version;
  for (const item of profile.networks) {
    if (!item.id) item.id = randomUUID();
    if (!item.deviceId) item.deviceId = randomUUID();
    if (!INTERFACE_RE.test(String(item.interface || '')) || used.has(item.interface)) {
      item.interface = '';
    }
    if (item.interface) used.add(item.interface);
  }
  for (const item of profile.networks) {
    if (!item.interface) {
      item.interface = nextInterface(profile);
      used.add(item.interface);
    }
    if (item.autoConnect === undefined) item.autoConnect = Boolean(item.lastPort);
    if (item.direct === undefined) item.direct = false;
    if (!Number.isInteger(item.listenPort) || item.listenPort <= 0 || item.listenPort >= 65536) {
      const match = /^nurofen(?:-(\d+))?$/.exec(String(item.interface || 'nurofen'));
      const index = match && match[1] ? Number(match[1]) - 1 : 0;
      item.listenPort = 57220 + Math.max(0, index);
    }
  }
  if (!profile.networks.some((item) => item.id === profile.activeId)) {
    profile.activeId = profile.networks[0]?.id || null;
  }
  return profile;
}

export function loadProfile() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(profileFile(), 'utf8'));
  } catch {
    raw = null;
  }
  const legacy = raw && (Object.prototype.hasOwnProperty.call(raw, 'invite') || !raw.version || raw.version < DEFAULT.version || Object.prototype.hasOwnProperty.call(raw, 'token'));
  const profile = normalize(migrate(raw));
  if (legacy) saveProfile(profile);
  return profile;
}

export function saveProfile(profile) {
  ensureDir(dataDir());
  const file = profileFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return profile;
}

/** Creates the local identity used when adding a network. */
export function initProfile(deviceName) {
  const profile = loadProfile();
  profile.deviceName = deviceName || profile.deviceName || defaultDeviceName();
  saveProfile(profile);
  return profile;
}

export function defaultDeviceName() {
  const host = process.env.COMPUTERNAME || 'pc';
  return host.replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 20) || 'pc';
}

export function removeMembership(profile, id) {
  profile.networks = profile.networks.filter((item) => item.id !== id);
  if (profile.activeId === id) profile.activeId = profile.networks[0]?.id || null;
  return profile;
}

export function confPath(name = 'nurofen') {
  return path.join(ensureDir(confDir()), `${name}.conf`);
}

export function renderConfig(network, port) {
  if (!network.server || !network.self || !network.obfuscation) {
    throw new Error('profile is not joined to a network');
  }
  const o = network.obfuscation;
  const endpoint = `${network.server.host}:${port ?? network.server.port}`;
  return [
    '# Nurofen profile (generated, do not edit)',
    '[Interface]',
    `PrivateKey = ${network.privateKey}`,
    `Address = ${network.self.ip}/24`,
    `ListenPort = ${network.listenPort || 57220}`,
    `MTU = ${network.mtu || 1280}`,
    `Jc = ${o.Jc}`,
    `Jmin = ${o.Jmin}`,
    `Jmax = ${o.Jmax}`,
    `S1 = ${o.S1}`,
    `S2 = ${o.S2}`,
    `H1 = ${o.H1}`,
    `H2 = ${o.H2}`,
    `H3 = ${o.H3}`,
    `H4 = ${o.H4}`,
    '',
    '[Peer]',
    `PublicKey = ${network.server.publicKey}`,
    `Endpoint = ${endpoint}`,
    `AllowedIPs = ${network.network.subnet}`,
    `PersistentKeepalive = ${network.keepalive || 25}`,
    '',
  ].join('\n');
}
