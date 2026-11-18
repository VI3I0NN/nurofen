import http from 'node:http';
import fs from 'node:fs';
import process from 'node:process';
import { applyServer, applyPortPool, awgStatus, dump, down, syncPeers } from './awg.js';
import { loadConfig, rootDir, stateFile, subnetInfo, writeConfig } from './config.js';
import {
  findNetwork,
  findPeerByToken,
  joinNetwork,
  peersOfNetwork,
  publicPeer,
  revokePeer,
  rotateInvite,
  setLanPort,
  touchPeer,
} from './network.js';
import { json, RateLimiter, readJson, safeEqual, text } from './util.js';
import { adminPage } from './admin-page.js';

const ROOT = rootDir();
let cfg = loadConfig(ROOT);
let cfgStamp = fileStamp();
const log = {
  info: (msg) => console.log(`${new Date().toISOString()} ${msg}`),
  warn: (msg) => console.warn(`${new Date().toISOString()} ${msg}`),
};

const joinLimiter = new RateLimiter(10, 60_000);
setInterval(() => joinLimiter.prune(), 60_000).unref?.();

function bearer(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : '';
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
}

/** Endpoint host: explicit config wins, otherwise whatever the client connected to. */
function endpointHost(req) {
  if (cfg.server.publicHost) return cfg.server.publicHost;
  const host = String(req.headers.host || '');
  return host.split(':')[0] || '127.0.0.1';
}

function save() {
  writeConfig(cfg, ROOT);
  cfgStamp = fileStamp();
}

function fileStamp() {
  try {
    return fs.statSync(stateFile(ROOT)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * The CLI edits nurofen.json behind our back. Without this the service would
 * save its stale in-memory copy on the next heartbeat and resurrect a peer the
 * admin just kicked.
 */
function refreshConfig() {
  const current = fileStamp();
  if (current && current !== cfgStamp) {
    cfg = loadConfig(ROOT);
    cfgStamp = current;
    log.info('[cfg] reloaded after external change');
  }
}

async function liveInfo() {
  return dump(cfg);
}

function peerView(req) {
  return {
    network: {
      id: cfg.networks[0].id,
      name: cfg.networks[0].name,
      subnet: subnetInfo(cfg).cidr,
    },
    invite: cfg.networks[0].invite,
    servers: [endpointHost(req)],
    ports: cfg.server.portPool,
    mtu: cfg.server.mtu,
    keepalive: cfg.server.keepalive,
    obfuscation: cfg.awg.obfuscation,
    serverPublicKey: cfg.awg.publicKey,
  };
}

async function handleJoin(req, res) {
  const ip = clientIp(req);
  if (!joinLimiter.check(ip)) {
    json(res, 429, { error: 'too_many_requests' });
    return;
  }
  const body = await readJson(req);
  const { network, peer, token } = joinNetwork(cfg, {
    invite: body.invite,
    name: body.deviceName,
    publicKey: body.publicKey,
    deviceId: body.deviceId,
  });
  save();
  await syncPeers(cfg, log);

  const live = await liveInfo();
  json(res, 200, {
    ...peerView(req),
    network: { id: network.id, name: network.name, subnet: subnetInfo(cfg).cidr },
    self: { id: peer.id, name: peer.name, ip: peer.ip },
    token,
    peers: peersOfNetwork(cfg, network.id).map((item) => ({
      ...publicPeer(item, live.peers.get(item.publicKey)),
      self: item.id === peer.id,
    })),
  });
}

async function handleState(req, res, peer) {
  const live = await liveInfo();
  json(res, 200, {
    ...peerView(req),
    self: { id: peer.id, name: peer.name, ip: peer.ip },
    peers: peersOfNetwork(cfg, peer.networkId).map((item) => ({
      ...publicPeer(item, live.peers.get(item.publicKey)),
      self: item.id === peer.id,
    })),
    tunnel: await awgStatus(cfg),
  });
}

async function handleHeartbeat(req, res, peer) {
  const body = await readJson(req);
  touchPeer(peer);
  setLanPort(peer, body?.lanPort ?? null);
  save();
  const live = await liveInfo();
  json(res, 200, {
    peers: peersOfNetwork(cfg, peer.networkId).map((item) => ({
      ...publicPeer(item, live.peers.get(item.publicKey)),
      self: item.id === peer.id,
    })),
  });
}

async function handleKey(req, res, peer) {
  const body = await readJson(req);
  const { isValidKey } = await import('./network.js');
  if (!isValidKey(body.publicKey)) {
    json(res, 400, { error: 'invalid_key' });
    return;
  }
  peer.publicKey = String(body.publicKey).trim();
  save();
  await syncPeers(cfg, log);
  json(res, 200, { ok: true });
}

async function handleLeave(req, res, peer) {
  revokePeer(cfg, peer.id);
  save();
  await syncPeers(cfg, log);
  json(res, 200, { ok: true });
}

function requireAdmin(req, res) {
  if (!safeEqual(bearer(req), cfg.adminToken)) {
    json(res, 401, { error: 'unauthorized' });
    return false;
  }
  return true;
}

async function handleAdminOverview(req, res) {
  if (!requireAdmin(req, res)) return;
  const live = await liveInfo();
  json(res, 200, {
    network: cfg.networks[0],
    invite: cfg.networks[0].invite,
    subnet: subnetInfo(cfg).cidr,
    server: {
      publicHost: cfg.server.publicHost || endpointHost(req),
      awgPort: cfg.server.awgPort,
      ports: cfg.server.portPool,
      mtu: cfg.server.mtu,
      iface: cfg.server.interface,
    },
    obfuscation: cfg.awg.obfuscation,
    awg: await awgStatus(cfg),
    peers: cfg.peers
      .filter((peer) => !peer.revoked)
      .map((peer) => ({ ...publicPeer(peer, live.peers.get(peer.publicKey)), deviceId: peer.deviceId })),
  });
}

async function handleAdminRotate(req, res) {
  if (!requireAdmin(req, res)) return;
  const network = rotateInvite(cfg, cfg.networks[0].id);
  save();
  json(res, 200, { invite: network.invite });
}

async function handleAdminKick(req, res, peerId) {
  if (!requireAdmin(req, res)) return;
  const peer = revokePeer(cfg, peerId);
  if (!peer) {
    json(res, 404, { error: 'not_found' });
    return;
  }
  save();
  await syncPeers(cfg, log);
  json(res, 200, { ok: true });
}

async function handleAdminRestart(req, res) {
  if (!requireAdmin(req, res)) return;
  await down(cfg, log);
  const result = await applyServer(cfg, log);
  json(res, 200, { ok: true, result });
}

const routes = [
  ['GET', '/healthz', async (req, res) => json(res, 200, { ok: true, service: 'nurofen' })],

  ['POST', '/api/v1/join', handleJoin],

  ['GET', '/api/v1/state', async (req, res, peer) => handleState(req, res, peer)],
  ['POST', '/api/v1/heartbeat', async (req, res, peer) => handleHeartbeat(req, res, peer)],
  ['POST', '/api/v1/key', async (req, res, peer) => handleKey(req, res, peer)],
  ['POST', '/api/v1/leave', async (req, res, peer) => handleLeave(req, res, peer)],

  ['GET', '/api/v1/admin/overview', handleAdminOverview],
  ['POST', '/api/v1/admin/invite/rotate', handleAdminRotate],
  ['DELETE', '/api/v1/admin/peers/:id', async (req, res, params) => handleAdminKick(req, res, params.id)],
  ['POST', '/api/v1/admin/awg/restart', handleAdminRestart],

  ['GET', '/admin', async (req, res) => text(res, 200, adminPage, 'text/html; charset=utf-8')],
  ['GET', '/', async (req, res) => {
    res.writeHead(302, { location: '/admin' });
    res.end();
  }],
];

function matchRoute(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const [routeMethod, pattern, handler] of routes) {
    if (routeMethod !== method) continue;
    const patternParts = pattern.split('/').filter(Boolean);
    if (patternParts.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < patternParts.length; i += 1) {
      const expected = patternParts[i];
      if (expected.startsWith(':')) {
        params[expected.slice(1)] = decodeURIComponent(parts[i]);
      } else if (expected !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler, params };
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  refreshConfig();
  const route = matchRoute(req.method, url.pathname);
  if (!route) {
    json(res, 404, { error: 'not_found' });
    return;
  }

  const publicRoutes = new Set(['/healthz', '/api/v1/join', '/admin', '/']);
  try {
    if (!publicRoutes.has(url.pathname) && !url.pathname.startsWith('/api/v1/admin/')) {
      const peer = findPeerByToken(cfg, bearer(req));
      if (!peer) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      await route.handler(req, res, peer);
      return;
    }
    await route.handler(req, res, route.params);
  } catch (error) {
    log.warn(`[http] ${req.method} ${url.pathname} -> ${error.status || 500}: ${error.message}`);
    if (!res.headersSent) json(res, error.status || 500, { error: error.code || 'internal_error' });
  }
});

async function bootstrap() {
  log.info(`[nurofen] root: ${ROOT}`);
  log.info(`[nurofen] network: ${cfg.networks[0].name} ${subnetInfo(cfg).cidr}`);
  log.info(`[nurofen] invite code: ${cfg.networks[0].invite}`);
  if (!cfg.server.publicHost) {
    log.warn('[nurofen] server.publicHost is empty - clients will use the address they connected to');
  }
  await applyServer(cfg, log);
  await applyPortPool(cfg, log);

  const port = Number(process.env.NUROFEN_API_PORT || cfg.server.apiPort || 8787);
  const host = process.env.NUROFEN_API_HOST || cfg.server.apiHost || '0.0.0.0';
  server.listen(port, host, () => {
    log.info(`[nurofen] api listening on http://${host}:${port}`);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.info(`[nurofen] ${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref?.();
  });
}

bootstrap().catch((error) => {
  console.error('[nurofen] fatal:', error);
  process.exit(1);
});
