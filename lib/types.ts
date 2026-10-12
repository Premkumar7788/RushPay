// SHARED CONTRACT between all tracks. Owner: Member A1. Change only after telling A2, B and C.
export const TTL_MS = 60_000;          // IS 19671: 60-second token time-to-live
export const TXN_CAP = 500;            // ₹ per-transaction cap (verify current RBI limit)

export type PaymentPayload = {
  orderId: string; amount: number; timestamp: number; nonce: string; studentHash: string;
};
export type Voucher = {
  serial: string; studentHash: string; devicePubKey: JsonWebKey; limit: number; expiresAt: number;
};
export type SignedVoucher = { voucher: Voucher; issuerSig: string };
export type WalletSecrets = {
  regNoNeverTransmitted: string; studentHash: string;
  devicePrivKey: JsonWebKey; signedVoucher: SignedVoucher;
};
export type PaymentToken = string; // "rp1.<b64url payload>.<b64url sig>.<b64url signedVoucher>"

export type CheckName = 'VOUCHER' | 'SIGNATURE' | 'FRESHNESS' | 'NONCE' | 'AMOUNT' | 'PII';
export type Check = { name: CheckName; label: string; ok: boolean; detail: string };
export type VerifyResult = {
  ok: boolean; checks: Check[]; elapsedMs: number;
  payload?: PaymentPayload; voucherSerial?: string; voucherLimit?: number; reason?: string;
};

export type ChannelMessage =
  | { type: 'PAYMENT_TOKEN'; token: PaymentToken; sentAt: number }
  | { type: 'PAYMENT_ACK'; orderId: string; nonce: string; amount: number; ok: boolean; reason?: string };

export type LedgerStatus = 'BUFFERED' | 'CLEARED' | 'DOUBLE_SPEND';
export type LedgerRow = {
  index: number; orderId: string; amount: number; timestamp: number; nonce: string;
  voucherSerial: string; voucherLimit: number; tokenHash: string;
  prevHash: string; rowHash: string; status: LedgerStatus;
};
