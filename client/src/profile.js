import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { ensureDir, confDir, dataDir, profileFile } from './paths.js';

const DEFAULT = {
  version: 1,
  deviceId: null,
  deviceName: '',
  privateKey: '',
  publicKey: '',
  token: '',
  network: null,
  self: null,
  server: null,
  obfuscation: null,
  mtu: 1280,
  keepalive: 25,
  portIndex: 0,
  lastPort: null,
  createdAt: null,
};

export function keypair() {
  const pair = generateKeyPairSync('x25519');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64'),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
  };
}

export function loadProfile() {
  try {
    const raw = JSON.parse(fs.readFileSync(profileFile(), 'utf8'));
    return { ...DEFAULT, ...raw };
  } catch {
    return { ...DEFAULT };
  }
}

export function saveProfile(profile) {
  ensureDir(dataDir());
  const file = profileFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return profile;
}

/** Creates the local identity: device id, name and X25519 keypair. */
export function initProfile(deviceName) {
  const profile = loadProfile();
  if (!profile.deviceId) profile.deviceId = randomUUID();
  if (!profile.privateKey) {
    const pair = keypair();
    profile.privateKey = pair.privateKey;
    profile.publicKey = pair.publicKey;
  }
  profile.deviceName = deviceName || profile.deviceName || defaultDeviceName();
  profile.createdAt = profile.createdAt || new Date().toISOString();
  saveProfile(profile);
  return profile;
}

export function defaultDeviceName() {
  const host = process.env.COMPUTERNAME || 'pc';
  return host.replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 20) || 'pc';
}

export function forgetNetwork() {
  const profile = loadProfile();
  const next = {
    ...DEFAULT,
    deviceId: profile.deviceId,
    deviceName: profile.deviceName,
    privateKey: profile.privateKey,
    publicKey: profile.publicKey,
    createdAt: profile.createdAt,
  };
  // New keys on every network change: the old public key is revoked server side.
  const pair = keypair();
  next.privateKey = pair.privateKey;
  next.publicKey = pair.publicKey;
  saveProfile(next);
  return next;
}

export function confPath(name = 'nurofen') {
  return path.join(ensureDir(confDir()), `${name}.conf`);
}

export function renderConfig(profile, port) {
  if (!profile.server || !profile.self || !profile.obfuscation) throw new Error('profile is not joined to a network');
  const o = profile.obfuscation;
  const endpoint = `${profile.server.host}:${port ?? profile.server.port}`;
  return [
    '# Nurofen profile (generated, do not edit)',
    '[Interface]',
    `PrivateKey = ${profile.privateKey}`,
    `Address = ${profile.self.ip}/24`,
    `MTU = ${profile.mtu || 1280}`,
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
    `PublicKey = ${profile.server.publicKey}`,
    `Endpoint = ${endpoint}`,
    `AllowedIPs = ${profile.network.subnet}`,
    `PersistentKeepalive = ${profile.keepalive || 25}`,
    '',
  ].join('\n');
}
