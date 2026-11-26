import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  HELPER_PORT,
  TUNNEL_NAME,
  confDir,
  ensureDir,
  findAwg,
  findAwgCli,
  helperTokenFile,
  programDataDir,
} from './paths.js';
import { ensureAmneziawg, run, tunnelStatus } from './tunnel.js';

function logLine(...args) {
  const line = `${new Date().toISOString()} ${args.join(' ')}`;
  try {
    ensureDir(path.join(programDataDir(), 'Nurofen'));
    fs.appendFileSync(path.join(programDataDir(), 'Nurofen', 'helper.log'), `${line}\n`);
  } catch {
    // logging must never break the helper
  }
  console.log(line);
}

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Version currently written on disk, which may be newer than this process. */
function diskVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || '';
  } catch {
    return '';
  }
}

let restarting = false;

/**
 * The helper runs as SYSTEM from the same files as the app. An update replaces
 * those files but the old code stays in memory, so the helper re-execs itself
 * from disk. The new process retries the port until the old one has exited.
 */
function restartSelf(reason) {
  if (restarting) return;
  restarting = true;
  logLine(`restart: ${reason}`);
  try {
    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (error) {
    restarting = false;
    logLine(`restart failed: ${error.message}`);
    return;
  }
  setTimeout(() => process.exit(0), 250);
}

function token() {
  const file = helperTokenFile();
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // create below
  }
  ensureDir(path.dirname(file));
  const value = randomBytes(32).toString('base64url');
  fs.writeFileSync(file, value, { mode: 0o600 });
  return value;
}

function authorized(req, expected) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return false;
  const a = Buffer.from(match[1]);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Windows Firewall blocks inbound ICMP and unsolicited LAN traffic by default,
 * so peers cannot ping each other or host a game. These rules open only the
 * virtual LAN range (10.66.0.0/16), not the physical network.
 */
const FIREWALL_RULES = [
  { name: 'Nurofen-LAN-ICMP', protocol: 'icmpv4:8,any' },
  { name: 'Nurofen-LAN-TCP', protocol: 'TCP' },
  { name: 'Nurofen-LAN-UDP', protocol: 'UDP' },
];

export async function ensureFirewall(ports = []) {
  const results = [];
  for (const rule of FIREWALL_RULES) {
    await run('netsh.exe', ['advfirewall', 'firewall', 'delete', 'rule', `name=${rule.name}`]);
    const result = await run('netsh.exe', [
      'advfirewall', 'firewall', 'add', 'rule', `name=${rule.name}`,
      'dir=in', 'action=allow', `protocol=${rule.protocol}`,
      'remoteip=10.66.0.0/16', 'profile=any',
    ]);
    results.push({ name: rule.name, ok: result.ok });
    if (!result.ok) {
      logLine(`firewall ${rule.name}: ${(result.stderr || result.stdout || result.code || '').toString().slice(0, 200)}`);
    }
  }

  // Direct (beta) links are plain UDP from another machine's real address, not
  // from 10.66.0.0/16. Open only the tunnel's own UDP ports; WireGuard silently
  // drops every packet it cannot authenticate.
  const list = [...new Set((Array.isArray(ports) ? ports : [])
    .map(Number)
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536))];
  // The helper starts without the client's profile, so it has no ports to
  // offer. Deleting the rule here used to remove direct connections until the
  // app was opened again; leave the existing rule alone instead.
  if (!list.length) return results;
  await run('netsh.exe', ['advfirewall', 'firewall', 'delete', 'rule', 'name=Nurofen-Direct-UDP']);
  if (list.length) {
    const result = await run('netsh.exe', [
      'advfirewall', 'firewall', 'add', 'rule', 'name=Nurofen-Direct-UDP',
      'dir=in', 'action=allow', 'protocol=UDP',
      `localport=${list.join(',')}`, 'remoteip=any', 'profile=any',
    ]);
    results.push({ name: 'Nurofen-Direct-UDP', ok: result.ok });
    if (!result.ok) {
      logLine(`firewall Nurofen-Direct-UDP: ${(result.stderr || result.stdout || result.code || '').toString().slice(0, 200)}`);
    }
  }
  return results;
}


async function up({ name, config }) {
  if (!NAME_RE.test(String(name || ''))) throw new Error('bad tunnel name');
  if (typeof config !== 'string' || !config.includes('[Interface]') || !config.includes('[Peer]')) {
    throw new Error('bad config');
  }
  const exe = findAwg();
  if (!exe) throw new Error('awg_missing');

  const dir = ensureDir(confDir());
  const file = path.join(dir, `${name}.conf`);
  fs.writeFileSync(file, config, { mode: 0o600 });

  // A tunnel with the same name may be left over from a crash or a port switch.
  await run(exe, ['/uninstalltunnelservice', name]);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const install = await run(exe, ['/installtunnelservice', file]);
  if (!install.ok) {
    throw new Error(`installtunnelservice failed: ${(install.stderr || install.stdout || install.code || '').toString().slice(0, 400)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 600));
  logLine(`tunnel up: ${name}`);
  return { ok: true, status: await tunnelStatus(name) };
}

async function down({ name }) {
  if (!NAME_RE.test(String(name || ''))) throw new Error('bad tunnel name');
  const exe = findAwg();
  if (!exe) throw new Error('awg_missing');
  const result = await run(exe, ['/uninstalltunnelservice', name]);
  logLine(`tunnel down: ${name} (${result.ok ? 'ok' : 'not running'})`);
  return { ok: true };
}

/** `awg show <name> dump` -> per-peer endpoint and handshake. */
function parseDump(text) {
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  const peers = [];
  for (const line of lines.slice(1)) {
    const [publicKey, , endpoint, allowedIps, latestHandshake, rx, tx] = line.split('\t');
    if (!publicKey) continue;
    peers.push({
      publicKey,
      endpoint: endpoint && endpoint !== '(none)' ? endpoint : null,
      allowedIps: allowedIps || '',
      latestHandshake: Number(latestHandshake) || 0,
      rx: Number(rx) || 0,
      tx: Number(tx) || 0,
    });
  }
  return peers;
}

async function dumpPeers(name) {
  if (!NAME_RE.test(String(name || ''))) throw new Error('bad tunnel name');
  const exe = findAwgCli();
  if (!exe) throw new Error('awg_missing');
  let result = await run(exe, ['show', name, 'dump']);
  if (!result.ok) {
    // Right after a port switch the service may still be starting.
    await new Promise((resolve) => setTimeout(resolve, 200));
    result = await run(exe, ['show', name, 'dump']);
  }
  if (!result.ok) throw new Error((result.stderr || result.stdout || 'awg show failed').toString().slice(0, 300));
  return parseDump(result.stdout);
}

/**
 * Beta P2P: tunnel traffic to selected peers goes straight to their endpoint
 * instead of through the hub.
 *
 * Two rules keep the channel from breaking the connection while it is being
 * established:
 *
 * 1. A peer is routed directly only after WireGuard has a fresh handshake with
 *    it. Until then the peer entry exists with a reserved probe address, so the
 *    real traffic keeps going through the hub. The old version moved the peer's
 *    10.66.x.y/32 to a dead endpoint right away, which blackholed the friend for
 *    the whole attempt — that is what looked like "the connection drops".
 * 2. A working session is never re-pointed at the address the hub observed.
 *    WireGuard roams on its own, and re-applying the hub's view every few
 *    seconds used to tear the direct link down again and again.
 *
 * The hub peer is never touched; a peer without a handshake stays on the hub.
 */
const DIRECT_ALIVE_S = 150; // WireGuard rekeys about every two minutes
const PROBE_PREFIX = '192.0.2.'; // TEST-NET-1: reserved, never routable

/** Stable per-peer probe address so two probes never fight over one /32. */
export function probeAllowedIp(publicKey) {
  let hash = 0;
  for (const char of String(publicKey || '')) hash = (hash * 33 + char.charCodeAt(0)) % 250;
  return `${PROBE_PREFIX}${hash + 1}/32`;
}

/** What to apply for one peer, given its current tunnel entry. */
export function directPlan(current, peer, now) {
  const live = Boolean(current && current.latestHandshake > 0 && now - current.latestHandshake < DIRECT_ALIVE_S);
  const route = live ? `${peer.ip}/32` : probeAllowedIp(peer.publicKey);
  const endpoint = live ? null : peer.endpoint;
  const patch = !current
    || current.allowedIps !== route
    || (endpoint !== null && current.endpoint !== endpoint);
  return { live, route, keepalive: live ? 25 : 2, endpoint, patch };
}

async function directPeers({ name, hubPublicKey, peers }) {
  if (!NAME_RE.test(String(name || ''))) throw new Error('bad tunnel name');
  if (!hubPublicKey) throw new Error('hub_key_required');
  const exe = findAwgCli();
  if (!exe) throw new Error('awg_missing');
  const wanted = (Array.isArray(peers) ? peers : [])
    .filter((peer) => peer && peer.publicKey && peer.ip && peer.endpoint && peer.publicKey !== hubPublicKey);

  const before = await dumpPeers(name);
  const known = new Map(before.map((peer) => [peer.publicKey, peer]));
  const wantedKeys = new Set(wanted.map((peer) => peer.publicKey));
  for (const peer of before) {
    if (peer.publicKey === hubPublicKey) continue;
    if (!wantedKeys.has(peer.publicKey)) {
      await run(exe, ['set', name, 'peer', peer.publicKey, 'remove']);
    }
  }

  const now = Date.now() / 1000;
  for (const peer of wanted) {
    const plan = directPlan(known.get(peer.publicKey), peer, now);
    if (!plan.patch) continue;
    const args = ['set', name, 'peer', peer.publicKey,
      'allowed-ips', plan.route,
      'persistent-keepalive', String(plan.keepalive)];
    if (plan.endpoint) args.push('endpoint', plan.endpoint);
    const result = await run(exe, args);
    if (!result.ok) {
      logLine(`direct ${peer.ip}: ${(result.stderr || result.stdout || result.code || '').toString().slice(0, 200)}`);
    }
  }

  const after = await dumpPeers(name);
  const seconds = Date.now() / 1000;
  return {
    peers: after
      .filter((peer) => peer.publicKey !== hubPublicKey)
      .map((peer) => {
        const target = wanted.find((item) => item.publicKey === peer.publicKey);
        const alive = peer.latestHandshake > 0 && seconds - peer.latestHandshake < DIRECT_ALIVE_S;
        return {
          publicKey: peer.publicKey,
          ip: target?.ip || '',
          endpoint: peer.endpoint,
          latestHandshake: peer.latestHandshake,
          active: Boolean(target && alive && peer.allowedIps === `${target.ip}/32`),
          alive,
        };
      }),
  };
}

export function startHelper(log = console, version = '') {
  const expected = token();
  logLine('helper starting');
  ensureFirewall().then((rules) => {
    logLine(`firewall: ${rules.map((rule) => `${rule.name}=${rule.ok ? 'ok' : 'fail'}`).join(' ')}`);
  }).catch((error) => logLine(`firewall: ${error.message}`));

  const server = http.createServer(async (req, res) => {
    const remote = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
      json(res, 403, { error: 'loopback only' });
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health') {
      json(res, 200, { ok: true, awg: findAwg(), tunnel: TUNNEL_NAME, version });
      return;
    }
    if (!authorized(req, expected)) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    try {
      if (url.pathname === '/tunnel/up' && req.method === 'POST') {
        json(res, 200, await up(await readBody(req)));
        return;
      }
      if (url.pathname === '/tunnel/down' && req.method === 'POST') {
        json(res, 200, await down(await readBody(req)));
        return;
      }
      if (url.pathname === '/tunnel/status') {
        json(res, 200, await tunnelStatus(url.searchParams.get('name') || TUNNEL_NAME));
        return;
      }
      if (url.pathname === '/tunnel/peers') {
        json(res, 200, { peers: await dumpPeers(url.searchParams.get('name') || TUNNEL_NAME) });
        return;
      }
      if (url.pathname === '/tunnel/direct' && req.method === 'POST') {
        json(res, 200, await directPeers(await readBody(req)));
        return;
      }
      if (url.pathname === '/awg/install' && req.method === 'POST') {
        json(res, 200, await ensureAmneziawg());
        return;
      }
      if (url.pathname === '/firewall/ensure' && req.method === 'POST') {
        const body = await readBody(req);
        json(res, 200, { ok: true, rules: await ensureFirewall(body?.ports) });
        return;
      }
      if (url.pathname === '/helper/restart' && req.method === 'POST') {
        json(res, 200, { ok: true, restarting: true, from: version, disk: diskVersion() });
        setTimeout(() => restartSelf('requested by client'), 150);
        return;
      }
      json(res, 404, { error: 'not_found' });
    } catch (error) {
      logLine(`error ${url.pathname}: ${error.message}`);
      json(res, 500, { error: error.message });
    }
  });

  let attempts = 0;
  const listen = () => {
    server.listen(HELPER_PORT, '127.0.0.1', () => {
      logLine(`helper listening on 127.0.0.1:${HELPER_PORT} (${version || '?'})`);
      log.info?.(`[helper] listening on 127.0.0.1:${HELPER_PORT}`);
    });
  };
  server.on('error', (err) => {
    // A self-restart starts the new process before the old one lets go of the
    // port, so the child retries briefly instead of dying with EADDRINUSE.
    if (err.code === 'EADDRINUSE' && attempts < 30) {
      attempts += 1;
      setTimeout(listen, 400);
      return;
    }
    logLine(`helper server error: ${err.message}`);
  });
  listen();
  return server;
}
