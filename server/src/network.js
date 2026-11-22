import { MAX_NETWORKS, networkSubnet, subnetForIndex, subnetIndex } from './config.js';
import {
  cleanNetworkName,
  guessIpv4,
  hashPassword,
  hashToken,
  id,
  isValidKey,
  networkKey,
  nowIso,
  token,
  verifyPassword,
} from './util.js';

export { isValidKey };

export const ONLINE_WINDOW_MS = 20 * 1000;
export const MIN_PASSWORD_LENGTH = 4;
export const MAX_PASSWORD_LENGTH = 64;

function fail(status, code) {  const error = new Error(code.replace(/_/g, ' '));
  error.status = status;
  error.code = code;
  return error;
}

export function findNetworkById(cfg, networkId) {
  return cfg.networks.find((net) => net.id === networkId) || null;
}

export function findNetworkByName(cfg, name) {
  const wanted = networkKey(name);
  if (!wanted) return null;
  return cfg.networks.find((net) => net.nameKey === wanted) || null;
}

export function networkForPeer(cfg, peer) {
  return peer ? findNetworkById(cfg, peer.networkId) : null;
}

export function findPeerByToken(cfg, bearer) {
  if (!bearer) return null;
  const hash = hashToken(bearer);
  return cfg.peers.find((peer) => !peer.revoked && peer.tokenHash === hash) || null;
}

function usedSubnetIndexes(cfg) {
  const used = new Set();
  for (const net of cfg.networks) {
    const index = subnetIndex(net.subnet);
    if (index !== null) used.add(index);
  }
  return used;
}

function nextFreeSubnet(cfg) {
  const used = usedSubnetIndexes(cfg);
  for (let index = 0; index <= 254; index += 1) {
    if (!used.has(index)) return subnetForIndex(index);
  }
  return null;
}

/** Free address inside one network: the hub plus every live peer counts. */
function usedIps(cfg, network) {
  const net = networkSubnet(network);
  const used = new Set([net.serverIp]);
  for (const peer of cfg.peers) {
    if (!peer.revoked && peer.networkId === network.id) used.add(peer.ip);
  }
  return used;
}

function allocateIp(cfg, network) {
  const net = networkSubnet(network);
  const used = usedIps(cfg, network);
  for (let last = net.firstClient; last <= net.lastClient; last += 1) {
    const candidate = `${net.network.split('.').slice(0, 3).join('.')}.${last}`;
    if (!used.has(candidate)) return candidate;
  }
  return null;
}

export function cleanName(value, fallback = 'device') {
  const name = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 32);
  return name || fallback;
}

export function setNetworkPassword(network, password) {
  if (!network) return null;
  const hashed = hashPassword(password);
  network.passwordSalt = hashed.salt;
  network.passwordHash = hashed.hash;
  network.passwordUpdatedAt = nowIso();
  return network;
}

export function validatePassword(password) {
  const value = String(password ?? '').trim();
  if (!value) throw fail(400, 'password_required');
  if (value.length < MIN_PASSWORD_LENGTH) throw fail(400, 'password_too_short');
  if (value.length > MAX_PASSWORD_LENGTH) throw fail(400, 'password_too_long');
  return value;
}

/**
 * Creates a network owned by the caller. Names are unique case-insensitively,
 * passwords are stored as scrypt hashes only.
 */
export function createNetwork(cfg, { name, password }) {
  const displayName = cleanNetworkName(name);
  if (!displayName) throw fail(400, 'network_name_required');
  if (displayName.length < 2) throw fail(400, 'invalid_network_name');
  const key = networkKey(displayName);
  if (cfg.networks.some((net) => net.nameKey === key)) throw fail(409, 'network_exists');
  if (cfg.networks.length >= MAX_NETWORKS) throw fail(409, 'too_many_networks');

  const subnet = nextFreeSubnet(cfg);
  if (!subnet) throw fail(409, 'too_many_networks');

  const plain = validatePassword(password);
  const hashed = hashPassword(plain);
  const network = {
    id: id(),
    name: displayName,
    nameKey: key,
    subnet,
    passwordSalt: hashed.salt,
    passwordHash: hashed.hash,
    createdAt: nowIso(),
    passwordUpdatedAt: nowIso(),
  };
  cfg.networks.push(network);
  return network;
}

/**
 * Radmin-style join: one server, many user-created networks, credentials are
 * the network name plus its password. No invitation codes are used.
 */
export function joinNetwork(cfg, { mode, name, password, deviceName, publicKey, deviceId }) {
  if (!isValidKey(publicKey)) throw fail(400, 'invalid_key');

  let network;
  let created = false;
  if (mode === 'create') {
    network = createNetwork(cfg, { name, password });
    created = true;
  } else {
    const displayName = cleanNetworkName(name);
    if (!displayName) throw fail(400, 'network_name_required');
    network = findNetworkByName(cfg, displayName);
    if (!network) throw fail(404, 'network_not_found');
    const plain = validatePassword(password);
    if (!verifyPassword(plain, network.passwordSalt, network.passwordHash)) throw fail(403, 'bad_password');
  }

  const peer = attachPeer(cfg, network, { name: deviceName, publicKey, deviceId });
  return { network, peer, token: peer._plainToken, created };
}

function attachPeer(cfg, network, { name, publicKey, deviceId }) {
  const publicKeyValue = publicKey.trim();
  const device = String(deviceId || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
  const plainToken = token(32);

  let peer = device ? cfg.peers.find((item) => item.deviceId === device && !item.revoked) : null;
  if (!peer) {
    // Same key re-joining from a fresh install: reuse the slot instead of
    // creating a duplicate peer that shares the tunnel.
    peer = cfg.peers.find((item) => item.publicKey === publicKeyValue && !item.revoked) || null;
  }

  if (peer) {
    if (peer.networkId !== network.id) {
      // One device belongs to one network at a time. Moving it frees the old
      // address and gives it an address inside the new /24.
      const ip = allocateIp(cfg, network);
      if (!ip) throw fail(409, 'network_full');
      peer.ip = ip;
      peer.networkId = network.id;
      peer.lanPort = null;
      peer.lanSeen = null;
    }
    peer.publicKey = publicKeyValue;
    peer.name = cleanName(name, peer.name);
    peer.tokenHash = hashToken(plainToken);
    peer.lastSeen = nowIso();
    peer.updatedAt = nowIso();
    if (device) peer.deviceId = device;
  } else {
    const ip = allocateIp(cfg, network);
    if (!ip) throw fail(409, 'network_full');
    peer = {
      id: id(),
      networkId: network.id,
      deviceId: device || null,
      name: cleanName(name),
      publicKey: publicKeyValue,
      ip,
      tokenHash: hashToken(plainToken),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastSeen: nowIso(),
      revoked: false,
    };
    cfg.peers.push(peer);
  }

  // Returned to the HTTP layer only; never persisted in plain form.
  Object.defineProperty(peer, '_plainToken', {
    value: plainToken,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return peer;
}

/** Adds one more device to an existing network, authorized by the caller's token. */
export function addDevice(cfg, network, { name, publicKey }) {
  if (!isValidKey(publicKey)) throw fail(400, 'invalid_key');
  return attachPeer(cfg, network, { name, publicKey, deviceId: null });
}

export function touchPeer(peer) {
  peer.lastSeen = nowIso();
  peer.offline = false;
}

/** Shows the peer as offline right away instead of waiting for the timeout. */
export function markOffline(peer) {
  peer.offline = true;
  peer.lastSeen = new Date(Date.now() - ONLINE_WINDOW_MS - 5000).toISOString();
  return peer;
}

/** Renames the caller's own device inside its network. */
export function renamePeer(peer, value) {
  const name = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 32);
  if (name.length < 2) throw fail(400, 'bad_name');
  peer.name = name;
  peer.updatedAt = nowIso();
  return peer;
}

/** LAN worlds live in an ephemeral port; null means "world is closed". */
export function isValidLanPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 1024 && port < 65536;
}

export function setLanPort(peer, value) {
  if (value === null || value === undefined || value === '') {
    if (peer.lanPort) {
      peer.lanPort = null;
      peer.lanSeen = null;
    }
    return;
  }
  if (!isValidLanPort(value)) return;
  peer.lanPort = Number(value);
  peer.lanSeen = nowIso();
}

const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;

/**
 * Beta P2P helpers: where the device listens for a direct tunnel and which
 * private addresses it can be reached on. Only peers that enabled the mode and
 * sit behind the same public IP receive these values.
 */
export function setDirectInfo(peer, { port, ips } = {}) {
  const value = Number(port);
  peer.directPort = Number.isInteger(value) && value > 0 && value < 65536 ? value : null;
  const list = Array.isArray(ips) ? ips : [];
  peer.directIps = [...new Set(list.map((item) => guessIpv4(item)).filter((ip) => (
    ip && PRIVATE_IPV4.test(ip) && !ip.startsWith('10.66.')
  )))].slice(0, 4);
}

/**
 * Build versions reported by the device. A helper older than the app means the
 * background service was not restarted after an update, which is the usual
 * reason a direct channel never comes up on that side.
 */
export function setBuildInfo(peer, { helperVersion, clientVersion } = {}) {
  const clean = (value) => {
    const text = String(value || '').trim().slice(0, 24);
    return /^\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]+)?$/.test(text) ? text : null;
  };
  peer.helperVersion = clean(helperVersion);
  peer.clientVersion = clean(clientVersion);
}

export function revokePeer(cfg, peerId) {
  const peer = cfg.peers.find((item) => item.id === peerId);
  if (!peer) return null;
  peer.revoked = true;
  peer.updatedAt = nowIso();
  return peer;
}

/** Removes a network and revokes every device that lived in it. */
export function deleteNetwork(cfg, networkId) {
  const network = findNetworkById(cfg, networkId);
  if (!network) return null;
  for (const peer of cfg.peers) {
    if (peer.networkId === networkId && !peer.revoked) {
      peer.revoked = true;
      peer.updatedAt = nowIso();
    }
  }
  cfg.networks = cfg.networks.filter((item) => item.id !== networkId);
  return network;
}

export function publicPeer(peer, live = null, options = {}) {
  const handshake = live?.latestHandshake ? Date.now() - live.latestHandshake : Infinity;
  const beat = peer.lastSeen ? Date.now() - Date.parse(peer.lastSeen) : Infinity;
  const online = !peer.offline && (handshake < ONLINE_WINDOW_MS || beat < ONLINE_WINDOW_MS);
  const direct = Boolean(peer.direct);
  const expose = options.admin === true || direct;
  const sameNat = expose && options.sameNat === true && direct;
  // Two devices behind one router cannot reach each other's public address
  // (hairpin NAT). Older clients blindly add `endpoint` as a last direct
  // candidate, so for them the endpoint is the LAN address itself; otherwise a
  // working LAN link gets replaced by a dead public one.
  const observedPort = String(live?.endpoint || '').split(':').pop();
  const lanPort = /^\d+$/.test(observedPort) ? observedPort : (peer.directPort || '');
  const lanEndpoint = sameNat && (peer.directIps || []).length && lanPort
    ? `${peer.directIps[0]}:${lanPort}`
    : null;
  return {
    id: peer.id,
    name: peer.name,
    ip: peer.ip,
    online,
    lastSeen: peer.lastSeen || null,
    rx: live?.rx ?? null,
    tx: live?.tx ?? null,
    endpoint: expose ? (lanEndpoint || live?.endpoint || null) : null,
    publicKey: expose ? (peer.publicKey || null) : null,
    direct,
    sameNat,
    directIps: sameNat ? (peer.directIps || []) : [],
    directPort: sameNat ? (peer.directPort || null) : null,
    helperVersion: expose ? (peer.helperVersion || null) : null,
    clientVersion: expose ? (peer.clientVersion || null) : null,
    lanPort: peer.lanPort || null,
  };
}

export function peersOfNetwork(cfg, networkId) {
  return cfg.peers.filter((peer) => !peer.revoked && peer.networkId === networkId);
}

export function publicNetwork(cfg, network) {
  return {
    id: network.id,
    name: network.name,
    subnet: network.subnet,
    createdAt: network.createdAt || null,
    passwordUpdatedAt: network.passwordUpdatedAt || null,
    peers: peersOfNetwork(cfg, network.id).length,
  };
}
