# Korea Finance Planner → SaaS · Implementation Plan (Phase 1)

> สถานะ: **Phase 1 ✅ · Phase 2 ✅ · Phase 3 ✅ · Phase 4 ✅ · Phase 5 ✅ · Phase 6 ✅ · Phase 7 ✅ · Phase 8 ✅ · Phase 9 ✅ · Phase 10 ✅ · Phase 11 ✅ · Phase 12 ✅** — ครบทุก Phase · ก่อนเปิดขายทำ `docs/GO_LIVE.md` · ดูรายละเอียดแต่ละ Phase ใน `docs/PHASE_LOG.md`
> วันที่: 13/11/2026 · Source: `korea-finance-planner-main (4).zip`

---

## 1. ผลวิเคราะห์ระบบเดิม

### 1.1 ภาพรวม
| ส่วน | สภาพปัจจุบัน |
|---|---|
| Hosting | Static site (GitHub Pages) ไม่มี backend ของตัวเอง |
| Backend | Supabase (Auth + PostgREST) ใช้ publishable key ใน `supabase-config.js` · Cloudflare Worker `gold-recorder` (ราคาทอง/proxy เท่านั้น ไม่มีข้อมูลผู้ใช้) |
| หน้า | `index.html` (เงินเดือน/แบ่งเงิน/สถิติ/สัญญา/แปลงเงิน + popup งาน/รายจ่าย) · `gold.html` (พอร์ตทอง) |
| ข้อมูลผู้ใช้ | **LocalStorage เป็นตัวหลัก** · Cloud = snapshot เดียวต่อคนใน `user_data.data` (jsonb, ค่าทุกตัวเป็น string) |
| PWA | `sw.js` cache assets · `pwa-persistence.js` สำรอง LocalStorage **ทั้งหมด** (ยกเว้น `sb-*`) ลง IndexedDB แล้ว restore คีย์ที่หายตอนเปิดแอป |

### 1.2 Authentication เดิม (`auth.js`)
- Username → อีเมลปลอม `username@kfp.example.com` (`usernameEmail()`), `signUp` / `signInWithPassword`
- Profile สร้าง 2 ทาง: trigger `handle_new_kfp_user` (username = ส่วนหน้า @ ของอีเมล) + client `upsert` ซ้ำอีกรอบ
- Login → โหลด Cloud แล้ว **ล้าง LocalStorage แล้วเขียนทับด้วย Cloud** · ก่อน login เก็บข้อมูล guest ไว้ที่ `__kfp_guest_backup_v1`
- Upload Cloud เป็นแบบกดเองเท่านั้น (`kfpUploadCloudBtn`) · Realtime ปิด
- Logout → ล้าง DATA_KEYS แล้วคืนข้อมูล guest backup → reload
- เปลี่ยนรหัสผ่านใช้ `prompt()` · ไม่มี forgot/reset password · `detectSessionInUrl:false` (ลิงก์ยืนยัน/รีเซ็ตจากอีเมลจะใช้ไม่ได้)

### 1.3 ปัญหา/ความเสี่ยงที่พบ (ต้องแก้ในงานนี้)
| # | ปัญหา | ผลกระทบ | แก้ใน Phase |
|---|---|---|---|
| R1 | Trigger สร้าง profile ใช้ username = ส่วนหน้า @ ของอีเมล + `on conflict (user_id)` เท่านั้น | สมัครด้วยอีเมลจริง เช่น `john@gmail.com` ขณะมีบัญชีเก่าชื่อ `john` → unique violation → **สมัครไม่ได้ ("Database error saving new user")** | 2 |
| R2 | `profiles_update_own` ให้ user แก้ทุกคอลัมน์ของ profile ตัวเอง | ถ้าเอา plan/status ไปใส่ใน `profiles` ผู้ใช้จะแก้ plan เองได้ → ต้องเก็บสิทธิ์ในตารางแยกที่ user เขียนไม่ได้ | 6 |
| R3 | ข้อมูลทองอยู่ใน snapshot เดียวกับข้อมูลอื่น (`user_data.data.kfp_gold_lots_v1`) | ป้องกันทองด้วย RLS ไม่ได้ (RLS ทำงานระดับแถว ไม่ใช่ระดับ key ใน jsonb) → ต้องแยกตาราง | 9 |
| R4 | `pwa-persistence.js` restore ทุกคีย์ที่หายจาก snapshot ใน IndexedDB | หลัง logout แล้ว reload คีย์ส่วนตัวของสมาชิกที่ไม่มีใน guest backup (เช่น `kfp_expenses_v1`) **น่าจะถูก restore กลับมาให้ guest เห็น** (ข้อมูลรั่วข้ามบัญชีบนเครื่องเดียวกัน) — จะยืนยันด้วย test ใน Phase 3 | 3 |
| R5 | LocalStorage ไม่แยกตามผู้ใช้ (คีย์เดียวกันทุกคน) | เครื่องที่ใช้หลายบัญชีพึ่งการล้าง/เขียนทับอย่างเดียว · ขัดข้อ "LocalStorage Isolation" | 3 |
| R6 | Logout ทิ้งการแก้ไขที่ยังไม่ได้กด Upload | สมาชิกเสียข้อมูลเงียบๆ | 4 (เตือนก่อน logout) |
| R7 | Supabase default SMTP ส่งอีเมลได้เฉพาะอีเมลทีมโปรเจกต์ + 2 ฉบับ/ชม. | ลูกค้าจริงจะ**ไม่ได้รับอีเมลยืนยัน/รีเซ็ตรหัส** → ต้องตั้ง Custom SMTP ก่อนเปิดสมัคร | 2 (ตั้งค่า) |
| R8 | "Secure email change" (ค่าเริ่มต้น Supabase) ต้องยืนยันทั้งอีเมลเก่าและใหม่ | บัญชีเก่า `@kfp.example.com` รับอีเมลไม่ได้ → **เปลี่ยนเป็นอีเมลจริงไม่สำเร็จ** | 2 |
| R9 | `sw.js` ลงทะเบียนด้วย `?v=20261018` และ ASSETS ต้องรวมไฟล์ใหม่ทุกไฟล์ | ไฟล์ใหม่ (admin/billing/gate) จะไม่ถูก cache / ผู้ใช้ค้างเวอร์ชันเก่า | ทุก Phase |

### 1.4 สิ่งที่ต้องคงไว้ (ห้ามเปลี่ยน)
สูตรเงินเดือน/แบ่งเงิน (`script.js`, `kfp-config.js`, `alloc-ui.js`) · สูตรทองทั้งหมดใน `gold.js` · logic งาน/รายจ่าย (`tools-ui.js`) · ธีม Black/Gold (`theme.css`, `tools.css`, `gold.css`) · ชื่อ LocalStorage keys เดิมทั้งหมด · โครง `user_data` เดิม · PWA

### 1.5 รายการปุ่ม Action (ใช้ทำ Login Gate)
| หน้า | ปุ่ม/Action | Gate? |
|---|---|---|
| index | `calculate()` (เขียน `salary` ลง LocalStorage) | ✅ |
| index | `saveThisMonthSalary()`, `addSalaryRecord()`, `saveContract()`, `deleteContract()`, `setContractDuration()` | ✅ |
| index | `exportExcel()` | ✅ (+ ต้องมีสิทธิ์ `export`) |
| index | `#btnManageAlloc` (เปิด popup ดูได้) → `#allocSave` | ✅ ที่ `#allocSave` |
| index | `updateExchangeRate()` | ❌ อ่านเรตสาธารณะอย่างเดียว |
| index | `swapConverter()`, `convertCurrency()` | ❌ เครื่องคิดเลข ไม่บันทึก |
| index popup | `w-save`, `w-del-yes`, `ded-add`, `ded-del`, `rcv-save`, `set-save`, `set-reset`, `ex-save`, `ex-del-yes` | ✅ (เปิดดู popup/ปฏิทิน/ประวัติได้) |
| gold | `#lotForm` submit, ปุ่มลบ lot, `#clearGoldBtn`, `#saveGold2goQuoteBtn`, บันทึก valuation settings | ✅ |
| gold | `#exportGoldBtn` | ✅ |
| gold | `#buyCalcBtn`, ปุ่มกราฟ, `#refreshGoldBtn`, ข่าว | ❌ อ่าน/คำนวณเฉยๆ |
| auth | Upload / Download Cloud | ✅ (+ สิทธิ์ `cloud_sync`) |

---

## 2. สถาปัตยกรรมเป้าหมาย

```
Browser (GitHub Pages, static)                  Supabase                               Stripe
──────────────────────────────                  ─────────────────────────────          ──────────
kfp-storage.js  ← โหลดก่อนทุกสคริปต์            Auth (email+password, verify, reset)
  ├ preview  → memory storage + demo data       Postgres + RLS
  └ member   → namespaced real storage            profiles, user_data, user_gold_data
auth.js (ปรับ)  → session, profile                 plans, plan_prices, subscriptions,
kfp-access.js   → requireAuth, canUseFeature       payments, user_entitlements,
                  applyPlanVisibility              user_activity, admin_roles,
pricing.html / account.html / admin.html           admin_audit_logs, stripe_webhook_events
                                                 RPC: get_my_entitlements(), has_feature(),
                                                      touch_activity(), admin_* (security definer)
                                                 Edge Functions (secret keys อยู่ที่นี่):
                                                   create-checkout ─────────────────────▶ Checkout
                                                   create-portal   ─────────────────────▶ Portal
                                                   stripe-webhook  ◀───────────────────── Webhooks
                                                   username-login, admin-actions
```

### 2.1 Preview Mode โดยไม่แก้สูตรเดิม (ทดสอบแล้วว่าทำได้)
ไฟล์ใหม่ `kfp-storage.js` โหลดเป็นสคริปต์แรกของทุกหน้า แล้วแทน `window.localStorage` ด้วย storage ของเราเอง:
- **Guest / Preview** → storage ในหน่วยความจำที่ seed ด้วย Demo Data · เขียนได้ (ให้ UI ทำงานต่อ) แต่**ไม่ลงเครื่อง ไม่ขึ้น Cloud** และหายเมื่อ reload
- **Member** → เขียนลง LocalStorage จริงแต่ต่อท้ายชื่อด้วย user id: `kfp:u:<uid>:salary` (แยกข้อมูลตามบัญชี แก้ R5) · คีย์ระบบ (`sb-*`, `rate`, ตำแหน่งปุ่ม ฯลฯ) ผ่านตรง
- โค้ดเดิม (`script.js`, `gold.js`, `tools-ui.js` …) ใช้ `localStorage.getItem(...)` ตามเดิม **ไม่ต้องแก้สักบรรทัด**
- Spike test (Chromium): override `window.localStorage` ได้ (`configurable: true`), สคริปต์เดิมอ่าน demo ได้, ข้อมูลจริงไม่ถูกแตะ, demo ไม่รั่วลงเครื่อง → **ต้องทดสอบซ้ำบน iOS Safari/PWA จริงใน Phase 3**
- `pwa-persistence.js`: ปิดใน Preview, และ backup/restore เฉพาะ namespace ของ user ปัจจุบัน (แก้ R4)

### 2.2 Login Gate กลาง (`kfp-access.js`)
- `requireAuth(action, options)` → ถ้าไม่ใช่สมาชิกที่ยืนยันอีเมลแล้ว เปิด Auth Modal ("กรุณาเข้าสู่ระบบหรือสมัครสมาชิกเพื่อใช้งานฟีเจอร์นี้" + Login / Create Account) แล้ว return `false`
- ติดตั้งครั้งเดียวด้วย **capture-phase listener** ระดับ `document` จับ `click`/`submit` ของ element ที่มี `data-action` หรือ match selector ในตาราง 1.5 → โค้ด handler เดิมไม่ถูกเรียกเลยถ้ายังไม่ login
- เพิ่ม attribute `data-action="..."` ใน HTML/template (ไม่แก้ logic)

### 2.3 Plan-Based Visibility
- `get_my_entitlements()` (RPC, security definer) คืน `{plan, status, period_end, features:{salary,salary_history,expenses,work_records,advanced_statistics,export,cloud_sync,gold_portfolio}, limits:{...}}` คำนวณจาก subscriptions + plans + user_entitlements (admin grant) ฝั่ง DB
- Client: `canUseFeature(key)`, `renderFeaturesByPlan()`, `applyPlanVisibility()` · element ใช้ `data-feature="gold_portfolio"` → ไม่มีสิทธิ์ = `hidden` (ไม่ใช่ล็อก) · กัน flash ด้วย `html:not([data-plan-ready]) [data-feature]{visibility:hidden}`
- Floating nav (`floating-nav.js`) รับ `data-feature` ด้วย → Plus/Free ไม่เห็นปุ่มไปหน้าทอง
- Direct URL `gold.html`: Guest = Preview demo · Member ไม่มีสิทธิ์ = หน้า upsell ไม่โหลดข้อมูลทองเลย · Premium = ปกติ
- **ความปลอดภัยจริงอยู่ที่ DB** (RLS + `has_feature()`), UI แค่ซ่อน

### 2.4 Entitlement ตามสถานะ Subscription (คำนวณใน DB)
| สถานะ Stripe | สิทธิ์ |
|---|---|
| `active`, `trialing` | ตาม plan |
| `active` + `cancel_at_period_end` | ตาม plan จนถึง `current_period_end` |
| `past_due` | ตาม plan อีก **N วัน grace** (ค่าเริ่มต้น 7 — รอยืนยัน) |
| `unpaid`, `canceled`, `incomplete_expired`, หมดอายุ | Free |
| admin grant ใน `user_entitlements` (มี `expires_at`) | override ตามที่ให้ |
ข้อมูลไม่ถูกลบเมื่อลดสิทธิ์ · อ่าน/Export ข้อมูลตัวเองได้เสมอ

---

## 3. Database Migration (ไฟล์ `supabase/migrations/*.sql`, re-run ได้)

**คงไว้:** `profiles`, `user_data` (โครงเดิม + policy เดิม)

**แก้ `profiles`:** เพิ่ม `email` (sync จาก `auth.users` ด้วย trigger, ไม่ให้ user แก้), `display_name`, `country`, `is_legacy_email boolean`, `last_login_at`, `last_active_at`, `last_page`, `suspended_at` · จำกัด column ที่ user update ได้ด้วย column-level `grant update (nickname, display_name, country)` · แก้ trigger (R1): เอา username จาก `raw_user_meta_data.username` และถ้าว่าง/ซ้ำให้ต่อท้าย suffix — ไม่ fail การสมัคร

**ตารางใหม่ (ทุกตาราง RLS on, user อ่านได้เฉพาะของตัวเอง, เขียนได้เฉพาะ service_role / RPC ที่ตรวจสิทธิ์):**
| ตาราง | หน้าที่ | หมายเหตุ |
|---|---|---|
| `plans` | free / plus / premium + `features jsonb` + `limits jsonb` + `sort` | อ่านได้ทุกคน (หน้า Pricing) |
| `plan_prices` | ราคา per plan × interval × currency + `stripe_price_id` + `active` | THB/KRW · KRW เป็น zero-decimal ใน Stripe |
| `subscriptions` | 1 แถวต่อ Stripe subscription: status, interval, currency, period start/end, cancel_at_period_end, ids | เขียนโดย webhook เท่านั้น |
| `payments` | invoice/charge: amount, currency, status, refunded_amount, hosted_invoice_url | Payment + Invoice + Refund history |
| `user_entitlements` | admin grant/revoke: plan, expires_at, reason, granted_by | |
| `user_activity` | event log แบบย่อ (login, page, heartbeat) + index (user_id, created_at) | เขียนผ่าน `touch_activity()` throttle 5 นาที |
| `admin_roles` | user_id, role (`owner`/`admin`) | ไม่มี policy insert สำหรับ authenticated → เพิ่มตัวเองเป็น admin ไม่ได้ |
| `admin_audit_logs` | ใคร ทำอะไร กับใคร ก่อน/หลัง | insert ผ่าน RPC admin เท่านั้น |
| `stripe_webhook_events` | `event_id` PK + processed_at | กัน event ซ้ำ (idempotency) |
| `user_gold_data` | snapshot ข้อมูลทองแยกจาก `user_data` | write ต้อง `has_feature('gold_portfolio')`, read ของตัวเองได้เสมอ (เพื่อ export) |

**Functions:** `has_feature(uid, key)`, `get_my_entitlements()`, `is_admin()`, `touch_activity(page)`, `admin_list_users(search, filters, sort, page)` (keyset pagination), `admin_user_detail(uid)`, `admin_set_plan/grant/extend/revoke/suspend/reactivate` (ทุกตัวเขียน audit log), view `admin_revenue_*` (MRR/ARR แยก THB/KRW)

**Data migration (ไม่ลบอะไร):** copy คีย์ `kfp_gold_*` จาก `user_data.data` → `user_gold_data` (เก็บของเดิมไว้ใน `user_data` จนกว่าจะยืนยันว่าถูกต้อง) · ตั้ง `is_legacy_email = true` ให้ทุกบัญชี `@kfp.example.com` · สร้างสิทธิ์เริ่มต้นตามข้อ 7.1

---

## 4. Edge Functions (Deno, secret อยู่ใน Supabase Secrets เท่านั้น)
| Function | หน้าที่ | ความปลอดภัย |
|---|---|---|
| `create-checkout` | สร้าง Checkout Session (mode subscription) จาก `plan_prices` · ผูก/สร้าง Stripe Customer | ต้องมี JWT + อีเมลยืนยันแล้ว + ไม่ใช่อีเมล legacy · ราคาเลือกจาก DB ไม่รับราคาจาก client |
| `create-portal` | Customer Portal (upgrade/downgrade/cancel/resume/update card/invoices) | JWT |
| `stripe-webhook` | 7 events ตามสเปก → upsert `subscriptions`, `payments` | ตรวจ signature (`constructEventAsync`), insert `stripe_webhook_events` ก่อนประมวลผล, ดึง subscription ล่าสุดจาก Stripe API ทุกครั้ง (ไม่เชื่อลำดับ event) · ไม่เชื่อ success URL |
| `username-login` | Login ด้วย username: หา email ด้วย service role แล้ว sign-in ฝั่ง server คืน session | ไม่ส่งอีเมลกลับ · rate limit ต่อ IP/username · ข้อความ error เดียวกันทุกกรณี |
| `admin-actions` | action ที่ต้องเรียก Stripe (cancel subscription, sync ราคา KRW yearly → สร้าง Stripe Price ใหม่) | ตรวจ `admin_roles` ฝั่ง server + audit log |

---

## 5. Auth ใหม่ + Migration บัญชีเดิม
- สมัคร: Email จริง, Username (`^[a-z0-9._-]{3,32}$`, ตรวจซ้ำผ่าน RPC `is_username_available` ที่คืนแค่ true/false), Password (≥ 8, มีตัวอักษร+ตัวเลข), Confirm, Display name · `signUp({options:{data:{username,display_name}, emailRedirectTo}})` · หลังสมัครแสดง "กรุณายืนยันอีเมล" + ปุ่ม Resend
- Login: Email+Password (หลัก) · ช่องเดียวรับได้ทั้ง email/username — ถ้าไม่มี `@` → `username-login`
- Forgot/Reset password, Change password (modal ไม่ใช้ `prompt()`), Change email, Resend verification · เปิด `detectSessionInUrl` + หน้า callback `auth-callback.html`
- บัญชียังไม่ยืนยัน: login ได้แต่สถานะ = Guest-like (ไม่ปลดล็อกอะไร) + แถบเตือน
- **บัญชีเก่า `@kfp.example.com`:** login ด้วย username+password ได้เหมือนเดิม (user id / profile / ข้อมูลเดิมไม่เปลี่ยน) → แถบ "เชื่อมอีเมลจริง" → `auth.updateUser({email})` → ยืนยันจากอีเมลใหม่ (ต้องปิด *Secure email change* — R8) → trigger อัปเดต `profiles.email` และ `is_legacy_email=false` · ระหว่างยังไม่เชื่อม: ใช้ฟีเจอร์ตามสิทธิ์ได้ แต่ **ซื้อแพ็กเกจไม่ได้** จนกว่าจะเชื่อมอีเมล

---

## 6. ไฟล์ที่จะสร้าง / แก้ไข

### สร้างใหม่
| ไฟล์ | Phase |
|---|---|
| `kfp-storage.js` (namespace + preview storage) | 3 |
| `kfp-demo-data.js` (Demo data: KRW 2,500,000 / THB 45,000 / 45-15-25-10-5 / รายจ่าย / ประวัติ / งาน / พอร์ตทอง) | 3 |
| `kfp-access.js` + `kfp-access.css` (requireAuth, canUseFeature, applyPlanVisibility, Preview badge, Auth modal ใหม่) | 3–5 |
| `pricing.html`, `account.html` (Billing), `auth-callback.html`, `admin.html`, `admin.js`, `admin.css`, `kfp-billing.js` | 2, 8, 10 |
| `supabase/migrations/2026111301_saas_core.sql` … (plans, subscriptions, …, RLS, RPC) | 2, 6, 9, 10, 11 |
| `supabase/functions/{create-checkout,create-portal,stripe-webhook,username-login,admin-actions}/index.ts` + `_shared/` | 2, 7, 10 |
| `supabase/config.toml`, `.env.example`, `docs/SETUP.md`, `docs/TESTING.md` | ทุก Phase |
| `tests/` (Playwright e2e ด้วย Supabase mock + SQL tests สำหรับ RLS) | ทุก Phase |

### แก้ไข (เฉพาะจุด ไม่เขียนใหม่)
| ไฟล์ | สิ่งที่แก้ |
|---|---|
| `auth.js` | Email auth, register ใหม่, recovery, change email/password, ส่ง entitlements ให้ `kfp-access.js`, upload ทอง → `user_gold_data`, เตือนก่อน logout ถ้ายังไม่ upload · คง LiquidSpring/สไตล์ปุ่มเดิม |
| `supabase_schema.sql` | คงไว้ + ชี้ไป migrations |
| `pwa-persistence.js` | ปิดใน preview, backup เฉพาะ namespace ปัจจุบัน |
| `index.html`, `gold.html` | เพิ่ม `<script>` ใหม่ (ลำดับ: storage → demo → access), `data-action`, `data-feature`, ลิงก์ Pricing/Account |
| `floating-nav.js` | รองรับ `data-feature` |
| `tools-ui.js` | เพิ่ม `data-action` ใน template ปุ่มบันทึก/ลบ · ซ่อนปุ่ม "บันทึกการเข้างาน" ถ้าไม่มี `work_records` |
| `gold.js` | **ไม่แตะสูตร** · แค่ hook export/upload ผ่าน `window.__kfpRefreshGoldFromCloud` เดิม |
| `sw.js` | ASSETS ใหม่ + bump version · ไม่ cache `admin.html`/Edge Function responses |

---

## 7. Decision Log (ยืนยันแล้ว 13/11/2026)
| # | เรื่อง | ตัดสินใจ |
|---|---|---|
| 7.1 | บัญชีเดิมทุกคนตอนเปิดระบบ | **Premium ฟรี 90 วัน** ผ่าน `user_entitlements` (`reason='legacy_launch'`, มี `expires_at`) แล้วลงเป็น Free · ข้อมูลไม่หาย |
| 7.2 | Cloud บน Free | **ไม่มี Cloud Sync** (ตามสเปก) · ข้อมูล Free อยู่ในเครื่อง · อ่าน/Export ข้อมูล Cloud เก่าของตัวเองได้เสมอ |
| 7.3 | Payment provider | **Stripe ก่อน แต่ DB เป็นกลาง** (`provider` column ทุกตาราง billing) เพื่อเพิ่ม PortOne/Toss/Omise ทีหลัง |
| 7.4 | สภาพแวดล้อม | **Staging Supabase + Stripe test mode ก่อน** แล้วค่อย production |
| 7.5 | Free "Limited History" | (ค่าเริ่มต้น แก้ได้ใน `plans.limits`) เงินเดือนย้อนหลัง 6 เดือน, รายจ่ายดูได้เดือนปัจจุบัน+เดือนก่อน |
| 7.6 | Grace period `past_due` | 7 วัน (แก้ได้ใน `plans.limits.grace_days`) |
| 7.7 | Trial | ไม่มี |
| 7.8 | Admin คนแรก | บัญชีเจ้าของ ใส่ด้วย SQL ครั้งเดียว |

## 8. สิ่งที่ต้องตั้งค่านอกโค้ด (Environment / Dashboard)
**Supabase Dashboard:** Confirm email = ON · Secure email change = OFF (R8) · Custom SMTP (Resend/Brevo/SES) + โดเมนผู้ส่ง (R7) · Site URL + Redirect URLs (`…/auth-callback.html`) · Leaked password protection ON
**Supabase Secrets:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SITE_URL`, (`SUPABASE_SERVICE_ROLE_KEY` มีให้อัตโนมัติใน Edge Functions)
**Stripe:** Products/Prices ×2 plans × (THB เดือน/ปี, KRW เดือน/ปี) · Customer Portal config · Webhook endpoint → `stripe-webhook` · Tax (ถ้าต้องการ)
**ฝั่ง Browser:** ยังใช้แค่ `SUPABASE_URL` + publishable key + Stripe *publishable* key (ถ้าจำเป็น) — ไม่มี secret ใดๆ

## 9. ⚠️ ข้อจำกัดทางธุรกิจที่ต้องรู้ก่อนเลือก Stripe
- Stripe **ไม่รับเปิดบัญชีให้ธุรกิจที่จดในเกาหลี** และการรับ **บัตรเดบิต/เครดิตท้องถิ่นเกาหลี + Kakao/Naver Pay** ทำได้เฉพาะบัญชี Stripe ที่ธุรกิจอยู่ในประเทศที่กำหนด (US, JP, SG, HK, GB, EU ฯลฯ — **ไทยไม่อยู่ในรายการ**) ([Stripe: South Korean payment methods](https://docs.stripe.com/payments/countries/korea))
- ถ้าบัญชี Stripe เป็นของไทย ลูกค้ายังจ่ายด้วยบัตร Visa/Mastercard ต่างประเทศได้ แต่บัตรเกาหลีที่ใช้ได้เฉพาะในประเทศมักจ่ายไม่ผ่าน — กลุ่มลูกค้าหลัก (คนไทยทำงานในเกาหลี) อาจได้รับผลกระทบมาก
- ขายแบบ subscription ให้ลูกค้าเกาหลีต้อง: แจ้งเตือนก่อนตัดเงิน 7 วัน, ขอความยินยอม 30 วันก่อนขึ้นราคา, ยกเลิกง่าย, คืนเงินเต็มภายใน 7 วันถ้ายังไม่ใช้ (ตามหน้าเดียวกัน)
- แผนนี้จะเขียนส่วนชำระเงินแบบ provider-agnostic (ตาราง `subscriptions/payments` ไม่ผูกกับ Stripe ตรงๆ) เพื่อเพิ่ม PortOne/Toss (KRW) หรือ Omise (THB) ทีหลังได้

## 10. แนวทางทดสอบ
- **ทดสอบได้ในเครื่องนี้:** Playwright (Chromium) กับ Supabase client แบบ mock: Preview, Gate, Visibility, Demo isolation, migration ของ LocalStorage · type-check Edge Functions ด้วย TypeScript · ตรวจ SQL แบบ static
- **ทดสอบไม่ได้ในเครื่องนี้ (ต้องทำบนโปรเจกต์จริง/Staging):** รัน SQL/RLS บน Postgres จริง, ส่งอีเมลจริง, Stripe test-mode checkout/webhook, iOS Safari/PWA — จะมี `docs/TESTING.md` เป็น checklist 30 ข้อตามสเปก พร้อม SQL test script ให้รันบน Staging
- แนะนำสร้าง **Supabase project แยกสำหรับ Staging** + Stripe test mode ก่อนแตะโปรเจกต์ production ที่มีลูกค้าอยู่

## 11. ลำดับ Phase (ตามสเปก)
1 ✅ วิเคราะห์ · 2 ✅ Email Auth + Migration บัญชีเก่า · 3 ✅ Preview + Demo Data · 4 ✅ Login Gate · 5 ✅ Plan Visibility · 6 ✅ Subscription DB · 7 ✅ Stripe + Webhooks · 8 Pricing/Billing · 9 Gold Protection · 10 Admin · 11 Activity · 12 Security audit + Full test
หมายเหตุ: Phase 2 ต้องใช้ migration พื้นฐานบางส่วนของ Phase 6 (ตาราง `plans`, `profiles` ใหม่) จึงจะทำ migration core ก่อนใน Phase 2
