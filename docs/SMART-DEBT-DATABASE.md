# Smart Credit & Debt — ฐานข้อมูล (Database)

Migration: `supabase/migrations/20261116001700_smart_debt.sql` · ทดสอบ: `tests/sql/phase16_test.sql`

## หลักการ

- เงินทุกช่องเป็น **bigint หน่วยย่อย (minor units)** — KRW = วอน, THB = สตางค์ (`kfp_currency_exponent`)
- ทุกตารางมี `user_id → auth.users on delete cascade`, `created_at`, `updated_at` (trigger `touch_kfp_updated_at`)
- ตารางที่แก้ไขได้มี `version` (optimistic concurrency) และ `client_request_id` (unique ต่อผู้ใช้ — กันกดซ้ำ)
- **ไม่เก็บ** เลขบัตรเต็ม / CVV / PIN — เก็บแค่ 4 หลักท้าย (`last4 ~ '^[0-9]{4}$'`)
- ยอดคงเหลือไม่ถูกเก็บเป็นตัวเลขตายตัว — คำนวณจากแถวดิบ (opening + แผนผ่อน + โอน + ปรับยอด − ชำระ) ใน `debt-engine.js`
- Additive + re-runnable: `create … if not exists`, `create or replace`, `drop policy/trigger if exists` — ไม่ลบข้อมูลเดิม

## ตาราง

| ตาราง | ใช้ทำอะไร | ช่องสำคัญ |
|---|---|---|
| `credit_cards` | บัตรเครดิต | currency THB/KRW, last4, credit_limit_minor, opening_balance_minor + opening_date, statement_day, due_day, apr_bp, **installment_mode** (`per_period` = กินวงเงินเฉพาะงวดที่เรียกเก็บ / `full_hold` = กันวงเงินเต็มยอด — เลือกได้ต่อบัตร), status active/archived |
| `installment_plans` | แผนผ่อน (บนบัตร หรือผ่อนร้าน/ไฟแนนซ์เมื่อ `card_id` ว่าง) | original/down/financed (`financed = original − down`), rate_bp, method zero/fixed/reducing/custom, months, first_due_date, monthly/total_payable (คำนวณ), status active/paused/settled/cancelled + status_date, revision, transfer_id |
| `installment_schedules` | งวดผ่อนรายเดือน | plan_id, revision, seq, due_date, principal/interest/fee, amount_minor (ยอดประมาณการ), actual_amount_minor + confirmed_at (ยอดจริงตาม statement), superseded_at (ประวัติ revision เก่า) |
| `debt_transfers` | โอนหนี้ / บัตรจ่ายบัตร / กดเงินสด / ปรับโครงสร้าง | type, from_card_id (หนี้ลดลง), to_card_id (หนี้เพิ่มขึ้น), amount, fee, rate_bp, installments, transfer/effective date, status draft/pending/confirmed/failed/cancelled, fx_rate/fx_source/fx_date, dest_currency/dest_amount_minor |
| `debt_payments` | การชำระ | card_id และ/หรือ plan_id, schedule_id, transfer_id, kind (full/partial/minimum/statement/early/extra_principal/settlement), แยก principal/interest/fee, paid_on, method, status confirmed/cancelled |
| `debt_adjustments` | ปรับยอดบัตร / กระทบยอด statement | kind purchase/interest/fee/refund/reconcile/other, amount (มีเครื่องหมาย), statement_balance_minor (reconcile), status |
| `debt_payoff_plans` | แผนปลดหนี้ที่บันทึกไว้ | strategy snowball/avalanche/custom, budget_minor, priorities/assumptions/result (jsonb ≤ 256 KB) |

## สูตรตารางผ่อน (`kfp_debt_build_schedule` — JS ใน `debt-engine.js` ต้องได้ผลเท่ากัน)

- งวดที่ n ครบกำหนด = `first_due_date + (n−1) เดือน` (วันสิ้นเดือนถูกปัดเป็นวันสุดท้ายของเดือนนั้น)
- **zero** (0%): เงินต้น ÷ n, เศษไปงวดสุดท้าย
- **fixed** (flat rate): ดอกรวม = `round(P × rate/ปี ÷ 12 × n)` แบ่งเท่าๆ กัน, เศษไปงวดสุดท้าย
- **reducing** (ลดต้นลดดอก): ค่างวด = `round(P·r / (1 − (1+r)^−n))`, r = rate/12, ดอกแต่ละงวด = `round(คงเหลือ × r)`, งวดสุดท้ายปิดยอดพอดี
- **custom**: รายการ `[{due_date, amount}]` ตามที่ผู้ใช้กรอก (ไม่มีดอก)
- rate = 0 ในแบบ fixed/reducing → คิดแบบ zero

## Revision / ประวัติ

แก้เงื่อนไขเงิน (ราคา, ดาวน์, ดอก, วิธี, จำนวนงวด, วันเริ่ม, บัตร) → revision +1, แถวเดิมถูก mark `superseded_at` (ไม่ลบ) แล้วสร้างแถวใหม่
แก้แค่ชื่อ/หมวด/ร้าน/โน้ต → revision เดิม

## กติกาไม่นับซ้ำ (no double counting)

- แผนผ่อนบนบัตร **จ่ายผ่านบัตรเท่านั้น** (`plan_on_card`) — ไม่มีการจ่ายแผนตรงซ้ำ
- โอนหนี้มีผลต่อยอดเมื่อ `confirmed` เท่านั้น; ถ้ามีงวด > 0 จะสร้างแผนผ่อนบนบัตรปลายทาง 1 แผน (unique `transfer_id`) — ยอดโอนถูกนับผ่านแผนนั้น ไม่ใช่นับทั้งสองทาง
- ยกเลิกโอนที่ยืนยันแล้ว → สถานะ cancelled + แผนที่เกิดจากมันถูกยกเลิกย้อนถึงวันแรก
- การชำระหนี้ **ไม่สร้างรายจ่าย** ในโมดูลรายจ่ายเดิม

## สิทธิ์ (สรุป — รายละเอียดใน SMART-DEBT-ACCESS-CONTROL.md)

- RLS เปิดทุกตาราง, `authenticated` มีแค่ `SELECT` แถวของตัวเอง (ไม่เช็กแพ็กเกจ → หมดอายุยังดูได้)
- ไม่มี INSERT/UPDATE/DELETE grant ให้เบราว์เซอร์ — เขียนผ่าน RPC `debt_*` เท่านั้น

## ขีดจำกัดต่อผู้ใช้

บัตร 50 · แผนผ่อน 500 · โอน 2,000 · ชำระ 20,000 · ปรับยอด 5,000 · แผนปลดหนี้ 50 · rate limit 600 ครั้ง/ชม.

## Rollback

ปิดฟีเจอร์ (ข้อมูลยังอยู่): `update plans set features = features - 'credit_debt';` แล้วซ่อนจุดเข้าใช้งาน
ถอดทั้งหมด (ลบข้อมูลโมดูลนี้ — ต้องยืนยันกับเจ้าของก่อน): drop RPC `debt_*`, `get_my_debt_access`, `export_my_debt`, `kfp_debt_*` แล้ว drop 7 ตารางตามลำดับ payments → adjustments → schedules → plans → transfers → payoff → cards
