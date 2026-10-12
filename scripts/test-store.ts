// Run: npx tsx scripts/test-store.ts
import {
  appendLedger, commitNonce, debit, getBalance, getBufferedCount, getLedger, getShiftRevenue,
  getUsedNonces, memoryAdapter, nextOrderId, openChannel, resetDemo, seedDemo, setOfflineMode,
  setStorageAdapter, settleBatch, tamperLedgerForDemo, verifyLedgerChain,
} from '@/lib/store';
import { SEED_ORDERS } from '@/lib/mockData';
import { TXN_CAP, type ChannelMessage, type LedgerRow } from '@/lib/types';

let failures = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}\n      ${(e as Error).message}`);
  }
}

function eq<T>(actual: T, expected: T, what: string) {
  if (actual !== expected) throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`);
}

async function fresh() {
  setStorageAdapter(memoryAdapter());
  await resetDemo();
}

const entry = (over: Partial<Parameters<typeof appendLedger>[0]> = {}) => ({
  orderId: '#104', amount: 80, timestamp: Date.now(), nonce: 'live-nonce-1',
  voucherSerial: 'v-live', voucherLimit: 320, token: 'rp1.fake.token', ...over,
});

const otherRow = (over: Partial<LedgerRow>): LedgerRow => ({
  index: 0, orderId: '#T2-001', amount: 80, timestamp: Date.now() + 1000, nonce: 'x',
  voucherSerial: 'v-live', voucherLimit: 320, tokenHash: 'h', prevHash: 'GENESIS', rowHash: 'r',
  status: 'BUFFERED', ...over,
});

await test('0 seed data: 14 orders, ₹1,840 total, each ≤ ₹500, ids #090–#103', () => {
  eq(SEED_ORDERS.length, 14, 'seed order count');
  eq(SEED_ORDERS.reduce((s, o) => s + o.amount, 0), 1840, 'seed total');
  if (SEED_ORDERS.some((o) => o.amount > TXN_CAP)) throw new Error('a seed order exceeds the cap');
  eq(SEED_ORDERS[0].orderId, '#090', 'first id');
  eq(SEED_ORDERS[13].orderId, '#103', 'last id');
});

await test('1 seedDemo → 14 rows, revenue 1840, buffered 14, balance 320', async () => {
  await fresh();
  eq(getLedger().length, 14, 'rows');
  eq(getShiftRevenue(), 1840, 'revenue');
  eq(getBufferedCount(), 14, 'buffered');
  eq(getBalance(), 320, 'balance');
  await seedDemo(); // second call must be a no-op
  eq(getLedger().length, 14, 'rows after re-seed');
  eq((await verifyLedgerChain()).ok, true, 'seed chain valid');
  eq(nextOrderId(), '#104', 'first live order id');
});

await test('2 appendLedger → revenue 1920, chain verifies', async () => {
  await fresh();
  const row = await appendLedger(entry());
  eq(row.index, 14, 'new row index');
  eq(row.prevHash, getLedger()[13].rowHash, 'prevHash links to previous row');
  eq(getShiftRevenue(), 1920, 'revenue');
  eq((await verifyLedgerChain()).ok, true, 'chain valid');
});

await test('2b concurrent appends do not fork the chain', async () => {
  await fresh();
  await Promise.all([1, 2, 3].map((i) => appendLedger(entry({ orderId: `#10${i + 3}`, nonce: `n${i}` }))));
  eq(getLedger().length, 17, 'rows');
  eq((await verifyLedgerChain()).ok, true, 'chain valid');
});

await test('3 tamperLedgerForDemo(3, 1) → chain broken at 3', async () => {
  await fresh();
  tamperLedgerForDemo(3, 1);
  const r = await verifyLedgerChain();
  eq(r.ok, false, 'ok');
  eq(r.brokenAt, 3, 'brokenAt');
});

await test('4 commitNonce persists to the used-nonce cache', async () => {
  await fresh();
  commitNonce('abc');
  eq(getUsedNonces().has('abc'), true, 'has abc');
});

await test('5 debit is idempotent per orderId (320 → 240, not 160)', async () => {
  await fresh();
  eq(debit('#104', 80), true, 'first debit');
  eq(debit('#104', 80), true, 'duplicate ACK');
  eq(getBalance(), 240, 'balance');
});

await test('6 debit beyond balance → false, balance unchanged', async () => {
  await fresh();
  eq(debit('#105', 321), false, 'over-balance debit');
  eq(getBalance(), 320, 'balance');
});

await test('7 settleBatch: other terminal reuses a nonce → DOUBLE_SPEND', async () => {
  await fresh();
  await appendLedger(entry({ nonce: 'dup' }));
  const r = await settleBatch([otherRow({ nonce: 'dup', voucherSerial: 'v-other' })]);
  eq(r.doubleSpends.length, 1, 'double spends');
  eq(r.doubleSpends[0].orderId, '#T2-001', 'flagged row is the later one');
  eq(r.cleared, 15, 'this terminal cleared');
  eq(r.payout, 1920, 'payout');
  eq(getBufferedCount(), 0, 'nothing left buffered');
  eq((await verifyLedgerChain()).ok, true, 'chain still valid after status change');
});

await test('8 settleBatch: two terminals overspend one voucher → later row DOUBLE_SPEND', async () => {
  await fresh();
  await appendLedger(entry({ amount: 200, nonce: 'a' }));            // ₹200 of ₹320 here…
  const r = await settleBatch([otherRow({ amount: 200, nonce: 'b' })]); // …₹200 more at another stall
  eq(r.doubleSpends.length, 1, 'double spends');
  eq(r.doubleSpends[0].nonce, 'b', 'flagged row');
  eq(getLedger()[14].status, 'CLEARED', 'earlier payment still clears');
});

await test('9 setOfflineMode blocks fetch / XHR / WebSocket and restores them', async () => {
  await fresh();
  const realFetch = async () => new Response('ok');
  class FakeXHR { open() {} }
  class FakeWS {}
  const fakeWindow = { fetch: realFetch, XMLHttpRequest: FakeXHR, WebSocket: FakeWS };
  (globalThis as unknown as Record<string, unknown>).window = fakeWindow;
  try {
    setOfflineMode(true);
    let fetchBlocked = false;
    await fakeWindow.fetch().catch(() => (fetchBlocked = true));
    eq(fetchBlocked, true, 'fetch blocked');
    let xhrBlocked = false;
    try { new fakeWindow.XMLHttpRequest().open(); } catch { xhrBlocked = true; }
    eq(xhrBlocked, true, 'XHR blocked');
    let wsBlocked = false;
    try { new (fakeWindow.WebSocket as unknown as new () => unknown)(); } catch { wsBlocked = true; }
    eq(wsBlocked, true, 'WebSocket blocked');
    setOfflineMode(false);
    eq(fakeWindow.fetch, realFetch, 'fetch restored');
    eq(fakeWindow.WebSocket, FakeWS, 'WebSocket restored');
    new fakeWindow.XMLHttpRequest().open(); // must not throw
  } finally {
    delete (globalThis as unknown as Record<string, unknown>).window;
  }
});

await test('10 BroadcastChannel: message from A reaches B, not A', async () => {
  const a = openChannel();
  const b = openChannel();
  let selfDelivered = false;
  a.onMessage(() => (selfDelivered = true));
  try {
    const got = await new Promise<ChannelMessage>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out after 1s')), 1000);
      b.onMessage((m) => { clearTimeout(t); resolve(m); });
      a.send({ type: 'PAYMENT_TOKEN', token: 'rp1.x.y.z', sentAt: Date.now() });
    });
    eq(got.type, 'PAYMENT_TOKEN', 'message type');
    eq(selfDelivered, false, 'sender does not receive its own message');
  } finally {
    a.close();
    b.close();
  }
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
