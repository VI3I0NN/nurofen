import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UI_PORT, dataDir, ensureDir, findAwg, logFile } from './paths.js';
import {
  initProfile,
  keypair,
  loadProfile,
  nextInterface,
  removeMembership,
  renderConfig,
  saveProfile,
} from './profile.js';
import { defaultServerUrl, heartbeat, join, leave, normalizeServer, state as getState, rename, offline } from './api.js';
import { helperAlive, helperInfo, ensureFirewall, ping, restartHelper, syncDirectPeers, tunnelDown, tunnelStatus, tunnelUp } from './tunnel.js';
import { startHelper } from './helper.js';
import { detectLanPort, serverInfo } from './minecraft.js';
import { keepStatuses, splitAddress, statusFor } from './mcstatus.js';
import { activeGameDir, findServerDir, resolveGameDir, runningGameDir, scanGameDirs } from './minecraftPaths.js';
import { readServers, upsertServer } from './servers.js';
import { launchGame, playInfo } from './play.js';
import {
  acceptTransfer,
  cancelTransfer,
  declineTransfer,
  dismissTransfer,
  filesSnapshot,
  initFiles,
  startSend,
  stopFiles,
  transferPath,
} from './files.js';
import {
  acceptRemote,
  dismissRemote,
  declineRemote,
  initRemote,
  remoteEnabled,
  remoteInput,
  remoteSnapshot,
  remoteStream,
  setRemoteControl,
  startRemote,
  stopRemote,
  stopRemoteSession,
} from './remote.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');
const UI_DIR = path.join(HERE, 'ui');
const NO_WINDOW = process.argv.includes('--no-window');
const FORCE_HELPER = process.argv.includes('--helper');

// When the desktop shell loads this file inside Electron, the shell owns the
// window, tray and lifetime. Everything else (API, tunnel, profiles) stays here.
const ELECTRON = globalThis.__nurofenElectron || null;

function readVersion() {
  try {
    const text = fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const APP_VERSION = readVersion();

// Windows named pipes are released by the kernel when the owner dies, which
// makes them a reliable single-instance lock without stale PID files.
const INSTANCE_PIPE = `\\\\.\\pipe\\nurofen-${(process.env.USERNAME || 'user').replace(/[^a-zA-Z0-9_.-]/g, '_')}`;

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  try {
    process.stdout.write(`${line}\n`);
  } catch {
    // Electron's GUI process may not have a console attached.
  }
  try {
    ensureDir(dataDir());
    fs.appendFileSync(logFile(), `${line}\n`);
  } catch {
    // never crash because of logging
  }
}

const ui = {
  helper: false,
  helperVersion: '',
  awg: false,
  minecraft: null,
  server: null,
  pendingServer: null,
  pendingInvite: null,
  logTail: [],
};

/** Per-network runtime state, keyed by membership id. */
const runtime = new Map();

let heartbeatTimer = null;
let tickTimer = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function profile() {
  return loadProfile();
}

/** The game folder the user picked by hand; empty means auto-detect. */
function configuredMinecraftDir(p = loadProfile()) {
  return String(p.settings?.minecraftDir || '').trim();
}

/** The dedicated server folder picked by hand; empty means none. */
function configuredServerDir(p = loadProfile()) {
  return String(p.settings?.minecraftServerDir || '').trim();
}

/**
 * The port friends should join: a running dedicated server wins over a LAN
 * world, because it was configured on purpose and stays up between sessions.
 */
function sharedLanPort() {
  if (ui.server?.running) return ui.server.port;
  return ui.minecraft?.port ?? null;
}

/**
 * Everything the UI needs to explain where Minecraft was found: the path in
 * use, the manual path and the short list of detected launchers.
 */
function minecraftInfo(p = loadProfile()) {
  const configured = configuredMinecraftDir(p);
  const dir = activeGameDir(configured);
  return {
    configured,
    dir: dir || '',
    installed: Boolean(dir),
    found: scanGameDirs().slice(0, 6).map((item) => ({
      path: item.path,
      launcher: item.launcher,
      instance: item.instance || '',
    })),
  };
}

/** World addresses that are worth asking for a status right now. */
function worldAddresses(p = loadProfile()) {
  const addresses = new Set();
  const port = sharedLanPort();
  for (const member of p.networks) {
    const state = runtimeFor(member.id);
    if (state.status !== 'connected' || !member.self?.ip) continue;
    if (port) addresses.add(`${member.self.ip}:${port}`);
    for (const peer of state.peers || []) {
      if (peer.self || !peer.online || !peer.lanPort) continue;
      addresses.add(`${peer.ip}:${peer.lanPort}`);
    }
  }
  return addresses;
}

/** A desktop notification when the shell supports it; the UI toast is separate. */
function notifyDesktop(title, body) {
  try {
    if (ELECTRON?.notify) ELECTRON.notify({ title, body });
  } catch {
    // notifications are optional
  }
}

/**
 * Folder picker for the plain-Node run (no Electron shell). PowerShell writes
 * the chosen path to a UTF-8 file so Cyrillic paths survive the console codepage.
 */
function pickDirectoryFallback(title = 'Папка Minecraft') {
  return new Promise((resolve) => {
    const outFile = path.join(os.tmpdir(), `nurofen-pick-${randomUUID()}.txt`);
    const quoted = outFile.replace(/'/g, "''");
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$d.Description = "${String(title).replace(/"/g, '')}"`,
      '$d.ShowNewFolderButton = $false',
      `if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [IO.File]::WriteAllText('${quoted}', $d.SelectedPath, [Text.Encoding]::UTF8) }`,
    ].join('; ');
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true });
    child.on('error', () => resolve(''));
    child.on('close', () => {
      let picked = '';
      try {
        picked = fs.readFileSync(outFile, 'utf8').trim();
        fs.unlinkSync(outFile);
      } catch {
        // cancelled or the file was never written
      }
      resolve(picked);
    });
  });
}

/** The same picker for a launcher executable, used without the Electron shell. */
function pickFileFallback({ title = 'Исполняемый файл лаунчера', filter = 'Программы (*.exe)|*.exe' } = {}) {
  return new Promise((resolve) => {
    const outFile = path.join(os.tmpdir(), `nurofen-exe-${randomUUID()}.txt`);
    const quoted = outFile.replace(/'/g, "''");
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.OpenFileDialog',
      `$d.Title = "${String(title).replace(/"/g, '')}"`,
      `$d.Filter = "${String(filter).replace(/"/g, '')}"`,
      `if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [IO.File]::WriteAllText('${quoted}', $d.FileName, [Text.Encoding]::UTF8) }`,
    ].join('; ');
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true });
    child.on('error', () => resolve(''));
    child.on('close', () => {
      let picked = '';
      try {
        picked = fs.readFileSync(outFile, 'utf8').trim();
        fs.unlinkSync(outFile);
      } catch {
        // cancelled or the file was never written
      }
      resolve(picked);
    });
  });
}

function pickAnyFileFallback() {
  return pickFileFallback({ title: 'Файл для отправки', filter: 'Все файлы (*.*)|*.*' });
}

function joined(member) {
  return Boolean(member?.token && member.serverUrl && member.server && member.self);
}

function memberById(id) {
  return loadProfile().networks.find((item) => item.id === id) || null;
}

function runtimeFor(id) {
  let state = runtime.get(id);
  if (!state) {
    state = {
      status: 'idle',
      error: null,
      port: null,
      tunnel: { exists: false, up: false, ip: null },
      peers: [],
      pings: {},
      hubPing: null,
      directModes: {},
      directTries: new Map(),
      directBlocked: new Map(),
      directAttempts: new Map(),
      directApplied: false,
      directBusy: false,
      connectedAt: null,
      connecting: false,
      abort: false,
      downTicks: 0,
      idleTicks: 0,
    };
    runtime.set(id, state);
  }
  return state;
}

function syncRuntime(p = profile()) {
  for (const member of p.networks) runtimeFor(member.id);
  for (const id of runtime.keys()) {
    if (!p.networks.some((member) => member.id === id)) runtime.delete(id);
  }
  return p;
}

/** Networks in the shape the file module needs: status, self and peers. */
function fileNetworks() {
  const p = loadProfile();
  return p.networks.map((member) => {
    const state = runtimeFor(member.id);
    return {
      id: member.id,
      status: state.status,
      network: member.network,
      self: member.self,
      peers: state.peers || [],
    };
  });
}

function fileSelf(networkId) {
  const member = memberById(networkId);
  return {
    name: member?.self?.name || loadProfile().deviceName || 'Устройство',
    ip: member?.self?.ip || '',
  };
}

function findPeerAnywhere(peerId) {
  const wanted = String(peerId || '');
  if (!wanted) return null;
  for (const net of fileNetworks()) {
    if (net.status !== 'connected') continue;
    const peer = (net.peers || []).find((item) => item.id === wanted && !item.self);
    if (peer) return { peer, networkId: net.id, networkName: net.network?.name || '' };
  }
  return null;
}

/**
 * Friends are stored by the server-side peer id, which is stable while the
 * membership exists. The view adds live data from every connected network, so
 * a friend is shown as online wherever they currently are.
 */
function friendView(p = loadProfile()) {
  const found = new Map();
  for (const net of fileNetworks()) {
    if (net.status !== 'connected') continue;
    for (const peer of net.peers || []) {
      if (peer.self) continue;
      const current = found.get(peer.id);
      if (!current || (!current.peer.online && peer.online)) {
        found.set(peer.id, { peer, networkId: net.id, networkName: net.network?.name || '' });
      }
    }
  }
  return (p.friends || []).map((friend) => {
    const live = found.get(friend.peerId);
    return {
      peerId: friend.peerId,
      name: live?.peer.name || friend.name || 'Друг',
      ip: live?.peer.ip || friend.ip || '',
      networkName: live?.networkName || friend.networkName || '',
      networkId: live?.networkId || friend.networkId || '',
      inNetwork: Boolean(live),
      online: Boolean(live?.peer.online),
      addedAt: friend.addedAt,
    };
  });
}

function hubIp(member) {
  const subnet = String(member.network?.subnet || '').split('/')[0];
  if (!subnet) return '';
  const parts = subnet.split('.');
  return `${parts[0]}.${parts[1]}.${parts[2]}.1`;
}

const VIRTUAL_ADAPTER = /vethernet|virtualbox|vmware|hyper-v|wsl|docker|loopback|radmin|nurofen|tap-|tun/i;

/** Private LAN addresses of this PC, used for direct links behind one router. */
function localDirectIps() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_ADAPTER.test(name)) continue;
    for (const item of list || []) {
      const ip = item.address;
      if (item.family !== 'IPv4' || item.internal) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) continue;
      if (ip.startsWith('10.66.')) continue;
      found.push(ip);
    }
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  return [...new Set(found)].sort((a, b) => rank(a) - rank(b)).slice(0, 4);
}

/**
 * Ordered direct endpoints for a peer. Old clients publish the hub port
 * (57201) as directPort instead of their real listening port, so the
 * server-observed port from peer.endpoint is tried first on the LAN address:
 * for a client without an explicit ListenPort that observed port IS the
 * listening port. Published directPort is the second LAN candidate.
 *
 * For two devices behind one router the public address would need hairpin
 * NAT, which most routers drop. Trying it replaced a working LAN link with a
 * dead one and the channel fell back to the hub, so the public address is not
 * used at all when a LAN address is known: the hub is the fallback instead.
 */
function directEndpoints(peer) {
  const found = [];
  const add = (value) => {
    if (value && !found.includes(value)) found.push(value);
  };
  const observedPort = String(peer.endpoint || '').split(':').pop();
  if (peer.sameNat && Array.isArray(peer.directIps) && peer.directIps.length) {
    for (const ip of peer.directIps) {
      if (observedPort && /^\d+$/.test(observedPort)) add(`${ip}:${observedPort}`);
    }
    for (const ip of peer.directIps) {
      if (peer.directPort) add(`${ip}:${peer.directPort}`);
    }
    if (found.length) return found;
  }
  add(peer.endpoint);
  return found;
}

function directEndpoint(peer) {
  return directEndpoints(peer)[0] || null;
}

function candidatePorts(member) {
  const pool = Array.isArray(member.server?.ports) && member.server.ports.length
    ? member.server.ports
    : [member.server?.port].filter(Boolean);
  const ordered = [member.lastPort, ...pool].filter((value) => Number.isInteger(value) && value > 0);
  return [...new Set(ordered)];
}

/** Every UDP port the client may listen on, for the direct-connection firewall rule. */
function allTunnelPorts(p) {
  const ports = [];
  for (const member of p.networks || []) {
    for (const port of candidatePorts(member)) ports.push(port);
    if (Number.isInteger(member.listenPort) && member.listenPort > 0) ports.push(member.listenPort);
  }
  return [...new Set(ports)];
}

function pushLog(level, message) {
  ui.logTail.push({ at: new Date().toISOString(), level, message });
  if (ui.logTail.length > 60) ui.logTail.shift();
}

/* Tunnel operations are serialised: AmneziaWG's CLI reshuffles services and two
   networks coming up at the same time would race each other. */
let tunnelQueue = Promise.resolve();
function withTunnelLock(task) {
  const next = tunnelQueue.then(task, task);
  tunnelQueue = next.catch(() => {});
  return next;
}

async function waitForTunnel(member, timeoutMs = 9000) {
  const deadline = Date.now() + timeoutMs;
  const hub = hubIp(member);
  while (Date.now() < deadline) {
    const status = await tunnelStatus(member.interface);
    if (status.up && hub) {
      const probe = await ping(hub, 800);
      if (probe.ok) return { ok: true, status };
    }
    await sleep(700);
  }
  return { ok: false };
}

/* ------------------------------------------------------------------ connect */

async function connect(id) {
  const member = memberById(id);
  if (!member || !joined(member)) return { ok: false, error: 'no_network' };
  const state = runtimeFor(id);
  if (state.connecting || state.status === 'connected') return { ok: true };

  state.connecting = true;
  state.abort = false;
  state.status = 'connecting';
  state.error = null;
  pushLog('info', `«${member.network.name}»: подключение…`);

  try {
    if (!findAwg()) {
      ui.helper = await helperAlive();
      if (ui.helper) {
        pushLog('info', 'устанавливаю AmneziaWG…');
        await fetch('http://127.0.0.1:39394/awg/install', {
          method: 'POST',
          headers: { authorization: `Bearer ${readHelperTokenSafe()}` },
          signal: AbortSignal.timeout(180000),
        }).catch(() => {});
      }
    }
    if (!findAwg()) throw new Error('awg_missing');

    let lastError = null;
    for (const port of candidatePorts(member)) {
      if (state.abort) return { ok: false, error: 'cancelled' };
      pushLog('info', `«${member.network.name}»: пробую udp/${port}`);
      try {
        const conf = renderConfig(member, port);
        await withTunnelLock(() => tunnelUp(conf, member.interface));
      } catch (error) {
        lastError = error;
        pushLog('warn', `«${member.network.name}» udp/${port}: ${error.message}`);
        await withTunnelLock(() => tunnelDown(member.interface).catch(() => {}));
        continue;
      }
      const probe = await waitForTunnel(member);
      if (probe.ok) {
        const fresh = loadProfile();
        const saved = fresh.networks.find((item) => item.id === id);
        if (saved) {
          saved.lastPort = port;
          saved.autoConnect = true;
          saveProfile(fresh);
        }
        state.port = port;
        state.status = 'connected';
        state.connectedAt = new Date().toISOString();
        state.tunnel = probe.status;
        state.downTicks = 0;
        pushLog('ok', `«${member.network.name}»: туннель поднят на udp/${port}`);
        await refreshPeers(member);
        syncDirect(loadProfile().networks.find((item) => item.id === id) || member).catch(() => {});
        return { ok: true, port };
      }
      pushLog('warn', `«${member.network.name}» udp/${port}: нет ответа, пробую следующий порт`);
      await withTunnelLock(() => tunnelDown(member.interface).catch(() => {}));
      lastError = new Error(`no_handshake_${port}`);
    }
    throw lastError || new Error('cannot_connect');
  } catch (error) {
    state.status = 'error';
    state.error = friendlyError(error.message);
    pushLog('error', state.error);
    return { ok: false, error: state.error };
  } finally {
    state.connecting = false;
  }
}

function readHelperTokenSafe() {
  try {
    return fs.readFileSync(path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Nurofen', 'helper-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

function friendlyError(code) {
  const map = {
    awg_missing: 'AmneziaWG не установлен. Запустите install.ps1 от администратора.',
    no_network: 'Сначала создайте сеть или подключитесь к существующей.',
    network_not_found: 'Сеть с таким названием не найдена.',
    network_exists: 'Сеть с таким названием уже существует.',
    network_name_required: 'Введите название сети.',
    invalid_network_name: 'Название сети должно содержать не менее двух символов.',
    password_required: 'Введите пароль сети.',
    password_too_short: 'Пароль должен содержать не менее четырёх символов.',
    password_too_long: 'Пароль слишком длинный.',
    bad_password: 'Неверный пароль сети.',
    too_many_requests: 'Слишком много попыток. Подождите минуту.',
    too_many_networks: 'На сервере достигнут лимит созданных сетей.',
    network_full: 'В сети закончились свободные адреса.',
    unauthorized: 'Сессия устарела — подключитесь к сети заново.',
    bad_response: 'Сервер вернул неожиданный ответ. Проверьте подключение к серверу.',
    server_required: 'Не задан адрес сервера.',
    no_update: 'Обновлений нет.',
    update_cancelled: 'Обновление отменено.',
    bad_checksum: 'Скачанный файл повреждён. Попробуйте ещё раз.',
    minecraft_not_found: 'Папка Minecraft не найдена — укажите её в настройках.',
    minecraft_server_not_found: 'В этой папке нет server.jar — выберите папку сервера.',
    bad_address: 'Некорректный адрес мира.',
    play_launcher_not_found: 'Лаунчер не найден — укажите путь к его исполняемому файлу.',
    play_instance_not_found: 'В лаунчере нет выбранной сборки.',
    play_launch_failed: 'Не удалось запустить лаунчер. Проверьте путь к нему.',
    play_exe_invalid: 'Такого файла нет — выберите исполняемый файл лаунчера.',
  };
  if (map[code]) return map[code];
  if (/elevat|access is denied|отказано/i.test(code)) {
    return 'Нужны права администратора: запустите install.ps1 (он ставит службу-помощник).';
  }
  if (/^no_handshake/.test(code)) return 'Сервер не отвечает ни на одном порту. Проверьте доступность сервера.';
  if (/fetch failed|enotfound|econnrefused|econnreset|timeout|timed out|network/i.test(code)) {
    return 'Сервер не отвечает. Проверьте подключение к интернету.';
  }
  return code;
}

async function disconnect(id, { manual = false } = {}) {
  const state = runtimeFor(id);
  const member = memberById(id);
  state.abort = true;
  if (member) {
    try {
      await withTunnelLock(() => tunnelDown(member.interface));
    } catch (error) {
      pushLog('warn', `${member.interface}: ${error.message}`);
    }
  }
  state.status = 'idle';
  state.port = null;
  state.connectedAt = null;
  state.tunnel = { exists: false, up: false, ip: null };
  state.peers = [];
  state.pings = {};
  state.hubPing = null;
  state.directApplied = false;
  state.directModes = {};
  state.directTries.clear();
  state.directBlocked.clear();
  state.directAttempts.clear();
  if (member) await Promise.race([offline(member).catch(() => {}), sleep(1500)]);
  pushLog('info', member ? `«${member.network.name}»: отключено` : 'отключено');

  if (manual && member) {
    const fresh = loadProfile();
    const saved = fresh.networks.find((item) => item.id === id);
    if (saved) {
      saved.autoConnect = false;
      saveProfile(fresh);
    }
  }
  return { ok: true };
}

async function disconnectAll() {
  await Promise.all(loadProfile().networks.map((member) => disconnect(member.id)));
}

/* ------------------------------------------------------------------- peers */

async function refreshPeers(member) {
  if (!joined(member)) return;
  const state = runtimeFor(member.id);
  try {
    const data = state.status === 'connected'
      ? await heartbeat(member, {
        direct: member.direct === true,
        directPort: member.listenPort || null,
        directIps: localDirectIps(),
        clientVersion: APP_VERSION,
        helperVersion: ui.helperVersion || null,
        lanPort: sharedLanPort(),
      })
      : await getState(member);
    if (data?.peers) {
      state.peers = data.peers;
      trackPeerWorlds(member, data.peers);
    }
  } catch (error) {
    if (state.status === 'connected') pushLog('warn', `«${member.network.name}»: связь с сервером — ${error.message}`);
  }
}

/**
 * A world that appears after the first poll is news: the player was waiting
 * for a friend to open it. The first poll only sets the baseline, so worlds
 * that were already open do not produce a burst of notifications on startup.
 */
function trackPeerWorlds(member, peers) {
  const state = runtimeFor(member.id);
  const next = new Set();
  const fresh = [];
  for (const peer of peers) {
    if (peer.self || !peer.online || !peer.lanPort) continue;
    const address = `${peer.ip}:${peer.lanPort}`;
    next.add(address);
    if (state.worlds && !state.worlds.has(address)) {
      fresh.push({ name: peer.name || peer.ip, address });
    }
  }
  const first = !state.worlds;
  state.worlds = next;
  if (first || !fresh.length) return;
  if (loadProfile().settings?.notifyWorlds === false) return;
  for (const item of fresh) {
    pushLog('ok', `${item.name} открыл мир — ${item.address}`);
    notifyDesktop(`${item.name} открыл мир`, `${item.address} — нажмите «Добавить» в Nurofen`);
  }
}

async function pingPeers(member) {
  const state = runtimeFor(member.id);
  if (state.pinging) return;
  const targets = state.peers.filter((peer) => !peer.self && peer.ip && peer.online);
  if (!targets.length) state.pings = {};
  state.pinging = true;
  try {
    const results = {};
    const queue = [...targets];
    const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
      while (queue.length) {
        const peer = queue.shift();
        const result = await ping(peer.ip, 700);
        results[peer.ip] = result.ok ? result.ms : null;
      }
    });
    const hub = ping(hubIp(member), 700).then((result) => {
      state.hubPing = result.ok ? result.ms : null;
    });
    await Promise.all([...workers, hub]);
    state.pings = results;
  } finally {
    state.pinging = false;
  }
}

/* -------------------------------------------------------- direct (beta) P2P */

const DIRECT_GRACE_MS = 8 * 1000;
const DIRECT_ROTATE_MS = 4 * 1000;
const DIRECT_RETRY_MS = 30 * 60 * 1000;
// WireGuard rekeys roughly every two minutes, so a handshake older than a
// minute does not mean the link is dead. The helper uses the same window.
const DIRECT_ALIVE_MS = 180 * 1000;

async function clearDirect(member) {
  const state = runtimeFor(member.id);
  if (state.status !== 'connected') return;
  try {
    await syncDirectPeers({ name: member.interface, hubPublicKey: member.server?.publicKey, peers: [] });
  } catch {
    // the tunnel may be gone already
  }
  state.directApplied = false;
  state.directModes = {};
  state.directTries.clear();
  state.directAttempts.clear();
}

/** Oldest helper build that knows how to add a direct peer. */
const DIRECT_MIN_HELPER = [0, 4, 5];

function versionAtLeast(value, min) {
  const parts = String(value || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < min.length; index += 1) {
    const part = parts[index] || 0;
    if (part > min[index]) return true;
    if (part < min[index]) return false;
  }
  return true;
}

/** A helper below the direct-capable build cannot open the channel at all. */
function staleHelper(peer) {
  return Boolean(peer.helperVersion) && !versionAtLeast(peer.helperVersion, DIRECT_MIN_HELPER);
}

/**
 * Optional beta feature: traffic to peers goes straight to their public
 * endpoint instead of through the hub. Only peers that enabled it too are
 * tried; after a failed handshake the peer is removed and the hub is used.
 */
async function syncDirect(member) {
  const state = runtimeFor(member.id);
  if (!member.direct) {
    if (state.directApplied) await clearDirect(member);
    return;
  }
  if (state.status !== 'connected' || state.directBusy) return;
  state.directBusy = true;
  try {
    const now = Date.now();
    const candidates = state.peers.filter((peer) => (
      !peer.self && peer.online && peer.direct && peer.publicKey && peer.ip && directEndpoint(peer)
    ));
    const modes = {};
    const wanted = [];
    for (const peer of candidates) {
      if ((state.directBlocked.get(peer.publicKey) || 0) > now) {
        modes[peer.ip] = 'relay';
        continue;
      }
      wanted.push(peer);
      modes[peer.ip] = 'trying';
    }
    if (!wanted.length) {
      if (state.directApplied) {
        await syncDirectPeers({ name: member.interface, hubPublicKey: member.server?.publicKey, peers: [] }).catch(() => {});
        state.directApplied = false;
      }
      state.directModes = modes;
      state.directTries.clear();
      state.directAttempts.clear();
      return;
    }
    const endpointsByKey = new Map(wanted.map((peer) => [peer.publicKey, directEndpoints(peer)]));
    const result = await syncDirectPeers({
      name: member.interface,
      hubPublicKey: member.server?.publicKey,
      peers: wanted.map((peer) => {
        const endpoints = endpointsByKey.get(peer.publicKey) || [];
        const attempt = state.directAttempts.get(peer.publicKey) || { index: 0, since: now };
        return { publicKey: peer.publicKey, ip: peer.ip, endpoint: endpoints[attempt.index % endpoints.length] };
      }),
    });
    state.directApplied = true;
    const live = new Map((result.peers || []).map((peer) => [peer.publicKey, peer]));
    for (const peer of wanted) {
      const info = live.get(peer.publicKey);
      const handshakeAt = info?.latestHandshake ? info.latestHandshake * 1000 : 0;
      const first = state.directTries.get(peer.publicKey) || now;
      state.directTries.set(peer.publicKey, first);
      const endpoints = endpointsByKey.get(peer.publicKey) || [];
      const attempt = state.directAttempts.get(peer.publicKey) || { index: 0, since: first };
      if (handshakeAt && now - handshakeAt < DIRECT_ALIVE_MS) {
        modes[peer.ip] = 'direct';
        state.directTries.delete(peer.publicKey);
        state.directAttempts.delete(peer.publicKey);
      } else if (now - first > Math.max(DIRECT_GRACE_MS, endpoints.length * DIRECT_ROTATE_MS)) {
        state.directBlocked.set(peer.publicKey, now + DIRECT_RETRY_MS);
        state.directTries.delete(peer.publicKey);
        state.directAttempts.delete(peer.publicKey);
        if (staleHelper(peer)) {
          modes[peer.ip] = 'stale';
          pushLog('warn', `«${member.network.name}»: у ${peer.name} старая служба (${peer.helperVersion} при клиенте ${peer.clientVersion}) — перезапустите ПК`);
        } else {
          modes[peer.ip] = 'relay';
          pushLog('warn', `«${member.network.name}»: прямой канал с ${peer.name} не поднялся, трафик идёт через сервер`);
        }
      } else {
        if (endpoints.length > 1 && now - attempt.since > DIRECT_ROTATE_MS) {
          state.directAttempts.set(peer.publicKey, { index: attempt.index + 1, since: now });
        } else if (!state.directAttempts.has(peer.publicKey)) {
          state.directAttempts.set(peer.publicKey, attempt);
        }
        modes[peer.ip] = 'trying';
      }
    }
    for (const key of [...state.directTries.keys()]) {
      if (!wanted.some((peer) => peer.publicKey === key)) {
        state.directTries.delete(key);
        state.directAttempts.delete(key);
      }
    }
    state.directModes = modes;
  } catch (error) {
    pushLog('warn', `«${member.network.name}»: прямые соединения — ${error.message}`);
    state.directModes = {};
  } finally {
    state.directBusy = false;
  }
}

async function setDirect(id, value) {
  const p = loadProfile();
  const member = p.networks.find((item) => item.id === id);
  if (!member) throw new Error('Сеть не найдена.');
  member.direct = Boolean(value);
  saveProfile(p);
  const state = runtimeFor(id);
  state.directBlocked.clear();
  state.directTries.clear();
  state.directAttempts.clear();
  if (!member.direct) await clearDirect(member);
  if (joined(member) && state.status === 'connected') {
    try {
      const data = await heartbeat(member, {
        direct: member.direct,
        directPort: member.listenPort || null,
        directIps: localDirectIps(),
        clientVersion: APP_VERSION,
        helperVersion: ui.helperVersion || null,
        lanPort: sharedLanPort(),
      });
      if (data?.peers) state.peers = data.peers;
    } catch {
      // the switch still applies locally; the next heartbeat will retry
    }
  }
  if (member.direct && state.status === 'connected') await syncDirect(member);
  return { ok: true, direct: member.direct };
}

let ticking = false;
/**
 * The game loads `servers.dat` at startup and may write its in-memory list
 * back when it closes, so a click made while it is open would be lost. Keep
 * the entry around for a few minutes and put it back whenever the file no
 * longer has it; that way the next launch always shows the server.
 */
const PENDING_SERVER_MS = 10 * 60 * 1000;
const INVITE_TTL = 10 * 60 * 1000;

function flushPendingServer() {
  const pending = ui.pendingServer;
  if (!pending) return;
  if (Date.now() > pending.until) {
    ui.pendingServer = null;
    return;
  }
  const dirs = new Set([configuredMinecraftDir()]);
  const running = runningGameDir();
  if (running) dirs.add(running.dir);
  for (const dir of dirs) {
    try {
      if (readServers(dir).servers.some((server) => server.ip === pending.ip)) continue;
      upsertServer({ name: pending.name, ip: pending.ip, dir });
    } catch {
      // a file the game is writing right now is retried on the next tick
    }
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
  // Minecraft writes the LAN port to its own log; reading the tail is the
  // only reliable way to learn it without touching the game.
  const p = syncRuntime();
  ui.minecraft = detectLanPort(configuredMinecraftDir(p));
  ui.server = await serverInfo(configuredServerDir(p));
  flushPendingServer();
  await Promise.all(p.networks.map(async (member) => {
    const state = runtimeFor(member.id);
    state.checkTick = (state.checkTick || 0) + 1;
    // Spawning PowerShell for every network every couple of seconds is wasteful;
    // idle networks are re-checked rarely, active ones on every tick.
    const check = state.status !== 'idle' || state.tunnel.exists || state.checkTick % 4 === 0;
    if (check) {
      const previous = state.tunnel;
      state.tunnel = await tunnelStatus(member.interface).catch(() => ({ exists: false, up: false }));

      if (state.status === 'connected') {
        if (state.tunnel.up) {
          state.downTicks = 0;
        } else if (state.tunnel.exists || previous.up) {
          state.downTicks += 1;
          if (state.downTicks >= 2) {
            pushLog('warn', `«${member.network.name}»: туннель отвалился, переподключаюсь`);
            state.status = 'idle';
            state.error = null;
            state.downTicks = 0;
            await connect(member.id);
          }
        }
      }
    }
    if (state.status === 'connected') {
      if (state.checkTick % 3 === 0) await pingPeers(member);
    } else {
      state.idleTicks += 1;
      if (state.idleTicks % 5 === 0) await refreshPeers(member);
    }
  }));
  } finally { ticking = false; }
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    const p = loadProfile();
    for (const member of p.networks) {
      const state = runtime.get(member.id);
      if (state?.status === 'connected') {
        refreshPeers(member).then(() => syncDirect(member)).catch(() => {});
      }
    }
  }, 5000);
}

/* -------------------------------------------------------------- join/leave */

async function addNetwork({ mode, name, password, deviceName }) {
  const existingProfile = loadProfile();
  const base = normalizeServer(defaultServerUrl() || existingProfile.networks[0]?.serverUrl);
  if (!base) throw new Error('server_required');
  const networkName = String(name || '').trim();
  if (!networkName) throw new Error('network_name_required');
  if (!String(password || '').trim()) throw new Error('password_required');

  if (mode !== 'create') {
    const known = existingProfile.networks.find(
      (item) => item.serverUrl === base && String(item.network?.name || '').toLowerCase() === networkName.toLowerCase(),
    );
    if (known) {
      existingProfile.activeId = known.id;
      if (!known.password) known.password = String(password);
      saveProfile(existingProfile);
      return { ok: true, id: known.id, existing: true };
    }
  }

  initProfile(deviceName);
  const keys = keypair();
  // A device id belongs to exactly one network, so every membership gets its
  // own. Sharing it would move the existing peer instead of adding a network.
  const deviceId = randomUUID();
  const response = await join({
    serverUrl: base,
    mode: mode === 'create' ? 'create' : 'join',
    name: networkName,
    password,
    deviceName: loadProfile().deviceName,
    publicKey: keys.publicKey,
    deviceId,
  });

  const p = loadProfile();
  const duplicate = p.networks.find(
    (item) => item.serverUrl === base && item.network?.id === response.network.id,
  );
  if (duplicate) {
    p.activeId = duplicate.id;
    saveProfile(p);
    runtimeFor(duplicate.id);
    return { ok: true, id: duplicate.id, existing: true };
  }

  const iface = nextInterface(p);
  const ifaceIndex = /^nurofen-(\d+)$/.exec(iface) ? Number(/^nurofen-(\d+)$/.exec(iface)[1]) - 1 : 0;
  const member = {
    id: randomUUID(),
    deviceId,
    serverUrl: base,
    token: response.token,
    network: response.network,
    self: response.self,
    server: {
      host: response.servers?.[0] || base.replace(/^https?:\/\//, '').split(':')[0],
      port: response.ports?.[0] || 51820,
      ports: response.ports || [],
      publicKey: response.serverPublicKey,
    },
    obfuscation: response.obfuscation,
    mtu: response.mtu || 1280,
    keepalive: response.keepalive || 25,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    // Kept to build the invite link. The profile already holds the private
    // key and the server token, so the network password is not new exposure.
    password: String(password),
    lastPort: null,
    interface: iface,
    listenPort: 57220 + Math.max(0, ifaceIndex),
    autoConnect: true,
    direct: false,
    createdAt: new Date().toISOString(),
  };
  p.networks.push(member);
  p.activeId = member.id;
  p.deviceName = response.self.name || p.deviceName;
  saveProfile(p);

  const state = runtimeFor(member.id);
  state.peers = response.peers || [];
  pushLog('ok', `вошёл в сеть «${response.network.name}» как ${response.self.ip}`);
  if (ui.helper) ensureFirewall(allTunnelPorts(p)).catch(() => {});
  connect(member.id).catch(() => {});
  return { ok: true, id: member.id };
}

async function forgetNetwork(id) {
  const member = memberById(id);
  await disconnect(id, { manual: true });
  if (member) await leave(member).catch(() => {});
  const p = loadProfile();
  removeMembership(p, id);
  saveProfile(p);
  runtime.delete(id);
  pushLog('info', member ? `вышел из сети «${member.network.name}»` : 'сеть удалена');
  return { ok: true, activeId: p.activeId };
}

function selectNetwork(id) {
  const p = loadProfile();
  if (!p.networks.some((member) => member.id === id)) return { ok: false, error: 'no_network' };
  p.activeId = id;
  saveProfile(p);
  return { ok: true };
}

/* ----------------------------------------------------------------- updates */

const update = {
  checking: false,
  applying: false,
  available: false,
  latest: null,
  notes: '',
  size: 0,
  checkedAt: null,
  error: null,
  progress: '',
};

function versionParts(value) {
  return String(value || '0')
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function updateServer() {
  return normalizeServer(defaultServerUrl() || loadProfile().networks[0]?.serverUrl);
}

async function checkForUpdate({ quiet = false } = {}) {
  if (update.checking) return update;
  update.checking = true;
  update.error = null;
  try {
    const base = updateServer();
    if (!base) throw new Error('server_required');
    const res = await fetch(`${base}/api/v1/client/latest`, {
      headers: { 'cache-control': 'no-store' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const data = await res.json();
    update.latest = data?.version ? String(data.version) : null;
    update.notes = data?.notes ? String(data.notes) : '';
    update.size = Number(data?.size) || 0;
    update.checkedAt = new Date().toISOString();
    update.available = Boolean(update.latest) && compareVersions(update.latest, APP_VERSION) > 0;
    update.download = `${base}/dl/${String(data?.file || 'client.zip')}`;
    update.sha256 = String(data?.sha256 || '').toLowerCase();
  } catch (error) {
    update.error = quiet ? null : friendlyError(error.message);
  } finally {
    update.checking = false;
  }
  return update;
}

/** Mirror a directory: copy everything from `source` and drop stale files. */
function mirrorDir(source, target) {
  ensureDir(target);
  const keep = new Set();
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    keep.add(entry.name);
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) mirrorDir(from, to);
    else fs.copyFileSync(from, to);
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (!keep.has(entry.name)) fs.rmSync(path.join(target, entry.name), { recursive: true, force: true });
  }
}

function copyUpdate(source, target) {
  for (const name of ['src', 'electron-app', 'assets']) {
    const from = path.join(source, name);
    if (fs.existsSync(from)) mirrorDir(from, path.join(target, name));
  }
  const pkg = path.join(source, 'package.json');
  if (fs.existsSync(pkg)) fs.copyFileSync(pkg, path.join(target, 'package.json'));
}

async function elevatedCopy(source, target, workDir) {
  const done = path.join(workDir, 'applied.txt');
  const script = path.join(workDir, 'apply-update.ps1');
  const quote = (value) => String(value).replace(/'/g, "''");
  fs.writeFileSync(script, [
    "$ErrorActionPreference = 'Stop'",
    `$source = '${quote(source)}'`,
    `$target = '${quote(target)}'`,
    `$done = '${quote(done)}'`,
    'foreach ($name in @("src", "electron-app", "assets")) {',
    '  $from = Join-Path $source $name',
    '  if (Test-Path $from) {',
    '    & robocopy $from (Join-Path $target $name) /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null',
    '    if ($LASTEXITCODE -ge 8) { throw "robocopy $name failed: $LASTEXITCODE" }',
    '  }',
    '}',
    '$pkg = Join-Path $source "package.json"',
    'if (Test-Path $pkg) { Copy-Item $pkg (Join-Path $target "package.json") -Force }',
    'foreach ($rule in @(@("Nurofen-LAN-ICMP", "icmpv4:8,any"), @("Nurofen-LAN-TCP", "TCP"), @("Nurofen-LAN-UDP", "UDP"))) {',
    '  & netsh.exe advfirewall firewall delete rule ("name=" + $rule[0]) | Out-Null',
    '  & netsh.exe advfirewall firewall add rule ("name=" + $rule[0]) dir=in action=allow ("protocol=" + $rule[1]) remoteip=10.66.0.0/16 profile=any | Out-Null',
    '}',
    '# Restart the SYSTEM helper so the new client code (firewall/P2P) is live.',
    '& schtasks.exe /End /TN NurofenHelper 2>$null | Out-Null',
    '& schtasks.exe /Run /TN NurofenHelper 2>$null | Out-Null',
    'Set-Content -LiteralPath $done -Value "ok" -Encoding ascii',
    '',
  ].join('\r\n'), 'utf8');

  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `"${script}"`,
  ];
  const command = `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -ArgumentList ${args
    .map((part) => `'${part.replace(/'/g, "''")}'`)
    .join(',')}`;
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('close', () => resolve());
  });
  for (let i = 0; i < 120; i += 1) {
    if (fs.existsSync(done)) return;
    await sleep(500);
  }
  throw new Error('update_cancelled');
}

/** Waits until the helper answers with the expected build. */
async function waitForHelper(targetVersion, timeoutMs = 20000) {
  const expected = String(targetVersion || '');
  if (!expected) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await helperInfo();
    if (info?.ok && String(info.version || '') === expected) {
      ui.helper = true;
      ui.helperVersion = expected;
      return true;
    }
    await sleep(500);
  }
  return false;
}

/** Asks the running helper to reload from disk (works from 0.4.10 on). */
async function reloadHelper(targetVersion, timeoutMs = 20000) {
  try {
    await restartHelper();
  } catch {
    return false;
  }
  return waitForHelper(targetVersion, timeoutMs);
}

/** Fallback for helpers that predate the restart endpoint: one UAC prompt. */
async function restartHelperElevated(workDir = os.tmpdir()) {
  ensureDir(workDir);
  const stamp = `${Date.now()}`;
  const done = path.join(workDir, `helper-restart-${stamp}.txt`);
  const script = path.join(workDir, `helper-restart-${stamp}.ps1`);
  fs.writeFileSync(script, [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '& schtasks.exe /End /TN NurofenHelper | Out-Null',
    'Start-Sleep -Milliseconds 900',
    '& schtasks.exe /Run /TN NurofenHelper | Out-Null',
    `Set-Content -LiteralPath '${done.replace(/'/g, "''")}' -Value 'ok' -Encoding ascii`,
    '',
  ].join('\r\n'), 'utf8');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `"${script}"`];
  const command = `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -ArgumentList ${args
    .map((part) => `'${part.replace(/'/g, "''")}'`)
    .join(',')}`;
  const code = await new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      stdio: 'ignore',
    });
    child.once('error', () => resolve(-1));
    child.once('close', (value) => resolve(value ?? -1));
  });
  if (code !== 0) return false;
  for (let i = 0; i < 40; i += 1) {
    if (fs.existsSync(done)) return true;
    await sleep(500);
  }
  return false;
}

/** Makes the helper match the files that were just installed. */
async function updateHelperBuild(targetVersion, workDir) {
  if (await reloadHelper(targetVersion)) return true;
  pushLog('info', 'служба-помощник: нужны права администратора');
  if (!(await restartHelperElevated(workDir))) return false;
  return waitForHelper(targetVersion, 20000);
}

/** Reinstall the published build even when the app version is already current. */
async function forceUpdateHelper() {
  pushLog('info', 'принудительно скачиваю и устанавливаю пакет клиента и службы');
  const result = await applyUpdate({ force: true });
  if (!result.ok) return result;
  return {
    ...result,
    message: result.helperUpdated
      ? `Служба обновлена до ${result.version}`
      : 'Пакет установлен, но служба не подтвердила новую версию',
  };
}

async function applyUpdate({ force = false } = {}) {
  if (update.applying) return { ok: false, error: 'busy' };
  if (!update.available) await checkForUpdate();
  if (!update.available && !force) return { ok: false, error: update.error || 'no_update' };
  if (!update.download) return { ok: false, error: update.error || 'no_update' };
  // A forced run re-installs the current build too: this refreshes the helper
  // and its firewall rules even when the version number has not changed.
  const targetVersion = update.latest || APP_VERSION;
  const restartNeeded = compareVersions(targetVersion, APP_VERSION) > 0;
  update.applying = true;
  update.error = null;
  update.progress = 'скачиваю…';
  let workDir = '';
  try {
    const res = await fetch(update.download, { signal: AbortSignal.timeout(180000) });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (update.sha256) {
      const hash = createHash('sha256').update(buffer).digest('hex');
      if (hash !== update.sha256) throw new Error('bad_checksum');
    }

    workDir = path.join(os.tmpdir(), `nurofen-update-${Date.now()}`);
    ensureDir(workDir);
    const zip = path.join(workDir, 'client.zip');
    fs.writeFileSync(zip, buffer);

    update.progress = 'распаковываю…';
    const unpacked = path.join(workDir, 'unpacked');
    await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${unpacked.replace(/'/g, "''")}' -Force`,
      ], { windowsHide: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`unzip_${code}`))));
    });

    let source = unpacked;
    if (!fs.existsSync(path.join(source, 'src'))) {
      const child = fs.readdirSync(unpacked, { withFileTypes: true }).find((item) => item.isDirectory());
      if (child) source = path.join(unpacked, child.name);
    }
    if (!fs.existsSync(path.join(source, 'src'))) throw new Error('bad_archive');

    update.progress = 'устанавливаю…';
    try {
      copyUpdate(source, APP_ROOT);
    } catch (error) {
      if (!/EPERM|EACCES|operation not permitted|access is denied/i.test(`${error.code} ${error.message}`)) throw error;
      update.progress = 'нужны права администратора…';
      await elevatedCopy(source, APP_ROOT, workDir);
    }

    update.progress = 'обновляю службу…';
    const helperReady = await updateHelperBuild(targetVersion, workDir);
    if (!helperReady) {
      pushLog('warn', 'служба-помощник не обновилась: перезапустите ПК, чтобы включить новую версию');
    }

    if (restartNeeded) {
      update.progress = 'перезапускаю…';
      setTimeout(() => restartApp(), 600);
    } else {
      update.progress = '';
    }
    return {
      ok: true,
      restarting: restartNeeded,
      helperUpdated: helperReady,
      version: targetVersion,
    };
  } catch (error) {
    update.error = friendlyError(error.message);
    update.progress = '';
    return { ok: false, error: update.error };
  } finally {
    update.applying = false;
  }
}

function restartApp() {
  if (ELECTRON?.restart) {
    ELECTRON.restart();
    return;
  }
  try {
    const child = spawn(process.execPath, [path.join(APP_ROOT, 'src', 'main.js')], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // If spawning fails, staying alive is better than exiting into nothing.
    return;
  }
  setTimeout(() => process.exit(0), 500);
}

/* ---------------------------------------------------------------- snapshot */

function snapshot() {
  const p = syncRuntime();
  const minecraft = minecraftInfo(p);
  if (ui.pendingInvite && Date.now() - ui.pendingInvite.at > INVITE_TTL) ui.pendingInvite = null;
  const addresses = worldAddresses(p);
  const minecraftStatus = {};
  for (const address of addresses) {
    const target = splitAddress(address);
    if (!target) continue;
    const value = statusFor(target.host, target.port);
    if (value) minecraftStatus[address] = value;
  }
  keepStatuses(addresses);
  const networks = p.networks.map((member) => {
    const state = runtimeFor(member.id);
    return {
      id: member.id,
      joined: joined(member),
      network: member.network,
      self: member.self,
      mtu: member.mtu || 1280,
      interface: member.interface,
      server: member.server ? { host: member.server.host, ports: member.server.ports } : null,
      status: state.status,
      error: state.error,
      port: state.port,
      tunnel: state.tunnel,
      peers: state.peers,
      pings: state.pings,
      hubPing: state.hubPing ?? null,
      direct: Boolean(member.direct),
      directModes: state.directModes || {},
      connectedAt: state.connectedAt,
    };
  });
  return {
    version: APP_VERSION,
    deviceName: p.deviceName,
    minecraft: { port: ui.minecraft?.port ?? null, at: ui.minecraft?.at ?? null, ...minecraft },
    minecraftServer: ui.server || { configured: configuredServerDir(p), dir: '', port: null, running: false },
    minecraftInstalled: minecraft.installed,
    minecraftStatus,
    play: playInfo(p.settings || {}),
    friends: friendView(p),
    files: filesSnapshot(p),
    remote: remoteSnapshot(p),
    invite: ui.pendingInvite,
    activeId: p.activeId,
    networks,
    update: { ...update },
    settings: p.settings || {
      compactPeers: true,
      autoConnect: true,
      notifyWorlds: true,
      minecraftDir: '',
      minecraftServerDir: '',
      playExe: '',
      playLauncher: '',
      playInstance: '',
      filesDir: '',
      remoteAllowed: true,
    },
    helper: ui.helper,
    helperVersion: ui.helperVersion || '',
    helperStale: Boolean(ui.helper && compareVersions(ui.helperVersion, APP_VERSION) < 0),
    awg: Boolean(findAwg()),
    log: ui.logTail.slice(-14),
  };
}

/* -------------------------------------------------------------- ui server */

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
  if (req.method === 'GET' && url.pathname === '/api/remote/stream') {
    remoteStream(url.searchParams.get('id') || '', req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const body = await readBody(req);
    try {
      switch (url.pathname) {
        case '/api/settings': {
          const p = loadProfile();
          p.settings = {
            compactPeers: body.compactPeers !== false,
            autoConnect: body.autoConnect !== false,
            notifyWorlds: body.notifyWorlds !== false,
            minecraftDir: body.minecraftDir === undefined
              ? configuredMinecraftDir(p)
              : String(body.minecraftDir || '').trim(),
            minecraftServerDir: body.minecraftServerDir === undefined
              ? configuredServerDir(p)
              : String(body.minecraftServerDir || '').trim(),
            playExe: body.playExe === undefined
              ? String(p.settings?.playExe || '')
              : String(body.playExe || '').trim(),
            playLauncher: body.playLauncher === undefined
              ? String(p.settings?.playLauncher || '')
              : String(body.playLauncher || ''),
            playInstance: body.playInstance === undefined
              ? String(p.settings?.playInstance || '')
              : String(body.playInstance || ''),
            filesDir: body.filesDir === undefined
              ? String(p.settings?.filesDir || '')
              : String(body.filesDir || '').trim(),
            remoteAllowed: body.remoteAllowed === undefined
              ? remoteEnabled(p)
              : body.remoteAllowed !== false,
          };
          saveProfile(p);
          json(res, 200, { ok: true, settings: p.settings });
          return;
        }
        case '/api/rename': {
          const name = String(body.name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
          if (name.length < 2 || name.length > 32) throw new Error('Ник должен содержать от 2 до 32 символов.');
          const p = loadProfile();
          const failed = [];
          for (const member of p.networks) {
            try {
              const result = await rename(member, name);
              const fresh = loadProfile();
              const saved = fresh.networks.find((item) => item.id === member.id);
              if (saved) saved.self = result.self;
              saveProfile(fresh);
              await refreshPeers(member);
            } catch { failed.push(member.network.name); }
          }
          const fresh = loadProfile();
          fresh.deviceName = name;
          saveProfile(fresh);
          json(res, 200, { ok: !failed.length, error: failed.length ? `Не удалось изменить ник в сетях: ${failed.join(', ')}. Повторите сохранение.` : null });
          return;
        }
        case '/api/join':
          json(res, 200, await addNetwork(body));
          return;
        case '/api/select':
          json(res, 200, selectNetwork(body.id));
          return;
        case '/api/direct':
          json(res, 200, await setDirect(body.id, body.value === true));
          return;
        case '/api/connect':
          json(res, 200, await connect(body.id));
          return;
        case '/api/disconnect':
          json(res, 200, await disconnect(body.id, { manual: true }));
          return;
        case '/api/toggle': {
          const state = runtimeFor(body.id);
          json(res, 200, state.status === 'connected' ? await disconnect(body.id, { manual: true }) : await connect(body.id));
          return;
        }
        case '/api/leave':
          json(res, 200, await forgetNetwork(body.id));
          return;
        case '/api/invite/link': {
          const p = loadProfile();
          const wanted = body.id || p.activeId;
          const member = wanted
            ? p.networks.find((item) => item.id === wanted)
            : p.networks[0];
          if (!member) {
            json(res, 200, { ok: false, error: wanted ? 'Сеть не найдена — подключитесь к ней заново.' : 'Сначала подключитесь к сети.' });
            return;
          }
          if (!member.password) {
            json(res, 200, { ok: false, error: 'Пароль этой сети не сохранён — подключитесь к ней заново.' });
            return;
          }
          const url = `nurofen://join?name=${encodeURIComponent(member.network.name)}&password=${encodeURIComponent(member.password)}`;
          json(res, 200, { ok: true, url, name: member.network.name });
          return;
        }
        case '/api/invite': {
          const name = String(body.name || '').trim().slice(0, 32);
          const password = String(body.password || '').slice(0, 64);
          if (!name || password.length < 4) {
            json(res, 400, { ok: false });
            return;
          }
          ui.pendingInvite = { name, password, at: Date.now() };
          showWindow().catch(() => {});
          json(res, 200, { ok: true });
          return;
        }
        case '/api/invite/clear':
          ui.pendingInvite = null;
          json(res, 200, { ok: true });
          return;
        case '/api/quit':
          stopRemote();
          stopFiles();
          await disconnectAll();
          json(res, 200, { ok: true });
          if (ELECTRON) setTimeout(() => ELECTRON.quit?.(), 150);
          else setTimeout(() => process.exit(0), 150);
          return;
        case '/api/window':
          showWindow().catch(() => {});
          json(res, 200, { ok: true });
          return;
        case '/api/minecraft/add': {
          const address = String(body.ip || '').trim();
          if (!/^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(address)) throw new Error('bad_address');
          const result = upsertServer({ name: body.name, ip: address, dir: configuredMinecraftDir() });
          // The game reads `servers.dat` at startup and writes its in-memory
          // list back on exit. If the player is in a different instance than
          // the configured one, the entry has to land there as well or it is
          // never shown to them.
          const primaryDir = path.dirname(result.file);
          const running = runningGameDir();
          const files = [result.file];
          if (running && running.dir.toLowerCase() !== primaryDir.toLowerCase()) {
            try {
              const extra = upsertServer({ name: body.name, ip: address, dir: running.dir });
              if (!files.includes(extra.file)) files.push(extra.file);
            } catch {
              // the configured folder is what matters; a second copy is a bonus
            }
          }
          pushLog('ok', `мир добавлен в список серверов: ${result.name} → ${files.join('; ')}`);
          ui.pendingServer = {
            name: result.name,
            ip: address,
            until: Date.now() + PENDING_SERVER_MS,
          };
          json(res, 200, { ...result, files, running: Boolean(running) });
          return;
        }
        case '/api/minecraft/path': {
          const value = String(body.dir || '').trim();
          if (value && !resolveGameDir(value)) throw new Error('minecraft_not_found');
          const p = loadProfile();
          p.settings = { ...(p.settings || {}), minecraftDir: value };
          saveProfile(p);
          scanGameDirs({ refresh: true });
          const info = minecraftInfo(p);
          pushLog('info', info.dir ? `папка Minecraft: ${info.dir}` : 'папка Minecraft: автоопределение');
          json(res, 200, { ok: true, ...info });
          return;
        }
        case '/api/minecraft/server': {
          const value = String(body.dir || '').trim();
          if (value && !findServerDir(value)) throw new Error('minecraft_server_not_found');
          const p = loadProfile();
          p.settings = { ...(p.settings || {}), minecraftServerDir: value };
          saveProfile(p);
          ui.server = await serverInfo(value, { refresh: true });
          pushLog('info', ui.server.dir
            ? `сервер Minecraft: ${ui.server.dir}${ui.server.running ? ` (порт ${ui.server.port})` : ' (не запущен)'}`
            : 'сервер Minecraft: папка не выбрана');
          json(res, 200, { ok: true, ...ui.server });
          return;
        }
        case '/api/minecraft/pick': {
          const picked = ELECTRON?.pickDirectory
            ? await ELECTRON.pickDirectory()
            : await pickDirectoryFallback();
          if (!picked) {
            json(res, 200, { ok: false, cancelled: true });
            return;
          }
          const resolved = resolveGameDir(picked);
          json(res, 200, { ok: Boolean(resolved), path: picked, dir: resolved || '' });
          return;
        }
        case '/api/play/refresh': {
          const p = loadProfile();
          json(res, 200, { ok: true, play: playInfo(p.settings || {}, { refresh: true }) });
          return;
        }
        case '/api/play/select': {
          const p = loadProfile();
          p.settings = {
            ...(p.settings || {}),
            playLauncher: String(body.launcher || ''),
            playInstance: String(body.instance || ''),
          };
          saveProfile(p);
          json(res, 200, { ok: true, play: playInfo(p.settings) });
          return;
        }
        case '/api/play/launch': {
          const p = loadProfile();
          const result = await launchGame({
            launcher: body.launcher,
            instance: body.instance,
            address: body.address,
            name: body.name,
            settings: p.settings || {},
          });
          pushLog('ok', `Nurofen Play: ${result.message}${result.address ? ` (${result.address})` : ''}`);
          json(res, 200, result);
          return;
        }
        case '/api/play/exe': {
          const value = String(body.path || '').trim();
          if (value && !fs.existsSync(value)) throw new Error('play_exe_invalid');
          const p = loadProfile();
          p.settings = { ...(p.settings || {}), playExe: value };
          saveProfile(p);
          json(res, 200, { ok: true, play: playInfo(p.settings, { refresh: true }) });
          return;
        }
        case '/api/play/pick': {
          const picked = ELECTRON?.pickFile
            ? await ELECTRON.pickFile()
            : await pickFileFallback();
          json(res, 200, picked ? { ok: true, path: picked } : { ok: false, cancelled: true });
          return;
        }
        case '/api/files/send': {
          const transfer = startSend({
            profile: loadProfile(),
            networkId: String(body.networkId || ''),
            peerId: String(body.peerId || ''),
            filePath: String(body.path || ''),
          });
          pushLog('info', `передача файла «${transfer.name}» → ${transfer.peerName}`);
          json(res, 200, { ok: true, transfer });
          return;
        }
        case '/api/files/pick-dir': {
          const picked = ELECTRON?.pickDirectory
            ? await ELECTRON.pickDirectory('Папка для принятых файлов')
            : await pickDirectoryFallback('Папка для принятых файлов');
          json(res, 200, picked ? { ok: true, path: picked } : { ok: false, cancelled: true });
          return;
        }
        case '/api/files/pick': {
          const picked = ELECTRON?.pickDocument
            ? await ELECTRON.pickDocument()
            : await pickAnyFileFallback();
          if (!picked) {
            json(res, 200, { ok: false, cancelled: true });
            return;
          }
          const stat = fs.statSync(picked);
          json(res, 200, {
            ok: true,
            path: picked,
            name: path.basename(picked),
            size: stat.isFile() ? stat.size : 0,
          });
          return;
        }
        case '/api/files/accept':
          json(res, 200, acceptTransfer(body.id));
          return;
        case '/api/files/decline':
          json(res, 200, declineTransfer(body.id));
          return;
        case '/api/files/cancel':
          json(res, 200, cancelTransfer(body.id));
          return;
        case '/api/files/dismiss':
          json(res, 200, dismissTransfer(body.id));
          return;
        case '/api/files/reveal': {
          const target = transferPath(body.id);
          if (!target) throw new Error('Файл ещё не сохранён.');
          if (ELECTRON?.reveal) ELECTRON.reveal(target);
          else spawn('explorer.exe', ['/select,', target], { detached: true, stdio: 'ignore' }).unref();
          json(res, 200, { ok: true });
          return;
        }
        case '/api/remote/start': {
          const [networkId, peerId] = String(body.target || '').split('|');
          const session = startRemote({
            profile: loadProfile(),
            networkId: String(body.networkId || networkId || ''),
            peerId: String(body.peerId || peerId || ''),
            control: body.control === true,
          });
          pushLog('info', `удалённая помощь: запрос к ${session.peerName}${session.controlRequested ? ' (с управлением)' : ''}`);
          json(res, 200, { ok: true, session });
          return;
        }
        case '/api/remote/accept':
          json(res, 200, acceptRemote(body.id, body.control === true));
          return;
        case '/api/remote/decline':
          json(res, 200, declineRemote(body.id));
          return;
        case '/api/remote/stop':
          json(res, 200, stopRemoteSession(body.id));
          return;
        case '/api/remote/control':
          json(res, 200, setRemoteControl(body.id, body.control === true));
          return;
        case '/api/remote/input':
          json(res, 200, remoteInput(body.id, body.events));
          return;
        case '/api/remote/dismiss':
          json(res, 200, dismissRemote(body.id));
          return;
        case '/api/friends/add': {
          const peerId = String(body.peerId || '').trim();
          const found = findPeerAnywhere(peerId);
          if (!found) throw new Error('Участник не найден в подключённых сетях.');
          const p = loadProfile();
          const existing = p.friends.find((item) => item.peerId === peerId);
          const entry = {
            peerId,
            name: found.peer.name || 'Друг',
            ip: found.peer.ip || '',
            networkId: found.networkId,
            networkName: found.networkName,
            addedAt: existing?.addedAt || new Date().toISOString(),
          };
          if (existing) Object.assign(existing, entry);
          else p.friends.push(entry);
          saveProfile(p);
          json(res, 200, { ok: true });
          return;
        }
        case '/api/friends/remove': {
          const peerId = String(body.peerId || '').trim();
          const p = loadProfile();
          p.friends = p.friends.filter((item) => item.peerId !== peerId);
          saveProfile(p);
          json(res, 200, { ok: true });
          return;
        }
        case '/api/update/check': {
          const result = await checkForUpdate();
          json(res, 200, { ok: true, update: { ...result } });
          return;
        }
        case '/api/update/apply': {
          const result = await applyUpdate();
          json(res, 200, result);
          return;
        }
        case '/api/update/dismiss': {
          update.available = false;
          json(res, 200, { ok: true });
          return;
        }
        case '/api/helper/restart': {
          const result = await forceUpdateHelper();
          json(res, 200, result);
          return;
        }
        case '/api/action': {
          if (body.name === 'toggle') {
            const active = memberById(loadProfile().activeId);
            if (!active) {
              json(res, 200, { ok: false, error: 'no_network' });
              return;
            }
            const state = runtimeFor(active.id);
            json(res, 200, state.status === 'connected'
              ? await disconnect(active.id, { manual: true })
              : await connect(active.id));
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
    // An older copy (without the instance pipe) already serves the UI.
    log('[ui] already running, focusing the existing window');
    if (ELECTRON) {
      ELECTRON.focus?.();
      return;
    }
    showWindow().finally(() => process.exit(0));
    return;
  }
  log(`[ui] ${error.message}`);
});

/* ------------------------------------------- browser fallback (no Electron) */

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

const WINDOW_WIDTH = 340;
const WINDOW_HEIGHT = 680;

function windowProfileDir() {
  const dir = path.join(dataDir(), 'window');
  const stamp = path.join(dataDir(), 'window-size');
  const want = `${WINDOW_WIDTH}x${WINDOW_HEIGHT}`;
  let previous = '';
  try {
    previous = fs.readFileSync(stamp, 'utf8').trim();
  } catch {
    previous = '';
  }
  if (previous !== want) {
    let cleaned = true;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      cleaned = false;
    }
    if (cleaned) {
      try {
        fs.writeFileSync(stamp, want);
      } catch {
        // ignore
      }
    }
  }
  return dir;
}

function focusExistingWindow() {
  const script = path.join(HERE, 'focus.ps1');
  if (!fs.existsSync(script)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.once('error', () => resolve(false));
    child.once('close', () => resolve(out.includes('focused')));
  });
}

async function showWindow() {
  if (ELECTRON) {
    ELECTRON.focus?.();
    return;
  }
  if (await focusExistingWindow()) return;
  openWindow();
}

function instanceAlive() {
  return new Promise((resolve) => {
    const socket = net.connect(INSTANCE_PIPE);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function claimInstance() {
  return new Promise((resolve) => {
    const srv = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.end('window');
      showWindow().catch(() => {});
    });
    srv.once('error', () => resolve(false));
    srv.listen(INSTANCE_PIPE, () => resolve(true));
  });
}

function openWindow() {
  if (ELECTRON) {
    ELECTRON.open?.();
    return;
  }
  const url = `http://127.0.0.1:${UI_PORT}/`;
  const browser = browserPath();
  if (browser) {
    spawn(
      browser,
      [
        `--app=${url}`,
        `--window-size=${WINDOW_WIDTH},${WINDOW_HEIGHT}`,
        `--user-data-dir=${windowProfileDir()}`,
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
  if (ELECTRON) return;
  const script = path.join(HERE, 'tray.ps1');
  const icon = path.join(HERE, '..', 'assets', 'nurofen.ico');
  if (!fs.existsSync(script)) return;
  spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-Port', String(UI_PORT), '-Icon', icon],
    { detached: true, stdio: 'ignore', windowsHide: true },
  ).unref();
}

/* -------------------------------------------------------------------- main */

async function main() {
  if (FORCE_HELPER) {
    startHelper(console, APP_VERSION);
    return;
  }

  if (!ELECTRON) {
    if (await instanceAlive()) {
      log('[app] уже запущен, показываю существующее окно');
      await showWindow();
      process.exit(0);
    }
    if (!(await claimInstance())) {
      log('[app] уже запущен, показываю существующее окно');
      await showWindow();
      process.exit(0);
    }
  }

  ensureDir(dataDir());
  const p = syncRuntime();
  log(`[app] starting, networks=${p.networks.length} profile=${dataDir()}`);

  initFiles({
    getProfile: () => loadProfile(),
    getNetworks: fileNetworks,
    getSelf: fileSelf,
    showWindow: () => { showWindow().catch(() => {}); },
    notify: notifyDesktop,
    log: (level, message) => pushLog(level, message),
  });

  initRemote({
    getProfile: () => loadProfile(),
    getNetworks: fileNetworks,
    getSelf: fileSelf,
    showWindow: () => { showWindow().catch(() => {}); },
    notify: notifyDesktop,
    log: (level, message) => pushLog(level, message),
  });

  const info = await helperInfo();
  ui.helper = Boolean(info);
  ui.helperVersion = info?.version || '';
  ui.awg = Boolean(findAwg());
  pushLog('info', ui.helper ? 'служба-помощник на связи' : 'служба-помощник не запущена');
  if (ui.helper && compareVersions(ui.helperVersion, APP_VERSION) < 0) {
    pushLog('warn', `служба-помощник ${ui.helperVersion || '?'} при клиенте ${APP_VERSION}: обновляю`);
    reloadHelper(APP_VERSION, 10000)
      .then((ok) => {
        if (ok) {
          pushLog('ok', `служба-помощник обновлена до ${APP_VERSION}`);
          ensureFirewall(allTunnelPorts(loadProfile())).catch(() => {});
        } else {
          pushLog('warn', 'служба-помощник не обновилась сама: откройте «Обновление» и нажмите «Обновить службу»');
        }
      })
      .catch(() => {});
  }
  if (ui.helper) ensureFirewall(allTunnelPorts(p)).catch(() => {});
  if (!ui.awg) pushLog('warn', 'AmneziaWG не найден');

  server.listen(UI_PORT, '127.0.0.1', () => {
    log(`[ui] http://127.0.0.1:${UI_PORT}`);
    if (!NO_WINDOW) openWindow();
    startTray();
  });

  startHeartbeat();
  tickTimer = setInterval(() => {
    tick().catch((error) => log(`[tick] ${error.message}`));
  }, 3000);
  tick().catch(() => {});

  // Bring back only the networks the user left switched on.
  setTimeout(() => {
    const profile = loadProfile();
    if (profile.settings?.autoConnect !== false) {
      for (const member of profile.networks) {
        if (member.autoConnect && member.lastPort && joined(member)) connect(member.id).catch(() => {});
      }
    }
  }, 1200);

  setTimeout(() => {
    checkForUpdate({ quiet: true }).catch(() => {});
  }, 8000);
  setInterval(() => {
    checkForUpdate({ quiet: true }).catch(() => {});
  }, 6 * 60 * 60 * 1000);

  process.on('SIGINT', () => {
    stopRemote();
    stopFiles();
    disconnectAll().finally(() => process.exit(0));
  });
}

main().catch((error) => {
  log(`[fatal] ${error.stack || error.message}`);
  process.exit(1);
});
