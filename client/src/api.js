import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function normalizeServer(value) {
  let url = String(value || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '');
}

/** Server address baked in at install time, overridable by env. */
export function defaultServerUrl() {
  if (process.env.NUROFEN_SERVER) return normalizeServer(process.env.NUROFEN_SERVER);
  for (const candidate of [path.join(HERE, '..', 'defaults.json'), path.join(HERE, '..', '..', 'defaults.json')]) {
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (raw.serverUrl) return normalizeServer(raw.serverUrl);
    } catch {
      // no defaults file
    }
  }
  return '';
}

async function request(baseUrl, route, { method = 'GET', token, body, timeoutMs = 10000 } = {}) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: 'bad_response' };
  }
  if (!res.ok) {
    const error = new Error(data?.error || `http_${res.status}`);
    error.status = res.status;
    error.code = data?.error || 'http_error';
    throw error;
  }
  return data;
}

export async function join({ serverUrl, invite, deviceName, publicKey, deviceId }) {
  return request(serverUrl, '/api/v1/join', {
    method: 'POST',
    body: { invite, deviceName, publicKey, deviceId },
  });
}

export async function state(profile) {
  return request(profile.serverUrl, '/api/v1/state', { token: profile.token, timeoutMs: 6000 });
}

export async function heartbeat(profile) {
  return request(profile.serverUrl, '/api/v1/heartbeat', { method: 'POST', token: profile.token, timeoutMs: 6000 });
}

export async function leave(profile) {
  return request(profile.serverUrl, '/api/v1/leave', { method: 'POST', token: profile.token, timeoutMs: 6000 });
}

export async function pushKey(profile) {
  return request(profile.serverUrl, '/api/v1/key', {
    method: 'POST',
    token: profile.token,
    body: { publicKey: profile.publicKey },
    timeoutMs: 6000,
  });
}
