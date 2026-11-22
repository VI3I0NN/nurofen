/**
 * servers.dat — the file the Minecraft client reads its multiplayer list from.
 *
 * Writing it directly is the difference between "here is an IP address, copy
 * it, open the game, type it in" and "click once, the server is in your list".
 *
 * The format is gzipped NBT; anything we do not understand is preserved so a
 * file written by the game (or by another launcher) survives untouched.
 *
 * The game folder is not always `%APPDATA%\.minecraft`: Prism, PineconeMC,
 * TLauncher Legacy and the rest each keep their own tree, so every entry point
 * takes the configured path (empty means auto-detect).
 */
import fs from 'node:fs';
import path from 'node:path';
import { TAG, byte, compound, gunzipNbt, gzipNbt, list, string } from './nbt.js';
import { activeGameDir } from './minecraftPaths.js';

const MAX_SERVERS = 64;

/** `servers.dat` of the configured or auto-detected game folder, or null. */
export function serversDatPath(configuredDir = '') {
  const dir = activeGameDir(configuredDir);
  return dir ? path.join(dir, 'servers.dat') : null;
}

/**
 * Reads the current list. A missing or unreadable file is not an error: the
 * game creates it on first save, and creating it ourselves is exactly what
 * makes "add to list" work on a fresh install.
 */
export function readServers(configuredDir = '') {
  const file = serversDatPath(configuredDir);
  if (!file) return { servers: [], file: null, fresh: true };
  let root;
  try {
    root = gunzipNbt(fs.readFileSync(file));
  } catch {
    return { servers: [], file, fresh: true };
  }
  const listNode = root.value?.servers;
  const raw = listNode?.value?.items || [];
  const servers = raw
    .filter((item) => item.type === TAG.COMPOUND && item.value)
    .map((item) => ({
      name: item.value.name?.value ?? '',
      ip: item.value.ip?.value ?? '',
      icon: item.value.icon?.value ?? '',
      acceptTextures: Number(item.value.acceptTextures?.value ?? 0),
      hidden: Number(item.value.hidden?.value ?? 0),
    }));
  return { servers, file, root, fresh: false };
}

function entry({ name, ip, icon, acceptTextures, hidden }) {
  return compound({
    name: string(name),
    ip: string(ip),
    icon: string(icon || ''),
    acceptTextures: byte(acceptTextures ?? 1),
    hidden: byte(hidden ?? 0),
  });
}

/**
 * Adds a server to the list, or updates the entry with the same address.
 * Returns the address that was written so the UI can show it verbatim.
 */
export function upsertServer({ name, ip, aliases = [], dir = '' }) {
  const wanted = String(ip || '').trim();
  if (!wanted) throw new Error('server_required');
  const file = serversDatPath(dir);
  if (!file) throw new Error('minecraft_not_found');
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const { servers, root } = readServers(dir);
  const label = String(name || wanted).slice(0, 60);
  const sameTarget = (value) => value === wanted || aliases.includes(value);
  const keep = servers.filter((server) => server.ip && !sameTarget(server.ip));
  const merged = [{ name: label, ip: wanted }, ...keep].slice(0, MAX_SERVERS);

  const next = root?.value ? root : compound({});
  next.value.servers = list(TAG.COMPOUND, merged.map(entry));

  const temp = `${file}.nurofen.tmp`;
  fs.writeFileSync(temp, gzipNbt(next));
  try {
    // Keep one generation back: a corrupt player list is a bad way to repay
    // someone who only wanted to join a world.
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.nurofen.bak`);
  } catch {
    // a failed backup must not block the write
  }
  fs.renameSync(temp, file);
  return { ok: true, ip: wanted, name: label, file, count: merged.length };
}

/** True when a usable game folder is configured or detected. */
export function minecraftInstalled(configuredDir = '') {
  return Boolean(activeGameDir(configuredDir));
}
