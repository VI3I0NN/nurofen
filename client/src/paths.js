import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const APP_NAME = 'Nurofen';
export const UI_PORT = 39391;
export const HELPER_PORT = 39394;
export const TUNNEL_NAME = 'nurofen';

export const dataDir = () => {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, APP_NAME);
};

export const programDataDir = () =>
  process.env.PROGRAMDATA || 'C:\\ProgramData';

export const profileFile = () => path.join(dataDir(), 'client.json');
export const logFile = () => path.join(dataDir(), 'client.log');
export const confDir = () => path.join(programDataDir(), APP_NAME, 'conf');
export const helperTokenFile = () => path.join(programDataDir(), APP_NAME, 'helper-token');
export const helperStateFile = () => path.join(programDataDir(), APP_NAME, 'helper.json');

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Candidate locations of the AmneziaWG CLI, most specific first. */
export function awgCandidates() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  return [
    path.join(programFiles, 'AmneziaWG', 'amneziawg.exe'),
    path.join(programFiles, 'AmneziaWG', 'wireguard.exe'),
    path.join(programFiles, 'WireGuard', 'wireguard.exe'),
    path.join(programFiles, 'Amnezia', 'amneziawg.exe'),
  ];
}

export function findAwg() {
  for (const candidate of awgCandidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}
