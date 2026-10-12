/**
 * Vendor-side Bluetooth LE link (Web Bluetooth, Chrome on Android/desktop).
 * Connects to the student laptop's "RushPay-Student" peripheral (ble-bridge/RushPayPeripheral.swift).
 *
 *   await bleLink.connect();                  // must run inside a tap handler (device chooser)
 *   await bleLink.sendAck({ type: 'PAYMENT_ACK', ... });
 *   bleLink.onToken((token) => ...);          // tap-free mode: student's current token over BLE
 *   const s = useBleState();                  // React: { state, deviceName, error }
 *
 * Web Bluetooth only works in a secure context (https or localhost, or an origin allow-listed in
 * chrome://flags/#unsafely-treat-insecure-origin-as-secure).
 */
import { useSyncExternalStore } from 'react';
import type { ChannelMessage } from '@/lib/types';

// Must match ble-bridge/RushPayPeripheral.swift (Web Bluetooth wants lowercase).
export const BLE_SERVICE = 'b5e3f0a0-6d1c-4e8a-9a5e-7275736870a1';
const ACK_CHAR = 'b5e3f0a1-6d1c-4e8a-9a5e-7275736870a1';
const TOKEN_CHAR = 'b5e3f0a2-6d1c-4e8a-9a5e-7275736870a1';
const TOKEN_VERSION_CHAR = 'b5e3f0a3-6d1c-4e8a-9a5e-7275736870a1';

// Minimal Web Bluetooth types (not in TypeScript's DOM lib).
interface BTCharacteristic extends EventTarget {
  value?: DataView;
  readValue(): Promise<DataView>;
  writeValueWithResponse?(value: BufferSource): Promise<void>;
  writeValue(value: BufferSource): Promise<void>;
  startNotifications(): Promise<BTCharacteristic>;
}
interface BTService {
  getCharacteristic(uuid: string): Promise<BTCharacteristic>;
}
interface BTServer {
  connected: boolean;
  connect(): Promise<BTServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<BTService>;
}
interface BTDevice extends EventTarget {
  id: string;
  name?: string;
  gatt?: BTServer;
}
interface BTBluetooth {
  requestDevice(options: { filters: { services?: string[]; namePrefix?: string }[]; optionalServices?: string[] }): Promise<BTDevice>;
}

export type BleConnState = 'unsupported' | 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
export type BleSnapshot = { state: BleConnState; deviceName: string | null; error: string | null };

const MAX_RECONNECT_ATTEMPTS = 8;

class BleLink {
  private snap: BleSnapshot = { state: 'disconnected', deviceName: null, error: null };
  private listeners = new Set<() => void>();
  private tokenListeners = new Set<(token: string) => void>();
  private device: BTDevice | null = null;
  private ack: BTCharacteristic | null = null;
  private token: BTCharacteristic | null = null;
  private manualDisconnect = false;
  private writeQueue: Promise<unknown> = Promise.resolve();

  private bluetooth(): BTBluetooth | null {
    if (typeof navigator === 'undefined') return null;
    return (navigator as unknown as { bluetooth?: BTBluetooth }).bluetooth ?? null;
  }

  isSupported(): boolean {
    return this.bluetooth() !== null && typeof window !== 'undefined' && window.isSecureContext;
  }

  private set(patch: Partial<BleSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
  }

  private unsupportedSnap: BleSnapshot | null = null;

  // Must return a stable object between changes (useSyncExternalStore).
  getSnapshot = (): BleSnapshot => {
    if (this.snap.state === 'disconnected' && typeof window !== 'undefined' && !this.isSupported()) {
      return (this.unsupportedSnap ??= { state: 'unsupported', deviceName: null, error: unsupportedReason() });
    }
    return this.snap;
  };

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  };

  onToken(cb: (token: string) => void): () => void {
    this.tokenListeners.add(cb);
    return () => void this.tokenListeners.delete(cb);
  }

  /** Opens Chrome's device chooser. Call from a click/tap handler. */
  async connect(): Promise<void> {
    const bt = this.bluetooth();
    if (!bt || !this.isSupported()) {
      this.set({ state: 'unsupported', error: unsupportedReason() });
      return;
    }
    this.manualDisconnect = false;
    this.set({ state: 'connecting', error: null });
    try {
      const device = await bt.requestDevice({
        filters: [{ services: [BLE_SERVICE] }, { namePrefix: 'RushPay' }],
        optionalServices: [BLE_SERVICE],
      });
      if (this.device && this.device !== device) this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
      this.device = device;
      device.addEventListener('gattserverdisconnected', this.onDisconnected);
      await this.setup();
    } catch (e) {
      const msg = (e as Error).message || String(e);
      const cancelled = /cancel/i.test(msg) || (e as Error).name === 'NotFoundError';
      this.set({ state: 'disconnected', error: cancelled ? null : msg });
    }
  }

  disconnect(): void {
    this.manualDisconnect = true;
    this.device?.gatt?.disconnect();
    this.ack = this.token = null;
    this.set({ state: 'disconnected', error: null });
  }

  private async setup(): Promise<void> {
    const gatt = this.device?.gatt;
    if (!gatt) throw new Error('Device has no GATT server');
    const server = await gatt.connect();
    const service = await server.getPrimaryService(BLE_SERVICE);
    this.ack = await service.getCharacteristic(ACK_CHAR);
    this.token = await service.getCharacteristic(TOKEN_CHAR);
    const version = await service.getCharacteristic(TOKEN_VERSION_CHAR);
    version.addEventListener('characteristicvaluechanged', this.onTokenVersion);
    await version.startNotifications(); // also tells the laptop we're connected
    this.set({ state: 'connected', deviceName: this.device?.name ?? 'RushPay-Student', error: null });
  }

  private onTokenVersion = async () => {
    if (!this.token || this.tokenListeners.size === 0) return;
    try {
      const view = await this.enqueue(() => this.token!.readValue());
      const text = new TextDecoder().decode(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
      if (text.startsWith('rp1.')) this.tokenListeners.forEach((cb) => cb(text));
    } catch {
      /* transient read failure; the next version bump retries */
    }
  };

  private onDisconnected = async () => {
    this.ack = this.token = null;
    if (this.manualDisconnect) return;
    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
      this.set({ state: 'reconnecting', error: `Link lost, reconnecting (${attempt}/${MAX_RECONNECT_ATTEMPTS})…` });
      await new Promise((r) => setTimeout(r, Math.min(500 * attempt, 3000)));
      if (this.manualDisconnect) return;
      try {
        await this.setup();
        return;
      } catch {
        /* retry */
      }
    }
    this.set({ state: 'disconnected', error: 'Bluetooth link lost. Tap Connect to pair again.' });
  };

  // GATT allows one operation at a time; serialise reads and writes.
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const p = this.writeQueue.then(op, op);
    this.writeQueue = p.catch(() => {});
    return p;
  }

  /** Sends a PAYMENT_ACK to the student laptop. Resolves false if not connected or the write failed. */
  async sendAck(msg: Extract<ChannelMessage, { type: 'PAYMENT_ACK' }>): Promise<boolean> {
    const ack = this.ack;
    if (!ack || this.snap.state !== 'connected') return false;
    const bytes = new TextEncoder().encode(JSON.stringify(msg));
    try {
      await this.enqueue(() => (ack.writeValueWithResponse ? ack.writeValueWithResponse(bytes) : ack.writeValue(bytes)));
      return true;
    } catch {
      return false;
    }
  }
}

function unsupportedReason(): string {
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return 'Page is not a secure context. Add this address in chrome://flags/#unsafely-treat-insecure-origin-as-secure';
  }
  return 'Web Bluetooth is not available. Use Chrome on Android with Bluetooth on.';
}

export const bleLink = new BleLink();

const SERVER_SNAPSHOT: BleSnapshot = { state: 'disconnected', deviceName: null, error: null };

export function useBleState(): BleSnapshot {
  return useSyncExternalStore(bleLink.subscribe, bleLink.getSnapshot, () => SERVER_SNAPSHOT);
}
