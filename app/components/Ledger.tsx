'use client';

// Append-only, hash-chained offline ledger (ISO/IEC 27001 tamper-evident audit log) with Sync & Settle.
import React, { useState } from 'react';
import { resetDemo, settleBatch, tamperLedgerForDemo, useRushStore, verifyLedgerChain } from '@/lib/store';
import type { LedgerStatus } from '@/lib/types';

const PILL: Record<LedgerStatus, string> = {
  BUFFERED: 'bg-amber-500/15 text-amber-300',
  CLEARED: 'bg-emerald-500/15 text-emerald-300',
  DOUBLE_SPEND: 'bg-red-500/20 text-red-300',
};

export function Ledger() {
  const ledger = useRushStore((s) => s.ledger);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<{ ok: boolean; text: string }>) => {
    setBusy(true);
    try {
      setMessage(await fn());
    } finally {
      setBusy(false);
    }
  };

  const checkChain = () =>
    run(async () => {
      const r = await verifyLedgerChain();
      return r.ok
        ? { ok: true, text: `Hash chain intact: all ${ledger.length} rows verified.` }
        : { ok: false, text: `TAMPERING DETECTED at row ${r.brokenAt}. The audit log has been altered.` };
    });

  const settle = () =>
    run(async () => {
      const r = await settleBatch();
      return {
        ok: r.doubleSpends.length === 0,
        text: `Settled ${r.cleared} orders, payout ₹${r.payout.toLocaleString('en-IN')}` +
          (r.doubleSpends.length ? `. ${r.doubleSpends.length} double-spend(s) rejected.` : '. No double-spends.'),
      };
    });

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <button disabled={busy} onClick={() => void checkChain()} className="rounded-xl bg-gray-800 py-2.5 text-xs font-bold text-white disabled:opacity-50">
          Verify hash chain
        </button>
        <button disabled={busy} onClick={() => void settle()} className="rounded-xl bg-emerald-600 py-2.5 text-xs font-bold text-white disabled:opacity-50">
          Sync &amp; Settle
        </button>
        <button
          disabled={busy || ledger.length < 4}
          onClick={() => {
            tamperLedgerForDemo(3, 1);
            setMessage({ ok: false, text: 'Row 3 amount secretly changed to ₹1. Now tap "Verify hash chain".' });
          }}
          className="rounded-xl border border-red-500/30 bg-red-500/10 py-2.5 text-xs font-bold text-red-300 disabled:opacity-50"
        >
          Tamper row 3 (demo)
        </button>
        <button
          disabled={busy}
          onClick={() => {
            if (confirm('Reset this terminal to the demo start (₹1,840, 14 orders)?')) {
              void resetDemo().then(() => setMessage(null));
            }
          }}
          className="rounded-xl bg-gray-900 py-2.5 text-xs font-bold text-gray-400 disabled:opacity-50"
        >
          Reset demo
        </button>
      </div>

      {message && (
        <p className={`rounded-xl border p-2 text-[11px] font-semibold ${message.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-red-500/30 bg-red-500/10 text-red-200'}`}>
          {message.text}
        </p>
      )}

      <div className="overflow-hidden rounded-2xl border border-gray-800">
        <table className="w-full table-fixed text-left font-mono text-[10px]">
          <thead className="bg-gray-900 text-gray-400">
            <tr>
              <th className="w-7 p-1.5">#</th>
              <th className="p-1.5">Order</th>
              <th className="w-12 p-1.5 text-right">₹</th>
              <th className="p-1.5">Row hash</th>
              <th className="w-[4.5rem] p-1.5">Status</th>
            </tr>
          </thead>
          <tbody>
            {[...ledger].reverse().map((r) => (
              <tr key={r.index} className="border-t border-gray-800/80 text-gray-200">
                <td className="p-1.5 text-gray-500">{r.index}</td>
                <td className="p-1.5 font-bold">{r.orderId}</td>
                <td className="p-1.5 text-right">{r.amount}</td>
                <td className="truncate p-1.5 text-gray-500" title={`prev ${r.prevHash}`}>
                  {r.rowHash.slice(0, 10)}…
                </td>
                <td className="p-1.5">
                  <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${PILL[r.status]}`}>{r.status === 'DOUBLE_SPEND' ? 'DOUBLE' : r.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
