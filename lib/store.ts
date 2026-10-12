/**
 * RushPay state, proximity messaging and settlement (Member A2).
 *
 * VENDOR FLOW (VendorView.tsx):
 *   const ch = openChannel();
 *   ch.onMessage(async (m) => {
 *     if (m.type !== 'PAYMENT_TOKEN') return;
 *     const r = await verifyToken(m.token, { usedNonces: getUsedNonces() });   // lib/crypto.ts
 *     if (r.ok && r.payload) {
 *       commitNonce(r.payload.nonce);
 *       await appendLedger({ ...r.payload, voucherSerial: r.voucherSerial!, voucherLimit: r.voucherLimit!, token: m.token });
 *       playChime();
 *     } else playAlarm();
 *     ch.send({ type: 'PAYMENT_ACK', orderId: r.payload?.orderId ?? '', nonce: r.payload?.nonce ?? '',
 *               amount: r.payload?.amount ?? 0, ok: r.ok, reason: r.reason });
 *   });
 *
 * STUDENT FLOW (StudentView.tsx):
 *   ch.onMessage((m) => { if (m.type === 'PAYMENT_ACK' && m.ok && m.orderId === myOrderId) debit(m.orderId, m.amount); });
 *
 * REACT: const balance = useRushStore((s) => s.balance);
 *   Selectors must return primitives or references already in the state (e.g. s.ledger), never new objects.
 *
 * Call seedDemo() once on mount in page.tsx.
 */
import { useSyncExternalStore } from 'react';
import type { ChannelMessage, LedgerRow, WalletSecrets } from '@/lib/types';
import { DEFAULT_BALANCE, FIRST_LIVE_ORDER, SEED_ORDERS, SEED_VOUCHER_LIMIT } from '@/lib/mockData';

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface StorageAdapter {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  keys(): string[];
}

export function memoryAdapter(): StorageAdapter {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => void m.set(k, v),
    remove: (k) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}

function localStorageAdapter(): StorageAdapter | null {
  try {
    const ls = window.localStorage;
    const probe = 'rushpay:__probe';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return {
      get: (k) => ls.getItem(k),
      set: (k, v) => ls.setItem(k, v),
      remove: (k) => ls.removeItem(k),
      keys: () => Array.from({ length: ls.length }, (_, i) => ls.key(i)).filter((k): k is string => k !== null),
    };
  } catch {
    return null; // private mode / blocked storage: fall back to memory so the demo still runs
  }
}

const PREFIX = 'rushpay:';
const K = {
  wallet: PREFIX + 'wallet',
  balance: PREFIX + 'balance',
  debited: PREFIX + 'debitedOrders',
  nonces: PREFIX + 'usedNonces',
  ledger: PREFIX + 'ledger',
  offline: PREFIX + 'offline',
  orderCounter: PREFIX + 'orderCounter',
  seeded: PREFIX + 'seeded',
} as const;

let adapter: StorageAdapter | null = null;

function storage(): StorageAdapter {
  if (!adapter) adapter = (typeof window !== 'undefined' && localStorageAdapter()) || memoryAdapter();
  return adapter;
}

/** Tests inject memoryAdapter(); the app never needs to call this. */
export function setStorageAdapter(a: StorageAdapter): void {
  adapter = a;
  notify();
}

function readJSON<T>(key: string, fallback: T): T {
  const raw = storage().get(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown): void {
  storage().set(key, JSON.stringify(value));
  notify();
}

// ---------------------------------------------------------------------------
// Pub/sub + React hook
// ---------------------------------------------------------------------------

export type RushState = {
  balance: number;
  ledger: LedgerRow[];
  revenue: number;
  buffered: number;
  usedNonceCount: number;
  offline: boolean;
  hasWallet: boolean;
};

const SERVER_STATE: RushState = {
  balance: DEFAULT_BALANCE, ledger: [], revenue: 0, buffered: 0, usedNonceCount: 0, offline: false, hasWallet: false,
};

const listeners = new Set<() => void>();
let version = 0;
let snapshot: RushState | null = null;
let snapshotVersion = -1;

function notify(): void {
  version++;
  listeners.forEach((l) => l());
}

export function getState(): RushState {
  if (!snapshot || snapshotVersion !== version) {
    const ledger = getLedger();
    snapshot = {
      balance: getBalance(),
      ledger,
      revenue: ledger.reduce((s, r) => s + r.amount, 0),
      buffered: ledger.filter((r) => r.status === 'BUFFERED').length,
      usedNonceCount: readJSON<string[]>(K.nonces, []).length,
      offline: isOfflineMode(),
      hasWallet: storage().get(K.wallet) !== null,
    };
    snapshotVersion = version;
  }
  return snapshot;
}

let windowListenersInstalled = false;

function ensureWindowListeners(): void {
  if (windowListenersInstalled || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  windowListenersInstalled = true;
  // Keep two tabs (?role=student / ?role=vendor) in sync.
  window.addEventListener('storage', (e) => {
    if (!e.key || !e.key.startsWith(PREFIX)) return;
    if (e.key === K.offline) applyNetworkGuard(isOfflineMode());
    notify();
  });
  applyNetworkGuard(isOfflineMode());
}

export function subscribe(cb: () => void): () => void {
  ensureWindowListeners();
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

export function useRushStore<T>(selector: (s: RushState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(getState()), () => selector(SERVER_STATE));
}

// ---------------------------------------------------------------------------
// Proximity channel (BroadcastChannel stands in for BLE)
// ---------------------------------------------------------------------------

const CHANNEL_NAME = 'rushpay-ble';

function isChannelMessage(x: unknown): x is ChannelMessage {
  if (!x || typeof x !== 'object') return false;
  const m = x as Record<string, unknown>;
  if (m.type === 'PAYMENT_TOKEN') return typeof m.token === 'string' && typeof m.sentAt === 'number';
  if (m.type === 'PAYMENT_ACK') return typeof m.orderId === 'string' && typeof m.ok === 'boolean';
  return false;
}

/**
 * Works with no network: BroadcastChannel is a same-origin, in-browser message bus.
 * It never delivers to the instance that sent the message, so StudentView and VendorView
 * must each call openChannel() themselves, even when they're on the same page.
 */
export function openChannel(): {
  send(msg: ChannelMessage): void;
  onMessage(cb: (m: ChannelMessage) => void): () => void;
  close(): void;
} {
  const cbs = new Set<(m: ChannelMessage) => void>();
  if (typeof BroadcastChannel === 'undefined') {
    return { send: () => {}, onMessage: () => () => {}, close: () => {} };
  }
  const ch = new BroadcastChannel(CHANNEL_NAME);
  ch.onmessage = (e: MessageEvent) => {
    if (isChannelMessage(e.data)) cbs.forEach((cb) => cb(e.data));
  };
  return {
    send: (msg) => ch.postMessage(msg),
    onMessage: (cb) => {
      cbs.add(cb);
      return () => void cbs.delete(cb);
    },
    close: () => {
      cbs.clear();
      ch.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Offline mode: blocks every network API so judges can see payments need zero connectivity
// ---------------------------------------------------------------------------

const OFFLINE_MSG = 'RushPay offline mode: network disabled';

type NetGlobals = {
  fetch?: typeof fetch;
  XMLHttpRequest?: { prototype: { open: (...a: unknown[]) => void } };
  WebSocket?: unknown;
};
let originals: { fetch?: unknown; xhrOpen?: unknown; WebSocket?: unknown } | null = null;

function applyNetworkGuard(on: boolean): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as NetGlobals;
  if (on && !originals) {
    originals = { fetch: w.fetch, xhrOpen: w.XMLHttpRequest?.prototype.open, WebSocket: w.WebSocket };
    w.fetch = () => Promise.reject(new Error(OFFLINE_MSG));
    if (w.XMLHttpRequest) w.XMLHttpRequest.prototype.open = () => { throw new Error(OFFLINE_MSG); };
    if (w.WebSocket) w.WebSocket = function BlockedWebSocket() { throw new Error(OFFLINE_MSG); };
  } else if (!on && originals) {
    w.fetch = originals.fetch as typeof fetch;
    if (w.XMLHttpRequest && originals.xhrOpen) w.XMLHttpRequest.prototype.open = originals.xhrOpen as () => void;
    if (originals.WebSocket) w.WebSocket = originals.WebSocket;
    originals = null;
  }
}

/** Note: in `next dev` this also blocks hot reload's WebSocket. Use a production build for the demo. */
export function setOfflineMode(on: boolean): void {
  applyNetworkGuard(on);
  writeJSON(K.offline, on);
}

export function isOfflineMode(): boolean {
  return readJSON<boolean>(K.offline, false);
}

// ---------------------------------------------------------------------------
// Student wallet
// ---------------------------------------------------------------------------

// DEMO: the device key is kept in localStorage. In production it would be a non-extractable key
// in Android Keystore / Secure Enclave (ISO/IEC 27001 key custody).
export function loadWallet(): WalletSecrets | null {
  return readJSON<WalletSecrets | null>(K.wallet, null);
}

export function saveWallet(w: WalletSecrets): void {
  writeJSON(K.wallet, w);
}

export function getBalance(): number {
  return readJSON<number>(K.balance, DEFAULT_BALANCE);
}

/** Phase 1 (online): pre-load escrow balance. */
export function topUp(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) return;
  writeJSON(K.balance, getBalance() + amount);
}

/** Idempotent per orderId, so a duplicate ACK never double-debits. */
export function debit(orderId: string, amount: number): boolean {
  const done = readJSON<string[]>(K.debited, []);
  if (done.includes(orderId)) return true;
  const balance = getBalance();
  if (!Number.isFinite(amount) || amount <= 0 || amount > balance) return false;
  storage().set(K.debited, JSON.stringify([...done, orderId]));
  writeJSON(K.balance, balance - amount);
  return true;
}

export function nextOrderId(): string {
  const n = readJSON<number>(K.orderCounter, FIRST_LIVE_ORDER);
  writeJSON(K.orderCounter, n + 1);
  return '#' + String(n).padStart(3, '0');
}

// ---------------------------------------------------------------------------
// Vendor nonce cache (IS 19671 anti-replay: each token nonce is accepted once)
// ---------------------------------------------------------------------------

export function getUsedNonces(): ReadonlySet<string> {
  return new Set(readJSON<string[]>(K.nonces, []));
}

export function commitNonce(nonce: string): void {
  const list = readJSON<string[]>(K.nonces, []);
  if (!list.includes(nonce)) writeJSON(K.nonces, [...list, nonce]);
}

// ---------------------------------------------------------------------------
// Tamper-evident ledger (ISO/IEC 27001 audit log): each row's hash covers the previous row's hash
// ---------------------------------------------------------------------------

async function sha256Hex(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes: number): string {
  const a = globalThis.crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Status is deliberately excluded so settlement can update it without breaking the chain.
function hashInput(r: Omit<LedgerRow, 'rowHash' | 'status'>): string {
  return r.prevHash + JSON.stringify([
    r.index, r.orderId, r.amount, r.timestamp, r.nonce, r.voucherSerial, r.voucherLimit, r.tokenHash,
  ]);
}

export function getLedger(): LedgerRow[] {
  return readJSON<LedgerRow[]>(K.ledger, []);
}

export type LedgerEntry = {
  orderId: string; amount: number; timestamp: number; nonce: string;
  voucherSerial: string; voucherLimit: number; token: string;
};

let ledgerQueue: Promise<unknown> = Promise.resolve();

/** Append-only. Appends are serialised so concurrent calls can't fork the hash chain. */
export function appendLedger(e: LedgerEntry): Promise<LedgerRow> {
  const run = async () => {
    const ledger = getLedger();
    const prev = ledger[ledger.length - 1];
    const base = {
      index: ledger.length,
      orderId: e.orderId,
      amount: e.amount,
      timestamp: e.timestamp,
      nonce: e.nonce,
      voucherSerial: e.voucherSerial,
      voucherLimit: e.voucherLimit,
      tokenHash: await sha256Hex(e.token),
      prevHash: prev ? prev.rowHash : 'GENESIS',
    };
    const row: LedgerRow = { ...base, rowHash: await sha256Hex(hashInput(base)), status: 'BUFFERED' };
    writeJSON(K.ledger, [...ledger, row]);
    return row;
  };
  const p = ledgerQueue.then(run, run);
  ledgerQueue = p.catch(() => {});
  return p;
}

export async function verifyLedgerChain(): Promise<{ ok: boolean; brokenAt?: number }> {
  const ledger = getLedger();
  let prevHash = 'GENESIS';
  for (let i = 0; i < ledger.length; i++) {
    const r = ledger[i];
    if (r.index !== i || r.prevHash !== prevHash || r.rowHash !== (await sha256Hex(hashInput(r)))) {
      return { ok: false, brokenAt: i };
    }
    prevHash = r.rowHash;
  }
  return { ok: true };
}

export function getShiftRevenue(): number {
  return getLedger().reduce((s, r) => s + r.amount, 0);
}

export function getBufferedCount(): number {
  return getLedger().filter((r) => r.status === 'BUFFERED').length;
}

/**
 * Phase 3: simulates the escrow server clearing batches from every stall terminal.
 * A row is DOUBLE_SPEND if its nonce was already cleared, or if it would push its voucher's
 * total spend over the voucher limit. Rows are judged in timestamp order, so the earliest payment wins.
 * Returns figures for THIS terminal (cleared, payout) and every double-spend found across all terminals.
 */
export async function settleBatch(
  otherTerminalRows: LedgerRow[] = [],
): Promise<{ cleared: number; doubleSpends: LedgerRow[]; payout: number }> {
  await ledgerQueue;
  const mine = getLedger();
  const all = [
    ...mine.map((row) => ({ row, mine: true })),
    ...otherTerminalRows.map((row) => ({ row: { ...row }, mine: false })),
  ].sort((a, b) => a.row.timestamp - b.row.timestamp || a.row.index - b.row.index);

  const seenNonces = new Set<string>();
  const spent = new Map<string, number>();
  const doubleSpends: LedgerRow[] = [];

  for (const { row } of all) {
    const total = (spent.get(row.voucherSerial) ?? 0) + row.amount;
    if (seenNonces.has(row.nonce) || total > row.voucherLimit) {
      row.status = 'DOUBLE_SPEND';
      doubleSpends.push(row);
    } else {
      row.status = 'CLEARED';
      spent.set(row.voucherSerial, total);
    }
    seenNonces.add(row.nonce);
  }

  writeJSON(K.ledger, mine);
  const cleared = mine.filter((r) => r.status === 'CLEARED');
  return { cleared: cleared.length, doubleSpends, payout: cleared.reduce((s, r) => s + r.amount, 0) };
}

/** DEMO ONLY: silently edits a stored row so verifyLedgerChain() can show it catching the change. */
export function tamperLedgerForDemo(index: number, newAmount: number): void {
  const ledger = getLedger();
  if (!ledger[index]) return;
  ledger[index] = { ...ledger[index], amount: newAmount };
  writeJSON(K.ledger, ledger);
}

// ---------------------------------------------------------------------------
// Demo control
// ---------------------------------------------------------------------------

let seeding: Promise<void> | null = null;

/** Safe to call on every mount: seeds only once (balance ₹320, 14 buffered orders = ₹1,840). */
export function seedDemo(): Promise<void> {
  if (storage().get(K.seeded)) return Promise.resolve();
  if (!seeding) {
    seeding = (async () => {
      storage().set(K.balance, JSON.stringify(DEFAULT_BALANCE));
      const now = Date.now();
      for (const o of SEED_ORDERS) {
        const nonce = randomHex(16);
        await appendLedger({
          orderId: o.orderId,
          amount: o.amount,
          timestamp: now - o.minutesAgo * 60_000,
          nonce,
          voucherSerial: 'seed-' + randomHex(6),
          voucherLimit: SEED_VOUCHER_LIMIT,
          token: 'seed:' + o.orderId + ':' + nonce,
        });
        commitNonce(nonce);
      }
      writeJSON(K.seeded, true);
    })().finally(() => {
      seeding = null;
    });
  }
  return seeding;
}

export async function resetDemo(): Promise<void> {
  await ledgerQueue;
  applyNetworkGuard(false);
  const s = storage();
  s.keys().filter((k) => k.startsWith(PREFIX)).forEach((k) => s.remove(k));
  notify();
  await seedDemo();
}
