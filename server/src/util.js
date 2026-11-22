import { randomBytes, timingSafeEqual, createHash, scryptSync } from 'node:crypto';

/**
 * Network names are human input: keep the spelling (including Cyrillic) for
 * display, but compare them case- and whitespace-insensitively.
 */
export function cleanNetworkName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
}

export function networkKey(value) {
  return cleanNetworkName(value).normalize('NFKC').toLowerCase();
}

/**
 * WireGuard keys are canonical base64 of 32 bytes. `wg` rejects keys whose
 * padding bits are not zero, so accept only values it will actually load.
 */
export function isValidKey(value) {
  if (typeof value !== 'string') return false;
  const key = value.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key)) return false;
  const bytes = Buffer.from(key, 'base64');
  if (bytes.length !== 32) return false;
  if (bytes.equals(Buffer.alloc(32))) return false;
  return bytes.toString('base64') === key;
}

/** scrypt keeps network passwords out of nurofen.json in readable form. */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 32).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  try {
    const expected = Buffer.from(String(hash), 'hex');
    const actual = scryptSync(String(password), String(salt), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function token(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function id() {
  return randomBytes(8).toString('hex');
}

export function nowIso() {
  return new Date().toISOString();
}

/** Constant time string compare that never throws on length mismatch. */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function json(res, status, body, extraHeaders = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}

export function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

export async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('payload too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('invalid json');
    error.status = 400;
    throw error;
  }
}

/** Small in-memory sliding window limiter, keyed by IP. */
export class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  check(key) {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || now - entry.start > this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    if (entry.count > this.limit) return false;
    return true;
  }

  prune() {
    const now = Date.now();
    for (const [key, entry] of this.hits) {
      if (now - entry.start > this.windowMs) this.hits.delete(key);
    }
  }
}

export function guessIpv4(value) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(value || '').trim());
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return null;
  return parts.join('.');
}
