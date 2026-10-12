'use client';

// Shows the six verifyToken() checks one by one (~150ms apart) so judges can follow them.
// The real verification has already finished; elapsedMs is the measured on-device time.
import React, { useEffect, useState } from 'react';
import type { VerifyResult } from '@/lib/types';

export const REVEAL_STEP_MS = 150;

type Props = { result: VerifyResult; revealKey: number; title?: string };

export function VerifyConsole({ result, revealKey, title = 'Cryptographic verification' }: Props) {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    setShown(0);
    let n = 0;
    const id = setInterval(() => {
      n += 1;
      setShown(n);
      if (n >= result.checks.length) clearInterval(id);
    }, REVEAL_STEP_MS);
    return () => clearInterval(id);
  }, [revealKey, result.checks.length]);

  const done = shown >= result.checks.length;

  return (
    <div className="space-y-2 rounded-2xl border border-gray-800 bg-gray-900/80 p-3 font-mono">
      <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-gray-400">
        <span>{title}</span>
        {result.payload && (
          <span className="text-gray-300">
            {result.payload.orderId} · ₹{result.payload.amount}
          </span>
        )}
      </div>

      <ul className="space-y-1.5">
        {result.checks.map((c, i) => {
          const visible = i < shown;
          return (
            <li key={c.name} className={`flex gap-2 text-[11px] transition-opacity ${visible ? 'opacity-100' : 'opacity-30'}`}>
              <span className="w-4 shrink-0 text-center">
                {!visible ? <span className="inline-block animate-pulse text-gray-500">•</span> : c.ok ? (
                  <span className="text-emerald-400">✓</span>
                ) : (
                  <span className="text-red-400">✗</span>
                )}
              </span>
              <span className="min-w-0">
                <span className={`block font-bold ${visible && !c.ok ? 'text-red-300' : 'text-gray-200'}`}>{c.label}</span>
                {visible && <span className={`block break-words text-[10px] ${c.ok ? 'text-gray-400' : 'text-red-300/90'}`}>{c.detail}</span>}
              </span>
            </li>
          );
        })}
      </ul>

      {done && (
        <div className={`flex items-center justify-between border-t border-gray-800 pt-2 text-[10px] ${result.ok ? 'text-emerald-300' : 'text-red-300'}`}>
          <span className="font-bold">{result.ok ? 'ALL CHECKS PASSED' : `BLOCKED: ${result.reason}`}</span>
          <span className="text-gray-400">
            {result.elapsedMs.toFixed(2)} ms on-device · target &lt; 300 ms · 0 network calls
          </span>
        </div>
      )}
    </div>
  );
}
