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
  const DATA_KEYS = [
    "salary", "rate", "rateUpdatedAt", "goal", "currentSaving",
    "contractStartDate", "salaryRecords",
    "__kfp_deleted_keys_v1",
    "kfp_gold_lots_v1", "kfp_gold_settings_v1"
  ];

  const ARRAY_KEYS = new Set(["salaryRecords", "kfp_gold_lots_v1"]);
  const GUEST_BACKUP_KEY = "__kfp_guest_backup_v1";
  const AUTH_USER_KEY = "__kfp_auth_user_v1";

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
      #kfpAuthRoot{position:fixed;top:14px;right:14px;z-index:99999;font-family:Arial,sans-serif}
      #kfpAuthButton{width:auto!important;margin:0!important;padding:10px 14px!important;border:1px solid #d4af37!important;border-radius:12px!important;background:#181818!important;color:#fff!important;box-shadow:0 4px 18px rgba(0,0,0,.35);font-size:14px!important}
      #kfpAuthButton.logged-in{background:#d4af37!important;color:#111!important}
      #kfpAuthPanel{display:none;position:fixed;inset:0;background:rgba(0,0,0,.68);backdrop-filter:blur(5px);align-items:center;justify-content:center;padding:18px}
      #kfpAuthPanel.open{display:flex}
      .kfp-auth-modal{width:min(460px,100%);max-height:90vh;overflow:auto;background:#181818;border:1px solid #d4af37;border-radius:18px;padding:22px;box-shadow:0 0 40px rgba(212,175,55,.18);color:#fff}
      .kfp-auth-modal h2{color:#d4af37;margin:0 0 8px}.kfp-auth-modal p{color:#aaa;margin:6px 0 16px}
      .kfp-auth-modal label{display:block;color:#d4af37;margin:12px 0 7px}.kfp-auth-modal input{width:100%;padding:12px;border-radius:10px;border:1px solid #333;background:#222;color:#fff;font-size:16px}
      .kfp-auth-row{display:flex;gap:10px;margin-top:14px}.kfp-auth-row button{flex:1;width:auto!important;margin:0!important}
      .kfp-auth-secondary{background:#2a2a2a!important;color:#fff!important;border:1px solid #555!important}.kfp-auth-danger{background:#421d1d!important;color:#ff7777!important;border:1px solid #a33!important}
      .kfp-auth-status{min-height:20px;margin-top:10px;color:#aaa;line-height:1.5}.kfp-auth-status.ok{color:#37d478}.kfp-auth-status.error{color:#ff6b6b}
      .kfp-auth-account{background:#222;border-radius:12px;padding:12px;margin:12px 0}
      .kfp-cloud-upload{margin-top:14px;padding:14px;border:1px solid #5c4b16;border-radius:13px;background:#151515}
      .kfp-cloud-upload button{width:100%!important;margin:0!important}
      .kfp-cloud-upload .kfp-small{margin:8px 0 0!important}
      .kfp-small{font-size:12px;color:#888!important}
      @media(max-width:600px){#kfpAuthRoot{top:8px;right:8px}.kfp-auth-modal{padding:18px}}
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
    // Session identity is already trusted by Supabase. Show the logged-in state
    // immediately; Cloud/PWA hydration must not block the Login button.
    currentUser = user;
    if (knownProfile) currentProfile = knownProfile;
    localStorage.setItem(AUTH_USER_KEY, user.id);
    renderAuthButton();
    renderAccountArea();

    // PWA restoration is for app data only. It must never control Auth state.
    try {
      if (window.__kfpPwaReady && typeof window.__kfpPwaReady.then === "function") {
        await window.__kfpPwaReady;
      }
    } catch (_) {}

    try {
      if (!knownProfile) {
        currentProfile = await getProfile(user.id);
        renderAuthButton();
      }
      const local = getLocalData();
      if (captureGuestBackup) saveGuestBackup(local);

      const row = await getCloudRow(user.id);
      const cloud = row?.data && typeof row.data === "object" ? row.data : {};

      if (hasData(cloud)) {
        // Cloud is authoritative when it exists. Clear every personal key first so
        // stale LocalStorage from another device/account cannot leak into the session.
        clearPersonalLocalData();
        putLocalData(cloud);
        notifyCloudLoaded();
        setAuthStatus(
          `☁️ โหลดข้อมูล Cloud แล้ว · ล่าสุด ${row?.updated_at ? new Date(row.updated_at).toLocaleString("th-TH", {dateStyle:"short", timeStyle:"medium"}) : "-"}`,
          "ok"
        );
      } else {
        // First-time/empty Cloud: keep this device's LocalStorage. Nothing is uploaded.
        notifyCloudLoaded();
        setAuthStatus("☁️ บัญชีนี้ยังไม่มีข้อมูล Cloud · ข้อมูลในเครื่องยังอยู่ และจะไม่อัปโหลดจนกดปุ่ม", "");
      }
    } catch (e) {
      // Keep the authenticated UI visible even if profile/cloud loading is slow or fails.
      renderAuthButton();
      renderAccountArea();
      setAuthStatus(`โหลดข้อมูล Cloud ไม่สำเร็จ: ${e?.message || e}`, "error");
      throw e;
    }

    renderAuthButton();
    renderAccountArea();
  }

  async function login(){
    if (!isConfigured()) return setAuthStatus("กรุณาใส่ SUPABASE_URL และ SUPABASE_ANON_KEY ใน supabase-config.js ก่อน", "error");
    const username = $("kfpUsername").value.trim();
    const password = $("kfpPassword").value;
    if (!username || !password) return setAuthStatus("กรุณากรอก Username และ Password", "error");
    setAuthStatus("กำลังเข้าสู่ระบบ...");
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email: usernameEmail(username), password });
      if (error) throw error;

      // Do not make the UI wait for Cloud hydration. The Supabase session is valid now.
      currentUser = data.user;
      localStorage.setItem(AUTH_USER_KEY, data.user.id);
      renderAuthButton();
      renderAccountArea();
      hideAuthPanel();

      // Hydrate Cloud data after the authenticated UI is visible.
      loadCloudForUser(data.user, { captureGuestBackup:true }).catch(() => {});
    } catch (e) {
      setAuthStatus(`เข้าสู่ระบบไม่สำเร็จ: ${e.message}`, "error");
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
      await loadCloudForUser(data.user, { captureGuestBackup:true });
      hideAuthPanel();
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

      const { data } = await supabase.auth.getSession();
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
