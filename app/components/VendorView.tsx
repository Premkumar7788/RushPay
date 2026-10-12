'use client';

// Vendor handheld PoS (Android phone, ?role=vendor). Flow per payment:
//   rear-camera QR scan → verifyToken (offline) → commitNonce → appendLedger → chime
//   → PAYMENT_ACK to the student laptop over Bluetooth LE (and the same-device channel for single-laptop demos).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { decodeToken, tamperAmount, verifyToken } from '@/lib/crypto';
import { bleLink, useBleState } from '@/lib/bleLink';
import { playAlarm, playChime, unlockAudio } from '@/lib/chime';
import { STALL } from '@/lib/mockData';
import { appendLedger, commitNonce, getBufferedCount, getShiftRevenue, getUsedNonces, openChannel, useRushStore } from '@/lib/store';
import type { ChannelMessage, PaymentToken, VerifyResult } from '@/lib/types';
import { AttackPanel, type AttackKind } from './AttackPanel';
import { Ledger } from './Ledger';
import { ScannerZone } from './ScannerZone';
import { SuccessModal, type ReceiptDelivery, type Settlement } from './SuccessModal';
import { REVEAL_STEP_MS, VerifyConsole } from './VerifyConsole';

type Tab = 'scan' | 'attack' | 'ledger';
type Accepted = { token: PaymentToken; nonce: string; orderId: string; amount: number };

const REASON_TEXT: Record<string, string> = {
  INVALID_VOUCHER: 'Forged or expired escrow voucher',
  SIGNATURE_MISMATCH: 'Signature mismatch: payload was tampered with',
  EXPIRED: 'Expired token (Δt > 60 s)',
  REPLAY: 'Replay attack: nonce already used',
  AMOUNT_OUT_OF_BOUNDS: 'Amount outside the ₹500 cap or voucher limit',
  PII_LEAK: 'Personal data found in payload',
  MALFORMED_TOKEN: 'Not a RushPay payment token',
};

const ATTACK_TITLE: Record<AttackKind, string> = { replay: 'Replay attack', tamper: 'Tamper attack', expire: 'Expired token' };

/** sameDevice: the student UI runs in this same browser (side-by-side mode), so the local channel reaches it. */
export function VendorView({ framed = false, sameDevice = false }: { framed?: boolean; sameDevice?: boolean }) {
  const revenue = useRushStore((s) => s.revenue);
  const buffered = useRushStore((s) => s.buffered);
  const ble = useBleState();

  const [tab, setTab] = useState<Tab>('scan');
  const [scanning, setScanning] = useState(true);
  const [result, setResult] = useState<{ r: VerifyResult; key: number; title: string } | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [lastAccepted, setLastAccepted] = useState<Accepted | null>(null);
  const [bleTokens, setBleTokens] = useState(false);
  const [online, setOnline] = useState(true);

  const accepted = useRef(new Map<string, Accepted>()); // this session's accepted nonces
  const busy = useRef(false);
  const channel = useRef<ReturnType<typeof openChannel> | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const revealMs = REVEAL_STEP_MS * 6 + 100;

  const later = (fn: () => void, ms: number) => timers.current.push(setTimeout(fn, ms));

  const sendAck = useCallback(async (ack: Extract<ChannelMessage, { type: 'PAYMENT_ACK' }>): Promise<ReceiptDelivery> => {
    channel.current?.send(ack);
    if (await bleLink.sendAck(ack)) return 'ble';
    return sameDevice ? 'local' : 'none';
  }, [sameDevice]);

  const processToken = useCallback(
    async (raw: string) => {
      if (busy.current) return;
      busy.current = true;
      setScanning(false);
      setAlert(null);
      setNotice(null);
      try {
        const token = raw.trim();
        const decoded = decodeToken(token);

        // Same payment seen again (the student's QR is still on screen, or a BLE re-sign): not an attack.
        const prior = decoded && accepted.current.get(decoded.payload.nonce);
        if (prior) {
          const delivery = await sendAck({ type: 'PAYMENT_ACK', orderId: prior.orderId, nonce: prior.nonce, amount: prior.amount, ok: true });
          setNotice(`${prior.orderId} is already settled. Receipt re-sent${delivery === 'ble' ? ' over Bluetooth' : ''}.`);
          later(() => setScanning(true), 1500);
          return;
        }

        const r = await verifyToken(token, { usedNonces: getUsedNonces() });
        setResult({ r, key: Date.now(), title: 'Payment verification' });

        if (r.ok && r.payload) {
          const p = r.payload;
          const revenueBefore = getShiftRevenue();
          commitNonce(p.nonce);
          await appendLedger({ ...p, voucherSerial: r.voucherSerial!, voucherLimit: r.voucherLimit!, token });
          const entry = { token, nonce: p.nonce, orderId: p.orderId, amount: p.amount };
          accepted.current.set(p.nonce, entry);
          setLastAccepted(entry);
          const delivery = await sendAck({ type: 'PAYMENT_ACK', orderId: p.orderId, nonce: p.nonce, amount: p.amount, ok: true });
          later(() => {
            playChime();
            setSettlement({
              orderId: p.orderId,
              amount: p.amount,
              revenueBefore,
              revenueAfter: getShiftRevenue(),
              bufferedCount: getBufferedCount(),
              delivery,
            });
          }, revealMs);
        } else {
          if (r.payload) {
            void sendAck({ type: 'PAYMENT_ACK', orderId: r.payload.orderId, nonce: r.payload.nonce, amount: r.payload.amount, ok: false, reason: r.reason });
          }
          later(() => {
            playAlarm();
            setAlert(`IS 19671 Security Violation: ${REASON_TEXT[r.reason ?? ''] ?? r.reason}`);
          }, revealMs);
        }
      } finally {
        busy.current = false;
      }
    },
    [revealMs, sendAck],
  );

  const runAttack = async (kind: AttackKind) => {
    if (!lastAccepted) return;
    setAlert(null);
    setNotice(null);
    const base = lastAccepted.token;
    const token = kind === 'tamper' ? tamperAmount(base, 8) : base;
    const now = kind === 'expire' ? (decodeToken(base)?.payload.timestamp ?? Date.now()) + 61_000 : undefined;
    const r = await verifyToken(token, { usedNonces: getUsedNonces(), now });
    setResult({ r, key: Date.now(), title: `${ATTACK_TITLE[kind]} (simulated)` });
    // Attacks never send a receipt to the student.
    later(() => {
      playAlarm();
      setAlert(
        r.ok
          ? `WARNING: ${ATTACK_TITLE[kind]} was NOT blocked`
          : `IS 19671 Security Violation: ${ATTACK_TITLE[kind]} blocked. ${REASON_TEXT[r.reason ?? ''] ?? r.reason}`,
      );
    }, revealMs);
  };

  // Same-device channel (two tabs / side-by-side mode) + optional tap-free tokens over BLE.
  useEffect(() => {
    const ch = openChannel();
    channel.current = ch;
    const off = ch.onMessage((m) => {
      if (m.type === 'PAYMENT_TOKEN') void processToken(m.token);
    });
    return () => {
      off();
      ch.close();
      channel.current = null;
    };
  }, [processToken]);

  useEffect(() => {
    if (!bleTokens) return;
    return bleLink.onToken((t) => void processToken(t));
  }, [bleTokens, processToken]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const bleLabel = {
    connected: `BLE: ${ble.deviceName ?? 'connected'}`,
    connecting: 'BLE: connecting…',
    reconnecting: 'BLE: reconnecting…',
    disconnected: 'BLE: not connected',
    unsupported: 'BLE: unavailable',
  }[ble.state];

  return (
    <div
      className={`w-full bg-gray-950 text-gray-100 ${framed ? 'mx-auto max-w-[440px] rounded-[36px] border-[5px] border-gray-800 p-4 shadow-2xl' : 'min-h-screen p-4'}`}
    >
      <div className="mx-auto max-w-md space-y-3">
        {/* Header */}
        <header className="space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-1.5">
                <h1 className="text-base font-black text-white">RushPay PoS</h1>
                <span className="rounded bg-amber-500/20 px-1.5 text-[9px] font-bold text-amber-300">VENDOR</span>
              </div>
              <p className="text-[11px] text-gray-400">{STALL.name}</p>
            </div>
            <div className="text-right">
              <div className="font-mono text-lg font-black text-emerald-400">₹{revenue.toLocaleString('en-IN')}</div>
              <div className="text-[10px] text-gray-400">{buffered} buffered for sync</div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-bold">
            <span className={`rounded-full px-2 py-1 ${online ? 'bg-gray-800 text-gray-300' : 'bg-amber-500/15 text-amber-300'}`}>
              {online ? 'Network: online' : 'Network: OFFLINE ✓'}
            </span>
            <span
              className={`rounded-full px-2 py-1 ${ble.state === 'connected' ? 'bg-sky-500/15 text-sky-300' : ble.state === 'unsupported' ? 'bg-red-500/10 text-red-300' : 'bg-gray-800 text-gray-400'}`}
            >
              {bleLabel}
            </span>
            {ble.state === 'connected' ? (
              <button onClick={() => bleLink.disconnect()} className="rounded-full bg-gray-800 px-2 py-1 text-gray-300">
                Disconnect
              </button>
            ) : (
              ble.state !== 'unsupported' && (
                <button
                  onClick={() => {
                    unlockAudio();
                    void bleLink.connect();
                  }}
                  disabled={ble.state === 'connecting'}
                  className="rounded-full bg-sky-500 px-2.5 py-1 text-black disabled:opacity-50"
                >
                  Connect student (BLE)
                </button>
              )
            )}
          </div>
          {ble.error && <p className="text-[10px] text-amber-300">{ble.error}</p>}
        </header>

        {/* Tabs */}
        <nav className="grid grid-cols-3 gap-1 rounded-2xl bg-gray-900 p-1 text-xs font-bold">
          {(['scan', 'attack', 'ledger'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-xl py-2 ${tab === t ? 'bg-gray-800 text-white' : 'text-gray-500'}`}
            >
              {t === 'scan' ? 'Scan' : t === 'attack' ? 'Attacks' : 'Ledger'}
            </button>
          ))}
        </nav>

        {alert && (
          <div className="rounded-2xl border-2 border-red-500 bg-red-600/20 p-3 text-sm font-black text-red-200">
            ⛔ {alert}
            {tab === 'scan' && (
              <button onClick={() => { setAlert(null); setScanning(true); }} className="mt-2 block w-full rounded-xl bg-red-500 py-2 text-xs text-white">
                Scan again
              </button>
            )}
          </div>
        )}
        {notice && <div className="rounded-2xl border border-sky-500/30 bg-sky-500/10 p-2.5 text-xs font-semibold text-sky-200">{notice}</div>}

        {tab === 'scan' && (
          <>
            <ScannerZone active={scanning && !settlement} onScan={(t) => void processToken(t)} onStart={unlockAudio} />
            <label className="flex items-center justify-between rounded-2xl bg-gray-900 px-3 py-2 text-[11px] text-gray-300">
              <span>
                Tap-free mode: receive token over BLE
                <span className="block text-[10px] text-gray-500">Needs the student connected over Bluetooth</span>
              </span>
              <input type="checkbox" checked={bleTokens} onChange={(e) => setBleTokens(e.target.checked)} className="h-5 w-5 accent-sky-500" />
            </label>
          </>
        )}
        {tab === 'attack' && <AttackPanel lastOrderId={lastAccepted?.orderId ?? null} onAttack={(k) => void runAttack(k)} />}
        {tab === 'ledger' && <Ledger />}

        {result && tab !== 'ledger' && <VerifyConsole result={result.r} revealKey={result.key} title={result.title} />}

        <p className="text-center text-[9px] text-gray-500">
          ECDSA P-256 · IS 19671 (TTL, nonce, anti-tamper) · IS 17428 (pseudonymous) · ISO/IEC 27001 (hash-chained audit log)
        </p>
      </div>

      {settlement && (
        <SuccessModal
          settlement={settlement}
          onClose={() => {
            setSettlement(null);
            setScanning(true);
          }}
        />
      )}
    </div>
  );
}
