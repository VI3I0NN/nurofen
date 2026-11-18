import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TUNNEL_NAME, UI_PORT, dataDir, ensureDir, findAwg, logFile } from './paths.js';
import {
  forgetNetwork,
  initProfile,
  keypair,
  loadProfile,
  renderConfig,
  saveProfile,
} from './profile.js';
import {
  defaultServerUrl,
  heartbeat,
  join,
  leave,
  normalizeServer,
  state as fetchState,
} from './api.js';
import { helperAlive, ping, tunnelDown, tunnelStatus, tunnelUp } from './tunnel.js';
import { detectLanPort } from './minecraft.js';
import { minecraftInstalled, upsertServer } from './servers.js';
import { startHelper } from './helper.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(HERE, 'ui');
const NO_WINDOW = process.argv.includes('--no-window');
const FORCE_HELPER = process.argv.includes('--helper');

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  process.stdout.write(`${line}\n`);
  try {
    ensureDir(dataDir());
    fs.appendFileSync(logFile(), `${line}\n`);
  } catch {
    // never crash because of logging
  }
}

const ui = {
  status: 'idle',
  error: null,
  port: null,
  tunnel: { exists: false, up: false, ip: null },
  peers: [],
  pings: {},
  minecraft: null,
  helper: false,
  awg: false,
  connectedAt: null,
  logTail: [],
};

let connecting = false;
let abortConnect = false;
let heartbeatTimer = null;
let tickTimer = null;
let downTicks = 0;
let idleTicks = 0;

function profile() {
  return loadProfile();
}

function joined(p) {
  return Boolean(p.token && p.serverUrl && p.server && p.self);
}

function hubIp(p) {
  const subnet = String(p.network?.subnet || '10.66.0.0/24').split('/')[0];
  const parts = subnet.split('.');
  return `${parts[0]}.${parts[1]}.${parts[2]}.1`;
}

function candidatePorts(p) {
  const pool = Array.isArray(p.server?.ports) && p.server.ports.length ? p.server.ports : [p.server?.port].filter(Boolean);
  const ordered = [p.lastPort, ...pool].filter((value) => Number.isInteger(value) && value > 0);
  return [...new Set(ordered)];
}

function pushLog(level, message) {
  ui.logTail.push({ at: new Date().toISOString(), level, message });
  if (ui.logTail.length > 60) ui.logTail.shift();
}

async function refreshTunnelState() {
  const status = await tunnelStatus(TUNNEL_NAME);
  ui.tunnel = status;
  return status;
}

async function waitForTunnel(p, port, timeoutMs = 9000) {
  const deadline = Date.now() + timeoutMs;
  const hub = hubIp(p);
  while (Date.now() < deadline) {
    const status = await tunnelStatus(TUNNEL_NAME);
    if (status.up) {
      const probe = await ping(hub, 800);
      if (probe.ok) return { ok: true, status };
    }
    await sleep(700);
  }
  return { ok: false };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect() {
  if (connecting || ui.status === 'connected') return { ok: true };
  const p = profile();
  if (!joined(p)) {
    ui.status = 'error';
    ui.error = 'no_network';
    return { ok: false, error: 'no_network' };
  }
  connecting = true;
  abortConnect = false;
  ui.status = 'connecting';
  ui.error = null;
  pushLog('info', 'подключение…');

  try {
    if (!findAwg()) {
      ui.helper = await helperAlive();
      if (ui.helper) {
        pushLog('info', 'устанавливаю AmneziaWG…');
        await fetch(`http://127.0.0.1:39394/awg/install`, {
          method: 'POST',
          headers: { authorization: `Bearer ${readHelperTokenSafe()}` },
          signal: AbortSignal.timeout(180000),
        }).catch(() => {});
      }
    }
    if (!findAwg()) throw new Error('awg_missing');

    let lastError = null;
    for (const port of candidatePorts(p)) {
      if (abortConnect) return { ok: false, error: 'cancelled' };
      pushLog('info', `пробую udp/${port}`);
      try {
        const conf = renderConfig(p, port);
        await tunnelUp(conf, TUNNEL_NAME);
      } catch (error) {
        lastError = error;
        pushLog('warn', `udp/${port}: ${error.message}`);
        await tunnelDown(TUNNEL_NAME).catch(() => {});
        continue;
      }
      const probe = await waitForTunnel(p, port);
      if (probe.ok) {
        const fresh = profile();
        fresh.lastPort = port;
        saveProfile(fresh);
        ui.port = port;
        ui.status = 'connected';
        ui.connectedAt = new Date().toISOString();
        ui.tunnel = probe.status;
        downTicks = 0;
        pushLog('ok', `туннель поднят на udp/${port}`);
        startHeartbeat();
        await refreshPeers();
        return { ok: true, port };
      }
      pushLog('warn', `udp/${port}: нет ответа, пробую следующий порт`);
      await tunnelDown(TUNNEL_NAME).catch(() => {});
      lastError = new Error(`no_handshake_${port}`);
    }
    throw lastError || new Error('cannot_connect');
  } catch (error) {
    ui.status = 'error';
    ui.error = friendlyError(error.message);
    pushLog('error', ui.error);
    return { ok: false, error: ui.error };
  } finally {
    connecting = false;
  }
}

function readHelperTokenSafe() {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return fs.readFileSync(path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Nurofen', 'helper-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

function friendlyError(code) {
  const map = {
    awg_missing: 'AmneziaWG не установлен. Запустите install.ps1 от администратора.',
    no_network: 'Сначала подключитесь к сети по коду приглашения.',
    invite_not_found: 'Код приглашения неверный или устарел.',
    too_many_requests: 'Слишком много попыток. Подождите минуту.',
    network_full: 'В сети закончились свободные адреса.',
  };
  if (map[code]) return map[code];
  if (/elevat|access is denied|отказано/i.test(code)) {
    return 'Нужны права администратора: запустите install.ps1 (он ставит службу-помощник).';
  }
  if (/^no_handshake/.test(code)) return 'Сервер не отвечает ни на одном порту. Проверьте, что VPS доступен.';
  return code;
}

async function disconnect() {
  abortConnect = true;
  stopHeartbeat();
  try {
    await tunnelDown(TUNNEL_NAME);
  } catch (error) {
    pushLog('warn', `down: ${error.message}`);
  }
  ui.status = 'idle';
  ui.port = null;
  ui.connectedAt = null;
  ui.tunnel = { exists: false, up: false, ip: null };
  pushLog('info', 'отключено');
  return { ok: true };
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    refreshPeers().catch(() => {});
  }, 5000);
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function refreshPeers() {
  const p = profile();
  if (!joined(p)) return;
  try {
    const data = await heartbeat(p, { lanPort: ui.minecraft?.port ?? null });
    if (data?.peers) ui.peers = data.peers;
  } catch (error) {
    if (ui.status === 'connected') pushLog('warn', `связь с сервером: ${error.message}`);
  }
}

async function pingPeers() {
  const p = profile();
  const targets = ui.peers.filter((peer) => !peer.self && peer.ip).slice(0, 12);
  const results = {};
  const queue = [...targets];
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) {
      const peer = queue.shift();
      const result = await ping(peer.ip, 700);
      results[peer.ip] = result.ok ? result.ms : null;
    }
  });
  await Promise.all(workers);
  ui.pings = { ...ui.pings, ...results };
  // Drop stale entries so the UI does not show ghosts.
  for (const key of Object.keys(ui.pings)) {
    if (!targets.some((peer) => peer.ip === key)) delete ui.pings[key];
  }
}

async function tick() {
  const p = profile();
  const previous = ui.tunnel;
  await refreshTunnelState().catch(() => {});

  if (ui.status === 'connected') {
    if (ui.tunnel.up) {
      downTicks = 0;
    } else if (ui.tunnel.exists || previous.up) {
      downTicks += 1;
      if (downTicks >= 2) {
        pushLog('warn', 'туннель отвалился, переподключаюсь');
        ui.status = 'idle';
        ui.error = null;
        downTicks = 0;
        await connect();
      }
    }
  }

  if (joined(p)) {
    ui.minecraft = detectLanPort();
    if (ui.status === 'connected') {
      await pingPeers();
    } else {
      // Keep the friends list fresh even while the tunnel is down.
      idleTicks += 1;
      if (idleTicks % 5 === 0) await refreshPeers();
    }
  }
}

async function joinNetwork({ serverUrl, invite, name }) {
  const base = normalizeServer(serverUrl || defaultServerUrl());
  if (!base) throw new Error('server_required');
  if (!String(invite || '').trim()) throw new Error('invite_required');

  const local = initProfile(name);
  const response = await join({
    serverUrl: base,
    invite: invite.trim().toUpperCase(),
    deviceName: local.deviceName,
    publicKey: local.publicKey,
    deviceId: local.deviceId,
  });

  const next = loadProfile();
  next.serverUrl = base;
  next.token = response.token;
  next.network = response.network;
  next.self = response.self;
  next.server = {
    host: response.servers?.[0] || base.replace(/^https?:\/\//, '').split(':')[0],
    port: response.ports?.[0] || 51820,
    ports: response.ports || [],
    publicKey: response.serverPublicKey,
  };
  next.obfuscation = response.obfuscation;
  next.mtu = response.mtu || 1280;
  next.keepalive = response.keepalive || 25;
  next.invite = response.invite || String(invite).trim().toUpperCase();
  next.deviceName = response.self.name;
  next.lastPort = null;
  saveProfile(next);
  ui.peers = response.peers || [];
  ui.status = 'idle';
  ui.error = null;
  pushLog('ok', `вошёл в сеть «${response.network.name}» как ${response.self.ip}`);
  return { ok: true, self: response.self };
}

function snapshot() {
  const p = profile();
  return {
    profile: {
      joined: joined(p),
      deviceName: p.deviceName,
      serverUrl: p.serverUrl || defaultServerUrl(),
      network: p.network,
      self: p.self,
      invite: p.invite || null,
      mtu: p.mtu || 1280,
      server: p.server ? { host: p.server.host, ports: p.server.ports } : null,
    },
    status: ui.status,
    error: ui.error,
    port: ui.port,
    tunnel: ui.tunnel,
    peers: ui.peers,
    pings: ui.pings,
    minecraft: ui.minecraft,
    minecraftInstalled: minecraftInstalled(),
    helper: ui.helper,
    awg: Boolean(findAwg()),
    connectedAt: ui.connectedAt,
    log: ui.logTail.slice(-14),
    version: '0.1.0',
  };
}

// -------------------------------------------------------------------------- ui server

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (url.pathname === '/api/status') {
    json(res, 200, snapshot());
    return;
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const body = await readBody(req);
    try {
      switch (url.pathname) {
        case '/api/join':
          json(res, 200, await joinNetwork(body));
          return;
        case '/api/connect':
          json(res, 200, await connect());
          return;
        case '/api/disconnect':
          json(res, 200, await disconnect());
          return;
        case '/api/forget': {
          await disconnect();
          const p = profile();
          await leave(p).catch(() => {});
          forgetNetwork();
          ui.peers = [];
          json(res, 200, { ok: true });
          return;
        }
        case '/api/quit':
          await disconnect();
          json(res, 200, { ok: true });
          setTimeout(() => process.exit(0), 150);
          return;
        case '/api/window':
          openWindow();
          json(res, 200, { ok: true });
          return;
        case '/api/minecraft/add': {
          const address = String(body.ip || '').trim();
          if (!/^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(address)) throw new Error('bad_address');
          const result = upsertServer({ name: body.name, ip: address });
          pushLog('ok', `мир добавлен в список серверов: ${result.name}`);
          json(res, 200, result);
          return;
        }
        case '/api/export-device': {          const p = profile();
          if (!p.invite || !joined(p)) throw new Error('no_network');
          const pair = keypair();
          const deviceName = String(body.name || `${p.deviceName}-phone`).slice(0, 32).trim();
          const created = await join({
            serverUrl: p.serverUrl,
            invite: p.invite,
            deviceName,
            publicKey: pair.publicKey,
          });
          const temp = {
            ...p,
            privateKey: pair.privateKey,
            publicKey: pair.publicKey,
            self: created.self,
            network: created.network,
            obfuscation: created.obfuscation,
            mtu: created.mtu || p.mtu,
            keepalive: created.keepalive || p.keepalive,
            server: {
              host: created.servers?.[0],
              port: created.ports?.[0],
              ports: created.ports,
              publicKey: created.serverPublicKey,
            },
          };
          json(res, 200, {
            ok: true,
            ip: created.self.ip,
            name: deviceName,
            config: renderConfig(temp, created.ports?.[0]),
          });
          return;
        }
        case '/api/action': {
          if (body.name === 'toggle') {
            json(res, 200, ui.status === 'connected' ? await disconnect() : await connect());
            return;
          }
          json(res, 200, { ok: true });
          return;
        }
        default:
          json(res, 404, { error: 'not_found' });
          return;
      }
    } catch (error) {
      json(res, 200, { ok: false, error: friendlyError(error.message) });
      return;
    }
  }

  const filePath = url.pathname === '/' ? path.join(UI_DIR, 'index.html') : path.join(UI_DIR, url.pathname);
  if (!filePath.startsWith(UI_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    log('[ui] already running, opening the existing window');
    openWindow();
    setTimeout(() => process.exit(0), 800);
    return;
  }
  log(`[ui] ${error.message}`);
});

function browserPath() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

function openWindow() {
  const url = `http://127.0.0.1:${UI_PORT}/`;
  const browser = browserPath();
  if (browser) {
    spawn(
      browser,
      [
        `--app=${url}`,
        '--window-size=1020,720',
        `--user-data-dir=${path.join(dataDir(), 'window')}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate',
      ],
      { detached: true, stdio: 'ignore' },
    ).unref();
    return;
  }
  spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref();
}

function startTray() {
  const script = path.join(HERE, 'tray.ps1');
  const icon = path.join(HERE, '..', 'assets', 'nurofen.ico');
  if (!fs.existsSync(script)) return;
  spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-Port', String(UI_PORT), '-Icon', icon],
    { detached: true, stdio: 'ignore', windowsHide: true },
  ).unref();
}

async function main() {
  if (FORCE_HELPER) {
    startHelper();
    return;
  }

  ensureDir(dataDir());
  const p = profile();
  log(`[app] starting, joined=${joined(p)} profile=${dataDir()}`);

  ui.helper = await helperAlive();
  ui.awg = Boolean(findAwg());
  pushLog('info', ui.helper ? 'служба-помощник на связи' : 'служба-помощник не запущена');
  if (!ui.awg) pushLog('warn', 'AmneziaWG не найден');
  if (joined(p)) refreshPeers().catch(() => {});

  server.listen(UI_PORT, '127.0.0.1', () => {
    log(`[ui] http://127.0.0.1:${UI_PORT}`);
    if (!NO_WINDOW) openWindow();
    startTray();
  });

  tickTimer = setInterval(() => {
    tick().catch((error) => log(`[tick] ${error.message}`));
  }, 2000);
  tick().catch(() => {});

  // Auto-reconnect on start if the tunnel is supposed to be up.
  if (joined(p) && p.lastPort) {
    setTimeout(() => {
      connect().catch(() => {});
    }, 1200);
  }

  process.on('SIGINT', () => {
    disconnect().finally(() => process.exit(0));
  });
}

main().catch((error) => {
  log(`[fatal] ${error.stack || error.message}`);
  process.exit(1);
});
