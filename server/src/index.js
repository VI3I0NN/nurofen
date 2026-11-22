import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  applyIsolation,
  applyPortPool,
  applyServer,
  awgStatus,
  down,
  dump,
  syncAddresses,
  syncPeers,
} from './awg.js';
import { loadConfig, rootDir, stateFile, SUPERNET, writeConfig } from './config.js';
import {
  addDevice,
  createNetwork,
  deleteNetwork,
  findNetworkById,
  findPeerByToken,
  isValidKey,
  joinNetwork,
  markOffline,
  networkForPeer,
  peersOfNetwork,
  publicNetwork,
  publicPeer,
  renamePeer,
  revokePeer,
  setBuildInfo,
  setDirectInfo,
  setLanPort,
  setNetworkPassword,
  touchPeer,
  validatePassword,
} from './network.js';
import { json, RateLimiter, readJson, safeEqual, text } from './util.js';
import { adminPage } from './admin-page.js';
import { downloadPage } from './download-page.js';

const ROOT = rootDir();
let cfg = loadConfig(ROOT);
let cfgStamp = fileStamp();
const log = {
  info: (msg) => console.log(`${new Date().toISOString()} ${msg}`),
  warn: (msg) => console.warn(`${new Date().toISOString()} ${msg}`),
};

const joinLimiter = new RateLimiter(20, 60_000);
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

function networkView(network) {
  return network ? { id: network.id, name: network.name, subnet: network.subnet } : null;
}

/** Everything a client needs to build its tunnel; the same for every network. */
function serverView(req) {
  return {
    servers: [endpointHost(req)],
    ports: cfg.server.portPool,
    mtu: cfg.server.mtu,
    keepalive: cfg.server.keepalive,
    obfuscation: cfg.awg.obfuscation,
    serverPublicKey: cfg.awg.publicKey,
  };
}

function selfView(peer) {
  return { id: peer.id, name: peer.name, ip: peer.ip };
}

function peerList(peer) {
  const live = dumpCache;
  const ownHost = endpointHostOf(live.peers.get(peer.publicKey)?.endpoint);
  return peersOfNetwork(cfg, peer.networkId).map((item) => {
    const info = live.peers.get(item.publicKey);
    const sameNat = Boolean(ownHost) && item.id !== peer.id && endpointHostOf(info?.endpoint) === ownHost;
    return {
      ...publicPeer(item, info, { sameNat }),
      self: item.id === peer.id,
    };
  });
}

/** `1.2.3.4:51820` / `[2001:db8::1]:51820` -> host part. */
function endpointHostOf(value) {
  const textValue = String(value || '');
  if (!textValue) return '';
  if (textValue.startsWith('[')) {
    const end = textValue.indexOf(']');
    return end > 0 ? textValue.slice(1, end) : '';
  }
  const colon = textValue.lastIndexOf(':');
  return colon > 0 ? textValue.slice(0, colon) : textValue;
}

// dump() is async; handlers refresh this right before building a peer list.
let dumpCache = { available: false, peers: new Map() };

async function handleJoin(req, res) {
  const ip = clientIp(req);
  if (!joinLimiter.check(ip)) {
    json(res, 429, { error: 'too_many_requests' });
    return;
  }
  const body = await readJson(req);
  const { network, peer, token, created } = joinNetwork(cfg, {
    mode: body.mode === 'create' ? 'create' : 'join',
    name: body.name,
    password: body.password,
    deviceName: body.deviceName,
    publicKey: body.publicKey,
    deviceId: body.deviceId,
  });
  save();
  if (created) {
    await syncAddresses(cfg, log);
    await applyIsolation(cfg, log);
  }
  await syncPeers(cfg, log);

  dumpCache = await liveInfo();
  json(res, 200, {
    ...serverView(req),
    created,
    network: networkView(network),
    self: selfView(peer),
    token,
    peers: peerList(peer),
  });
}

async function handleState(req, res, peer) {
  dumpCache = await liveInfo();
  const network = networkForPeer(cfg, peer);
  json(res, 200, {
    ...serverView(req),
    network: networkView(network),
    self: selfView(peer),
    peers: peerList(peer),
    tunnel: await awgStatus(cfg),
  });
}

async function handleHeartbeat(req, res, peer) {
  const body = await readJson(req);
  touchPeer(peer);
  setLanPort(peer, body?.lanPort ?? null);
  peer.direct = body?.direct === true;
  setDirectInfo(peer, { port: body?.directPort, ips: body?.directIps });
  setBuildInfo(peer, { helperVersion: body?.helperVersion, clientVersion: body?.clientVersion });
  save();
  dumpCache = await liveInfo();
  json(res, 200, { peers: peerList(peer) });
}

async function handleRename(req, res, peer) {
  const body = await readJson(req);
  renamePeer(peer, body.name);
  save();
  json(res, 200, { ok: true, self: selfView(peer) });
}

async function handleOffline(req, res, peer) {
  markOffline(peer);
  save();
  json(res, 200, { ok: true });
}

async function handleKey(req, res, peer) {
  const body = await readJson(req);
  if (!isValidKey(body.publicKey)) {
    json(res, 400, { error: 'invalid_key' });
    return;
  }
  const value = String(body.publicKey).trim();
  const conflict = cfg.peers.find((item) => !item.revoked && item.id !== peer.id && item.publicKey === value);
  if (conflict) {
    json(res, 409, { error: 'key_in_use' });
    return;
  }
  peer.publicKey = value;
  save();
  await syncPeers(cfg, log);
  json(res, 200, { ok: true });
}

/** Another device for the caller's own network (kept for older clients). */
async function handleAddDevice(req, res, peer) {
  const body = await readJson(req);
  const network = networkForPeer(cfg, peer);
  if (!network) {
    json(res, 404, { error: 'network_not_found' });
    return;
  }
  const device = addDevice(cfg, network, {
    name: body.deviceName,
    publicKey: body.publicKey,
  });
  save();
  await syncPeers(cfg, log);
  json(res, 200, {
    ...serverView(req),
    network: networkView(network),
    self: selfView(device),
  });
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
  dumpCache = await liveInfo();
  json(res, 200, {
    networks: cfg.networks.map((network) => publicNetwork(cfg, network)),
    subnet: SUPERNET,
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
      .map((peer) => ({
        ...publicPeer(peer, dumpCache.peers.get(peer.publicKey), { admin: true }),
        deviceId: peer.deviceId,
        network: networkView(networkForPeer(cfg, peer)),
      })),
  });
}

async function handleAdminCreateNetwork(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = await readJson(req);
  const network = createNetwork(cfg, { name: body.name, password: body.password });
  save();
  await syncAddresses(cfg, log);
  await applyIsolation(cfg, log);
  json(res, 200, { network: publicNetwork(cfg, network) });
}

async function handleAdminDeleteNetwork(req, res, networkId) {
  if (!requireAdmin(req, res)) return;
  const network = deleteNetwork(cfg, networkId);
  if (!network) {
    json(res, 404, { error: 'not_found' });
    return;
  }
  save();
  await syncPeers(cfg, log);
  await syncAddresses(cfg, log);
  await applyIsolation(cfg, log);
  json(res, 200, { ok: true });
}

async function handleAdminPassword(req, res, networkId) {
  if (!requireAdmin(req, res)) return;
  const network = findNetworkById(cfg, networkId);
  if (!network) {
    json(res, 404, { error: 'not_found' });
    return;
  }
  const body = await readJson(req);
  const password = validatePassword(body.password);
  setNetworkPassword(network, password);
  save();
  json(res, 200, { ok: true });
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

/**
 * Prerequisites mirrored next to the app. Friends' installers fetch these
 * first: GitHub and nodejs.org are not always reachable where the users are.
 */
const DL_DIR = process.env.NUROFEN_DL_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dl');
const DL_FILES = {
  'node.zip': 'application/zip',
  'amneziawg.msi': 'application/x-msi',
  'NurofenSetup.exe': 'application/vnd.microsoft.portable-executable',
  'client.zip': 'application/zip',
};

function handleDownload(req, res, params) {  const type = DL_FILES[params.name];
  if (!type) {
    json(res, 404, { error: 'not_found' });
    return;
  }
  const file = path.join(DL_DIR, params.name);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) {
    json(res, 404, { error: 'not_mirrored' });
    return;
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'content-disposition': `attachment; filename="${params.name}"`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

/** Version manifest produced by tools/build-installer.ps1. */
function handleClientLatest(req, res) {
  const file = path.join(DL_DIR, 'client.json');
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) {
    json(res, 200, { version: null });
    return;
  }
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': stat.size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  fs.createReadStream(file).pipe(res);
}

const routes = [
  ['GET', '/healthz', async (req, res) => json(res, 200, { ok: true, service: 'nurofen' })],
  ['GET', '/dl/:name', async (req, res, params) => handleDownload(req, res, params)],
  ['GET', '/api/v1/client/latest', handleClientLatest],

  ['POST', '/api/v1/join', handleJoin],

  ['GET', '/api/v1/state', async (req, res, peer) => handleState(req, res, peer)],
  ['POST', '/api/v1/heartbeat', async (req, res, peer) => handleHeartbeat(req, res, peer)],
  ['POST', '/api/v1/rename', handleRename],
  ['POST', '/api/v1/offline', handleOffline],
  ['POST', '/api/v1/key', async (req, res, peer) => handleKey(req, res, peer)],
  ['POST', '/api/v1/devices', async (req, res, peer) => handleAddDevice(req, res, peer)],
  ['POST', '/api/v1/leave', async (req, res, peer) => handleLeave(req, res, peer)],

  ['GET', '/api/v1/admin/overview', handleAdminOverview],
  ['POST', '/api/v1/admin/networks', handleAdminCreateNetwork],
  ['DELETE', '/api/v1/admin/networks/:id', async (req, res, params) => handleAdminDeleteNetwork(req, res, params.id)],
  ['POST', '/api/v1/admin/networks/:id/password', async (req, res, params) => handleAdminPassword(req, res, params.id)],
  ['DELETE', '/api/v1/admin/peers/:id', async (req, res, params) => handleAdminKick(req, res, params.id)],
  ['POST', '/api/v1/admin/awg/restart', handleAdminRestart],

  ['GET', '/admin', async (req, res) => text(res, 200, adminPage, 'text/html; charset=utf-8')],
  ['GET', '/download', async (req, res) => text(res, 200, downloadPage, 'text/html; charset=utf-8')],
  ['GET', '/', async (req, res) => {
    res.writeHead(302, { location: '/download' });
    res.end();
  }],
];

function matchRoute(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const [routeMethod, pattern, handler] of routes) {
    // HEAD is answered by the GET handler; Node omits the body automatically.
    if (routeMethod !== method && !(method === 'HEAD' && routeMethod === 'GET')) continue;
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

  const publicRoutes = new Set(['/healthz', '/api/v1/join', '/api/v1/client/latest', '/admin', '/download', '/']);
  try {
    if (!publicRoutes.has(url.pathname) && !url.pathname.startsWith('/dl/') && !url.pathname.startsWith('/api/v1/admin/')) {
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
  log.info(`[nurofen] supernet: ${SUPERNET}, networks: ${cfg.networks.length}`);
  for (const network of cfg.networks) {
    log.info(`[nurofen] network "${network.name}" ${network.subnet}`);
  }
  if (!cfg.server.publicHost) {
    log.warn('[nurofen] server.publicHost is empty - clients will use the address they connected to');
  }
  await applyServer(cfg, log);
  await applyPortPool(cfg, log);
  await syncAddresses(cfg, log);
  await applyIsolation(cfg, log);

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
