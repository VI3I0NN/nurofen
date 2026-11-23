/**
 * Nurofen Play — launching the game through the launcher the player already has.
 *
 * The network is the point: friends open a world, Nurofen knows the address,
 * and one click starts Minecraft already connected to it. Nurofen does not
 * download game files and does not own accounts — it drives Prism/Pinecone
 * through their CLI and TLauncher Legacy through the server list the game
 * reads on startup.
 *
 * Prism and its forks accept `-l <instance> -s <address>`, which is exactly
 * "launch this instance and join this server". TLauncher Legacy has no
 * documented launch-profile flag, so the address is written to its
 * `servers.dat` and the launcher is started; the player picks the entry from
 * "Сетевая игра". That is honest and survives launcher updates.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expandPath, isGameDir, runningGameDir, scanGameDirs } from './minecraftPaths.js';
import { upsertServer } from './servers.js';

const CACHE_MS = 15_000;
const ADDRESS_RE = /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/;
const RUNNING_MS = 90_000;

let cache = { at: 0, launchers: [] };
let lastLaunch = null;

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

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** `instance.cfg` is a flat INI; section names do not matter for our keys. */
function readIni(file) {
  const out = {};
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([^=;#][^=]*?)\s*=\s*(.*?)\s*$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

const LOADERS = [
  { uid: 'net.fabricmc.fabric-loader', label: 'Fabric' },
  { uid: 'org.quiltmc.quilt-loader', label: 'Quilt' },
  { uid: 'net.neoforged', label: 'NeoForge' },
  { uid: 'net.minecraftforge', label: 'Forge' },
  { uid: 'org.multimc.optifine', label: 'OptiFine' },
];

/** Prism keeps one folder per instance; the folder name is the CLI instance ID. */
function prismInstance(instanceDir, id) {
  const cfg = readIni(path.join(instanceDir, 'instance.cfg'));
  const pack = readJson(path.join(instanceDir, 'mmc-pack.json'));
  const components = Array.isArray(pack?.components) ? pack.components : [];
  const game = components.find((item) => item?.uid === 'net.minecraft');
  let loader = '';
  let loaderVersion = '';
  for (const item of LOADERS) {
    const found = components.find((component) => component?.uid === item.uid);
    if (!found) continue;
    loader = item.label;
    loaderVersion = String(found.version || '');
    break;
  }

  let gameDir = '';
  for (const sub of ['minecraft', '.minecraft', '']) {
    const candidate = sub ? path.join(instanceDir, sub) : instanceDir;
    if (isGameDir(candidate)) {
      gameDir = candidate;
      break;
    }
  }
  if (!gameDir) gameDir = path.join(instanceDir, 'minecraft');

  return {
    id,
    name: String(cfg.name || id).replace(/^"(.*)"$/, '$1'),
    version: String(game?.version || ''),
    loader,
    loaderVersion,
    gameDir,
    gameDirs: [gameDir],
    lastPlayed: Number(cfg.lastLaunchTime) || stamp(path.join(gameDir, 'logs', 'latest.log')) || stamp(instanceDir),
    note: '',
  };
}

function readPrismInstances(root) {
  const dir = path.join(root, 'instances');
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const instanceDir = path.join(dir, entry.name);
    try {
      out.push(prismInstance(instanceDir, entry.name));
    } catch {
      // one broken instance must not hide the rest
    }
  }
  return out.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || a.name.localeCompare(b.name, 'ru'));
}

const PRISM_INSTALLS = [
  {
    name: 'Prism Launcher',
    root: '%APPDATA%\\PrismLauncher',
    exes: [
      '%LOCALAPPDATA%\\Programs\\PrismLauncher\\prismlauncher.exe',
      '%PROGRAMFILES%\\PrismLauncher\\prismlauncher.exe',
      '%PROGRAMFILES(X86)%\\PrismLauncher\\prismlauncher.exe',
      '%USERPROFILE%\\PrismLauncher\\prismlauncher.exe',
    ],
    portable: ['prismlauncher.exe'],
  },
  {
    name: 'PineconeMC',
    root: '%APPDATA%\\ElyPrismLauncher',
    exes: [
      '%LOCALAPPDATA%\\Programs\\ElyPrismLauncher\\elyprismlauncher.exe',
      '%PROGRAMFILES%\\ElyPrismLauncher\\elyprismlauncher.exe',
      '%PROGRAMFILES(X86)%\\ElyPrismLauncher\\elyprismlauncher.exe',
    ],
    portable: ['elyprismlauncher.exe'],
  },
  {
    name: 'PineconeMC',
    root: '%APPDATA%\\PineconeMC',
    exes: [
      '%LOCALAPPDATA%\\Programs\\PineconeMC\\pineconemc.exe',
      '%PROGRAMFILES%\\PineconeMC\\pineconemc.exe',
    ],
    portable: ['pineconemc.exe'],
  },
];

function firstExisting(list) {
  for (const value of list) {
    const file = expandPath(value);
    if (exists(file)) return file;
  }
  return '';
}

function prismLauncher(entry) {
  let root = expandPath(entry.root);
  let exe = firstExisting(entry.exes);
  for (const name of entry.portable) {
    const candidate = path.join(root, name);
    if (exists(candidate)) {
      exe = candidate;
      break;
    }
  }
  // A portable install may live outside %APPDATA%; its data sits next to the exe.
  if (!isDir(root) && exe) root = path.dirname(exe);
  if (!isDir(root) && !exe) return null;

  const instances = readPrismInstances(root);
  if (!instances.length && !exe) return null;

  return {
    id: `prism:${root.toLowerCase()}`,
    kind: 'prism',
    name: entry.name,
    exe,
    root,
    available: Boolean(exe),
    note: exe ? '' : 'исполняемый файл не найден',
    instances,
  };
}

function scanForExe(dir, depth, pattern, out, seen) {
  const key = String(dir).toLowerCase();
  if (seen.has(key) || depth < 0) return;
  seen.add(key);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      if (pattern.test(entry.name)) out.push(full);
      continue;
    }
    if (!entry.isDirectory() || depth === 0) continue;
    if (/^(cache|logs|versions|libraries|assets|runtime|mods|saves|resourcepacks|shaderpacks|webcache2?)$/i.test(entry.name)) continue;
    scanForExe(full, depth - 1, pattern, out, seen);
  }
}

const TLAUNCHER_EXES = [
  '%APPDATA%\\.tlauncher\\TLauncher.exe',
  '%APPDATA%\\.tlauncher\\legacy\\TLauncher.exe',
  '%APPDATA%\\.tlauncher\\legacy\\Minecraft\\TLauncher.exe',
  '%APPDATA%\\.minecraft\\TLauncher.exe',
  '%LOCALAPPDATA%\\Programs\\TLauncher\\TLauncher.exe',
  '%PROGRAMFILES%\\TLauncher\\TLauncher.exe',
  '%PROGRAMFILES(X86)%\\TLauncher\\TLauncher.exe',
  '%USERPROFILE%\\Desktop\\TLauncher.exe',
];

function findTlauncherExe() {
  const direct = firstExisting(TLAUNCHER_EXES);
  if (direct) return direct;

  const found = [];
  const seen = new Set();
  scanForExe(expandPath('%APPDATA%\\.tlauncher'), 3, /^TLauncher.*\.exe$/i, found, seen);
  scanForExe(expandPath('%APPDATA%\\.minecraft'), 1, /^TLauncher.*\.exe$/i, found, seen);
  scanForExe(expandPath('%USERPROFILE%\\Desktop'), 0, /^TLauncher.*\.exe$/i, found, seen);
  scanForExe(expandPath('%LOCALAPPDATA%\\Programs'), 2, /^TLauncher.*\.exe$/i, found, seen);
  return found[0] || '';
}

function tlauncherGameDirs() {
  const dirs = [];
  const seen = new Set();
  const add = (dir) => {
    if (!dir || seen.has(dir.toLowerCase())) return;
    seen.add(dir.toLowerCase());
    dirs.push(dir);
  };
  for (const item of scanGameDirs()) {
    if (/tlauncher/i.test(item.launcher)) add(item.path);
  }
  for (const value of [
    '%APPDATA%\\.tlauncher\\legacy\\Minecraft\\game',
    '%APPDATA%\\.tlauncher\\legacy\\game',
  ]) {
    const dir = expandPath(value);
    if (isGameDir(dir)) add(dir);
  }
  return dirs.sort((a, b) => stamp(path.join(b, 'logs', 'latest.log')) - stamp(path.join(a, 'logs', 'latest.log')));
}

function tlauncherLauncher(exe) {
  const gameDirs = tlauncherGameDirs();
  const gameDir = gameDirs[0] || '';
  const lastPlayed = gameDirs.reduce((best, dir) => Math.max(best, stamp(path.join(dir, 'logs', 'latest.log'))), 0);
  return {
    id: 'tlauncher',
    kind: 'tlauncher',
    name: 'TLauncher Legacy',
    exe,
    root: expandPath('%APPDATA%\\.tlauncher'),
    available: Boolean(exe),
    note: exe ? '' : 'исполняемый файл не найден',
    instances: [
      {
        id: 'default',
        name: 'TLauncher Legacy',
        version: '',
        loader: '',
        loaderVersion: '',
        gameDir,
        gameDirs,
        lastPlayed,
        note: 'Сборку и версию выбирают в самом TLauncher',
      },
    ],
  };
}

/**
 * The player may keep a launcher somewhere unusual. A hand-picked exe is used
 * for the launcher of the same family instead of replacing auto-detection.
 */
function applyExeOverride(launchers, value) {
  const exe = expandPath(value || '');
  if (!exe || !exists(exe)) return;
  const base = path.basename(exe).toLowerCase();
  const kind = /tlauncher/.test(base) ? 'tlauncher' : 'prism';
  const existing = launchers.find((item) => item.kind === kind);
  if (existing) {
    existing.exe = exe;
    existing.available = true;
    existing.note = '';
    return;
  }
  if (kind === 'tlauncher') {
    launchers.push(tlauncherLauncher(exe));
    return;
  }
  const root = PRISM_INSTALLS
    .map((item) => expandPath(item.root))
    .find((candidate) => isDir(path.join(candidate, 'instances')))
    || path.dirname(exe);
  const instances = readPrismInstances(root);
  launchers.push({
    id: `prism:${root.toLowerCase()}`,
    kind: 'prism',
    name: base.includes('pinecone') || base.includes('ely') ? 'PineconeMC' : 'Prism Launcher',
    exe,
    root,
    available: true,
    note: '',
    instances,
  });
}

function detectLaunchers(settings = {}) {
  const launchers = [];
  const seen = new Set();
  for (const entry of PRISM_INSTALLS) {
    const launcher = prismLauncher(entry);
    if (!launcher || seen.has(launcher.id)) continue;
    seen.add(launcher.id);
    launchers.push(launcher);
  }

  const tlauncherExe = findTlauncherExe();
  if (tlauncherExe || tlauncherGameDirs().length) launchers.push(tlauncherLauncher(tlauncherExe));

  applyExeOverride(launchers, settings.playExe);
  return launchers;
}

function resolveSelection(launchers, settings = {}) {
  const saved = launchers.find((item) => item.id === settings.playLauncher);
  if (saved) {
    const instance = saved.instances.find((item) => item.id === settings.playInstance) || saved.instances[0];
    if (instance) return { launcher: saved.id, instance: instance.id };
  }

  let best = null;
  for (const launcher of launchers) {
    if (!launcher.available) continue;
    for (const instance of launcher.instances) {
      if (!best || (instance.lastPlayed || 0) > best.lastPlayed) {
        best = { launcher: launcher.id, instance: instance.id, lastPlayed: instance.lastPlayed || 0 };
      }
    }
  }
  if (best) return { launcher: best.launcher, instance: best.instance };

  const fallback = launchers.find((item) => item.instances.length);
  return fallback ? { launcher: fallback.id, instance: fallback.instances[0].id } : null;
}

/** Everything the Play window needs; launcher detection is cached briefly. */
export function playInfo(settings = {}, { refresh = false } = {}) {
  const now = Date.now();
  if (refresh || now - cache.at > CACHE_MS) {
    cache = { at: now, launchers: detectLaunchers(settings) };
  }
  const running = runningGameDir(RUNNING_MS);
  return {
    launchers: cache.launchers,
    selected: resolveSelection(cache.launchers, settings),
    last: lastLaunch,
    running: running ? { dir: running.dir, at: running.mtime } : null,
    configuredExe: String(settings.playExe || ''),
  };
}

function spawnDetached(exe, args, cwd) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, args, {
        cwd: cwd || path.dirname(exe),
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Writes the world into the launcher's own server list, then starts it.
 * `address` is optional: the plain "Играть" button only opens the game.
 */
export async function launchGame({ launcher, instance, address = '', name = '', settings = {} } = {}) {
  const info = playInfo(settings);
  const target = info.launchers.find((item) => item.id === launcher);
  if (!target) throw new Error('play_launcher_not_found');
  const build = target.instances.find((item) => item.id === instance) || target.instances[0];
  if (!build) throw new Error('play_instance_not_found');
  if (!target.available || !target.exe) throw new Error('play_launcher_not_found');

  const world = ADDRESS_RE.test(String(address || '').trim()) ? String(address).trim() : '';
  const label = String(name || world || build.name).slice(0, 60);
  const files = [];
  if (world) {
    const dirs = target.kind === 'tlauncher'
      ? (build.gameDirs?.length ? build.gameDirs : [build.gameDir])
      : [build.gameDir];
    for (const dir of dirs) {
      if (!dir) continue;
      try {
        const result = upsertServer({ name: `Nurofen · ${label}`, ip: world, dir });
        if (!files.includes(result.file)) files.push(result.file);
      } catch {
        // The game can still start; Prism receives the address on its own.
      }
    }
  }

  const running = runningGameDir(RUNNING_MS);
  if (running) {
    // Never start a second client: Minecraft keeps `servers.dat` in memory and
    // writes it back on exit, so the entry goes into the running folder too.
    if (world && build.gameDir && running.dir.toLowerCase() !== build.gameDir.toLowerCase()) {
      try {
        const extra = upsertServer({ name: `Nurofen · ${label}`, ip: world, dir: running.dir });
        if (!files.includes(extra.file)) files.push(extra.file);
      } catch {
        // the running instance may be read-only; the message below stays honest
      }
    }
    const message = world
      ? (files.length
        ? 'Игра уже запущена — мир добавлен в список «Сетевая игра»'
        : 'Игра уже запущена — закройте её, чтобы подключиться к миру')
      : 'Игра уже запущена';
    lastLaunch = {
      at: Date.now(), launcher: target.id, instance: build.id, address: world, name: label, ok: true, message,
    };
    return {
      ok: true, alreadyRunning: true, message, address: world, files,
      launcher: { id: target.id, name: target.name, kind: target.kind },
      instance: { id: build.id, name: build.name, version: build.version },
    };
  }

  const args = target.kind === 'prism'
    ? ['-l', build.id, ...(world ? ['-s', world] : [])]
    : [];

  try {
    await spawnDetached(target.exe, args, path.dirname(target.exe));
  } catch {
    lastLaunch = {
      at: Date.now(), launcher: target.id, instance: build.id, address: world, name: label, ok: false,
      message: 'Не удалось запустить лаунчер',
    };
    throw new Error('play_launch_failed');
  }

  let message;
  if (target.kind === 'tlauncher') {
    message = world
      ? (files.length
        ? 'TLauncher открывается — мир уже в списке «Сетевая игра»'
        : 'TLauncher открывается — выберите мир в игре')
      : 'TLauncher открывается';
  } else {
    message = world
      ? 'Игра запускается — подключение к миру начнётся само'
      : 'Игра запускается';
  }

  lastLaunch = {
    at: Date.now(), launcher: target.id, instance: build.id, address: world, name: label, ok: true, message,
  };

  return {
    ok: true,
    message,
    address: world,
    files,
    launcher: { id: target.id, name: target.name, kind: target.kind },
    instance: { id: build.id, name: build.name, version: build.version },
  };
}
