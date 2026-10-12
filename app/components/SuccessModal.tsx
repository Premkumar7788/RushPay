'use client';

import React from 'react';
import { decodeItems } from '@/lib/mockData';

export type ReceiptDelivery = 'ble' | 'local' | 'none';

export type Settlement = {
  orderId: string;
  amount: number;
  items: string;
  revenueBefore: number;
  revenueAfter: number;
  bufferedCount: number;
  delivery: ReceiptDelivery;
};

const DELIVERY_TEXT: Record<ReceiptDelivery, string> = {
  ble: 'Receipt sent to student over Bluetooth LE ✓',
  local: 'Receipt sent to student (same-device channel) ✓',
  none: 'Student not connected over Bluetooth. Receipt not delivered.',
};

export function SuccessModal({ settlement, onClose }: { settlement: Settlement; onClose: () => void }) {
  const s = settlement;
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-emerald-500 p-6 text-center text-black">
      <div className="flex h-24 w-24 items-center justify-center rounded-full border-4 border-black/80 text-5xl font-black">✓</div>
      <h2 className="mt-5 text-2xl font-black leading-tight">
        ORDER {s.orderId} VERIFIED
        <br />₹{s.amount} SETTLED
      </h2>
      {s.items && (
        <ul className="mt-4 w-full max-w-xs space-y-0.5 rounded-2xl bg-black/15 p-3 text-left text-sm font-bold">
          {decodeItems(s.items).map((l) => (
            <li key={l.id} className="flex justify-between">
              <span>
                {l.qty} × {l.item?.name ?? l.id}
              </span>
              <span className="font-mono">₹{l.lineTotal}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 w-full max-w-xs space-y-1.5 rounded-2xl bg-black/10 p-3 text-left font-mono text-xs">
        <div className="flex justify-between">
          <span>Shift revenue</span>
          <span className="font-bold">
            ₹{s.revenueBefore.toLocaleString('en-IN')} → ₹{s.revenueAfter.toLocaleString('en-IN')}
          </span>
        </div>
        <div className="flex justify-between">
          <span>Buffered for settlement</span>
          <span className="font-bold">{s.bufferedCount} orders</span>
        </div>
      </div>
      <p className={`mt-3 text-xs font-bold ${s.delivery === 'none' ? 'text-red-900' : 'text-black/80'}`}>{DELIVERY_TEXT[s.delivery]}</p>
      <button onClick={onClose} className="mt-6 w-full max-w-xs rounded-2xl bg-black py-3.5 text-sm font-black text-emerald-400 active:scale-95">
        Next customer
      </button>
    </div>
  );
}
