#!/usr/bin/env node
/**
 * Nurofen control plane CLI.
 *
 *   node src/cli.js init --host <public-ip> [--port 51820] [--pool 443,500,4500]
 *   node src/cli.js info
 *   node src/cli.js invite
 *   node src/cli.js rotate
 *   node src/cli.js kick <id|name|ip>
 *   node src/cli.js ports 443,500,4500
 */
import process from 'node:process';
import { generateObfuscation, loadConfig, rootDir, subnetInfo, writeConfig } from './config.js';
import { awgStatus, applyPortPool, syncPeers } from './awg.js';
import { peersOfNetwork, publicPeer, revokePeer, rotateInvite } from './network.js';

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
  const net = subnetInfo(cfg);
  console.log(`network    ${cfg.networks[0].name}  ${net.cidr}  (hub ${net.serverIp})`);
  console.log(`invite     ${cfg.networks[0].invite}`);
  console.log(`adminToken ${cfg.adminToken}`);
  console.log(`endpoint   ${cfg.server.publicHost || '<not set>'}:${cfg.server.awgPort} udp`);
  console.log(`port pool  ${(cfg.server.portPool || []).join(', ') || '-'}`);
  console.log(`interface  ${cfg.server.interface}  mtu ${cfg.server.mtu}`);
  const peers = peersOfNetwork(cfg, cfg.networks[0].id);
  console.log(`peers      ${peers.length}`);
  for (const peer of peers) {
    console.log(`  - ${peer.name.padEnd(20)} ${peer.ip.padEnd(15)} ${peer.lastSeen || ''}`);
  }
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
    printInfo();
    break;
  case 'invite':
    console.log(cfg.networks[0].invite);
    break;
  case 'rotate': {
    const network = rotateInvite(cfg, cfg.networks[0].id);
    save();
    console.log(network.invite);
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
    console.log('commands: init | info | invite | rotate | kick | ports | reseed | status | prune');
    console.log(`peers: ${cfg.peers.map((peer) => publicPeer(peer)).filter((peer) => !peer.revoked).length}`);
    process.exit(command === 'help' ? 0 : 1);
}
