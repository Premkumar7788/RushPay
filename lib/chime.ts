// Audio feedback via Web Audio API (no asset files, works offline).
// The AudioContext is created on first call, which must follow a user gesture (browser autoplay policy).

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function tone(ac: AudioContext, freq: number, start: number, dur: number, type: OscillatorType, peak: number) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

/** Call from a tap handler (e.g. "Start scanner") so later chimes can play on mobile browsers. */
export function unlockAudio(): void {
  const ac = audio();
  if (ac) tone(ac, 440, ac.currentTime, 0.02, 'sine', 0.0002);
}

/** Success: a bright two-note bell (~400ms). */
export function playChime(): void {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime;
  tone(ac, 880, t, 0.25, 'sine', 0.3);
  tone(ac, 1318.5, t + 0.12, 0.3, 'sine', 0.3);
}

/** Attack blocked: three harsh low pulses (~600ms). */
export function playAlarm(): void {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime;
  for (let i = 0; i < 3; i++) tone(ac, 220, t + i * 0.2, 0.15, 'square', 0.2);
}
