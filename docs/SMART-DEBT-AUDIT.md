# Smart Credit & Debt — PHASE 0 Project Audit

> Korea Finance Planner · ตรวจจาก source code จริงใน branch `saas-v2` (commit `ece9af9`, ตรงกับ `origin/main`) และ schema ของ Supabase production (อ่านอย่างเดียว)
> วันที่: 15 พ.ย. 2569 (2026-11-15) · สถานะ: **รอเจ้าของโปรเจกต์อนุมัติ** — Phase นี้ไม่มีการแก้โค้ด ไม่แก้ฐานข้อมูล ไม่ deploy

ข้อกำหนดเพิ่มจากเจ้าของโปรเจกต์ (15/11): **ลูกค้าทั้งฝั่งบาท (ประเทศ = ไทย) และฝั่งวอน (ประเทศ = เกาหลีใต้) ต้องเข้าถึงโมดูลนี้ได้** และใช้ได้ทั้ง THB Workspace และ KRW Workspace ไม่ว่าโปรไฟล์จะตั้งประเทศอะไร

---

## สรุปสั้น

| หัวข้อ | ผลตรวจ | ผลต่อโมดูลใหม่ |
|---|---|---|
| โครงหน้าเว็บ | Static PWA (HTML + vanilla JS) บน GitHub Pages, ไม่มี build step / framework | หน้าใหม่ `credit-debt.html` + JS/CSS แยก แบบเดียวกับ `gold.html` |
| Auth | Supabase Auth (`auth.js`), ต้องยืนยันอีเมล, username login ผ่าน Edge Function | ใช้ของเดิมทั้งหมด |
| Entitlement | คำนวณฝั่ง DB: `kfp_effective_plan` + `kfp_entitlement_bundle` (plan + add-on) → `has_feature()` | เพิ่ม feature key ใหม่ `credit_debt` (Premium) |
| Stripe | Checkout / Portal / Webhook / Add-on มีครบแล้ว | **ไม่ต้องสร้าง billing ใหม่เลย** |
| Gold (ต้นแบบ) | ตารางของตัวเอง + RPC + optimistic version; **SELECT ถูกล็อกเมื่อหมด Premium** | ใช้แนวทางเดียวกัน **ยกเว้น** ต้องเปิด SELECT ให้คนหมดอายุ (read-only) |
| Cloud Sync เดิม | JSON blob ก้อนเดียวใน `user_data` (เขียนได้เฉพาะ `cloud_sync`) | **ห้ามเก็บหนี้ใน blob นี้** → ใช้ตาราง relational ใหม่ |
| Staging | ไม่มี staging project / staging site | ต้องตัดสินใจก่อน Phase 3 (ดูข้อ 13.1) |
| ภาษา | ไม่มี language system (ทั้งเว็บ `lang="th"`, ข้อความไทย + ศัพท์อังกฤษ) | ใช้ไทยเป็นหลักแบบเดิม (ดูข้อขัดแย้ง C3) |

---

## 1. Existing Architecture

### 1.1 Repository และ deploy

* Branch ทำงาน: `saas-v2` → push แบบ fast-forward ไป `main` = **production** (GitHub Pages, โดเมน `planer.com.de` ผ่าน `CNAME`)
* Git status สะอาด, `saas-v2` = `origin/main` = `ece9af9`
* Backend: Supabase project `yelkgtddtuugzoyzvqug` (Postgres 17) + Edge Functions (Deno): `create-checkout`, `create-portal`, `billing-action`, `stripe-webhook`, `admin-actions`, `username-login`
* Migrations: `supabase/migrations/2026111…0050` ถึง `…1600` (17 ไฟล์, additive + re-runnable ทั้งหมด) · รวมเป็น `supabase/install_all.sql` ด้วย `tools/build-install-sql.sh`

### 1.2 หน้าเว็บ

| หน้า | หน้าที่ | ไฟล์หลัก |
|---|---|---|
| `index.html` | เครื่องคิดเงินเดือน, แบ่งเงิน, ประวัติเงินเดือน, สถิติ, สัญญาจ้าง, เป้าหมาย, เครื่องมือ (รายจ่าย / บันทึกการเข้างาน) | `script.js` (1,709 บรรทัด), `kfp-config.js`, `alloc-ui.js`, `tools-ui.js`, `kfp-country.js`, `kfp-digest.js` |
| `gold.html` | พอร์ตทอง (Premium) | `gold.js` (2,396), `gold.css`, `kfp-gold-sync.js` |
| `pricing.html` | แพ็กเกจ + Add-on → Stripe Checkout | inline script |
| `account.html` | แพ็กเกจของฉัน, ใบเสร็จ, ยกเลิก/ต่ออายุ, Add-on | inline script |
| `admin.html` | Admin Console (owner/admin/viewer) | `admin.js`, `admin.css` |
| `auth-callback.html` | ยืนยันอีเมล / reset password | inline |

### 1.3 สคริปต์ที่ใช้ร่วมกันทุกหน้า (ลำดับโหลดสำคัญ)

1. `kfp-guard.js` (head) — viewport ไม่ซูม, กันคลิกขวา
2. `supabase-config.js` → `kfp-demo-data.js` → **`kfp-storage.js`** (ต้องมาก่อนสคริปต์ข้อมูลทั้งหมด)
3. `supabase-js@2.97.0` (CDN) → `pwa-persistence.js` → `auth.js`
4. สคริปต์ของหน้า → `kfp-access.js` (สิทธิ์/ล็อกปุ่ม) → `kfp-badge.js` (ป้ายมุมซ้าย)
5. `floating-nav.js` (ปุ่มลอยไปหน้าอื่น), `kfp-motion.*`, `kfp-bfcache.js`

### 1.4 Local / Guest data

* `kfp-storage.js` แทนที่ `window.localStorage`:
  * **Preview (ยังไม่ login)**: ข้อมูลส่วนตัวอยู่ในหน่วยความจำ + demo data, รีโหลดแล้วหาย
  * **Member**: คีย์ส่วนตัวถูกแยกเป็น `kfp:u:<user_id>:<key>`
  * คีย์สาธารณะ (เรตเงิน, cache ราคาทอง, ตำแหน่งปุ่ม) อยู่แบบเดิม
* ข้อสรุป: โมดูลหนี้ **ไม่ควรมีโหมด guest ที่บันทึกได้** (ต้อง login + Premium) แต่ preview แบบ demo data ได้

### 1.5 PWA

* `sw.js` cache ชื่อ `korea-finance-pwa-20261115-saas18`, precache รายชื่อไฟล์ใน `ASSETS`, cache-busting ด้วย `?v=`
* หน้าใหม่ต้องเพิ่มไฟล์ใน `ASSETS` และ bump `CACHE_NAME`
* **ห้าม cache** การตอบกลับของ Supabase REST/RPC (ข้อมูลการเงินส่วนตัว) — ตอนนี้ SW cache เฉพาะ host ราคาทอง/เรตเงิน (ถูกต้องแล้ว)

### 1.6 ระบบที่เพิ่งเปลี่ยน (เกี่ยวข้องกับโมดูลนี้)

* **ประเทศกำหนดหน้า index** (`kfp-country.js`): TH = บาทล้วน, KR = วอน + บาท, ซ่อนปุ่มสลับ ₩/฿
* **Free limits / Add-ons / Monthly digest** (migration 1500–1600)
* ผลต่อโมดูลหนี้: หน้าใหม่ **ต้องไม่ใช้ `kfp_mode_v1` / `kfpGetMode()`** เพราะต้องเปิดได้ทั้งสองสกุลเงิน (ดูข้อ 10)

---

## 2. Gold Module Architecture (ต้นแบบ)

| ส่วน | วิธีที่ Gold ทำ |
|---|---|
| ทางเข้า | ปุ่มลอย `floating-nav.js` บน `index.html` (`data-target="gold.html" data-feature="gold_portfolio"`) → ซ่อนเมื่อไม่มีสิทธิ์ · บน gold มีปุ่มลอยกลับ `index.html` |
| หน้า | `gold.html` แยกเต็มหน้า, โหลดสคริปต์ชุดเดียวกับ index (storage → auth → access → badge) |
| ล็อกเมื่อไม่มีสิทธิ์ | `kfp-access.js › buildGoldGate()` ใส่ `data-feature="gold_portfolio"` ที่ `.gold-container` และแทรก upsell card `data-feature-off` → CSS ซ่อน/แสดงตาม `html[data-feat-*]` |
| ล็อกปุ่มเขียน | ตาราง `GATES` ใน `kfp-access.js` ดัก click/submit แบบ capture-phase แล้วเปิด upsell |
| ข้อมูล | ตาราง `user_gold_data` (1 แถวต่อคน, `lots jsonb` + `settings jsonb` + `version`) |
| อ่าน | `get_my_gold()` + RLS SELECT `auth.uid() = user_id and has_feature('gold_portfolio')` |
| เขียน | `save_my_gold(p_lots, p_settings, p_base_version)` — ตรวจ Premium, validate, **optimistic concurrency** (`version`) |
| ไม่มี grant เขียนตรง | `revoke all … from anon, authenticated; grant select …` |
| ข้อมูลในเครื่อง | `kfp-gold-sync.js` เก็บสำเนาใน localStorage (ต่อบัญชี), debounce push, conflict → ให้สมาชิกเลือก |
| หมดสิทธิ์ | ข้อมูล **ไม่ถูกลบ** แต่ **อ่านไม่ได้** จนกลับมาเป็น Premium |

**สิ่งที่นำมาใช้:** หน้าแยก, ทางเข้าด้วย floating nav/ปุ่มบน index, ไม่มี grant เขียนตรง, เขียนผ่าน RPC ที่ตรวจสิทธิ์, optimistic version, ไม่ลบข้อมูลเมื่อหมดสิทธิ์

**สิ่งที่ต้องต่าง:**

* Gold ซ่อนข้อมูลเมื่อหมดสิทธิ์ แต่หนี้ต้อง **อ่านได้ตลอด (read-only)** → RLS SELECT ต้องไม่ตรวจ feature
* Gold เป็น JSON ก้อนเดียว, หนี้ต้องมีความสัมพันธ์ (บัตร ↔ งวดผ่อน ↔ การชำระ ↔ การโอน) และ atomic transaction → ใช้ **ตาราง relational**
* Gold เก็บ local copy เป็นหลักแล้ว sync, หนี้ควรให้ **server เป็น source of truth** (เก็บ cache ในเครื่องเพื่ออ่านออฟไลน์อย่างเดียว)

---

## 3. Authentication

* Supabase Auth (email + password), อีเมลต้องยืนยัน, username login ผ่าน Edge Function `username-login`
* `profiles` (1:1 กับ `auth.users`): `username`, `nickname`, `country` (TH/KR), `suspended_at`, `is_legacy_email`, …
* Browser มีสิทธิ์ UPDATE แค่ `nickname`, `country`
* Role ทีมงาน: `admin_roles` (owner/admin/viewer), `kfp_require_admin()`, ทุก action ของ admin ลง `admin_audit_logs`
* ข้อสรุป: **ใช้ `auth.uid()` เป็น owner ของทุกแถว**, ไม่ต้องแก้ auth

---

## 4. Subscription Entitlement

### 4.1 แหล่งความจริง

```
subscriptions (Stripe webhook)  ┐
user_entitlements (grants)      ┴→ kfp_effective_plan(uid)   → plan หลัก (kind = 'plan')
                                   kfp_active_addons(uid)    → add-on ที่ยังใช้ได้
                                   kfp_entitlement_bundle()  → features (OR) + limits
                                   kfp_has_feature(uid, key) → ใช้ใน RPC / RLS (service)
                                   has_feature(key)          → auth.uid() (browser / RLS)
                                   get_my_entitlements()     → payload ให้หน้าเว็บ
```

### 4.2 กติกาเดิมเทียบกับ requirement (PART 6)

| Requirement | ระบบเดิม | ผล |
|---|---|---|
| Active = Full | `status in (active, trialing)` และ `current_period_end > now()` | ✅ |
| Cancelled แต่ยังอยู่ใน paid period = Full | ยกเลิก = `cancel_at_period_end = true`, status ยัง `active` จนจบงวด | ✅ ไม่ดูสถานะ cancelled อย่างเดียว |
| แยกวันยกเลิก vs วันหมดสิทธิ์ | `subscriptions.canceled_at` / `cancel_at_period_end` vs `current_period_end` (= `valid_until`) | ✅ มีครบ แสดงได้ทั้งคู่ |
| Payment failed → grace | `past_due` ได้ต่อ `limits.grace_days` วัน (Premium = 7) | ✅ |
| หมดงวด = Read-only | effective plan ไม่มีสิทธิ์ → `has_feature` = false | ✅ (โมดูลใหม่แปลงเป็น read-only) |
| สมัครใหม่ = Full ทันที | webhook → `kfp_apply_subscription` → entitlement คำนวณสด ไม่มี cache | ✅ |
| Admin ตรวจสถานะได้ | `admin_user_detail` / `kfp_access_snapshot` | ✅ |
| ทีมงาน (owner/admin/viewer) | staff grant = Premium ไม่จำกัด | ✅ ได้ Full |
| ถูกระงับ (suspended) | effective plan = free | ➜ read-only (ข้อมูลของตัวเอง) |

### 4.3 สามสถานะของโมดูล

ระบบเดิมไม่มีธง "เคยเป็น Premium" และ **สมาชิกเดิมทุกคนเคยได้ Premium 90 วันช่วงเปิดระบบ** (`legacy_launch`) จึงใช้ประวัติ Premium แยกไม่ได้จริง เสนอให้ตัดสินจาก **ข้อมูลที่มีอยู่**:

| สถานะ | เงื่อนไข (คำนวณฝั่ง server) | หน้าจอ |
|---|---|---|
| `full` | `kfp_has_feature(uid, 'credit_debt')` | ใช้งานครบ |
| `read_only` | ไม่มี feature **และ** มีข้อมูลหนี้ของตัวเองอย่างน้อย 1 แถว | ดู/ค้นหา/กรอง/Export ได้, เขียนไม่ได้ |
| `locked` | ไม่มี feature และไม่มีข้อมูล | หน้าแนะนำ + ราคา + ปุ่มอัปเกรด (+ demo preview) |

RPC ใหม่ `get_my_debt_access()` คืนค่า `{ mode, plan, premium_until, cancel_at_period_end, canceled_at, grace_until }` ให้หน้าเว็บแสดง badge และวันหมดอายุ **แต่หน้าเว็บใช้เพื่อแสดงผลเท่านั้น** การบังคับจริงอยู่ที่ RPC เขียนทุกตัว

---

## 5. Stripe Billing

* Checkout: `create-checkout` → `createCheckout()` ใน `_shared/billing.ts` (plan + add-on, idempotency key ต่อนาที)
* จัดการบิล: `create-portal` (manage / payment_method / switch), `billing-action` (cancel/resume ของตัวเอง)
* Webhook: `stripe-webhook` → re-fetch ทุก object → `kfp_apply_subscription / invoice / refund` (idempotent ด้วย `stripe_webhook_events`)
* ราคาอยู่ใน `plan_prices` (admin แก้ได้), product/price ใน Stripe สร้างอัตโนมัติ
* **ข้อสรุป:** โมดูลหนี้ไม่ต้องแตะ Stripe เลย — แค่เพิ่ม `credit_debt: true` ให้ Premium ทุกอย่างก็ทำงานตาม billing เดิม ปุ่ม Upgrade ชี้ไป `pricing.html#premium`

---

## 6. Supabase Schema (production, อ่านเมื่อ 15/11)

18 ตารางใน `public` (RLS เปิดทุกตาราง): `profiles`, `user_data`, `plans` (9 แถว: 3 plan + 6 add-on), `plan_prices`, `user_entitlements`, `subscriptions`, `billing_customers`, `payments`, `payment_refunds`, `stripe_webhook_events`, `admin_roles`, `admin_audit_logs`, `rate_limits`, `user_activity`, `user_activity_daily`, `admin_analytics_cache`, `user_gold_data`, `user_gold_legacy_raw`

**ยังไม่มีตารางหรือโค้ดเกี่ยวกับบัตรเครดิต/หนี้เลย** (grep ทั้ง repo แล้ว) → ไม่มีอะไรต้อง migrate

Helper ที่ใช้ต่อได้:

* `kfp_currency_exponent(cur)` (KRW = 0, THB = 2) → เก็บเงินเป็น `bigint` หน่วยย่อย
* `touch_kfp_updated_at()` trigger, `kfp_rate_hit()` rate limit
* `kfp_audit()` / `admin_audit_logs` สำหรับ admin override
* `kfp_security_report()` self-check (ต้องเพิ่ม RPC ใหม่ใน allowlist)

---

## 7. RLS (สภาพปัจจุบัน)

* Migration 1300 revoke default privileges → ตารางใหม่ **ไม่มีสิทธิ์อะไรเลย** จนกว่าจะ grant เอง (ปลอดภัยโดยค่าเริ่มต้น)
* รูปแบบเดิม:
  * `user_data`: SELECT ของตัวเอง, INSERT/UPDATE ต้อง `has_feature('cloud_sync')`
  * `user_gold_data`: SELECT ต้อง `has_feature('gold_portfolio')`, ไม่มีสิทธิ์เขียนตรง (ผ่าน RPC)
  * ตาราง billing: browser อ่านผ่าน RPC `get_my_billing()` เท่านั้น
* `kfp_security_report()` ตรวจ: ตารางไม่มี RLS, definer ไม่มี search_path, definer ที่ anon/authenticated เรียกได้แต่ไม่อยู่ใน allowlist, grant เขียนให้ authenticated → production ตอนนี้ **0 findings**

---

## 8. Cloud Sync

* ข้อมูลหน้า index (เงินเดือน, รายจ่าย, บันทึกงาน) = localStorage ต่อบัญชี → push เป็น JSON ก้อนเดียวใน `user_data.data` (เฉพาะคนมี `cloud_sync`: Plus/Premium/Add-on)
* มี tombstone (`kfpClearDeleted`), merge ตาม key, guest data import
* Gold แยกออกไปตารางของตัวเองแล้ว (Phase 9) เพราะต้องล็อกตาม Premium

**ข้อเสนอ: ไม่เพิ่ม namespace หนี้ใน `user_data`** เพราะ:

1. RLS ของ blob ล็อกได้แค่ทั้งก้อน — ทำ "อ่านได้แต่เขียนไม่ได้เฉพาะส่วนหนี้" ไม่ได้
2. การโอนหนี้ / ชำระต้อง atomic หลายแถว ซึ่ง blob ทำไม่ได้
3. ใครก็ตามที่มี `cloud_sync` (Plus หรือ Free + Add-on Cloud Sync) เขียน blob ได้ → คนที่ไม่ใช่ Premium จะเขียนข้อมูลหนี้ผ่าน blob ได้ = ช่องทาง bypass

→ ตารางใหม่ = sync ข้ามเครื่องในตัว (server เป็นความจริง), ไม่ต้องพึ่ง `cloud_sync`

---

## 9. Recommended Credit & Debt Architecture

### 9.1 ไฟล์ (เพิ่มใหม่เท่านั้น)

```
credit-debt.html          หน้าใหม่ (โครงเดียวกับ gold.html: storage → auth → access → badge)
credit-debt.css           สไตล์เฉพาะ (ใช้ theme.css / kfp-motion.css เดิม)
debt-core.js              state, API (เรียก RPC), สิทธิ์ (mode), เงิน (minor units), escape
debt-dashboard.js         Overview + Analytics
debt-cards.js             บัตรเครดิต
debt-installments.js      ผ่อน + installment engine (สร้างงวด)
debt-transfers.js         โอนหนี้
debt-payments.js          บันทึกการชำระ
debt-calendar.js          ปฏิทิน (เดือน/สัปดาห์/รายการ)
debt-planner.js           Snowball / Avalanche / Custom
```

ไฟล์เดิมที่ต้องแตะ **เล็กน้อย** (เฉพาะจุด):

* `index.html` — ทางเข้า (ดู 9.2)
* `kfp-access.js` — เพิ่ม `credit_debt` ใน `FEATURES`, label, plan
* `kfp-access.css` — กฎ `data-feat-credit_debt`
* `pricing.html` — แถว "Smart Credit & Debt" ใน Premium
* `sw.js` — ASSETS + cache name
* `admin.js` — (ทางเลือก) แสดงจำนวนบัตร/หนี้ของสมาชิกแบบสรุป ไม่แสดงรายละเอียด

**ไม่แตะ:** `script.js`, `gold.js`, `kfp-gold-sync.js`, `auth.js` (ยกเว้นเพิ่มลิงก์เมนู), `kfp-storage.js` keys, `_shared/billing.ts`

### 9.2 ทางเข้า (Navigation)

`floating-nav.js` รองรับปลายทางเดียวต่อหน้า (ตอนนี้ index → gold) ตัวเลือก:

* **A (แนะนำ):** ปุ่มการ์ด "💳 Smart Credit & Debt · PREMIUM" บน `index.html` + ลิงก์ในป๊อปอัพโปรไฟล์ (ใต้ปุ่ม Admin Console) — ไม่แตะ floating nav
* B: ขยาย floating nav เป็นเมนูหลายปลายทาง (กระทบ gold + index มากกว่า)

ปุ่มแสดงให้ทุกคนที่ login (Free เห็นพร้อม badge PREMIUM แล้วเข้าไปเจอหน้าแนะนำ) · หน้า `credit-debt.html` มีปุ่มลอยกลับ `index.html` เหมือน gold

### 9.3 Data flow

```
หน้าเว็บ ──select──▶ ตาราง debt_* (RLS: เฉพาะของตัวเอง, อ่านได้ทุกสถานะ)
        ──rpc────▶ debt_* write RPCs (SECURITY DEFINER)
                      ├─ kfp_has_feature(uid,'credit_debt') ไม่ผ่าน → error 'premium_required'
                      ├─ validate + ownership ทุก FK
                      ├─ idempotency (client_request_id)
                      ├─ optimistic version
                      └─ ทำทั้งหมดใน transaction เดียว
```

ไม่ต้องมี Edge Function ใหม่ (ไม่มี secret/บริการภายนอก)

---

## 10. THB / KRW Workspace Design

**ข้อกำหนดเพิ่ม:** ลูกค้าบาทและลูกค้าวอนเข้าถึงได้ทั้งคู่

* หน้า `credit-debt.html` **ไม่ผูกกับประเทศของโปรไฟล์และไม่อ่าน `kfp_mode_v1`**
* แท็บด้านบน: `ภาพรวม` · `฿ THB` · `₩ KRW` — เปิดได้ทุกแท็บทุกคน
* แท็บเริ่มต้น: ประเทศไทย → `฿ THB`, เกาหลีใต้ → `₩ KRW`, ไม่มีประเทศ → `ภาพรวม` (จำแท็บล่าสุดไว้ในเครื่อง)
* **สกุลเงินเป็นคุณสมบัติของบัตร** (`credit_cards.currency`) — รายการผ่อน/ชำระ/โอนสืบทอดสกุลเงินจากบัตร
* Workspace = component ชุดเดียว + filter `currency` (ไม่ duplicate code)
* Overview: แสดงสองกล่องแยก (`ยอดหนี้ THB`, `ยอดหนี้ KRW`) **ไม่บวกข้ามสกุล**
* ยอดรวมแบบแปลง (เลือกเปิดเอง): ต้องแสดง base currency, rate, แหล่ง (frankfurter / ผู้ใช้กรอก), วันที่ของเรต, ยอดที่แปลง · ค่าที่แสดงเป็นการคำนวณชั่วคราว ไม่เขียนกลับประวัติ
* FX snapshot เก็บถาวรเฉพาะเมื่อมีธุรกรรมข้ามสกุล (โอนหนี้ THB ↔ KRW) โดยผู้ใช้กรอก **ยอดปลายทางและเรตเอง** แล้วบันทึกในแถว `debt_transfers` (`fx_rate`, `fx_source`, `fx_date`, `dest_amount_minor`)
* หน้า index ที่ถูกล็อกตามประเทศ **ไม่เปลี่ยน** — การแปลงข้อมูลตอนเปลี่ยนประเทศ (`kfp-country.js`) **ต้องไม่แตะข้อมูลหนี้** (ข้อมูลหนี้ไม่อยู่ใน localStorage key ที่ไฟล์นั้นแปลงอยู่แล้ว)

---

## 11. Premium Read-only Enforcement

### Backend (ตัวบังคับจริง)

1. ตาราง `debt_*`: `revoke all from anon, authenticated` → `grant select to authenticated` → policy `for select using (user_id = auth.uid())` (**ไม่ตรวจ feature** เพื่อให้คนหมดอายุอ่านได้)
2. **ไม่มี** INSERT/UPDATE/DELETE grant ให้ browser เลย (เข้มกว่า RLS write policy และกันการเรียก REST ตรง)
3. การเขียนทั้งหมดผ่าน RPC `SECURITY DEFINER` + `set search_path = public` ที่ขึ้นต้นด้วย `perform kfp_require_debt_write()`:
   * `auth.uid()` ไม่ว่าง
   * `kfp_has_feature(uid, 'credit_debt')` (รวม grace, staff, ระงับบัญชี)
   * rate limit (`kfp_rate_hit`)
4. ทุก FK ตรวจ `user_id = auth.uid()` (กันอ้างบัตรของคนอื่น)
5. Export = `export_my_debt()` อ่านอย่างเดียว (`stable`) ใช้ได้ทุกสถานะที่มีข้อมูล
6. Admin override (ถ้าจำเป็น) = RPC แยก `kfp_require_admin('admin')` + `kfp_audit()` เท่านั้น
7. เพิ่ม RPC ใหม่ทุกตัวใน allowlist ของ `kfp_security_report()` และทดสอบว่า report = 0

### Frontend (UX เท่านั้น)

* `mode` จาก `get_my_debt_access()` → `html[data-debt-mode="full|read_only|locked"]`
* read_only: ซ่อน/disable ปุ่ม Add/Edit/Delete/Save/Record payment, แสดง badge "อ่านอย่างเดียว · Premium หมดอายุ <วันที่>" + ปุ่มต่ออายุ
* พยายามเขียน (ปุ่มที่ยังเห็น/ทางลัด) → Upgrade Modal ตามข้อความ PART 8 · **ไม่แสดง popup ตอนแค่เปิดดู**
* ถ้า RPC ตอบ `premium_required` (เช่นสิทธิ์หมดระหว่างใช้งาน) → สลับเป็น read_only ทันที + modal

---

## 12. Database Migration Plan (ร่าง — ยังไม่สร้าง)

Migration ใหม่ไฟล์เดียว `20261116001700_smart_debt.sql` (additive, idempotent, ไม่ drop ของเดิม)

### 12.1 Feature

```sql
update plans set features = features || jsonb_build_object('credit_debt', id = 'premium')
where kind = 'plan';
```

### 12.2 ตาราง (ทุกตาราง: `user_id uuid not null references auth.users on delete cascade`, `created_at`, `updated_at` + trigger, `version bigint`)

| ตาราง | คอลัมน์หลัก | Constraints |
|---|---|---|
| `credit_cards` | name, bank, country, currency, last4, credit_limit_minor, statement_day, due_day, apr_bp, color, icon, notes, status (active/archived) | `currency in ('THB','KRW')`, `last4 ~ '^\d{4}$'`, วัน 1–31, ยอด ≥ 0, unique (user_id, client_request_id) |
| `card_balance_snapshots` | card_id, statement_date, statement_balance_minor, source (manual/reconcile) | ใช้ reconcile กับใบแจ้งยอดจริง |
| `installment_plans` | card_id, product, category, merchant, purchase_date, original/down/financed_minor, rate_bp, method (zero/fixed/reducing/custom), months, monthly_minor, first_due, status | FK บัตรของคนเดียวกัน, months 1–120 |
| `installment_schedules` | plan_id, seq, due_date, principal/interest/fee_minor, status (due/paid/partial/skipped/cancelled), is_estimate | **unique (plan_id, seq)** กันงวดซ้ำ |
| `debt_transfers` | type, from_card_id, to_card_id, amount_minor, fee_minor, rate_bp, installments, transfer_date, effective_date, status (draft/pending/confirmed/failed/cancelled), fx_rate, fx_source, fx_date, dest_amount_minor, related_id | ลดหนี้ต้นทางเฉพาะตอน confirmed |
| `debt_payments` | card_id / plan_id / transfer_id, kind, amount/principal/interest/fee_minor, paid_on, method, status | อย่างน้อยหนึ่ง FK, ไม่สร้างรายจ่ายสินค้า |
| `debt_adjustments` | card_id, amount_minor (+/−), reason, effective_date | manual reconciliation |
| `debt_payoff_plans` | name, strategy (snowball/avalanche/custom), budget_minor, currency, priorities jsonb, result jsonb, assumptions jsonb | แผนที่บันทึก |
| `debt_reminders` | (Phase หลัง) | — |

* เงินทุกช่องเป็น `bigint` หน่วยย่อย (KRW วอน, THB สตางค์) ตาม `plan_prices.amount_minor`
* Index: `(user_id, currency)`, `(user_id, due_date)`, `(card_id)`, `(plan_id, seq)`
* **ยอดหนี้บัตรเป็นค่าคำนวณ** (view `v_card_balances` = ยอดตั้งต้น/reconcile + ซื้อ/ผ่อนที่ถึงงวด + โอนเข้า − ชำระ − โอนออก (confirmed)) ไม่เก็บซ้ำ → กันนับหนี้ซ้ำ
* ยอดผ่อน: ใส่ในยอดบัตรเฉพาะงวดที่ถึงกำหนด (หรือแบบ "กันวงเงินเต็มจำนวน" — ต้องเลือกใน spec)

### 12.3 RPC (ร่างรายชื่อ)

`get_my_debt_access`, `debt_save_card`, `debt_archive_card`, `debt_delete_card` (เฉพาะไม่มีข้อมูลอ้างอิง), `debt_save_installment` (สร้างงวดใน transaction, แก้ไขแล้วเก็บประวัติเดิม), `debt_record_payment`, `debt_create_transfer`, `debt_confirm_transfer` (atomic), `debt_cancel_transfer`, `debt_add_adjustment`, `debt_save_payoff_plan`, `export_my_debt`

ทุก write RPC รับ `p_client_request_id uuid` (กดซ้ำ / retry / sync ซ้ำ → ได้ผลเดิม ไม่สร้างแถวใหม่) และ `p_base_version` (กันสองเครื่องแก้ทับกัน)

### 12.4 Rollback

* Migration ไม่แก้ตาราง/ฟังก์ชันเดิมนอกจาก `plans.features` (เพิ่ม key) และ `kfp_security_report` (allowlist)
* ถอยกลับ: `update plans set features = features - 'credit_debt'` + ลบปุ่มทางเข้า → ระบบเดิมทำงานเหมือนก่อน · ตาราง `debt_*` เก็บไว้ (ไม่ drop เพื่อไม่ทำข้อมูลหาย) หรือ drop ได้เฉพาะตอนยังไม่มีผู้ใช้จริงและเจ้าของอนุมัติ

---

## 13. Security Risks

| # | ความเสี่ยง | การป้องกัน |
|---|---|---|
| R1 | เรียก REST `/rest/v1/debt_*` ตรงเพื่อเขียน | ไม่มี grant เขียนเลย + RLS |
| R2 | เชื่อสถานะ Premium จากหน้าเว็บ | ทุก write RPC เรียก `kfp_has_feature` เอง |
| R3 | อ้าง `card_id` ของคนอื่นใน RPC | ตรวจ ownership ทุก FK ใน RPC |
| R4 | กดซ้ำ / เน็ตหลุดแล้ว retry → รายการซ้ำ | `client_request_id` unique |
| R5 | สองเครื่องแก้พร้อมกัน | `version` + `p_base_version` (แบบ gold) |
| R6 | โอนหนี้ไม่ครบ (ลดต้นทางแต่ไม่เพิ่มปลายทาง) | ทำใน RPC เดียว = transaction เดียว, ลดหนี้เฉพาะ confirmed |
| R7 | XSS จากชื่อบัตร/หมายเหตุ | escape ทุก output (`esc()` แบบเดิม), จำกัดความยาว |
| R8 | เก็บเลขบัตรเต็ม / CVV / PIN | schema มีแค่ `last4` (check `^\d{4}$`), ไม่มีช่องอื่น, ฟอร์มไม่ถาม |
| R9 | Admin เห็นข้อมูลการเงินละเอียด | Admin Console แสดงแค่จำนวน (cards/plans) ไม่แสดงรายการ |
| R10 | SW cache ข้อมูลส่วนตัว | ไม่ cache Supabase API (ตามเดิม) |
| R11 | ข้อมูลหายเมื่อหมดอายุ | ไม่มี job ลบ, `on delete cascade` เฉพาะตอนลบบัญชี |
| R12 | Floating-point ปัดเศษผิด | bigint หน่วยย่อย, คำนวณงวดใน SQL/JS ด้วยจำนวนเต็ม |
| R13 | ข้อจำกัดของ `kfp-guard.js` (กันคลิกขวา) ไม่ใช่ความปลอดภัย | ทุกสิทธิ์บังคับที่ DB อยู่แล้ว |

### 13.1 ข้อขัดแย้ง / สิ่งที่ต้องตัดสินใจ (ขอให้เจ้าของโปรเจกต์เลือก)

| # | ประเด็น | รายละเอียด | ข้อเสนอ |
|---|---|---|---|
| C1 | **ไม่มี Staging** | ตอนนี้มีแค่ production Supabase + GitHub Pages (main = production) | (ก) Supabase Branching (ต้องเป็นแพ็กเกจ Pro) หรือ (ข) สร้างโปรเจกต์ Supabase ฟรีแยกเป็น staging + เปิดหน้าเว็บจาก branch ด้วย Cloudflare/Netlify preview หรือ (ค) ทดสอบด้วย Postgres ในเครื่อง + mock (ชุดทดสอบเดิมรองรับแล้ว) แล้วค่อยขึ้น production หลังอนุมัติ |
| C2 | ทำงานที่ผ่านมาบน production โดยตรง | Prompt นี้ห้ามแตะ production จนกว่าจะอนุมัติ | ทุก Phase ต่อจากนี้ทำบน branch `credit-debt` + staging ตาม C1, ไม่ merge เข้า `main` จนกว่าจะอนุมัติ |
| C3 | "ภาษาไทยและอังกฤษตาม Language System เดิม" | **ไม่มี language system** ทั้งเว็บเป็นภาษาไทย + ศัพท์อังกฤษ | ใช้ไทยเป็นหลักเหมือนเดิม (ชื่อเมนูอังกฤษตามที่ระบุ) · ระบบสองภาษาเป็นงานแยกในอนาคต |
| C4 | "เคย Premium" vs "ไม่เคย" | สมาชิกเดิมทุกคนเคยได้ Premium 90 วัน (legacy) | ใช้ "มีข้อมูลหนี้หรือไม่" ตัดสิน (ข้อ 4.3) |
| C5 | Add-on | ระบบ add-on เพิ่งเพิ่ม (6 ตัว) | ตอนนี้ Premium เท่านั้น ตาม prompt · ถ้าต้องการขายแยกภายหลัง เพิ่มแถว `addon_debt` ได้โดยไม่แก้โค้ด |
| C6 | ยอดผ่อนในยอดหนี้บัตร | ธนาคารบางแห่งกันวงเงินเต็ม บางแห่งคิดเฉพาะงวด | ให้เลือกต่อบัตรใน Phase 1 spec |
| C7 | ลบบัตร | requirement ให้ลบได้เมื่อไม่มีข้อมูลอ้างอิง | ถ้ามีประวัติ → Archive แทน (ไม่ลบประวัติการเงิน) |
| C8 | Monthly digest | Premium มีป๊อปอัพสรุปรายเดือนแล้ว | ภายหลังเพิ่ม "งวดที่ต้องจ่ายเดือนนี้" ใน digest ได้ (ไม่อยู่ในขอบเขตแรก) |

---

## 14. Implementation Roadmap

| Phase | งาน | ผลลัพธ์ | แตะ production? |
|---|---|---|---|
| 0 ✅ | Audit (เอกสารนี้) | `docs/SMART-DEBT-AUDIT.md` | ไม่ |
| 1 | Spec | `SMART-DEBT-SPEC.md`, `SMART-DEBT-DATABASE.md`, `SMART-DEBT-ACCESS-CONTROL.md` — สูตรผ่อน (0% / fixed / reducing / custom), กติกายอดหนี้ (C6), สถานะธุรกรรม, ข้อความ UX | ไม่ |
| 2 | UI | `credit-debt.html` + ทุกแท็บ (Overview / THB / KRW / Cards / Installments / Transfers / Payments / Calendar / Planner) ด้วย mock data ใน preview, ทดสอบมือถือ, สถานะ loading/empty/error/success/read-only/upgrade | ไม่ |
| 3 | DB & Security | migration + RLS + RPC บน **staging** (C1), SQL tests ชุดใหม่ (Premium active / expired / never / suspended / cross-user / REST ตรง) | ไม่ |
| 4 | Business logic | installment engine, transfer engine (atomic), payment engine, dashboard, calendar, planner, export | ไม่ |
| 5 | Subscription integration | `credit_debt` ใน Premium, ทดสอบเปลี่ยนสถานะ (active → cancel ในงวด → หมดงวด → สมัครใหม่, past_due grace) | ไม่ |
| 6 | QA | test case 1–32 ตาม PART 20 + regression ของเดิมทั้งหมด (ชุด e2e phase 2–15 ที่มีอยู่ ~560 รายการ) | ไม่ |
| 7 | Staging acceptance | `SMART-DEBT-TEST-REPORT.md` → **รออนุมัติ** → merge `main` + apply migration production | หลังอนุมัติเท่านั้น |

### ชุดทดสอบที่มีอยู่และจะใช้ต่อ

* `tests/run-sql-tests.sh` (Postgres จริง, phase 2–15), `tests/run-fresh-install.sh` (ติดตั้งใหม่ + replica prod + security report)
* `tests/run-edge-tests.sh` (billing / admin กับ Postgres จริง + Stripe ปลอม)
* `tests/e2e/phase*.test.js` (Playwright + `mock-supabase.js`)
* `node tests/security/static-audit.js`

---

**จบ Phase 0 — หยุดรอการอนุมัติ** โดยเฉพาะข้อ C1 (staging), C2 (branch), C6 (วิธีนับยอดผ่อน) และทางเข้าข้อ 9.2
