import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const APP_NAME = 'Nurofen';
export const UI_PORT = 39391;
export const HELPER_PORT = 39394;
// File transfer listens on the tunnel, not on loopback. The firewall already
// allows TCP from 10.66.0.0/16, so no extra rule is needed. A short list keeps
// the client working if one of the ports is taken by another program.
export const FILE_PORTS = [39395, 39396, 39397];
// Remote help uses the same tunnel and the same firewall rule as files: the
// rule allows every TCP port from 10.66.0.0/16, so a separate port list is
// enough. Screen frames go host → viewer, input goes viewer → host.
export const REMOTE_PORTS = [39398, 39399];
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

/**
 * The low-level `awg` CLI, which unlike the GUI executable supports
 * `show <name> dump` and `set <name> peer …`. Falls back to the GUI path when
 * only that one exists.
 */
export function findAwgCli() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const dirs = [
    path.join(programFiles, 'AmneziaWG'),
    path.join(programFiles, 'WireGuard'),
    path.join(programFiles, 'Amnezia'),
  ];
  for (const dir of dirs) {
    for (const name of ['awg.exe', 'wireguard.exe']) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // ignore
      }
    }
  }
  return findAwg();
}
