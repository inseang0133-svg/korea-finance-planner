# Smart Credit & Debt — การควบคุมสิทธิ์ (Access control)

## โหมดการใช้งาน (คำนวณที่ server ใน `get_my_debt_access()`)

| โหมด | เงื่อนไข | ผู้ใช้เห็นอะไร |
|---|---|---|
| `full` | `kfp_has_feature(uid,'credit_debt')` = true — Finance Premium ที่ยังใช้งานได้ (รวมยกเลิกแล้วแต่ยังอยู่ในรอบที่จ่าย, ชำระไม่ผ่านแต่อยู่ในช่วงผ่อนผัน, staff ที่ได้ Premium) | ใช้ได้ทุกอย่าง |
| `read_only` | ไม่มีสิทธิ์ แต่มีข้อมูลเดิม (หมดอายุ / ลดแพ็กเกจ / ถูกระงับบัญชี) | ดูข้อมูลทั้งหมด, ปฏิทิน, กราฟ, export ได้ · ปุ่มเพิ่ม/แก้/ลบ ถูกปิด + แบนเนอร์ "ต่ออายุ Premium" |
| `locked` | ไม่มีสิทธิ์และไม่มีข้อมูล (Free / Plus ที่ไม่เคยใช้) | หน้าแนะนำ + ตัวอย่างข้อมูลสาธิต (demo) + ปุ่มอัปเกรด |
| `guest` | ยังไม่ล็อกอิน | หน้าแนะนำ + ให้เข้าสู่ระบบ |

โหมดนี้ใช้ **แสดงผลเท่านั้น** — การบังคับสิทธิ์จริงอยู่ที่ฐานข้อมูล ไม่เชื่อสถานะ Premium จากฝั่ง client

## ชั้นการป้องกัน

1. **RLS SELECT own** ทุกตาราง (`user_id = auth.uid()`) — ไม่มีเงื่อนไขแพ็กเกจ จึงอ่านได้ตลอดไป
2. **ไม่มี write grant** สำหรับ `anon`/`authenticated` — REST `POST/PATCH/DELETE` ตรงไปที่ตารางจะได้ `permission denied`
3. **RPC `debt_*` (SECURITY DEFINER, `search_path = public`)** ทุกตัวเรียก `kfp_debt_write_guard()` เป็นอย่างแรก:
   ล็อกอิน → `kfp_has_feature(uid,'credit_debt')` (ไม่ผ่าน = `premium_required`, 42501) → rate limit `kfp_rate_hit('debt:'||uid, 600, 3600)`
4. **ตรวจความเป็นเจ้าของทุก id** ที่ส่งมา (card/plan/schedule/transfer/payoff) — ของคนอื่นตอบว่า `*_not_found` (ไม่บอกว่ามีอยู่จริง)
5. ฟังก์ชันภายใน `kfp_debt_*` ถูก revoke จาก `public/anon/authenticated`
6. `kfp_security_report()` มี allowlist ของ RPC ใหม่ทั้ง 18 ตัว — รายงานต้องเป็น 0 findings

## RPC สำหรับเบราว์เซอร์

| RPC | สิทธิ์ |
|---|---|
| `get_my_debt_access()` | ทุกคนที่ล็อกอิน (อ่านอย่างเดียว) |
| `export_my_debt()` | ทุกคนที่ล็อกอิน — export ข้อมูลของตัวเอง (ใช้ได้แม้ read_only) |
| `debt_save_card`, `debt_set_card_status`, `debt_delete_card` | full เท่านั้น |
| `debt_save_installment`, `debt_set_installment_status`, `debt_delete_installment`, `debt_confirm_schedule` | full เท่านั้น |
| `debt_record_payment`, `debt_cancel_payment` | full เท่านั้น |
| `debt_save_transfer`, `debt_set_transfer_status`, `debt_delete_transfer` | full เท่านั้น |
| `debt_add_adjustment`, `debt_cancel_adjustment` | full เท่านั้น |
| `debt_save_payoff_plan`, `debt_delete_payoff_plan` | full เท่านั้น |

## สถานการณ์ที่ทดสอบแล้ว (phase16)

Premium ใช้งาน → full · Premium grant หมดอายุ → read_only (เห็นครบ เขียนไม่ได้ ข้อมูลไม่หาย) · ไม่เคย Premium → locked ·
ยกเลิกแต่ยังอยู่ในรอบ → full · หมดรอบ → read_only · ชำระไม่ผ่านในช่วงผ่อนผัน → full · เกินช่วงผ่อนผัน → read_only ·
สมัครใหม่ → full · ถูกระงับบัญชี → read_only · ผู้ใช้อื่นอ่าน/เขียนข้ามไม่ได้ · anon อ่าน/เรียกไม่ได้ · REST เขียนตรงไม่ได้

## สกุลเงิน

ลูกค้าไทยและเกาหลีเข้าถึงได้เหมือนกัน: บัตร/แผนแต่ละรายการเลือก THB หรือ KRW เองได้ (ไม่ผูกกับ `kfp_mode` หรือประเทศในโปรไฟล์) — ประเทศใช้แค่เลือกแท็บเริ่มต้น (TH → ฿, KR → ₩) และหน้า "ภาพรวม" รวมทั้งสองสกุลโดยแปลงตามเรตที่แสดงไว้ชัดเจน
