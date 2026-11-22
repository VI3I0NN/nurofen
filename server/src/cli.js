#!/usr/bin/env node
/**
 * Nurofen control plane CLI.
 *
 *   node src/cli.js init --host <public-ip> [--port 51820] [--pool 443,500,4500]
 *   node src/cli.js info
 *   node src/cli.js create <network> <password>
 *   node src/cli.js passwd <network> <new-password>
 *   node src/cli.js delete-network <network>
 *   node src/cli.js kick <id|name|ip>
 *   node src/cli.js ports 443,500,4500
 */
import process from 'node:process';
import { generateObfuscation, loadConfig, rootDir, SUPERNET, writeConfig } from './config.js';
import { applyIsolation, applyPortPool, awgStatus, syncAddresses, syncPeers } from './awg.js';
import {
  createNetwork,
  deleteNetwork,
  findNetworkByName,
  peersOfNetwork,
  revokePeer,
  setNetworkPassword,
  validatePassword,
} from './network.js';

const cfg = loadConfig(rootDir());
const [, , command = 'info', ...rest] = process.argv;

function flag(name, fallback = undefined) {
  const index = rest.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return rest[index + 1] ?? true;
}

function save() {
  writeConfig(cfg, rootDir());
}

function printInfo() {
  console.log(`supernet   ${SUPERNET}`);
  console.log(`adminToken ${cfg.adminToken}`);
  console.log(`endpoint   ${cfg.server.publicHost || '<not set>'}:${cfg.server.awgPort} udp`);
  console.log(`port pool  ${(cfg.server.portPool || []).join(', ') || '-'}`);
  console.log(`interface  ${cfg.server.interface}  mtu ${cfg.server.mtu}`);
  console.log(`networks   ${cfg.networks.length}`);
  for (const network of cfg.networks) {
    const peers = peersOfNetwork(cfg, network.id);
    console.log(`  - ${network.name.padEnd(20)} ${network.subnet}  peers ${peers.length}`);
    for (const peer of peers) {
      console.log(`      ${peer.name.padEnd(18)} ${peer.ip.padEnd(15)} ${peer.lastSeen || ''}`);
    }
  }
}

async function applyNetworkChange() {
  save();
  await syncAddresses(cfg);
  await syncPeers(cfg);
  await applyIsolation(cfg);
}

switch (command) {
  case 'init': {
    const host = flag('host');
    if (host) cfg.server.publicHost = String(host);
    const port = Number(flag('port', 0));
    if (port) cfg.server.awgPort = port;
    const apiPort = Number(flag('api-port', 0));
    if (apiPort) cfg.server.apiPort = apiPort;
    const pool = flag('pool');
    if (pool) {
      const extra = String(pool)
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0 && value < 65536);
      // The listen port always comes first, the extras are redirect targets.
      cfg.server.portPool = [...new Set([cfg.server.awgPort, ...extra])];
    }
    save();
    printInfo();
    break;
  }
  case 'info':
  case 'networks':
    printInfo();
    break;
  case 'create': {
    const name = String(rest[0] || '').trim();
    const password = String(rest[1] || '').trim();
    if (!name || !password) {
      console.error('usage: cli.js create <network> <password>');
      process.exit(1);
    }
    const network = createNetwork(cfg, { name, password });
    await applyNetworkChange();
    console.log(`created "${network.name}" ${network.subnet}`);
    break;
  }
  case 'passwd': {
    const network = findNetworkByName(cfg, rest[0]);
    if (!network) {
      console.error(`network not found: ${rest[0] || ''}`);
      process.exit(1);
    }
    const password = validatePassword(rest[1]);
    setNetworkPassword(network, password);
    save();
    console.log(`password updated for "${network.name}"`);
    break;
  }
  case 'delete-network': {
    const network = findNetworkByName(cfg, rest[0]);
    if (!network) {
      console.error(`network not found: ${rest[0] || ''}`);
      process.exit(1);
    }
    deleteNetwork(cfg, network.id);
    await applyNetworkChange();
    console.log(`deleted "${network.name}"`);
    break;
  }
  case 'kick': {
    const needle = String(rest[0] || '').toLowerCase();
    const peer = cfg.peers.find(
      (item) =>
        !item.revoked &&
        (item.id === needle || item.ip === needle || String(item.name).toLowerCase() === needle),
    );
    if (!peer) {
      console.error(`peer not found: ${needle}`);
      process.exit(1);
    }
    revokePeer(cfg, peer.id);
    save();
    await syncPeers(cfg);
    console.log(`kicked ${peer.name} (${peer.ip})`);
    break;
  }
  case 'ports': {
    const list = String(rest[0] || '').split(',').map(Number).filter(Boolean);
    cfg.server.portPool = list;
    save();
    console.log(JSON.stringify(await applyPortPool(cfg), null, 2));
    break;
  }
  case 'reseed': {
    cfg.awg.obfuscation = generateObfuscation();
    save();
    console.log(JSON.stringify(cfg.awg.obfuscation, null, 2));
    console.log('\nrestart the service: systemctl restart nurofen');
    console.log('clients pick the new parameters up on their next reconnect');
    break;
  }
  case 'status': {
    console.log(JSON.stringify(await awgStatus(cfg), null, 2));
    break;
  }
  case 'prune': {
    const before = cfg.peers.length;
    cfg.peers = cfg.peers.filter((peer) => !peer.revoked || Date.now() - Date.parse(peer.updatedAt || peer.createdAt) < 30 * 864e5);
    save();
    console.log(`pruned ${before - cfg.peers.length} revoked peer(s)`);
    break;
  }
  default:
    console.log('commands: init | info | create | passwd | delete-network | kick | ports | reseed | status | prune');
    console.log(`networks: ${cfg.networks.length}, peers: ${cfg.peers.filter((peer) => !peer.revoked).length}`);
    process.exit(command === 'help' ? 0 : 1);
}
