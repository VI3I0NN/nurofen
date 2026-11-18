import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nurofen-smoke-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, NUROFEN_ROOT: root, NUROFEN_API_PORT: String(port), NUROFEN_AWG_BIN: 'definitely-missing', NUROFEN_AWG_QUICK_BIN: 'definitely-missing' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const logs = [];
child.stdout.on('data', (chunk) => logs.push(String(chunk)));
child.stderr.on('data', (chunk) => logs.push(String(chunk)));

function keypair() {
  const pair = generateKeyPairSync('x25519');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64'),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
  };
}

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`server did not start:\n${logs.join('')}`);
}

async function call(method, url, { token, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}: ${error.message}`);
  }
}

try {
  await waitForServer();
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'nurofen.json'), 'utf8'));
  const invite = cfg.networks[0].invite;
  const adminToken = cfg.adminToken;
  console.log(`smoke: root=${root} invite=${invite}`);

  const alice = keypair();
  const bob = keypair();
  let aliceToken = null;
  let bobToken = null;
  let aliceId = null;

  await check('healthz', async () => {
    const res = await call('GET', '/healthz');
    assert.equal(res.status, 200);
  });

  await check('join with bad invite is rejected', async () => {
    const res = await call('POST', '/api/v1/join', { body: { invite: 'AAAA-BBBB', deviceName: 'x', publicKey: alice.publicKey } });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'invite_not_found');
  });

  await check('join rejects malformed key', async () => {
    const res = await call('POST', '/api/v1/join', { body: { invite, deviceName: 'x', publicKey: 'nope' } });
    assert.equal(res.status, 400);
  });

  await check('alice joins', async () => {
    const res = await call('POST', '/api/v1/join', {
      body: { invite, deviceName: 'Alice', publicKey: alice.publicKey, deviceId: 'device-alice' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.self.ip, '10.66.0.10');
    assert.equal(res.body.network.subnet, '10.66.0.0/24');
    assert.ok(res.body.token);
    assert.equal(res.body.peers.length, 1);
    assert.equal(res.body.peers[0].self, true);
    aliceToken = res.body.token;
    aliceId = res.body.self.id;
  });

  await check('bob joins and sees alice', async () => {
    const res = await call('POST', '/api/v1/join', {
      body: { invite, deviceName: 'Bob', publicKey: bob.publicKey, deviceId: 'device-bob' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.self.ip, '10.66.0.11');
    assert.equal(res.body.peers.length, 2);
    bobToken = res.body.token;
  });

  await check('same device rejoins without a new IP', async () => {
    const res = await call('POST', '/api/v1/join', {
      body: { invite, deviceName: 'Alice', publicKey: alice.publicKey, deviceId: 'device-alice' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.self.ip, '10.66.0.10');
    aliceToken = res.body.token;
  });

  await check('state requires a token', async () => {
    const res = await call('GET', '/api/v1/state');
    assert.equal(res.status, 401);
  });

  await check('state returns peers', async () => {
    const res = await call('GET', '/api/v1/state', { token: aliceToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.peers.length, 2);
    assert.equal(res.body.self.name, 'Alice');
    assert.equal(res.body.tunnel.dryRun, true);
  });

  await check('heartbeat updates liveness', async () => {
    const res = await call('POST', '/api/v1/heartbeat', { token: bobToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.peers.length, 2);
  });

  await check('admin overview needs admin token', async () => {
    const res = await call('GET', '/api/v1/admin/overview', { token: aliceToken });
    assert.equal(res.status, 401);
  });

  await check('admin overview works', async () => {
    const res = await call('GET', '/api/v1/admin/overview', { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.peers.length, 2);
    assert.equal(res.body.invite, invite);
    assert.equal(res.body.awg.dryRun, true);
  });

  await check('admin page renders', async () => {
    const res = await fetch(`${base}/admin`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.ok(html.includes('Nurofen'));
  });

  await check('rotate invite invalidates the old code', async () => {
    const rotated = await call('POST', '/api/v1/admin/invite/rotate', { token: adminToken });
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.body.invite, invite);
    const old = await call('POST', '/api/v1/join', { body: { invite, deviceName: 'Eve', publicKey: keypair().publicKey } });
    assert.equal(old.status, 404);
    const fresh = await call('POST', '/api/v1/join', {
      body: { invite: rotated.body.invite, deviceName: 'Eve', publicKey: keypair().publicKey },
    });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.self.ip, '10.66.0.12');
  });

  await check('kick removes a peer from the network', async () => {
    const res = await call('DELETE', `/api/v1/admin/peers/${aliceId}`, { token: adminToken });
    assert.equal(res.status, 200);
    const state = await call('GET', '/api/v1/state', { token: bobToken });
    assert.equal(state.body.peers.length, 2);
    const kicked = await call('GET', '/api/v1/state', { token: aliceToken });
    assert.equal(kicked.status, 401);
  });

  await check('server config is written with obfuscation', async () => {
    const conf = fs.readFileSync(path.join(root, 'nurofen0.conf'), 'utf8');
    assert.match(conf, /\[Interface\]/);
    assert.match(conf, /^Jc = \d+$/m);
    assert.match(conf, /^H4 = \d+$/m);
    assert.match(conf, /AllowedIPs = 10\.66\.0\.1[01]\/32/);
  });
} finally {
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
