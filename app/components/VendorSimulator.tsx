'use client';

import React, { useEffect, useState } from 'react';
import { openChannel } from '@/lib/store';
import { decodeToken } from '@/lib/crypto';
import type { ChannelMessage, PaymentPayload } from '@/lib/types';

export const VendorSimulator: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [lastToken, setLastToken] = useState<{
    raw: string;
    payload: PaymentPayload;
    receivedAt: number;
  } | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    const ch = openChannel();
    const unsub = ch.onMessage((msg: ChannelMessage) => {
      if (msg.type === 'PAYMENT_TOKEN') {
        const decoded = decodeToken(msg.token);
        if (decoded) {
          setLastToken({
            raw: msg.token,
            payload: decoded.payload,
            receivedAt: Date.now(),
          });
          setLogs((prev) => [
            `[${new Date().toLocaleTimeString()}] RECEIVED: ${decoded.payload.orderId} (₹${decoded.payload.amount})`,
            ...prev.slice(0, 5),
          ]);
        }
      }
    });

    return () => {
      unsub();
      ch.close();
    };
  }, []);

  const handleSendAck = (ok: boolean, reason?: string) => {
    if (!lastToken) return;
    const ch = openChannel();
    ch.send({
      type: 'PAYMENT_ACK',
      orderId: lastToken.payload.orderId,
      nonce: lastToken.payload.nonce,
      amount: lastToken.payload.amount,
      ok,
      reason,
    });
    ch.close();

    setLogs((prev) => [
      `[${new Date().toLocaleTimeString()}] SENT ACK: ${lastToken.payload.orderId} ok=${ok}`,
      ...prev.slice(0, 5),
    ]);
  };

  return (
    <div className="fixed bottom-3 right-3 z-50 max-w-xs w-full bg-gray-900 text-gray-100 rounded-2xl border border-gray-700 shadow-2xl overflow-hidden text-xs">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-3 py-2 bg-gray-800 hover:bg-gray-750 text-left transition-colors"
      >
        <div className="flex items-center gap-1.5 font-semibold text-gray-200">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span>Vendor Simulator (Dev Dock)</span>
        </div>
        <span className="text-[10px] text-gray-400">{isOpen ? '▼' : '▲'}</span>
      </button>

      {isOpen && (
        <div className="p-3 space-y-2.5 bg-gray-900/95 max-h-80 overflow-y-auto">
          <p className="text-[10px] text-gray-400">
            Simulates Gazebo Stall #4 receiving the student&apos;s proximity broadcast over channel <code className="text-emerald-400">rushpay-ble</code>.
          </p>

          {lastToken ? (
            <div className="bg-gray-800 rounded-xl p-2.5 border border-gray-700 space-y-1.5 text-[11px]">
              <div className="flex justify-between font-bold text-emerald-300">
                <span>Order: {lastToken.payload.orderId}</span>
                <span className="font-mono text-emerald-400">₹{lastToken.payload.amount}</span>
              </div>
              <div className="font-mono text-[9px] text-gray-400">
                Nonce: {lastToken.payload.nonce.slice(0, 12)}...
              </div>

              <div className="pt-1.5 flex gap-1.5">
                <button
                  onClick={() => handleSendAck(true)}
                  className="flex-1 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg text-xs transition-colors"
                >
                  ✓ Accept &amp; Settle
                </button>
                <button
                  onClick={() => handleSendAck(false, 'SIMULATED_REJECT')}
                  className="flex-1 py-1.5 bg-red-600/80 hover:bg-red-600 text-white font-bold rounded-lg text-xs transition-colors"
                >
                  ✗ Reject
                </button>
              </div>
            </div>
          ) : (
            <div className="p-2.5 rounded-xl bg-gray-800/40 border border-dashed border-gray-700 text-center text-gray-500 text-[11px]">
              Tap &quot;Pay via RushPay&quot; in phone to broadcast...
            </div>
          )}

          <div>
            <div className="text-[9px] font-bold text-gray-400 uppercase tracking-wider mb-1">Channel Log</div>
            <div className="bg-black/50 rounded-lg p-1.5 font-mono text-[9px] text-gray-300 space-y-0.5 min-h-[40px]">
              {logs.length === 0 ? (
                <span className="text-gray-600">No events yet</span>
              ) : (
                logs.map((log, i) => <div key={i} className="truncate">{log}</div>)
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
