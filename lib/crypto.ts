/**
 * RushPay cryptographic engine (Member A1). Web Crypto only (crypto.subtle), no network, no npm crypto.
 *
 * Two-level ECDSA P-256:
 *   1. Online pre-funding: the escrow issuer signs a Voucher binding the student's device public key
 *      to a spending limit.
 *   2. Offline payment: the device signs the PaymentPayload. The terminal checks both signatures, so it
 *      can verify payments but never forge one (unlike a shared-secret HMAC).
 *
 * STUDENT (StudentView.tsx):
 *   const wallet = loadWallet() ?? await createStudentWallet('21BCE1234', 320); saveWallet(wallet);
 *   const token = await createPaymentToken(wallet, { orderId: nextOrderId(), amount: 80, items: 'paneer-roll*1' });
 *   // every ~10s while the ring runs, refresh the QR with the SAME nonce:
 *   const fresh = await createPaymentToken(wallet, { orderId, amount, items, nonce: decodeToken(token)!.payload.nonce });
 *
 * VENDOR (VendorView.tsx):
 *   const r = await verifyToken(token, { usedNonces: getUsedNonces() });  // r.checks drives the console
 *   if (r.ok) commitNonce(r.payload!.nonce);                               // verifyToken never commits
 *
 * ATTACK PANEL: tamperAmount(token, 8), makeExpiredToken(wallet, {...}), or re-send an accepted token.
 */
import { ISSUER_PRIVATE_JWK, ISSUER_PUBLIC_JWK } from '@/lib/issuerKeys';
import {
  TTL_MS, TXN_CAP,
  type Check, type CheckName, type PaymentPayload, type PaymentToken, type SignedVoucher,
  type VerifyResult, type Voucher, type WalletSecrets,
} from '@/lib/types';

const ECDSA_KEY = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ECDSA_SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;
const TOKEN_PREFIX = 'rp1';
const FUTURE_SKEW_MS = 5_000;
const VOUCHER_VALIDITY_MS = 24 * 60 * 60 * 1000;

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------------------
// Encoding helpers (browser + Node 20+)
// ---------------------------------------------------------------------------

function toB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomHex(bytes: number): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await subtle().digest('SHA-256', enc.encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Fixed key order so signer and verifier hash identical bytes.
function canonicalPayload(p: PaymentPayload): string {
  return JSON.stringify({
    orderId: p.orderId, amount: p.amount, items: p.items, timestamp: p.timestamp, nonce: p.nonce, studentHash: p.studentHash,
  });
}

function publicJwk(k: JsonWebKey): JsonWebKey {
  return { kty: k.kty, crv: k.crv, x: k.x, y: k.y };
}

function canonicalVoucher(v: Voucher): string {
  return JSON.stringify({
    serial: v.serial, studentHash: v.studentHash, devicePubKey: publicJwk(v.devicePubKey), limit: v.limit, expiresAt: v.expiresAt,
  });
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

let issuerPublicKey: Promise<CryptoKey> | null = null;
const getIssuerPublicKey = () =>
  (issuerPublicKey ??= subtle().importKey('jwk', ISSUER_PUBLIC_JWK, ECDSA_KEY, false, ['verify']));

const importPrivate = (jwk: JsonWebKey) => subtle().importKey('jwk', jwk, ECDSA_KEY, false, ['sign']);
const importPublic = (jwk: JsonWebKey) => subtle().importKey('jwk', publicJwk(jwk), ECDSA_KEY, false, ['verify']);

async function sign(key: CryptoKey, data: string): Promise<string> {
  return toB64url(new Uint8Array(await subtle().sign(ECDSA_SIGN, key, enc.encode(data))));
}

// ---------------------------------------------------------------------------
// Phase 1 (online): wallet + escrow-signed voucher
// ---------------------------------------------------------------------------

/**
 * Simulates pre-funding over campus Wi-Fi: creates the device keypair and has the "issuer" sign a voucher.
 * IS 17428: the registration number only feeds a salted hash; it never appears in a token.
 */
export async function createStudentWallet(regNo: string, limit: number): Promise<WalletSecrets> {
  const device = await subtle().generateKey(ECDSA_KEY, true, ['sign', 'verify']);
  const studentHash = (await sha256Hex(`rushpay:${regNo}:${randomHex(16)}`)).slice(0, 16);
  const voucher: Voucher = {
    serial: randomHex(6),
    studentHash,
    devicePubKey: publicJwk(await subtle().exportKey('jwk', device.publicKey)),
    limit,
    expiresAt: Date.now() + VOUCHER_VALIDITY_MS,
  };
  const issuerSig = await sign(await importPrivate(ISSUER_PRIVATE_JWK), canonicalVoucher(voucher));
  const priv = await subtle().exportKey('jwk', device.privateKey);
  return {
    regNoNeverTransmitted: regNo,
    studentHash,
    devicePrivKey: { kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y, d: priv.d },
    signedVoucher: { voucher, issuerSig },
  };
}

// ---------------------------------------------------------------------------
// Phase 2 (offline): token creation
// ---------------------------------------------------------------------------

function encodeToken(payloadJson: string, sig: string, sv: SignedVoucher): PaymentToken {
  return [TOKEN_PREFIX, toB64url(enc.encode(payloadJson)), sig, toB64url(enc.encode(JSON.stringify(sv)))].join('.');
}

/**
 * Signs a payment on-device. Reuse `nonce` with a new timestamp to refresh the dynamic QR.
 * `items` is the order in menu-id form ("paneer-roll*2,lime-juice*1"); it is signed, so the vendor sees
 * exactly what was paid for.
 */
export async function createPaymentToken(
  wallet: WalletSecrets,
  opts: { orderId: string; amount: number; items?: string; nonce?: string; timestamp?: number },
): Promise<PaymentToken> {
  const payloadJson = canonicalPayload({
    orderId: opts.orderId,
    amount: opts.amount,
    items: opts.items ?? '',
    timestamp: opts.timestamp ?? Date.now(),
    nonce: opts.nonce ?? randomHex(16),
    studentHash: wallet.studentHash,
  });
  const sig = await sign(await importPrivate(wallet.devicePrivKey), payloadJson);
  return encodeToken(payloadJson, sig, wallet.signedVoucher);
}

type Decoded = { payload: PaymentPayload; payloadBytes: Uint8Array<ArrayBuffer>; sig: Uint8Array<ArrayBuffer>; signedVoucher: SignedVoucher };

function isPayload(x: unknown): x is PaymentPayload {
  const p = x as PaymentPayload;
  return !!p && typeof p === 'object' && typeof p.orderId === 'string' && typeof p.amount === 'number'
    && typeof p.items === 'string' && typeof p.timestamp === 'number' && typeof p.nonce === 'string' && typeof p.studentHash === 'string';
}

function isSignedVoucher(x: unknown): x is SignedVoucher {
  const s = x as SignedVoucher;
  const v = s?.voucher;
  return !!v && typeof s.issuerSig === 'string' && typeof v.serial === 'string' && typeof v.studentHash === 'string'
    && typeof v.limit === 'number' && typeof v.expiresAt === 'number' && !!v.devicePubKey && typeof v.devicePubKey === 'object';
}

function decodeFull(token: PaymentToken): Decoded | null {
  try {
    if (typeof token !== 'string') return null;
    const parts = token.trim().split('.');
    if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) return null;
    const payloadBytes = fromB64url(parts[1]);
    const payload: unknown = JSON.parse(dec.decode(payloadBytes));
    const signedVoucher: unknown = JSON.parse(dec.decode(fromB64url(parts[3])));
    if (!isPayload(payload) || !isSignedVoucher(signedVoucher)) return null;
    return { payload, payloadBytes, sig: fromB64url(parts[2]), signedVoucher };
  } catch {
    return null;
  }
}

/** Unverified decode, for display only. Never trust the result without verifyToken(). */
export function decodeToken(token: PaymentToken): { payload: PaymentPayload; signedVoucher: SignedVoucher } | null {
  const d = decodeFull(token);
  return d && { payload: d.payload, signedVoucher: d.signedVoucher };
}

// ---------------------------------------------------------------------------
// Edge verification (vendor terminal, fully offline)
// ---------------------------------------------------------------------------

const LABELS: Record<CheckName, string> = {
  VOUCHER: 'Escrow Voucher (Issuer ECDSA)',
  SIGNATURE: 'ECDSA P-256 Signature',
  FRESHNESS: 'Token Freshness (Δt)',
  NONCE: 'Anti-Replay Nonce Cache',
  AMOUNT: `Amount Bounds (₹${TXN_CAP} cap)`,
  PII: 'IS 17428 PII Minimisation',
};

const REASONS: Record<CheckName, string> = {
  VOUCHER: 'INVALID_VOUCHER',
  SIGNATURE: 'SIGNATURE_MISMATCH',
  FRESHNESS: 'EXPIRED',
  NONCE: 'REPLAY',
  AMOUNT: 'AMOUNT_OUT_OF_BOUNDS',
  PII: 'PII_LEAK',
};

const ORDER: CheckName[] = ['VOUCHER', 'SIGNATURE', 'FRESHNESS', 'NONCE', 'AMOUNT', 'PII'];
const PAYLOAD_KEYS = ['orderId', 'amount', 'items', 'timestamp', 'nonce', 'studentHash'];
// Menu ids must start with a letter, so digits (phone numbers, reg numbers) can't be smuggled in as items.
const ITEMS_RE = /^(?:[a-z][a-z0-9-]{0,31}\*[1-9]\d?(?:,[a-z][a-z0-9-]{0,31}\*[1-9]\d?){0,19})?$/;
const PII_PATTERNS: [RegExp, string][] = [
  [/\b[6-9]\d{9}\b/, 'phone number'],
  [/@/, 'UPI VPA'],
  [/\d{2}[A-Z]{3}\d{4}/i, 'registration number'],
];

const check = (name: CheckName, ok: boolean, detail: string): Check => ({ name, label: LABELS[name], ok, detail });

async function verifySig(key: CryptoKey, sig: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<boolean> {
  try {
    return await subtle().verify(ECDSA_SIGN, key, sig, data);
  } catch {
    return false;
  }
}

/**
 * Runs all six checks (always returns six, in order, so the UI can animate them) and never throws.
 * Does NOT commit the nonce: the caller does that after a successful result.
 */
export async function verifyToken(
  token: PaymentToken,
  ctx: { usedNonces: ReadonlySet<string>; now?: number },
): Promise<VerifyResult> {
  const t0 = performance.now();
  const now = ctx.now ?? Date.now();
  const d = decodeFull(token);

  if (!d) {
    return {
      ok: false,
      reason: 'MALFORMED_TOKEN',
      checks: ORDER.map((n) => check(n, false, 'Not evaluated: malformed token')),
      elapsedMs: performance.now() - t0,
    };
  }

  const { payload, payloadBytes, sig, signedVoucher } = d;
  const v = signedVoucher.voucher;

  // 1. Voucher: issued by the campus escrow, unexpired, and belongs to this payer.
  let issuerOk = false;
  try {
    issuerOk = await verifySig(await getIssuerPublicKey(), fromB64url(signedVoucher.issuerSig), enc.encode(canonicalVoucher(v)));
  } catch { /* bad base64 in issuerSig */ }
  const voucherCheck = !issuerOk
    ? check('VOUCHER', false, 'Issuer signature invalid: voucher not issued by campus escrow')
    : v.expiresAt <= now
      ? check('VOUCHER', false, 'Voucher expired: re-sync wallet online')
      : v.studentHash !== payload.studentHash
        ? check('VOUCHER', false, 'Voucher belongs to a different payer')
        : check('VOUCHER', true, `Valid (serial …${v.serial.slice(-4)}, limit ₹${v.limit})`);

  // 2. Device signature (IS 19671 anti-tampering): any edit to the payload breaks it.
  let deviceOk = false;
  try {
    deviceOk = await verifySig(await importPublic(v.devicePubKey), sig, payloadBytes);
  } catch { /* malformed device key */ }
  const sigCheck = deviceOk
    ? check('SIGNATURE', true, 'MATCH / VERIFIED')
    : check('SIGNATURE', false, 'MISMATCH: payload altered or signed by another device');

  // 3. Freshness (IS 19671: 60-second TTL).
  const ageMs = now - payload.timestamp;
  const freshCheck = ageMs < -FUTURE_SKEW_MS
    ? check('FRESHNESS', false, `Timestamp ${(-ageMs / 1000).toFixed(1)}s in the future`)
    : ageMs > TTL_MS
      ? check('FRESHNESS', false, `EXPIRED: generated ${(ageMs / 1000).toFixed(1)}s ago (TTL ${TTL_MS / 1000}s)`)
      : check('FRESHNESS', true, `Generated ${(Math.max(ageMs, 0) / 1000).toFixed(1)}s ago (< ${TTL_MS / 1000}s TTL)`);

  // 4. Single-use nonce (IS 19671 replay protection).
  const nonceCheck = ctx.usedNonces.has(payload.nonce)
    ? check('NONCE', false, 'REPLAY: nonce already used')
    : check('NONCE', true, `Unique (nonce …${payload.nonce.slice(-6)})`);

  // 5. Amount bounds: per-transaction cap bounds counterparty exposure.
  const a = payload.amount;
  const amountCheck = !Number.isInteger(a) || a <= 0
    ? check('AMOUNT', false, `Invalid amount ${a}`)
    : a > TXN_CAP
      ? check('AMOUNT', false, `₹${a} exceeds ₹${TXN_CAP} per-transaction cap`)
      : a > v.limit
        ? check('AMOUNT', false, `₹${a} exceeds voucher limit ₹${v.limit}`)
        : check('AMOUNT', true, `₹${a} within ₹${TXN_CAP} cap and ₹${v.limit} voucher`);

  // 6. PII minimisation (IS 17428): strict schema, opaque hex identifiers, no personal data in free text.
  const keys = Object.keys(JSON.parse(dec.decode(payloadBytes)) as object);
  const extraKeys = keys.filter((k) => !PAYLOAD_KEYS.includes(k));
  const leak = PII_PATTERNS.find(([re]) => re.test(payload.orderId));
  const piiCheck = extraKeys.length || keys.length !== PAYLOAD_KEYS.length
    ? check('PII', false, `Unexpected fields: ${extraKeys.join(', ') || 'schema mismatch'}`)
    : !/^[0-9a-f]{16}$/.test(payload.studentHash) || !/^[0-9a-f]{32}$/.test(payload.nonce)
      ? check('PII', false, 'Identifiers are not opaque hashes')
      : !ITEMS_RE.test(payload.items)
        ? check('PII', false, 'Order items are not plain menu ids')
        : leak
          ? check('PII', false, `Possible ${leak[1]} in orderId`)
          : check('PII', true, 'PASSED (pseudonymous hash only)');

  const checks = [voucherCheck, sigCheck, freshCheck, nonceCheck, amountCheck, piiCheck];
  const failed = checks.find((c) => !c.ok);
  return {
    ok: !failed,
    checks,
    elapsedMs: performance.now() - t0,
    payload,
    voucherSerial: v.serial,
    voucherLimit: v.limit,
    reason: failed ? REASONS[failed.name] : undefined,
  };
}

// ---------------------------------------------------------------------------
// Attack simulation (AttackPanel)
// ---------------------------------------------------------------------------

/** Edits the amount WITHOUT re-signing, so the device signature check must fail. */
export function tamperAmount(token: PaymentToken, newAmount: number): PaymentToken {
  const d = decodeFull(token);
  if (!d) return token;
  const parts = token.trim().split('.');
  parts[1] = toB64url(enc.encode(canonicalPayload({ ...d.payload, amount: newAmount })));
  return parts.join('.');
}

/** Validly signed, but generated 61 seconds ago, so the freshness check must fail. */
export function makeExpiredToken(wallet: WalletSecrets, opts: { orderId: string; amount: number }): Promise<PaymentToken> {
  return createPaymentToken(wallet, { ...opts, timestamp: Date.now() - TTL_MS - 1_000 });
}
