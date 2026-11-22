import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where Minecraft keeps its game folder.
 *
 * Vanilla and most launchers still use `%APPDATA%\.minecraft`, but Prism and
 * its forks (PineconeMC) keep one folder per instance, TLauncher Legacy has its
 * own tree, and Modrinth/GDLauncher/ATLauncher/CurseForge each use a different
 * layout. This module knows those layouts and can also resolve a folder picked
 * by hand, so a portable install works too.
 */

const CACHE_MS = 10_000;
let cache = { at: 0, dirs: [] };

const GAME_MARKERS = [
  'logs',
  'servers.dat',
  'options.txt',
  'saves',
  'mods',
  'versions',
  'launcher_profiles.json',
  'assets',
  'libraries',
];

const FIXED = [
  { launcher: 'Minecraft', dir: '%APPDATA%\\.minecraft' },
  { launcher: 'TLauncher Legacy', dir: '%APPDATA%\\.tlauncher\\legacy\\Minecraft\\game' },
  { launcher: 'TLauncher Legacy', dir: '%APPDATA%\\.tlauncher\\legacy\\game' },
  { launcher: 'Legacy Launcher', dir: '%APPDATA%\\.legacylauncher\\legacy\\Minecraft\\game' },
];

const GROUPS = [
  { launcher: 'Prism Launcher', dir: '%APPDATA%\\PrismLauncher\\instances', subdirs: ['minecraft', '.minecraft', ''] },
  { launcher: 'PineconeMC', dir: '%APPDATA%\\ElyPrismLauncher\\instances', subdirs: ['minecraft', '.minecraft', ''] },
  { launcher: 'PineconeMC', dir: '%APPDATA%\\PineconeMC\\instances', subdirs: ['minecraft', '.minecraft', ''] },
  { launcher: 'MultiMC', dir: '%APPDATA%\\MultiMC\\instances', subdirs: ['minecraft', '.minecraft', ''] },
  { launcher: 'Modrinth App', dir: '%APPDATA%\\ModrinthApp\\profiles', subdirs: ['', 'minecraft', '.minecraft'] },
  { launcher: 'Modrinth App', dir: '%APPDATA%\\com.modrinth.theseus\\profiles\\profiles', subdirs: ['', 'minecraft', '.minecraft'] },
  { launcher: 'ATLauncher', dir: '%APPDATA%\\ATLauncher\\instances', subdirs: ['', 'minecraft', '.minecraft'] },
  { launcher: 'GDLauncher', dir: '%APPDATA%\\GDLauncher\\instances', subdirs: ['instance', 'minecraft', '.minecraft', ''] },
  { launcher: 'GDLauncher', dir: '%APPDATA%\\gdlauncher_next\\instances', subdirs: ['instance', 'minecraft', '.minecraft', ''] },
  { launcher: 'CurseForge', dir: '%USERPROFILE%\\curseforge\\minecraft\\Instances', subdirs: ['', 'minecraft', '.minecraft'] },
  { launcher: 'CurseForge', dir: '%APPDATA%\\CurseForge\\minecraft\\Instances', subdirs: ['', 'minecraft', '.minecraft'] },
];

function exists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function isDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function stamp(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function logStamp(dir) {
  return stamp(path.join(dir, 'logs', 'latest.log'));
}

/** Expands `%APPDATA%`, `%USERPROFILE%`, `~` and quotes around a pasted path. */
export function expandPath(value) {
  let text = String(value || '').trim();
  if (!text) return '';
  if (/^".*"$/.test(text)) text = text.slice(1, -1);
  text = text.replace(/%([^%]+)%/g, (match, name) => {
    const key = String(name);
    return process.env[key] ?? process.env[key.toUpperCase()] ?? match;
  });
  if (text === '~') text = os.homedir();
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = path.join(os.homedir(), text.slice(1));
  return path.resolve(text);
}

/** A game folder always has at least one of these next to `servers.dat`. */
export function isGameDir(dir) {
  if (!dir || !isDir(dir)) return false;
  return GAME_MARKERS.some((name) => exists(path.join(dir, name)));
}

function newest(items) {
  return [...items].sort((a, b) => b.mtime - a.mtime)[0] || null;
}

/** Finds game folders directly under an instances/profiles directory. */
function childGameDirs(parent, subdirs) {
  let entries;
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const base = path.join(parent, entry.name);
    for (const sub of subdirs) {
      const candidate = sub ? path.join(base, sub) : base;
      if (!isGameDir(candidate)) continue;
      out.push({
        path: candidate,
        instance: entry.name,
        mtime: Math.max(logStamp(candidate), stamp(candidate)),
      });
      break;
    }
  }
  return out;
}

/**
 * Resolves a folder picked by hand. Accepts the game folder itself, its parent
 * (`...\instances\My pack`), a launcher data folder or a portable root.
 */
export function resolveGameDir(value) {
  const dir = expandPath(value);
  if (!dir || !isDir(dir)) return null;
  if (isGameDir(dir)) return dir;

  for (const sub of ['.minecraft', 'minecraft', 'instance']) {
    const candidate = path.join(dir, sub);
    if (isGameDir(candidate)) return candidate;
  }

  for (const group of ['instances', 'Instances', 'profiles']) {
    const found = newest(childGameDirs(path.join(dir, group), ['minecraft', '.minecraft', 'instance', '']));
    if (found) return found.path;
  }

  const found = newest(childGameDirs(dir, ['minecraft', '.minecraft', 'instance', '']));
  return found ? found.path : null;
}

/** All game folders found in the known launcher locations, newest first. */
export function scanGameDirs({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && now - cache.at < CACHE_MS) return cache.dirs;

  const found = [];
  const seen = new Set();
  const add = (dir, launcher, instance = '') => {
    if (!dir) return;
    const key = dir.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ path: dir, launcher, instance, mtime: Math.max(logStamp(dir), stamp(dir)) });
  };

  for (const item of FIXED) {
    const dir = expandPath(item.dir);
    if (isGameDir(dir)) add(dir, item.launcher);
    else {
      const resolved = resolveGameDir(dir);
      if (resolved) add(resolved, item.launcher);
    }
  }

  for (const item of GROUPS) {
    for (const entry of childGameDirs(expandPath(item.dir), item.subdirs)) {
      add(entry.path, item.launcher, entry.instance);
    }
  }

  found.sort((a, b) => b.mtime - a.mtime);
  cache = { at: now, dirs: found };
  return found;
}

/** The configured folder when it is valid, otherwise the newest auto-detected one. */
export function activeGameDir(configured = '') {
  const resolved = configured ? resolveGameDir(configured) : null;
  if (resolved) return resolved;
  return scanGameDirs()[0]?.path || null;
}

export function minecraftInstalled(configured = '') {
  return Boolean(activeGameDir(configured));
}

export function serversDatPath(configured = '') {
  const dir = activeGameDir(configured);
  return dir ? path.join(dir, 'servers.dat') : null;
}

/**
 * The log of the running instance. When no folder is configured, the newest
 * `latest.log` wins — that is the instance the player has just launched.
 */
export function findLatestLog(configured = '') {
  if (configured) {
    const dir = resolveGameDir(configured);
    if (!dir) return null;
    const file = path.join(dir, 'logs', 'latest.log');
    return exists(file) ? { file, dir, mtime: stamp(file) } : null;
  }

  let best = null;
  for (const item of scanGameDirs()) {
    const file = path.join(item.path, 'logs', 'latest.log');
    if (!exists(file)) continue;
    const mtime = stamp(file);
    if (!best || mtime > best.mtime) best = { file, dir: item.path, mtime };
  }
  return best;
}
