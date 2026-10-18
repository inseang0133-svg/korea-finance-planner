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
    "__kfp_deleted_keys_v1",
    "kfp_gold_lots_v1", "kfp_gold_settings_v1"
  ];

  const ARRAY_KEYS = new Set(["salaryRecords", "kfp_gold_lots_v1"]);
  const GUEST_BACKUP_KEY = "__kfp_guest_backup_v1";
  const AUTH_USER_KEY = "__kfp_auth_user_v1";
  const PROFILE_CACHE_KEY = "__kfp_profile_cache_v1";
  const AUTH_TIMEOUT_MS = 15000;
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

    try {
      const data = getLocalData();
      const payload = {
        user_id: currentUser.id,
        data,
        updated_at: new Date().toISOString()
      };

      const { error } = await supabase
        .from("user_data")
        .upsert(payload, { onConflict: "user_id" });

      if (error) throw error;

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

  function showAuthPanel() {
    const panel = $("kfpAuthPanel");
    if (panel) panel.classList.add("open");
  }

  function hideAuthPanel() {
    const panel = $("kfpAuthPanel");
    if (panel) panel.classList.remove("open");
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
    const logged = $("kfpLoggedArea");
    const login = $("kfpLoginArea");
    const add = $("kfpAddUserArea");
    if (logged) logged.hidden = !currentUser;
    if (login) login.hidden = !!currentUser;
    if (add) add.hidden = !!currentUser;
    if (currentUser) {
      if ($("kfpAccountUsername")) $("kfpAccountUsername").textContent = currentProfile?.username || "-";
      if ($("kfpNickname")) $("kfpNickname").value = currentProfile?.nickname || "";
    }
  }

  function injectUI() {
    if ($("kfpAuthRoot")) return;

    const style = document.createElement("style");
    style.textContent = `
      #kfpAuthRoot{position:fixed;top:14px;right:14px;z-index:99999;font-family:"Prompt","Noto Sans Thai",system-ui,-apple-system,Arial,sans-serif}
      #kfpAuthButton{width:auto!important;margin:0!important;padding:10px 16px!important;border:1px solid rgba(212,175,55,.7)!important;border-radius:999px!important;background:rgba(18,18,20,.82)!important;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);color:#f3d870!important;box-shadow:0 6px 20px rgba(0,0,0,.45);font-size:14px!important;font-weight:600;cursor:pointer;transition:transform .12s ease,filter .18s ease}
      #kfpAuthButton:active{transform:scale(.97)}
      #kfpAuthButton.logged-in{background:linear-gradient(135deg,#f3d870,#d4af37 55%,#b8901f)!important;color:#1a1400!important;border-color:transparent!important;box-shadow:0 6px 20px rgba(212,175,55,.3)}
      #kfpAuthPanel{display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);align-items:center;justify-content:center;padding:18px}
      #kfpAuthPanel.open{display:flex}
      .kfp-auth-modal{width:min(460px,100%);max-height:90vh;overflow:auto;background:linear-gradient(160deg,#1b1b1e,#111113);border:1px solid rgba(212,175,55,.55);border-radius:22px;padding:24px;box-shadow:0 24px 70px rgba(0,0,0,.65),0 0 44px rgba(212,175,55,.14);color:#f4f1e8}
      .kfp-auth-modal h2{color:#f3d870;margin:0 0 8px;font-size:21px;font-weight:600}.kfp-auth-modal p{color:#a29e93;margin:6px 0 16px;line-height:1.55}
      .kfp-auth-modal label{display:block;color:#e6c552;margin:12px 0 7px;font-size:14px;font-weight:500}.kfp-auth-modal input{width:100%;min-height:48px;padding:12px 14px;border-radius:12px;border:1px solid #2d2d31;background:#1b1b1e;color:#fff;font-size:16px;outline:none;transition:border-color .18s ease,box-shadow .18s ease}
      .kfp-auth-modal input:focus{border-color:#d4af37;box-shadow:0 0 0 3px rgba(212,175,55,.2)}
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
      @media(max-width:600px){#kfpAuthRoot{top:max(8px,env(safe-area-inset-top));right:8px}.kfp-auth-modal{padding:20px}}
    `;
    document.head.appendChild(style);

    const root = document.createElement("div");
    root.id = "kfpAuthRoot";
    root.innerHTML = `
      <button id="kfpAuthButton" type="button">🔐 Login</button>
      <div id="kfpAuthPanel">
        <div class="kfp-auth-modal">
          <h2>🔐 Korea Finance Planner</h2>
          <p>เข้าสู่ระบบเพื่อใช้ข้อมูลส่วนตัวข้ามเครื่องแบบ Cloud</p>

          <div id="kfpLoginArea">
            <label>Username</label><input id="kfpUsername" autocomplete="username" placeholder="เช่น inseang0133">
            <label>Password</label><input id="kfpPassword" type="password" autocomplete="current-password" placeholder="รหัสผ่าน">
            <div class="kfp-auth-row"><button id="kfpLoginBtn" type="button">🔐 เข้าสู่ระบบ</button><button id="kfpOpenAddBtn" class="kfp-auth-secondary" type="button">➕ เพิ่มบัญชี</button></div>
          </div>

          <div id="kfpAddUserArea" hidden>
            <label>Username</label><input id="kfpNewUsername" autocomplete="username" placeholder="อย่างน้อย 3 ตัวอักษร">
            <label>Password</label><input id="kfpNewPassword" type="password" autocomplete="new-password" placeholder="อย่างน้อย 6 ตัวอักษร">
            <label>ชื่อเล่น</label><input id="kfpNewNickname" placeholder="ชื่อที่จะแสดงบนเว็บ">
            <div class="kfp-auth-row"><button id="kfpCreateBtn" type="button">➕ สร้างบัญชี</button><button id="kfpBackLoginBtn" class="kfp-auth-secondary" type="button">กลับ Login</button></div>
            <p class="kfp-small">บัญชีนี้ใช้ Username + Password ตามที่คุณกรอก ไม่ต้องกรอกอีเมล</p>
          </div>

          <div id="kfpLoggedArea" hidden>
            <div class="kfp-auth-account">👤 <b id="kfpAccountUsername">-</b></div>
            <label>ชื่อเล่น</label><input id="kfpNickname" placeholder="ชื่อที่จะแสดง">
            <div class="kfp-auth-row"><button id="kfpSaveProfileBtn" type="button">💾 บันทึกชื่อเล่น</button><button id="kfpChangePassBtn" class="kfp-auth-secondary" type="button">🔑 เปลี่ยนรหัส</button></div>

            <div class="kfp-cloud-upload">
              <button id="kfpUploadCloudBtn" type="button">☁️ อัปโหลดข้อมูลขึ้น Cloud</button>
              <p class="kfp-small">ระบบจะไม่อัปโหลดข้อมูลเองอีกต่อไป · กดปุ่มนี้เท่านั้นจึงจะส่งข้อมูลเครื่องนี้ขึ้น Cloud</p>
            </div>

            <div class="kfp-auth-row"><button id="kfpLogoutBtn" class="kfp-auth-danger" type="button">🚪 Logout</button><button id="kfpCloseBtn" class="kfp-auth-secondary" type="button">ปิด</button></div>
          </div>
          <div id="kfpAuthStatus" class="kfp-auth-status"></div>
        </div>
      </div>`;
    document.body.appendChild(root);

    $("kfpAuthButton").onclick = () => {
      showAuthPanel();
      if (!VALID_CONFIG) setAuthStatus("ยังไม่ได้ตั้งค่า Supabase ใน supabase-config.js", "error");
    };
    $("kfpCloseBtn").onclick = hideAuthPanel;
    $("kfpOpenAddBtn").onclick = () => { $("kfpLoginArea").hidden=true; $("kfpAddUserArea").hidden=false; setAuthStatus(""); };
    $("kfpBackLoginBtn").onclick = () => { $("kfpLoginArea").hidden=false; $("kfpAddUserArea").hidden=true; setAuthStatus(""); };
    $("kfpLoginBtn").onclick = login;
    $("kfpCreateBtn").onclick = registerUser;
    $("kfpSaveProfileBtn").onclick = saveProfile;
    $("kfpChangePassBtn").onclick = changePassword;
    $("kfpUploadCloudBtn").onclick = uploadCloudData;
    $("kfpLogoutBtn").onclick = logout;
    $("kfpAuthPanel").addEventListener("click", e => { if(e.target.id === "kfpAuthPanel") hideAuthPanel(); });
  }

  async function getProfile(userId) {
    const { data, error } = await supabase
      .from("profiles")
      .select("user_id,username,nickname")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function createProfile(userId, username, nickname) {
    const { error } = await supabase
      .from("profiles")
      .upsert({ user_id:userId, username, nickname:nickname || username }, { onConflict:"user_id" });
    if (error) throw error;
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

    try {
      if (captureGuestBackup) saveGuestBackup(getLocalData());

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

      if (hasData(cloud)) {
        clearPersonalLocalData();
        putLocalData(cloud);
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

  async function login(){
    if (!isConfigured()) return setAuthStatus("กรุณาใส่ SUPABASE_URL และ SUPABASE_ANON_KEY ใน supabase-config.js ก่อน", "error");
    const username = $("kfpUsername").value.trim();
    const password = $("kfpPassword").value;
    if (!username || !password) return setAuthStatus("กรุณากรอก Username และ Password", "error");

    const btn = $("kfpLoginBtn");
    if (btn) { btn.disabled = true; btn.textContent = "⏳ กำลังเข้าสู่ระบบ..."; }
    setAuthStatus("กำลังเข้าสู่ระบบ…");

    try {
      const { data, error } = await withTimeout(
        supabase.auth.signInWithPassword({
          email: usernameEmail(username),
          password
        }),
        AUTH_TIMEOUT_MS,
        "Supabase ใช้เวลาตอบกลับนานเกิน 15 วินาที · ตรวจอินเทอร์เน็ตแล้วลองใหม่"
      );
      if (error) throw error;

      currentUser = data.user;
      localStorage.setItem(AUTH_USER_KEY, data.user.id);
      renderAuthButton();
      renderAccountArea();
      hideAuthPanel();

      // Profile/Cloud load continues in background.
      loadCloudForUser(data.user, { captureGuestBackup:true }).catch(() => {});
    } catch (e) {
      setAuthStatus(`เข้าสู่ระบบไม่สำเร็จ: ${e.message}`, "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "🔐 เข้าสู่ระบบ"; }
    }
  }

  async function registerUser(){
    if (!isConfigured()) return setAuthStatus("กรุณาตั้งค่า Supabase ก่อน", "error");
    const username = $("kfpNewUsername").value.trim().toLowerCase();
    const password = $("kfpNewPassword").value;
    const nickname = $("kfpNewNickname").value.trim() || username;
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) return setAuthStatus("Username ใช้ a-z, 0-9, จุด, _ หรือ - และยาว 3-32 ตัว", "error");
    if (password.length < 6) return setAuthStatus("Password ต้องมีอย่างน้อย 6 ตัว", "error");
    setAuthStatus("กำลังสร้างบัญชี...");
    try {
      const { data, error } = await supabase.auth.signUp({ email: usernameEmail(username), password });
      if (error) throw error;
      if (!data.user) throw new Error("Supabase ไม่ส่งข้อมูลผู้ใช้กลับมา");
      await createProfile(data.user.id, username, nickname);
      if (!data.session) {
        setAuthStatus("สร้างบัญชีแล้ว แต่ยังต้องยืนยันอีเมลใน Supabase", "error");
        return;
      }
      currentUser = data.user;
      localStorage.setItem(AUTH_USER_KEY, data.user.id);
      renderAuthButton();
      renderAccountArea();
      hideAuthPanel();
      loadCloudForUser(data.user, { captureGuestBackup:true, knownProfile:{user_id:data.user.id, username, nickname} }).catch(() => {});
    } catch (e) {
      setAuthStatus(`สร้างบัญชีไม่สำเร็จ: ${e.message}`, "error");
    }
  }

  async function saveProfile(){
    if (!currentUser) return;
    const nickname = $("kfpNickname").value.trim() || currentProfile?.username || "ผู้ใช้";
    const { error } = await supabase
      .from("profiles")
      .update({ nickname, updated_at:new Date().toISOString() })
      .eq("user_id", currentUser.id);
    if (error) return setAuthStatus(`บันทึกชื่อเล่นไม่สำเร็จ: ${error.message}`, "error");
    currentProfile = { ...currentProfile, nickname };
    renderAuthButton();
    setAuthStatus("บันทึกชื่อเล่นแล้ว", "ok");
  }

  async function changePassword(){
    if (!currentUser) return;
    const password = prompt("ตั้งรหัสผ่านใหม่ (อย่างน้อย 6 ตัวอักษร)");
    if (password === null) return;
    if (password.length < 6) return setAuthStatus("Password ต้องมีอย่างน้อย 6 ตัว", "error");
    const { error } = await supabase.auth.updateUser({ password });
    if (error) return setAuthStatus(`เปลี่ยนรหัสไม่สำเร็จ: ${error.message}`, "error");
    setAuthStatus("เปลี่ยนรหัสผ่านเรียบร้อยแล้ว", "ok");
  }

  async function logout(){
    if (!currentUser) return;
    try { await supabase.auth.signOut(); } catch (_) {}

    // Logout must NEVER upload current LocalStorage to Cloud.
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

  async function init(){
    if (initialized) return;
    initialized = true;
    injectUI();
    if (!isConfigured()) return;

    try {
      supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth:{ persistSession:true, autoRefreshToken:true, detectSessionInUrl:false }
      });

      const { data } = await withTimeout(
        supabase.auth.getSession(),
        AUTH_TIMEOUT_MS,
        "Supabase Session ใช้เวลาตอบกลับนานเกิน 15 วินาที"
      );
      if (data?.session?.user) {
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
        if (!session?.user) {
          currentUser = null;
          currentProfile = null;
          renderAuthButton();
          renderAccountArea();
          return;
        }

        // Session events can fire before/after page hydration on iOS PWA.
        // Always reflect the authenticated state immediately, then hydrate Cloud.
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

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
