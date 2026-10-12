# RushPay

Zero-bandwidth micropayments for campus food courts (Gazebo, North Square). A student's phone signs a
60-second payment token offline. The stall terminal verifies it in under 300ms with no network, and
the payments are batch-settled to the campus escrow account later.

Standards referenced: IS 19671 / ISO 5201 (code-scanning payment security), IS 17428 (data privacy),
ISO/IEC 27001 (information security).

## Run

```bash
npm install
npm run dev          # development (side-by-side at http://localhost:3000)
npm test             # store + crypto tests
npm run demo         # live demo: build + Bluetooth helper + server (macOS, needs Xcode command line tools)
npm run serve        # serve the last build without Bluetooth
```

| URL | Shows |
|---|---|
| `/` | Student and vendor side by side on one screen (no camera or Bluetooth needed) |
| `/?role=student` | Student UI plus the Bluetooth bridge status (laptop) |
| `/?role=vendor` | Full-screen vendor PoS with rear-camera scanner and Web Bluetooth (Android phone) |
| add `&dev=1` | Also shows the VendorSimulator dock |

## Live demo: laptop (student) + Android phone (vendor), laptop Wi-Fi off

How it works: the laptop shows the payment QR. The phone's rear camera scans it and verifies it on the
phone with no network. The phone then sends the receipt back to the laptop over **Bluetooth LE**: the
laptop runs a small CoreBluetooth helper (`ble-bridge/`) that advertises as `RushPay-Student`, and the
phone connects to it with Web Bluetooth in Chrome.

**Before the demo, with Wi-Fi on (both devices on the same network or a phone hotspot):**

1. Laptop: `npm run demo`. The first time, macOS asks to allow Bluetooth for your terminal app: allow it.
   The terminal prints the student and vendor URLs.
2. Laptop: open `http://localhost:3000/?role=student`. The badge at the bottom left should say
   *Advertising as RushPay-Student*.
3. Phone (Chrome): open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add the address the
   terminal printed (for example `http://172.16.40.154:3000`), set it to **Enabled**, tap **Relaunch**.
   This lets the camera, crypto and Bluetooth run on that page.
4. Phone: turn Bluetooth on, open the vendor URL, tap **Connect student (BLE)**, pick **RushPay-Student**,
   and allow "Nearby devices". The laptop badge turns blue: *Vendor phone connected over Bluetooth LE*.
5. Phone: tap **Start rear-camera scanner** and allow the camera.

**Then go offline:** turn laptop Wi-Fi off and put the phone in airplane mode with Bluetooth turned back
on. Do **not** reload the phone page: it was loaded from the laptop and stays running in memory.

**Demo:** pay on the laptop → point the phone at the QR → six checks, chime, green screen → the laptop
shows PAYMENT SETTLED and ₹320 → ₹240. Then use the phone's **Attacks** tab (replay, tamper, expired)
and **Ledger** tab (tamper row 3, verify chain, Sync & Settle).

**If Bluetooth drops on stage:** the phone retries automatically, and you can tap Connect again. If
the link is lost completely, the phone still verifies payments; only the laptop's receipt is missed.

## Who owns what

Only edit your own files. `lib/types.ts` is the shared contract; change it only after telling everyone.

| Member | Files |
|---|---|
| A1 Crypto | `lib/types.ts`, `lib/crypto.ts`, `lib/issuerKeys.ts`, `scripts/gen-issuer-keys.ts`, `scripts/test-crypto.ts` |
| A2 State & settlement | `lib/store.ts`, `lib/chime.ts`, `lib/mockData.ts`, `scripts/test-store.ts` |
| B Student UI | `app/components/StudentView.tsx`, `CountdownRing.tsx`, `BleRadar.tsx` |
| C Vendor UI | `app/components/VendorView.tsx`, `ScannerZone.tsx`, `VerifyConsole.tsx`, `SuccessModal.tsx`, `AttackPanel.tsx`, `Ledger.tsx`, `BleBridgeLink.tsx`, `app/page.tsx`, `lib/bleLink.ts`, `ble-bridge/` |
| D Pitch & compliance | `docs/` |

Work on a branch per member (`a1/crypto`, `a2/store`, `b/student-ui`, `c/vendor-ui`, `d/docs`) and open a PR into `main`.
