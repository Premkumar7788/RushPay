'use client';

import React, { useEffect, useState } from 'react';

interface CountdownRingProps {
  totalSeconds?: number;
  initialSeconds?: number;
  isActive: boolean;
  onExpire?: () => void;
  /** Change this to restart the countdown from initialSeconds (e.g. a regenerated QR). */
  resetKey?: number | string;
  size?: number;
  strokeWidth?: number;
}

export const CountdownRing: React.FC<CountdownRingProps> = ({
  totalSeconds = 60,
  initialSeconds = 60,
  isActive,
  onExpire,
  resetKey,
  size = 110,
  strokeWidth = 7,
}) => {
  const [secondsRemaining, setSecondsRemaining] = useState(initialSeconds);

  // Reset during render (not in an effect) so the expiry effect below never sees the stale 0
  // in the same commit that re-activates the ring.
  const [seenResetKey, setSeenResetKey] = useState(resetKey);
  if (seenResetKey !== resetKey) {
    setSeenResetKey(resetKey);
    setSecondsRemaining(initialSeconds);
  }

  useEffect(() => {
    setSecondsRemaining(initialSeconds);
  }, [initialSeconds]);

  useEffect(() => {
    if (!isActive) return;

    if (secondsRemaining <= 0) {
      if (onExpire) onExpire();
      return;
    }

    const timer = setInterval(() => {
      setSecondsRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          if (onExpire) onExpire();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [isActive, secondsRemaining, onExpire]);

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const progressRatio = Math.max(0, Math.min(1, secondsRemaining / totalSeconds));
  const strokeDashoffset = circumference - progressRatio * circumference;

  let strokeColor = '#10b981'; // emerald-500
  let badgeColor = 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20';

  if (secondsRemaining <= 10) {
    strokeColor = '#ef4444'; // red-500
    badgeColor = 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20';
  } else if (secondsRemaining <= 30) {
    strokeColor = '#f59e0b'; // amber-500
    badgeColor = 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20';
  }

  // Text scales with the ring so it always sits inside the stroke.
  const numberPx = Math.round(size * 0.3);
  const unitPx = Math.round(size * 0.16);

  return (
    <div className="flex flex-col items-center gap-1.5 select-none">
      {/* The overlay is positioned over the ring only (not the label/badge below), so it centres correctly. */}
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke="currentColor"
            strokeWidth={strokeWidth}
            className="text-gray-200 dark:text-gray-800"
            fill="transparent"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke={strokeColor}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            fill="transparent"
            style={{ transition: 'stroke-dashoffset 1s linear, stroke 0.4s ease' }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span
            className="font-mono font-black leading-none tabular-nums transition-colors"
            style={{ color: strokeColor, fontSize: numberPx }}
          >
            {String(secondsRemaining).padStart(2, '0')}
            <span style={{ fontSize: unitPx }}>s</span>
          </span>
        </div>
      </div>

      <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">TTL window</span>

      <div className={`whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[9px] font-medium ${badgeColor}`}>
        IS 19671: Δt ≤ 60s
      </div>
    </div>
  );
};
