# RushPay: algorithms used

Everything listed here runs in the current code. File references point to where each algorithm lives.

## 1. Cryptography (`lib/crypto.ts`, browser Web Crypto: `crypto.subtle`)

| Algorithm | Used for | Details |
|---|---|---|
| **ECDSA on NIST P-256 (secp256r1) with SHA-256** | Signing and verifying payments | Two levels: the campus escrow (issuer) signs the student's **voucher**; the student's **phone** signs each **payment**. About 128-bit security. Vendors can verify but cannot forge. |
| **SHA-256** | Pseudonymous student ID, ledger hash chain, token fingerprint | `studentHash = SHA-256("rushpay:" + regNo + ":" + salt)`, truncated to 16 hex characters. The registration number never leaves the phone. |
| **Cryptographically secure random numbers** (`crypto.getRandomValues`) | Nonces, salts, voucher serials | 128-bit nonce per payment, 128-bit salt, 48-bit voucher serial |
| **Canonical JSON** | Input to every signature | Fixed field order so signer and verifier hash identical bytes |
| **Base64url** (no padding) | Token encoding | `rp1.<payload>.<signature>.<voucher>`, about 768 characters |

Payment payload (signed): `orderId, amount, items, timestamp, nonce, studentHash`.

## 2. Verification: the six checks (`verifyToken`)

Always run in this order; all six results are returned for the vendor console.

| # | Check | Algorithm | Fails with |
|---|---|---|---|
| 1 | Escrow voucher | ECDSA verify with the issuer public key, expiry check, payer match | `INVALID_VOUCHER` |
| 2 | Payment signature | ECDSA verify with the device public key from the voucher | `SIGNATURE_MISMATCH` |
| 3 | Freshness (IS 19671) | `0 ≤ now − timestamp ≤ 60 s`, 5 s clock-skew allowance | `EXPIRED` |
| 4 | Anti-replay (IS 19671) | Nonce cache: set membership, each nonce accepted once | `REPLAY` |
| 5 | Amount bounds | Integer, > 0, ≤ ₹500 per transaction, ≤ voucher limit | `AMOUNT_OUT_OF_BOUNDS` |
| 6 | PII minimisation (IS 17428) | Field allow-list (exactly 6 fields), hex-only identifiers, regex detectors for phone numbers, UPI VPAs and registration numbers, menu-id-only `items` | `PII_LEAK` |

Measured verification time: about 0.4 ms on a laptop (target < 300 ms).

## 3. Ledger and settlement (`lib/store.ts`)

| Algorithm | What it does |
|---|---|
| **Hash chain** | `rowHash = SHA-256(prevHash + canonical row fields)`. Editing any row breaks the chain from that row on (tamper-evident audit log, ISO/IEC 27001). |
| **Double-spend detection** | Merge all terminals' rows, sort by timestamp, accept first come first served. Track cumulative spend per voucher and a set of seen nonces; a row is `DOUBLE_SPEND` if it exceeds the voucher limit or repeats a nonce. |
| **Idempotent debit** | A student is charged at most once per order ID, even if the receipt arrives twice. |
| **Serialised appends** | Ledger writes are queued so concurrent appends cannot fork the chain. |

## 4. Communication

| Algorithm / protocol | Where |
|---|---|
| **QR code with Reed–Solomon error correction** (level L) | Student's dynamic QR, re-signed every 10 s with the same nonce |
| **QR detection** (browser `BarcodeDetector`) | Vendor phone rear camera, about 8 frames per second |
| **Bluetooth LE GATT** (write, long read with offset, notify; MTU 512) | Receipt from vendor phone to student laptop (`lib/bleLink.ts`, `ble-bridge/`) |
| **Reconnect with linear backoff** | 8 attempts, 0.5 s × attempt, capped at 3 s |
| **BroadcastChannel publish/subscribe** | Two screens in the same browser |
| **Server-Sent Events** | BLE bridge to student page |

## What RushPay does not use

- **No HMAC.** The original brief proposed HMAC-SHA256; it was replaced with ECDSA because a shared secret would let vendors forge payments.
- **No encryption.** Tokens are signed, not encrypted: anyone can read them, which is acceptable because they contain only a pseudonymous hash, menu items and the amount. Local device storage is also not encrypted. Describe the system as **tamper-evident, not encrypted**; encrypting storage (for example AES-GCM) is a production step.
