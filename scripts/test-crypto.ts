// Run: npx tsx scripts/test-crypto.ts
import {
  createPaymentToken, createStudentWallet, decodeToken, makeExpiredToken, tamperAmount, verifyToken,
} from '@/lib/crypto';
import type { VerifyResult } from '@/lib/types';

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

function failedOn(r: VerifyResult, reason: string, check: string) {
  eq(r.ok, false, 'ok');
  eq(r.reason, reason, 'reason');
  eq(r.checks.length, 6, 'check count');
  eq(r.checks.find((c) => c.name === check)?.ok, false, `${check} check`);
}

const b64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8');
const toB64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const none = new Set<string>();

const REG_NO = '21BCE1234';
const walletA = await createStudentWallet(REG_NO, 320);
const walletB = await createStudentWallet('22BIT5678', 320);
const tokenA = await createPaymentToken(walletA, { orderId: '#104', amount: 80, items: 'paneer-roll*1' });

await test('1 valid token → ok, all 6 checks pass, < 300ms', async () => {
  const r = await verifyToken(tokenA, { usedNonces: none });
  eq(r.ok, true, 'ok');
  eq(r.checks.length, 6, 'check count');
  const bad = r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
  if (bad.length) throw new Error(bad.join('; '));
  eq(r.payload?.amount, 80, 'amount');
  eq(r.voucherLimit, 320, 'voucher limit');
  if (r.elapsedMs >= 300) throw new Error(`took ${r.elapsedMs.toFixed(1)}ms`);
  console.log(`      verified in ${r.elapsedMs.toFixed(2)}ms`);
});

await test('2 nonce already used → REPLAY', async () => {
  const nonce = decodeToken(tokenA)!.payload.nonce;
  failedOn(await verifyToken(tokenA, { usedNonces: new Set([nonce]) }), 'REPLAY', 'NONCE');
});

await test('3 tamperAmount(token, 8) → SIGNATURE_MISMATCH', async () => {
  const forged = tamperAmount(tokenA, 8);
  eq(decodeToken(forged)?.payload.amount, 8, 'forged amount');
  failedOn(await verifyToken(forged, { usedNonces: none }), 'SIGNATURE_MISMATCH', 'SIGNATURE');
});

await test('4 makeExpiredToken → EXPIRED', async () => {
  const old = await makeExpiredToken(walletA, { orderId: '#105', amount: 80 });
  failedOn(await verifyToken(old, { usedNonces: none }), 'EXPIRED', 'FRESHNESS');
});

await test("5 wallet B's signature with wallet A's voucher → rejected", async () => {
  const tokenB = await createPaymentToken(walletB, { orderId: '#106', amount: 80 });
  const parts = tokenB.split('.');
  parts[3] = tokenA.split('.')[3];
  const r = await verifyToken(parts.join('.'), { usedNonces: none });
  eq(r.ok, false, 'ok');
  eq(r.checks.find((c) => c.name === 'SIGNATURE')?.ok, false, 'SIGNATURE check');
});

await test("5b B forges A's studentHash, signs with own key → SIGNATURE fails", async () => {
  const parts = tokenA.split('.');
  const p = JSON.parse(b64(parts[1]));
  p.orderId = '#107';
  const fake = await createPaymentToken(walletB, { ...p });       // signed by B…
  const fp = fake.split('.');
  fp[1] = toB64(JSON.stringify({ ...JSON.parse(b64(fp[1])), studentHash: walletA.studentHash })); // …claiming to be A
  fp[3] = parts[3];
  const r = await verifyToken(fp.join('.'), { usedNonces: none });
  eq(r.ok, false, 'ok');
  eq(r.checks.find((c) => c.name === 'VOUCHER')?.ok, true, 'voucher itself is genuine');
  eq(r.reason, 'SIGNATURE_MISMATCH', 'reason');
});

await test('6 voucher with forged issuerSig → INVALID_VOUCHER', async () => {
  const parts = tokenA.split('.');
  const sv = JSON.parse(b64(parts[3]));
  sv.issuerSig = walletB.signedVoucher.issuerSig;
  parts[3] = toB64(JSON.stringify(sv));
  failedOn(await verifyToken(parts.join('.'), { usedNonces: none }), 'INVALID_VOUCHER', 'VOUCHER');
});

await test('6b voucher limit raised from ₹320 to ₹5000 → INVALID_VOUCHER', async () => {
  const parts = tokenA.split('.');
  const sv = JSON.parse(b64(parts[3]));
  sv.voucher.limit = 5000;
  parts[3] = toB64(JSON.stringify(sv));
  failedOn(await verifyToken(parts.join('.'), { usedNonces: none }), 'INVALID_VOUCHER', 'VOUCHER');
});

await test('7 amount ₹600 → AMOUNT_OUT_OF_BOUNDS', async () => {
  const rich = await createStudentWallet('23BCE0001', 2000);
  const t = await createPaymentToken(rich, { orderId: '#108', amount: 600 });
  failedOn(await verifyToken(t, { usedNonces: none }), 'AMOUNT_OUT_OF_BOUNDS', 'AMOUNT');
});

await test('7b amount above voucher limit (₹400 on ₹320) → AMOUNT_OUT_OF_BOUNDS', async () => {
  const t = await createPaymentToken(walletA, { orderId: '#109', amount: 400 });
  failedOn(await verifyToken(t, { usedNonces: none }), 'AMOUNT_OUT_OF_BOUNDS', 'AMOUNT');
});

await test('8 garbage input → MALFORMED_TOKEN, never throws', async () => {
  for (const junk of ['garbage', '', 'rp1.a.b.c', 'rp1.!!!.x.y', tokenA.replace('rp1', 'rp2'), null as unknown as string]) {
    const r = await verifyToken(junk, { usedNonces: none });
    eq(r.reason, 'MALFORMED_TOKEN', `reason for ${JSON.stringify(junk)}`);
    eq(r.checks.length, 6, 'check count');
  }
});

await test('9 token fits comfortably in a QR code (< 1200 chars)', () => {
  console.log(`      token length: ${tokenA.length} chars`);
  if (tokenA.length >= 1200) throw new Error(`token is ${tokenA.length} chars`);
});

await test('10 registration number never appears in the token', () => {
  const decoded = tokenA.split('.').map((p) => { try { return b64(p); } catch { return p; } }).join(' ');
  if (decoded.includes(REG_NO) || tokenA.includes(REG_NO)) throw new Error('regNo leaked into token');
});

await test('11 refreshed QR (same nonce, new timestamp) verifies; replay of it is blocked', async () => {
  const nonce = decodeToken(tokenA)!.payload.nonce;
  const refreshed = await createPaymentToken(walletA, { orderId: '#104', amount: 80, nonce });
  eq((await verifyToken(refreshed, { usedNonces: none })).ok, true, 'refreshed ok');
  failedOn(await verifyToken(refreshed, { usedNonces: new Set([nonce]) }), 'REPLAY', 'NONCE');
});

await test('12 extra payload field (PII smuggling) → fails PII check', async () => {
  const parts = tokenA.split('.');
  parts[1] = toB64(JSON.stringify({ ...JSON.parse(b64(parts[1])), phone: '9876543210' }));
  const r = await verifyToken(parts.join('.'), { usedNonces: none });
  eq(r.ok, false, 'ok');
  eq(r.checks.find((c) => c.name === 'PII')?.ok, false, 'PII check');
});

await test('13 PII check has no false positives across 2000 random nonces', async () => {
  for (let i = 0; i < 2000; i++) {
    const t = await createPaymentToken(walletA, { orderId: '#110', amount: 40 });
    const r = await verifyToken(t, { usedNonces: none });
    if (!r.ok) throw new Error(`run ${i}: ${r.reason} ${r.checks.find((c) => !c.ok)?.detail}`);
  }
});

await test('14 order items are signed: changing them breaks the signature', async () => {
  eq(decodeToken(tokenA)?.payload.items, 'paneer-roll*1', 'items carried in token');
  const parts = tokenA.split('.');
  parts[1] = toB64(JSON.stringify({ ...JSON.parse(b64(parts[1])), items: 'paneer-roll*3' }));
  failedOn(await verifyToken(parts.join('.'), { usedNonces: none }), 'SIGNATURE_MISMATCH', 'SIGNATURE');
});

await test('15 items field cannot carry personal data', async () => {
  for (const items of ['9876543210*1', 'student@okaxis*1', '21BCE1234', 'paneer roll*1']) {
    const t = await createPaymentToken(walletA, { orderId: '#111', amount: 80, items });
    const r = await verifyToken(t, { usedNonces: none });
    eq(r.ok, false, `ok for ${items}`);
    eq(r.checks.find((c) => c.name === 'PII')?.ok, false, `PII check for ${items}`);
  }
});

await test('16 multi-item order verifies; empty items allowed', async () => {
  const t = await createPaymentToken(walletA, { orderId: '#112', amount: 190, items: 'paneer-roll*1,corn-sandwich*1,lime-juice*1' });
  eq((await verifyToken(t, { usedNonces: none })).ok, true, 'multi-item ok');
  const e = await createPaymentToken(walletA, { orderId: '#113', amount: 40 });
  eq((await verifyToken(e, { usedNonces: none })).ok, true, 'empty items ok');
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
