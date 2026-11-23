import net from 'node:net';

/**
 * Server List Ping from the Minecraft protocol. It is the same request the
 * game sends when it draws the multiplayer list, so a world that answers here
 * is a world a player can join — no mods and no game files involved.
 */

const PROTOCOL = 47; // 1.8; every server since then answers the same status packet
const ONLINE_TTL = 8000;
const OFFLINE_TTL = 5000;
const PROBE_TIMEOUT = 1200;

function varint(value) {
  const bytes = [];
  let rest = value >>> 0;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest) byte |= 0x80;
    bytes.push(byte);
  } while (rest);
  return Buffer.from(bytes);
}

function readVarint(buffer, offset) {
  let value = 0;
  for (let size = 0; size < 5; size += 1) {
    if (offset + size >= buffer.length) return null;
    const byte = buffer[offset + size];
    value |= (byte & 0x7f) << (7 * size);
    if (!(byte & 0x80)) return { value, size: size + 1 };
  }
  return null;
}

function stripColors(text) {
  return String(text ?? '').replace(/§[0-9a-fk-or]/gi, '');
}

/** Chat components are strings, arrays or `{ text, extra }` trees. */
function flatten(component) {
  if (component == null) return '';
  if (typeof component === 'string') return component;
  if (Array.isArray(component)) return component.map(flatten).join('');
  if (typeof component === 'object') {
    const own = typeof component.text === 'string'
      ? component.text
      : typeof component.translate === 'string' ? component.translate : '';
    const extra = Array.isArray(component.extra) ? component.extra.map(flatten).join('') : '';
    return own + extra;
  }
  return '';
}

function parseStatus(json) {
  const players = json?.players || {};
  const sample = Array.isArray(players.sample) ? players.sample : [];
  return {
    online: true,
    motd: stripColors(flatten(json?.description)).replace(/\s+/g, ' ').trim().slice(0, 140),
    players: {
      online: Number(players.online) || 0,
      max: Number(players.max) || 0,
      names: sample.map((item) => item?.name).filter((name) => typeof name === 'string').slice(0, 16),
    },
    version: String(json?.version?.name || ''),
    protocol: Number(json?.version?.protocol) || null,
  };
}

function readResponse(buffer) {
  const length = readVarint(buffer, 0);
  if (!length) return null;
  const start = length.size;
  if (buffer.length < start + length.value) return null;
  const frame = buffer.subarray(start, start + length.value);
  const id = readVarint(frame, 0);
  if (!id || id.value !== 0) return { online: false, error: 'protocol' };
  const size = readVarint(frame, id.size);
  if (!size) return { online: false, error: 'protocol' };
  const from = id.size + size.size;
  const text = frame.subarray(from, from + size.value).toString('utf8');
  try {
    return parseStatus(JSON.parse(text));
  } catch {
    return { online: false, error: 'protocol' };
  }
}

function probe(host, port) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    let buffer = Buffer.alloc(0);
    let done = false;

    const finish = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ...value, at: Date.now(), latency: value.online ? Date.now() - started : null });
    };

    socket.setTimeout(PROBE_TIMEOUT);
    socket.once('timeout', () => finish({ online: false, error: 'timeout' }));
    socket.once('error', (error) => finish({ online: false, error: error?.code || 'error' }));
    socket.once('connect', () => {
      const name = Buffer.from(host, 'utf8');
      const handshake = Buffer.concat([
        varint(0),
        varint(PROTOCOL),
        varint(name.length),
        name,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        varint(1),
      ]);
      socket.write(Buffer.concat([varint(handshake.length), handshake]));
      socket.write(Buffer.from([0x01, 0x00]));
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const result = readResponse(buffer);
      if (result) finish(result);
    });
  });
}

const cache = new Map();

/**
 * Returns the last known status immediately and refreshes it in the
 * background, so `/api/status` never waits for a dead port.
 */
export function statusFor(host, port) {
  const key = `${host}:${port}`;
  const now = Date.now();
  let entry = cache.get(key);
  if (!entry) {
    entry = { value: null, at: 0, pending: null };
    cache.set(key, entry);
  }
  const ttl = entry.value?.online ? ONLINE_TTL : OFFLINE_TTL;
  if (!entry.pending && now - entry.at >= ttl) {
    entry.pending = probe(host, port)
      .then((value) => {
        entry.value = value;
        entry.at = Date.now();
      })
      .catch(() => {
        entry.value = { online: false, error: 'error', at: Date.now(), latency: null };
        entry.at = Date.now();
      })
      .finally(() => {
        entry.pending = null;
      });
  }
  return entry.value;
}

/** Drops addresses that no longer belong to a connected network. */
export function keepStatuses(keys) {
  const wanted = new Set(keys);
  for (const key of cache.keys()) {
    if (!wanted.has(key)) cache.delete(key);
  }
}

/** Parses `10.66.2.11:25565` without breaking on anything else. */
export function splitAddress(address) {
  const text = String(address || '');
  const index = text.lastIndexOf(':');
  if (index <= 0) return null;
  const port = Number(text.slice(index + 1));
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return null;
  return { host: text.slice(0, index), port };
}
