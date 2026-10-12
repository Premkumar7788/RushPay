'use client';

import React from 'react';

interface BleRadarProps {
  isBroadcasting: boolean;
  stallName?: string;
  rssi?: number;
}

export const BleRadar: React.FC<BleRadarProps> = ({
  isBroadcasting,
  stallName = 'Gazebo Stall #4',
  rssi = -54,
}) => {
  return (
    <div className="flex flex-col items-center justify-center p-3 rounded-2xl bg-gray-900 text-white border border-gray-800 shadow-inner overflow-hidden relative">
      {/* Radar ripple container */}
      <div className="relative w-20 h-20 flex items-center justify-center my-1">
        {/* Animated concentric rings */}
        {isBroadcasting && (
          <>
            <span className="absolute w-16 h-16 rounded-full border border-emerald-500/40 animate-ping" />
            <span
              className="absolute w-12 h-12 rounded-full border border-emerald-400/50 animate-ping"
              style={{ animationDuration: '2s' }}
            />
          </>
        )}

        {/* Static grid guide rings */}
        <div className="absolute w-20 h-20 rounded-full border border-dashed border-gray-700/60" />
        <div className="absolute w-12 h-12 rounded-full border border-gray-800" />

        {/* Center transmitter beacon */}
        <div
          className={`relative z-10 w-9 h-9 rounded-full flex items-center justify-center shadow-lg transition-colors ${
            isBroadcasting
              ? 'bg-gradient-to-tr from-emerald-600 to-teal-400 text-white shadow-emerald-500/50'
              : 'bg-gray-800 text-gray-400'
          }`}
        >
          {/* Radio / Bluetooth SVG icon */}
          <svg
            className={`w-4 h-4 ${isBroadcasting ? 'animate-pulse' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.14 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0"
            />
          </svg>
        </div>
      </div>

      {/* Radar status information */}
      <div className="z-10 text-center space-y-0.5">
        <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 text-[10px] font-semibold">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
          Proximity Beacon Broadcasting
        </div>

        <div className="text-[11px] font-mono text-gray-300 flex items-center justify-center gap-1.5">
          <span>Target: <strong className="text-white">{stallName}</strong></span>
          <span className="text-gray-500">|</span>
          <span className="text-emerald-400">{rssi} dBm</span>
        </div>

        <div className="text-[9px] text-gray-400 font-mono">
          Channel: <span className="text-gray-300">rushpay-ble</span> • Airgap Proximity
        </div>
      </div>
    </div>
  );
};
