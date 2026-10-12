'use client';

import React from 'react';

export type AttackKind = 'replay' | 'tamper' | 'expire';

const ATTACKS: { kind: AttackKind; title: string; what: string; expect: string }[] = [
  {
    kind: 'replay',
    title: 'Replay attack',
    what: 'Re-submits the exact token that was just accepted, as if someone screenshotted the QR.',
    expect: 'Blocked by the anti-replay nonce cache',
  },
  {
    kind: 'tamper',
    title: 'Tamper attack',
    what: 'Changes the amount from the original to ₹8 without re-signing.',
    expect: 'Blocked by the ECDSA signature check',
  },
  {
    kind: 'expire',
    title: 'Expired token',
    what: 'Fast-forwards this terminal’s clock 61 s and re-checks the last token.',
    expect: 'Blocked by the 60 s time-to-live',
  },
];

export function AttackPanel({ lastOrderId, onAttack }: { lastOrderId: string | null; onAttack: (kind: AttackKind) => void }) {
  return (
    <div className="space-y-2">
      <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-3 text-[11px] text-gray-300">
        <span className="font-bold text-red-300">IS 19671 attack simulation.</span>{' '}
        {lastOrderId ? (
          <>Each attack reuses the last accepted payment ({lastOrderId}).</>
        ) : (
          <>Scan a real payment first; the attacks reuse that token.</>
        )}
      </div>
      {ATTACKS.map((a) => (
        <button
          key={a.kind}
          disabled={!lastOrderId}
          onClick={() => onAttack(a.kind)}
          className="w-full rounded-2xl border border-gray-800 bg-gray-900 p-3 text-left active:scale-[0.98] disabled:opacity-40"
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-black text-white">{a.title}</span>
            <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] font-bold text-red-300">Run ▶</span>
          </div>
          <p className="mt-1 text-[11px] text-gray-400">{a.what}</p>
          <p className="mt-0.5 text-[10px] font-semibold text-emerald-400">Expected: {a.expect}</p>
        </button>
      ))}
    </div>
  );
}
