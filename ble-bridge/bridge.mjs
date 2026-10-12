// RushPay demo server + BLE bridge. Run: npm run demo  (builds the app first)
//
// 1. Serves the static app (./out) on port 3000, on every interface:
//      laptop:  http://localhost:3000/?role=student
//      phone:   http://<laptop-ip>:3000/?role=vendor   (load it BEFORE turning Wi-Fi off)
// 2. Runs the Swift BLE peripheral and relays between it and the student page:
//      GET  /ble/events  SSE stream of PAYMENT_ACKs the phone wrote over Bluetooth + status
//      POST /ble/token   current payment token → readable by the phone over Bluetooth
//      GET  /ble/status  JSON status
// Everything stays on this machine; there is no internet dependency.

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'out');
const HELPER = join(ROOT, 'ble-bridge', '.build', 'rushpay-peripheral');
const PORT = Number(process.env.PORT ?? 3000);
const NO_BLE = process.argv.includes('--no-ble');

const status = { ble: NO_BLE ? 'disabled' : 'starting', advertising: false, phoneConnected: false, lastAckAt: null };
const sseClients = new Set();

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

function log(...args) {
  console.log(new Date().toLocaleTimeString(), ...args);
}

// ---------------------------------------------------------------------------
// BLE helper process
// ---------------------------------------------------------------------------

let helper = null;

function startHelper() {
  if (!existsSync(HELPER)) {
    status.ble = 'not built';
    log('BLE helper not built. Run: npm run ble:build');
    return;
  }
  helper = spawn(HELPER, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  helper.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onHelperEvent(line);
    }
  });
  helper.on('exit', (code) => {
    status.ble = `exited (${code})`;
    status.advertising = false;
    status.phoneConnected = false;
    broadcast('status', status);
    log(`BLE helper exited with code ${code}; restarting in 2s`);
    setTimeout(startHelper, 2000);
  });
}

function onHelperEvent(line) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return log('helper:', line);
  }
  switch (ev.event) {
    case 'state':
      status.ble = ev.state;
      if (ev.state === 'unauthorized') log('Bluetooth permission denied: System Settings → Privacy & Security → Bluetooth → allow your terminal app');
      if (ev.state === 'poweredOff') log('Bluetooth is off. Turn it on (Control Centre).');
      break;
    case 'advertising':
      status.advertising = true;
      log(`BLE advertising as "${ev.name}"`);
      break;
    case 'subscribed':
      status.phoneConnected = true;
      log(`Phone connected over BLE (MTU ${ev.mtu})`);
      break;
    case 'unsubscribed':
      status.phoneConnected = ev.count > 0;
      log('Phone disconnected from BLE');
      break;
    case 'ack': {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return log('Ignoring malformed BLE write:', ev.data);
      }
      status.lastAckAt = Date.now();
      log(`BLE receipt: ${msg.orderId} ₹${msg.amount} ok=${msg.ok}${msg.reason ? ` (${msg.reason})` : ''}`);
      broadcast('ack', msg);
      break;
    }
    case 'error':
      log('BLE error:', ev.message);
      break;
  }
  broadcast('status', status);
}

function sendToHelper(obj) {
  if (helper?.stdin.writable) helper.stdin.write(JSON.stringify(obj) + '\n');
}

// ---------------------------------------------------------------------------
// HTTP: static app + BLE relay endpoints
// ---------------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain', '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  let file = normalize(join(OUT, decodeURIComponent(pathname)));
  if (!file.startsWith(OUT)) return res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file) && existsSync(file + '.html')) file += '.html';
  if (!existsSync(file)) {
    res.writeHead(404, { 'Content-Type': TYPES['.html'] });
    return createReadStream(join(OUT, '404.html')).on('error', () => res.end('Not found')).pipe(res);
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': pathname.startsWith('/_next/static/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((ok, fail) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 16_384) req.destroy();
    });
    req.on('end', () => ok(body));
    req.on('error', fail);
  });
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');

  if (pathname === '/ble/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (pathname === '/ble/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(status));
  }

  if (pathname === '/ble/token' && req.method === 'POST') {
    try {
      const { token } = JSON.parse(await readBody(req));
      if (typeof token !== 'string' || !token.startsWith('rp1.') || token.length > 4000) throw new Error('bad token');
      sendToHelper({ cmd: 'token', token });
      res.writeHead(204).end();
    } catch {
      res.writeHead(400).end();
    }
    return;
  }

  // Lets you test the laptop side without a phone: curl -X POST localhost:3000/ble/debug-ack -d '{...}'
  if (pathname === '/ble/debug-ack' && req.method === 'POST') {
    sendToHelper({ cmd: 'debugAck', data: await readBody(req) });
    return res.writeHead(204).end();
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
  serveStatic(req, res, pathname);
});

// Keep SSE connections alive through idle periods.
setInterval(() => {
  for (const res of sseClients) res.write(': keep-alive\n\n');
}, 15_000);

if (!existsSync(join(OUT, 'index.html'))) {
  console.error('No build found in ./out. Run: npm run build  (or use npm run demo)');
  process.exit(1);
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.entries(networkInterfaces())
    .filter(([name]) => !/^(utun|bridge|vmnet|awdl|llw|lo)/.test(name))
    .flatMap(([, addrs]) => addrs ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);

  console.log(`\n  RushPay demo server`);
  console.log(`  Student (this laptop):  http://localhost:${PORT}/?role=student`);
  if (ips.length) {
    for (const ip of ips) console.log(`  Vendor (Android phone): http://${ip}:${PORT}/?role=vendor`);
    console.log(`\n  On the phone, open chrome://flags/#unsafely-treat-insecure-origin-as-secure,`);
    console.log(`  add http://${ips[0]}:${PORT}, Enable, Relaunch. Then open the vendor URL.`);
  } else {
    console.log('  (No Wi-Fi/LAN address: the phone must load the vendor page while Wi-Fi is on.)');
  }
  console.log('');
  if (!NO_BLE) startHelper();
});

process.on('SIGINT', () => {
  helper?.kill();
  process.exit(0);
});
