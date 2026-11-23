import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { FILE_PORTS, ensureDir } from './paths.js';

/**
 * File transfer over the virtual LAN.
 *
 * The receiver starts a small HTTP server on the tunnel and accepts only
 * connections from peers that are currently online in a connected network.
 * A sender offers a file, the receiver confirms it in the UI, and only then
 * the bytes are streamed. The token in the offer is the only key that can
 * upload, so a stray request from the same subnet cannot write a file.
 */

const MAX_SIZE = 64 * 1024 * 1024 * 1024; // 64 GB
const OFFER_TIMEOUT_MS = 120 * 1000;
const ACCEPT_TIMEOUT_MS = 2 * 60 * 1000;
const KEEP_MS = 2 * 60 * 1000;
const MAX_PENDING = 4;
const MAX_OUTGOING = 3;
const STALL_MS = 5 * 60 * 1000;
const MAX_NAME = 160;

let ctx = null;
let server = null;
let boundPort = 0;
const transfers = new Map();

const ACTIVE_OUT = new Set(['offering', 'waiting', 'active']);
const TERMINAL = new Set(['done', 'declined', 'error', 'cancelled', 'timeout']);

export function initFiles(context) {
  ctx = context;
  startServer();
}

export function stopFiles() {
  for (const transfer of transfers.values()) {
    if (transfer.status === 'pending') declineTransfer(transfer.id);
    else if (transfer.status === 'active') cancelTransfer(transfer.id);
  }
  if (server) {
    try {
      server.close();
    } catch {
      // already closing
    }
    server = null;
    boundPort = 0;
  }
}

export function filesDir(profile) {
  return String(profile?.settings?.filesDir || '').trim() || defaultDir();
}

export function filesSnapshot(profile) {
  cleanup();
  const list = [...transfers.values()].sort((a, b) => b.createdAt - a.createdAt);
  const pending = list.filter((item) => item.direction === 'in' && item.status === 'pending');
  const active = list.filter((item) => ACTIVE_OUT.has(item.status));
  return {
    dir: filesDir(profile),
    configured: Boolean(String(profile?.settings?.filesDir || '').trim()),
    port: boundPort,
    available: Boolean(server && boundPort),
    active: active.length,
    pending: pending.length,
    transfers: list.map(transferView),
  };
}

export function startSend({ profile, networkId, peerId, filePath }) {
  if (!ctx) throw new Error('Передача файлов ещё не готова.');
  const peer = peerForSend(networkId, peerId);
  if (!peer) throw new Error('Участник не в сети — передача недоступна.');
  if (!boundPort) throw new Error('Передача файлов не запустилась: порт занят.');

  const source = String(filePath || '').trim();
  let stat;
  try {
    stat = fs.statSync(source);
  } catch {
    throw new Error('Файл не найден.');
  }
  if (!stat.isFile()) throw new Error('Выберите файл, а не папку.');
  if (stat.size <= 0) throw new Error('Пустой файл отправлять нечего.');
  if (stat.size > MAX_SIZE) throw new Error('Файл больше 64 ГБ.');

  const busy = [...transfers.values()]
    .filter((item) => item.direction === 'out' && ACTIVE_OUT.has(item.status)).length;
  if (busy >= MAX_OUTGOING) throw new Error('Слишком много одновременных отправок.');

  const self = ctx.getSelf?.(peer.networkId) || {};
  const transfer = {
    id: randomUUID(),
    token: randomBytes(24).toString('hex'),
    direction: 'out',
    status: 'offering',
    name: safeName(path.basename(source)),
    size: stat.size,
    transferred: 0,
    sourcePath: source,
    peerId: peer.peerId,
    peerName: peer.name,
    peerIp: peer.ip,
    networkId: peer.networkId,
    networkName: peer.networkName,
    fromName: self.name || '',
    fromIp: self.ip || '',
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    lastProgressAt: Date.now(),
    speed: 0,
    sampleAt: 0,
    sampleBytes: 0,
    error: '',
    request: null,
    stream: null,
    cancelled: false,
  };
  transfers.set(transfer.id, transfer);
  runSend(transfer, peer).catch((error) => {
    finish(transfer, 'error', error.message);
  });
  return transferView(transfer);
}

export function acceptTransfer(id) {
  const transfer = transfers.get(String(id || ''));
  if (!transfer || transfer.direction !== 'in' || transfer.status !== 'pending') {
    return { ok: false, error: 'Запрос уже неактуален.' };
  }
  transfer.status = 'accepted';
  transfer.acceptedAt = Date.now();
  clearTimeout(transfer.offerTimer);
  const resolve = transfer.offerResolve;
  transfer.offerResolve = null;
  resolve?.({ accepted: true });
  return { ok: true };
}

export function declineTransfer(id) {
  const transfer = transfers.get(String(id || ''));
  if (!transfer || transfer.direction !== 'in' || transfer.status !== 'pending') {
    return { ok: false, error: 'Запрос уже неактуален.' };
  }
  transfer.status = 'declined';
  transfer.endedAt = Date.now();
  clearTimeout(transfer.offerTimer);
  const resolve = transfer.offerResolve;
  transfer.offerResolve = null;
  resolve?.({ accepted: false, error: 'declined' });
  return { ok: true };
}

export function cancelTransfer(id) {
  const transfer = transfers.get(String(id || ''));
  if (!transfer) return { ok: false, error: 'Передача не найдена.' };
  if (transfer.status === 'pending') return declineTransfer(id);
  if (TERMINAL.has(transfer.status)) return { ok: false, error: 'Передача уже завершена.' };

  transfer.cancelled = true;
  finish(transfer, 'cancelled');
  try {
    transfer.request?.destroy();
  } catch {
    // the socket may already be gone
  }
  try {
    transfer.stream?.destroy();
  } catch {
    // the stream may already be gone
  }
  try {
    transfer.uploadReq?.destroy();
  } catch {
    // the socket may already be gone
  }
  try {
    transfer.uploadOut?.destroy();
  } catch {
    // the stream may already be gone
  }
  return { ok: true };
}

export function dismissTransfer(id) {
  const transfer = transfers.get(String(id || ''));
  if (!transfer) return { ok: true };
  if (!TERMINAL.has(transfer.status)) return { ok: false, error: 'Сначала завершите передачу.' };
  transfers.delete(transfer.id);
  return { ok: true };
}

export function transferPath(id) {
  const transfer = transfers.get(String(id || ''));
  if (!transfer || transfer.status !== 'done' || transfer.direction !== 'in') return '';
  return transfer.path || '';
}

/* ------------------------------------------------------------------ sending */

async function runSend(transfer, peer) {
  try {
    const answer = await offer(transfer, peer);
    if (!answer.accepted) {
      finish(transfer, answer.error === 'timeout' ? 'timeout' : 'declined');
      return;
    }
    transfer.status = 'active';
    transfer.startedAt = Date.now();
    transfer.lastProgressAt = Date.now();
    const result = await upload(transfer, peer);
    if (transfer.cancelled) return;
    if (result.sha256 && transfer.hash && result.sha256 !== transfer.hash) {
      throw new Error('Файл пришёл повреждённым. Попробуйте ещё раз.');
    }
    transfer.transferred = transfer.size;
    finish(transfer, 'done');
    log('ok', `отправлен файл «${transfer.name}» → ${transfer.peerName}`);
  } catch (error) {
    if (transfer.cancelled) return;
    finish(transfer, error.code === 'offer_timeout' ? 'timeout' : 'error', error.message || 'Передача не удалась.');
    log('warn', `передача «${transfer.name}»: ${transfer.error}`);
  }
}

function offer(transfer, peer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const attempt = (index) => {
      if (index >= FILE_PORTS.length) {
        fail(new Error('У получателя не запущена передача файлов. Попросите обновить Nurofen.'));
        return;
      }
      const port = FILE_PORTS[index];
      const body = JSON.stringify({
        id: transfer.id,
        token: transfer.token,
        name: transfer.name,
        size: transfer.size,
        from: { name: transfer.fromName, ip: transfer.fromIp },
        network: transfer.networkName,
      });
      const request = http.request({
        host: peer.ip,
        port,
        method: 'POST',
        path: '/offer',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          'x-nurofen-files': '1',
        },
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          if (settled) return;
          if (response.headers['x-nurofen-files'] !== '1') {
            attempt(index + 1);
            return;
          }
          let data = {};
          try {
            data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            data = {};
          }
          if (!data.ok) {
            fail(new Error(data.error || 'Получатель не принял файл.'));
            return;
          }
          transfer.peerPort = port;
          done({ accepted: Boolean(data.accepted), error: data.error || '' });
        });
        response.on('error', () => attempt(index + 1));
      });

      transfer.request = request;
      request.setTimeout(OFFER_TIMEOUT_MS + 15 * 1000, () => {
        request.destroy(Object.assign(new Error('Получатель не ответил.'), { code: 'offer_timeout' }));
      });
      request.on('finish', () => {
        if (transfer.status === 'offering') transfer.status = 'waiting';
      });
      request.on('error', (error) => {
        transfer.request = null;
        if (settled) return;
        if (error.code === 'offer_timeout') {
          fail(new Error('Получатель не ответил.'));
          return;
        }
        attempt(index + 1);
      });
      request.end(body);
    };

    attempt(0);
  });
}

function upload(transfer, peer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const hash = createHash('sha256');
    const finishWith = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };

    const request = http.request({
      host: peer.ip,
      port: transfer.peerPort,
      method: 'PUT',
      path: `/upload/${encodeURIComponent(transfer.id)}?token=${encodeURIComponent(transfer.token)}`,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': transfer.size,
        'x-nurofen-files': '1',
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        let data = {};
        try {
          data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          data = {};
        }
        if (response.statusCode === 200 && data.ok) {
          finishWith(null, data);
          return;
        }
        finishWith(new Error(data.error || 'Получатель не сохранил файл.'));
      });
      response.on('error', () => finishWith(new Error('Соединение прервалось.')));
    });

    transfer.request = request;
    const stream = fs.createReadStream(transfer.sourcePath);
    transfer.stream = stream;

    stream.on('data', (chunk) => {
      hash.update(chunk);
      bump(transfer, chunk.length);
    });
    stream.on('end', () => {
      try {
        transfer.hash = hash.digest('hex');
      } catch {
        transfer.hash = '';
      }
    });
    stream.on('error', (error) => {
      try {
        request.destroy();
      } catch {
        // ignore
      }
      finishWith(new Error(`Не удалось прочитать файл: ${error.message}`));
    });
    request.on('error', (error) => {
      transfer.request = null;
      if (transfer.cancelled) {
        finishWith(new Error('Отменено'));
        return;
      }
      finishWith(new Error(error.code === 'ECONNRESET' ? 'Получатель прервал передачу.' : 'Соединение прервалось.'));
    });
    request.setTimeout(60 * 1000, () => {
      request.destroy(Object.assign(new Error('Передача остановилась.'), { code: 'upload_timeout' }));
    });

    stream.pipe(request);
  });
}

/* ---------------------------------------------------------------- receiving */

function startServer() {
  if (server) return;
  let index = 0;

  const tryPort = () => {
    if (index >= FILE_PORTS.length) {
      log('warn', 'передача файлов недоступна: свободных портов нет');
      return;
    }
    const port = FILE_PORTS[index];
    index += 1;
    const candidate = http.createServer(handleRequest);
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
      log('warn', `передача файлов: ${error.message}`);
    });
    candidate.listen(port, '0.0.0.0', () => {
      server = candidate;
      boundPort = port;
      log('info', `передача файлов: порт ${port}`);
    });
  };

  tryPort();
}

function handleRequest(req, res) {
  const remote = normalizeIp(req.socket.remoteAddress);
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, { ok: true, app: 'nurofen-files' });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/offer') {
    handleOffer(req, res, remote).catch((error) => {
      json(res, 400, { ok: false, error: error.message || 'Некорректный запрос.' });
    });
    return;
  }
  if (req.method === 'PUT' && url.pathname.startsWith('/upload/')) {
    handleUpload(req, res, remote, url).catch((error) => {
      json(res, 500, { ok: false, error: error.message || 'Не удалось принять файл.' });
    });
    return;
  }
  json(res, 404, { ok: false, error: 'not_found' });
}

async function handleOffer(req, res, remote) {
  if (!trustedPeer(remote)) {
    json(res, 403, { ok: false, error: 'Этот адрес не входит в вашу сеть.' });
    return;
  }
  const body = await readJson(req);
  const id = String(body.id || '').trim();
  const token = String(body.token || '').trim();
  const name = safeName(String(body.name || ''));
  const size = Number(body.size);
  if (!/^[0-9a-f-]{20,64}$/i.test(id) || !/^[0-9a-f]{16,128}$/i.test(token)) {
    json(res, 400, { ok: false, error: 'Некорректный запрос передачи.' });
    return;
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_SIZE) {
    json(res, 400, { ok: false, error: 'Некорректный размер файла.' });
    return;
  }
  if (transfers.has(id)) {
    json(res, 409, { ok: false, error: 'Такая передача уже есть.' });
    return;
  }
  const pending = [...transfers.values()].filter((item) => item.direction === 'in' && item.status === 'pending');
  if (pending.length >= MAX_PENDING) {
    json(res, 429, { ok: false, error: 'Слишком много входящих запросов.' });
    return;
  }

  const peer = peerByIp(remote);
  const transfer = {
    id,
    token,
    direction: 'in',
    status: 'pending',
    name,
    size,
    transferred: 0,
    peerId: peer.peerId,
    peerName: peer.name || body.from?.name || remote,
    peerIp: remote,
    networkId: peer.networkId,
    networkName: peer.networkName,
    fromName: String(body.from?.name || '').slice(0, 32),
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    lastProgressAt: Date.now(),
    speed: 0,
    sampleAt: 0,
    sampleBytes: 0,
    error: '',
    offerResolve: null,
    offerTimer: null,
    path: '',
  };
  transfers.set(transfer.id, transfer);

  try {
    ctx?.showWindow?.();
  } catch {
    // the window is a convenience, the request still stands
  }
  ctx?.notify?.('Входящий файл', `${transfer.peerName} отправляет «${name}»`);
  log('info', `входящий файл «${name}» от ${transfer.peerName}`);

  const decision = await new Promise((resolve) => {
    transfer.offerResolve = resolve;
    transfer.offerTimer = setTimeout(() => {
      if (transfer.status !== 'pending') return;
      transfer.status = 'timeout';
      transfer.endedAt = Date.now();
      transfer.offerResolve = null;
      resolve({ accepted: false, error: 'timeout' });
    }, OFFER_TIMEOUT_MS);
    req.on('aborted', () => {
      if (transfer.status !== 'pending') return;
      transfer.status = 'declined';
      transfer.endedAt = Date.now();
      transfer.offerResolve = null;
      resolve({ accepted: false, error: 'declined' });
    });
    res.on('close', () => {
      if (res.writableEnded) return;
      if (transfer.status !== 'pending') return;
      transfer.status = 'declined';
      transfer.endedAt = Date.now();
      transfer.offerResolve = null;
      resolve({ accepted: false, error: 'declined' });
    });
  });

  if (decision.accepted) {
    json(res, 200, { ok: true, accepted: true });
    return;
  }
  json(res, 200, { ok: true, accepted: false, error: decision.error || 'declined' });
}

async function handleUpload(req, res, remote, url) {
  const id = decodeURIComponent(url.pathname.slice('/upload/'.length));
  const token = String(url.searchParams.get('token') || '');
  const transfer = transfers.get(id);
  if (!transfer || transfer.direction !== 'in') {
    json(res, 404, { ok: false, error: 'Передача не найдена.' });
    return;
  }
  if (transfer.peerIp !== remote || transfer.token !== token) {
    json(res, 403, { ok: false, error: 'Нет доступа к этой передаче.' });
    return;
  }
  if (transfer.status !== 'accepted') {
    json(res, 409, { ok: false, error: 'Передача ещё не принята.' });
    return;
  }
  const length = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(length) || length !== transfer.size) {
    json(res, 400, { ok: false, error: 'Размер файла не совпадает.' });
    return;
  }

  let dir;
  try {
    dir = ensureDir(filesDir(ctx?.getProfile?.() || {}));
  } catch (error) {
    json(res, 500, { ok: false, error: `Не удалось открыть папку: ${error.message}` });
    return;
  }

  const finalPath = uniquePath(dir, transfer.name);
  const temp = path.join(dir, `.nurofen-${transfer.id}.part`);
  try {
    fs.rmSync(temp, { force: true });
  } catch {
    // a stale part file is harmless
  }

  const hash = createHash('sha256');
  let out;
  try {
    out = fs.createWriteStream(temp, { flags: 'wx' });
  } catch (error) {
    json(res, 500, { ok: false, error: `Не удалось создать файл: ${error.message}` });
    return;
  }

  transfer.status = 'active';
  transfer.startedAt = Date.now();
  transfer.lastProgressAt = Date.now();
  transfer.path = finalPath;
  transfer.temp = temp;
  transfer.uploadReq = req;
  transfer.uploadOut = out;

  let settled = false;
  const fail = (message, status = 500) => {
    if (settled) return;
    settled = true;
    transfer.status = transfer.cancelled ? 'cancelled' : 'error';
    transfer.error = transfer.cancelled ? '' : message;
    transfer.endedAt = Date.now();
    transfer.speed = 0;
    json(res, status, { ok: false, error: message });
    try {
      req.destroy();
    } catch {
      // ignore
    }
    try {
      out.destroy();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // ignore
    }
  };

  req.on('data', (chunk) => {
    if (settled) return;
    if (transfer.transferred + chunk.length > transfer.size) {
      fail('Файл больше заявленного размера.', 400);
      return;
    }
    hash.update(chunk);
    bump(transfer, chunk.length);
    if (!out.write(chunk)) {
      req.pause();
      out.once('drain', () => req.resume());
    }
  });
  req.on('end', () => {
    if (!settled) out.end();
  });
  req.on('aborted', () => fail('Передача отменена.', 499));
  req.on('error', () => fail('Соединение прервалось.', 500));
  req.on('close', () => {
    if (!settled && !req.complete) fail('Соединение прервалось.', 500);
  });
  out.on('error', (error) => fail(`Не удалось записать файл: ${error.message}`, 500));
  out.on('finish', () => {
    if (settled) return;
    if (transfer.transferred !== transfer.size) {
      fail('Файл пришёл не полностью.', 400);
      return;
    }
    const digest = hash.digest('hex');
    try {
      fs.renameSync(temp, finalPath);
    } catch (error) {
      fail(`Не удалось сохранить файл: ${error.message}`, 500);
      return;
    }
    settled = true;
    transfer.transferred = transfer.size;
    transfer.hash = digest;
    finish(transfer, 'done');
    json(res, 200, { ok: true, sha256: digest, path: finalPath });
    log('ok', `получен файл «${transfer.name}» от ${transfer.peerName}`);
  });
}

/* -------------------------------------------------------------------- utils */

function defaultDir() {
  return path.join(os.homedir(), 'Downloads', 'Nurofen');
}

function cleanup() {
  const now = Date.now();
  for (const transfer of [...transfers.values()]) {
    if (TERMINAL.has(transfer.status) && transfer.endedAt && now - transfer.endedAt > KEEP_MS) {
      transfers.delete(transfer.id);
      continue;
    }
    if (transfer.status === 'pending' && now - transfer.createdAt > OFFER_TIMEOUT_MS + 10 * 1000) {
      declineTransfer(transfer.id);
      continue;
    }
    if (transfer.status === 'accepted' && transfer.acceptedAt && now - transfer.acceptedAt > ACCEPT_TIMEOUT_MS) {
      finish(transfer, 'timeout', 'Получатель не начал передачу.');
      continue;
    }
    if (transfer.status === 'active' && now - (transfer.lastProgressAt || transfer.startedAt || now) > STALL_MS) {
      finish(transfer, 'error', 'Передача прервалась — нет данных.');
      try {
        transfer.request?.destroy();
        transfer.uploadReq?.destroy();
      } catch {
        // ignore
      }
    }
  }
}

function finish(transfer, status, error = '') {
  transfer.status = status;
  transfer.error = error;
  transfer.endedAt = Date.now();
  transfer.speed = 0;
  transfer.offerResolve = null;
  clearTimeout(transfer.offerTimer);
}

function bump(transfer, bytes) {
  transfer.transferred += bytes;
  transfer.lastProgressAt = Date.now();
  const now = Date.now();
  if (!transfer.sampleAt) {
    transfer.sampleAt = now;
    transfer.sampleBytes = 0;
  }
  if (now - transfer.sampleAt >= 700) {
    transfer.speed = Math.max(0, Math.round(((transfer.transferred - transfer.sampleBytes) * 1000) / (now - transfer.sampleAt)));
    transfer.sampleAt = now;
    transfer.sampleBytes = transfer.transferred;
  }
}

function transferView(transfer) {
  const terminal = TERMINAL.has(transfer.status);
  const percent = transfer.size
    ? Math.min(100, Math.max(0, Math.round((transfer.transferred / transfer.size) * 100)))
    : 0;
  return {
    id: transfer.id,
    direction: transfer.direction,
    status: transfer.status,
    name: transfer.name,
    size: transfer.size,
    transferred: transfer.transferred,
    percent,
    speed: transfer.speed || 0,
    peerId: transfer.peerId,
    peerName: transfer.peerName,
    peerIp: transfer.peerIp,
    networkId: transfer.networkId,
    networkName: transfer.networkName,
    error: transfer.error || '',
    createdAt: transfer.createdAt,
    endedAt: transfer.endedAt,
    canAccept: transfer.direction === 'in' && transfer.status === 'pending',
    canDecline: transfer.direction === 'in' && transfer.status === 'pending',
    canCancel: !terminal,
    canDismiss: terminal,
    canReveal: transfer.direction === 'in' && transfer.status === 'done' && Boolean(transfer.path),
  };
}

function peerByIp(ip) {
  const networks = ctx?.getNetworks?.() || [];
  for (const net of networks) {
    if (net.status !== 'connected') continue;
    for (const peer of net.peers || []) {
      if (peer.self || peer.ip !== ip) continue;
      if (!peer.online) continue;
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

function peerForSend(networkId, peerId) {
  const networks = ctx?.getNetworks?.() || [];
  for (const net of networks) {
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

function trustedPeer(ip) {
  if (peerByIp(ip)) return true;
  // Local end-to-end tests run both sides on one machine. Never enabled by the
  // normal launcher; the environment variable has to be set explicitly.
  if (process.env.NUROFEN_FILES_ALLOW_LOCAL === '1') {
    return ip === '127.0.0.1' || ip === '::1';
  }
  return false;
}

function normalizeIp(value) {
  return String(value || '').replace(/^::ffff:/, '');
}

function safeName(value) {
  const base = path.basename(String(value || '').replace(/\\/g, '/'));
  let name = base
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, MAX_NAME);
  if (!name || name === '.' || name === '..') name = 'file';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) name = `_${name}`;
  return name;
}

function uniquePath(dir, name) {
  const wanted = path.join(dir, safeName(name));
  if (!fs.existsSync(wanted)) return wanted;
  const ext = path.extname(wanted);
  const stem = path.basename(wanted, ext);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.join(dir, `${stem} (${index})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Слишком большой запрос.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('Некорректный запрос.'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-nurofen-files': '1',
  });
  res.end(JSON.stringify(body));
}

function log(level, message) {
  try {
    ctx?.log?.(level, message);
  } catch {
    // logging must never break a transfer
  }
}
