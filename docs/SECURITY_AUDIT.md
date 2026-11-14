# Korea Finance Planner · Security Audit (Phase 12)

> วันที่: 14/11/2026 · ขอบเขต: เว็บ (GitHub Pages), Supabase (Auth, Postgres/RLS, Edge Functions), Stripe · อ้างอิง PART 12 ของ Master Prompt V2
> วิธี: อ่านโค้ดทุกไฟล์ที่เกี่ยวกับสิทธิ์/ข้อมูล + ตรวจ catalog ของฐานข้อมูลแบบอัตโนมัติ + เทสต์โจมตีจริงใน browser/SQL
> **ผล: ไม่พบช่องโหว่ระดับร้ายแรงที่ให้คนอื่นเห็น/แก้ข้อมูลหรือได้สิทธิ์ฟรี** · พบและแก้ 7 เรื่อง (ด้านล่าง) · ความเสี่ยงที่เหลือเป็นข้อจำกัดของแพลตฟอร์มหรือต้องทำบนระบบจริง

## 1. สิ่งที่พบและแก้ใน Phase 12

| # | ระดับ | เรื่อง | ผลกระทบ | แก้แล้ว | ทดสอบ |
|---|---|---|---|---|---|
| F1 | **สูง (ใช้งาน)** | หน้าบัญชีส่ง `updated_at` ไปพร้อมชื่อเล่น แต่ฐานข้อมูลอนุญาตให้ browser แก้ได้เฉพาะ `nickname`/`country` | **กด "บันทึกชื่อ" ล้มเหลวทุกครั้งบน Supabase จริง** (ไม่เห็นในเทสต์เพราะ mock) | `auth.js` ส่งแค่ `{nickname}` (≤ 60 ตัว) · trigger ตั้ง `updated_at` เอง | SQL S4 (คำสั่งเดียวกับที่ browser ส่ง) · e2e X6 · static audit |
| F2 | กลาง | สคริปต์จาก CDN ไม่ล็อกเวอร์ชัน (`supabase-js@2`, `xlsx` ล่าสุด) | ถ้า npm package ถูกยึด เว็บจะโหลดโค้ดใหม่ที่ไม่ได้ตรวจทันที (เข้าถึง session ได้) | ล็อก `@supabase/supabase-js@2.97.0`, `xlsx@0.18.5` (เว็บ) และ `npm:@supabase/supabase-js@2.97.0` (Edge) | static audit B · **SRI ยังเป็น WARN** (GO_LIVE) |
| F3 | กลาง | เครื่องที่ใช้ร่วมกัน: logout แล้วข้อมูลบัญชียังอยู่ในเครื่อง (และใน backup IndexedDB ของ iOS) | คนถัดไปที่ใช้เครื่องเปิด DevTools อ่านได้ | ปุ่ม **"ออกจากระบบและลบข้อมูลบัญชีนี้ออกจากเครื่องนี้"** (ยืนยัน 2 ครั้ง, เตือนแรงขึ้นสำหรับ Free) ลบ namespace + เขียน backup ใหม่ | e2e X4 (รวม reload หลังลบ — ไม่ถูกกู้กลับ) |
| F4 | กลาง | หน้า Admin ไม่มี CSP / กัน clickjacking | XSS ใดๆ ในอนาคตบนหน้า admin จะรุนแรง · หน้าถูกฝังใน iframe ได้ | CSP แบบเข้ม (ไม่มี inline script, ส่งข้อมูลได้แค่ Supabase) + frame-busting | e2e X3 (0 violation ระหว่างใช้งานจริง, บล็อก inline/ต่างโดเมน) |
| F5 | ต่ำ | Pricing/Billing เปิด URL ใดๆ ที่ Edge Function ตอบกลับ | ถ้า function ถูกแก้/ตอบผิด อาจพาไปหน้า phishing หรือ `javascript:` | เปิดได้เฉพาะ `https://*.stripe.com` หรือโดเมนตัวเอง | e2e X5 |
| F6 | ต่ำ | Trigger functions (`handle_new_kfp_user`, `sync_kfp_profile_from_auth`, …) เรียกผ่าน API ได้ | ไม่มีผล (Postgres ไม่ให้เรียก trigger ตรง) แต่ผิดหลัก least-privilege | revoke ทั้งหมด · ลบ `kfp_protect_gold_keys` ที่ไม่ใช้แล้ว | `kfp_security_report()` / SQL S2, S6 |
| F7 | ต่ำ | สิทธิ์ insert/delete `profiles` ที่ไม่จำเป็น · ไม่มีขีดจำกัดขนาด `user_data` / ชื่อเล่น | ผู้ใช้ Plus+ อัปโหลด JSON ใหญ่มากได้ (ค่าใช้จ่าย/ช้า) | revoke + ลบ policy insert · `user_data` ต้องเป็น object ≤ 2 MB · nickname ≤ 60 · country = รหัส 2 ตัว | SQL S4 |

เครื่องมือใหม่สำหรับตรวจซ้ำในอนาคต:
- **`select * from public.kfp_security_report();`** (SQL Editor) — ตารางไม่มี RLS, SECURITY DEFINER ไม่มี search_path, ฟังก์ชันภายในที่ browser เรียกได้, สิทธิ์เขียนที่เกินกำหนด, ตารางที่ anon อ่านได้, policy เปิดกว้าง · **ว่าง = ผ่าน** · รันทุกครั้งหลังเพิ่ม migration
- `node tests/security/static-audit.js` — secret ในไฟล์เว็บ, เวอร์ชัน CDN, eval, ลิงก์ `_blank`, mixed content, RPC/Edge ที่เว็บเรียกต้องมีจริงและได้สิทธิ์, Edge ทุกตัวต้องตรวจ JWT ฯลฯ

## 2. ผลตรวจตามหัวข้อ PART 12

| หัวข้อ | ตรวจอย่างไร | ผล |
|---|---|---|
| **Supabase RLS** | catalog: ทุกตารางใน `public` (18) เปิด RLS · เทสต์ทั่วไป: สมาชิก X อ่านทุกตาราง (16) ไม่เห็นแถวของ Y · anon อ่านได้แค่ `plans` / `plan_prices` ที่ active | ✅ |
| **Auth Session** | session ของ Supabase เก็บใน localStorage จริง (ไม่ผ่าน proxy) · token ตรวจที่ server ด้วย `auth.getUser(token)` ทุก Edge Function · logout ล้าง session + เปลี่ยนเป็น Preview · iOS backup ไม่เก็บ/กู้ session | ✅ |
| **Email Verification** | Supabase "Confirm email" (SETUP Phase 2) · Checkout ปฏิเสธอีเมลที่ยังไม่ยืนยัน/บัญชี legacy (Edge C1) | ✅ (ต้องเปิดใน Dashboard) |
| **Password Recovery** | ลิงก์รีเซ็ตกลับมาที่ `auth-callback.html` ที่อยู่ใน Redirect URLs allowlist · ไม่มี open redirect (`next=`) · เปลี่ยนรหัสต้องยืนยันรหัสเดิม | ✅ (e2e Phase 2) |
| **Admin Authorization** | ทุก `admin_*` ตรวจ `admin_roles` + บัญชีไม่ถูกระงับในฐานข้อมูล · viewer อ่านอย่างเดียว · ทำกับตัวเองไม่ได้ · admin แตะ admin ไม่ได้ · Edge `admin-actions` อ่านบทบาทจาก DB · ทุกการเขียนมี audit (แก้/ลบไม่ได้) | ✅ (SQL P10, Edge M1, e2e Phase 10) |
| **Stripe Webhook** | ตรวจลายเซ็น (SDK) · ปฏิเสธ body ถูกแก้/ลายเซ็นเก่า > 5 นาที · กันซ้ำด้วย event id · ดึงสถานะจริงจาก Stripe ทุกครั้ง · เขียนผ่านฟังก์ชัน service_role เท่านั้น | ✅ (Edge W1–W9) |
| **Secret Management** | ไม่มี secret ในไฟล์เว็บ (static audit) · key ในเว็บเป็น publishable · Stripe/service key อยู่ใน Supabase Secrets เท่านั้น · CORS ปิดถ้าไม่ได้ตั้ง `ALLOWED_ORIGINS` | ✅ |
| **XSS** | ข้อความผู้ใช้ทุกจุดผ่าน `esc()`/`escapeHTML()`/`textContent` · e2e "canary" ใส่ payload ใน รายจ่าย/รายการหัก/หมวดเงิน/โน้ตทอง/ชื่อผู้ใช้/audit/ชื่อหน้า → ไม่มีอะไรทำงาน · ลิงก์ภายนอกรับเฉพาะ `https://` · หน้า admin มี CSP | ✅ |
| **SQL Injection** | ไม่มี dynamic SQL ที่ประกอบจากค่าผู้ใช้ (ใช้ parameter / `format('%I')` เฉพาะชื่อตารางในเทสต์) · เทสต์ส่ง `'; delete …`, `%' or 1=1`, `drop table` ในการค้นหา/ตัวกรอง/username/ชื่อหน้า → เป็นแค่ข้อความ | ✅ (SQL S5) |
| **CSRF** | API ใช้ `Authorization: Bearer` (ไม่ใช้ cookie) → เว็บอื่นส่งคำขอในนามผู้ใช้ไม่ได้ · CORS จำกัดโดเมน · webhook ใช้ลายเซ็น | ✅ ไม่เกี่ยวข้องตามรูปแบบ |
| **Privilege Escalation** | สมาชิกแก้ `suspended_at`/`username`/`email`/`updated_at` ไม่ได้ · insert admin_roles/subscriptions/entitlements/payments/gold ไม่ได้ · เรียกฟังก์ชันภายใน `kfp_*` ไม่ได้ · ให้ Premium ตัวเองไม่ได้ | ✅ (SQL S4) |
| **Unauthorized Requests** | Edge ทุกตัว (ยกเว้น webhook/username-login) ต้องมี JWT · RPC ที่ anon เรียกได้มีตัวเดียว (`is_username_available`) | ✅ (static audit E, SQL S6) |
| **Subscription Manipulation** | สิทธิ์คำนวณจากฐานข้อมูลเท่านั้น (subscriptions ← webhook) · ราคามาจาก `plan_prices` ไม่ใช่ browser · success URL ไม่ให้สิทธิ์ · ยกเลิก/ต่ออายุ/เปลี่ยนแพ็กเกจตรวจเจ้าของ subscription | ✅ |
| **Data Leakage** | ไม่มีตารางใดรั่วข้ามบัญชี (16 ตาราง) · ประวัติชำระเงินกรอง user_id แม้เป็น admin · `get_my_gold` ไม่ส่งเนื้อหาเมื่อไม่มีสิทธิ์ · activity เก็บแค่ชื่อหน้า/เวลา | ✅ |
| **LocalStorage Isolation** | namespace ต่อบัญชี + Preview ในหน่วยความจำ · บัญชีหนึ่งอ่านของอีกบัญชีผ่านหน้าเว็บไม่ได้ · ข้อมูลตัวอย่างไม่ถูกบันทึก/ส่ง · ปุ่มลบออกจากเครื่อง (F3) | ✅ (e2e Phase 3, X4, X6) |

## 3. รองรับจำนวนสมาชิก (Postgres 16 ในเครื่องทดสอบ, ms)

| คำสั่ง | 100 | 1,000 | 10,000 | 50,000 |
|---|---|---|---|---|
| get_my_entitlements (ต่อคน) | 1.4 | 0.9 | 1.0 | 1.5 |
| get_my_billing (ต่อคน) | 2.2 | 1.9 | 1.7 | 2.1 |
| get_my_gold (ต่อคน) | 1.1 | 1.1 | 0.9 | 1.2 |
| touch_activity (ต่อคน) | 0.5 | 0.4 | 0.3 | 1.0 |
| admin_overview | 23 | 21 | 39 | 171 |
| admin_list_users (1 หน้า) | 9 | 10 | 63 | 455 |
| admin_list_users (ค้นหา) | 4 | 4 | 17 | 86 |
| admin_revenue | 6 | 5 | 24 | 114 |
| admin_activity_analytics (คำนวณใหม่ / แคช) | 20 / 0 | 52 / 0 | 435 / 0 | 2,613 / 0 |

ข้อมูลทดสอบ: 20% จ่ายเงิน · 20% ใช้งานทุกวัน 30 วัน · คำสั่งของสมาชิกคงที่ ~1–2 ms ทุกระดับ (ใช้ index) · หน้า admin ไม่โหลดสมาชิกทั้งหมดพร้อมกัน (สูงสุด 100/หน้า) · รายงานการใช้งานแคช 10 นาที
รันเอง: `tests/run-scale.sh`

## 4. ความเสี่ยงที่ยังเหลือ / ต้องทำนอกโค้ด

| # | เรื่อง | ทำไม | ทางแก้ |
|---|---|---|---|
| R1 | ยังไม่มี SRI (`integrity=`) บนสคริปต์ CDN | ต้องดาวน์โหลดไฟล์จริงเพื่อคำนวณ hash (เครื่องทดสอบนี้ออกเน็ตไม่ได้) | คำสั่งใน GO_LIVE ข้อ 3 |
| R2 | GitHub Pages ส่ง HTTP header เองไม่ได้ (CSP/X-Frame-Options ของทุกหน้า) | ข้อจำกัดของ GitHub Pages · หน้าอื่นมี inline script จึงใช้ CSP เข้มไม่ได้ | ใช้ meta CSP บน admin แล้ว · ถ้าย้ายไป Cloudflare Pages/Netlify ตั้ง header ได้ทุกหน้า |
| R3 | ระงับบัญชีแล้ว token เดิมยังไม่หมดอายุ (~1 ชม.) | Supabase JWT | สิทธิ์ทุกอย่างตรวจใหม่ที่ server จึงกลายเป็น Free ทันที · ถ้าต้องตัดทันที: Dashboard → Users → Sign out user |
| R4 | ตรวจว่า username ว่างไหมได้โดยไม่ login | จำเป็นสำหรับหน้าสมัคร | รับได้ · ถ้าถูกใช้ไล่หา ให้ย้ายไป Edge Function ที่มี rate limit |
| R5 | ข้อมูลในเครื่องของตัวเองดูได้ด้วย DevTools | ตั้งใจให้ใช้ออฟไลน์ได้ | ปุ่มลบออกจากเครื่อง (F3) |
| R6 | ยังไม่ได้ทดสอบกับ Supabase/Stripe/อีเมลจริง และ iOS Safari | เครื่องทดสอบไม่มีบัญชี/เน็ต | ทำ checklist ใน SETUP ทุก Phase + GO_LIVE บน staging |
| R7 | สมาชิกลบบัญชีตัวเองไม่ได้ (ต้องติดต่อผู้ดูแล) · นโยบายความเป็นส่วนตัว (ดาวน์โหลดข้อมูลตัวเองได้แล้ว — account.html) | PDPA (ไทย) / PIPA (เกาหลี) | แนะนำเพิ่ม "ลบบัญชี" + หน้า Privacy Policy ก่อนเปิดขาย (ปรึกษาผู้เชี่ยวชาญกฎหมาย) |
| R8 | `xlsx@0.18.5` มีช่องโหว่ตอน**อ่าน**ไฟล์ (prototype pollution) | เว็บใช้แค่**เขียน**ไฟล์ Export จึงไม่โดน | ถ้าจะเพิ่ม Import Excel ให้เปลี่ยนไปใช้ SheetJS จาก cdn.sheetjs.com |
