# RushPay

Zero-bandwidth micropayments for campus food courts (Gazebo, North Square). A student's phone signs a
60-second payment token offline. The stall terminal verifies it in under 300ms with no network, and
the payments are batch-settled to the campus escrow account later.

Standards referenced: IS 19671 / ISO 5201 (code-scanning payment security), IS 17428 (data privacy),
ISO/IEC 27001 (information security).

## Run

```bash
npm install
npm run dev          # development
npm test             # store + crypto tests
npm run build && npm run serve   # static build, use this for the live demo (works offline)
```

Open `/` for side-by-side, or `/?role=student` and `/?role=vendor` in two windows.

## Who owns what

Only edit your own files. `lib/types.ts` is the shared contract; change it only after telling everyone.

| Member | Files |
|---|---|
| A1 Crypto | `lib/types.ts`, `lib/crypto.ts`, `lib/issuerKeys.ts`, `scripts/gen-issuer-keys.ts`, `scripts/test-crypto.ts` |
| A2 State & settlement | `lib/store.ts`, `lib/chime.ts`, `lib/mockData.ts`, `scripts/test-store.ts` |
| B Student UI | `app/components/StudentView.tsx`, `CountdownRing.tsx`, `BleRadar.tsx` |
| C Vendor UI | `app/components/VendorView.tsx`, `VerifyConsole.tsx`, `SuccessModal.tsx`, `AttackPanel.tsx`, `Ledger.tsx`, `app/page.tsx` |
| D Pitch & compliance | `docs/` |

Work on a branch per member (`a1/crypto`, `a2/store`, `b/student-ui`, `c/vendor-ui`, `d/docs`) and open a PR into `main`.
