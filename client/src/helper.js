import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  HELPER_PORT,
  TUNNEL_NAME,
  confDir,
  ensureDir,
  findAwg,
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

export function startHelper(log = console) {
  const expected = token();
  logLine('helper starting');

  const server = http.createServer(async (req, res) => {
    const remote = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
      json(res, 403, { error: 'loopback only' });
      return;
    }
    if (!authorized(req, expected)) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (url.pathname === '/health') {
        json(res, 200, { ok: true, awg: findAwg(), tunnel: TUNNEL_NAME });
        return;
      }
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
      if (url.pathname === '/awg/install' && req.method === 'POST') {
        json(res, 200, await ensureAmneziawg());
        return;
      }
      json(res, 404, { error: 'not_found' });
    } catch (error) {
      logLine(`error ${url.pathname}: ${error.message}`);
      json(res, 500, { error: error.message });
    }
  });

  server.listen(HELPER_PORT, '127.0.0.1', () => {
    logLine(`helper listening on 127.0.0.1:${HELPER_PORT}`);
    log.info?.(`[helper] listening on 127.0.0.1:${HELPER_PORT}`);
  });
  return server;
}
