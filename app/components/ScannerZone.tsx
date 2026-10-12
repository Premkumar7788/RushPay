'use client';

// Rear-camera QR scanner using the browser's built-in BarcodeDetector (Chrome on Android; no library,
// works offline). Falls back to pasting the token when the camera or detector is unavailable.
import React, { useCallback, useEffect, useRef, useState } from 'react';

interface DetectedBarcode { rawValue: string }
interface BarcodeDetectorLike { detect(source: HTMLVideoElement): Promise<DetectedBarcode[]> }
type BarcodeDetectorCtor = new (opts: { formats: string[] }) => BarcodeDetectorLike;

type Props = {
  /** Scanning runs only while true; the parent pauses it after each result. */
  active: boolean;
  onScan: (text: string) => void;
  /** Called from the Start tap, e.g. to unlock audio. */
  onStart?: () => void;
};

const SCAN_INTERVAL_MS = 120;

export function ScannerZone({ active, onScan, onStart }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<BarcodeDetectorLike | null>(null);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  const [cameraOn, setCameraOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPaste, setShowPaste] = useState(false);
  const [pasted, setPasted] = useState('');

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  }, []);

  const startCamera = async () => {
    onStart?.();
    setError(null);
    const Detector = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
    if (!Detector) {
      setError('This browser has no built-in QR detector. Use Chrome on Android, or paste the token below.');
      setShowPaste(true);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera needs a secure page. Add this address in chrome://flags/#unsafely-treat-insecure-origin-as-secure');
      setShowPaste(true);
      return;
    }
    try {
      detectorRef.current = new Detector({ formats: ['qr_code'] });
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      // Continuous autofocus where supported (most Android rear cameras).
      track?.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => {});
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraOn(true);
    } catch (e) {
      const name = (e as Error).name;
      setError(name === 'NotAllowedError' ? 'Camera permission denied. Allow it in Chrome site settings.' : `Camera error: ${(e as Error).message}`);
      setShowPaste(true);
    }
  };

  // Detection loop
  useEffect(() => {
    if (!cameraOn || !active) return;
    let stopped = false;
    let busy = false;
    const id = setInterval(async () => {
      const video = videoRef.current;
      const detector = detectorRef.current;
      if (stopped || busy || !video || !detector || video.readyState < 2) return;
      busy = true;
      try {
        const codes = await detector.detect(video);
        const hit = codes.find((c) => c.rawValue);
        if (hit && !stopped) {
          stopped = true;
          navigator.vibrate?.(40);
          onScanRef.current(hit.rawValue);
        }
      } catch {
        /* frame not ready */
      } finally {
        busy = false;
      }
    }, SCAN_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [cameraOn, active]);

  useEffect(() => stopCamera, [stopCamera]);

  return (
    <div className="space-y-2">
      <div className="relative aspect-square w-full overflow-hidden rounded-3xl border border-gray-800 bg-black">
        <video ref={videoRef} playsInline muted className={`h-full w-full object-cover ${cameraOn ? '' : 'hidden'}`} />

        {cameraOn ? (
          <>
            {/* Aiming reticle */}
            <div className="pointer-events-none absolute inset-[12%]">
              {['left-0 top-0 border-l-4 border-t-4 rounded-tl-2xl', 'right-0 top-0 border-r-4 border-t-4 rounded-tr-2xl',
                'left-0 bottom-0 border-l-4 border-b-4 rounded-bl-2xl', 'right-0 bottom-0 border-r-4 border-b-4 rounded-br-2xl',
              ].map((c) => (
                <span key={c} className={`absolute h-10 w-10 ${active ? 'border-emerald-400' : 'border-gray-500'} ${c}`} />
              ))}
              {active && <span className="rp-laser absolute left-2 right-2 h-0.5 bg-emerald-400 shadow-[0_0_12px_2px_rgba(52,211,153,0.8)]" />}
            </div>
            <div className="absolute bottom-2 left-0 right-0 text-center text-[11px] font-semibold text-white/90 drop-shadow">
              {active ? 'Point at the student’s QR code' : 'Paused'}
            </div>
            <button
              onClick={stopCamera}
              className="absolute right-2 top-2 rounded-full bg-black/60 px-2.5 py-1 text-[10px] font-bold text-white"
            >
              Stop
            </button>
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <div className="text-4xl">📷</div>
            <button
              onClick={() => void startCamera()}
              className="rounded-2xl bg-emerald-500 px-5 py-3 text-sm font-black text-black shadow-lg shadow-emerald-500/20 active:scale-95"
            >
              Start rear-camera scanner
            </button>
            <p className="text-[11px] text-gray-400">Verification runs on this phone. No network needed.</p>
          </div>
        )}
      </div>

      {error && <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-200">{error}</p>}

      <button onClick={() => setShowPaste((s) => !s)} className="text-[11px] font-semibold text-gray-400 underline">
        {showPaste ? 'Hide manual entry' : 'Paste token manually'}
      </button>
      {showPaste && (
        <div className="space-y-1.5">
          <textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder="rp1.…"
            rows={3}
            className="w-full rounded-xl border border-gray-800 bg-gray-900 p-2 font-mono text-[10px] text-gray-200"
          />
          <button
            disabled={!pasted.trim()}
            onClick={() => {
              onScanRef.current(pasted.trim());
              setPasted('');
            }}
            className="w-full rounded-xl bg-gray-800 py-2 text-xs font-bold text-white disabled:opacity-40"
          >
            Verify pasted token
          </button>
        </div>
      )}

      <style>{`
        .rp-laser { animation: rp-sweep 1.8s ease-in-out infinite alternate; }
        @keyframes rp-sweep { from { top: 4%; } to { top: 96%; } }
      `}</style>
    </div>
  );
}
