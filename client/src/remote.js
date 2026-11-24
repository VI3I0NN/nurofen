import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { REMOTE_PORTS } from './paths.js';

/**
 * Remote help over the virtual LAN.
 *
 * A viewer asks a peer to share the screen. The host sees the request in the
 * main window and chooses "view only" or "view and control"; nothing is shared
 * until that choice. Screen frames travel host → viewer over a single TCP
 * connection in the tunnel, input events travel back viewer → host. Input is
 * injected by a small PowerShell helper that uses SendInput.
 *
 * Safety rules, all deliberate:
 *   - the sender must be an online member of a connected Nurofen network;
 *   - the token is one-time and bound to the socket, like file transfer;
 *   - control is off unless the host explicitly allowed it;
 *   - the session ends when either side closes the window, the socket drops,
 *     or the host presses "Остановить";
 *   - an incoming request is never accepted automatically.
 */

const MAX_TRANSFER_FRAME = 6 * 1024 * 1024;
const TEST_PORTS = process.env.NUROFEN_REMOTE_TEST_PORTS
  ?.split(',')
  .map((value) => Number(value.trim()))
  .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
const LISTEN_PORTS = TEST_PORTS?.length ? TEST_PORTS : REMOTE_PORTS;
const OFFER_TIMEOUT_MS = 120 * 1000;
const CONNECT_TIMEOUT_MS = 8 * 1000;
const PING_MS = 15 * 1000;
const DEAD_MS = 60 * 1000;
const KEEP_ENDED_MS = 5 * 60 * 1000;
const MAX_PENDING = 2;
const FRAME_MS = 350;
const FRAME_WIDTH = 1280;
const FRAME_HEIGHT = 720;
const JPEG_QUALITY = 60;
const STREAM_FPS = 15;
const STREAM_QUALITY = 0.55;
const CAPTURE_PARTITION = 'nurofen-capture';
const CAPTURE_START_MS = 8 * 1000;
const CAPTURE_IDLE_MS = 30 * 1000;
const MAX_EVENTS = 64;

const BOUNDARY = 'nurofenframe';
const HERE = path.dirname(fileURLToPath(import.meta.url));

let ctx = null;
let server = null;
let boundPort = 0;
let electronModule; // undefined: not probed, null: unavailable
const pending = new Map(); // host sessions awaiting consent
const sessions = new Map(); // accepted sessions, both roles

// Shared screen stream. One hidden window captures the desktop and broadcasts
// JPEG frames to every active host session, so several viewers do not each pay
// for a capture pipeline.
let captureWin = null;
let captureSource = null;
let captureActive = false;
let captureStarting = null;
let captureIpcReady = false;
let captureHandlerReady = false;
let captureUsers = 0;
let captureResolve = null;
let captureReject = null;
let captureIdle = null;
let captureError = '';

/* ------------------------------------------------------------------ module */

export function initRemote(context) {
  ctx = context;
  if (server) return;
  startServer();
}

export function stopRemote() {
  for (const session of [...pending.values()]) declineRemote(session.id);
  for (const session of [...sessions.values()]) {
    if (!TERMINAL.has(session.status)) endSession(session, 'app', 'Nurofen закрывается.');
  }
  stopStreamCapture(true);
  if (server) {
    try {
      server.close();
    } catch {
      // already closing
    }
    server = null;
    boundPort = 0;
  }
  electronModule = undefined;
}

const TERMINAL = new Set(['ended', 'declined', 'error', 'timeout']);

export function remoteEnabled(profile) {
  return profile?.settings?.remoteAllowed !== false;
}

export function remoteSnapshot(profile = {}) {
  cleanup();
  const incoming = [...pending.values()]
    .filter((session) => session.status === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(pendingView);
  const host = pickSession('host');
  const viewer = pickSession('viewer');
  return {
    allowed: remoteEnabled(profile),
    available: Boolean(server && boundPort),
    port: boundPort,
    supports: supported(),
    incoming,
    host: host ? sessionView(host) : null,
    viewer: viewer ? sessionView(viewer) : null,
  };
}

/* ---------------------------------------------------------------- viewer */

export function startRemote({ profile, networkId, peerId, control }) {
  if (!ctx) throw new Error('Удалённая помощь ещё не готова.');
  if (!remoteEnabled(profile)) {
    throw new Error('Удалённая помощь отключена в настройках.');
  }
  if (currentViewer()) throw new Error('Сеанс удалённой помощи уже идёт.');
  const peer = peerForSend(networkId, peerId);
  if (!peer) throw new Error('Участник не в сети — помощь недоступна.');

  const session = {
    id: randomUUID(),
    token: randomBytes(24).toString('hex'),
    role: 'viewer',
    status: 'connecting',
    controlRequested: Boolean(control),
    control: false,
    peerId: peer.peerId,
    peerName: peer.name,
    peerIp: peer.ip,
    networkId: peer.networkId,
    networkName: peer.networkName,
    fromName: ctx.getSelf?.(peer.networkId)?.name || '',
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    error: '',
    socket: null,
    timer: null,
    pingTimer: null,
    frame: null,
    width: 0,
    height: 0,
    frames: 0,
    bytes: 0,
    rateAt: Date.now(),
    rateFrames: 0,
    rateBytes: 0,
    fps: 0,
    kbps: 0,
    lastPing: Date.now(),
  };
  sessions.set(session.id, session);
  runViewer(session, peer).catch((error) => {
    if (TERMINAL.has(session.status)) return;
    endSession(session, 'error', error.message || 'Не удалось подключиться.');
  });
  return sessionView(session);
}

async function runViewer(session, peer) {
  const socket = await connectAny(peer.ip);
  if (session.status === 'ended' || session.status === 'error') {
    socket.destroy();
    return;
  }
  session.socket = socket;
  socket.setNoDelay(true);
  // Tag the socket before the reader starts, so binary frames can be attached
  // to this session without another closure per connection.
  socket.__nurofenViewer = session;
  session.status = 'waiting';
  const reader = frameReader(socket, (payload) => {
    let message;
    try {
      message = JSON.parse(payload.toString('utf8'));
    } catch {
      return;
    }
    onViewerMessage(session, message);
  });
  socket.on('close', () => {
    reader.stop();
    if (TERMINAL.has(session.status)) return;
    endSession(session, 'closed', 'Соединение закрыто.');
  });
  socket.on('error', (error) => {
    if (TERMINAL.has(session.status)) return;
    endSession(session, 'error', networkError(error));
  });
  sendJson(socket, {
    t: 'offer',
    id: session.id,
    token: session.token,
    control: session.controlRequested,
    from: { name: session.fromName },
    network: session.networkName,
  });

  session.timer = setTimeout(() => {
    if (session.status === 'waiting') endSession(session, 'timeout', 'Получатель не ответил.');
  }, OFFER_TIMEOUT_MS + 10 * 1000);

  session.pingTimer = setInterval(() => {
    if (session.status !== 'active') return;
    sendJson(socket, { t: 'ping' });
    if (Date.now() - session.lastPing > DEAD_MS) {
      endSession(session, 'timeout', 'Связь потеряна.');
    }
  }, PING_MS);
}

function onViewerMessage(session, message) {
  if (!message || typeof message.t !== 'string') return;
  if (message.t === 'accept') {
    if (session.status !== 'waiting' && session.status !== 'connecting') return;
    clearTimeout(session.timer);
    session.timer = null;
    session.control = Boolean(message.control);
    session.status = 'active';
    session.startedAt = Date.now();
    session.lastPing = Date.now();
    session.streams = session.streams || new Set();
    pushLog('info', `удалённая помощь: ${session.peerName} разрешил${session.control ? ' управление' : ' просмотр'}`);
    return;
  }
  if (message.t === 'decline') {
    endSession(session, 'declined', String(message.error || 'Получатель отклонил запрос.'));
    return;
  }
  if (message.t === 'hello') {
    session.width = Number(message.width) || session.width;
    session.height = Number(message.height) || session.height;
    session.control = Boolean(message.control);
    session.lastPing = Date.now();
    return;
  }
  if (message.t === 'frame') {
    // Frames arrive as binary parts; a JSON marker only carries size hints.
    if (message.width) session.width = Number(message.width) || session.width;
    if (message.height) session.height = Number(message.height) || session.height;
    return;
  }
  if (message.t === 'control') {
    session.control = Boolean(message.control) && session.controlRequested;
    return;
  }
  if (message.t === 'pong') {
    session.lastPing = Date.now();
    return;
  }
  if (message.t === 'end') {
    endSession(session, 'ended', String(message.reason || 'Сеанс завершён.'));
  }
}

function attachFrame(session, jpeg) {
  session.frame = jpeg;
  session.frames += 1;
  session.bytes += jpeg.length;
  session.lastPing = Date.now();
  const now = Date.now();
  session.rateFrames += 1;
  session.rateBytes += jpeg.length;
  if (now - session.rateAt >= 1000) {
    session.fps = Math.round((session.rateFrames * 1000) / (now - session.rateAt));
    session.kbps = Math.round((session.rateBytes * 8) / (now - session.rateAt));
    session.rateAt = now;
    session.rateFrames = 0;
    session.rateBytes = 0;
  }
  for (const res of session.streams || []) {
    if (res.writableEnded || res.destroyed) {
      session.streams.delete(res);
      continue;
    }
    if (res.writableLength > 2 * 1024 * 1024) continue;
    writeStreamFrame(res, session);
  }
}

function connectAny(ip) {
  return new Promise((resolve, reject) => {
    let index = 0;
    const attempt = () => {
      if (index >= LISTEN_PORTS.length) {
        reject(new Error('У участника не запущена удалённая помощь. Попросите обновить Nurofen.'));
        return;
      }
      const port = LISTEN_PORTS[index];
      index += 1;
      const socket = net.createConnection({ host: ip, port });
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        attempt();
      };
      socket.setTimeout(CONNECT_TIMEOUT_MS, fail);
      socket.once('error', fail);
      socket.once('close', () => {
        if (!settled) fail();
      });
      socket.once('connect', () => {
        if (settled) return;
        settled = true;
        socket.setTimeout(0);
        socket.removeListener('error', fail);
        resolve(socket);
      });
    };
    attempt();
  });
}

/* ------------------------------------------------------------------ host */

function handleConnection(socket) {
  const remote = normalizeIp(socket.remoteAddress);
  const trust = trustedPeer(remote);
  socket.setNoDelay(true);
  socket.setTimeout(20 * 1000);

  let session = null;
  let answered = false;
  const reader = frameReader(socket, (payload) => {
    let message;
    try {
      message = JSON.parse(payload.toString('utf8'));
    } catch {
      return;
    }
    if (!session) {
      if (message.t !== 'offer') {
        socket.destroy();
        return;
      }
      session = beginOffer(socket, remote, trust, message);
      if (!session) return;
      socket.setTimeout(0);
      waitConsent(session)
        .then((decision) => {
          if (answered) return;
          answered = true;
          if (!decision.accepted) {
            sendJson(socket, { t: 'decline', error: decision.error || 'Запрос отклонён.' });
            settleDecline(session);
            setTimeout(() => socket.destroy(), 300);
            return;
          }
          acceptHost(session).catch((error) => {
            sendJson(socket, { t: 'decline', error: error.message || 'Не удалось начать сеанс.' });
            settleDecline(session);
            setTimeout(() => socket.destroy(), 300);
          });
        })
        .catch(() => {});
      return;
    }
    if (message.t === 'input') {
      applyInput(session, message.list);
      return;
    }
    if (message.t === 'ping') {
      sendJson(socket, { t: 'pong' });
      session.lastPing = Date.now();
      return;
    }
    if (message.t === 'end') {
      endSession(session, 'ended', 'Пользователь завершил сеанс.');
    }
  });

  socket.on('close', () => {
    reader.stop();
    if (session && !TERMINAL.has(session.status)) {
      if (session.status === 'pending') settleDecline(session);
      else endSession(session, 'closed', 'Соединение закрыто.');
    }
  });
  socket.on('error', () => {
    // close fires next and does the cleanup
  });
  socket.on('timeout', () => {
    // Only the handshake is guarded: an accepted session runs without a
    // socket timeout and relies on ping frames instead.
    if (!session) socket.destroy();
  });
}

function beginOffer(socket, remote, trust, message) {
  const id = String(message.id || '').trim();
  const token = String(message.token || '').trim();
  if (!/^[0-9a-f-]{20,64}$/i.test(id) || !/^[0-9a-f]{16,128}$/i.test(token)) {
    socket.destroy();
    return null;
  }
  if (!trust) {
    sendJson(socket, { t: 'decline', error: 'Этот адрес не входит в вашу сеть.' });
    setTimeout(() => socket.destroy(), 300);
    return null;
  }
  const profile = ctx?.getProfile?.() || {};
  if (!remoteEnabled(profile)) {
    sendJson(socket, { t: 'decline', error: 'На этом компьютере удалённая помощь отключена.' });
    setTimeout(() => socket.destroy(), 300);
    return null;
  }
  if (currentHost()) {
    sendJson(socket, { t: 'decline', error: 'Уже идёт сеанс удалённой помощи.' });
    setTimeout(() => socket.destroy(), 300);
    return null;
  }
  if (pending.size >= MAX_PENDING) {
    sendJson(socket, { t: 'decline', error: 'Слишком много входящих запросов.' });
    setTimeout(() => socket.destroy(), 300);
    return null;
  }
  if (sessions.has(id) || pending.has(id)) {
    sendJson(socket, { t: 'decline', error: 'Такой запрос уже есть.' });
    setTimeout(() => socket.destroy(), 300);
    return null;
  }

  const peer = trust.peer || {};
  const session = {
    id,
    token,
    role: 'host',
    status: 'pending',
    controlRequested: Boolean(message.control),
    control: false,
    peerId: peer.peerId || '',
    peerName: peer.name || String(message.from?.name || remote),
    peerIp: remote,
    networkId: peer.networkId || '',
    networkName: peer.networkName || String(message.network || ''),
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    error: '',
    socket,
    timer: null,
    consentResolve: null,
    agent: null,
    loop: null,
    busy: false,
    streamCapture: false,
    frame: null,
    lastJpeg: null,
    width: 0,
    height: 0,
    frames: 0,
    bytes: 0,
    rateAt: Date.now(),
    rateFrames: 0,
    rateBytes: 0,
    fps: 0,
    kbps: 0,
    lastPing: Date.now(),
  };
  pending.set(id, session);
  pushLog('info', `удалённая помощь: запрос от ${session.peerName}${session.controlRequested ? ' (с управлением)' : ''}`);
  try {
    ctx?.showWindow?.();
  } catch {
    // the window is a convenience, the request still stands
  }
  ctx?.notify?.(
    'Удалённая помощь',
    `${session.peerName} просит доступ к экрану${session.controlRequested ? ' и управлению' : ''}`,
  );
  return session;
}

function waitConsent(session) {
  return new Promise((resolve) => {
    session.consentResolve = resolve;
    session.timer = setTimeout(() => {
      if (session.status !== 'pending') return;
      session.status = 'declined';
      session.endedAt = Date.now();
      session.consentResolve = null;
      resolve({ accepted: false, error: 'Время ожидания истекло.' });
    }, OFFER_TIMEOUT_MS);
  });
}

async function acceptHost(session) {
  pending.delete(session.id);
  clearTimeout(session.timer);
  session.consentResolve = null;
  session.status = 'connecting';
  sessions.set(session.id, session);

  let capture;
  try {
    capture = await grabScreen();
  } catch (error) {
    session.status = 'error';
    session.error = error.message || 'Не удалось захватить экран.';
    session.endedAt = Date.now();
    throw error;
  }
  session.width = capture.width;
  session.height = capture.height;
  session.frame = capture.jpeg;
  session.lastJpeg = capture.jpeg;

  sendJson(session.socket, { t: 'accept', control: session.control });
  sendJson(session.socket, { t: 'hello', width: session.width, height: session.height, control: session.control });
  sendFrame(session.socket, session.frame);

  session.status = 'active';
  session.startedAt = Date.now();
  session.lastPing = Date.now();
  if (session.control) session.agent = startAgent();
  // A slow fallback keeps the session alive until the stream is ready; it is
  // also the permanent path when the stream cannot start at all.
  session.loop = setInterval(() => captureTick(session), FRAME_MS);
  session.pingTimer = setInterval(() => {
    if (Date.now() - session.lastPing > DEAD_MS) {
      endSession(session, 'timeout', 'Связь потеряна.');
    }
  }, PING_MS);
  beginStreamCapture(session);
  pushLog('ok', `удалённая помощь: сеанс с ${session.peerName}${session.control ? ' (управление)' : ' (просмотр)'}`);
}

async function captureTick(session) {
  if (session.busy || session.status !== 'active' || session.streamCapture) return;
  session.busy = true;
  try {
    const capture = await grabScreen();
    deliverFrame(session, capture.jpeg, capture.width, capture.height);
  } catch (error) {
    endSession(session, 'error', error.message || 'Захват экрана остановился.');
  } finally {
    session.busy = false;
  }
}

function deliverFrame(session, jpeg, width, height) {
  if (session.status !== 'active' || !session.socket || !jpeg?.length) return;
  session.width = width;
  session.height = height;
  if (session.lastJpeg && jpeg.equals(session.lastJpeg)) {
    updateRate(session);
    return;
  }
  session.lastJpeg = jpeg;
  session.frame = jpeg;
  sendFrame(session.socket, jpeg);
  session.frames += 1;
  session.bytes += jpeg.length;
  session.rateFrames += 1;
  session.rateBytes += jpeg.length;
  updateRate(session);
}

function updateRate(session) {
  const now = Date.now();
  if (now - session.rateAt < 1000) return;
  session.fps = Math.round((session.rateFrames * 1000) / (now - session.rateAt));
  session.kbps = Math.round((session.rateBytes * 8) / (now - session.rateAt));
  session.rateAt = now;
  session.rateFrames = 0;
  session.rateBytes = 0;
}

/* --------------------------------------------------------- screen stream */

async function beginStreamCapture(session) {
  captureUsers += 1;
  const ok = await startStreamCapture();
  if (!ok || session.status !== 'active') {
    captureUsers = Math.max(0, captureUsers - 1);
    releaseStreamCapture();
    return;
  }
  session.streamCapture = true;
  if (session.loop) {
    clearInterval(session.loop);
    session.loop = null;
  }
}

async function startStreamCapture() {
  if (captureActive) return true;
  if (captureStarting) return captureStarting;
  captureStarting = (async () => {
    try {
      const electron = await electronApi();
      if (!electron?.BrowserWindow || !electron?.ipcMain || !electron?.desktopCapturer) {
        throw new Error('Потоковый захват недоступен.');
      }
      if (captureIdle) {
        clearTimeout(captureIdle);
        captureIdle = null;
      }
      installCaptureIpc(electron);
      installDisplayHandler(electron);
      const primary = electron.screen?.getPrimaryDisplay?.();
      const sources = await electron.desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      });
      if (!sources.length) throw new Error('Не удалось захватить экран.');
      captureSource = (primary && sources.find((item) => String(item.display_id) === String(primary.id)))
        || sources[0];
      const win = await ensureCaptureWindow(electron);
      const ready = new Promise((resolve, reject) => {
        captureResolve = resolve;
        captureReject = reject;
      });
      captureActive = true;
      captureError = '';
      win.webContents.send('nurofen-capture:start', {
        maxWidth: FRAME_WIDTH,
        maxHeight: FRAME_HEIGHT,
        fps: STREAM_FPS,
        quality: STREAM_QUALITY,
      });
      let timer = 0;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Захват экрана не ответил.')), CAPTURE_START_MS);
      });
      try {
        await Promise.race([ready, timeout]);
      } finally {
        clearTimeout(timer);
      }
      if (captureActive) pushLog('info', 'удалённая помощь: плавный захват экрана включён');
      return captureActive;
    } catch (error) {
      captureActive = false;
      captureError = error.message || 'Захват экрана недоступен.';
      pushLog('warn', `удалённая помощь: плавный захват недоступен (${captureError})`);
      return false;
    } finally {
      captureStarting = null;
      captureResolve = null;
      captureReject = null;
    }
  })();
  return captureStarting;
}

function releaseStreamCapture() {
  if (captureUsers > 0) return;
  stopStreamCapture(false);
}

function stopStreamCapture(immediate) {
  captureActive = false;
  const resolve = captureResolve;
  captureResolve = null;
  captureReject = null;
  resolve?.(false);
  if (captureIdle) {
    clearTimeout(captureIdle);
    captureIdle = null;
  }
  if (!captureWin || captureWin.isDestroyed()) {
    captureWin = null;
    captureSource = null;
    return;
  }
  try {
    captureWin.webContents.send('nurofen-capture:stop');
  } catch {
    // the window is already going away
  }
  if (immediate) {
    try {
      captureWin.destroy();
    } catch {
      // ignore
    }
    captureWin = null;
    captureSource = null;
    return;
  }
  captureIdle = setTimeout(() => {
    captureIdle = null;
    if (captureActive) return;
    try {
      captureWin?.destroy();
    } catch {
      // ignore
    }
    captureWin = null;
    captureSource = null;
  }, CAPTURE_IDLE_MS);
}

function captureFailed(reason) {
  const wasActive = captureActive;
  captureActive = false;
  captureError = reason || 'Захват экрана остановился.';
  const reject = captureReject;
  captureResolve = null;
  captureReject = null;
  reject?.(new Error(captureError));
  const win = captureWin;
  captureWin = null;
  captureSource = null;
  captureUsers = 0;
  try {
    win?.destroy();
  } catch {
    // ignore
  }
  if (!wasActive) return;
  for (const session of sessions.values()) {
    if (session.role !== 'host' || session.status !== 'active' || !session.streamCapture) continue;
    session.streamCapture = false;
    if (!session.loop) session.loop = setInterval(() => captureTick(session), FRAME_MS);
  }
  pushLog('warn', `удалённая помощь: ${captureError} Перехожу на медленный захват.`);
}

async function ensureCaptureWindow(electron) {
  if (captureWin && !captureWin.isDestroyed()) return captureWin;
  captureWin = null;
  const win = new electron.BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    frame: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#000000',
    title: 'Nurofen — захват экрана',
    webPreferences: {
      partition: CAPTURE_PARTITION,
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
      devTools: false,
      webSecurity: true,
    },
  });
  win.setMenu?.(null);
  win.setSkipTaskbar?.(true);
  win.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('render-process-gone', () => {
    if (captureWin === win) captureFailed('Захват экрана остановился.');
  });
  win.on('closed', () => {
    if (captureWin !== win) return;
    captureWin = null;
    captureSource = null;
    if (captureActive) captureFailed('Захват экрана остановился.');
  });
  captureWin = win;
  await win.loadFile(path.join(HERE, 'capture.html'));
  return win;
}

function installDisplayHandler(electron) {
  if (captureHandlerReady) return;
  captureHandlerReady = true;
  const captureSession = electron.session.fromPartition(CAPTURE_PARTITION);
  captureSession.setDisplayMediaRequestHandler((request, callback) => {
    if (!captureSource) {
      callback({});
      return;
    }
    callback({ video: captureSource });
  }, { useSystemPicker: false });
}

function installCaptureIpc(electron) {
  if (captureIpcReady) return;
  captureIpcReady = true;
  electron.ipcMain.on('nurofen-capture:frame', (event, data, width, height) => {
    if (!captureActive) return;
    if (!captureWin || event.sender !== captureWin.webContents) return;
    const jpeg = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!jpeg.length) return;
    const resolve = captureResolve;
    captureResolve = null;
    resolve?.(true);
    const w = Math.max(1, Math.round(Number(width) || 0));
    const h = Math.max(1, Math.round(Number(height) || 0));
    for (const session of sessions.values()) {
      if (session.role !== 'host' || session.status !== 'active' || !session.streamCapture) continue;
      deliverFrame(session, jpeg, w, h);
    }
  });
  electron.ipcMain.on('nurofen-capture:error', (event, message) => {
    if (captureWin && event.sender !== captureWin.webContents) return;
    captureFailed(String(message || 'Захват экрана недоступен.'));
  });
}

/* ----------------------------------------------------------------- input */

function applyInput(session, list) {
  if (!session || !session.control || session.role !== 'host') return;
  if (!Array.isArray(list) || !list.length) return;
  if (!session.agent) session.agent = startAgent();
  if (!session.agent) return;
  const events = list.slice(0, MAX_EVENTS);
  let lastMove = null;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.t === 'm') {
      lastMove = event;
      continue;
    }
    if (lastMove) {
      writeMove(session.agent, lastMove);
      lastMove = null;
    }
    if (event.t === 'b') {
      const button = ['left', 'right', 'middle'].includes(event.b) ? event.b : '';
      if (button) writeAgent(session.agent, `b ${button} ${event.d ? 1 : 0}`);
      continue;
    }
    if (event.t === 'w') {
      const delta = Math.max(-2400, Math.min(2400, Math.round(Number(event.d) || 0)));
      if (delta) writeAgent(session.agent, `w ${delta}`);
      continue;
    }
    if (event.t === 'k') {
      const vk = Math.round(Number(event.vk) || 0);
      if (vk > 0 && vk < 256) writeAgent(session.agent, `k ${vk} ${event.d ? 1 : 0}`);
      continue;
    }
    if (event.t === 'u') {
      const code = Math.round(Number(event.c) || 0);
      if (code >= 32 && code <= 0xffff) writeAgent(session.agent, `u ${code}`);
    }
  }
  if (lastMove) writeMove(session.agent, lastMove);
}

function writeMove(agent, event) {
  const x = Math.max(0, Math.min(1, Number(event.x) || 0));
  const y = Math.max(0, Math.min(1, Number(event.y) || 0));
  writeAgent(agent, `m ${Math.round(x * 65535)} ${Math.round(y * 65535)}`);
}

function startAgent() {
  if (process.env.NUROFEN_REMOTE_DRYRUN === '1') {
    return { write() {}, stop() {} };
  }
  const script = path.join(HERE, 'input-agent.ps1');
  if (!fs.existsSync(script)) {
    pushLog('warn', 'удалённая помощь: не найден input-agent.ps1');
    return null;
  }
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  let child;
  try {
    child = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
  } catch (error) {
    pushLog('warn', `удалённая помощь: не удалось запустить управление: ${error.message}`);
    return null;
  }
  let stopped = false;
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  child.on('exit', () => {
    if (!stopped) pushLog('warn', 'удалённая помощь: управление вводом остановилось');
  });
  return {
    write(line) {
      try {
        if (!stopped && child.stdin.writable) child.stdin.write(`${line}\n`);
      } catch {
        // the helper may have exited
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        child.stdin.write('q\n');
        child.stdin.end();
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
      }, 400);
    },
  };
}

function writeAgent(agent, line) {
  agent?.write?.(line);
}

/* -------------------------------------------------------------- sessions */

export function acceptRemote(id, control) {
  const session = pending.get(String(id || ''));
  if (!session || session.status !== 'pending') {
    return { ok: false, error: 'Запрос уже неактуален.' };
  }
  if (!remoteEnabled(ctx?.getProfile?.() || {})) {
    declineRemote(session.id);
    return { ok: false, error: 'Удалённая помощь отключена в настройках.' };
  }
  if (currentHost()) {
    return { ok: false, error: 'Уже идёт сеанс удалённой помощи.' };
  }
  session.control = Boolean(control) && session.controlRequested;
  session.status = 'connecting';
  const resolve = session.consentResolve;
  session.consentResolve = null;
  resolve?.({ accepted: true });
  return { ok: true };
}

export function declineRemote(id) {
  const session = pending.get(String(id || ''));
  if (!session || session.status !== 'pending') {
    return { ok: false, error: 'Запрос уже неактуален.' };
  }
  session.status = 'declined';
  session.endedAt = Date.now();
  clearTimeout(session.timer);
  const resolve = session.consentResolve;
  session.consentResolve = null;
  resolve?.({ accepted: false, error: 'Запрос отклонён.' });
  return { ok: true };
}

export function stopRemoteSession(id) {
  const session = sessions.get(String(id || ''));
  if (!session) return { ok: true };
  if (TERMINAL.has(session.status)) {
    sessions.delete(session.id);
    return { ok: true };
  }
  endSession(session, 'ended', 'Сеанс завершён пользователем.');
  return { ok: true };
}

export function dismissRemote(id) {
  const key = String(id || '');
  const session = sessions.get(key);
  if (!session || !TERMINAL.has(session.status)) return { ok: false, error: 'Сеанс ещё идёт.' };
  sessions.delete(key);
  return { ok: true };
}

export function setRemoteControl(id, control) {
  const session = sessions.get(String(id || ''));
  if (!session || session.role !== 'host') return { ok: false, error: 'Сеанс не найден.' };
  if (session.status !== 'active') return { ok: false, error: 'Сеанс ещё не начался.' };
  session.control = Boolean(control) && session.controlRequested;
  if (session.control && !session.agent) session.agent = startAgent();
  if (!session.control) {
    session.agent?.stop?.();
    session.agent = null;
  }
  sendJson(session.socket, { t: 'control', control: session.control });
  pushLog('info', `удалённая помощь: управление ${session.control ? 'разрешено' : 'запрещено'}`);
  return { ok: true };
}

export function remoteInput(id, list) {
  const session = sessions.get(String(id || ''));
  if (!session || session.role !== 'viewer') return { ok: false, error: 'Сеанс не найден.' };
  if (session.status !== 'active' || !session.control) return { ok: true, ignored: true };
  if (!Array.isArray(list) || !list.length) return { ok: true };
  sendJson(session.socket, { t: 'input', list: list.slice(0, MAX_EVENTS) });
  return { ok: true };
}

function endSession(session, status, reason = '') {
  if (!session || TERMINAL.has(session.status)) return;
  session.status = status === 'closed' ? 'ended' : status;
  session.endedAt = Date.now();
  if (reason) session.error = reason;
  clearTimeout(session.timer);
  clearInterval(session.loop);
  clearInterval(session.pingTimer);
  session.timer = null;
  session.loop = null;
  session.pingTimer = null;
  session.agent?.stop?.();
  session.agent = null;
  if (session.streamCapture) {
    session.streamCapture = false;
    captureUsers = Math.max(0, captureUsers - 1);
  }
  if (session.socket) {
    try {
      sendJson(session.socket, { t: 'end', reason });
    } catch {
      // the socket may be gone
    }
    try {
      session.socket.destroy();
    } catch {
      // ignore
    }
    session.socket = null;
  }
  for (const res of session.streams || []) {
    try {
      res.end();
    } catch {
      // ignore
    }
  }
  if (session.streams) session.streams.clear();
  if (session.role === 'host') {
    pending.delete(session.id);
    releaseStreamCapture();
    if (status === 'ended' || status === 'error' || status === 'timeout') {
      ctx?.notify?.('Удалённая помощь', `Сеанс с ${session.peerName} завершён.`);
    }
  }
  if (session.role === 'viewer' && session.streams) {
    for (const res of session.streams) {
      try {
        res.end();
      } catch {
        // The HTTP viewer may have closed already.
      }
    }
    session.streams.clear();
  }
  pushLog('info', `удалённая помощь: сеанс с ${session.peerName} завершён${session.error ? ` (${session.error})` : ''}`);
}

function settleDecline(session) {
  if (!session) return;
  clearTimeout(session.timer);
  session.timer = null;
  session.consentResolve = null;
  if (!TERMINAL.has(session.status)) {
    session.status = 'declined';
    session.endedAt = Date.now();
  }
  pending.delete(session.id);
  sessions.delete(session.id);
}

/* ------------------------------------------------------------- streaming */

export function remoteStream(id, req, res) {
  const session = sessions.get(String(id || ''));
  if (!session || session.role !== 'viewer' || TERMINAL.has(session.status)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('no session');
    return;
  }
  res.writeHead(200, {
    'content-type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
    connection: 'keep-alive',
  });
  if (!session.streams) session.streams = new Set();
  session.streams.add(res);
  writeStreamFrame(res, session);
  const drop = () => session.streams?.delete(res);
  req.on('close', drop);
  res.on('close', drop);
  res.on('error', drop);
}

function writeStreamFrame(res, session) {
  if (!session.frame || res.writableEnded || res.destroyed) return;
  try {
    res.write(
      `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${session.frame.length}\r\n`
      + `X-Nurofen-Width: ${session.width || 0}\r\nX-Nurofen-Height: ${session.height || 0}\r\n\r\n`,
    );
    res.write(session.frame);
    res.write('\r\n');
  } catch {
    session.streams?.delete(res);
  }
}

/* --------------------------------------------------------------- capture */

async function grabScreen() {
  if (process.env.NUROFEN_REMOTE_TEST === '1') {
    return { jpeg: TEST_JPEG, width: 1, height: 1 };
  }
  const electron = await electronApi();
  if (!electron?.desktopCapturer) {
    throw new Error('Удалённая помощь доступна только в приложении Nurofen.');
  }
  const sources = await electron.desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: FRAME_WIDTH, height: FRAME_HEIGHT },
    fetchWindowIcons: false,
  });
  if (!sources.length) throw new Error('Не удалось захватить экран.');
  let source = sources[0];
  try {
    const primary = electron.screen?.getPrimaryDisplay?.();
    if (primary) {
      const match = sources.find((item) => String(item.display_id) === String(primary.id));
      if (match) source = match;
    }
  } catch {
    // the first screen is a fine fallback
  }
  const image = source.thumbnail;
  const size = image.getSize();
  if (!size.width || !size.height) throw new Error('Не удалось захватить экран.');
  return { jpeg: image.toJPEG(JPEG_QUALITY), width: size.width, height: size.height };
}

async function electronApi() {
  if (electronModule !== undefined) return electronModule;
  try {
    const loaded = await import('electron');
    // In a plain Node process the npm package resolves to the path string of
    // the Electron binary, not to the runtime API.
    if (loaded?.desktopCapturer) electronModule = loaded;
    else if (loaded?.default?.desktopCapturer) electronModule = loaded.default;
    else electronModule = null;
  } catch {
    electronModule = null;
  }
  return electronModule;
}

function supported() {
  if (process.env.NUROFEN_REMOTE_TEST === '1') return true;
  // The probe is cheap after the first call and avoids a false "unavailable"
  // while the module is still unresolved in the UI process.
  if (electronModule === undefined) return true;
  return Boolean(electronModule);
}

/* ----------------------------------------------------------------- server */

function startServer() {
  if (server) return;
  let index = 0;
  const tryPort = () => {
    if (index >= LISTEN_PORTS.length) {
      pushLog('warn', 'удалённая помощь недоступна: свободных портов нет');
      return;
    }
    const port = LISTEN_PORTS[index];
    index += 1;
    const candidate = net.createServer((socket) => {
      try {
        handleConnection(socket);
      } catch {
        socket.destroy();
      }
    });
    candidate.once('error', (error) => {
      try {
        candidate.close();
      } catch {
        // not listening yet
      }
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        tryPort();
        return;
      }
      pushLog('warn', `удалённая помощь: ${error.message}`);
    });
    candidate.listen(port, '0.0.0.0', () => {
      server = candidate;
      boundPort = port;
      pushLog('info', `удалённая помощь: порт ${port}`);
    });
  };
  tryPort();
}

/* ---------------------------------------------------------------- helpers */

function frameReader(socket, onJson) {
  let buffer = Buffer.alloc(0);
  let stopped = false;
  const onData = (chunk) => {
    if (stopped) return;
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (buffer.length >= 5) {
      const type = buffer[0];
      const length = buffer.readUInt32BE(1);
      if (length > MAX_TRANSFER_FRAME) {
        socket.destroy();
        return;
      }
      if (buffer.length < 5 + length) break;
      const payload = buffer.subarray(5, 5 + length);
      buffer = buffer.subarray(5 + length);
      if (type === 1) onJson(payload);
      else if (type === 2) onFrameBinary(socket, payload);
    }
  };
  socket.on('data', onData);
  return {
    stop() {
      stopped = true;
      socket.removeListener('data', onData);
    },
  };
}

function onFrameBinary(socket, payload) {
  const session = socket.__nurofenViewer;
  if (!session || session.role !== 'viewer') return;
  attachFrame(session, payload);
}

function sendJson(socket, value) {
  if (!socket || socket.destroyed) return;
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const head = Buffer.alloc(5);
  head[0] = 1;
  head.writeUInt32BE(payload.length, 1);
  try {
    socket.write(Buffer.concat([head, payload]));
  } catch {
    // the socket closed between the check and the write
  }
}

function sendFrame(socket, jpeg) {
  if (!socket || socket.destroyed || !jpeg) return;
  // A deep queue would turn a slow link into multi-second lag. Dropping the
  // frame keeps the picture live instead of freezing and then catching up.
  if (socket.writableLength > 512 * 1024) return;
  const head = Buffer.alloc(5);
  head[0] = 2;
  head.writeUInt32BE(jpeg.length, 1);
  try {
    socket.write(Buffer.concat([head, jpeg]));
  } catch {
    // ignore
  }
}

function peerByIp(ip) {
  for (const net of ctx?.getNetworks?.() || []) {
    if (net.status !== 'connected') continue;
    for (const peer of net.peers || []) {
      if (peer.self || peer.ip !== ip || !peer.online) continue;
      return {
        networkId: net.id,
        networkName: net.network?.name || '',
        peerId: peer.id,
        name: peer.name,
      };
    }
  }
  return null;
}

function trustedPeer(ip) {
  const peer = peerByIp(ip);
  if (peer) return { peer };
  if (process.env.NUROFEN_REMOTE_ALLOW_LOCAL === '1' && (ip === '::1' || /^127\./.test(ip))) {
    return { peer: { peerId: 'local', name: 'Локальный тест', networkId: 'local', networkName: 'local' } };
  }
  return null;
}

function peerForSend(networkId, peerId) {
  for (const net of ctx?.getNetworks?.() || []) {
    if (net.status !== 'connected') continue;
    if (networkId && net.id !== networkId) continue;
    for (const peer of net.peers || []) {
      if (peer.self || peer.id !== peerId || !peer.online) continue;
      return {
        networkId: net.id,
        networkName: net.network?.name || '',
        peerId: peer.id,
        name: peer.name,
        ip: peer.ip,
      };
    }
  }
  return null;
}

function normalizeIp(value) {
  return String(value || '').replace(/^::ffff:/, '');
}

function currentHost() {
  return pickActive('host');
}

function currentViewer() {
  return pickActive('viewer');
}

function pickActive(role) {
  for (const session of sessions.values()) {
    if (session.role === role && !TERMINAL.has(session.status)) return session;
  }
  return null;
}

function pickSession(role) {
  const active = pickActive(role);
  if (active) return active;
  let recent = null;
  for (const session of sessions.values()) {
    if (session.role !== role) continue;
    if (!recent || (session.endedAt || 0) > (recent.endedAt || 0)) recent = session;
  }
  return recent;
}

function cleanup() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (!TERMINAL.has(session.status)) continue;
    const ended = session.endedAt || session.createdAt;
    if (now - ended > KEEP_ENDED_MS) sessions.delete(id);
  }
}

function pendingView(session) {
  return {
    id: session.id,
    peerId: session.peerId,
    peerName: session.peerName,
    peerIp: session.peerIp,
    networkName: session.networkName,
    controlRequested: session.controlRequested,
    createdAt: session.createdAt,
  };
}

function sessionView(session) {
  const terminal = TERMINAL.has(session.status);
  return {
    id: session.id,
    role: session.role,
    status: session.status,
    peerId: session.peerId,
    peerName: session.peerName,
    peerIp: session.peerIp,
    networkName: session.networkName,
    control: Boolean(session.control),
    controlRequested: Boolean(session.controlRequested),
    width: session.width || 0,
    height: session.height || 0,
    fps: session.fps || 0,
    kbps: session.kbps || 0,
    frames: session.frames || 0,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    error: session.error || '',
    active: session.status === 'active',
    terminal,
    canStop: !terminal,
    canDismiss: terminal,
  };
}

function networkError(error) {
  if (!error) return 'Соединение прервалось.';
  if (error.code === 'ECONNREFUSED') return 'У участника не запущена удалённая помощь.';
  if (error.code === 'ETIMEDOUT') return 'Участник не отвечает.';
  if (error.code === 'EHOSTUNREACH' || error.code === 'ENETUNREACH') return 'Нет связи с участником.';
  return 'Соединение прервалось.';
}

function pushLog(level, message) {
  try {
    ctx?.log?.(level, message);
  } catch {
    // logging must never break a session
  }
}

const TEST_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof'
  + 'Hh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDT/wAALCAABAAEBAREA/8QAFAAB'
  + 'AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);


