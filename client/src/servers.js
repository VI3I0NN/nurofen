/**
 * servers.dat — the file the Minecraft client reads its multiplayer list from.
 *
 * Writing it directly is the difference between "here is an IP address, copy
 * it, open the game, type it in" and "click once, the server is in your list".
 *
 * The format is gzipped NBT; anything we do not understand is preserved so a
 * file written by the game (or by another launcher) survives untouched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TAG, byte, compound, gunzipNbt, gzipNbt, list, string } from './nbt.js';

const MAX_SERVERS = 64;

/** `%APPDATA%\.minecraft`, honouring a custom install when one is obvious. */
export function minecraftDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, '.minecraft');
}

export function serversDatPath() {
  return path.join(minecraftDir(), 'servers.dat');
}

/**
 * Reads the current list. A missing or unreadable file is not an error: the
 * game creates it on first save, and creating it ourselves is exactly what
 * makes "add to list" work on a fresh install.
 */
export function readServers() {
  const file = serversDatPath();
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
export function upsertServer({ name, ip, aliases = [] }) {
  const wanted = String(ip || '').trim();
  if (!wanted) throw new Error('server_required');
  const dir = minecraftDir();
  fs.mkdirSync(dir, { recursive: true });

  const { servers, root } = readServers();
  const label = String(name || wanted).slice(0, 60);
  const sameTarget = (value) => value === wanted || aliases.includes(value);
  const keep = servers.filter((server) => server.ip && !sameTarget(server.ip));
  const merged = [{ name: label, ip: wanted }, ...keep].slice(0, MAX_SERVERS);

  const next = root?.value ? root : compound({});
  next.value.servers = list(TAG.COMPOUND, merged.map(entry));

  const file = serversDatPath();
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

/** True when the game's folder exists, i.e. adding a server is meaningful. */
export function minecraftInstalled() {
  try {
    return fs.existsSync(minecraftDir());
  } catch {
    return false;
  }
}
