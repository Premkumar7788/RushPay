'use client';

// Vendor order book: every order this terminal accepted, newest first, with the signed items.
// Tap an order for its cryptographic details.
import React, { useState } from 'react';
import { decodeItems, itemsTotal } from '@/lib/mockData';
import { useRushStore } from '@/lib/store';
import type { LedgerRow, LedgerStatus } from '@/lib/types';

type Filter = 'ALL' | LedgerStatus;

const PILL: Record<LedgerStatus, string> = {
  BUFFERED: 'bg-amber-500/15 text-amber-300',
  CLEARED: 'bg-emerald-500/15 text-emerald-300',
  DOUBLE_SPEND: 'bg-red-500/20 text-red-300',
};
const PILL_TEXT: Record<LedgerStatus, string> = { BUFFERED: 'Buffered', CLEARED: 'Cleared', DOUBLE_SPEND: 'Double-spend' };

const short = (h: string | undefined, n = 12) => (h ? (h.length > n ? `${h.slice(0, n)}…` : h) : '—');

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="shrink-0 text-gray-500">{label}</span>
      <span className="min-w-0 break-all text-right text-gray-200">{value}</span>
    </div>
  );
}

function OrderCard({ row, open, onToggle }: { row: LedgerRow; open: boolean; onToggle: () => void }) {
  const lines = decodeItems(row.items);
  const menuTotal = itemsTotal(row.items);
  const live = !row.voucherSerial.startsWith('seed-');
  const time = new Date(row.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <li className={`rounded-2xl border bg-gray-900 ${live ? 'border-emerald-500/30' : 'border-gray-800'}`}>
      <button onClick={onToggle} className="w-full p-3 text-left">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-black text-white">{row.orderId}</span>
            {live && <span className="rounded bg-emerald-500/20 px-1 text-[9px] font-bold text-emerald-300">LIVE</span>}
            <span className="text-[10px] text-gray-500">{time}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${PILL[row.status]}`}>{PILL_TEXT[row.status]}</span>
            <span className="font-mono text-sm font-black text-emerald-400">₹{row.amount}</span>
          </div>
        </div>

        {lines.length > 0 ? (
          <ul className="mt-1.5 space-y-0.5 text-[11px] text-gray-300">
            {lines.map((l) => (
              <li key={l.id} className="flex justify-between">
                <span>
                  <span className="font-bold text-white">{l.qty} ×</span> {l.item?.name ?? l.id}
                </span>
                <span className="font-mono text-gray-400">₹{l.lineTotal}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-[11px] text-gray-500">No item list (older token format)</p>
        )}
        <div className="mt-1 text-right text-[9px] text-gray-500">{open ? 'Hide details ▲' : 'Details ▼'}</div>
      </button>

      {open && (
        <div className="space-y-1 border-t border-gray-800 p-3 font-mono text-[10px]">
          <Detail
            label="Items vs amount"
            value={
              lines.length === 0 ? '—' : menuTotal === row.amount ? (
                <span className="text-emerald-300">₹{menuTotal} matches ✓</span>
              ) : (
                <span className="text-red-300">menu ₹{menuTotal} ≠ paid ₹{row.amount}</span>
              )
            }
          />
          <Detail label="Payer (pseudonymous)" value={short(row.studentHash, 16)} />
          <Detail label="Received" value={new Date(row.timestamp).toLocaleString()} />
          <Detail label="Nonce" value={short(row.nonce, 16)} />
          <Detail label="Escrow voucher" value={`${row.voucherSerial} (limit ₹${row.voucherLimit})`} />
          <Detail label="Token hash" value={short(row.tokenHash, 16)} />
          <Detail label="Ledger row" value={`#${row.index} · ${short(row.rowHash, 16)}`} />
          <Detail label="Previous row" value={short(row.prevHash, 16)} />
        </div>
      )}
    </li>
  );
}

export function OrdersView() {
  const ledger = useRushStore((s) => s.ledger);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const rows = [...ledger].reverse().filter((r) => filter === 'ALL' || r.status === filter);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const counts = ledger.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-2xl bg-gray-900 p-2">
          <div className="font-mono text-base font-black text-white">{ledger.length}</div>
          <div className="text-[10px] text-gray-500">orders</div>
        </div>
        <div className="rounded-2xl bg-gray-900 p-2">
          <div className="font-mono text-base font-black text-amber-300">{counts.BUFFERED ?? 0}</div>
          <div className="text-[10px] text-gray-500">buffered</div>
        </div>
        <div className="rounded-2xl bg-gray-900 p-2">
          <div className="font-mono text-base font-black text-emerald-300">{counts.CLEARED ?? 0}</div>
          <div className="text-[10px] text-gray-500">cleared</div>
        </div>
      </div>

      <div className="flex gap-1.5 overflow-x-auto text-[11px] font-bold">
        {(['ALL', 'BUFFERED', 'CLEARED', 'DOUBLE_SPEND'] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`shrink-0 rounded-full px-3 py-1.5 ${filter === f ? 'bg-white text-black' : 'bg-gray-900 text-gray-400'}`}
          >
            {f === 'ALL' ? 'All' : PILL_TEXT[f]}
          </button>
        ))}
      </div>

      <div className="flex justify-between px-1 text-[11px] text-gray-400">
        <span>{rows.length} shown</span>
        <span className="font-mono">Total ₹{total.toLocaleString('en-IN')}</span>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-gray-800 p-6 text-center text-xs text-gray-500">No orders here yet.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <OrderCard key={r.index} row={r} open={openIndex === r.index} onToggle={() => setOpenIndex(openIndex === r.index ? null : r.index)} />
          ))}
        </ul>
      )}
    </div>
  );
}
