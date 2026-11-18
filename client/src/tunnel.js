import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HELPER_PORT, TUNNEL_NAME, confDir, findAwg, helperTokenFile, programDataDir, ensureDir } from './paths.js';

export function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30000, windowsHide: true, ...options }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error });
    });
  });
}

export function ps(script) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
}

export function readHelperToken() {
  try {
    return fs.readFileSync(helperTokenFile(), 'utf8').trim();
  } catch {
    return '';
  }
}

export async function helperAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${HELPER_PORT}/health`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}

async function helperCall(route, body) {
  const token = readHelperToken();
  const res = await fetch(`http://127.0.0.1:${HELPER_PORT}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `helper ${res.status}`);
  return data;
}

/** Local (non-elevated) direct mode, used only as a fallback for debugging. */
async function direct(method, config, name) {
  const exe = findAwg();
  if (!exe) throw new Error('awg_missing');
  const file = path.join(ensureDir(confDir()), `${name}.conf`);
  if (method === 'up') {
    fs.writeFileSync(file, config, { mode: 0o600 });
    const result = await run(exe, ['/installtunnelservice', file]);
    if (!result.ok) throw new Error(`install failed: ${result.stderr || result.code}`);
    return { ok: true, mode: 'direct' };
  }
  const result = await run(exe, ['/uninstalltunnelservice', name]);
  if (!result.ok) throw new Error(`uninstall failed: ${result.stderr || result.code}`);
  return { ok: true, mode: 'direct' };
}

export async function tunnelUp(config, name = TUNNEL_NAME) {
  if (await helperAlive()) {
    const result = await helperCall('/tunnel/up', { name, config });
    return { ...result, mode: 'helper' };
  }
  return direct('up', config, name);
}

export async function tunnelDown(name = TUNNEL_NAME) {
  if (await helperAlive()) {
    const result = await helperCall('/tunnel/down', { name });
    return { ...result, mode: 'helper' };
  }
  return direct('down', null, name);
}

/**
 * Tunnel state comes from the network adapter, not from the AmneziaWG manager:
 * the manager IPC is private to its own UI, while the adapter state is exactly
 * what matters for "can I reach my friends".
 */
export async function tunnelStatus(name = TUNNEL_NAME) {
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'
    $adapter = Get-NetAdapter -Name '${name}'
    $ip = (Get-NetIPAddress -InterfaceAlias '${name}' -AddressFamily IPv4).IPAddress
    if ($null -eq $adapter) { '{"exists":false}' } else {
      ConvertTo-Json -Compress -InputObject ([pscustomobject]@{
        exists = $true
        status = [string]$adapter.Status
        ip = [string]$ip
        description = [string]$adapter.InterfaceDescription
      })
    }
  `;
  const result = await ps(script);
  try {
    const data = JSON.parse(result.stdout.trim() || '{"exists":false}');
    return { ...data, up: data.exists === true && String(data.status).toLowerCase() === 'up' };
  } catch {
    return { exists: false, up: false };
  }
}

export async function ping(host, timeoutMs = 900) {
  if (!host) return { ok: false, ms: null };
  const result = await run('ping.exe', ['-n', '1', '-w', String(timeoutMs), host]);
  const text = `${result.stdout}${result.stderr}`;
  // "time=12ms" / "время=12мс"; a bare TTL line still means the host answered.
  const match = /(?:time|время)[=<]\s*(\d+)\s*(?:ms|мс|мсек)/i.exec(text);
  if (match) return { ok: true, ms: Number(match[1]) };
  if (/TTL=\d+/i.test(text)) return { ok: true, ms: null };
  return { ok: false, ms: null };
}

/** Downloads and silently installs the official AmneziaWG Windows client. */
export async function ensureAmneziawg(log = console) {
  if (findAwg()) return { installed: true, path: findAwg() };
  const msi = path.join(process.env.TEMP || programDataDir(), 'amneziawg-amd64.msi');
  const url = 'https://github.com/amnezia-vpn/amneziawg-windows-client/releases/download/3.1.0/amneziawg-amd64-3.1.0.msi';
  log.info?.(`[awg] downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(msi, buffer);
  const install = await run('msiexec.exe', ['/i', msi, '/qn', '/norestart']);
  if (!install.ok) throw new Error(`msiexec failed: ${install.stderr || install.code}`);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const found = findAwg();
  if (!found) throw new Error('amneziawg installed but cli not found');
  return { installed: true, path: found };
}
