'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { MENU, STALL, DEFAULT_BALANCE, MenuItem } from '@/lib/mockData';
import {
  createStudentWallet,
  createPaymentToken,
  decodeToken,
} from '@/lib/crypto';
import {
  loadWallet,
  saveWallet,
  useRushStore,
  debit,
  nextOrderId,
  openChannel,
  setOfflineMode,
  resetDemo,
} from '@/lib/store';
import { playChime, playAlarm } from '@/lib/chime';
import type { ChannelMessage, WalletSecrets } from '@/lib/types';
import { CountdownRing } from './CountdownRing';
import { BleRadar } from './BleRadar';

export const StudentView: React.FC = () => {
  // Store Subscriptions (reactive via syncExternalStore)
  const balance = useRushStore((s) => s.balance);
  const isOffline = useRushStore((s) => s.offline);

  // Student Wallet
  const [wallet, setWallet] = useState<WalletSecrets | null>(null);

  // Cart State (defaults to 1 Paneer Tikka Roll = ₹80 to match live order #104)
  const [cart, setCart] = useState<Record<string, number>>({
    'paneer-roll': 1,
  });

  // Payment Session State
  const [isPaying, setIsPaying] = useState(false);
  const [activeOrderId, setActiveOrderId] = useState<string>('');
  const [activeAmount, setActiveAmount] = useState<number>(0);
  const [activeToken, setActiveToken] = useState<string>('');
  const [reSignCount, setReSignCount] = useState(0);
  const [isExpired, setIsExpired] = useState(false);
  const [settledResult, setSettledResult] = useState<{
    orderId: string;
    amount: number;
    timestamp: number;
  } | null>(null);
  const [rejectReason, setRejectReason] = useState<string | null>(null);

  const reSignIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const channelRef = useRef<ReturnType<typeof openChannel> | null>(null);

  // Load or initialize student wallet on mount
  useEffect(() => {
    async function initWallet() {
      let w = loadWallet();
      if (!w) {
        w = await createStudentWallet('21BCE1234', DEFAULT_BALANCE);
        saveWallet(w);
      }
      setWallet(w);
    }
    void initWallet();
  }, []);

  // Compute Subtotal & Item Count
  const subtotal = MENU.reduce((acc, item) => {
    return acc + item.price * (cart[item.id] || 0);
  }, 0);

  const totalItemsCount = Object.values(cart).reduce((a, b) => a + b, 0);

  const updateQuantity = (itemId: string, delta: number) => {
    setCart((prev) => {
      const current = prev[itemId] || 0;
      const next = Math.max(0, current + delta);
      if (next === 0) {
        const copy = { ...prev };
        delete copy[itemId];
        return copy;
      }
      return { ...prev, [itemId]: next };
    });
  };

  // Broadcast helper using official proximity channel
  const broadcast = useCallback((token: string) => {
    if (!channelRef.current) {
      channelRef.current = openChannel();
    }
    channelRef.current.send({
      type: 'PAYMENT_TOKEN',
      token,
      sentAt: Date.now(),
    });
  }, []);

  // Dynamic Re-signing: fresh timestamp every ~10s while preserving the same nonce
  const reSignPayment = useCallback(
    async (currentWallet: WalletSecrets, orderId: string, amount: number, existingNonce?: string) => {
      try {
        const token = await createPaymentToken(currentWallet, {
          orderId,
          amount,
          nonce: existingNonce,
        });
        setActiveToken(token);
        setReSignCount((prev) => prev + 1);
        broadcast(token);
        return token;
      } catch (err) {
        console.error('Failed to sign payment token', err);
        return null;
      }
    },
    [broadcast]
  );

  // Start Payment Flow
  const handleStartPayment = async () => {
    if (subtotal <= 0 || subtotal > balance || !wallet) return;

    const orderId = nextOrderId();
    const amount = subtotal;

    setActiveOrderId(orderId);
    setActiveAmount(amount);
    setIsExpired(false);
    setSettledResult(null);
    setRejectReason(null);
    setReSignCount(0);
    setIsPaying(true);

    const initialToken = await reSignPayment(wallet, orderId, amount);
    if (!initialToken) return;

    const decoded = decodeToken(initialToken);
    const nonce = decoded?.payload.nonce;

    // Dynamic re-signing timer (every 10s with the SAME nonce)
    if (reSignIntervalRef.current) clearInterval(reSignIntervalRef.current);
    reSignIntervalRef.current = setInterval(() => {
      void reSignPayment(wallet, orderId, amount, nonce);
    }, 10000);
  };

  const handleClosePayment = () => {
    setIsPaying(false);
    setIsExpired(false);
    if (reSignIntervalRef.current) {
      clearInterval(reSignIntervalRef.current);
      reSignIntervalRef.current = null;
    }
  };

  const handleRegenerate = async () => {
    if (!wallet || !activeOrderId) return;
    setIsExpired(false);
    setRejectReason(null);

    // Fresh nonce for new 60s lifecycle
    const freshToken = await reSignPayment(wallet, activeOrderId, activeAmount);
    if (!freshToken) return;

    const decoded = decodeToken(freshToken);
    const nonce = decoded?.payload.nonce;

    if (reSignIntervalRef.current) clearInterval(reSignIntervalRef.current);
    reSignIntervalRef.current = setInterval(() => {
      void reSignPayment(wallet, activeOrderId, activeAmount, nonce);
    }, 10000);
  };

  // Channel Listener for PAYMENT_ACK
  useEffect(() => {
    const ch = openChannel();
    channelRef.current = ch;

    const unsubscribe = ch.onMessage((msg: ChannelMessage) => {
      if (msg.type === 'PAYMENT_ACK' && msg.orderId === activeOrderId) {
        if (msg.ok) {
          debit(msg.orderId, msg.amount);
          playChime();

          if (reSignIntervalRef.current) {
            clearInterval(reSignIntervalRef.current);
            reSignIntervalRef.current = null;
          }

          setSettledResult({
            orderId: msg.orderId,
            amount: msg.amount,
            timestamp: Date.now(),
          });
          setCart({});
        } else {
          playAlarm();
          setRejectReason(msg.reason || 'Verification rejected by vendor terminal');
        }
      }
    });

    return () => {
      unsubscribe();
      ch.close();
    };
  }, [activeOrderId]);

  useEffect(() => {
    return () => {
      if (reSignIntervalRef.current) clearInterval(reSignIntervalRef.current);
    };
  }, []);

  return (
    <div className="w-full max-w-[400px] mx-auto bg-gray-950 text-gray-100 rounded-[44px] p-4 shadow-2xl border-[5px] border-gray-800 relative font-sans select-none overflow-hidden">
      {/* ----------------- Phone Frame Status Bar ----------------- */}
      <div className="w-full flex items-center justify-between px-4 pt-1.5 pb-2 text-xs text-gray-300 font-medium">
        <span>12:45</span>

        {/* Dynamic Island Pill */}
        <div className="w-24 h-5 bg-black rounded-full flex items-center justify-center gap-1.5 px-2 shadow-inner">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-[10px] text-emerald-400 font-mono tracking-tighter">RushPay BLE</span>
        </div>

        <div className="flex items-center gap-2">
          {/* Offline / Online Icon */}
          {isOffline ? (
            <span className="text-[10px] font-mono text-amber-400 font-bold">AIRGAP</span>
          ) : (
            <span className="text-[10px] font-mono text-gray-400">ONLINE</span>
          )}
          <span className="text-[10px] font-mono">98%</span>
          {/* Battery Icon */}
          <div className="w-4 h-2.5 border border-emerald-400 rounded-sm p-0.5 flex items-center">
            <div className="h-full w-full bg-emerald-400 rounded-xs" />
          </div>
        </div>
      </div>

      {/* ----------------- App Content ----------------- */}
      <div className="p-2 space-y-3.5">
        {/* Header Bar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center text-black font-black text-base shadow-md shadow-emerald-500/20">
              ⚡
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h1 className="text-sm font-extrabold tracking-tight text-white">RushPay</h1>
                <span className="px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 text-[9px] font-mono font-bold">
                  STUDENT
                </span>
              </div>
              <p className="text-[10px] text-gray-400 font-medium">
                {wallet ? `Hash: …${wallet.studentHash.slice(-6)}` : 'Generating wallet…'}
              </p>
            </div>
          </div>

          {/* Airgap / Offline Switch */}
          <button
            onClick={() => setOfflineMode(!isOffline)}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px] font-semibold transition-all ${
              isOffline
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-300 shadow-sm'
                : 'bg-gray-800 border-gray-700 text-gray-300'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                isOffline ? 'bg-amber-400 animate-ping' : 'bg-gray-500'
              }`}
            />
            <span>{isOffline ? 'Offline Mode' : 'Online'}</span>
          </button>
        </div>

        {/* Escrow Balance Card */}
        <div className="relative rounded-3xl p-3.5 bg-gradient-to-br from-gray-900 via-gray-900 to-emerald-950/50 border border-emerald-500/30 shadow-lg overflow-hidden">
          <div className="flex items-start justify-between">
            <div className="space-y-0.5">
              <span className="text-[11px] font-semibold text-emerald-400 block">
                Pre-funded Offline Escrow Balance
              </span>
              <div className="text-2xl font-black font-mono tracking-tight text-white">
                ₹{balance.toFixed(2)}
              </div>
            </div>

            <button
              onClick={() => void resetDemo()}
              title="Reset Demo to ₹320.00"
              className="p-1 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors text-[10px] font-mono"
            >
              Reset
            </button>
          </div>

          <div className="mt-2.5 pt-2 border-t border-gray-800 flex items-center justify-between text-[10px] text-gray-400">
            <span>RBI PPI Escrow Limits</span>
            <span className="font-mono text-gray-500">Max ₹500/tx</span>
          </div>
        </div>

        {/* Gazebo Stall #4 Header Banner */}
        <div className="bg-gray-900 rounded-2xl p-2.5 border border-gray-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-sm">
              🌯
            </div>
            <div>
              <div className="text-xs font-bold text-white flex items-center gap-1">
                <span>{STALL.name}</span>
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              </div>
              <p className="text-[10px] text-gray-400">{STALL.location} • Fast Counter</p>
            </div>
          </div>
          <span className="px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700 text-[9px] font-mono text-emerald-400">
            BLE 0xFD6F
          </span>
        </div>

        {/* Menu Items */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between px-1">
            <span className="text-[11px] font-bold text-gray-300 uppercase tracking-wider">
              Canteen Menu
            </span>
            <span className="text-[10px] text-gray-400 font-mono">
              {totalItemsCount} {totalItemsCount === 1 ? 'item' : 'items'}
            </span>
          </div>

          <div className="space-y-1.5">
            {MENU.map((item: MenuItem) => {
              const qty = cart[item.id] || 0;
              return (
                <div
                  key={item.id}
                  className={`flex items-center justify-between p-2 rounded-2xl border transition-all ${
                    qty > 0
                      ? 'bg-gray-900 border-emerald-500/30'
                      : 'bg-gray-900/40 border-gray-800/80'
                  }`}
                >
                  <div>
                    <div className="text-xs font-bold text-gray-200">{item.name}</div>
                    <div className="text-xs font-bold font-mono text-emerald-400">
                      ₹{item.price.toFixed(2)}
                    </div>
                  </div>

                  {/* Quantity +/- Buttons */}
                  <div className="flex items-center gap-1.5 bg-gray-950 rounded-xl p-1 border border-gray-800">
                    <button
                      onClick={() => updateQuantity(item.id, -1)}
                      disabled={qty === 0}
                      className="w-5 h-5 rounded-md bg-gray-800 hover:bg-gray-700 disabled:opacity-40 flex items-center justify-center text-white text-xs font-bold"
                    >
                      -
                    </button>
                    <span className="w-4 text-center font-mono text-xs font-bold text-white">
                      {qty}
                    </span>
                    <button
                      onClick={() => updateQuantity(item.id, 1)}
                      className="w-5 h-5 rounded-md bg-emerald-600 hover:bg-emerald-500 flex items-center justify-center text-white text-xs font-bold"
                    >
                      +
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Subtotal & Checkout Button */}
        <div className="pt-1.5 border-t border-gray-800 space-y-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-xs font-semibold text-gray-400">Subtotal</span>
            <span className="text-base font-black font-mono text-white">
              ₹{subtotal.toFixed(2)}
            </span>
          </div>

          <button
            onClick={() => void handleStartPayment()}
            disabled={subtotal <= 0 || subtotal > balance}
            className={`w-full py-3 px-4 rounded-2xl font-black text-xs flex items-center justify-center gap-2 shadow-lg transition-all ${
              subtotal <= 0 || subtotal > balance
                ? 'bg-gray-800 text-gray-500 cursor-not-allowed'
                : 'bg-gradient-to-r from-emerald-500 via-emerald-600 to-teal-500 text-black hover:brightness-110 shadow-emerald-500/20 active:scale-[0.98]'
            }`}
          >
            <span>Pay ₹{subtotal.toFixed(2)} via RushPay</span>
            <span>→</span>
          </button>
        </div>

        {/* Security Stamp */}
        <div className="p-2 rounded-xl bg-gray-900/60 border border-gray-800 text-center text-[10px] text-gray-400 space-y-0.5">
          <div className="font-bold text-gray-300">
            BIS IS 19671:2026 &amp; IS 17428 Compliant
          </div>
          <div className="text-[9px] text-gray-500 font-mono">
            Zero-Network Local Settlement • Pseudonymous Student Hash
          </div>
        </div>
      </div>

      {/* ----------------- PAYMENT OVERLAY MODAL ----------------- */}
      {isPaying && (
        <div className="absolute inset-0 z-40 bg-gray-950/95 backdrop-blur-md p-4 flex flex-col justify-between overflow-y-auto">
          {/* Modal Header */}
          <div className="flex items-center justify-between pb-2 border-b border-gray-800">
            <div className="flex items-center gap-1.5 text-xs font-black text-white">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
              <span>PAYMENT AUTHORIZATION</span>
            </div>
            <button
              onClick={handleClosePayment}
              className="w-6 h-6 rounded-full bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white flex items-center justify-center text-xs"
            >
              ✕
            </button>
          </div>

          {/* Settled State */}
          {settledResult ? (
            <div className="my-auto py-4 text-center space-y-3">
              <div className="w-16 h-16 rounded-full bg-emerald-500/20 border-2 border-emerald-400 mx-auto flex items-center justify-center text-emerald-400 text-2xl font-bold shadow-lg">
                ✓
              </div>

              <div className="space-y-0.5">
                <h3 className="text-lg font-black text-white">PAYMENT SETTLED</h3>
                <p className="text-xs font-bold text-emerald-400">
                  ₹{settledResult.amount.toFixed(2)} Settled with {STALL.name}
                </p>
                <p className="text-[10px] font-mono text-gray-400">
                  Order {settledResult.orderId}
                </p>
              </div>

              <div className="p-2.5 bg-gray-900 rounded-xl border border-gray-800 text-left font-mono text-[9px] text-gray-300 space-y-1">
                <div className="flex justify-between">
                  <span className="text-gray-500">Order ID:</span>
                  <span className="text-white font-bold">{settledResult.orderId}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Remaining Balance:</span>
                  <span className="text-emerald-400 font-bold">₹{balance.toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Settled At:</span>
                  <span>{new Date(settledResult.timestamp).toLocaleTimeString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Protocol:</span>
                  <span>ECDSA P-256 Airgap ACK</span>
                </div>
              </div>

              <button
                onClick={handleClosePayment}
                className="w-full py-2.5 bg-emerald-500 hover:bg-emerald-400 text-black font-black text-xs rounded-xl transition-all shadow-md"
              >
                Done
              </button>
            </div>
          ) : (
            /* Active QR / Radar Zone */
            <div className="space-y-2.5 my-auto">
              {/* Order Info Banner */}
              <div className="flex items-center justify-between p-2 rounded-xl bg-gray-900 border border-gray-800 text-xs">
                <div>
                  <span className="text-gray-400 block text-[9px]">ORDER</span>
                  <span className="font-extrabold text-white">{activeOrderId}</span>
                </div>
                <div className="text-right">
                  <span className="text-gray-400 block text-[9px]">AMOUNT</span>
                  <span className="text-sm font-black font-mono text-emerald-400">
                    ₹{activeAmount.toFixed(2)}
                  </span>
                </div>
              </div>

              {/* Rejection Alert */}
              {rejectReason && (
                <div className="p-2 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-[11px]">
                  ⚠ {rejectReason}
                </div>
              )}

              {/* QR Code Container */}
              <div className="relative flex flex-col items-center justify-center p-3 rounded-2xl bg-gray-900 border border-gray-800 shadow-lg">
                <div
                  className={`p-2.5 bg-white rounded-xl shadow-md transition-all ${
                    isExpired ? 'opacity-20 blur-sm pointer-events-none' : 'opacity-100'
                  }`}
                >
                  {activeToken ? (
                    <QRCodeSVG
                      value={activeToken}
                      size={150}
                      level="M"
                      includeMargin={false}
                    />
                  ) : (
                    <div className="w-36 h-36 flex items-center justify-center text-gray-400 text-xs font-mono">
                      Generating token…
                    </div>
                  )}
                </div>

                {/* Expired Overlay */}
                {isExpired && (
                  <div className="absolute inset-0 rounded-2xl flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm p-4 text-center space-y-2 z-20">
                    <span className="text-xs font-bold text-red-400">
                      Token Expired (IS 19671 Δt &gt; 60s)
                    </span>
                    <button
                      onClick={() => void handleRegenerate()}
                      className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black font-bold text-xs"
                    >
                      Regenerate Dynamic QR
                    </button>
                  </div>
                )}

                <div className="mt-2 text-center space-y-0.5">
                  <div className="text-[10px] font-semibold text-gray-300">
                    Present QR to Vendor Scanner
                  </div>
                  <div className="text-[9px] text-gray-500 font-mono">
                    Dynamic re-sign: #{reSignCount} (every 10s)
                  </div>
                </div>
              </div>

              {/* Dual Row: Countdown Ring & BLE Radar */}
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-gray-900 rounded-2xl p-2 border border-gray-800 flex flex-col items-center justify-center">
                  <CountdownRing
                    totalSeconds={60}
                    initialSeconds={60}
                    isActive={!isExpired && !settledResult}
                    onExpire={() => setIsExpired(true)}
                    size={80}
                    strokeWidth={5}
                  />
                </div>

                <BleRadar
                  isBroadcasting={!isExpired && !settledResult}
                  stallName={STALL.name}
                />
              </div>
            </div>
          )}

          <div className="pt-1.5 border-t border-gray-800 text-center">
            <span className="text-[9px] text-gray-500 font-mono">
              ECDSA P-256 Airgap Voucher • IS 17428 Pseudonymous
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
