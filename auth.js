/* Korea Finance Planner - optional Supabase login/cloud layer
 * Existing finance/gold logic remains untouched.
 * Guest mode: original LocalStorage behavior.
 * Login mode: personal data is mirrored to Supabase per auth user.
 */
(() => {
  "use strict";

  const CFG = window.KFP_SUPABASE_CONFIG || {};
  const SUPABASE_URL = CFG.SUPABASE_URL || "";
  const SUPABASE_ANON_KEY = CFG.SUPABASE_ANON_KEY || "";
  const VALID_CONFIG = /^https:\/\/[^\s]+\.supabase\.co(mp)?$/i.test(SUPABASE_URL) &&
    SUPABASE_ANON_KEY && !SUPABASE_ANON_KEY.includes("YOUR_SUPABASE");

  // Independent storage domains. Deleting salary history cannot delete the contract or exchange rate.
  const DATA_KEYS = [
    "salary", "kfp_exchange_rate_v1", "kfp_exchange_rate_updated_v1",
    "goal", "currentSaving", "kfp_contract_v1", "kfp_salary_records_v2",
    "kfp_sync_revision_v1",
    "kfp_deleted_keys_v1",
    "kfp_gold_lots_v1", "kfp_gold_settings_v1"
  ];
  const ARRAY_KEYS = new Set(["kfp_salary_records_v2", "kfp_gold_lots_v1"]);
  const LEGACY_TO_NEW = {
    "rate": "kfp_exchange_rate_v1",
    "rateUpdatedAt": "kfp_exchange_rate_updated_v1",
    "contractStartDate": "kfp_contract_v1",
    "salaryRecords": "kfp_salary_records_v2"
  };

  function normalizeDataKeys(data) {
    const out = { ...(data || {}) };
    for (const [oldKey, newKey] of Object.entries(LEGACY_TO_NEW)) {
      if (out[newKey] === undefined && out[oldKey] !== undefined) out[newKey] = out[oldKey];
      delete out[oldKey];
    }
    return out;
  }
  const GUEST_BACKUP_KEY = "__kfp_guest_backup_v1";
  const AUTH_USER_KEY = "__kfp_auth_user_v1";
  const SYNC_DEBOUNCE_MS = 700;

  let supabase = null;
  let currentUser = null;
  let currentProfile = null;
  let syncTimer = null;
  let realtimeChannel = null;
  let applyingCloud = false;
  let initialized = false;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]));

  function isConfigured() {
    return VALID_CONFIG && window.supabase?.createClient;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
    data = normalizeDataKeys(data);
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

  function replaceLocalData(data) {
    if (!data || typeof data !== "object") return;
    data = normalizeDataKeys(data);
    applyingCloud = true;
    try {
      for (const key of DATA_KEYS) {
        localStorage.removeItem(key);
      }
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
    try { DATA_KEYS.forEach(k => localStorage.removeItem(k)); }
    finally { applyingCloud = false; }
  }

  function hasData(data) {
    return data && Object.keys(data).length > 0;
  }

  function dataLabel(data) {
    const labels = [];
    if (data.kfp_salary_records_v2 && safeArray(data.kfp_salary_records_v2).length) labels.push("เงินเดือน");
    if (data.kfp_gold_lots_v1 && safeArray(data.kfp_gold_lots_v1).length) labels.push("รายการทอง");
    if (data.kfp_contract_v1) labels.push("สัญญาจ้าง");
    if (data.goal || data.currentSaving) labels.push("เป้าหมายเงินเก็บ");
    return labels.length ? labels.join(" · ") : "ข้อมูลการตั้งค่า";
  }

  function safeArray(raw) {
    try { const x = JSON.parse(raw || "[]"); return Array.isArray(x) ? x : []; }
    catch { return []; }
  }

  function safeObj(raw) {
    try { const x = JSON.parse(raw || "{}"); return x && typeof x === "object" && !Array.isArray(x) ? x : {}; }
    catch { return {}; }
  }

  function getDeletedKeys(data) {
    try {
      const raw = data?.kfp_deleted_keys_v1;
      const x = typeof raw === "string" ? JSON.parse(raw || "{}") : (raw || {});
      return x && typeof x === "object" && !Array.isArray(x) ? x : {};
    } catch (_) { return {}; }
  }

  function mergeData(local, cloud) {
    local = normalizeDataKeys(local);
    cloud = normalizeDataKeys(cloud);
    const deleted = { ...getDeletedKeys(cloud), ...getDeletedKeys(local) };
    const out = { ...(cloud || {}), ...(local || {}) };

    // Explicitly deleted keys are authoritative. This is what prevents an empty
    // salary history or deleted contract from being resurrected by Cloud/PWA.
    for (const key of Object.keys(deleted)) delete out[key];

    // For finance scalar/array domains, presence in the current device is authoritative.
    // An empty [] is meaningful and must NOT be treated as "missing".
    for (const key of [
      "salary", EXCHANGE_RATE_KEY, "kfp_exchange_rate_updated_v1",
      "goal", "currentSaving", "kfp_contract_v1", "kfp_salary_records_v2"
    ]) {
      if (Object.prototype.hasOwnProperty.call(local, key) && !Object.prototype.hasOwnProperty.call(deleted, key)) {
        out[key] = local[key];
      }
    }

    // Gold records/settings retain the existing merge behavior.
    if (local.kfp_gold_lots_v1 !== undefined && !deleted.kfp_gold_lots_v1) {
      const la = safeArray(local.kfp_gold_lots_v1), ca = safeArray(cloud.kfp_gold_lots_v1);
      const map = new Map();
      for (const item of ca) if (item?.id) map.set(String(item.id), item);
      for (const item of la) if (item?.id) map.set(String(item.id), item);
      out.kfp_gold_lots_v1 = JSON.stringify([...map.values(), ...la.filter(x => !x?.id)]);
    }
    if (local.kfp_gold_settings_v1 !== undefined && !deleted.kfp_gold_settings_v1) {
      out.kfp_gold_settings_v1 = JSON.stringify({ ...safeObj(cloud.kfp_gold_settings_v1), ...safeObj(local.kfp_gold_settings_v1) });
    }

    if (Object.keys(deleted).length) out.kfp_deleted_keys_v1 = JSON.stringify(deleted);
    else delete out.kfp_deleted_keys_v1;
    return out;
  }

  function guestBackup() {
    try { return JSON.parse(localStorage.getItem(GUEST_BACKUP_KEY) || "null"); }
    catch { return null; }
  }

  function saveGuestBackup(data) {
    try { localStorage.setItem(GUEST_BACKUP_KEY, JSON.stringify(data || {})); } catch (_) {}
  }

  async function getCloudRow(userId) {
    const { data, error } = await supabase.from("user_data").select("user_id,data,updated_at").eq("user_id", userId).maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function saveCloud(data = getLocalData()) {
    if (!currentUser || applyingCloud) return;
    data = normalizeDataKeys(data);
    const deleted = getDeletedKeys(data);
    let cloud = {};
    try {
      const row = await getCloudRow(currentUser.id);
      cloud = normalizeDataKeys(row?.data || {});
    } catch (_) {}

    // Preserve unrelated cloud domains. Only keys explicitly present locally
    // or explicitly tombstoned are changed. This prevents deleting salary from
    // accidentally deleting the Korea contract/exchange-rate domains.
    const merged = mergeData(data, cloud);
    const revision = Math.max(
      Number(data.kfp_sync_revision_v1) || 0,
      Number(localStorage.getItem("kfp_sync_revision_v1")) || 0,
      Number(cloud.kfp_sync_revision_v1) || 0,
      Date.now()
    );
    merged.kfp_sync_revision_v1 = String(revision);
    try { localStorage.setItem("kfp_sync_revision_v1", String(revision)); } catch (_) {}
    if (Object.keys(deleted).length) merged.kfp_deleted_keys_v1 = JSON.stringify(deleted);

    const payload = { user_id: currentUser.id, data: merged, updated_at: new Date().toISOString() };
    const { error } = await supabase.from("user_data").upsert(payload, { onConflict: "user_id" });
    if (error) console.error("KFP cloud sync:", error);
  }

  function scheduleCloudSave() {
    if (!currentUser || applyingCloud) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => saveCloud(), SYNC_DEBOUNCE_MS);
  }

  async function getProfile(userId) {
    const { data, error } = await supabase.from("profiles").select("user_id,username,nickname").eq("user_id", userId).maybeSingle();
    if (error) throw error;
    return data;
  }

  async function createProfile(userId, username, nickname) {
    const { error } = await supabase.from("profiles").upsert({ user_id: userId, username, nickname: nickname || username }, { onConflict: "user_id" });
    if (error) throw error;
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
      $("kfpAccountUsername").textContent = currentProfile?.username || "-";
      $("kfpNickname").value = currentProfile?.nickname || "";
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
      .kfp-auth-modal{width:min(430px,100%);max-height:90vh;overflow:auto;background:#181818;border:1px solid #d4af37;border-radius:18px;padding:22px;box-shadow:0 0 40px rgba(212,175,55,.18);color:#fff}
      .kfp-auth-modal h2{color:#d4af37;margin:0 0 8px}.kfp-auth-modal p{color:#aaa;margin:6px 0 16px}
      .kfp-auth-modal label{display:block;color:#d4af37;margin:12px 0 7px}.kfp-auth-modal input{width:100%;padding:12px;border-radius:10px;border:1px solid #333;background:#222;color:#fff;font-size:16px}
      .kfp-auth-row{display:flex;gap:10px;margin-top:14px}
       .kfp-auth-row button{
         flex:1;width:auto!important;margin:0!important;padding:12px 14px!important;
         border:1px solid #b18d21!important;border-radius:10px!important;
         background:#d4af37!important;color:#111!important;font-weight:700!important;
         cursor:pointer;box-shadow:0 3px 12px rgba(212,175,55,.12);
       }
       .kfp-auth-row button:hover{filter:brightness(1.06);transform:translateY(-1px)}
       .kfp-auth-row button:active{transform:translateY(0)}
      .kfp-auth-secondary{background:#2a2a2a!important;color:#fff!important;border:1px solid #555!important}.kfp-auth-danger{background:#421d1d!important;color:#ff7777!important;border:1px solid #a33!important}
      .kfp-auth-status{min-height:20px;margin-top:10px;color:#aaa}.kfp-auth-status.ok{color:#37d478}.kfp-auth-status.error{color:#ff6b6b}.kfp-auth-account{background:#222;border-radius:12px;padding:12px;margin:12px 0}
      .kfp-auth-cloud{border:1px solid #d4af37;border-radius:14px;padding:16px;background:#151515;margin-top:12px}.kfp-auth-cloud h3{color:#d4af37;margin:0 0 8px}
      .kfp-choice{display:grid;gap:9px;margin-top:12px}
       .kfp-choice button{
         margin:0!important;width:100%!important;padding:12px 14px!important;
         border:1px solid #b18d21!important;border-radius:10px!important;
         background:#d4af37!important;color:#111!important;font-weight:700!important;
         cursor:pointer;
       }
       .kfp-choice button:hover{filter:brightness(1.06)}
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
          <p>เข้าสู่ระบบเพื่อซิงค์ข้อมูลของผู้ใช้ข้ามเครื่องแบบ Cloud</p>

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
            <div class="kfp-auth-row"><button id="kfpLogoutBtn" class="kfp-auth-danger" type="button">🚪 Logout</button><button id="kfpCloseBtn" class="kfp-auth-secondary" type="button">ปิด</button></div>
          </div>
          <div id="kfpAuthStatus" class="kfp-auth-status"></div>
        </div>
      </div>`;
    document.body.appendChild(root);

    $("kfpAuthButton").onclick = () => { showAuthPanel(); setAuthStatus(VALID_CONFIG ? "" : "ยังไม่ได้ตั้งค่า Supabase ใน supabase-config.js", VALID_CONFIG ? "" : "error"); };
    $("kfpCloseBtn").onclick = hideAuthPanel;
    $("kfpOpenAddBtn").onclick = () => { $("kfpLoginArea").hidden=true; $("kfpAddUserArea").hidden=false; setAuthStatus(""); };
    $("kfpBackLoginBtn").onclick = () => { $("kfpLoginArea").hidden=false; $("kfpAddUserArea").hidden=true; setAuthStatus(""); };
    $("kfpLoginBtn").onclick = login;
    $("kfpCreateBtn").onclick = registerUser;
    $("kfpSaveProfileBtn").onclick = saveProfile;
    $("kfpChangePassBtn").onclick = changePassword;
    $("kfpLogoutBtn").onclick = logout;
    $("kfpAuthPanel").addEventListener("click", e => { if(e.target.id === "kfpAuthPanel") hideAuthPanel(); });
  }

  async function showDataChoice(local, cloud) {
    return new Promise(resolve => {
      const panel = $("kfpAuthPanel");
      const modal = panel.querySelector(".kfp-auth-modal");
      const old = modal.innerHTML;
      modal.innerHTML = `
        <h2>🔐 Login สำเร็จ</h2>
        <div class="kfp-auth-cloud">
          <h3>☁️ พบข้อมูล Cloud</h3>
          <p>พบข้อมูลทั้งสองฝั่ง ระบบจะไม่เขียนทับกันโดยอัตโนมัติ</p>
          <p>📱 ข้อมูลในเครื่อง: <b>${esc(dataLabel(local))}</b><br>☁️ ข้อมูล Cloud: <b>${esc(dataLabel(cloud))}</b></p>
          <div class="kfp-choice">
            <button data-choice="merge">🔀 รวมข้อมูล</button>
            <button data-choice="cloud">☁️ ใช้ข้อมูล Cloud</button>
            <button data-choice="local">📱 ใช้ข้อมูลในเครื่อง</button>
          </div>
        </div>`;
      panel.classList.add("open");
      modal.querySelectorAll("[data-choice]").forEach(btn => btn.onclick = () => {
        const choice = btn.dataset.choice;
        modal.innerHTML = old;
        // Rebind only the modal buttons after restoring its HTML.
        bindModalHandlers();
        resolve(choice);
      });
    });
  }

  function bindModalHandlers(){
    $("kfpCloseBtn").onclick = hideAuthPanel;
    $("kfpOpenAddBtn")?.addEventListener("click", () => { $("kfpLoginArea").hidden=true; $("kfpAddUserArea").hidden=false; });
    $("kfpBackLoginBtn")?.addEventListener("click", () => { $("kfpLoginArea").hidden=false; $("kfpAddUserArea").hidden=true; });
    $("kfpLoginBtn")?.addEventListener("click", login);
    $("kfpCreateBtn")?.addEventListener("click", registerUser);
    $("kfpSaveProfileBtn")?.addEventListener("click", saveProfile);
    $("kfpChangePassBtn")?.addEventListener("click", changePassword);
    $("kfpLogoutBtn")?.addEventListener("click", logout);
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
      await activateUser(data.user);
    } catch (e) { setAuthStatus(`เข้าสู่ระบบไม่สำเร็จ: ${e.message}`, "error"); }
  }

  async function registerUser(){
    if (!isConfigured()) return setAuthStatus("กรุณาตั้งค่า Supabase ก่อน", "error");
    const username = $("kfpNewUsername").value.trim().toLowerCase();
    const password = $("kfpNewPassword").value;
    const nickname = $("kfpNewNickname").value.trim() || username;
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) return setAuthStatus("Username ใช้ a-z, 0-9, จุด, _ หรือ - และยาว 3-32 ตัว", "error");
    if (password.length < 6) return setAuthStatus("Password ต้องมีอย่างน้อย 6 ตัวอักษร", "error");
    setAuthStatus("กำลังสร้างบัญชี...");
    try {
      const { data, error } = await supabase.auth.signUp({ email: usernameEmail(username), password });
      if (error) throw error;
      if (!data.user) throw new Error("Supabase ไม่ส่งข้อมูลผู้ใช้กลับมา");
      await createProfile(data.user.id, username, nickname);
      if (!data.session) {
        setAuthStatus("สร้างบัญชีแล้ว แต่ Supabase ยังเปิดยืนยันอีเมลอยู่ ให้ปิด Confirm email ใน Authentication > Providers > Email", "error");
        return;
      }
      await activateUser(data.user);
    } catch (e) { setAuthStatus(`สร้างบัญชีไม่สำเร็จ: ${e.message}`, "error"); }
  }

  async function activateUser(user){
    currentUser = user;
    currentProfile = await getProfile(user.id);
    localStorage.setItem(AUTH_USER_KEY, user.id);

    const local = getLocalData();
    // Guest backup is captured only once per login session, before cloud data is loaded.
    saveGuestBackup(local);
    const row = await getCloudRow(user.id);
    const cloud = normalizeDataKeys(row?.data || {});

    if (hasData(local) && hasData(cloud)) {
      const choice = await showDataChoice(local, cloud);
      if (choice === "merge") {
        const merged = mergeData(local, cloud);
        putLocalData(merged);
        await saveCloud(merged);
      } else if (choice === "cloud") {
        putLocalData(cloud);
      } else {
        // Local wins for this device and is uploaded to the user's Cloud record.
        await saveCloud(local);
      }
    } else if (hasData(cloud)) {
      putLocalData(cloud);
    } else if (hasData(local)) {
      await saveCloud(local);
    } else {
      await saveCloud({});
    }

    await subscribeRealtime();
renderAuthButton();
renderAccountArea();
hideAuthPanel();

// ไม่ต้อง reload หน้าเว็บหลัง Login
  }

  async function subscribeRealtime(){
  if (!currentUser || realtimeChannel) return;

  realtimeChannel = supabase.channel(`kfp-user-${currentUser.id}`)
  .on(
    "postgres_changes",
    {
      event: "*",
      schema: "public",
      table: "user_data",
      filter: `user_id=eq.${currentUser.id}`
    },
    payload => {

      if (!payload.new?.data || applyingCloud) return;

      const cloudData = normalizeDataKeys(payload.new.data);
      const cloudRev = Number(cloudData.kfp_sync_revision_v1) || 0;
      const localRev = Number(localStorage.getItem("kfp_sync_revision_v1")) || 0;

      // Ignore stale realtime events. This prevents an older salary snapshot
      // from resurrecting a record that was just deleted.
      if (cloudRev <= localRev) return;

      // Apply Cloud by independent domain. A local tombstone/empty array is preserved,
      // and unrelated domains (contract/rate) are never cleared accidentally.
      const merged = mergeData(getLocalData(), cloudData);
      replaceLocalData(merged);
      try { if (typeof window.__kfpPwaPersist === "function") window.__kfpPwaPersist(); } catch (_) {}

      // Refresh index.html UI without reloading the page.
      try {
        if (typeof loadSalaryRecords === "function") loadSalaryRecords();
        if (typeof updateAnalytics === "function") updateAnalytics();
        if (typeof loadContract === "function") loadContract();
        if (typeof updateSalaryPreview === "function") updateSalaryPreview();
        if (typeof convertCurrency === "function") convertCurrency();
      } catch (_) {}

      setAuthStatus(
        "☁️ ข้อมูล Cloud อัปเดตแล้ว",
        "ok"
      );

      // ❌ ห้าม location.reload()
    }
  )
  .subscribe();
}

  async function saveProfile(){
    if (!currentUser) return;
    const nickname = $("kfpNickname").value.trim() || currentProfile?.username || "ผู้ใช้";
    const { error } = await supabase.from("profiles").update({ nickname, updated_at:new Date().toISOString() }).eq("user_id", currentUser.id);
    if (error) return setAuthStatus(`บันทึกชื่อเล่นไม่สำเร็จ: ${error.message}`, "error");
    currentProfile = { ...currentProfile, nickname };
    renderAuthButton(); setAuthStatus("บันทึกชื่อเล่นแล้ว", "ok");
  }

  async function changePassword(){
    if (!currentUser) return;
    const password = prompt("ตั้งรหัสผ่านใหม่ (อย่างน้อย 6 ตัวอักษร)");
    if (password === null) return;
    if (password.length < 6) return setAuthStatus("Password ต้องมีอย่างน้อย 6 ตัวอักษร", "error");
    const { error } = await supabase.auth.updateUser({ password });
    if (error) return setAuthStatus(`เปลี่ยนรหัสไม่สำเร็จ: ${error.message}`, "error");
    setAuthStatus("เปลี่ยนรหัสผ่านเรียบร้อยแล้ว", "ok");
  }

  async function logout(){
    if (!currentUser) return;
    clearTimeout(syncTimer);
    await saveCloud(getLocalData());
    const backup = guestBackup() || {};
    clearPersonalLocalData();
    putLocalData(backup);
    localStorage.removeItem(AUTH_USER_KEY);
    try { await supabase.auth.signOut(); } catch (_) {}
    currentUser = null; currentProfile = null;
    if (realtimeChannel) { try { await supabase.removeChannel(realtimeChannel); } catch (_) {} realtimeChannel = null; }
    renderAuthButton(); renderAccountArea();
    hideAuthPanel();
    location.reload();
  }

  function patchLocalStorage(){
    const proto = Storage.prototype;
    if (proto.__kfpPatched) return;
    const originalSet = proto.setItem;
    const originalRemove = proto.removeItem;
    proto.setItem = function(key, value){
      const result = originalSet.call(this, key, value);
      if (this === window.localStorage && currentUser && !applyingCloud && DATA_KEYS.includes(String(key))) scheduleCloudSave();
      return result;
    };
    proto.removeItem = function(key){
      const result = originalRemove.call(this, key);
      if (this === window.localStorage && currentUser && !applyingCloud && DATA_KEYS.includes(String(key))) scheduleCloudSave();
      return result;
    };
    Object.defineProperty(proto, "__kfpPatched", { value:true, configurable:false });
  }

  async function init(){
    if (initialized) return; initialized = true;
    injectUI(); patchLocalStorage();
    if (!isConfigured()) return;
    try {
      supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth:{ persistSession:true, autoRefreshToken:true, detectSessionInUrl:false } });
      const { data } = await supabase.auth.getSession();
      if (data?.session?.user) {
        currentUser = data.session.user;
        currentProfile = await getProfile(currentUser.id);
        await subscribeRealtime();
        renderAuthButton(); renderAccountArea();
      }
      supabase.auth.onAuthStateChange(async (_event, session) => {
        if (!session?.user) { currentUser=null; currentProfile=null; renderAuthButton(); renderAccountArea(); }
      });
    } catch (e) { console.error("KFP auth init:", e); setAuthStatus(`Auth เริ่มต้นไม่สำเร็จ: ${e.message}`, "error"); }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
