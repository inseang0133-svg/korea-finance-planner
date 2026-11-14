# Korea Finance Planner · Test Matrix (PART 13 — 30 required tests)

รันทั้งหมด: `PGHOST=… PGPORT=… PGUSER=postgres tests/run-all.sh --scale` (ผลล่าสุด 14/11/2026: **ALL GREEN**)

| ชุด | ไฟล์ | ผล |
|---|---|---|
| SQL (Postgres 16 + stub ของ Supabase) | `tests/sql/phase{2,5,6,7,8,9,10,11,12}_test.sql` | ✅ 9 ชุด |
| Edge Functions (Stripe จำลอง + Postgres จริง) | `tests/edge/billing.test.ts` | ✅ 96/96 |
| TypeScript Edge Functions | `tests/ts/tsconfig.json` | ✅ |
| Static security audit | `tests/security/static-audit.js` | ✅ 38 ผ่าน · 1 เตือน (SRI) |
| Browser e2e (Chromium, Supabase จำลอง) | `tests/e2e/phase{2..12}.test.js` | ✅ 455/455 |
| ติดตั้งบนฐานข้อมูลว่าง (+ บัญชีเดิม) | `tests/run-fresh-install.sh` | ✅ 18 ตาราง · ข้อมูลเดิมครบ · findings 0 |
| Scale 100 → 50,000 สมาชิก | `tests/sql/scale_bench.sql` | ✅ (ตารางใน SECURITY_AUDIT §3) |

สัญลักษณ์: **อัตโนมัติ** = มีเทสต์รันได้ทุกครั้ง · **staging** = ต้องทำบนบริการจริงตาม checklist (เครื่องทดสอบไม่มีบัญชี Supabase/Stripe/อีเมลจริง)

| # | ต้องทดสอบ | อัตโนมัติ (ไฟล์ › กลุ่ม) | staging (checklist) |
|---|---|---|---|
| 1 | Guest เปิดเว็บไซต์ | e2e Phase 2 › T1 · Phase 3 › P1 | — |
| 2 | Guest ดูทุกหน้า | e2e Phase 12 › X2 (6 หน้า ไม่มี error) · Phase 3 › P10 · Phase 5 › V1, V9 | — |
| 3 | Guest เปิด Gold Preview | e2e Phase 3 › P10 · Phase 4 › G7 · Phase 9 › G1 | — |
| 4 | Guest กดปุ่ม Action แล้วเจอ Login Modal | e2e Phase 4 › G1–G7, G11 · Phase 7 › K1 · Phase 8 › B1 | — |
| 5 | Guest ไม่สามารถบันทึกข้อมูลจริง | e2e Phase 3 › P2, P3 · Phase 12 › X2 (0 การเขียน) · SQL Phase 12 › S3 (anon) | — |
| 6 | Register ด้วย Email จริง | e2e Phase 2 › T2 | SETUP Phase 2 (SMTP จริง) |
| 7 | Email Verification | e2e Phase 2 › T3, T12 (auth-callback) | SETUP Phase 2 · GO_LIVE ข้อ 1 |
| 8 | Login | e2e Phase 2 › T4, T6, T7 · Phase 4 › G9, G10 | SETUP Phase 2 |
| 9 | Logout | e2e Phase 3 › P6 · Phase 12 › X4 (ลบออกจากเครื่อง) | — |
| 10 | Forgot Password | e2e Phase 2 › T10 | SETUP Phase 2 |
| 11 | Reset Password | e2e Phase 2 › T12 · T5 (เปลี่ยนรหัส) | SETUP Phase 2 |
| 12 | Free Plan Visibility | e2e Phase 5 › V2 · SQL Phase 5 | — |
| 13 | Plus Plan Visibility | e2e Phase 5 › V3 · SQL Phase 5 | — |
| 14 | Premium Plan Visibility | e2e Phase 5 › V4 · Phase 9 › G2 | — |
| 15 | Direct URL Protection | e2e Phase 5 › V2/V3 (`gold.html` → หน้าอัปเกรด) · Phase 10 › A1, A2 (`admin.html`) · Phase 8 › B1 · SQL Phase 9/10 (server ปฏิเสธ) | — |
| 16 | Stripe Checkout | Edge › C1–C5 · e2e Phase 7 › K2–K7 | SETUP Phase 7 ข้อ 1, 10 |
| 17 | Successful Payment | Edge › W2, W3 · SQL Phase 7 › T2, T4 · e2e Phase 7 › K8 | SETUP Phase 7 ข้อ 1 |
| 18 | Failed Payment | Edge › W4 · SQL Phase 7 › T5 · e2e Phase 8 › B5 | SETUP Phase 7 ข้อ 5, 6 |
| 19 | Subscription Cancellation | Edge › A1, M1 · SQL Phase 7 › T6 · e2e Phase 8 › B4 | SETUP Phase 8 ข้อ 13 |
| 20 | Subscription Expiration | SQL Phase 5 (period end, grace, unpaid) · Phase 7 › T5, T6 · Phase 9 › T5 | Stripe Test clock (SETUP Phase 7 ข้อ 5) |
| 21 | Upgrade | Edge › P1, W5 · e2e Phase 7 › K5 · Phase 8 › B3 | SETUP Phase 8 ข้อ 12 |
| 22 | Downgrade | Edge › P1 · e2e Phase 8 › B7 | SETUP Phase 8 ข้อ 12 |
| 23 | Admin Authorization | SQL Phase 10 › T1, T6, T8 · Phase 12 › S2, S4 · Edge › M1 · e2e Phase 10 › A1, A2, A7, A8 · Phase 12 › X3 | SETUP Phase 10 ข้อ 1, 2 |
| 24 | Admin User Management | SQL Phase 10 › T4–T6 · e2e Phase 10 › A4, A5 | SETUP Phase 10 ข้อ 3, 4 |
| 25 | User Activity | SQL Phase 11 › T1–T4 · e2e Phase 6 › A2 · Phase 11 › F1–F3 | SETUP Phase 11 ข้อ 4 |
| 26 | Gold Cloud Sync | SQL Phase 9 › T2–T4 · e2e Phase 9 › G2, G3, G8, G10 | SETUP Phase 9 ข้อ 1, 2 |
| 27 | Cross-device Sync | e2e Phase 9 › G4–G7 (ชนกัน → ให้เลือก) · Phase 3 › P5 | SETUP Phase 9 ข้อ 3, 4 |
| 28 | Existing Account Migration | SQL Phase 2 · e2e Phase 2 › T7–T9 · Phase 3 › P8 · SQL Phase 9 › T1 (ทองจาก user_data) | SETUP Phase 2 ข้อ 5 |
| 29 | Existing Data Preservation | e2e Phase 3 › P2, P6, P8, P9 · Phase 12 › X7 (Export หลังหมดอายุ), X8 (กู้คืนทอง) · SQL Phase 9 › T1, T5 · Phase 10 › T6 · Phase 12 › S7 · fresh install | GO_LIVE ข้อ 2 (backup) |
| 30 | Mobile Responsiveness | e2e Phase 3 › P12 · Phase 5 › V10 · Phase 7 › K9 · Phase 8 › B10 · Phase 9 › G12 · Phase 10 › A9 · Phase 11 › F4 | iOS Safari / Android Chrome จริง (GO_LIVE ข้อ 9) |

เพิ่มเติมจาก PART 12 (ความปลอดภัย): SQL Phase 12 › S1–S6 · e2e Phase 12 › X1–X6 · static audit — รายละเอียดใน `docs/SECURITY_AUDIT.md`
