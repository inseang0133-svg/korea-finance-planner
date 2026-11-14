# Phase Log

## Phase 1 · วิเคราะห์ระบบเดิม ✅ (13/11/2026)
- **ไฟล์ที่สร้าง:** `docs/SAAS_PLAN.md`
- **ไฟล์ที่แก้:** ไม่มี
- **ผลลัพธ์:** แผนทั้งระบบ, ตารางปุ่ม Action, ความเสี่ยง R1–R9, Decision Log (ยืนยันแล้ว)
- **Spike test:** แทน `window.localStorage` ด้วย storage ของเราเองได้ใน Chromium (สคริปต์เดิมไม่ต้องแก้) → ใช้เป็นแกนของ Preview Mode · ต้องทดสอบซ้ำบน iOS Safari ใน Phase 3

## Phase 2 · Email Authentication + Migration บัญชีเดิม ✅ (13/11/2026)

### ไฟล์ที่สร้าง
| ไฟล์ | หน้าที่ |
|---|---|
| `supabase/migrations/20261113000100_saas_core_auth.sql` | profiles (email, legacy flag, verified, activity cols), column-level grants, trigger สมัครใหม่ที่ไม่ fail, sync อีเมลจาก auth.users, `is_username_available()`, `plans` + seed 3 แพ็กเกจ, `user_entitlements` |
| `supabase/migrations/20261113000200_legacy_launch_grant.sql` | Premium 90 วันให้บัญชีเดิม (รันวันเปิดระบบ) |
| `supabase/migrations/20261113000300_rate_limits.sql` | `rate_limits`, `kfp_rate_hit()`, `kfp_login_email_for_username()` (service_role เท่านั้น) |
| `supabase/functions/username-login/index.ts`, `supabase/functions/_shared/cors.ts` | Login ด้วย username โดยไม่ส่งอีเมลให้ browser · rate limit · เวลาตอบคงที่ |
| `auth-callback.html` | รับลิงก์จากอีเมล: ยืนยันสมัคร / ตั้งรหัสใหม่ / ยืนยันอีเมลใหม่ / ลิงก์หมดอายุ |
| `docs/SETUP.md` | ขั้นตอนตั้งค่า Staging → Production |
| `tests/sql/00_supabase_stub.sql`, `tests/sql/phase2_test.sql`, `tests/run-sql-tests.sh` | ทดสอบ migration + RLS บน Postgres 16 จริง |
| `tests/e2e/mock-supabase.js`, `tests/e2e/phase2.test.js` | ทดสอบ UI ด้วย Playwright (Supabase mock) |
| `tests/ts/*` | type-check Edge Functions |

### ไฟล์ที่แก้
| ไฟล์ | สิ่งที่แก้ |
|---|---|
| `auth.js` | Modal ใหม่: Login (อีเมลหรือ username), Register (อีเมล/username + เช็กซ้ำสด/password/confirm/ชื่อที่แสดง), Verify notice + Resend, Forgot password, Change password (ต้องใส่รหัสเดิม, เลิกใช้ `prompt()`), Change email, แถบ "เชื่อมอีเมลจริง" สำหรับบัญชีเก่า · บัญชีที่ยังไม่ยืนยันไม่ปลดล็อกอะไร · เพิ่ม `window.kfpAuth` (สำหรับ Login Gate ใน Phase 4) · Session ใช้ storage จริงเสมอ · **ส่วน Cloud load/upload/logout เดิมไม่เปลี่ยน** |
| `index.html`, `gold.html` | bump `auth.js?v=` |
| `sw.js` | เพิ่ม `auth-callback.html`, bump cache version |
| `supabase_schema.sql` | เพิ่มหมายเหตุให้รัน migrations ต่อ (ไม่แก้ SQL เดิม) |

### Database Migration
ดูตารางด้านบน · ทั้งหมด **เพิ่มอย่างเดียว รันซ้ำได้** · ไม่ลบ/แก้ข้อมูลเดิม · `user_data` ไม่ถูกแตะ

### Environment / Secrets
- Edge Function secret: `ALLOWED_ORIGINS`
- (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` Supabase ใส่ให้อัตโนมัติ)
- Browser: ไม่มีค่าใหม่

### การตั้งค่าที่ต้องทำ (ดู `docs/SETUP.md`)
Confirm email ON · **Secure email change OFF** · Custom SMTP · Redirect URL `…/auth-callback.html` · Deploy `username-login --no-verify-jwt`

### ผลการทดสอบ
| ชุด | ผล |
|---|---|
| SQL (Postgres 16 + Supabase stub): migration รันซ้ำได้, ข้อมูลบัญชีเก่าครบ, R1 แก้แล้ว, sync อีเมล/ยืนยัน, RLS + column grants (แก้อีเมล/username/suspend/plan/entitlement เองไม่ได้), anon อ่าน profiles ไม่ได้, rate limit, lookup อีเมลได้เฉพาะ service_role, บัญชีถูกระงับใช้ username login ไม่ได้ | ✅ 6 กลุ่ม ผ่านทั้งหมด |
| E2E (Chromium, Supabase mock): 12 สถานการณ์ 49 assertions — guest ไม่เจอ popup, validation สมัคร, เช็ก username สด, สมัครแล้วเจอหน้ายืนยัน, resend, บัญชียังไม่ยืนยันเข้าไม่ได้, login อีเมล, เปลี่ยนรหัส (re-auth), session หลัง reload, login username ผ่าน function, 401/429 ไม่ fallback, บัญชีเก่า fallback + เชื่อมอีเมล, forgot password, auth-callback (reset / หมดอายุ / ยืนยันสมัคร) | ✅ 49/49 |
| TypeScript check Edge Functions | ✅ |
| Smoke: `index.html`, `gold.html` โหลดไม่มี error ใหม่, modal เปิดได้ทั้ง 2 หน้า | ✅ |

### ปัญหาที่พบ / ข้อจำกัด
1. **พบและแก้:** บั๊กเดิมใน `theme.css` — แสงเรืองหลัง modal เลื่อนออกด้านข้างเพราะ animation `fx-breathe2` ทับ `translateX(-50%)` และ ripple ของปุ่มหลุดกรอบ → modal เลื่อนแนวนอนได้ (เนื้อหาโดนตัดซ้าย) · แก้ใน style ของ `auth.js` ไม่แตะ `theme.css`
2. **ยังทดสอบไม่ได้ในเครื่องนี้ (ต้องทดสอบบน Staging):** การส่งอีเมลจริง, error code จริงของ Supabase Auth, ลิงก์ยืนยัน/เปลี่ยนอีเมลจริง, Edge Function บน Deno จริง, iOS Safari/PWA — checklist อยู่ใน `docs/SETUP.md`
3. ผู้ใช้ที่ถูกระงับ: ตอนนี้บล็อกเฉพาะ username login · บล็อกเต็มรูปแบบ (ban ผ่าน Auth Admin API) ทำใน Phase 10
4. ช่วงเปลี่ยนผ่าน: เครื่องที่ยังค้าง `auth.js` เวอร์ชันเก่า (PWA cache) ถ้าสมัครใหม่จะเห็นข้อความ error ตอนสร้าง profile แม้บัญชีจะถูกสร้างแล้ว (trigger สร้าง profile ให้) — หายเองเมื่อ Service Worker อัปเดต
5. การ Login/Logout ยังใช้ logic สลับข้อมูล guest เดิม · จะเปลี่ยนเป็น Preview/namespace ใน Phase 3


## Phase 3 · Public Preview + Demo Data ✅ (13/11/2026)

### หลักการ
`kfp-storage.js` โหลดก่อนทุกสคริปต์ แล้วแทน `window.localStorage` ของหน้าเว็บ — **สูตร/โค้ดเดิม (`script.js`, `gold.js`, `tools-ui.js`, `kfp-config.js`) ไม่ถูกแก้แม้แต่บรรทัดเดียว**
| สถานะ | ข้อมูลส่วนตัวอ่าน/เขียนที่ไหน |
|---|---|
| Guest / ยังไม่ยืนยันอีเมล → **PREVIEW** | หน่วยความจำ ที่ใส่ Demo Data ไว้ · ไม่ลงเครื่อง · ไม่ขึ้น Cloud · หายเมื่อรีโหลด |
| สมาชิกที่ยืนยันแล้ว → **MEMBER** | LocalStorage จริงใต้ `kfp:u:<user_id>:<key>` (แยกตามบัญชี) |
| คีย์สาธารณะ (session, เรต, cache ราคาทอง/ข่าว, ตำแหน่งปุ่ม) | LocalStorage จริงตามเดิม |
| `kfp:*` ของบัญชีอื่น | หน้าเว็บอ่านผ่าน `localStorage` ไม่ได้เลย |

Login → reload เข้า MEMBER · Logout → reload กลับ PREVIEW (ข้อมูลบัญชียังอยู่ในเครื่อง ไม่ถูกล้าง) · session หมดอายุ/ถูกเพิกถอน/เปลี่ยนในแท็บอื่น → สลับให้อัตโนมัติ (มีตัวกันวนลูป)

### ไฟล์ที่สร้าง
| ไฟล์ | หน้าที่ |
|---|---|
| `kfp-storage.js` | แยก Preview/Member, namespace ต่อบัญชี, ย้ายคีย์เก่า, “ข้อมูลเดิมในเครื่อง” + นำเข้า/ลบ, reboot กันลูป |
| `kfp-demo-data.js` | Demo: เงินเดือน KRW 2,500,000 / THB 45,000, แบ่ง 45-15-25-10-5, ประวัติเงินเดือน 10 เดือน, บันทึกงานเดือนนี้, รายการหัก, รายจ่ายวอน+บาท (บางรายการผูกการ์ด), พอร์ตทอง 5 รอบ · สร้างตามวันที่ปัจจุบัน |
| `kfp-access.js`, `kfp-access.css` | ป้าย PREVIEW MODE มุมซ้ายบน, แถบ “DEMO DATA — ตัวอย่างการใช้งาน” + ปุ่มสมัคร/เข้าสู่ระบบ, ป้าย DEMO บนทุก popup (Phase 4–5 จะต่อในไฟล์นี้) |
| `tests/e2e/phase3.test.js`, `tests/run-e2e.sh` | ทดสอบ 12 สถานการณ์ |

### ไฟล์ที่แก้
| ไฟล์ | สิ่งที่แก้ |
|---|---|
| `auth.js` | Login/Logout สลับโหมดด้วย reload · Logout ไม่ลบข้อมูลบัญชี · กล่อง “พบข้อมูลเดิมในเครื่องนี้” (นำเข้า/ลบ แบบแตะ 2 ครั้ง) · **แก้ปัญหาข้อมูลหายตอนรีโหลด**: ดึง Cloud มาทับเฉพาะเมื่อ Cloud ใหม่กว่าที่เครื่องนี้เคยโหลด/อัปโหลด (`__kfp_cloud_seen_v1`) · ตรวจโหมดไม่ตรงกับ session |
| `pwa-persistence.js` | สำรอง/คืนค่า LocalStorage จริง (ทุก namespace) · **ไม่คืนคีย์ส่วนตัวแบบเก่าอีก (แก้ R4)** · tombstone ตาม namespace · ไม่คืน `__kfp_auth_user_v1` |
| `index.html`, `gold.html` | โหลด `supabase-config.js` → `kfp-demo-data.js` → `kfp-storage.js` ก่อนสคริปต์อื่น, เพิ่ม `kfp-access.*`, bump version |
| `auth-callback.html` | โหลด config ก่อน supabase-js |
| `sw.js` | เพิ่มไฟล์ใหม่ใน cache, bump version |

### Database Migration / Environment
ไม่มี (Phase นี้เป็นฝั่ง browser ล้วน)

### การตั้งค่าที่ต้องทำ
Deploy ไฟล์ตามรายการ · ทดสอบบน iPhone ตาม checklist ด้านล่าง

### ผลการทดสอบ
| ชุด | ผล |
|---|---|
| Phase 3 E2E (Chromium): Guest เห็น demo + ป้าย, ไม่มี popup login · ข้อมูลจริงในเครื่อง (ทั้งของสมาชิกและ guest แบบเก่า) ไม่โผล่ใน Preview · สิ่งที่กดใน Preview ไม่ถูกบันทึก · Login → ข้อมูลบัญชีจาก Cloud · แก้ในเครื่องแล้วรีโหลดไม่หาย / Cloud ใหม่กว่าจากเครื่องอื่นชนะ · Logout ข้อมูลไม่หาย · 2 บัญชีเครื่องเดียวแยกกัน · อัปเกรดจากเวอร์ชันเก่า + นำเข้าข้อมูลเดิม · R4 (PWA ไม่คืนข้อมูลเก่า) · หน้าทอง Preview/Member · session ถูกเพิกถอน/ยังไม่ยืนยัน → Preview · มือถือ 360px | ✅ 60/60 |
| Phase 2 E2E (รันซ้ำ) | ✅ 49/49 |
| SQL Phase 2 (รันซ้ำ) | ✅ |
| Smoke `index.html` / `gold.html` | ✅ ไม่มี error ใหม่ |

### ปัญหาที่พบ / ข้อจำกัด
1. **พบและแก้ (เดิม):** สมาชิกที่ Login อยู่ เมื่อรีโหลดหน้าเว็บ ข้อมูลที่แก้แต่ยังไม่กดอัปโหลดถูก Cloud ทับหายทุกครั้ง → แก้แล้ว (ดึง Cloud เฉพาะเมื่อใหม่กว่า) · ข้อจำกัดที่ยังเหลือ: ถ้าแก้ในเครื่อง A โดยไม่อัปโหลด แล้วเครื่อง B อัปโหลด เครื่อง A จะได้ข้อมูลของ B (ไม่มีการ merge) — จะออกแบบ Cloud Sync จริงใน Phase 5/6 (Plus)
2. **พบและแก้:** PWA backup คืน `__kfp_auth_user_v1` หลัง logout · ระบบตรวจ session สแกน token ของโปรเจกต์อื่นบนโดเมนเดียวกัน (staging/prod) → ใช้เฉพาะ token ของโปรเจกต์ที่ตั้งค่าไว้
3. **ยังทดสอบไม่ได้:** iOS Safari / PWA (เครื่องนี้ไม่มี WebKit) — ถ้า Safari ไม่ยอมให้แทน `localStorage` ระบบจะตั้ง `data-kfp-isolation="failed"` และหน้าจะว่าง (ไม่รั่ว เพราะคีย์ส่วนตัวทั้งหมดย้ายไปอยู่ใต้ `kfp:` แล้ว)
4. ใน Preview ปุ่มต่างๆ ยังกดได้ (ผลอยู่ในหน่วยความจำ ไม่บันทึก) — Phase 4 จะเปิด Login Modal แทน

### Checklist ทดสอบบน iPhone (Safari + แอปที่ติดตั้งจาก Home Screen)
1. เปิดเว็บแบบไม่ Login → เห็นป้าย PREVIEW MODE + ตัวเลข 2,500,000
2. Login บัญชีที่มีข้อมูล → เห็นข้อมูลจริง ไม่มีป้าย
3. แก้เงินเดือน → ปิดแอปจนหมด → เปิดใหม่ → ค่าที่แก้ยังอยู่
4. Logout → กลับเป็น Demo · Login ใหม่ → ข้อมูลกลับมาครบ
5. ถ้าหน้าว่างผิดปกติ: เปิด Web Inspector แล้วดู `document.documentElement.dataset.kfpIsolation`


## Phase 4 · Global Login Gate ✅ (13/11/2026)

### หลักการ
ผู้เข้าชม (Preview) กดปุ่มที่ **บันทึก / แก้ไข / ลบ / คำนวณ / Export / ตั้งค่า** → ขึ้น Modal
**"🔒 กรุณาเข้าสู่ระบบหรือสมัครสมาชิกเพื่อใช้งานฟีเจอร์นี้"** + ชื่อฟีเจอร์ที่กด + ปุ่ม เข้าสู่ระบบ / สร้างบัญชี / ลืมรหัสผ่าน
- ดักที่จุดเดียว: listener แบบ capture-phase บน `document` (click / submit / change) ใน `kfp-access.js` → **handler เดิมไม่ถูกเรียกเลย** (ไม่มี alert/confirm เด้ง ไม่มีอะไรเปลี่ยน) · ไม่ได้แก้โค้ดของปุ่มเดิม
- ฟังก์ชันกลาง `requireAuth(action, options)` (+ `window.kfpGate`) ใช้กับโค้ดใหม่ได้ · หรือใส่ `data-requires-auth="ชื่อฟีเจอร์"` ที่ปุ่ม
- Login สำเร็จ → reload เป็น Member (session, profile, Cloud, ข้อมูลของบัญชี) · Login ไม่สำเร็จ → ไม่ปลดล็อกอะไร
- ถ้า `auth.js` โหลดไม่ขึ้น → ยังบล็อกอยู่ และแสดงกล่องแจ้งเตือนสำรอง

### ตารางปุ่ม
| หน้า | ถูกดัก (ต้อง Login) | ไม่ดัก (ดู/คิดเลขเฉยๆ) |
|---|---|---|
| หน้าหลัก | คำนวณ, บันทึกเงินเดือนเดือนนี้, เพิ่ม/ลบประวัติเงินเดือน, Export Excel, บันทึก/ตั้งระยะ/ลบสัญญา, บันทึกการแบ่งเงิน | อัปเดตค่าเงิน, เครื่องแปลงเงิน, สลับวอน/บาท, เปิดหน้าจัดการแบ่งเงิน, กรองปี |
| บันทึกการเข้างาน | บันทึกวันนี้, บันทึกย้อนหลัง, แก้ไข/ลบวัน, เพิ่ม/ลบรายการหัก, บันทึกเงินเข้าจริง, บันทึก/คืนค่าตั้งค่า | เปิด popup, ประวัติ (ปฏิทิน + ดูรายละเอียด), สรุปรายได้, ดูหน้าตั้งค่า |
| รายจ่าย | บันทึก, แก้ไข, ลบ | เปิด popup, สลับรายการ/ประวัติ, เลื่อนเดือน |
| พอร์ตทอง | บันทึกการซื้อ (ปุ่มและ Enter), ลบรอบ, ลบทั้งหมด, Export, บันทึกราคา GOLD2go, ดึงราคา Auto, เปลี่ยนแหล่งราคา (คืนค่าเดิมให้) | เครื่องคิดราคาทอง, จำลองขาย, กราฟ, รีเฟรชราคา, ข่าว |

หมายเหตุ: การพิมพ์ในช่องกรอกยังทำได้ (เป็นข้อมูลตัวอย่างในหน่วยความจำ ไม่บันทึก) — ถูกดักตอนกดปุ่มที่ทำงานจริง

### ไฟล์ที่แก้
| ไฟล์ | สิ่งที่แก้ |
|---|---|
| `kfp-access.js` | Login Gate: ตาราง GATES, `requireAuth()`, `window.kfpGate`, ดัก click/submit/change, คืนค่า select, กล่องสำรอง, ข้อความในแถบ Demo |
| `kfp-access.css` | สไตล์กล่องสำรอง |
| `auth.js` | Modal แสดงข้อความ gate + ชื่อฟีเจอร์ · **คืนโฟกัสให้ปุ่มเดิมเมื่อปิด Modal** · Esc ปิดเฉพาะ Modal ไม่ปิด popup ข้างใต้ |
| `index.html`, `gold.html`, `sw.js` | bump version (`20261113-saas4`) |
| `tests/e2e/phase4.test.js` | ใหม่ · 11 สถานการณ์ |

### Database / Environment / การตั้งค่า
ไม่มี · อัปโหลดไฟล์ตามตารางด้านบน

### ผลการทดสอบ
| ชุด | ผล |
|---|---|
| Phase 4 E2E: ปุ่มทุกตัวในตาราง (หน้าหลัก, popup งาน/รายจ่าย, หน้าทอง) ถูกดัก + ตรวจว่า handler เดิมไม่ทำงานและข้อมูลไม่เปลี่ยน · คีย์บอร์ด (Enter) · ปุ่มดู/คิดเลขไม่ถูกดัก · Esc ไม่ปิด popup ข้างใต้ · เนื้อหา Modal (ข้อความ, ชื่อฟีเจอร์, Login/Create Account, สลับ, ลืมรหัส) · `requireAuth()` และ `data-requires-auth` · สมาชิกใช้งานได้ปกติ · Login จาก Modal แล้วทำต่อได้ · Login ผิดยังถูกดัก · auth.js โหลดไม่ขึ้น | ✅ 74/74 |
| Phase 2 E2E (รันซ้ำ) | ✅ 49/49 |
| Phase 3 E2E (รันซ้ำ, ปรับให้คาดหวัง gate ใน Preview) | ✅ 61/61 |

### ปัญหาที่พบ / ข้อจำกัด
1. **พบและแก้:** ปิด Modal แล้วโฟกัสหลุดไป `<body>` → กด Esc ปิด popup ที่เปิดค้างไม่ได้ และผู้ใช้คีย์บอร์ดหลงตำแหน่ง → คืนโฟกัสให้ปุ่มที่เปิด Modal
2. Gate ฝั่งหน้าเว็บเป็นแค่ UX · ความปลอดภัยจริงอยู่ที่ฐานข้อมูล (Guest ไม่มี session จึงเขียน Supabase ไม่ได้อยู่แล้ว · Phase 5–9 จะเพิ่มการตรวจสิทธิ์ตามแพ็กเกจใน RLS)
3. หลัง Login ผู้ใช้ต้องกดปุ่มเดิมอีกครั้ง (หน้าเว็บ reload เพื่อเข้า Member Mode) — ยังไม่ได้ทำ "ทำต่ออัตโนมัติ"
4. ปุ่มที่เพิ่มในอนาคตต้องเพิ่มในตาราง GATES หรือใส่ `data-requires-auth` ไม่เช่นนั้นจะไม่ถูกดัก (แต่ก็ยังไม่บันทึกอะไรจริงเพราะ Preview ใช้หน่วยความจำ)


## Phase 5 · Plan-Based Visibility ✅ (13/11/2026)

### หลักการ
- **สิทธิ์คำนวณในฐานข้อมูลเท่านั้น**: `get_my_entitlements()` ดู subscription + สิทธิ์ที่ admin ให้ (เช่น Premium 90 วันของสมาชิกเดิม) แล้วเลือกแพ็กเกจสูงสุดที่ยังใช้ได้ · browser แก้ไม่ได้ (ทดสอบแล้วว่าแก้ cache ในเครื่องก็ถูก server ทับ)
- **ไม่มีสิทธิ์ = ไม่แสดง** (ไม่ใช่ล็อก): ใส่ `data-feature="..."` ที่ element → CSS ซ่อนตาม `html[data-feat-*]` (รวม element ที่สร้างภายหลัง เช่น ปุ่มลอย)
- ระหว่างรอคำตอบจาก server ซ่อนทุกฟีเจอร์ที่ขึ้นกับแพ็กเกจ · ออฟไลน์ใช้คำตอบล่าสุดจาก server (≤ 7 วัน) ไม่งั้นเป็น Free
- Guest (Preview) เห็นครบทุกฟีเจอร์ด้วยข้อมูล Demo ตามเดิม
- **บังคับจริงที่ฐานข้อมูล**: Free อัปโหลด Cloud ไม่ได้ (RLS) · ไม่มี Premium แก้ข้อมูลทองใน Cloud ไม่ได้ (trigger เก็บค่าเดิมไว้ ไม่ลบ)

### สิ่งที่แต่ละแพ็กเกจเห็น
| ส่วน | Free | Plus | Premium |
|---|---|---|---|
| เงินเดือน, แบ่งเงิน, สถิติพื้นฐาน, สัญญา, แปลงเงิน, เป้าหมาย | ✅ | ✅ | ✅ |
| ประวัติเงินเดือน | 6 เดือนล่าสุด (ที่เก่ากว่าซ่อน ไม่ลบ) | ทั้งหมด | ทั้งหมด |
| รายจ่าย | ✅ ย้อนหลัง 2 เดือน | ✅ ทั้งหมด | ✅ ทั้งหมด |
| บันทึกการเข้างาน | ❌ (ปุ่มหาย ปุ่มรายจ่ายเต็มแถว) | ✅ | ✅ |
| กราฟ (สัดส่วน, รายได้, เงินเก็บสะสม) | ❌ (มีข้อความชวนอัปเกรดแทน) | ✅ | ✅ |
| Export Excel | ❌ | ✅ | ✅ |
| Cloud Sync | ❌ (มีข้อความแทนปุ่ม) | ✅ (ไม่ส่งข้อมูลทอง) | ✅ |
| พอร์ตทอง (ปุ่มลอย + หน้า gold.html) | ❌ เปิดตรงๆ → หน้าชวนอัปเกรด | ❌ เปิดตรงๆ → หน้าชวนอัปเกรด | ✅ |
ตัวเลขทั้งหมด (ฟีเจอร์ต่อแพ็กเกจ, จำนวนเดือน, grace period) แก้ได้ในตาราง `plans` โดยไม่ต้องแก้โค้ด

### ไฟล์ที่สร้าง
| ไฟล์ | หน้าที่ |
|---|---|
| `supabase/migrations/20261113000400_entitlements.sql` | `subscriptions` (เป็นกลาง ไม่ผูก Stripe), `kfp_effective_plan()`, `kfp_has_feature()` (เฉพาะ server), `has_feature()` / `get_my_entitlements()` (เฉพาะของผู้เรียก), RLS Cloud Sync, trigger ป้องกันคีย์ทอง |
| `pricing.html` | หน้าแพ็กเกจ: ดึงแพ็กเกจ+ฟีเจอร์จากตาราง `plans`, สลับรายเดือน/รายปี และ บาท/วอน, ตารางเทียบฟีเจอร์, แสดงแพ็กเกจปัจจุบัน · ปุ่มชำระเงิน "เร็วๆ นี้" (Phase 7–8) |
| `tests/sql/phase5_test.sql`, `tests/e2e/phase5.test.js` | ทดสอบ |

### ไฟล์ที่แก้
| ไฟล์ | สิ่งที่แก้ |
|---|---|
| `kfp-access.js` | `canUseFeature()`, `renderFeaturesByPlan()`, `applyPlanVisibility()`, `requireFeature()`, `window.kfpPlan`, โหลดสิทธิ์จาก RPC (+ timeout/ออฟไลน์/ยังไม่รัน migration), จำกัดประวัติเงินเดือน Free, หน้าชวนอัปเกรด + หน้า "กำลังตรวจสอบสิทธิ์" บน gold.html, กล่องชวนอัปเกรด |
| `kfp-access.css` | กฎซ่อน/แสดงตามฟีเจอร์ + สไตล์หน้าอัปเกรด/ข้อความจำกัด |
| `auth.js` | ส่งสัญญาณ `kfp:auth-ready` · แสดงแพ็กเกจในหน้า "บัญชีของฉัน" · ปิดอัปโหลด Cloud ถ้าไม่มีสิทธิ์ · ไม่ส่งข้อมูลทองถ้าไม่มี Premium |
| `index.html` | `data-feature` ที่ปุ่มบันทึกงาน, Export, กราฟ, ปุ่มลอยไปหน้าทอง + ข้อความแทนกราฟ |
| `tools-ui.js`, `tools.css` | จำกัดการเลื่อนดูรายจ่ายย้อนหลังตามแพ็กเกจ + ข้อความ |
| `floating-nav.js` | รองรับ `data-feature` |
| `gold.html`, `sw.js` | bump version, เพิ่ม `pricing.html` ใน cache |

### Database Migration
`20261113000400_entitlements.sql` (เพิ่มอย่างเดียว รันซ้ำได้) · แก้ policy `user_data_insert_own` / `user_data_update_own` (ชื่อเดิม) ให้ต้องมี `cloud_sync` · การอ่านข้อมูล Cloud ของตัวเองยังทำได้ทุกแพ็กเกจ

### Environment / การตั้งค่า
ไม่มีค่าใหม่ · ลำดับ deploy: **รัน migration 0400 ก่อน แล้วค่อยอัปโหลดหน้าเว็บ** (ถ้าเว็บขึ้นก่อน ระบบจะแสดงทุกฟีเจอร์เหมือนเดิมจนกว่า migration จะรัน — ไม่มีใครถูกล็อกผิดพลาด)
⚠️ ต้องรัน `20261113000200_legacy_launch_grant.sql` ในวันเปิดระบบ ไม่งั้นสมาชิกเดิมจะกลายเป็น Free (Cloud upload และทองหายจากหน้าจอ แต่ข้อมูลไม่หาย)

### ผลการทดสอบ
| ชุด | ผล |
|---|---|
| SQL Phase 5: ตารางสิทธิ์ 14 กรณี (active, ยกเลิกปลายรอบ, หมดรอบ, past_due ใน/เกิน grace, unpaid, canceled, trialing, incomplete, grant+subscription, grant หมดอายุ, ถูกระงับ, สมาชิกเดิม) · ถอน grant/หมดอายุ · API ตอบเฉพาะของผู้เรียก · แก้ subscription/plan เองไม่ได้ · anon เรียกไม่ได้ · Free อัปโหลด Cloud ไม่ได้แต่อ่านได้ · Plus เพิ่ม/แก้/ลบข้อมูลทองใน Cloud ไม่ได้ (ของเดิมไม่หาย) · Premium ได้ | ✅ |
| SQL Phase 2 (รันซ้ำ) | ✅ |
| E2E Phase 2 / 3 / 4 (รันซ้ำ) | ✅ 49/49 · 61/61 · 74/74 |
| E2E Phase 5: Guest เห็นครบ · Free/Plus/Premium เห็นตามตาราง · ประวัติจำกัดและข้อมูลไม่หาย · กดอัปโหลดแบบบังคับก็ไม่ส่ง · Plus อัปโหลดไม่มีคีย์ทอง · gold.html ตรงๆ → หน้าอัปเกรด · ระหว่างรอ server ซ่อนไว้ก่อน · ออฟไลน์ใช้คำตอบล่าสุด/เป็น Free · cache ที่ถูกแก้ไม่มีผล · ยังไม่รัน migration → แสดงทั้งหมด · หน้า Pricing (ราคา, รายปี, วอน, แพ็กเกจปัจจุบัน, สมัครฟรี) · มือถือ 360px | ✅ 57/57 |

### ปัญหาที่พบ / ข้อจำกัด
1. ฟีเจอร์ที่ทำงานในเครื่องล้วน (บันทึกงาน, Export, กราฟ, ประวัติ) ป้องกันได้แค่ระดับ UI — คนที่แก้โค้ดในเบราว์เซอร์เองเปิดได้ แต่เห็นแค่ข้อมูลของตัวเองในเครื่อง · ส่วนที่มีค่าจริง (Cloud Sync, ข้อมูลทองบน Cloud) บังคับที่ฐานข้อมูลแล้ว
2. ราคาในหน้า Pricing ยังเป็นค่าเริ่มต้นในไฟล์ (Phase 6 ย้ายเข้าตาราง `plan_prices` ให้ admin แก้) · ราคารายปีสกุลวอนยังไม่กำหนด
3. ถ้าสมาชิกถูกลดเป็น Free ขณะเปิดหน้าค้างไว้ หน้าจะอัปเดตเมื่อกลับมาที่แท็บหลัง 10 นาที หรือรีโหลด
4. กราฟในเทสต์แสดงเป็นช่องว่างเพราะเครื่องทดสอบโหลด Chart.js จาก CDN ไม่ได้ (ไม่เกี่ยวกับระบบสิทธิ์)


## Phase 6 · Subscription Database ✅ (13/11/2026)

### ตารางใหม่ (migration `20261113000500_billing_admin.sql`)
| ตาราง | เก็บอะไร | ใครอ่าน | ใครเขียน |
|---|---|---|---|
| `plan_prices` | ราคา Plus/Premium × เดือน/ปี × THB/KRW · ราคาเก่าเก็บเป็นประวัติ (active=false) · ช่อง `provider_price_id` รอ Stripe (Phase 7) | ทุกคน (เฉพาะราคาที่ใช้อยู่) · admin เห็นประวัติ | `admin_set_price()` / `admin_deactivate_price()` เท่านั้น (ต้องใส่เหตุผล + บันทึก audit) |
| `billing_customers` | user ↔ ลูกค้าใน Stripe (หรือ provider อื่น) | เจ้าของ / admin | Edge Function |
| `payments` | การชำระเงิน = ใบแจ้งหนี้: ยอด, สกุลเงิน, สถานะ (paid / failed / action_required / refunded ฯลฯ), เหตุผลที่จ่ายไม่ผ่าน, ลิงก์ใบแจ้งหนี้/PDF, รอบบิล | เจ้าของ / admin | Webhook เท่านั้น |
| `payment_refunds` | คืนเงินแต่ละครั้ง (คืนบางส่วนได้หลายครั้ง) | เจ้าของ / admin | Webhook / admin Edge Function |
| `stripe_webhook_events` | ทุก event ที่รับ + สถานะ + จำนวนครั้งที่ลอง + error | ไม่มีใครผ่าน browser | Edge Function |
| `user_activity` | บันทึกการใช้งาน (login / หน้า / heartbeat) | เจ้าของ / admin | `touch_activity()` เท่านั้น |
| `admin_roles` | owner / admin / viewer | ตัวเองเห็นแถวตัวเอง | **SQL เท่านั้น** (ไม่มีทางเพิ่มตัวเองเป็น admin ผ่านเว็บ) |
| `admin_audit_logs` | ใคร ทำอะไร กับใคร ก่อน/หลัง เหตุผล เวลา | admin (viewer ขึ้นไป) | ฟังก์ชัน admin เท่านั้น · **แก้/ลบไม่ได้แม้แต่ service_role** |

`subscriptions` เพิ่ม `price_id`, `unit_amount_minor`, `latest_invoice_id` (ใช้คำนวณ MRR/ARR ใน Phase 10)

### หลักการสำคัญ
- **เงินเก็บเป็นหน่วยย่อยของสกุลเงิน** (เหมือน Stripe): THB เป็นสตางค์ (129 บาท = 12900), KRW ไม่มีหน่วยย่อย (5,900 วอน = 5900) · แยกสกุลเงินเสมอ ไม่แปลงรวมกัน
- **เปลี่ยนราคา = สร้างแถวใหม่** แถวเก่าเก็บเป็นประวัติ · ลูกค้าเดิมจ่ายราคาเดิมตามรอบที่สมัคร (ตามกฎเกาหลีต้องแจ้ง 30 วันก่อนขึ้นราคา)
- **กัน webhook ซ้ำ**: `kfp_claim_webhook_event()` ให้ผ่านได้ครั้งเดียวต่อ event · event ที่ล้มเหลวลองใหม่ได้ · event ที่ค้าง (worker ล่ม) เกิน 5 นาทีลองใหม่ได้
- **บันทึกการใช้งานแบบไม่เปลือง**: browser ส่งตอนเปิดหน้า/ทุก 5 นาทีที่เปิดค้างไว้ และฐานข้อมูลกรองซ้ำอีกชั้น (บันทึก 1 แถว/หน้า/5 นาที, อัปเดต last_active สูงสุดนาทีละครั้ง) · มี `kfp_prune_activity()` เก็บย้อนหลัง 180 วัน
- **ลบบัญชีผู้ใช้**: ข้อมูลส่วนตัว (subscription, activity, customer) ลบตาม · การชำระเงินและ audit log เก็บไว้แต่ตัดชื่อผู้ใช้ออก (เพื่อบัญชี/ตรวจสอบย้อนหลัง)
- Admin ที่ถูกระงับบัญชีหมดสิทธิ์ admin ทันที

### ไฟล์ที่สร้าง / แก้
| ไฟล์ | |
|---|---|
| `supabase/migrations/20261113000500_billing_admin.sql` | ใหม่ |
| `tests/sql/phase6_test.sql`, `tests/e2e/phase6.test.js` | ใหม่ |
| `pricing.html` | ดึงราคาจาก `plan_prices` (ราคาเดิมในไฟล์ใช้เฉพาะตอนออฟไลน์) |
| `kfp-access.js` | Heartbeat ไปที่ `touch_activity()` (สมาชิกเท่านั้น) |
| `index.html`, `gold.html`, `sw.js` | bump version (`20261113-saas6`) |

### Environment / การตั้งค่า
ไม่มีค่าใหม่ · ต้องเพิ่ม owner คนแรกด้วย SQL (ดู `docs/SETUP.md`)

### ผลการทดสอบ
| ชุด | ผล |
|---|---|
| SQL Phase 6 (11 กลุ่ม): owner ตั้งราคาจาก SQL Editor ได้ แต่ผู้ใช้ผ่าน API ไม่ได้ · ราคาเริ่มต้น · guest/ลูกค้าอ่านได้แต่แก้ไม่ได้ · ลูกค้าตั้งตัวเองเป็น admin ไม่ได้ · admin เปลี่ยนราคา (ตรวจค่าผิด, ต้องมีเหตุผล, ไม่เปลี่ยน=ไม่บันทึก, ราคาเก่าเป็นประวัติ, audit มี before/after) · viewer อ่านอย่างเดียว · admin ถูกระงับหมดสิทธิ์ · audit แก้/ลบไม่ได้ (รวม service_role และ owner) แต่ลบบัญชีได้ · payments/refunds เห็นของตัวเอง แก้ไม่ได้ ใบแจ้งหนี้ซ้ำไม่ได้ คืนเงินเกินยอดไม่ได้ · webhook ซ้ำ/ล้มเหลว/ค้าง · activity throttle + กรองชื่อหน้า · ลบบัญชี · indexes | ✅ |
| SQL Phase 2, 5 (รันซ้ำ) | ✅ |
| E2E Phase 2 / 3 / 4 / 5 (รันซ้ำ) | ✅ 49/49 · 61/61 · 74/74 · 57/57 |
| E2E Phase 6: ราคาจากฐานข้อมูล (สตางค์/วอน, ราคารายปีวอนที่ admin ตั้ง) · heartbeat (guest ไม่ส่ง, สมาชิกส่งครั้งเดียว, รีโหลดไม่ส่งซ้ำ, หน้าใหม่ส่ง, ครบ 5 นาทีส่งได้) | ✅ 8/8 |

### ปัญหาที่พบ / ข้อจำกัด
1. **พบและแก้ก่อนทดสอบ:** (ก) trigger กันแก้ audit log จะทำให้ลบบัญชีผู้ใช้ไม่ได้ (FK set null = การ update) → อนุญาตเฉพาะการตัด id ผู้ใช้ออก (ข) policy ราคาเรียก `is_admin()` ซึ่ง guest ไม่มีสิทธิ์เรียก → หน้า Pricing ของ guest จะ error → แยก policy
2. ยังไม่มีหน้าจอ admin (Phase 10) · ตอนนี้เปลี่ยนราคาด้วย `admin_set_price()` จาก SQL Editor (อนุญาตเฉพาะ session เจ้าของฐานข้อมูลที่ไม่มี token — browser ทำแบบนี้ไม่ได้ ทดสอบแล้ว)
3. `provider_price_id` ยังว่าง — Phase 7 จะสร้าง Stripe Price ให้อัตโนมัติเมื่อ admin ตั้งราคา
4. ตาราง `stripe_webhook_events` ใช้ชื่อตามสเปก แต่มีคอลัมน์ `provider` รองรับ PortOne/Toss ด้วย


## Phase 7 · Stripe + Webhooks ✅ (13/11/2026)

### ทำงานอย่างไร
```
Pricing → [สมัคร] → create-checkout ─(ตรวจสิทธิ์+ราคาจาก DB)→ Stripe Checkout → จ่ายเงิน
                                                                     │
Stripe ──webhook (มีลายเซ็น)──→ stripe-webhook → ตรวจลายเซ็น → กันซ้ำ → ดึงข้อมูลล่าสุดจาก Stripe → SQL functions
                                                                     → subscriptions / payments / refunds → สิทธิ์ (Phase 5)
Pricing ← ?checkout=success → รอจนฐานข้อมูลยืนยันสิทธิ์ (ไม่เชื่อ URL) → "ชำระเงินสำเร็จ"
Pricing → [จัดการแพ็กเกจ] → create-portal → Stripe Customer Portal (อัปเกรด/ดาวน์เกรด/ยกเลิก/ต่ออายุ/เปลี่ยนบัตร/ใบเสร็จ)
```
- **ราคามาจากฐานข้อมูลเสมอ** — browser ส่งแค่ แพ็กเกจ/รอบบิล/สกุลเงิน · Stripe Product (`kfp_plus`, `kfp_premium`) และ Price ถูกสร้างอัตโนมัติจาก `plan_prices` ตอน Checkout ครั้งแรก (admin เปลี่ยนราคาแล้วจะสร้าง Price ใหม่เอง)
- **ไม่มี subscription ซ้อน** — มีแพ็กเกจที่จ่ายอยู่แล้วต้องเปลี่ยนผ่านพอร์ต
- **ต้องมีอีเมลจริงที่ยืนยันแล้ว** — บัญชี `@kfp.example.com` / ยังไม่ยืนยัน / ถูกระงับ สมัครไม่ได้
- **Webhook**: ลายเซ็นผิด/ไม่มี/แก้ body/เก่าเกิน 5 นาที → 400 และไม่แตะฐานข้อมูล · event ซ้ำ → 200 duplicate · ประมวลผลพลาด → 500 (Stripe ส่งซ้ำ) และเก็บ error ไว้ · **ทุก event ดึงสถานะล่าสุดจาก Stripe ใหม่** ลำดับ event จึงไม่มีผล
- **Stripe API version ล็อกไว้ที่ 2024-06-20** + รองรับรูปแบบข้อมูลรุ่นใหม่
- กันกดซ้ำ: idempotency key ทุกการสร้างใน Stripe · จำกัด Checkout 10 ครั้ง/ชม./คน

### Events ที่รองรับ
`checkout.session.completed` · `customer.subscription.created` · `customer.subscription.updated` · `customer.subscription.deleted` · `invoice.paid` · `invoice.payment_failed` · `invoice.payment_action_required` · + `charge.refunded` (ติดตามการคืนเงิน)

### ไฟล์ที่สร้าง
| ไฟล์ | |
|---|---|
| `supabase/migrations/20261113000600_stripe.sql` | `kfp_checkout_context`, `kfp_set_price_provider_id`, `kfp_upsert_billing_customer`, `kfp_apply_subscription`, `kfp_apply_invoice` (จ่ายแล้วไม่ถูกเปลี่ยนเป็นล้มเหลว, การคืนเงินไม่ถูกลบ), `kfp_apply_refund` — service_role เท่านั้น |
| `supabase/functions/_shared/billing.ts` | ตรรกะทั้งหมด (ไม่ผูก Deno/Stripe SDK จึงทดสอบได้) |
| `supabase/functions/_shared/stripe.ts`, `_shared/supabase.ts` | Stripe client (ล็อก API version, ตรวจลายเซ็นด้วย SDK), service client |
| `supabase/functions/create-checkout/`, `create-portal/`, `stripe-webhook/` | Edge Functions |
| `tests/sql/phase7_test.sql`, `tests/edge/billing.test.ts`, `tests/run-edge-tests.sh`, `tests/e2e/phase7.test.js` | ทดสอบ |

### ไฟล์ที่แก้
`pricing.html` (ปุ่มสมัคร/จัดการบิล/เปลี่ยนแพ็กเกจ, ข้อความผิดพลาดภาษาไทย, หน้ารอยืนยันหลังจ่ายเงิน) · `kfp-access.js` (guest กดสมัคร → Login) · `tests/ts/deno-shim.d.ts`

### Environment Variables (Supabase Secrets)
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SITE_URL`, `ALLOWED_ORIGINS` · ไม่บังคับ: `CHECKOUT_REQUIRE_TOS`, `STRIPE_PORTAL_CONFIGURATION` · browser ไม่มี secret ใดๆ

### ผลการทดสอบ
| ชุด | ผล |
|---|---|
| SQL Phase 7 (9 กลุ่ม): checkout context · price id ใครเขียนก่อนได้ก่อน · checkout → Plus · หา user จาก customer · event ซ้ำ · customer/price ที่ไม่รู้จักถูกปฏิเสธ · invoice.paid · จ่ายไม่ผ่าน → past_due → ช่วงผ่อนผัน → เกิน → Free → จ่ายได้ → Plus · 3DS · อัปเกรด/ยกเลิกปลายรอบ/ลบ · คืนเงินบางส่วน/ทั้งหมด/ซ้ำ/เกินยอด · KRW · browser เรียกไม่ได้ | ✅ |
| Edge core (Stripe จำลอง + Postgres จริง) 51 ข้อ: validation · unverified/legacy/suspended · สร้าง Product+Price จากราคาใน DB (สตางค์/วอน) ครั้งเดียว · customer ครั้งเดียว · พารามิเตอร์ Checkout · กดซ้ำ = session เดิม · ToS · portal · ลายเซ็น 4 แบบ · checkout → Plus · ซ้ำ · invoice.paid · ล้มเหลว · 3DS · อัปเกรด · payload เก่า/สลับลำดับ · ลบ · คืนเงิน · ล้มเหลวแล้ว retry สำเร็จ · event อื่น · already_subscribed · rate limit · รันซ้ำได้ | ✅ 51/51 |
| E2E Phase 7 หน้า Pricing 23 ข้อ | ✅ 23/23 |
| TypeScript check Edge Functions | ✅ |
| รันซ้ำ: E2E Phase 2/3/4/5/6 · SQL Phase 2/5/6 | ✅ 49 · 61 · 74 · 57 (ปรับข้อ "ปุ่มสมัครปิดไว้" เป็น "เปิดแล้ว") · 8 · ✅ |

### ปัญหาที่พบ / ข้อจำกัด
1. **ยังไม่ได้ทดสอบกับ Stripe จริง** (เครื่องนี้ไม่มีบัญชี/คีย์ และต่อเน็ตไป Stripe ไม่ได้) — Stripe ในเทสต์เป็นของจำลองที่ใช้รูปแบบข้อมูลตาม API 2024-06-20 · การตรวจลายเซ็นจริงใช้ฟังก์ชันของ Stripe SDK · **ต้องทำ checklist 10 ข้อใน SETUP บน Test mode ก่อนเปิดจริง**
2. ข้อจำกัดประเทศของ Stripe (บัตรเกาหลี/Kakao Pay) ยังเหมือนเดิม — ตาราง billing เป็นกลาง เพิ่ม PortOne/Toss ทีหลังได้
3. หน้า Billing ของสมาชิก (ประวัติการชำระเงิน ใบเสร็จ วันตัดเงินถัดไป) ทำใน Phase 8 ✅
4. ราคาเปลี่ยนแล้วลูกค้าเดิมยังจ่ายราคาเดิม (ตามที่ Stripe ทำ) · ถ้าต้องการย้ายลูกค้าเดิมไปราคาใหม่ต้องทำใน Stripe (และแจ้งล่วงหน้า 30 วันตามกฎเกาหลี)

---

## Phase 8 · หน้า Billing ของสมาชิก ✅ (14/11/2026)

### หน้า `account.html` (แพ็กเกจและการชำระเงิน)
| ส่วน | แสดง |
|---|---|
| แพ็กเกจปัจจุบัน | ชื่อแพ็กเกจ · สถานะ (ใช้งานอยู่ / ทดลองใช้ / ยกเลิกแล้ว·ใช้ได้ถึง / ค้างชำระ / สิทธิ์สมาชิกเดิม / Free) · ราคาต่อรอบ · วันเริ่มเป็นสมาชิก · รอบบิลปัจจุบัน · **วันตัดเงินถัดไป** · **วันหมดอายุ** (+ เหลือกี่วัน) · **ต่ออายุอัตโนมัติ เปิด/ปิด** |
| แจ้งเตือน | ค้างชำระ → เหตุผล + ยอด + ปุ่ม "ชำระเงินตอนนี้" (ใบแจ้งหนี้ Stripe) + "เปลี่ยนบัตร" · ตั้งยกเลิกแล้ว → วันสิ้นสุด + ปุ่มต่ออายุ · สิทธิ์ฟรีช่วงเปิดระบบ → วันหมด + ชวนสมัคร · บัญชี Username เก่า → ให้เชื่อมอีเมล |
| จัดการแพ็กเกจ | **อัปเกรด / ดาวน์เกรด / เปลี่ยนรายเดือน↔รายปี** (แสดงราคาจาก DB, สกุลเงินเดียวกับที่สมัคร) → หน้ายืนยันของ Stripe ที่แสดงยอดตามสัดส่วนก่อนกดยืนยัน · **ยกเลิกการต่ออายุ** (หน้าต่างยืนยัน 2 ขั้น อธิบายวันสิ้นสุด/ข้อมูลไม่หาย + เหตุผลไม่บังคับ) · **ต่ออายุอีกครั้ง** · **เปลี่ยนบัตร** · **จัดการบิลใน Stripe** |
| ประวัติการชำระเงิน | วันที่ · แพ็กเกจ/รอบ · ยอด · สถานะ (ชำระแล้ว/ไม่สำเร็จ/รอยืนยัน/คืนเงิน…) · ยอดคืนเงิน · เหตุผลที่ล้มเหลว · **ลิงก์ใบเสร็จ/ใบแจ้งหนี้ + PDF** · ทีละ 10 รายการ + "โหลดเพิ่ม" |

- ยกเลิก/ต่ออายุทำในหน้าเราเอง (Edge Function `billing-action`) → **อัปเดตฐานข้อมูลทันที** ไม่ต้องรอ webhook · เปลี่ยนแพ็กเกจและบัตรผ่านหน้าของ Stripe (รองรับ 3-D Secure และคำนวณยอดตามสัดส่วนให้)
- ยกเลิก = ปิดต่ออายุ **ใช้ได้ถึงสิ้นรอบ** (ไม่ตัดทันที) · กดซ้ำไม่เรียก Stripe ซ้ำ · ระหว่างตั้งยกเลิก/ค้างชำระ เปลี่ยนแพ็กเกจไม่ได้ (บอกเหตุผล)
- ความปลอดภัย: ทุกคำสั่งตรวจว่า subscription ใน Stripe เป็นของ customer ของผู้ใช้นั้นจริง · rate limit (portal 20/ชม., ยกเลิก/ต่ออายุ 10/ชม.) · ประวัติการชำระเงินกรองด้วย user_id ของตัวเองเสมอ (กันกรณีบัญชี admin เห็นของคนอื่นผ่าน RLS) · ลิงก์ใบเสร็จรับเฉพาะ `https://` · หน้านี้ไม่มี Preview/ข้อมูลตัวอย่าง (guest เห็นปุ่มเข้าสู่ระบบ)
- กลับจาก Stripe → `account.html?portal=updated` → แจ้ง "เปลี่ยนแพ็กเกจเรียบร้อย" แล้วอ่านข้อมูลจาก server ซ้ำ 3 ครั้ง (รอ webhook)
- ทางเข้า: หน้าต่างบัญชี (บรรทัดแพ็กเกจ → "แพ็กเกจและใบเสร็จ") · Pricing (แพ็กเกจปัจจุบัน → จัดการ, แพ็กเกจอื่น → อัปเกรด/เปลี่ยนตรงไปหน้ายืนยัน Stripe)

### ไฟล์ที่สร้าง
| ไฟล์ | |
|---|---|
| `account.html` | หน้า Billing |
| `supabase/migrations/20261114000700_billing_page.sql` | `get_my_billing()` (ข้อมูลทั้งหน้าในคำขอเดียว เฉพาะของผู้เรียก) · `kfp_checkout_context` เพิ่มรายละเอียด subscription |
| `supabase/functions/billing-action/index.ts` | ยกเลิก / ต่ออายุ |
| `tests/sql/phase8_test.sql`, `tests/e2e/phase8.test.js` | ทดสอบ |

### ไฟล์ที่แก้
`supabase/functions/_shared/billing.ts` (`createPortal` รองรับ flow `manage` / `payment_method` / `switch`, กลับมาที่ `account.html` · `subscriptionAction` ใหม่) · `supabase/functions/create-portal/index.ts` (รับ body) · `pricing.html` (ปุ่มอัปเกรด → หน้ายืนยัน Stripe, จัดการ → account.html) · `auth.js` (ลิงก์ "แพ็กเกจและใบเสร็จ") · `sw.js` (+account.html, cache saas8) · `index.html`, `gold.html` (เวอร์ชันไฟล์) · `tests/edge/billing.test.ts`, `tests/e2e/mock-supabase.js`, `tests/e2e/phase7.test.js`, `tests/ts/deno-shim.d.ts`

### Database / Environment
- Migration: `20261114000700_billing_page.sql` (รันซ้ำได้)
- Secrets: ไม่มีตัวใหม่ · Deploy เพิ่ม `billing-action` และ deploy `create-portal` ใหม่
- Stripe: Customer portal ต้องเปิด **Switch plans** (ใส่ `kfp_plus`, `kfp_premium` ทุกราคา) และ **Update payment methods** — ไม่งั้น flow `switch` / `payment_method` จะ error

### ผลการทดสอบ
| ชุด | ผล |
|---|---|
| SQL Phase 8: สรุป billing ของตัวเอง (เลือก subscription ปัจจุบันก่อนแถวเก่า, ใบแจ้งหนี้ค้างชำระ, ยอดรวม) · ผู้ใช้อื่นไม่เห็นอะไรเลย · anon เรียกไม่ได้ · สิทธิ์ legacy · checkout context เฉพาะ service_role | ✅ |
| Edge core 81 ข้อ (+30): portal กลับ account.html · flow ผิด → 400 · payment_method · switch: same_plan/plan ผิด/ไม่มี subscription · อัปเกรด → subscription_update_confirm (item เดิม, ราคา Premium จาก DB, สกุลเงินเดิม) · รายเดือน→รายปี · portal ไม่แก้ subscription เอง · ยกเลิก (ปลายรอบ + เหตุผล) → DB ทันที · กดซ้ำไม่เรียก Stripe · ตั้งยกเลิกแล้วเปลี่ยนแพ็กเกจไม่ได้ · webhook ตามมาไม่ทำให้เพี้ยน · ต่ออายุ · subscription ไม่ใช่ของ customer นี้ → 403 · past_due → เปลี่ยนไม่ได้ · จบใน Stripe แล้ว → 409 + sync DB · rate limit | ✅ 81/81 |
| E2E Phase 8 (account.html) 51 ข้อ: guest · Free · Plus active (วันตัดเงิน, ไม่มีวันหมดอายุ, ตัวเลือกเปลี่ยนแพ็กเกจ THB, ประวัติ 10+2, ใบเสร็จ/PDF, คืนเงิน, ล้มเหลว, ตัดลิงก์ `javascript:`) · ยกเลิก (Escape/ใช้ต่อ = ไม่ส่ง, ยืนยัน + เหตุผล) → สถานะยกเลิก → ต่ออายุ · past_due (ชำระ/เปลี่ยนบัตร) · สิทธิ์ legacy · KRW รายปี (ดาวน์เกรด) · error 409/429/ไม่มี migration · กลับจาก portal · มือถือ 360px ปุ่ม ≥ 44px · ลิงก์จากหน้าต่างบัญชี | ✅ 51/51 |
| E2E Phase 7 (ปรับ K4/K5 ตามปุ่มใหม่) | ✅ 24/24 |
| รันซ้ำ: E2E Phase 2/3/4/5/6 · SQL Phase 2/5/6/7 · TypeScript | ✅ 49 · 61 · 74 · 57 · 8 · ✅ · ✅ |

### ปัญหาที่พบ / ข้อจำกัด
1. พบและแก้ระหว่างทดสอบ: ปุ่ม "โหลดเพิ่ม" ยังแสดงทั้งที่ตั้ง `hidden` (CSS `display:flex` ทับ) → เพิ่ม `[hidden]{display:none!important}`
2. ยังไม่ได้ทดสอบกับ Stripe จริง (เหมือน Phase 7) — flow `subscription_update_confirm` / `payment_method_update` ต้องเปิดฟีเจอร์ใน Customer portal ก่อน · ทำ checklist ข้อ 11–15 ใน SETUP
3. เปลี่ยนสกุลเงินของ subscription ไม่ได้ (ข้อจำกัด Stripe) — ถ้าต้องการเปลี่ยน ต้องยกเลิกแล้วสมัครใหม่หลังหมดรอบ
4. วันที่แสดงเป็นปี พ.ศ. (`th-TH`) ให้ตรงกับส่วนอื่นของเว็บ

---

## Phase 9 · Gold Premium Protection ✅ (14/11/2026)

### ทำงานอย่างไร
```
gold.html (Premium) ──get_my_gold / save_my_gold──► ฐานข้อมูลตรวจสิทธิ์ gold_portfolio ทุกครั้ง ──► user_gold_data
     │  แก้ข้อมูล → บันทึกในเครื่องทันที → ส่งขึ้น Cloud อัตโนมัติ (หน่วง 1.2 วิ) พร้อมเลขเวอร์ชันล่าสุดที่เครื่องนี้เห็น
     │  เวอร์ชันไม่ตรง (อีกเครื่องแก้ไปก่อน) → server ไม่เขียนทับ → ให้สมาชิกเลือกชุดข้อมูล (อีกชุดสำรองไว้ในเครื่อง)
user_data (Cloud Sync เดิม) ── ไม่มีข้อมูลทองอีกต่อไป
```
- **ตาราง `user_gold_data`**: browser ไม่มีสิทธิ์ insert/update/delete โดยตรง · อ่านได้เฉพาะแถวตัวเองและเฉพาะตอนมี `gold_portfolio` (RLS) · เขียนผ่าน `save_my_gold()` ซึ่งตรวจ Premium, rate limit 120 ครั้ง/นาที, ตรวจรูปแบบข้อมูล (lots ≤ 2000, id/grams/costThb, ขนาด) ทุกครั้ง
- **ไม่มี Premium** (Free/Plus/หมดอายุ/ค้างชำระเกินช่วงผ่อนผัน/ถูกระงับ): อ่านไม่ได้ เขียนไม่ได้ · `get_my_gold()` ตอบแค่ "มีเก็บไว้ N รอบ" (ไม่มีเนื้อหา) → หน้าอัปเกรดบอกว่าข้อมูลยังอยู่ครบ · **ไม่มีการลบข้อมูล** — กลับมาเป็น Premium เห็นข้อมูลเดิมทันที
- **ย้ายข้อมูลเดิม**: migration คัดลอกทองจาก `user_data` (ค่าที่เป็น string ของ localStorage → JSON จริง) ไป `user_gold_data` แล้วจึงลบออกจาก `user_data` เฉพาะแถวที่คัดลอกแล้ว · ค่าที่ parse ไม่ได้เก็บดิบไว้ใน `user_gold_legacy_raw` · รันซ้ำได้
- **แอปเวอร์ชันเก่าที่ยังค้างในเครื่อง** (PWA) ถ้ายังส่งทองมากับ `user_data`: trigger ย้ายไป `user_gold_data` ให้ (เฉพาะ Premium) หรือทิ้งเฉพาะคีย์ทอง (ไม่มี Premium) — `user_data` ไม่มีทองอีก
- **ในเครื่อง**: ข้อมูลทองยังเก็บใน localStorage ของบัญชี (ใช้ออฟไลน์ได้) · ออฟไลน์ → ขึ้น "บันทึกไว้ในเครื่อง" แล้วส่งเมื่อกลับมาออนไลน์ · ราคา GOLD2go ที่ดึงอัตโนมัติไม่ถูกส่งขึ้น Cloud (เป็นข้อมูลตลาด ไม่ใช่ข้อมูลส่วนตัว)
- ระหว่างใช้งานถ้าสิทธิ์หมด → server ปฏิเสธ → หน้าเปลี่ยนเป็นหน้าอัปเกรดทันที (ข้อมูลใหม่ยังอยู่ในเครื่อง)
- หน้าแรก: กล่อง "พอร์ตทอง · มูลค่าปัจจุบัน" ในการ์ดสถิติ แสดงเฉพาะ Premium

### ไฟล์ที่สร้าง
| ไฟล์ | |
|---|---|
| `supabase/migrations/20261114000800_gold_premium.sql` | `user_gold_data` + RLS · `get_my_gold()` · `save_my_gold()` · `kfp_validate_gold` · ย้ายข้อมูล · `user_gold_legacy_raw` · trigger `kfp_route_gold_keys` (แทน `kfp_protect_gold_keys` ของ Phase 5) |
| `kfp-gold-sync.js` | ซิงก์ทองในหน้า gold.html: ดึง/ส่ง/เวอร์ชัน/เลือกเมื่อชนกัน/ออฟไลน์/สถานะ |
| `tests/sql/phase9_test.sql`, `tests/e2e/phase9.test.js` | ทดสอบ |

### ไฟล์ที่แก้
`gold.js` (3 จุด: แจ้ง sync หลัง `saveLots` / `saveSettings` / ลบทั้งหมด — สูตรและการแสดงผลไม่เปลี่ยน) · `gold.html` (โหลด `kfp-gold-sync.js`) · `auth.js` (เอาคีย์ทองออกจาก Cloud Sync ของ `user_data`) · `kfp-config.js` (กล่องพอร์ตทองหน้าแรก `data-feature="gold_portfolio"`) · `kfp-access.css` (ป้ายสถานะ + กล่องเลือกข้อมูล) · `sw.js` (+kfp-gold-sync.js, cache saas9) · `index.html`, `pricing.html`, `account.html` (เวอร์ชันไฟล์) · `tests/e2e/mock-supabase.js`

### Database / Environment
- Migration: `20261114000800_gold_premium.sql` — **รันก่อนอัปโหลดหน้าเว็บ** (หน้าเว็บใหม่ไม่ส่งทองผ่าน `user_data` แล้ว)
- ไม่มี Secret / Edge Function ใหม่

### ผลการทดสอบ
| ชุด | ผล |
|---|---|
| SQL Phase 9 (7 กลุ่ม): ย้ายข้อมูล (string → JSON, ไม่มี settings, JSON เสีย → เก็บดิบ, ลบจาก user_data เฉพาะที่คัดลอกแล้ว, รันซ้ำไม่ซ้ำ) · อ่าน: Premium / Free / Plus / ถูกระงับ / ค้างชำระในช่วงผ่อนผัน / สิทธิ์ legacy / anon · เขียน: เวอร์ชัน, ไม่เปลี่ยน = ไม่ขึ้นเวอร์ชัน, เวอร์ชันเก่า → conflict, บังคับเขียนทับ, validation 8 แบบ, insert/update/delete ตรงถูกปฏิเสธ, Free/Plus → `premium_required` · แอปเก่า: Premium ย้ายให้ / Plus ทิ้งเฉพาะทอง · หมดอายุ → ซ่อน → สมัครใหม่ → ข้อมูลเดิมกลับมา · rate limit · ลบบัญชี → ลบทอง | ✅ |
| E2E Phase 9 (33 ข้อ): Preview ไม่แตะ Cloud · Premium ครั้งแรกส่งข้อมูลเครื่อง (base 0) และ login ไม่ลบทองในเครื่อง · เพิ่มรอบซื้อ → บันทึกครั้งเดียวพร้อมเวอร์ชัน · ราคา auto ไม่ส่ง · อัปโหลด user_data ไม่มีทอง · เครื่องที่ 2 ได้ข้อมูลจาก Cloud · Cloud ใหม่กว่า → อัปเดตเงียบ · ชนกัน → เลือก Cloud / เลือกเครื่องนี้ (สำรองอีกชุด) · อีกเครื่องบันทึกก่อน → ไม่เขียนทับ · ออฟไลน์ → ส่งเมื่อกลับมา · Plus เห็นหน้าอัปเกรด "เก็บไว้ 3 รอบ" ไม่มีการส่ง · สิทธิ์หมดระหว่างใช้ → หน้าอัปเกรด · กล่องทองหน้าแรกเฉพาะ Premium · มือถือ 360px | ✅ 33/33 |
| รันซ้ำ: SQL Phase 2/5/6/7/8 · Edge 81 · TypeScript · E2E Phase 2–8 | ✅ ทั้งหมด (49 · 61 · 74 · 57 · 8 · 24 · 51) |

### ปัญหาที่พบ / ข้อจำกัด
1. พบและแก้ระหว่างทดสอบ: trigger แบบ `security definer` มองเห็น `current_user` เป็นเจ้าของฟังก์ชันเสมอ ทำให้ทุกคนดูเป็น "trusted" → เปลี่ยนไปตัดสินจาก JWT (`service_role` หรือไม่มี JWT เลย = SQL Editor/migration)
2. migration ลบคีย์ทองออกจาก `user_data` ทำให้ `updated_at` เปลี่ยน → แต่ละเครื่องจะโหลดข้อมูล Cloud ซ้ำหนึ่งครั้ง (ข้อมูลเหมือนเดิม ไม่มีผลเสีย)
3. ข้อมูลทองที่อยู่ใน localStorage ของเครื่องยังเป็นของผู้ใช้ (ใช้ออฟไลน์) · คนที่ไม่มี Premium มองไม่เห็นผ่านหน้าเว็บ แต่ถ้าเปิด DevTools ก็เห็นข้อมูลของตัวเองในเครื่องได้ — สิ่งที่ server ป้องกันคือการอ่าน/เขียน/ซิงก์ผ่าน Cloud
4. ถ้าเลือก "ใช้ข้อมูลเครื่องนี้" ข้อมูล Cloud เดิมสำรองไว้เฉพาะในเครื่องนั้น (`__kfp_gold_backup_v1`) ยังไม่มีหน้ากู้คืน — กู้ได้โดยผู้ดูแล/DevTools · เพิ่มปุ่มกู้คืนได้ภายหลังถ้าต้องการ
5. ยังไม่ได้ทดสอบบน Supabase จริง (ทดสอบกับ Postgres 16 + stub ของ Supabase)

---

## Phase 10 · Admin Dashboard ✅ (14/11/2026)

### หน้า `admin.html` (Admin Console)
| แท็บ | แสดง / ทำได้ |
|---|---|
| 📊 ภาพรวม | สมาชิกทั้งหมด · สมัครใหม่วันนี้/เดือนนี้ (เวลาเกาหลี) · Free/Plus/Premium · ได้สิทธิ์จากการให้ · ถูกระงับ · Subscription: ใช้งานอยู่/ทดลอง/ตั้งยกเลิก/ค้างชำระ/หมดอายุ · Churn 30 วัน · **MRR / ARR / รายได้สุทธิ / ARPU แยก THB กับ KRW** · จ่ายไม่สำเร็จ 30 วัน · webhook ล้มเหลว · สัดส่วน Active/Recent/Inactive/Dormant |
| 👥 สมาชิก | User ID · Email · Username · ประเทศ · แพ็กเกจ · สถานะ subscription · วันสมัคร · เริ่ม subscription · วันหมดอายุ · เข้าสู่ระบบล่าสุด · ใช้งานล่าสุด (+หน้าล่าสุด) · จำนวนวันที่ไม่ได้ใช้ · **ค้นหา / กรอง (แพ็กเกจ, สถานะ, การใช้งาน, ประเทศ, ระงับ) / เรียง / แบ่งหน้า ฝั่ง server** (สูงสุด 100 แถว/หน้า) · มือถือแสดงเป็นการ์ด |
| รายละเอียดสมาชิก | โปรไฟล์ · อีเมล · การสมัคร · Subscription ทั้งหมด · Stripe Customer ID · Stripe Subscription ID · ประวัติชำระเงิน/ใบแจ้งหนี้ (ลิงก์) · คืนเงิน · Grants · สิทธิ์ปัจจุบัน · การใช้งานล่าสุด 50 รายการ · Audit log ของสมาชิก · จำนวนรอบทองบน Cloud |
| การจัดการ | **เปลี่ยนแพ็กเกจ** (Plus/Premium + วันหมดอายุ หรือ Free) · **ให้ Premium** (30/90/365 วัน/ไม่มีกำหนด) · **ขยายสิทธิ์** (+N วัน) · **ยกเลิกสิทธิ์ที่ให้** · **ระงับ/เปิดบัญชี** · **ยกเลิก subscription** (สิ้นรอบ หรือทันที — ผ่าน Stripe จริง) · ทุกปุ่มมีหน้ายืนยัน + เหตุผลบังคับ · การกระทำที่ร้ายแรงต้องพิมพ์อีเมลของสมาชิก |
| 💰 รายได้ | ต่อสกุลเงิน: MRR, ARR, สมาชิกที่จ่าย, ARPU, Gross, คืนเงิน, Net, Net ในช่วงที่เลือก · Net รายเดือน (กราฟแท่งแยกสกุลเงิน) · รายได้ตามแพ็กเกจ · จ่ายไม่สำเร็จ · คืนเงิน |
| 🏷️ ราคา | 8 ช่อง (Plus/Premium × เดือน/ปี × THB/KRW) · ตั้ง/แก้ราคา (เช่น **KRW รายปี**) · ปิดขาย · ประวัติราคาเดิม |
| 📜 Audit log | ทุกการกระทำของผู้ดูแล: เวลา ผู้ดูแล การกระทำ สมาชิก เหตุผล ก่อน/หลัง · กรองตามประเภท · แบ่งหน้า |

### ความปลอดภัย
- **ตรวจบทบาทในฐานข้อมูลทุกครั้ง** (`admin_roles` + บัญชีไม่ถูกระงับ) — หน้าเว็บแค่แสดงผล · สมาชิกทั่วไปเรียก `admin_*` ได้ 403 · เพิ่มตัวเองเป็น admin ไม่ได้ (ไม่มีสิทธิ์ insert)
- บทบาท: **viewer** ดูอย่างเดียว · **admin** ดู + จัดการสมาชิก/ราคา · **owner** เหมือน admin + จัดการบัญชีผู้ดูแลคนอื่นได้
- ทำกับบัญชีตัวเองไม่ได้ · admin ทำกับ admin/owner คนอื่นไม่ได้ · admin ที่ถูกระงับหมดสิทธิ์ทันที
- ทุกการเปลี่ยนแปลงต้องมีเหตุผล (3–500 ตัวอักษร) และเขียน `admin_audit_logs` (แก้/ลบไม่ได้) พร้อมสถานะก่อน/หลัง
- ไม่มีการลบข้อมูล: ยกเลิกสิทธิ์ = ใส่ `revoked_at` · ระงับ = `suspended_at`
- ยกเลิก subscription ผ่าน Edge Function `admin-actions`: อ่านบทบาทจากฐานข้อมูลด้วย token ของผู้ดูแล (ไม่เชื่อ body) · ตรวจว่า subscription เป็นของ customer นั้นจริง · rate limit 60 ครั้ง/ชม.
- ข้อความทุกช่องแสดงแบบ text (ทดสอบด้วย `<img onerror>` / `<script>`) · ลิงก์รับเฉพาะ `https://` · หน้า admin ไม่ถูก cache ใน Service Worker · `noindex`

### รองรับจำนวนสมาชิก
- คำนวณแพ็กเกจของทุกคนในคำสั่งเดียว (`kfp_effective_plans_all`, ทดสอบว่าให้ผลตรงกับ `kfp_effective_plan` ทีละคนทุกบัญชี) · ค้นหา/กรอง/เรียง/แบ่งหน้าใน SQL · index ใหม่ 7 ตัว
- ทดสอบกับ **สมาชิก 50,000 คน + subscription 10,000**: รายชื่อ 1 หน้า ~0.55 วิ · ค้นหา ~0.25 วิ · ภาพรวม ~0.17 วิ · รายได้ ~0.05 วิ
- พบและแก้: Postgres JIT ทำให้รายงานรายได้ช้า 5.4 วิ (เวลาคอมไพล์ JIT) → ปิด JIT เฉพาะฟังก์ชันรายงาน → 0.05 วิ

### ไฟล์ที่สร้าง
| ไฟล์ | |
|---|---|
| `supabase/migrations/20261114000900_admin_dashboard.sql` | `admin_whoami/overview/list_users/user_detail/revenue/audit_list/list_prices` · `admin_set_plan/extend_access/revoke_access/set_suspended` · helper บทบาท/เป้าหมาย · `kfp_effective_plans_all` · `kfp_admin_role`, `kfp_admin_audit` (service_role) · index |
| `admin.html`, `admin.js`, `admin.css` | Admin Console |
| `supabase/functions/admin-actions/index.ts` | ยกเลิก subscription ใน Stripe (สิ้นรอบ / ทันที) |
| `tests/sql/phase10_test.sql`, `tests/e2e/phase10.test.js` | ทดสอบ |

### ไฟล์ที่แก้
`supabase/functions/_shared/billing.ts` (`adminCancelSubscription`, `subscriptions.cancel`) · `auth.js` (ลิงก์ 🛡️ Admin ในหน้าต่างบัญชี เฉพาะผู้ดูแล) · `sw.js` (ไม่ cache หน้า admin, cache saas10) · `index.html`, `gold.html`, `pricing.html`, `account.html` (เวอร์ชันไฟล์) · `tests/edge/billing.test.ts`, `tests/e2e/mock-supabase.js`, `tests/ts/deno-shim.d.ts` · `tests/run-sql-tests.sh`, `tests/run-e2e.sh` (เรียงไฟล์ phase10 หลัง phase9)

### Database / Environment
- Migration: `20261114000900_admin_dashboard.sql` (รันซ้ำได้)
- Deploy: `supabase functions deploy admin-actions` · ไม่มี Secret ใหม่
- ผู้ดูแลคนแรก: เพิ่มด้วย SQL (SETUP Phase 6 ข้อ 2)

### ผลการทดสอบ
| ชุด | ผล |
|---|---|
| SQL Phase 10 (9 กลุ่ม): สิทธิ์ (anon / สมาชิก / admin ถูกระงับ / viewer อ่านอย่างเดียว / owner) · plan แบบ set-based = แบบรายคนทุกบัญชี · ตัวเลขภาพรวม + MRR ที่เพิ่มขึ้นตรงเป๊ะ (KRW +9,900 · THB รายปี ÷ 12) · ค้นหา (อีเมล/username/ID, `%` `_` ไม่ใช่ wildcard) / ตัวกรอง 7 แบบ / เรียง / แบ่งหน้า / จำกัด 100 · รายละเอียด · ให้/เปลี่ยน/ขยาย (grant และ subscription)/ยกเลิก/ระงับ/เปิดคืน + audit ก่อน/หลัง · เหตุผลบังคับ · ห้ามทำกับตัวเอง · admin กับ admin · owner ทำได้ · รายได้แยกสกุลเงิน · ฟังก์ชันของ Edge เป็น service_role · 50k users | ✅ |
| Edge core 96 ข้อ (+15): viewer/สมาชิก → 403 · mode/เหตุผล · ห้ามทำกับตัวเอง/admin อื่น · ไม่มี subscription · ยกเลิกสิ้นรอบ (Stripe + DB + audit) · ยกเลิกทันที → Free · admin ถูกระงับ → 403 | ✅ 96/96 |
| E2E Phase 10 (48 ข้อ): guest · สมาชิกธรรมดา 403 (ไม่โหลดข้อมูลอื่น) · ภาพรวม · ลิงก์ Admin เฉพาะผู้ดูแล · รายชื่อ/ค้นหา/กรอง/เรียง/หน้า · XSS · รายละเอียด · ยืนยัน+เหตุผล · พิมพ์อีเมลยืนยัน · ยกเลิก subscription ผ่าน Edge · admin กับ admin ล็อก · รายได้ · ราคา (₩59,000 ไม่คูณ 100, ฿149.50 → 14950) · audit · viewer · ตัวเอง · มือถือ | ✅ 48/48 |
| รันซ้ำทั้งหมด: SQL Phase 2/5/6/7/8/9 · TypeScript · E2E Phase 2–9 | ✅ (49 · 61 · 74 · 57 · 8 · 24 · 51 · 33) |

### ปัญหาที่พบ / ข้อจำกัด
1. "เปลี่ยนแพ็กเกจ" ของผู้ดูแล = ให้สิทธิ์ (grant) — ระบบใช้แพ็กเกจที่สูงที่สุด จึง**ลดแพ็กเกจของคนที่จ่ายเงินอยู่ไม่ได้ด้วยวิธีนี้** (ต้องยกเลิก subscription หรือให้ลูกค้าเปลี่ยนในหน้า Billing)
2. "ขยายสิทธิ์" ไม่เลื่อนรอบบิลของ Stripe (ให้สิทธิ์ต่อหลังรอบหมด) · ถ้าต้องการเลื่อนการเก็บเงินจริงให้ทำใน Stripe Dashboard
3. คืนเงิน (refund) ทำใน Stripe Dashboard — ระบบรับผลผ่าน webhook `charge.refunded` และแสดงในแท็บรายได้
4. ระงับบัญชีไม่ได้บังคับ logout ทันที (token เดิมใช้ได้ถึงหมดอายุ ~1 ชม.) แต่สิทธิ์ทุกอย่างถูกตรวจใหม่ที่ server จึงกลายเป็น Free ทันที
5. Activity Monitor แบบละเอียด (กราฟรายวัน, หน้าที่ใช้บ่อย, retention) อยู่ใน Phase 11

---

## Phase 11 · Activity Monitoring & Analytics ✅ (14/11/2026)

### เก็บข้อมูลการใช้งานอย่างไร (ไม่เขียนทุกครั้งที่กดปุ่ม)
| อะไร | เมื่อไร | จำกัดฝั่งเครื่อง | จำกัดฝั่ง server |
|---|---|---|---|
| หน้า (page) | เปิดหน้า / กลับมาที่แท็บ / ทุก 5 นาทีที่หน้ายังเปิดอยู่ | ≤ 1 ครั้ง/หน้า/5 นาที | log ≤ 1/หน้า/5 นาที · `last_active_at` ≤ 1/นาที |
| ฟีเจอร์ (ใหม่) | เปิดบันทึกการเข้างาน · รายจ่าย · Export · Cloud Sync · พอร์ตทอง (เมื่อมีสิทธิ์) | ≤ 1 ครั้ง/ฟีเจอร์/30 นาที | ≤ 1/ฟีเจอร์/30 นาที |
| สรุปรายวัน (ใหม่) | ทุกครั้งที่ข้างบนถูกบันทึก | — | 1 แถว/คน/วัน (เวลาเกาหลี): เห็นครั้งแรก/ล่าสุด, จำนวนครั้ง, หน้า, ฟีเจอร์ |
- เก็บแค่**ชื่อหน้า/ชื่อฟีเจอร์และเวลา** — ไม่เก็บเนื้อหา ตัวเลขเงิน IP หรือการพิมพ์ · ชื่อที่ส่งมาถูกกรองอักขระ และหนึ่งวันเก็บได้ไม่เกิน 60 ชื่อ (กันข้อมูลขยะ)
- Guest / Preview ไม่ถูกเก็บเลย · กดปุ่มเดิม 5 ครั้ง = 1 รายการ
- เก็บ log ดิบ 90 วัน · สรุปรายวัน 400 วัน (`kfp_activity_maintenance()` ตั้ง pg_cron วันละครั้ง)

### Admin Console → แท็บ 📈 การใช้งาน
- DAU วันนี้ · WAU · MAU · Stickiness (DAU เฉลี่ย ÷ MAU) · ผู้ใช้งานและสมัครใหม่ในช่วงที่เลือก (7/30/90/180 วัน)
- สถานะ **Active (≤ 24 ชม.) · Recent (≤ 7 วัน) · Inactive (8–30 วัน) · Dormant (> 30 วัน) · ยังไม่เคยใช้** — แตะการ์ดเพื่อเปิดรายชื่อสมาชิกที่กรองแล้ว · ตารางแยกตามแพ็กเกจ
- กราฟผู้ใช้รายวันและสมัครใหม่รายวัน · ช่วงเวลาที่ใช้ (เวลาเกาหลี) · วันในสัปดาห์
- ฟีเจอร์ที่ใช้ (จำนวนคน, % ของผู้ใช้งาน, จำนวนครั้ง) · หน้าที่เปิดบ่อย
- Retention ตามสัปดาห์ที่สมัคร (สัปดาห์ 1–4)
- **สมาชิกที่จ่ายเงินแต่ไม่ได้ใช้ > 14 วัน (เสี่ยงยกเลิก)** พร้อม MRR — แตะเพื่อเปิดรายละเอียด
- รายละเอียดสมาชิก: แถบการใช้งาน 30 วัน + หน้า/ฟีเจอร์ที่ใช้ · Last Active และ Last Visited Page (มีตั้งแต่ Phase 10)
- รายงานถูกแคช 10 นาที (ปุ่ม "คำนวณใหม่" เพื่อบังคับ)

### ไฟล์ที่สร้าง
| ไฟล์ | |
|---|---|
| `supabase/migrations/20261114001000_activity_analytics.sql` | `user_activity_daily` + backfill · `touch_activity` v2 (kind `feature`) · `admin_activity_analytics` (+ cache) · `admin_user_activity` · `kfp_activity_maintenance` |
| `tests/sql/phase11_test.sql`, `tests/e2e/phase11.test.js` | ทดสอบ |

### ไฟล์ที่แก้
`kfp-access.js` (นับการใช้ฟีเจอร์) · `admin.html`, `admin.js`, `admin.css` (แท็บการใช้งาน, แถบ 30 วันในรายละเอียด, KPI 2 คอลัมน์บนมือถือ) · `sw.js` + เวอร์ชันไฟล์ใน `index.html`, `gold.html`, `pricing.html`, `account.html` · `tests/e2e/mock-supabase.js`, `tests/e2e/phase6.test.js` (นับเฉพาะ heartbeat ของหน้า), `tests/run-sql-tests.sh`

### Database / Environment
- Migration: `20261114001000_activity_analytics.sql` (รันซ้ำได้) · ไม่มี Secret / Edge Function ใหม่
- (แนะนำ) pg_cron รัน `kfp_activity_maintenance()` ทุกวัน — ดู SETUP

### ผลการทดสอบ
| ชุด | ผล |
|---|---|
| SQL Phase 11 (4 กลุ่ม): heartbeat 100 ครั้งติด = 1 แถว · เปลี่ยนหน้า → บันทึก + last page · ฟีเจอร์ 1 ครั้ง/30 นาที, กรองชื่อ, ไม่เปลี่ยน last page · ผ่านไป 6 นาทีจึงนับใหม่ · ชื่อขยะ 80 ชื่อ → เก็บ ≤ 60 · anon ห้าม · สมาชิกเห็นเฉพาะของตัวเอง เขียนเองไม่ได้ อ่าน analytics ไม่ได้ · DAU/WAU/MAU ตรงกับการนับตรง · buckets ครอบคลุมทุกคน · หน้า/ฟีเจอร์/ชั่วโมง/วัน · cohort ปัจจุบันยังไม่มีค่า · at-risk (MRR ₩89,000/12) · แถบ 30 วัน · แคช · maintenance (service_role เท่านั้น) · **50,000 คน / 10,000 คนต่อวัน / 300k แถว: คำนวณใหม่ ~2.2 วิ · จากแคช ~0 วิ** | ✅ |
| E2E Phase 11 (21 ข้อ): heartbeat ตอนเปิด 1 ครั้ง · กด 5 ครั้ง = 1 · Export/บันทึกงาน · ส่งแค่ชื่อ · reload ไม่เขียนซ้ำ · ทองนับเฉพาะ Premium · Preview ไม่นับ · แท็บการใช้งาน (KPI, กราฟ 30/24/7 แท่ง, ฟีเจอร์, หน้าแสดงเป็น text, retention, ตาราง plan, แคช, เปลี่ยนช่วง, คำนวณใหม่) · แตะ Dormant → รายชื่อกรองแล้ว · at-risk → รายละเอียด + แถบ 30 วัน · มือถือ | ✅ 21/21 |
| รันซ้ำทั้งหมด: SQL Phase 2/5–10 · Edge 96 · TypeScript · E2E Phase 2–10 | ✅ (49 · 61 · 74 · 57 · 8 · 24 · 51 · 33 · 48) |

### ปัญหาที่พบ / ข้อจำกัด
1. พบและแก้: รายงานใช้ 3.2 วิ ที่ 50k คน (นับผู้ใช้ไม่ซ้ำต่อหน้า/ฟีเจอร์ด้วยการ sort ข้อมูล 600k แถว) → เปลี่ยนเป็นนับ 2 ขั้นแบบ hash → 2.2 วิ และเพิ่มแคช 10 นาที
2. พบและแก้: เทสต์ Phase 6 นับ ping ของหน้ารวมกับเหตุการณ์ฟีเจอร์ใหม่ → ให้นับเฉพาะ heartbeat ของหน้า
3. "เวลาใช้งาน" เป็นค่าประมาณจากจำนวนครั้ง (≈ 5 นาที/ครั้ง) ไม่ใช่เวลาจริงทุกวินาที — ตั้งใจเพื่อไม่ให้เขียนฐานข้อมูลบ่อย
4. ข้อมูลก่อน Phase 11 ไม่มีการนับฟีเจอร์ (backfill ได้เฉพาะหน้าจาก log ดิบ)
5. ควรเพิ่มข้อความในนโยบายความเป็นส่วนตัวว่าเก็บชื่อหน้า/ฟีเจอร์ที่ใช้และเวลา เพื่อปรับปรุงบริการ

---

## Phase 12 · Security Audit & Full Testing ✅ (14/11/2026)

รายงานเต็ม: **`docs/SECURITY_AUDIT.md`** · ตารางเทสต์ 30 ข้อตามสเปก: **`docs/TEST_MATRIX.md`** · เช็กลิสต์เปิดระบบ: **`docs/GO_LIVE.md`**

### สิ่งที่พบและแก้
| # | ระดับ | เรื่อง | แก้ |
|---|---|---|---|
| F1 | สูง (ใช้งาน) | "บันทึกชื่อ" ในหน้าต่างบัญชีล้มเหลวทุกครั้งบน Supabase จริง (ส่ง `updated_at` ซึ่ง browser ไม่มีสิทธิ์แก้) | ส่งแค่ `nickname` |
| F2 | กลาง | สคริปต์ CDN ไม่ล็อกเวอร์ชัน | ล็อก supabase-js 2.97.0 / xlsx 0.18.5 (เว็บ + Edge) |
| F3 | กลาง | เครื่องที่ใช้ร่วมกัน: ข้อมูลบัญชีค้างในเครื่องหลัง logout | ปุ่ม "ออกจากระบบและลบข้อมูลบัญชีนี้ออกจากเครื่องนี้" (รวม backup iOS) |
| F4 | กลาง | หน้า Admin ไม่มี CSP / กัน clickjacking | CSP เข้ม + frame-busting |
| F5 | ต่ำ | เปิด URL ใดก็ได้ที่ Edge ตอบกลับ | เปิดเฉพาะ Stripe / โดเมนตัวเอง |
| F6 | ต่ำ | trigger functions เรียกผ่าน API ได้ | revoke + ลบฟังก์ชันเก่า |
| F7 | ต่ำ | สิทธิ์ profiles เกินจำเป็น · ไม่จำกัดขนาด user_data/ชื่อเล่น | revoke + constraint + guard trigger (≤ 2 MB) |

### ไฟล์ที่สร้าง
| ไฟล์ | |
|---|---|
| `supabase/migrations/20261114001100_security_hardening.sql` | revoke trigger functions · profiles เขียนได้แค่ nickname/country (+ข้อจำกัด) · `user_data` guard · **`kfp_security_report()`** |
| `tests/sql/phase12_test.sql` | S1 report สะอาด + จับปัญหาที่จงใจใส่ได้ · S2 ฟังก์ชัน definer ทั้งหมด · S3 แยกข้อมูลทุกตาราง (generic) · S4 ยกระดับสิทธิ์/แก้ subscription · S5 SQL injection · S6 anon |
| `tests/security/static-audit.js` | ตรวจแบบ static 39 ข้อ (secret, CDN, eval, ลิงก์, RPC/Edge ที่เรียกต้องมีจริง, Edge ต้องตรวจ JWT, CSP, service worker) |
| `tests/e2e/phase12.test.js` | X1 XSS canary ทุกจุด · X2 guest เปิดทุกหน้าไม่มีการเขียน · X3 CSP admin · X4 ลบออกจากเครื่อง · X5 redirect เฉพาะ Stripe · X6 profile/แยกบัญชี |
| `tests/sql/scale_bench.sql`, `tests/run-scale.sh`, `tests/run-all.sh` | benchmark 100 → 50,000 · รันทุกอย่างคำสั่งเดียว |
| `docs/SECURITY_AUDIT.md`, `docs/TEST_MATRIX.md`, `docs/GO_LIVE.md` | รายงาน |

### ไฟล์ที่แก้
`auth.js` (F1, F3) · `kfp-storage.js` (`wipeUser`) · `pricing.html`, `account.html` (F5) · `admin.html`, `admin.js` (F4) · `index.html`, `gold.html`, `pricing.html`, `account.html`, `admin.html`, `auth-callback.html` (เวอร์ชัน CDN + เวอร์ชันไฟล์) · `supabase/functions/username-login/index.ts`, `_shared/supabase.ts`, `tests/ts/deno-shim.d.ts` (ล็อก supabase-js) · `sw.js` (cache saas12) · `tests/run-sql-tests.sh`

### Database / Environment
- Migration: `20261114001100_security_hardening.sql` (รันซ้ำได้ · ไม่แก้แถวเดิม — constraint ใหม่เป็น `NOT VALID`)
- ไม่มี Secret ใหม่ · Edge Functions ทุกตัว **deploy ใหม่** (ล็อกเวอร์ชัน supabase-js)

### ผลการทดสอบ (รันทั้งหมดด้วย `tests/run-all.sh --scale`)
| ชุด | ผล |
|---|---|
| SQL Phase 2, 5, 6, 7, 8, 9, 10, 11, 12 | ✅ ALL PASSED |
| Edge Functions | ✅ 96/96 |
| TypeScript | ✅ |
| Static security audit | ✅ 38 · ⚠️ 1 (SRI — GO_LIVE ข้อ 3) |
| E2E Phase 2–12 | ✅ 446/446 (49 · 61 · 74 · 57 · 8 · 24 · 51 · 33 · 48 · 21 · 20) |
| Scale 100 / 1k / 10k / 50k | ✅ คำสั่งของสมาชิก 1–2 ms ทุกระดับ · admin ≤ 0.5 วิ · รายงานการใช้งาน 2.6 วิ (แคช 0 วิ) |
| 30 ข้อตาม PART 13 | ✅ ทุกข้อมีเทสต์อัตโนมัติ · ข้อที่ต้องใช้บริการจริงมี checklist staging (TEST_MATRIX) |

### ข้อจำกัดที่เหลือ
SRI ยังไม่ได้ใส่ (ต้องออกเน็ตเพื่อคำนวณ hash) · GitHub Pages ตั้ง HTTP header ไม่ได้ (ใช้ meta CSP บนหน้า admin) · ยังไม่ได้ทดสอบกับ Supabase/Stripe/อีเมลจริงและ iOS Safari · ควรมี "ลบบัญชี" + Privacy Policy ก่อนเปิดขาย — รายละเอียด SECURITY_AUDIT §4

---

## ตรวจทานครั้งสุดท้ายเทียบ Master Prompt V2 (14/11/2026)

ไล่ตรวจทุก PART เทียบกับไฟล์จริง — พบ 3 ข้อที่ยังไม่ครบ และเพิ่มตัวช่วยติดตั้ง:

| PART | ข้อกำหนด | ก่อน | ตอนนี้ |
|---|---|---|---|
| 7 | "เก็บข้อมูลไว้…และให้ลูกค้าสามารถ Export ข้อมูลได้" (หลังหมดอายุ) | Export Excel เป็นของ Plus ขึ้นไป → สมาชิกที่หมดอายุ/Free ดาวน์โหลดข้อมูลตัวเองไม่ได้ | **account.html → "📦 ข้อมูลของฉัน"**: ดาวน์โหลด JSON ได้ทุกแพ็กเกจ (ข้อมูลในเครื่องของบัญชีนี้ + พอร์ตทองบน Cloud ผ่าน `export_my_gold()` อ่านอย่างเดียว, 10 ครั้ง/ชม.) |
| 10 | Gold: Backup / **Restore** / Export | มี Export + สำรองอัตโนมัติ แต่ไม่มีปุ่มกู้คืน | **gold.html → "♻️ กู้คืนจากไฟล์"** (ไฟล์จาก Export, ตรวจรูปแบบ, ยืนยันก่อนแทนที่) + **"↩️ ย้อนกลับ"** (ข้อมูลชุดก่อนกู้คืน/ก่อนเลือกข้อมูลจาก Cloud) · สูตรคำนวณไม่เปลี่ยน |
| 9 | ตารางสมาชิกของ Admin มีคอลัมน์ **Country** | มีคอลัมน์ในฐานข้อมูล แต่สมาชิกไม่มีที่ให้กรอก → ว่างทุกคน | หน้าต่างบัญชี → **"ประเทศที่ทำงาน/อยู่"** (ไม่บังคับ) บันทึกพร้อมชื่อที่แสดง · ฐานข้อมูลรับเฉพาะรหัส 2 ตัว (KR, TH …) |
| — | ติดตั้งฐานข้อมูล | ต้องรัน 10 ไฟล์ทีละไฟล์ | **`supabase/install_all.sql`** ไฟล์เดียว (สร้างด้วย `tools/build-install-sql.sh`) · ทดสอบติดตั้งบนฐานข้อมูลว่าง + บัญชีเดิม: `tests/run-fresh-install.sh` → 18 ตาราง, ข้อมูลเดิมครบ, ทองย้ายแล้ว, security findings 0 |

ไฟล์ที่แก้/เพิ่ม: `account.html`, `auth.js` (ประเทศ), `gold.html`, `gold.js`, `kfp-access.js` (gate ปุ่มใหม่ใน Preview), `supabase/migrations/20261114001100_security_hardening.sql` (+`export_my_gold`), `supabase/install_all.sql`, `tools/build-install-sql.sh`, `tests/run-fresh-install.sh`, `tests/sql/fresh_seed.sql`, `tests/sql/phase12_test.sql` (S7), `tests/e2e/phase12.test.js` (X7, X8), `tests/e2e/mock-supabase.js`, `docs/GO_LIVE.md` (ข้อ 0 ดูหน้าตาก่อน + git branch, ข้อ 1 ใช้ install_all.sql), เวอร์ชันไฟล์ `saas13`
