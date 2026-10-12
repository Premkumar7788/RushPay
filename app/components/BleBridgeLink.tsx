'use client';

// Student-laptop side of the Bluetooth link. Talks to ble-bridge/bridge.mjs on this machine:
//   - receipts the phone wrote over BLE arrive on /ble/events and are re-broadcast on the in-page
//     channel, where StudentView already listens for PAYMENT_ACK;
//   - every payment token StudentView broadcasts is pushed to the peripheral (tap-free mode).
// Renders a small status badge. Does nothing when the bridge isn't running (e.g. `next dev`).
import React, { useEffect, useState } from 'react';
import { localLinkFetch, openChannel } from '@/lib/store';
import type { ChannelMessage } from '@/lib/types';

type BridgeStatus = { ble: string; advertising: boolean; phoneConnected: boolean };

export function BleBridgeLink() {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [bridgeUp, setBridgeUp] = useState<boolean | null>(null);

  useEffect(() => {
    const ch = openChannel();

    const offTokens = ch.onMessage((m: ChannelMessage) => {
      if (m.type !== 'PAYMENT_TOKEN') return;
      void localLinkFetch('/ble/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: m.token }),
      }).catch(() => {});
    });

    const es = new EventSource('/ble/events');
    es.addEventListener('open', () => setBridgeUp(true));
    es.addEventListener('error', () => {
      if (es.readyState === EventSource.CLOSED) setBridgeUp(false);
    });
    es.addEventListener('status', (e) => {
      setBridgeUp(true);
      setStatus(JSON.parse((e as MessageEvent).data));
    });
    es.addEventListener('ack', (e) => {
      const msg = JSON.parse((e as MessageEvent).data) as ChannelMessage;
      if (msg?.type === 'PAYMENT_ACK') ch.send(msg); // StudentView picks this up
    });

    return () => {
      es.close();
      offTokens();
      ch.close();
    };
  }, []);

  if (bridgeUp === false) {
    return (
      <div className="fixed bottom-3 left-3 z-50 rounded-xl border border-gray-700 bg-gray-900/95 px-3 py-2 text-[11px] text-gray-400">
        BLE bridge not running. Start the demo with <code className="text-gray-200">npm run demo</code>
      </div>
    );
  }
  if (!status) return null;

  const phone = status.phoneConnected;
  const text = phone
    ? 'Vendor phone connected over Bluetooth LE'
    : status.advertising
      ? 'Advertising as RushPay-Student. Waiting for vendor phone…'
      : `Bluetooth: ${status.ble}`;

  return (
    <div
      className={`fixed bottom-3 left-3 z-50 flex items-center gap-2 rounded-xl border px-3 py-2 text-[11px] font-semibold ${phone ? 'border-sky-500/40 bg-sky-950/90 text-sky-200' : 'border-gray-700 bg-gray-900/95 text-gray-300'}`}
    >
      <span className={`h-2 w-2 rounded-full ${phone ? 'bg-sky-400' : status.advertising ? 'animate-pulse bg-amber-400' : 'bg-red-400'}`} />
      {text}
    </div>
  );
}
