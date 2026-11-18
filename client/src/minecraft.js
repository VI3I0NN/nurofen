import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOG_CANDIDATES = [
  path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft', 'logs', 'latest.log'),
  path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'PrismLauncher', 'instances'),
];

const PORT_PATTERNS = [
  /Started serving on (\d{2,5})/i,
  /Local game hosted on port (\d{2,5})/i,
  /Opening LAN on port (\d{2,5})/i,
  /lan server.*?(\d{4,5})/i,
];

/** Reads the tail of a file without loading a 30 MB log into memory. */
function tail(file, bytes = 120_000) {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - bytes);
    const handle = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(handle, buffer, 0, buffer.length, start);
    fs.closeSync(handle);
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Minecraft announces the port it opened for LAN play in its own log. That is
 * the only reliable, version independent way to know it without touching the
 * game, so the client can show friends the exact address to type.
 */
export function detectLanPort() {
  const logPath = LOG_CANDIDATES[0];
  const text = tail(logPath);
  if (!text) return null;

  const lines = text.split(/\r?\n/).slice(-400);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (/Stopping server|Stopping internal server/i.test(line)) {
      // Anything before a shutdown is a stale port.
      return null;
    }
    for (const pattern of PORT_PATTERNS) {
      const match = pattern.exec(line);
      if (match) {
        const port = Number(match[1]);
        if (port > 1024 && port < 65536) return { port, at: new Date().toISOString() };
      }
    }
  }
  return null;
}

/** Where a vanilla launcher keeps its logs, used by the diagnostics panel. */
export function minecraftLogPath() {
  return LOG_CANDIDATES[0];
}
