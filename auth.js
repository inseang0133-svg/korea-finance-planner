/* Korea Finance Planner - Supabase login + MANUAL Cloud upload layer
 *
 * Important behavior:
 * - LocalStorage remains the working copy on the device.
 * - Logging in NEVER uploads local data automatically.
 * - When a session is opened, existing Cloud data is loaded immediately and
 *   becomes authoritative for the personal data keys used by this app.
 * - If the Cloud record is empty, local data is kept and can be uploaded
 *   explicitly with the Cloud upload button.
 * - No LocalStorage change schedules an automatic Cloud upload.
 * - Realtime Cloud subscriptions are intentionally disabled so Cloud cannot
 *   silently overwrite the working copy while the user is editing locally.
 */
/* SaaS update (Phase 2): real e-mail accounts, username login via the
 * `username-login` Edge Function, forgot/reset password, change e-mail /
 * password, resend verification, and "link a real e-mail" for legacy
 * username@kfp.example.com accounts. Cloud load/upload behaviour above is
 * unchanged.
 */
(() => {
  "use strict";

  const CFG = window.KFP_SUPABASE_CONFIG || {};
  const SUPABASE_URL = CFG.SUPABASE_URL || "";
  const SUPABASE_ANON_KEY = CFG.SUPABASE_ANON_KEY || "";
  const VALID_CONFIG = /^https:\/\/[^\s]+\.supabase\.co(mp)?$/i.test(SUPABASE_URL) &&
    SUPABASE_ANON_KEY && !SUPABASE_ANON_KEY.includes("YOUR_SUPABASE");

  // Keep the existing Cloud payload/schema exactly the same.
  // NOTE: "rate" / "rateUpdatedAt" (อัตราแลกเปลี่ยนหน้าหลัก) ถูกเก็บเฉพาะในเครื่อง
  // ไม่อัปโหลด/ไม่ดาวน์โหลดผ่าน Cloud เพื่อไม่ให้เรตเก่าจาก Cloud มาทับเรตล่าสุด
  const DATA_KEYS = [
    "salary", "goal", "currentSaving",
    "contractStartDate", "salaryRecords",
    "salaryThb", "kfp_alloc_v1", "kfp_mode_v1",
    "__kfp_deleted_keys_v1",
    // Phase 9: gold (kfp_gold_lots_v1 / kfp_gold_settings_v1) is NOT part of user_data any more —
    // it syncs through the Premium-only table user_gold_data (kfp-gold-sync.js).
    "kfp_work_settings_v1", "kfp_work_records_v1", "kfp_work_deductions_v1",
    "kfp_work_received_v1", "kfp_expenses_v1"
  ];

  const ARRAY_KEYS = new Set(["salaryRecords", "kfp_work_records_v1", "kfp_work_deductions_v1", "kfp_expenses_v1"]);
  const GUEST_BACKUP_KEY = "__kfp_guest_backup_v1";
  const AUTH_USER_KEY = "__kfp_auth_user_v1";
  const PROFILE_CACHE_KEY = "__kfp_profile_cache_v1";
  const AUTH_TIMEOUT_MS = 15000;
  const LEGACY_DOMAIN = "@kfp.example.com";
  const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const CALLBACK_URL = (() => { try { return new URL("auth-callback.html", location.href).href; } catch (_) { return ""; } })();
  // Real (non-proxied) storage for the Supabase session: kfp-storage.js
  // (Phase 3) swaps window.localStorage for guests; auth must not use that.
  const SESSION_STORAGE = window.__kfpRealLocalStorage || window.localStorage;
  // Phase 3: kfp-storage.js isolates Preview (demo) and Member (per-account) data.
  const KS = window.kfpStorage || null;
  // updated_at of the Cloud row this device last applied or uploaded (per account).
  const CLOUD_SEEN_KEY = "__kfp_cloud_seen_v1";
  // Switch Preview ⇄ Member by reloading so every script re-reads the right data.
  function switchMode(reason) { return !!(KS && KS.reboot(reason)); }
  const DATA_TIMEOUT_MS = 12000;

  function withTimeout(promise, ms, message) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
    ]);
  }

  function readCachedProfile(userId) {
    try {
      const raw = localStorage.getItem(PROFILE_CACHE_KEY);
      const p = raw ? JSON.parse(raw) : null;
      return p && p.user_id === userId ? p : null;
    } catch (_) { return null; }
  }

  function cacheProfile(profile) {
    try {
      if (profile?.user_id) localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(profile));
    } catch (_) {}
  }

  let supabase = null;
  let currentUser = null;
  let currentProfile = null;
  let applyingCloud = false;
  let initialized = false;
  let uploadBusy = false;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]));

  function isConfigured() {
    return VALID_CONFIG && window.supabase?.createClient;
  }

  function getLocalData() {
    const out = {};
    for (const key of DATA_KEYS) {
      const value = localStorage.getItem(key);
      if (value !== null) out[key] = value;
    }
    return out;
  }

  function putLocalData(data) {
    if (!data || typeof data !== "object") return;
    applyingCloud = true;
    try {
      for (const key of DATA_KEYS) {
        if (Object.prototype.hasOwnProperty.call(data, key) && data[key] !== null && data[key] !== undefined) {
          localStorage.setItem(key, String(data[key]));
        }
      }
    } finally {
      applyingCloud = false;
    }
  }

  function clearPersonalLocalData() {
    applyingCloud = true;
    try {
      DATA_KEYS.forEach(k => localStorage.removeItem(k));
    } finally {
      applyingCloud = false;
    }
  }

  function hasData(data) {
    return data && Object.keys(data).length > 0;
  }

  function safeArray(raw) {
    try { const x = JSON.parse(raw || "[]"); return Array.isArray(x) ? x : []; }
    catch { return []; }
  }

  function getCloudRow(userId) {
    return supabase
      .from("user_data")
      .select("user_id,data,updated_at")
      .eq("user_id", userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) throw error;
        return data || null;
      });
  }

  async function uploadCloudData() {
    if (!currentUser) {
      setAuthStatus("กรุณา Login ก่อนอัปโหลดข้อมูลขึ้น Cloud", "error");
      return false;
    }
    if (!isConfigured() || !supabase) {
      setAuthStatus("ยังไม่ได้ตั้งค่า Supabase", "error");
      return false;
    }
    if (uploadBusy) return false;

    const btn = $("kfpUploadCloudBtn");
    uploadBusy = true;
    if (btn) {
      btn.disabled = true;
      btn.textContent = "⏳ กำลังอัปโหลด...";
    }
    setAuthStatus("☁️ กำลังอัปโหลดข้อมูลขึ้น Cloud...", "");

    const plan = window.kfpPlan;
    if (plan && !plan.canUseFeature("cloud_sync")) {
      uploadBusy = false;
      if (btn) { btn.disabled = false; btn.textContent = "☁️ อัปโหลดข้อมูลขึ้น Cloud"; }
      setAuthStatus("☁️ Cloud Sync มีในแพ็กเกจ Finance Plus ขึ้นไป · ข้อมูลของคุณยังอยู่ในเครื่องนี้ครบ", "error");
      return false;
    }
    try {
      const data = getLocalData();
      const payload = {
        user_id: currentUser.id,
        data,
        updated_at: new Date().toISOString()
      };

      const { data: saved, error } = await supabase
        .from("user_data")
        .upsert(payload, { onConflict: "user_id" })
        .select("updated_at")
        .maybeSingle();

      if (error) throw error;
      if (saved?.updated_at) localStorage.setItem(CLOUD_SEEN_KEY, saved.updated_at);

      const now = new Date();
      setAuthStatus(
        `☁️ อัปโหลดข้อมูลเสร็จแล้ว · ${now.toLocaleString("th-TH", { dateStyle:"short", timeStyle:"medium" })}`,
        "ok"
      );
      return true;
    } catch (e) {
      const reason = e?.message || String(e) || "ไม่ทราบสาเหตุ";
      setAuthStatus(`❌ อัปโหลดไม่สำเร็จ · ${reason}`, "error");
      return false;
    } finally {
      uploadBusy = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = "☁️ อัปโหลดข้อมูลขึ้น Cloud";
      }
    }
  }

  function saveGuestBackup(data) {
    try { localStorage.setItem(GUEST_BACKUP_KEY, JSON.stringify(data || {})); } catch (_) {}
  }

  function guestBackup() {
    try { return JSON.parse(localStorage.getItem(GUEST_BACKUP_KEY) || "null"); }
    catch { return null; }
  }

  function usernameEmail(username) {
    return `${String(username).trim().toLowerCase()}@kfp.example.com`;
  }

  let returnFocus = null;
  function showAuthPanel() {
    const panel = $("kfpAuthPanel");
    if (!panel) return;
    if (!panel.classList.contains("open")) {
      const a = document.activeElement;
      returnFocus = a && a !== document.body && !panel.contains(a) ? a : null;
    }
    panel.classList.add("open");
  }

  function hideAuthPanel() {
    const panel = $("kfpAuthPanel");
    if (!panel || !panel.classList.contains("open")) return;
    panel.classList.remove("open");
    // Give focus back to whatever opened the modal (e.g. a gated button inside a popup)
    // so keyboard users — and Escape for the popup underneath — keep working.
    const r = returnFocus; returnFocus = null;
    if (r && r.isConnected && typeof r.focus === "function") { try { r.focus({ preventScroll: true }); } catch (_) {} }
  }

  function setAuthStatus(text, type="") {
    const el = $("kfpAuthStatus");
    if (!el) return;
    el.textContent = text;
    el.className = `kfp-auth-status ${type}`;
  }

  function renderAuthButton() {
    const btn = $("kfpAuthButton");
    if (!btn) return;
    if (currentUser) {
      const name = currentProfile?.nickname || currentProfile?.username || "ผู้ใช้";
      btn.textContent = `👤 ${name}`;
      btn.classList.add("logged-in");
    } else {
      btn.textContent = "🔐 Login";
      btn.classList.remove("logged-in");
    }
  }

  function renderAccountArea() {
    if (!$("kfpLoggedArea")) return;
    const panelOpen = $("kfpAuthPanel")?.classList.contains("open");
    const cur = currentView();
    if (currentUser && cur !== "account") showView("account", { keepStatus: true });
    else if (!currentUser && (cur === "account" || !panelOpen)) showView(cur === "account" ? "login" : (cur || "login"), { keepStatus: true });
    if (currentUser) {
      const email = currentUser.email || currentProfile?.email || "";
      const legacy = isLegacyEmail(email);
      $("kfpAccountUsername").textContent = currentProfile?.username || (legacy ? email.split("@")[0] : "-");
      $("kfpAccountEmail").textContent = legacy ? "ยังไม่ได้เชื่อมอีเมลจริง" : (email || "-");
      $("kfpLegacyBanner").hidden = !legacy;
      $("kfpChangeEmailBtn").textContent = legacy ? "🔗 เชื่อมอีเมลจริงตอนนี้" : "✉️ เปลี่ยนอีเมล";
      if (legacy && $("kfpChangeEmailForm").hidden) $("kfpChangeEmailForm").hidden = false;
      if ($("kfpNickname") && document.activeElement !== $("kfpNickname")) $("kfpNickname").value = currentProfile?.nickname || "";
      if ($("kfpCountry") && document.activeElement !== $("kfpCountry")) $("kfpCountry").value = currentProfile?.country || "";
      renderDeviceDataBox();
    }
  }

  /* ---------- แพ็กเกจปัจจุบัน (จาก get_my_entitlements ผ่าน kfp-access.js) ---------- */
  function renderPlanLine(info) {
    const el = $("kfpPlanLine"); if (!el) return;
    if (!info || !info.plan) { el.hidden = true; return; }
    const src = String(info.source || "");
    const why = src === "legacy_launch" ? "สิทธิ์สมาชิกเดิม (ฟรีช่วงเปิดระบบ)"
      : src === "admin_grant" ? "ได้รับจากผู้ดูแลระบบ"
      : src.startsWith("subscription") ? (info.status === "past_due" ? "⚠️ ชำระเงินไม่สำเร็จ · กรุณาอัปเดตการชำระเงิน" : info.status === "trialing" ? "ช่วงทดลองใช้" : "สมาชิกแบบชำระเงิน")
      : src === "offline" ? "ออฟไลน์ · ใช้ข้อมูลสิทธิ์ล่าสุด" : "";
    const until = info.validUntil ? new Date(info.validUntil).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" }) : "";
    el.textContent = "";
    const b = document.createElement("b"); b.textContent = "💎 " + (info.planName || info.plan); el.appendChild(b);
    if (why || until) el.appendChild(document.createTextNode(" · " + [why, until ? "ถึง " + until : ""].filter(Boolean).join(" · ")));
    if (info.plan !== "premium") { const a = document.createElement("a"); a.href = "pricing.html"; a.textContent = "อัปเกรด"; el.appendChild(a); }
    if (info.state === "ready" || info.state === "offline") { const m = document.createElement("a"); m.href = "account.html"; m.id = "kfpBillingLink"; m.textContent = "แพ็กเกจและใบเสร็จ"; el.appendChild(m); }
    if (info.state === "ready" && supabase && currentUser) showAdminLink(el);
    el.hidden = false;
  }
  window.addEventListener("kfp:plan", e => renderPlanLine(e.detail));
  // Phase 10: link to the Admin Console for admins only (the console itself re-checks the role on every call).
  let adminCheck = null;
  function showAdminLink(el) {
    if (!adminCheck) adminCheck = Promise.resolve(supabase.rpc("is_admin", { p_min_role: "viewer" })).then(r => !!(r && r.data === true), () => false);
    adminCheck.then(ok => {
      if (!ok || document.getElementById("kfpAdminLink")) return;
      const a = document.createElement("a"); a.href = "admin.html"; a.id = "kfpAdminLink"; a.textContent = "🛡️ Admin"; el.appendChild(a);
    });
  }

  /* ---------- ข้อมูลเดิมในเครื่อง (ก่อนมีระบบสมาชิก) ---------- */
  function renderDeviceDataBox() {
    const box = $("kfpDeviceDataBox"); if (!box) return;
    const show = !!(KS && KS.isMember() && KS.hasDeviceData());
    box.hidden = !show;
    if (!show) return;
    const sm = KS.deviceSummary(), parts = [];
    if (sm.salaryRecords) parts.push(`เงินเดือน ${sm.salaryRecords} เดือน`);
    if (sm.kfp_expenses_v1) parts.push(`รายจ่าย ${sm.kfp_expenses_v1} รายการ`);
    if (sm.kfp_work_records_v1) parts.push(`บันทึกงาน ${sm.kfp_work_records_v1} วัน`);
    if (sm.kfp_gold_lots_v1) parts.push(`ทอง ${sm.kfp_gold_lots_v1} รอบ`);
    $("kfpDeviceDataText").textContent = "ข้อมูลที่บันทึกในเครื่องนี้ก่อนมีระบบสมาชิก" + (parts.length ? ` (${parts.join(" · ")})` : "") +
      " · นำเข้าแล้วจะแทนที่ข้อมูลของบัญชีนี้บนเครื่องนี้ (ระบบสำรองของเดิมไว้ให้)";
  }
  function confirmTwice(btn, label) {
    if (btn.dataset.armed === "1") { btn.dataset.armed = ""; return true; }
    btn.dataset.armed = "1"; btn.dataset.label0 = btn.textContent; btn.textContent = label;
    setTimeout(() => { if (btn.dataset.armed === "1") { btn.dataset.armed = ""; btn.textContent = btn.dataset.label0; } }, 4000);
    return false;
  }
  function importDeviceData() {
    const btn = $("kfpImportDeviceBtn");
    if (!KS || !confirmTwice(btn, "แตะอีกครั้งเพื่อยืนยันนำเข้า")) return;
    if (KS.importDeviceData()) {
      setAuthStatus("📥 นำเข้าข้อมูลแล้ว · กด ☁️ อัปโหลดขึ้น Cloud เพื่อเก็บสำรอง", "ok");
      setTimeout(() => KS.reboot("import"), 900);
    }
  }
  function discardDeviceData() {
    const btn = $("kfpDiscardDeviceBtn");
    if (!KS || !confirmTwice(btn, "แตะอีกครั้งเพื่อลบถาวร")) return;
    KS.discardDeviceData();
    renderDeviceDataBox();
    setAuthStatus("ลบข้อมูลเดิมในเครื่องแล้ว", "ok");
  }

  /* ---------- views ---------- */
  const VIEW_TEXT = {
    login:    ["🔐 เข้าสู่ระบบ", "เข้าสู่ระบบเพื่อบันทึกข้อมูลและใช้ฟีเจอร์ตามแพ็กเกจของคุณ"],
    register: ["✨ สร้างบัญชี", "สมัครด้วยอีเมลจริง · เริ่มต้นที่แพ็กเกจ Free"],
    verify:   ["📧 ยืนยันอีเมล", "อีกขั้นเดียวก็ใช้งานได้แล้ว"],
    forgot:   ["🔑 ลืมรหัสผ่าน", "เราจะส่งลิงก์ตั้งรหัสผ่านใหม่ไปที่อีเมลของคุณ"],
    account:  ["👤 บัญชีของฉัน", "จัดการบัญชีและข้อมูล Cloud"]
  };
  function currentView() {
    const el = document.querySelector("#kfpAuthPanel [data-view]:not([hidden])");
    return el ? el.dataset.view : "";
  }
  function showView(name, { keepStatus = false } = {}) {
    document.querySelectorAll("#kfpAuthPanel [data-view]").forEach(el => { el.hidden = el.dataset.view !== name; });
    const t = VIEW_TEXT[name] || VIEW_TEXT.login;
    if ($("kfpAuthTitle")) $("kfpAuthTitle").textContent = t[0];
    if ($("kfpAuthSub")) $("kfpAuthSub").textContent = t[1];
    if (name !== "login" && name !== "register" && $("kfpAuthGateMsg")) $("kfpAuthGateMsg").hidden = true;
    if (!keepStatus) setAuthStatus("");
    const first = document.querySelector(`#kfpAuthPanel [data-view="${name}"] input`);
    if (first && $("kfpAuthPanel")?.classList.contains("open")) setTimeout(() => { try { first.focus({ preventScroll: true }); } catch (_) {} }, 40);
  }
  function openAuthPanel(view, message, detail) {
    showAuthPanel();
    showView(currentUser ? "account" : (view || "login"));
    const gm = $("kfpAuthGateMsg");
    if (gm) {
      gm.textContent = "";
      if (message) {
        const b = document.createElement("b"); b.textContent = "🔒 " + message; gm.appendChild(b);
        if (detail) { const sm = document.createElement("small"); sm.textContent = "ฟีเจอร์: " + detail; gm.appendChild(sm); }
      }
      gm.hidden = !message || !!currentUser;
    }
  }
  function toggleSub(id, force) {
    const el = $(id); if (!el) return;
    el.hidden = force === undefined ? !el.hidden : !force;
    if (!el.hidden) { const i = el.querySelector("input"); if (i) i.focus(); }
  }
  function isLegacyEmail(email) { return String(email || "").toLowerCase().endsWith(LEGACY_DOMAIN); }
  function busy(btn, on, text) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.textContent; btn.disabled = true; btn.textContent = text || "⏳ กรุณารอสักครู่..."; }
    else { btn.disabled = false; if (btn.dataset.label) btn.textContent = btn.dataset.label; }
  }
  function passwordProblem(pw) {
    if (pw.length < 8) return "รหัสผ่านต้องมีอย่างน้อย 8 ตัว";
    if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "รหัสผ่านต้องมีทั้งตัวอักษรและตัวเลข";
    if (pw.length > 72) return "รหัสผ่านยาวเกิน 72 ตัว";
    return "";
  }
  function thaiAuthError(e) {
    const code = e?.code || "", msg = String(e?.message || e || "");
    const map = {
      invalid_credentials: "อีเมล/Username หรือรหัสผ่านไม่ถูกต้อง",
      email_not_confirmed: "ยังไม่ได้ยืนยันอีเมล กรุณากดลิงก์ในอีเมลก่อน",
      user_already_exists: "อีเมลนี้มีบัญชีอยู่แล้ว",
      email_exists: "อีเมลนี้มีบัญชีอยู่แล้ว",
      weak_password: "รหัสผ่านง่ายเกินไป กรุณาตั้งใหม่",
      same_password: "รหัสผ่านใหม่ต้องไม่ซ้ำรหัสเดิม",
      email_address_invalid: "รูปแบบอีเมลไม่ถูกต้อง หรือโดเมนอีเมลนี้ใช้ไม่ได้",
      over_email_send_rate_limit: "ส่งอีเมลถี่เกินไป กรุณารอสักครู่แล้วลองใหม่",
      over_request_rate_limit: "ลองบ่อยเกินไป กรุณารอสักครู่",
      rate_limited: "ลองบ่อยเกินไป กรุณารอ 10 นาทีแล้วลองใหม่",
      signup_disabled: "ปิดรับสมัครชั่วคราว"
    };
    if (map[code]) return map[code];
    if (/invalid login credentials/i.test(msg)) return map.invalid_credentials;
    if (/email not confirmed/i.test(msg)) return map.email_not_confirmed;
    if (/rate limit/i.test(msg)) return map.over_email_send_rate_limit;
    return msg || "เกิดข้อผิดพลาด กรุณาลองใหม่";
  }

  /* Liquid-glass spring: กดแล้วยุบ, ลากนิ้วแล้วยืดตามนิ้วแบบหนืดๆ (rubber band), ปล่อยแล้วเด้งกลับพร้อมสั่น */
  function attachLiquidSpring(btn, onTap) {
    const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    let ox = 0, oy = 0, vx = 0, vy = 0;          // offset + velocity (px)
    let sc = 1, sv = 0, st = 1;                  // scale spring
    let q = 0, qv = 0;                           // jelly squash oscillator
    let tx = 0, ty = 0, startX = 0, startY = 0, pid = null, pressed = false, moved = false;
    let raf = 0, last = 0;

    function render() {
      const sp = Math.hypot(vx, vy), d = Math.hypot(ox, oy);
      const ang = d > 0.5 ? Math.atan2(oy, ox) : (sp > 20 ? Math.atan2(vy, vx) : 0);
      const stretch = Math.min(d / 90, 0.35) + Math.min(sp / 4200, 0.18);
      const sx = 1 + stretch + q * 0.5, sy = 1 - stretch * 0.55 - q * 0.3;
      btn.style.setProperty("--hx", Math.max(-5, Math.min(5, -ox * 0.12 - vx * 0.002)).toFixed(2) + "px");
      btn.style.setProperty("--hy", Math.max(-4, Math.min(4, -oy * 0.12 - vy * 0.002)).toFixed(2) + "px");
      btn.style.transform =
        "translate3d(" + ox.toFixed(2) + "px," + oy.toFixed(2) + "px,0) rotate(" + ang.toFixed(4) + "rad) scale(" +
        (sx * sc).toFixed(4) + "," + (sy * sc).toFixed(4) + ") rotate(" + (-ang).toFixed(4) + "rad)";
    }
    function step(dt) {
      // ตามนิ้วด้วยสปริงหนืด (ระยะถูกบีบให้ไม่หลุดไปไกล) / ปล่อยแล้วกลับ 0 แบบเด้ง
      const k = pressed ? 260 : 210, c = 2 * (pressed ? 0.62 : 0.30) * Math.sqrt(k);
      const gx = pressed ? tx : 0, gy = pressed ? ty : 0;
      vx += (k * (gx - ox) - c * vx) * dt; vy += (k * (gy - oy) - c * vy) * dt;
      ox += vx * dt; oy += vy * dt;
      const sk = 380, sc2 = 2 * 0.50 * Math.sqrt(sk);
      sv += (sk * (st - sc) - sc2 * sv) * dt; sc += sv * dt;
      const qk = 420, qc = 2 * 0.24 * Math.sqrt(qk);
      qv += (-qk * q - qc * qv) * dt; q += qv * dt;
    }
    function rest() {
      return !pressed && Math.abs(ox) + Math.abs(oy) < 0.15 && Math.abs(vx) + Math.abs(vy) < 3 &&
        Math.abs(sc - st) < 0.002 && Math.abs(sv) < 0.05 && Math.abs(q) < 0.002 && Math.abs(qv) < 0.05;
    }
    function frame(t) {
      const dt = Math.min(0.033, (t - last) / 1000 || 0.016); last = t;
      const n = Math.max(1, Math.ceil(dt / (1 / 120)));
      for (let i = 0; i < n; i++) step(dt / n);
      render();
      if (rest()) { ox = oy = vx = vy = q = qv = sv = 0; sc = st; render(); raf = 0; return; }
      raf = requestAnimationFrame(frame);
    }
    function wake() { if (raf || reduce) return; last = performance.now(); raf = requestAnimationFrame(frame); }

    btn.addEventListener("pointerdown", e => {
      if (e.button !== undefined && e.button !== 0) return;
      pressed = true; moved = false; pid = e.pointerId; startX = e.clientX; startY = e.clientY; tx = ty = 0;
      try { btn.setPointerCapture(pid); } catch (_) {}
      btn.classList.add("kfp-pressed");
      st = 0.9; qv += 2.2;                         // ยุบลง + jelly
      if (reduce) { sc = 0.96; render(); } else wake();
    });
    btn.addEventListener("pointermove", e => {
      if (!pressed || e.pointerId !== pid) return;
      const dx = e.clientX - startX, dy = e.clientY - startY, d = Math.hypot(dx, dy);
      if (d > 6) moved = true;
      // rubber band: ยิ่งดึงไกลยิ่งหนืด (สูงสุด ~26px)
      const m = 26 * (1 - Math.exp(-d / 46)), f = d > 0 ? m / d : 0;
      tx = dx * f; ty = dy * f;
      if (!reduce) wake();
    });
    function release(e, cancelled) {
      if (!pressed || (e && e.pointerId !== undefined && e.pointerId !== pid)) return;
      pressed = false; st = 1; btn.classList.remove("kfp-pressed");
      try { btn.releasePointerCapture(pid); } catch (_) {}
      qv += moved ? 3.2 : 1.6;                    // เด้งกลับแบบเยลลี่
      if (reduce) { ox = oy = 0; sc = 1; render(); } else wake();
      if (!cancelled && !moved) setTimeout(onTap, reduce ? 0 : 120);
    }
    btn.addEventListener("pointerup", e => release(e, false));
    btn.addEventListener("pointercancel", e => release(e, true));
    btn.addEventListener("lostpointercapture", () => { if (pressed) release(null, true); });
    btn.addEventListener("contextmenu", e => e.preventDefault());
    btn.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); qv += 2; wake(); onTap(); } });
  }

  function injectUI() {
    if ($("kfpAuthRoot")) return;

    const style = document.createElement("style");
    style.textContent = `
      #kfpAuthRoot{position:fixed;top:14px;right:14px;z-index:99999;font-family:"Prompt","Noto Sans Thai",system-ui,-apple-system,Arial,sans-serif}
      #kfpAuthButton{position:relative;width:auto!important;margin:0!important;padding:11px 18px!important;border-radius:999px!important;cursor:pointer;font-family:inherit;font-size:14px!important;font-weight:600;color:#fff6d6!important;white-space:nowrap;overflow:visible;
        touch-action:manipulation;-webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;outline:none;
        background:radial-gradient(90% 90% at 50% 120%,rgba(255,214,102,.34),rgba(255,214,102,0) 62%),radial-gradient(120% 140% at 25% 0%,rgba(255,255,255,.26),rgba(255,255,255,.05) 45%,rgba(255,255,255,0) 66%),linear-gradient(150deg,rgba(255,236,170,.20),rgba(212,175,55,.07) 55%,rgba(255,255,255,.04))!important;
        -webkit-backdrop-filter:blur(14px) saturate(210%) brightness(1.12) contrast(1.05);backdrop-filter:blur(14px) saturate(210%) brightness(1.12) contrast(1.05);
        border:1px solid rgba(255,240,190,.38)!important;
        box-shadow:inset 0 1.5px 1px rgba(255,255,255,.70),inset 0 -2px 3px rgba(255,214,102,.45),inset 4px 0 8px rgba(255,255,255,.07),inset -4px 0 8px rgba(255,214,102,.10),0 10px 22px rgba(0,0,0,.50),0 3px 8px rgba(0,0,0,.35),0 0 22px rgba(212,175,55,.20);
        text-shadow:0 1px 3px rgba(0,0,0,.5);transform-origin:50% 50%;will-change:transform;transition:box-shadow .3s ease}
      #kfpAuthButton::before{content:'';position:absolute;left:14px;right:14px;top:3px;height:42%;border-radius:50% 50% 55% 55%/80% 80% 40% 40%;background:linear-gradient(180deg,rgba(255,255,255,.55),rgba(255,255,255,.03));pointer-events:none;opacity:.8;transform:translate(var(--hx,0px),var(--hy,0px));filter:blur(.4px)}
      #kfpAuthButton::after{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;mix-blend-mode:screen;background:conic-gradient(from 200deg,rgba(255,255,255,0) 0deg,rgba(255,255,255,.24) 40deg,rgba(255,255,255,0) 90deg,rgba(255,255,255,0) 196deg,rgba(255,224,130,.26) 246deg,rgba(255,255,255,0) 300deg);-webkit-mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0);mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0);padding:1.5px}
      #kfpAuthButton.kfp-pressed{box-shadow:inset 0 1.5px 1px rgba(255,255,255,.8),inset 0 -2px 3px rgba(255,214,102,.55),0 16px 30px rgba(0,0,0,.55),0 5px 10px rgba(0,0,0,.35),0 0 32px rgba(243,216,112,.36)}
      #kfpAuthButton:focus-visible{box-shadow:0 0 0 3px rgba(243,216,112,.8),0 10px 22px rgba(0,0,0,.5)}
      #kfpAuthButton.logged-in{color:#fff!important;background:radial-gradient(90% 90% at 50% 120%,rgba(255,200,70,.55),rgba(255,200,70,0) 62%),radial-gradient(120% 140% at 25% 0%,rgba(255,255,255,.34),rgba(255,255,255,.06) 45%,rgba(255,255,255,0) 66%),linear-gradient(150deg,rgba(255,226,130,.38),rgba(212,175,55,.20) 55%,rgba(255,255,255,.06))!important;border-color:rgba(255,236,170,.55)!important}
      @supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){#kfpAuthButton{background:linear-gradient(150deg,rgba(80,66,24,.94),rgba(34,28,12,.94))!important}}
      #kfpAuthPanel{display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);align-items:center;justify-content:center;padding:18px}
      #kfpAuthPanel.open{display:flex}
      .kfp-auth-modal{width:min(460px,100%);max-height:90vh;overflow:auto;background:linear-gradient(160deg,#1b1b1e,#111113);border:1px solid rgba(212,175,55,.55);border-radius:22px;padding:24px;box-shadow:0 24px 70px rgba(0,0,0,.65),0 0 44px rgba(212,175,55,.14);color:#f4f1e8}
      .kfp-auth-modal h2{color:#f3d870;margin:0 0 8px;font-size:21px;font-weight:600}.kfp-auth-modal p{color:#a29e93;margin:6px 0 16px;line-height:1.55}
      .kfp-auth-modal label{display:block;color:#e6c552;margin:12px 0 7px;font-size:14px;font-weight:500}.kfp-auth-modal input{width:100%;min-height:48px;padding:12px 14px;border-radius:12px;border:1px solid #2d2d31;background:#1b1b1e;color:#fff;font-size:16px;outline:none;transition:border-color .18s ease,box-shadow .18s ease}
      .kfp-auth-modal input:focus{border-color:#d4af37;box-shadow:0 0 0 3px rgba(212,175,55,.2)}
      .kfp-auth-modal select{width:100%;min-height:48px;padding:12px 14px;border-radius:12px;border:1px solid #2d2d31;background:#1b1b1e;color:#fff;font-size:16px;outline:none}
      .kfp-auth-modal select:focus{border-color:#d4af37;box-shadow:0 0 0 3px rgba(212,175,55,.2)}
      .kfp-auth-modal button{padding:13px 14px;border:0;border-radius:12px;background:linear-gradient(135deg,#f3d870,#d4af37 55%,#b8901f);color:#1a1400;font-weight:600;font-size:15px;font-family:inherit;cursor:pointer;box-shadow:0 6px 16px rgba(212,175,55,.2);transition:transform .12s ease,filter .18s ease}
      .kfp-auth-modal button:active{transform:scale(.98)}
      .kfp-auth-modal button:disabled{opacity:.65;cursor:wait}
      .kfp-auth-row{display:flex;gap:10px;margin-top:14px}.kfp-auth-row button{flex:1;width:auto!important;margin:0!important}
      .kfp-auth-secondary{background:#26262a!important;color:#f4f1e8!important;border:1px solid #4a4a50!important;box-shadow:none!important}.kfp-auth-danger{background:linear-gradient(135deg,#3a1818,#2a1111)!important;color:#ff8c8c!important;border:1px solid rgba(255,107,107,.5)!important;box-shadow:none!important}
      .kfp-auth-status{min-height:20px;margin-top:12px;color:#a29e93;line-height:1.5;font-size:14px}.kfp-auth-status.ok{color:#37d478}.kfp-auth-status.error{color:#ff6b6b}
      .kfp-auth-account{background:#202023;border:1px solid rgba(212,175,55,.2);border-radius:14px;padding:13px 14px;margin:12px 0}
      .kfp-cloud-upload{margin-top:16px;padding:14px;border:1px solid rgba(212,175,55,.35);border-radius:15px;background:rgba(212,175,55,.05)}
      .kfp-cloud-upload button{width:100%!important;margin:0!important}
      .kfp-cloud-upload .kfp-small{margin:10px 0 0!important}
      .kfp-small{font-size:12px;color:#8d897e!important}
      .kfp-auth-modal{position:relative}
      #kfpAuthPanel .kfp-auth-modal button{position:relative;overflow:hidden}
      #kfpAuthPanel .kfp-auth-modal{overflow-x:hidden}
      #kfpAuthPanel .kfp-auth-modal::before{left:0;right:0;margin:0 auto;transform:none}
      #kfpAuthPanel .kfp-auth-modal>.kfp-auth-x{position:absolute;top:16px;right:16px;min-height:40px;z-index:2}
      #kfpAuthPanel .kfp-auth-account{flex-wrap:wrap}
      #kfpAuthPanel #kfpAccountEmail{flex-basis:100%;text-align:center;margin:0!important}
      #kfpAuthPanel .kfp-auth-legacy p,#kfpAuthPanel .kfp-auth-legacy b{text-align:left;display:block}
      #kfpAuthPanel .kfp-auth-mail{text-align:left}
      .kfp-auth-x{position:absolute;top:14px;right:14px;width:40px!important;height:40px;padding:0!important;border-radius:50%!important;background:#26262a!important;color:#f4f1e8!important;border:1px solid #4a4a50!important;box-shadow:none!important;font-size:15px!important}
      .kfp-auth-link{display:block;width:auto!important;margin:12px auto 0!important;padding:8px 10px!important;background:none!important;border:0!important;box-shadow:none!important;color:#e6c552!important;text-decoration:underline;text-underline-offset:3px;font-size:14px!important}
      .kfp-auth-gate{margin:0 0 6px!important;padding:12px 14px;border-radius:14px;background:rgba(212,175,55,.1);border:1px solid rgba(212,175,55,.45);color:#f3d870!important;font-weight:500;text-align:left!important;animation:kfp-gate-in .45s cubic-bezier(.34,1.56,.64,1) both}
      .kfp-auth-gate b{display:block;color:#ffe08a;font-weight:600;line-height:1.5}
      .kfp-auth-gate small{display:block;margin-top:4px;color:#cfc9b8;font-size:12.5px;font-weight:400}
      @keyframes kfp-gate-in{from{opacity:0;transform:scale(.96)}}
      @media(prefers-reduced-motion:reduce){.kfp-auth-gate{animation:none}}
      .kfp-auth-legacy{margin:10px 0;padding:12px 14px;border-radius:14px;background:rgba(255,196,64,.08);border:1px solid rgba(255,196,64,.45)}
      .kfp-auth-legacy b{color:#ffd78a}.kfp-auth-legacy p{margin:6px 0 0!important}
      .kfp-auth-sub{margin-top:10px;padding:4px 14px 14px;border-radius:14px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.025)}
      .kfp-auth-mail{display:flex;gap:10px;line-height:1.6}
      .kfp-req{color:#ff8c8c}
      .kfp-plan-line{margin:10px 0 0;padding:12px 14px;border-radius:14px;text-align:left;font-size:13.5px;line-height:1.6;color:#cfc9b8;background:rgba(255,255,255,.035);border:1px solid rgba(232,190,70,.3)}
      .kfp-plan-line b{color:#ffe08a}.kfp-plan-line a{color:#ffe08a;font-weight:600;margin-left:6px}
      .kfp-hint{margin:6px 2px 0!important;min-height:16px}.kfp-hint.ok{color:#37d478!important}.kfp-hint.bad{color:#ff8c8c!important}
      @media(max-width:600px){#kfpAuthRoot{top:max(8px,env(safe-area-inset-top));right:8px}.kfp-auth-modal{padding:20px}}
    `;
    document.head.appendChild(style);

    const root = document.createElement("div");
    root.id = "kfpAuthRoot";
    root.innerHTML = `
      <button id="kfpAuthButton" type="button">🔐 Login</button>
      <div id="kfpAuthPanel" role="dialog" aria-modal="true" aria-labelledby="kfpAuthTitle">
        <div class="kfp-auth-modal">
          <button id="kfpAuthX" class="kfp-auth-x" type="button" aria-label="ปิด">✕</button>
          <h2 id="kfpAuthTitle">🔐 Korea Finance Planner</h2>
          <p id="kfpAuthSub">เข้าสู่ระบบเพื่อใช้ข้อมูลส่วนตัวข้ามเครื่องแบบ Cloud</p>

          <p id="kfpAuthGateMsg" class="kfp-auth-gate" hidden></p>

          <div id="kfpLoginArea" data-view="login">
            <label for="kfpUsername">อีเมล หรือ Username</label><input id="kfpUsername" autocomplete="username" inputmode="email" autocapitalize="none" spellcheck="false" placeholder="you@email.com หรือ username">
            <label for="kfpPassword">Password</label><input id="kfpPassword" type="password" autocomplete="current-password" placeholder="รหัสผ่าน">
            <div class="kfp-auth-row"><button id="kfpLoginBtn" type="button">🔐 เข้าสู่ระบบ</button><button id="kfpOpenAddBtn" class="kfp-auth-secondary" type="button">✨ สร้างบัญชี</button></div>
            <button id="kfpOpenForgotBtn" class="kfp-auth-link" type="button">ลืมรหัสผ่าน?</button>
          </div>

          <div id="kfpAddUserArea" data-view="register" hidden>
            <label for="kfpNewEmail">อีเมล <span class="kfp-req">*</span></label><input id="kfpNewEmail" type="email" autocomplete="email" autocapitalize="none" spellcheck="false" placeholder="อีเมลที่ใช้งานจริง (ต้องยืนยัน)">
            <label for="kfpNewUsername">Username <span class="kfp-req">*</span></label><input id="kfpNewUsername" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="a-z 0-9 . _ - (3-32 ตัว)">
            <p id="kfpUsernameHint" class="kfp-small kfp-hint"></p>
            <label for="kfpNewPassword">Password <span class="kfp-req">*</span></label><input id="kfpNewPassword" type="password" autocomplete="new-password" placeholder="อย่างน้อย 8 ตัว มีตัวอักษรและตัวเลข">
            <label for="kfpNewPassword2">Confirm Password <span class="kfp-req">*</span></label><input id="kfpNewPassword2" type="password" autocomplete="new-password" placeholder="พิมพ์รหัสผ่านอีกครั้ง">
            <label for="kfpNewNickname">ชื่อที่แสดง (ไม่บังคับ)</label><input id="kfpNewNickname" maxlength="60" placeholder="ชื่อที่จะแสดงบนเว็บ">
            <div class="kfp-auth-row"><button id="kfpCreateBtn" type="button">✨ สร้างบัญชี</button><button id="kfpBackLoginBtn" class="kfp-auth-secondary" type="button">มีบัญชีแล้ว</button></div>
          </div>

          <div id="kfpVerifyArea" data-view="verify" hidden>
            <div class="kfp-auth-account kfp-auth-mail">📧 <span>เราส่งลิงก์ยืนยันไปที่ <b id="kfpVerifyEmail">-</b> แล้ว<br>กรุณาเปิดอีเมลแล้วกดยืนยันก่อนเข้าสู่ระบบ (เช็กโฟลเดอร์ Spam ด้วย)</span></div>
            <div class="kfp-auth-row"><button id="kfpResendBtn" type="button">📨 ส่งอีเมลยืนยันอีกครั้ง</button><button class="kfp-auth-secondary" data-goto="login" type="button">ไปหน้าเข้าสู่ระบบ</button></div>
          </div>

          <div id="kfpForgotArea" data-view="forgot" hidden>
            <label for="kfpForgotEmail">อีเมลของบัญชี</label><input id="kfpForgotEmail" type="email" autocomplete="email" autocapitalize="none" placeholder="you@email.com">
            <div class="kfp-auth-row"><button id="kfpForgotBtn" type="button">📨 ส่งลิงก์ตั้งรหัสใหม่</button><button class="kfp-auth-secondary" data-goto="login" type="button">กลับ</button></div>
            <p class="kfp-small">บัญชีเก่าที่ยังไม่ได้เชื่อมอีเมลจริงจะรีเซ็ตรหัสทางอีเมลไม่ได้ · เข้าสู่ระบบแล้วเชื่อมอีเมลก่อน</p>
          </div>

          <div id="kfpLoggedArea" data-view="account" hidden>
            <div class="kfp-auth-account">👤 <b id="kfpAccountUsername">-</b><br><span class="kfp-small" id="kfpAccountEmail">-</span></div>
            <div id="kfpPlanLine" class="kfp-plan-line" hidden></div>
            <div id="kfpLegacyBanner" class="kfp-auth-legacy" hidden>
              <b>🔗 เชื่อมอีเมลจริงกับบัญชีนี้</b>
              <p class="kfp-small">บัญชีนี้ยังใช้ระบบ Username แบบเก่า · เชื่อมอีเมลเพื่อกู้รหัสผ่านได้และสมัครแพ็กเกจได้ ข้อมูลเดิมทั้งหมดยังอยู่ครบ</p>
            </div>
            <div id="kfpDeviceDataBox" class="kfp-auth-legacy" hidden>
              <b>📦 พบข้อมูลเดิมในเครื่องนี้</b>
              <p class="kfp-small" id="kfpDeviceDataText">ข้อมูลที่บันทึกไว้ในเครื่องนี้ก่อนมีระบบสมาชิก (ไม่ใช่ข้อมูลตัวอย่าง)</p>
              <div class="kfp-auth-row"><button id="kfpImportDeviceBtn" type="button">📥 นำเข้าบัญชีนี้</button><button id="kfpDiscardDeviceBtn" class="kfp-auth-secondary" type="button">ลบทิ้ง</button></div>
            </div>
            <label for="kfpNickname">ชื่อที่แสดง</label><input id="kfpNickname" maxlength="60" placeholder="ชื่อที่จะแสดง">
            <label for="kfpCountry">ประเทศที่ทำงาน/อยู่ (ไม่บังคับ)</label>
            <select id="kfpCountry"><option value="">— ไม่ระบุ —</option><option value="KR">เกาหลีใต้</option><option value="TH">ไทย</option><option value="JP">ญี่ปุ่น</option>
              <option value="TW">ไต้หวัน</option><option value="IL">อิสราเอล</option><option value="AU">ออสเตรเลีย</option><option value="SG">สิงคโปร์</option>
              <option value="MY">มาเลเซีย</option><option value="AE">สหรัฐอาหรับเอมิเรตส์</option><option value="US">สหรัฐอเมริกา</option></select>
            <div class="kfp-auth-row"><button id="kfpSaveProfileBtn" type="button">💾 บันทึกโปรไฟล์</button><button id="kfpChangePassBtn" class="kfp-auth-secondary" type="button">🔑 เปลี่ยนรหัส</button></div>

            <div id="kfpChangePassForm" class="kfp-auth-sub" hidden>
              <label for="kfpCurPass">รหัสผ่านปัจจุบัน</label><input id="kfpCurPass" type="password" autocomplete="current-password">
              <label for="kfpNewPass">รหัสผ่านใหม่</label><input id="kfpNewPass" type="password" autocomplete="new-password" placeholder="อย่างน้อย 8 ตัว มีตัวอักษรและตัวเลข">
              <label for="kfpNewPass2">ยืนยันรหัสผ่านใหม่</label><input id="kfpNewPass2" type="password" autocomplete="new-password">
              <div class="kfp-auth-row"><button id="kfpSavePassBtn" type="button">💾 บันทึกรหัสใหม่</button><button class="kfp-auth-secondary" data-toggle="kfpChangePassForm" type="button">ยกเลิก</button></div>
            </div>

            <button id="kfpChangeEmailBtn" class="kfp-auth-link" type="button">✉️ เปลี่ยนอีเมล</button>
            <div id="kfpChangeEmailForm" class="kfp-auth-sub" hidden>
              <label for="kfpNewEmailChange">อีเมลใหม่</label><input id="kfpNewEmailChange" type="email" autocomplete="email" autocapitalize="none" placeholder="you@email.com">
              <div class="kfp-auth-row"><button id="kfpSaveEmailBtn" type="button">📨 ส่งลิงก์ยืนยัน</button><button class="kfp-auth-secondary" data-toggle="kfpChangeEmailForm" type="button">ยกเลิก</button></div>
              <p class="kfp-small">ระบบจะเปลี่ยนอีเมลหลังคุณกดลิงก์ยืนยันในอีเมลใหม่เท่านั้น</p>
            </div>

            <div class="kfp-locked-note" data-feature-off="cloud_sync">☁️ <b>Cloud Sync</b> (สำรองและใช้ข้อมูลข้ามเครื่อง) มีในแพ็กเกจ Finance Plus ขึ้นไป · ตอนนี้ข้อมูลของคุณเก็บไว้ในเครื่องนี้ · <a href="pricing.html#plus">ดูแพ็กเกจ</a></div>
            <div class="kfp-cloud-upload" data-feature="cloud_sync">
              <button id="kfpUploadCloudBtn" type="button">☁️ อัปโหลดข้อมูลขึ้น Cloud</button>
              <p class="kfp-small">ระบบจะไม่อัปโหลดข้อมูลเองอีกต่อไป · กดปุ่มนี้เท่านั้นจึงจะส่งข้อมูลเครื่องนี้ขึ้น Cloud</p>
            </div>

            <div class="kfp-auth-row"><button id="kfpLogoutBtn" class="kfp-auth-danger" type="button">🚪 Logout</button><button id="kfpCloseBtn" class="kfp-auth-secondary" type="button">ปิด</button></div>
            <button id="kfpLogoutWipeBtn" class="kfp-auth-link" type="button">🧹 ออกจากระบบและลบข้อมูลบัญชีนี้ออกจากเครื่องนี้ (เครื่องที่ใช้ร่วมกับคนอื่น)</button>
          </div>
          <div id="kfpAuthStatus" class="kfp-auth-status"></div>
        </div>
      </div>`;
    document.body.appendChild(root);

    const openAuth = () => {
      openAuthPanel(currentUser ? "account" : "login");
      if (!VALID_CONFIG) setAuthStatus("ยังไม่ได้ตั้งค่า Supabase ใน supabase-config.js", "error");
    };
    attachLiquidSpring($("kfpAuthButton"), openAuth);
    $("kfpCloseBtn").onclick = hideAuthPanel;
    $("kfpAuthX").onclick = hideAuthPanel;
    $("kfpOpenAddBtn").onclick = () => showView("register");
    $("kfpBackLoginBtn").onclick = () => showView("login");
    $("kfpOpenForgotBtn").onclick = () => { showView("forgot"); const v = $("kfpUsername").value.trim(); if (v.includes("@")) $("kfpForgotEmail").value = v; };
    $("kfpLoginBtn").onclick = login;
    $("kfpCreateBtn").onclick = registerUser;
    $("kfpResendBtn").onclick = resendVerification;
    $("kfpForgotBtn").onclick = forgotPassword;
    $("kfpSaveProfileBtn").onclick = saveProfile;
    $("kfpChangePassBtn").onclick = () => toggleSub("kfpChangePassForm");
    $("kfpSavePassBtn").onclick = changePassword;
    $("kfpChangeEmailBtn").onclick = () => toggleSub("kfpChangeEmailForm");
    $("kfpSaveEmailBtn").onclick = changeEmail;
    $("kfpUploadCloudBtn").onclick = uploadCloudData;
    $("kfpImportDeviceBtn").onclick = importDeviceData;
    $("kfpDiscardDeviceBtn").onclick = discardDeviceData;
    $("kfpLogoutBtn").onclick = logout;
    $("kfpLogoutWipeBtn").onclick = logoutAndWipe;
    $("kfpAuthPanel").addEventListener("click", e => {
      if (e.target.id === "kfpAuthPanel") return hideAuthPanel();
      const go = e.target.closest && e.target.closest("[data-goto]");
      if (go) return showView(go.dataset.goto);
      const tg = e.target.closest && e.target.closest("[data-toggle]");
      if (tg) toggleSub(tg.dataset.toggle, false);
    });
    $("kfpAuthPanel").addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hideAuthPanel(); return; }
      if (e.key !== "Enter" || e.target.tagName !== "INPUT") return;
      const view = e.target.closest("[data-view]"); if (!view) return;
      e.preventDefault();
      ({ login, register: registerUser, forgot: forgotPassword }[view.dataset.view] || (() => {}))();
    });
    $("kfpNewUsername").addEventListener("input", checkUsernameSoon);
  }

  async function getProfile(userId) {
    const { data, error } = await supabase
      .from("profiles")
      .select("user_id,username,nickname")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    // country (PART 9 admin column) — separate so a database without migration 0100 still loads the profile
    if (data) {
      try {
        const c = await supabase.from("profiles").select("country").eq("user_id", userId).maybeSingle();
        if (c && !c.error && c.data) data.country = c.data.country || null;
      } catch (_) {}
    }
    return data;
  }

  function notifyCloudLoaded() {
    // Existing pages decide how to re-render themselves; no finance/gold logic is changed here.
    try { window.dispatchEvent(new CustomEvent("kfp:cloud-loaded")); } catch (_) {}
    try { if (typeof window.__kfpRefreshFromCloud === "function") window.__kfpRefreshFromCloud(); } catch (_) {}
    try { if (typeof window.__kfpRefreshGoldFromCloud === "function") window.__kfpRefreshGoldFromCloud(); } catch (_) {}
  }

  async function loadCloudForUser(user, { captureGuestBackup = false, knownProfile = null } = {}) {
    // Supabase has already authenticated the user. Do not wait for PWA/Cloud
    // before showing the logged-in UI.
    currentUser = user;
    currentProfile = knownProfile || readCachedProfile(user.id) || null;
    localStorage.setItem(AUTH_USER_KEY, user.id);
    renderAuthButton();
    renderAccountArea();
    // Phase 5: kfp-access.js loads entitlements from the database once the session is ready.
    try { window.dispatchEvent(new CustomEvent("kfp:auth-ready", { detail: { userId: user.id } })); } catch (_) {}

    try {
      if (captureGuestBackup && !KS) saveGuestBackup(getLocalData());

      // Profile + Cloud are independent requests; fetch them in parallel.
      const profilePromise = withTimeout(
        getProfile(user.id),
        DATA_TIMEOUT_MS,
        "โหลดโปรไฟล์ช้าเกินไป"
      ).catch(e => {
        console.warn("KFP profile:", e);
        return null;
      });

      const cloudPromise = withTimeout(
        getCloudRow(user.id),
        DATA_TIMEOUT_MS,
        "โหลดข้อมูล Cloud ช้าเกินไป"
      ).catch(e => {
        console.warn("KFP cloud:", e);
        return null;
      });

      const [profile, row] = await Promise.all([profilePromise, cloudPromise]);

      if (profile) {
        currentProfile = profile;
        cacheProfile(profile);
        renderAuthButton();
        renderAccountArea();
      }

      const cloud = row?.data && typeof row.data === "object" ? row.data : {};

      const seen = localStorage.getItem(CLOUD_SEEN_KEY);
      if (hasData(cloud) && KS && seen && row?.updated_at && seen === row.updated_at) {
        // Cloud has not changed since this device last loaded/uploaded it:
        // keep local edits instead of silently replacing them on every reload.
        setAuthStatus("💾 ใช้ข้อมูลในเครื่องนี้ (ยังไม่มีข้อมูลใหม่บน Cloud) · อย่าลืมอัปโหลดเมื่อแก้ไข", "");
      } else if (hasData(cloud)) {
        clearPersonalLocalData();
        putLocalData(cloud);
        if (row?.updated_at) localStorage.setItem(CLOUD_SEEN_KEY, row.updated_at);
        notifyCloudLoaded();
        setAuthStatus(
          `☁️ โหลดข้อมูล Cloud แล้ว · ล่าสุด ${row?.updated_at ? new Date(row.updated_at).toLocaleString("th-TH", {dateStyle:"short", timeStyle:"medium"}) : "-"}`,
          "ok"
        );
      } else {
        notifyCloudLoaded();
        if (!row) {
          setAuthStatus("เข้าสู่ระบบแล้ว · กำลังเชื่อมต่อข้อมูล Cloud…", "");
        } else {
          setAuthStatus("☁️ บัญชีนี้ยังไม่มีข้อมูล Cloud · ข้อมูลในเครื่องยังอยู่", "");
        }
      }
    } catch (e) {
      console.warn("KFP cloud hydration:", e);
      renderAuthButton();
      renderAccountArea();
      setAuthStatus(`เข้าสู่ระบบแล้ว · Cloud ยังโหลดไม่เสร็จ (${e.message || "ช้า"})`, "");
    }
  }

  async function signInWithUsername(username, password) {
    // 1) Edge Function: resolves username → e-mail on the server (never sent to the browser)
    let res = null;
    try {
      res = await withTimeout(fetch(`${SUPABASE_URL}/functions/v1/username-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify({ username, password })
      }), AUTH_TIMEOUT_MS, "timeout");
    } catch (_) { res = null; }

    if (res && res.ok) {
      const tok = await res.json();
      const { data, error } = await supabase.auth.setSession(tok);
      if (error) throw error;
      return data.user;
    }
    if (res && res.status !== 404 && res.status < 500) {
      let body = {}; try { body = await res.json(); } catch (_) {}
      throw { code: body.error || "invalid_credentials" };
    }
    // 2) Function not deployed / unreachable: legacy accounts still work exactly as before.
    const { data, error } = await supabase.auth.signInWithPassword({ email: usernameEmail(username), password });
    if (error) throw error;
    return data.user;
  }

  async function login(){
    if (!isConfigured()) return setAuthStatus("กรุณาใส่ SUPABASE_URL และ SUPABASE_ANON_KEY ใน supabase-config.js ก่อน", "error");
    const id = $("kfpUsername").value.trim();
    const password = $("kfpPassword").value;
    if (!id || !password) return setAuthStatus("กรุณากรอกอีเมล/Username และ Password", "error");
    const isEmail = id.includes("@");
    if (isEmail && !EMAIL_RE.test(id)) return setAuthStatus("รูปแบบอีเมลไม่ถูกต้อง", "error");
    if (!isEmail && !USERNAME_RE.test(id.toLowerCase())) return setAuthStatus("Username ไม่ถูกต้อง", "error");

    const btn = $("kfpLoginBtn");
    busy(btn, true, "⏳ กำลังเข้าสู่ระบบ...");
    setAuthStatus("กำลังเข้าสู่ระบบ…");

    try {
      const user = await withTimeout(
        isEmail
          ? supabase.auth.signInWithPassword({ email: id.toLowerCase(), password }).then(({ data, error }) => { if (error) throw error; return data.user; })
          : signInWithUsername(id.toLowerCase(), password),
        AUTH_TIMEOUT_MS + 5000,
        "Supabase ใช้เวลาตอบกลับนานเกิน 15 วินาที · ตรวจอินเทอร์เน็ตแล้วลองใหม่"
      );
      if (!user) throw new Error("ไม่พบข้อมูลผู้ใช้");
      if (!user.email_confirmed_at) {
        // Never unlock anything for an unverified account.
        try { await supabase.auth.signOut(); } catch (_) {}
        pendingVerifyEmail = user.email || (isEmail ? id : "");
        showVerify(pendingVerifyEmail);
        return;
      }

      currentUser = user;
      localStorage.setItem(AUTH_USER_KEY, user.id);
      $("kfpPassword").value = "";
      renderAuthButton();
      renderAccountArea();
      hideAuthPanel();

      // Preview → Member: reload so every page script reads this account's data.
      if (switchMode("login")) return;
      // Profile/Cloud load continues in background.
      loadCloudForUser(user, { captureGuestBackup:true }).catch(() => {});
    } catch (e) {
      if ((e?.code || "") === "email_not_confirmed" || /email not confirmed/i.test(e?.message || "")) {
        pendingVerifyEmail = isEmail ? id.toLowerCase() : "";
        showVerify(pendingVerifyEmail);
        setAuthStatus(thaiAuthError(e), "error");
      } else {
        setAuthStatus(`เข้าสู่ระบบไม่สำเร็จ: ${thaiAuthError(e)}`, "error");
      }
    } finally {
      busy(btn, false);
    }
  }

  let pendingVerifyEmail = "";
  function showVerify(email) {
    showView("verify");
    $("kfpVerifyEmail").textContent = email || "อีเมลของคุณ";
    $("kfpResendBtn").hidden = !email;
  }

  let usernameTimer = 0, usernameSeq = 0;
  function checkUsernameSoon() {
    clearTimeout(usernameTimer);
    const hint = $("kfpUsernameHint");
    const v = $("kfpNewUsername").value.trim().toLowerCase();
    if (!v) { hint.textContent = ""; hint.className = "kfp-small kfp-hint"; return; }
    if (!USERNAME_RE.test(v)) { hint.textContent = "ใช้ a-z, 0-9, จุด, _ หรือ - ยาว 3-32 ตัว"; hint.className = "kfp-small kfp-hint bad"; return; }
    hint.textContent = "กำลังตรวจสอบ…"; hint.className = "kfp-small kfp-hint";
    usernameTimer = setTimeout(async () => {
      const seq = ++usernameSeq;
      const ok = await usernameAvailable(v);
      if (seq !== usernameSeq) return;
      hint.textContent = ok === null ? "" : ok ? "✓ ใช้ชื่อนี้ได้" : "✗ ชื่อนี้มีคนใช้แล้ว";
      hint.className = "kfp-small kfp-hint " + (ok ? "ok" : ok === false ? "bad" : "");
    }, 350);
  }
  async function usernameAvailable(v) {
    if (!supabase) return null;
    try {
      const { data, error } = await supabase.rpc("is_username_available", { p_username: v });
      if (error) throw error;
      return data === true;
    } catch (_) { return null; }   // migration not applied yet → let the server decide
  }

  async function registerUser(){
    if (!isConfigured()) return setAuthStatus("กรุณาตั้งค่า Supabase ก่อน", "error");
    const email = $("kfpNewEmail").value.trim().toLowerCase();
    const username = $("kfpNewUsername").value.trim().toLowerCase();
    const password = $("kfpNewPassword").value;
    const password2 = $("kfpNewPassword2").value;
    const nickname = $("kfpNewNickname").value.trim() || username;

    if (!EMAIL_RE.test(email)) return setAuthStatus("กรุณากรอกอีเมลให้ถูกต้อง", "error");
    if (isLegacyEmail(email)) return setAuthStatus("กรุณาใช้อีเมลจริง", "error");
    if (!USERNAME_RE.test(username)) return setAuthStatus("Username ใช้ a-z, 0-9, จุด, _ หรือ - และยาว 3-32 ตัว", "error");
    const pwErr = passwordProblem(password);
    if (pwErr) return setAuthStatus(pwErr, "error");
    if (password !== password2) return setAuthStatus("Confirm Password ไม่ตรงกัน", "error");

    const btn = $("kfpCreateBtn");
    busy(btn, true, "⏳ กำลังสร้างบัญชี...");
    setAuthStatus("กำลังสร้างบัญชี...");
    try {
      const free = await usernameAvailable(username);
      if (free === false) throw new Error("Username นี้มีคนใช้แล้ว");
      const { data, error } = await withTimeout(supabase.auth.signUp({
        email, password,
        options: { data: { username, display_name: nickname }, emailRedirectTo: CALLBACK_URL }
      }), AUTH_TIMEOUT_MS, "Supabase ตอบช้าเกินไป กรุณาลองใหม่");
      if (error) throw error;

      if (data.session && data.user?.email_confirmed_at) {
        // Project still has "Confirm email" OFF (old setting) → behave as before.
        currentUser = data.user;
        localStorage.setItem(AUTH_USER_KEY, data.user.id);
        renderAuthButton(); renderAccountArea(); hideAuthPanel();
        if (switchMode("signup")) return;
        loadCloudForUser(data.user, { captureGuestBackup:true, knownProfile:{ user_id:data.user.id, username, nickname } }).catch(() => {});
        return;
      }
      // Normal path: confirmation e-mail sent. (Supabase deliberately gives the
      // same answer for an already-registered e-mail, so we don't reveal it.)
      pendingVerifyEmail = email;
      $("kfpNewPassword").value = $("kfpNewPassword2").value = "";
      showVerify(email);
      setAuthStatus("สร้างบัญชีแล้ว · กรุณายืนยันอีเมลก่อนเข้าสู่ระบบ", "ok");
    } catch (e) {
      setAuthStatus(`สร้างบัญชีไม่สำเร็จ: ${thaiAuthError(e)}`, "error");
    } finally {
      busy(btn, false);
    }
  }

  async function resendVerification(){
    if (!supabase || !pendingVerifyEmail) return;
    const btn = $("kfpResendBtn");
    busy(btn, true, "⏳ กำลังส่ง...");
    try {
      const { error } = await supabase.auth.resend({ type: "signup", email: pendingVerifyEmail, options: { emailRedirectTo: CALLBACK_URL } });
      if (error) throw error;
      setAuthStatus("ส่งอีเมลยืนยันอีกครั้งแล้ว", "ok");
    } catch (e) {
      setAuthStatus(`ส่งไม่สำเร็จ: ${thaiAuthError(e)}`, "error");
    } finally { busy(btn, false); }
  }

  async function forgotPassword(){
    if (!isConfigured()) return setAuthStatus("กรุณาตั้งค่า Supabase ก่อน", "error");
    const email = $("kfpForgotEmail").value.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return setAuthStatus("กรุณากรอกอีเมลให้ถูกต้อง", "error");
    if (isLegacyEmail(email)) return setAuthStatus("บัญชีแบบเก่ารีเซ็ตทางอีเมลไม่ได้ · เข้าสู่ระบบด้วย Username แล้วเชื่อมอีเมลจริงก่อน", "error");
    const btn = $("kfpForgotBtn");
    busy(btn, true, "⏳ กำลังส่ง...");
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: CALLBACK_URL });
      if (error) throw error;
      // Same message whether or not the e-mail exists.
      setAuthStatus("ถ้ามีบัญชีที่ใช้อีเมลนี้ เราได้ส่งลิงก์ตั้งรหัสผ่านใหม่ไปแล้ว", "ok");
    } catch (e) {
      setAuthStatus(`ส่งไม่สำเร็จ: ${thaiAuthError(e)}`, "error");
    } finally { busy(btn, false); }
  }

  async function changeEmail(){
    if (!currentUser) return;
    const email = $("kfpNewEmailChange").value.trim().toLowerCase();
    if (!EMAIL_RE.test(email) || isLegacyEmail(email)) return setAuthStatus("กรุณากรอกอีเมลจริงให้ถูกต้อง", "error");
    if (email === String(currentUser.email || "").toLowerCase()) return setAuthStatus("นี่คืออีเมลปัจจุบันอยู่แล้ว", "error");
    const btn = $("kfpSaveEmailBtn");
    busy(btn, true, "⏳ กำลังส่ง...");
    try {
      const { error } = await supabase.auth.updateUser({ email }, { emailRedirectTo: CALLBACK_URL });
      if (error) throw error;
      $("kfpNewEmailChange").value = "";
      setAuthStatus(`ส่งลิงก์ยืนยันไปที่ ${email} แล้ว · อีเมลจะเปลี่ยนหลังกดยืนยัน (บัญชี ข้อมูล และ User ID เดิมไม่เปลี่ยน)`, "ok");
    } catch (e) {
      setAuthStatus(`เปลี่ยนอีเมลไม่สำเร็จ: ${thaiAuthError(e)}`, "error");
    } finally { busy(btn, false); }
  }

  async function saveProfile(){
    if (!currentUser) return;
    const nickname = ($("kfpNickname").value.trim() || currentProfile?.username || "ผู้ใช้").slice(0, 60);
    // Only "nickname" and "country" may be sent: the browser has no UPDATE right on other columns
    // (updated_at is set by the database trigger). Phase 12 fix.
    const country = /^[A-Z]{2}$/.test(($("kfpCountry") && $("kfpCountry").value) || "") ? $("kfpCountry").value : null;
    let { error } = await supabase
      .from("profiles")
      .update({ nickname, country })
      .eq("user_id", currentUser.id);
    if (error && /country/i.test(error.message || "")) {          // database without migration 0100: name only
      ({ error } = await supabase.from("profiles").update({ nickname }).eq("user_id", currentUser.id));
    }
    if (error) return setAuthStatus(`บันทึกชื่อเล่นไม่สำเร็จ: ${error.message}`, "error");
    currentProfile = { ...currentProfile, nickname, country };
    renderAuthButton();
    setAuthStatus("บันทึกโปรไฟล์แล้ว", "ok");
  }

  async function changePassword(){
    if (!currentUser) return;
    const cur = $("kfpCurPass").value, pw = $("kfpNewPass").value, pw2 = $("kfpNewPass2").value;
    if (!cur) return setAuthStatus("กรุณากรอกรหัสผ่านปัจจุบัน", "error");
    const pwErr = passwordProblem(pw);
    if (pwErr) return setAuthStatus(pwErr, "error");
    if (pw !== pw2) return setAuthStatus("ยืนยันรหัสผ่านใหม่ไม่ตรงกัน", "error");
    const btn = $("kfpSavePassBtn");
    busy(btn, true, "⏳ กำลังบันทึก...");
    try {
      // Re-authenticate first so an unattended, logged-in device can't change the password.
      const { error: reErr } = await supabase.auth.signInWithPassword({ email: currentUser.email, password: cur });
      if (reErr) throw { code: "invalid_credentials" };
      const { error } = await supabase.auth.updateUser({ password: pw });
      if (error) throw error;
      ["kfpCurPass", "kfpNewPass", "kfpNewPass2"].forEach(id => { $(id).value = ""; });
      toggleSub("kfpChangePassForm", false);
      setAuthStatus("เปลี่ยนรหัสผ่านเรียบร้อยแล้ว", "ok");
    } catch (e) {
      setAuthStatus(`เปลี่ยนรหัสไม่สำเร็จ: ${thaiAuthError(e)}`, "error");
    } finally { busy(btn, false); }
  }

  async function logout(){
    if (!currentUser) return;
    try { await supabase.auth.signOut(); } catch (_) {}

    // Logout must NEVER upload current LocalStorage to Cloud.
    if (KS) {
      // Phase 3: this account's data stays in its own namespace on the device
      // (Free members have no Cloud copy) and is simply not shown in Preview.
      localStorage.removeItem(AUTH_USER_KEY);
      currentUser = null; currentProfile = null;
      hideAuthPanel();
      if (!switchMode("logout")) location.reload();
      return;
    }
    const backup = guestBackup() || {};
    clearPersonalLocalData();
    putLocalData(backup);
    localStorage.removeItem(AUTH_USER_KEY);

    currentUser = null;
    currentProfile = null;
    renderAuthButton();
    renderAccountArea();
    hideAuthPanel();

    // Keep the existing app behavior of resetting the page after logout.
    location.reload();
  }

  // Phase 12: shared phones / PCs — remove this account's copy from the device.
  // Data on Cloud (Plus/Premium) stays; local-only data (Free) is gone for good, so ask twice.
  async function logoutAndWipe(){
    if (!currentUser || !KS || !KS.wipeUser) return;
    const btn = $("kfpLogoutWipeBtn");
    const cloud = window.kfpPlan && window.kfpPlan.canUseFeature && window.kfpPlan.canUseFeature("cloud_sync");
    if (!confirmTwice(btn, cloud
      ? "แตะอีกครั้งเพื่อยืนยัน · ข้อมูลที่ยังไม่ได้อัปโหลดขึ้น Cloud จะหายจากเครื่องนี้"
      : "⚠️ แพ็กเกจ Free ไม่มีสำเนาบน Cloud — ข้อมูลจะหายถาวร · แตะอีกครั้งเพื่อยืนยัน")) return;
    const uid = currentUser.id;
    try { await supabase.auth.signOut(); } catch (_) {}
    KS.wipeUser(uid);
    localStorage.removeItem(AUTH_USER_KEY);
    try { if (typeof window.__kfpPwaPersist === "function") await window.__kfpPwaPersist(); } catch (_) {}   // the iOS backup must not bring it back
    currentUser = null; currentProfile = null;
    hideAuthPanel();
    if (!switchMode("logout-wipe")) location.reload();
  }

  async function init(){
    if (initialized) return;
    initialized = true;
    injectUI();
    if (!isConfigured()) return;

    try {
      supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth:{ persistSession:true, autoRefreshToken:true, detectSessionInUrl:false, storage: SESSION_STORAGE }
      });

      const { data } = await withTimeout(
        supabase.auth.getSession(),
        AUTH_TIMEOUT_MS,
        "Supabase Session ใช้เวลาตอบกลับนานเกิน 15 วินาที"
      );
      const sUser = data?.session?.user && data.session.user.email_confirmed_at ? data.session.user : null;
      if (KS && ((KS.isMember() && (!sUser || sUser.id !== KS.userId)) || (KS.isPreview() && sUser))) {
        // Page booted in the wrong mode (session expired / changed in another tab).
        if (switchMode("session-mismatch")) return;
      }
      if (data?.session?.user && !data.session.user.email_confirmed_at) {
        // Unverified sessions never unlock anything.
        try { await supabase.auth.signOut(); } catch (_) {}
        renderAuthButton();
        renderAccountArea();
      } else if (data?.session?.user) {
        // Session restoration is enough to show the logged-in state.
        currentUser = data.session.user;
        localStorage.setItem(AUTH_USER_KEY, data.session.user.id);
        renderAuthButton();
        renderAccountArea();

        // Continue profile/cloud hydration without blocking the page.
        loadCloudForUser(data.session.user, { captureGuestBackup:false }).catch(() => {});
      } else {
        renderAuthButton();
        renderAccountArea();
      }

      supabase.auth.onAuthStateChange(async (_event, session) => {
        if (session?.user && !session.user.email_confirmed_at) return;
        if (KS && KS.isMember() && (!session?.user || session.user.id !== KS.userId)) {
          // Signed out (here, in another tab, or the refresh token was revoked).
          localStorage.removeItem(AUTH_USER_KEY);
          if (switchMode("signed-out")) return;
        }
        if (!session?.user) {
          currentUser = null;
          currentProfile = null;
          renderAuthButton();
          renderAccountArea();
          return;
        }

        // Session events can fire before/after page hydration on iOS PWA.
        // Always reflect the authenticated state immediately, then hydrate Cloud.
        if (currentUser && currentUser.id === session.user.id && currentUser.email !== session.user.email) {
          currentUser = session.user;          // e-mail linked/changed on another tab
          renderAccountArea();
        }
        if (!currentUser || currentUser.id !== session.user.id) {
          currentUser = session.user;
          localStorage.setItem(AUTH_USER_KEY, session.user.id);
          renderAuthButton();
          renderAccountArea();
          loadCloudForUser(session.user, { captureGuestBackup:false }).catch(() => {});
        }
      });
    } catch (e) {
      console.error("KFP auth init:", e);
      setAuthStatus(`Auth เริ่มต้นไม่สำเร็จ: ${e.message}`, "error");
    }
  }

  // Public API for kfp-access.js (Phase 4 login gate) and other pages.
  window.kfpAuth = {
    open: (view, message, detail) => { if (!$("kfpAuthRoot")) injectUI(); openAuthPanel(view, message, detail); },
    close: hideAuthPanel,
    user: () => currentUser,
    profile: () => currentProfile,
    client: () => supabase,
    isLegacy: () => !!currentUser && isLegacyEmail(currentUser.email),
    isPreview: () => (KS ? KS.isPreview() : !currentUser)
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
