import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { joinNetwork, publicPeer } from '../src/network.js';
import { verifyPassword } from '../src/util.js';

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
  const adminToken = cfg.adminToken;
  assert.equal(cfg.networks.length, 0, 'fresh server starts without networks');
  console.log(`smoke: root=${root} networks=${cfg.networks.length}`);

  const alice = keypair();
  const bob = keypair();
  const dave = keypair();
  let aliceToken = null;
  let bobToken = null;
  let daveToken = null;
  let aliceId = null;
  let dachaId = null;
  let officeId = null;

  await check('healthz', async () => {
    const res = await call('GET', '/healthz');
    assert.equal(res.status, 200);
  });

  await check('public landing page and installer route exist', async () => {
    const page = await fetch(`${base}/download`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Nurofen/);
    const redirect = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/download');
  });

  await check('join without a network name is rejected', async () => {
    const res = await call('POST', '/api/v1/join', {
      body: { mode: 'join', name: '', password: 'whatever', deviceName: 'x', publicKey: alice.publicKey },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'network_name_required');
  });

  await check('join rejects malformed key', async () => {
    const res = await call('POST', '/api/v1/join', {
      body: { mode: 'create', name: 'Дача', password: 'teapot42', deviceName: 'x', publicKey: 'nope' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_key');
  });

  await check('join rejects a non-canonical base64 key', async () => {
    // 43 chars + "=" decodes to 32 bytes, but the padding bits are non-zero
    // and `wg` refuses it. Reject it before a peer is stored.
    const res = await call('POST', '/api/v1/join', {
      body: {
        mode: 'create', name: 'Дача', password: 'teapot42', deviceName: 'x',
        publicKey: `${'B'.repeat(43)}=`,
      },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_key');
  });

  await check('alice creates the network "Дача"', async () => {
    const res = await call('POST', '/api/v1/join', {
      body: {
        mode: 'create', name: 'Дача', password: 'teapot42',
        deviceName: 'Alice', publicKey: alice.publicKey, deviceId: 'device-alice',
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.created, true);
    assert.equal(res.body.network.name, 'Дача');
    assert.equal(res.body.network.subnet, '10.66.0.0/24');
    assert.equal(res.body.self.ip, '10.66.0.10');
    assert.ok(res.body.token);
    assert.equal(res.body.peers.length, 1);
    assert.equal(res.body.peers[0].self, true);
    assert.equal(res.body.invite, undefined);
    aliceToken = res.body.token;
    aliceId = res.body.self.id;
    dachaId = res.body.network.id;
  });

  await check('a duplicate network name is rejected case-insensitively', async () => {
    const res = await call('POST', '/api/v1/join', {
      body: {
        mode: 'create', name: '  дАчА ', password: 'other-pass',
        deviceName: 'Eve', publicKey: keypair().publicKey,
      },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'network_exists');
  });

  await check('bob creates a separate network "Office"', async () => {
    const res = await call('POST', '/api/v1/join', {
      body: {
        mode: 'create', name: 'Office', password: 'work-1234',
        deviceName: 'Bob', publicKey: bob.publicKey, deviceId: 'device-bob',
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.network.subnet, '10.66.1.0/24');
    assert.equal(res.body.self.ip, '10.66.1.10');
    bobToken = res.body.token;
    officeId = res.body.network.id;
  });

  await check('wrong password is rejected', async () => {
    const res = await call('POST', '/api/v1/join', {
      body: { mode: 'join', name: 'Дача', password: 'nope-nope', deviceName: 'Dave', publicKey: dave.publicKey },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'bad_password');
  });

  await check('unknown network is rejected', async () => {
    const res = await call('POST', '/api/v1/join', {
      body: { mode: 'join', name: 'Не существует', password: 'whatever', deviceName: 'Dave', publicKey: dave.publicKey },
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'network_not_found');
  });

  await check('dave joins by name and password', async () => {
    const res = await call('POST', '/api/v1/join', {
      body: {
        mode: 'join', name: '  дача ', password: 'teapot42',
        deviceName: 'Dave', publicKey: dave.publicKey, deviceId: 'device-dave',
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.created, false);
    assert.equal(res.body.self.ip, '10.66.0.11');
    assert.equal(res.body.peers.length, 2);
    daveToken = res.body.token;
  });

  await check('networks are isolated in the API', async () => {
    const a = await call('GET', '/api/v1/state', { token: aliceToken });
    assert.equal(a.status, 200);
    assert.ok(a.body.peers.every((peer) => peer.ip.startsWith('10.66.0.')));
    assert.equal(a.body.network.subnet, '10.66.0.0/24');
    const b = await call('GET', '/api/v1/state', { token: bobToken });
    assert.equal(b.body.peers.length, 1);
    assert.ok(b.body.peers.every((peer) => peer.ip.startsWith('10.66.1.')));
  });

  await check('same device rejoins without a new IP', async () => {
    const res = await call('POST', '/api/v1/join', {
      body: {
        mode: 'join', name: 'Дача', password: 'teapot42',
        deviceName: 'Alice', publicKey: alice.publicKey, deviceId: 'device-alice',
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.self.ip, '10.66.0.10');
    aliceToken = res.body.token;
  });

  await check('state requires a token', async () => {
    const res = await call('GET', '/api/v1/state');
    assert.equal(res.status, 401);
  });

  await check('heartbeat publishes the LAN world port', async () => {
    const beat = await call('POST', '/api/v1/heartbeat', { token: daveToken, body: { lanPort: 54871 } });
    assert.equal(beat.status, 200);
    assert.equal(beat.body.peers.find((peer) => peer.name === 'Dave').lanPort, 54871);
    const cleared = await call('POST', '/api/v1/heartbeat', { token: daveToken, body: { lanPort: null } });
    assert.equal(cleared.body.peers.find((peer) => peer.name === 'Dave').lanPort, null);
  });

  await check('device renames itself', async () => {
    const bad = await call('POST', '/api/v1/rename', { token: daveToken, body: { name: 'x' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'bad_name');
    const res = await call('POST', '/api/v1/rename', { token: daveToken, body: { name: '  Dave Pro  ' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.self.name, 'Dave Pro');
    const alice = await call('GET', '/api/v1/state', { token: aliceToken });
    assert.ok(alice.body.peers.some((peer) => peer.name === 'Dave Pro'));
  });

  await check('offline endpoint marks a peer offline immediately', async () => {
    const gone = await call('POST', '/api/v1/offline', { token: daveToken });
    assert.equal(gone.status, 200);
    const alice = await call('GET', '/api/v1/state', { token: aliceToken });
    assert.equal(alice.body.peers.find((peer) => peer.name === 'Dave Pro').online, false);
    await call('POST', '/api/v1/heartbeat', { token: daveToken, body: {} });
    const again = await call('GET', '/api/v1/state', { token: aliceToken });
    assert.equal(again.body.peers.find((peer) => peer.name === 'Dave Pro').online, true);
  });

  await check('direct (beta) opt-in exposes the peer key only to opted-in members', async () => {
    await call('POST', '/api/v1/heartbeat', { token: daveToken, body: { direct: true } });
    let alice = await call('GET', '/api/v1/state', { token: aliceToken });
    let davePeer = alice.body.peers.find((peer) => peer.name === 'Dave Pro');
    assert.equal(davePeer.direct, true);
    assert.equal(davePeer.publicKey, dave.publicKey);

    await call('POST', '/api/v1/heartbeat', { token: daveToken, body: { direct: false } });
    alice = await call('GET', '/api/v1/state', { token: aliceToken });
    davePeer = alice.body.peers.find((peer) => peer.name === 'Dave Pro');
    assert.equal(davePeer.direct, false);
    assert.equal(davePeer.publicKey, null);
  });

  await check('direct (beta) keeps private addresses hidden without a shared NAT', async () => {
    await call('POST', '/api/v1/heartbeat', {
      token: daveToken,
      body: { direct: true, directPort: 51820, directIps: ['192.168.1.50', '10.66.2.99', 'bad'] },
    });
    const alice = await call('GET', '/api/v1/state', { token: aliceToken });
    const davePeer = alice.body.peers.find((peer) => peer.name === 'Dave Pro');
    assert.equal(davePeer.sameNat, false);
    assert.equal(davePeer.directPort, null);
    assert.deepEqual(davePeer.directIps, []);
    await call('POST', '/api/v1/heartbeat', { token: daveToken, body: { direct: true } });
  });

  await check('direct (beta) reports the peer helper build to direct peers only', async () => {
    await call('POST', '/api/v1/heartbeat', {
      token: daveToken,
      body: { direct: true, helperVersion: '0.4.8', clientVersion: '0.4.9' },
    });
    let alice = await call('GET', '/api/v1/state', { token: aliceToken });
    let davePeer = alice.body.peers.find((peer) => peer.name === 'Dave Pro');
    assert.equal(davePeer.helperVersion, '0.4.8');
    assert.equal(davePeer.clientVersion, '0.4.9');

    await call('POST', '/api/v1/heartbeat', { token: daveToken, body: { direct: false } });
    alice = await call('GET', '/api/v1/state', { token: aliceToken });
    davePeer = alice.body.peers.find((peer) => peer.name === 'Dave Pro');
    assert.equal(davePeer.helperVersion, null);
    assert.equal(davePeer.clientVersion, null);
  });

  await check('direct (beta) gives same-NAT peers the LAN endpoint, not the public one', async () => {
    const view = publicPeer(
      {
        id: 'same-nat-peer',
        name: 'Same NAT',
        ip: '10.66.2.11',
        direct: true,
        directPort: 57220,
        directIps: ['192.168.1.50'],
      },
      { endpoint: '176.226.195.3:57220' },
      { sameNat: true },
    );
    assert.equal(view.sameNat, true);
    assert.equal(view.endpoint, '192.168.1.50:57220');
    assert.deepEqual(view.directIps, ['192.168.1.50']);
  });

  await check('admin overview lists networks and peers', async () => {
    const res = await call('GET', '/api/v1/admin/overview', { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.networks.length, 2);
    assert.equal(res.body.subnet, '10.66.0.0/16');
    assert.equal(res.body.invite, undefined);
    assert.equal(res.body.peers.length, 3);
    assert.ok(res.body.peers.every((peer) => peer.network && peer.network.name));
    assert.equal(res.body.awg.dryRun, true);
  });

  await check('admin page renders', async () => {
    const res = await fetch(`${base}/admin`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.ok(html.includes('Сети пользователей'));
  });

  await check('admin creates a network and changes a password', async () => {
    const created = await call('POST', '/api/v1/admin/networks', {
      token: adminToken,
      body: { name: 'Гости', password: 'guest-1234' },
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.network.subnet, '10.66.2.0/24');

    const changed = await call('POST', `/api/v1/admin/networks/${dachaId}/password`, {
      token: adminToken,
      body: { password: 'teapot-new-42' },
    });
    assert.equal(changed.status, 200);

    const old = await call('POST', '/api/v1/join', {
      body: { mode: 'join', name: 'Дача', password: 'teapot42', deviceName: 'Old', publicKey: keypair().publicKey },
    });
    assert.equal(old.status, 403);
    const fresh = await call('POST', '/api/v1/join', {
      body: { mode: 'join', name: 'Дача', password: 'teapot-new-42', deviceName: 'Fresh', publicKey: keypair().publicKey },
    });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.self.ip, '10.66.0.12');
  });

  await check('an authenticated device can add a phone profile to its network', async () => {
    const phone = keypair();
    const res = await call('POST', '/api/v1/devices', {
      token: aliceToken,
      body: { deviceName: 'Телефон', publicKey: phone.publicKey },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.network.name, 'Дача');
    assert.equal(res.body.self.ip, '10.66.0.13');
    const state = await call('GET', '/api/v1/state', { token: aliceToken });
    assert.equal(state.body.peers.length, 4);
  });

  await check('admin can kick a single device', async () => {
    const res = await call('DELETE', `/api/v1/admin/peers/${aliceId}`, { token: adminToken });
    assert.equal(res.status, 200);
    const kicked = await call('GET', '/api/v1/state', { token: aliceToken });
    assert.equal(kicked.status, 401);
  });

  await check('admin can delete a whole network', async () => {
    const res = await call('DELETE', `/api/v1/admin/networks/${officeId}`, { token: adminToken });
    assert.equal(res.status, 200);
    const kicked = await call('GET', '/api/v1/state', { token: bobToken });
    assert.equal(kicked.status, 401);
    const overview = await call('GET', '/api/v1/admin/overview', { token: adminToken });
    assert.equal(overview.body.networks.length, 2);
    assert.ok(!overview.body.networks.some((net) => net.id === officeId));
  });

  await check('passwords are stored as hashes, not plaintext', async () => {
    const raw = fs.readFileSync(path.join(root, 'nurofen.json'), 'utf8');
    assert.ok(!raw.includes('teapot-new-42'));
    assert.ok(!raw.includes('guest-1234'));
    assert.ok(!raw.includes('"invite"'));
    assert.ok(raw.includes('passwordHash'));
    assert.ok(raw.includes('passwordSalt'));
  });

  await check('server config has one Address per network and /32 peers', async () => {
    const conf = fs.readFileSync(path.join(root, 'nurofen0.conf'), 'utf8');
    assert.match(conf, /^Address = 10\.66\.0\.1\/24$/m);
    assert.match(conf, /^Address = 10\.66\.2\.1\/24$/m);
    assert.match(conf, /^Jc = \d+$/m);
    assert.match(conf, /^H4 = \d+$/m);
    assert.match(conf, /AllowedIPs = 10\.66\.\d+\.\d+\/32/);
  });

  await check('external config edits survive heartbeats', async () => {
    const file = path.join(root, 'nurofen.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const peer = raw.peers.find((item) => item.name === 'Dave Pro');
    peer.revoked = true;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    await new Promise((resolve) => setTimeout(resolve, 30));

    const beat = await call('POST', '/api/v1/heartbeat', { token: daveToken, body: {} });
    assert.equal(beat.status, 401, 'revoked peer must lose access');

    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.peers.find((item) => item.name === 'Dave Pro').revoked, true, 'heartbeat must not resurrect the peer');
  });
} finally {
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
}

// ---------------------------------------------------------------- migration
await check('legacy config with an invite code migrates to a password', async () => {
  const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nurofen-legacy-'));
  const pair = keypair();
  const legacy = {
    version: 1,
    adminToken: 'legacy-token',
    server: { publicHost: '203.0.113.7', interface: 'nurofen0', awgPort: 51820, subnet: '10.66.0.0/24' },
    awg: { privateKey: keypair().privateKey, publicKey: keypair().publicKey, obfuscation: {} },
    networks: [{ id: 'net-1', name: 'Nurofen', invite: '6SCH-UNAP', createdAt: '2026-01-01T00:00:00.000Z' }],
    peers: [
      { id: 'bad-key', networkId: 'net-1', name: 'Broken', ip: '10.66.0.20', publicKey: `${'B'.repeat(43)}=`, revoked: false },
      { id: 'orphan', networkId: 'gone', name: 'Orphan', ip: '10.66.5.10', publicKey: pair.publicKey, revoked: false },
    ],
  };
  fs.writeFileSync(path.join(legacyRoot, 'nurofen.json'), JSON.stringify(legacy, null, 2));

  const migrated = loadConfig(legacyRoot);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.peers.find((peer) => peer.id === 'bad-key').revoked, true);
  assert.equal(migrated.peers.find((peer) => peer.id === 'orphan').revoked, true);
  assert.equal(migrated.networks.length, 1);
  assert.equal(migrated.networks[0].subnet, '10.66.0.0/24');
  assert.equal(migrated.networks[0].invite, undefined);
  assert.ok(migrated.networks[0].passwordHash);
  assert.ok(verifyPassword('6SCH-UNAP', migrated.networks[0].passwordSalt, migrated.networks[0].passwordHash));
  assert.ok(!verifyPassword('wrong', migrated.networks[0].passwordSalt, migrated.networks[0].passwordHash));

  const joined = joinNetwork(migrated, {
    mode: 'join',
    name: 'nurofen',
    password: '6SCH-UNAP',
    deviceName: 'Legacy PC',
    publicKey: pair.publicKey,
    deviceId: 'legacy-device',
  });
  assert.equal(joined.network.id, 'net-1');
  assert.equal(joined.peer.ip, '10.66.0.10');

  const onDisk = JSON.parse(fs.readFileSync(path.join(legacyRoot, 'nurofen.json'), 'utf8'));
  assert.equal(onDisk.networks[0].invite, undefined);
  assert.ok(onDisk.networks[0].passwordHash);

  // The migrated network also accepts a new one next to it.
  const second = joinNetwork(migrated, {
    mode: 'create',
    name: 'Новая',
    password: 'second-pass',
    deviceName: 'PC 2',
    publicKey: keypair().publicKey,
  });
  assert.equal(second.network.subnet, '10.66.1.0/24');
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
