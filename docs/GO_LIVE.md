# Korea Finance Planner · Go-Live Checklist

ทำบน **staging ก่อน** ทุกข้อ แล้วทำซ้ำบน production · รายละเอียดแต่ละข้ออยู่ใน `docs/SETUP.md` ตาม Phase

## 0. ดูหน้าตาก่อน (ยังไม่แตะ Supabase / Stripe)
GitHub Pages ของ repo นี้คือ**เว็บจริงที่ผู้ใช้ใช้อยู่** และ `supabase-config.js` ชี้ฐานข้อมูลจริง — อย่า push ลง branch ที่ Pages ใช้ (ปกติ `main`) จนกว่าจะทำข้อ 1–2
```bash
git checkout -b saas-v2            # branch ใหม่ — เว็บจริงไม่เปลี่ยน
# คัดลอกไฟล์จาก zip ทับ (ทั้งโฟลเดอร์) แล้ว
git add -A && git commit -m "SaaS v2: preview, auth, plans, Stripe, billing, admin, security"
git push -u origin saas-v2
python3 -m http.server 8000       # ดูหน้าตาในเครื่อง: http://localhost:8000
```
- ในเครื่องจะเห็นโหมด Preview + ข้อมูลตัวอย่าง, หน้า Pricing (ราคาสำรอง), Login gate ได้ทันที · Login ได้ด้วยบัญชีเดิม (ฐานข้อมูลจริง) แต่ฟีเจอร์ตามแพ็กเกจ/ชำระเงิน/Admin จะยังไม่ทำงานจนกว่าจะรัน SQL
- ถ้าเผลอ push ลง `main` ก่อนรัน SQL: เว็บยังใช้งานได้ (ทุกฟีเจอร์แสดงแบบเดิม, ปุ่มสมัครแจ้งว่ายังไม่เปิด) แต่**พอร์ตทองจะไม่ซิงก์ข้ามเครื่อง**จนกว่าจะรัน `0800` และผู้เยี่ยมชมจะเห็นโหมด Preview — ไม่มีข้อมูลหาย

## 1. Supabase (production project)
- [ ] **Backup** ก่อนเริ่ม (Dashboard → Database → Backups หรือ `pg_dump`)
- [ ] Staging (project ใหม่ว่างเปล่า) เท่านั้น: รัน `supabase_schema.sql` ก่อน · **production ห้ามรันซ้ำ** (มีอยู่แล้ว)
- [ ] SQL Editor → วางไฟล์ **`supabase/install_all.sql`** ทั้งไฟล์แล้วกด Run (รวม migration 0100, 0300 → 1100 ตามลำดับ · รันซ้ำได้)
      หรือรันทีละไฟล์ใน `supabase/migrations/` ตามชื่อ (ข้าม `0200`)
      (`0200_legacy_launch_grant` = **วันเปิดระบบ** ข้อ 6)
- [ ] `select * from public.kfp_security_report();` → ต้องเหลือแค่ `INFO no_owner` (ก่อนข้อถัดไป) แล้ว **ว่าง**
- [ ] ตั้ง owner คนแรก (SETUP Phase 6 ข้อ 2) — ใช้บัญชีที่มีอีเมลจริงและรหัสผ่านยาว
- [ ] Authentication (SETUP Phase 2 ข้อ 2): Confirm email **ON** (เปิดเป็นอย่างสุดท้าย) · Secure email change **OFF** · Min password 8 · Leaked password protection ON · Site URL + Redirect URLs เฉพาะโดเมนจริง (ลบ localhost ออก) · **Custom SMTP** + SPF/DKIM
- [ ] Auth → Rate limits: ค่าเริ่มต้นหรือเข้มกว่า (sign-up / OTP / token refresh)
- [ ] pg_cron: `kfp_activity_maintenance` วันละครั้ง (SETUP Phase 11)
- [ ] (แนะนำ) เปิด MFA สำหรับบัญชี owner/admin ใน Supabase Dashboard ของทีม

## 2. Edge Functions + Secrets
```bash
supabase link --project-ref <prod-ref>
supabase secrets set STRIPE_SECRET_KEY=sk_live_xxx STRIPE_WEBHOOK_SECRET=whsec_xxx \
  SITE_URL=https://inseang0133-svg.github.io/korea-finance-planner \
  ALLOWED_ORIGINS="https://inseang0133-svg.github.io"
supabase functions deploy username-login --no-verify-jwt
supabase functions deploy stripe-webhook --no-verify-jwt
for f in create-checkout create-portal billing-action admin-actions; do supabase functions deploy $f; done
```
- [ ] `ALLOWED_ORIGINS` มีแค่โดเมนจริง (ไม่มี localhost) · ไม่มี secret ใดอยู่ใน repo/เว็บ (`node tests/security/static-audit.js`)

## 3. ความปลอดภัยของหน้าเว็บ
- [ ] **SRI**: ใส่ `integrity` + `crossorigin="anonymous"` ให้สคริปต์ CDN ทุกตัว (เวอร์ชันล็อกไว้แล้ว) — คำนวณ hash บนเครื่องที่ออกเน็ตได้:
```bash
for u in https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.97.0/dist/umd/supabase.js \
         https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.js \
         https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js \
         https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.3/dist/lightweight-charts.standalone.production.js; do
  echo "$u  sha384-$(curl -sL "$u" | openssl dgst -sha384 -binary | openssl base64 -A)"; done
```
  แล้วแก้ `<script src="…" integrity="sha384-…" crossorigin="anonymous">` ใน `index.html`, `gold.html`, `pricing.html`, `account.html`, `admin.html`, `auth-callback.html` (ทดสอบทุกหน้าว่ายังโหลดได้)
- [ ] `supabase-config.js` ชี้ production (publishable key เท่านั้น)
- [ ] อัปโหลดเว็บทั้งหมด → เปิดเว็บด้วย PWA ที่ติดตั้งไว้ ตรวจว่าได้เวอร์ชันใหม่ (`sw.js` cache `…-saas12`)
- [ ] หน้า Privacy Policy / Terms: เก็บอะไร (อีเมล ข้อมูลการเงินที่ผู้ใช้กรอก ชื่อหน้า/ฟีเจอร์ที่ใช้) · ชำระผ่าน Stripe · การลบบัญชี · ติดต่อ (ปรึกษากฎหมาย PDPA/PIPA)

## 4. Stripe (Live mode)
- [ ] ข้อจำกัดประเทศของบัญชี Stripe (SAAS_PLAN ข้อ 9) · Business details + Terms URL
- [ ] Customer portal: Cancel at period end · Switch plans (`kfp_plus`, `kfp_premium` ทุกราคา) · Update payment methods · Invoice history
- [ ] Emails: renewal reminders (แจ้งก่อนตัดเงิน 7 วัน) · failed payment · receipts
- [ ] Webhook endpoint production + 8 events (SETUP Phase 7) · Signing secret ตรงกับ `STRIPE_WEBHOOK_SECRET`
- [ ] ฐานข้อมูล production ต้อง**ไม่มี** id ของ Test mode (`plan_prices.provider_price_id`, `billing_customers`) — SETUP Phase 7 ข้อ 5
- [ ] ทดลองซื้อจริง 1 ครั้งด้วยบัตรตัวเอง → refund → ตรวจ `payments`, `payment_refunds`, หน้า Billing

## 5. ทดสอบบน staging (บริการจริง) — ทำครบก่อนเปิด
- [ ] SETUP Phase 2 (สมัคร/ยืนยัน/ลืมรหัส/บัญชีเดิม) · Phase 7 ข้อ 1–10 · Phase 8 ข้อ 11–15 · Phase 9 ข้อ 1–7 · Phase 10 ข้อ 1–6 · Phase 11 ข้อ 4
- [ ] `tests/run-all.sh --scale` เขียวทั้งหมด

## 6. วันเปิดระบบ
1. Backup อีกครั้ง
2. เปิด Confirm email (ถ้ายังไม่เปิด)
3. รัน `20261113000200_legacy_launch_grant.sql` (สมาชิกเดิมได้ Premium 90 วัน นับจากวันนี้)
4. ประกาศผู้ใช้เดิม: วิธีเชื่อมอีเมลจริง · Cloud Sync/พอร์ตทองตามแพ็กเกจ · ข้อมูลเดิมอยู่ครบ

## 7. หลังเปิด (สัปดาห์แรกทุกวัน แล้วสัปดาห์ละครั้ง)
- [ ] Admin → ภาพรวม: **Webhook ที่ล้มเหลว = 0** · จ่ายไม่สำเร็จ · ค้างชำระ
- [ ] Admin → การใช้งาน: DAU / สมาชิกเสี่ยงยกเลิก
- [ ] Supabase → Logs (Edge Functions 5xx, Auth errors) · Stripe → Developers → Webhooks (failed deliveries)
- [ ] หลังเพิ่ม migration ใดๆ: `select * from public.kfp_security_report();` ต้องว่าง

## 8. Rollback
- Migration ทุกไฟล์เป็นแบบเพิ่ม (ไม่ลบข้อมูล) → ถอยหน้าเว็บได้โดย deploy ไฟล์เดิมกลับ
- ถอยเฉพาะการเก็บเงิน: ปิด webhook endpoint + ซ่อนปุ่มสมัครใน `pricing.html` · สิทธิ์ที่จ่ายแล้วยังอยู่จนสิ้นรอบ

## 9. อุปกรณ์จริง
- [ ] iPhone Safari + PWA ที่ติดตั้ง (iOS backup ของ localStorage) · Android Chrome · เดสก์ท็อป Chrome/Edge · หน้าจอ 360 px
