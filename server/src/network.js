import { subnetInfo } from './config.js';
import { hashToken, id, inviteCode, normalizeCode, nowIso, token } from './util.js';

export const ONLINE_WINDOW_MS = 3 * 60 * 1000;

const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

export function isValidKey(value) {
  return typeof value === 'string' && KEY_RE.test(value.trim()) && Buffer.from(value.trim(), 'base64').length === 32;
}

export function findNetwork(cfg, invite) {
  const wanted = normalizeCode(invite);
  if (!wanted) return null;
  return cfg.networks.find((net) => normalizeCode(net.invite) === wanted) || null;
}

export function findPeerByToken(cfg, bearer) {
  if (!bearer) return null;
  const hash = hashToken(bearer);
  return cfg.peers.find((peer) => !peer.revoked && peer.tokenHash === hash) || null;
}

function usedIps(cfg) {
  const net = subnetInfo(cfg);
  const used = new Set([net.serverIp]);
  for (const peer of cfg.peers) {
    if (!peer.revoked) used.add(peer.ip);
  }
  return used;
}

function allocateIp(cfg) {
  const net = subnetInfo(cfg);
  const used = usedIps(cfg);
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

/**
 * Registers a device in a network. Idempotent for the same deviceId, so a
 * client that lost its token can re-join without eating a new IP every time.
 */
export function joinNetwork(cfg, { invite, name, publicKey, deviceId }) {
  const network = findNetwork(cfg, invite);
  if (!network) {
    const error = new Error('invite not found');
    error.status = 404;
    error.code = 'invite_not_found';
    throw error;
  }
  if (!isValidKey(publicKey)) {
    const error = new Error('invalid public key');
    error.status = 400;
    error.code = 'invalid_key';
    throw error;
  }

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
    peer.publicKey = publicKeyValue;
    peer.name = cleanName(name, peer.name);
    peer.tokenHash = hashToken(plainToken);
    peer.lastSeen = nowIso();
    peer.updatedAt = nowIso();
    if (device) peer.deviceId = device;
    peer.networkId = network.id;
  } else {
    const ip = allocateIp(cfg);
    if (!ip) {
      const error = new Error('network is full');
      error.status = 409;
      error.code = 'network_full';
      throw error;
    }
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

  return { network, peer, token: plainToken };
}

export function touchPeer(peer) {
  peer.lastSeen = nowIso();
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

export function revokePeer(cfg, peerId) {
  const peer = cfg.peers.find((item) => item.id === peerId);
  if (!peer) return null;
  peer.revoked = true;
  peer.updatedAt = nowIso();
  return peer;
}

export function rotateInvite(cfg, networkId) {
  const network = cfg.networks.find((item) => item.id === networkId);
  if (!network) return null;
  network.invite = inviteCode();
  network.rotatedAt = nowIso();
  return network;
}

export function publicPeer(peer, live = null) {
  const handshake = live?.latestHandshake ? Date.now() - live.latestHandshake : Infinity;
  const beat = peer.lastSeen ? Date.now() - Date.parse(peer.lastSeen) : Infinity;
  const online = handshake < ONLINE_WINDOW_MS || beat < ONLINE_WINDOW_MS;
  return {
    id: peer.id,
    name: peer.name,
    ip: peer.ip,
    online,
    lastSeen: peer.lastSeen || null,
    rx: live?.rx ?? null,
    tx: live?.tx ?? null,
    endpoint: live?.endpoint || null,
    lanPort: peer.lanPort || null,
  };
}

export function peersOfNetwork(cfg, networkId) {
  return cfg.peers.filter((peer) => !peer.revoked && peer.networkId === networkId);
}
