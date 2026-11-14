/*
  kfp-storage.js — Preview / Member storage isolation  (Phase 3)
  ต้องโหลด "ก่อน" สคริปต์อื่นทั้งหมดของหน้า (ต่อจาก supabase-config.js + kfp-demo-data.js)

  แนวคิด: โค้ดเดิมทั้งหมดใช้ localStorage.getItem("salary") ฯลฯ ตรงๆ
  ไฟล์นี้แทน window.localStorage ด้วย storage ของเรา โดยไม่ต้องแก้สูตร/โค้ดเดิม

  • PREVIEW (ยังไม่ Login / ยังไม่ยืนยันอีเมล)
      คีย์ข้อมูลส่วนตัว → หน่วยความจำ ที่ใส่ Demo Data ไว้ · เขียนได้แต่ไม่ลงเครื่อง หายเมื่อรีโหลด
      ไม่มีทางอ่านข้อมูลจริงของใครในเครื่องนี้
  • MEMBER  (มี Supabase session ที่ยืนยันอีเมลแล้ว)
      คีย์ข้อมูลส่วนตัว → LocalStorage จริง แต่แยกชื่อตามบัญชี:  kfp:u:<user_id>:<key>
  • คีย์สาธารณะ (session ของ Supabase, เรตเงิน, ราคาทอง/ข่าว cache, ตำแหน่งปุ่ม) → LocalStorage จริงตามเดิม

  การย้ายข้อมูลเก่า (คีย์ไม่มี prefix จากเวอร์ชันก่อน):
      ถ้าเครื่องนี้เคย Login ไว้ (__kfp_auth_user_v1) → ย้ายเข้าช่องของบัญชีนั้น
      ถ้าไม่ใช่ → เก็บเป็น "ข้อมูลเดิมในเครื่อง" kfp:device:<key> ให้สมาชิกกดนำเข้าบัญชีได้ภายหลัง
      ไม่มีการลบข้อมูลทิ้ง
*/
(function () {
  "use strict";
  if (window.kfpStorage) return;

  var real;
  try { real = window.localStorage; } catch (_) { real = null; }
  if (!real) { // storage ถูกปิด (เช่น private mode บางรุ่น) → ใช้หน่วยความจำล้วน
    var m0 = {};
    real = { getItem: function (k) { return k in m0 ? m0[k] : null; }, setItem: function (k, v) { m0[k] = String(v); },
             removeItem: function (k) { delete m0[k]; }, key: function (i) { return Object.keys(m0)[i] || null; },
             get length() { return Object.keys(m0).length; }, clear: function () { m0 = {}; } };
  }

  var NS_USER = "kfp:u:";
  var NS_DEVICE = "kfp:device:";
  var AUTH_USER_KEY = "__kfp_auth_user_v1";
  var GUEST_BACKUP_KEY = "__kfp_guest_backup_v1";

  // คีย์ที่ไม่ใช่ข้อมูลส่วนตัว (ใช้ร่วมกันได้ทั้งเครื่อง) — คีย์อื่นทั้งหมดถือเป็นข้อมูลส่วนตัว (ปลอดภัยไว้ก่อน)
  var SHARED_EXACT = {
    "rate": 1, "rateUpdatedAt": 1, "kfp_exchange_rate_v1": 1, "kfp_exchange_rate_updated_v1": 1,
    "kfp_gold_market_history_v1": 1, "kfp_gold_daily_history_v2": 1, "kfp_gold_intraday_history_v2": 1,
    "kfp_gold_usd_ticks_v3": 1, "kfp_gold_usd_daily_v3": 1, "kfp_gold_rec_cursor_v1": 1,
    "kfp_gold_news_v1": 1, "kfp_gold_thai_prices_v1": 1, "kfp_gold_last_market": 1,
    "kfp_fab_pos_v1": 1, "__all_local_storage__": 1
  };
  SHARED_EXACT[AUTH_USER_KEY] = 1;
  // kfp:* = ที่เก็บภายในของไฟล์นี้ (namespace ของทุกบัญชี) → หน้าเว็บเข้าถึงผ่าน localStorage ไม่ได้
  function isInternal(k) { return String(k).indexOf("kfp:") === 0; }
  function isShared(k) {
    k = String(k);
    return SHARED_EXACT[k] === 1 || k.indexOf("sb-") === 0 || k.indexOf("supabase") === 0;
  }
  function isPersonalBare(k) { return !isInternal(k) && !isShared(k); }

  function realKeys() {
    var out = [];
    try { for (var i = 0; i < real.length; i++) { var k = real.key(i); if (k !== null) out.push(k); } } catch (_) {}
    return out;
  }

  /* ---------- ตรวจ session จาก Supabase (อ่านแบบ sync ก่อนสคริปต์อื่น) ---------- */
  function sessionUser() {
    var cfg = window.KFP_SUPABASE_CONFIG || {};
    var ref = "";
    try { ref = new URL(cfg.SUPABASE_URL).hostname.split(".")[0]; } catch (_) {}
    // Only the configured project's session counts (a staging/other-project token
    // on the same domain must never switch this page into Member mode).
    if (!ref) return null;
    var keys = ["sb-" + ref + "-auth-token"];
    for (var i = 0; i < keys.length; i++) {
      try {
        var raw = real.getItem(keys[i]); if (!raw) continue;
        var s = JSON.parse(raw);
        var u = s && (s.user || (s.currentSession && s.currentSession.user));
        if (u && u.id) {
          // ยังไม่ยืนยันอีเมล = ยังไม่ใช่สมาชิก
          if (!u.email_confirmed_at && !u.confirmed_at) return null;
          if (!/^[0-9a-zA-Z-]{6,64}$/.test(u.id)) return null;
          return { id: u.id, email: u.email || "" };
        }
      } catch (_) {}
    }
    return null;
  }

  /* ---------- ย้ายคีย์เก่าที่ไม่มี prefix (ทำทุกครั้งที่เปิดหน้า, ไม่ทับของที่มีอยู่) ---------- */
  function migrateBareKeys(sess) {
    var owner = real.getItem(AUTH_USER_KEY);
    if (owner && !/^[0-9a-zA-Z-]{6,64}$/.test(owner)) owner = null;
    var moved = 0;
    realKeys().forEach(function (k) {
      if (!isPersonalBare(k)) return;
      var v = real.getItem(k);
      if (k === GUEST_BACKUP_KEY) {
        // ข้อมูล guest ที่ auth.js เดิมเก็บไว้ตอน Login → เป็นข้อมูลเดิมในเครื่อง
        try {
          var g = JSON.parse(v || "null");
          if (g && typeof g === "object") Object.keys(g).forEach(function (gk) {
            if (isPersonalBare(gk) && g[gk] != null && real.getItem(NS_DEVICE + gk) === null) real.setItem(NS_DEVICE + gk, String(g[gk]));
          });
        } catch (_) {}
      } else {
        var dest = (owner ? NS_USER + owner + ":" : NS_DEVICE) + k;
        if (real.getItem(dest) === null && v !== null) real.setItem(dest, v);
      }
      real.removeItem(k);
      moved++;
    });
    return moved;
  }

  var sess = sessionUser();
  var migrated = 0;
  try { migrated = migrateBareKeys(sess); } catch (e) { console.warn("kfp-storage migrate:", e); }

  var MODE = sess ? "member" : "preview";
  var PREFIX = sess ? NS_USER + sess.id + ":" : "";

  /* ---------- storage objects ---------- */
  function makeMember() {
    function listOwn() {
      var out = [];
      realKeys().forEach(function (k) {
        if (k.indexOf(PREFIX) === 0) out.push(k.slice(PREFIX.length));
        else if (isShared(k)) out.push(k);
      });
      return out;
    }
    return {
      getItem: function (k) { k = String(k); if (isInternal(k)) return null; return real.getItem(isShared(k) ? k : PREFIX + k); },
      setItem: function (k, v) { k = String(k); if (isInternal(k)) return; real.setItem(isShared(k) ? k : PREFIX + k, String(v)); },
      removeItem: function (k) { k = String(k); if (isInternal(k)) return; real.removeItem(isShared(k) ? k : PREFIX + k); },
      key: function (i) { var l = listOwn(); return i >= 0 && i < l.length ? l[i] : null; },
      get length() { return listOwn().length; },
      clear: function () { realKeys().forEach(function (k) { if (k.indexOf(PREFIX) === 0) real.removeItem(k); }); }
    };
  }

  function makePreview() {
    var mem = Object.create(null);
    var demo = (window.KFP_DEMO && window.KFP_DEMO.data) || {};
    Object.keys(demo).forEach(function (k) { mem[k] = String(demo[k]); });
    function listOwn() {
      var out = Object.keys(mem);
      realKeys().forEach(function (k) { if (isShared(k)) out.push(k); });
      return out;
    }
    return {
      getItem: function (k) { k = String(k); if (isInternal(k)) return null; if (isShared(k)) return real.getItem(k); return k in mem ? mem[k] : null; },
      setItem: function (k, v) { k = String(k); if (isInternal(k)) return; if (isShared(k)) { real.setItem(k, String(v)); return; } mem[k] = String(v); },
      removeItem: function (k) { k = String(k); if (isInternal(k)) return; if (isShared(k)) { real.removeItem(k); return; } delete mem[k]; },
      key: function (i) { var l = listOwn(); return i >= 0 && i < l.length ? l[i] : null; },
      get length() { return listOwn().length; },
      clear: function () { mem = Object.create(null); }
    };
  }

  var store = MODE === "member" ? makeMember() : makePreview();
  try {
    Object.defineProperty(window, "localStorage", { configurable: true, enumerable: true, get: function () { return store; } });
  } catch (e) {
    // ถ้า browser ไม่ยอมให้แทน ห้ามแสดงข้อมูลจริงให้ guest: บังคับ preview ไม่ได้ จึงบันทึกไว้ให้หน้าเว็บตัดสินใจ
    console.error("kfp-storage: cannot isolate localStorage", e);
    window.__kfpStorageIsolationFailed = true;
  }
  // Self-check (Safari/iOS must be verified on a real device). If the swap did not
  // take effect, no data can leak: every personal key now lives under kfp:*, which
  // the old code never reads — the page would just look empty.
  try { if (window.localStorage !== store) window.__kfpStorageIsolationFailed = true; } catch (_) { window.__kfpStorageIsolationFailed = true; }
  if (window.__kfpStorageIsolationFailed) document.documentElement.setAttribute("data-kfp-isolation", "failed");
  window.__kfpRealLocalStorage = real;
  document.documentElement.setAttribute("data-kfp-mode", MODE);

  /* ---------- reload ที่ปลอดภัย (กันวนลูป) ---------- */
  function reboot(reason) {
    var now = Date.now(), hist = [];
    try { hist = JSON.parse(sessionStorage.getItem("__kfp_reboots") || "[]").filter(function (t) { return now - t < 15000; }); } catch (_) {}
    if (hist.length >= 3) { console.warn("kfp-storage: reboot loop prevented (" + reason + ")"); return false; }
    hist.push(now);
    try { sessionStorage.setItem("__kfp_reboots", JSON.stringify(hist)); } catch (_) {}
    location.reload();
    return true;
  }

  /* ---------- ข้อมูลเดิมในเครื่อง (ก่อนมีระบบสมาชิก) ---------- */
  var IGNORE_DEVICE = { "kfp_mode_v1": 1, "__kfp_deleted_keys_v1": 1, "__kfp_profile_cache_v1": 1, "contractMonths": 1 };
  function deviceKeys() {
    return realKeys().filter(function (k) { return k.indexOf(NS_DEVICE) === 0; }).map(function (k) { return k.slice(NS_DEVICE.length); });
  }
  function hasDeviceData() {
    return deviceKeys().some(function (k) {
      if (IGNORE_DEVICE[k]) return false;
      var v = real.getItem(NS_DEVICE + k);
      return v !== null && v !== "" && v !== "[]" && v !== "{}" && v !== "0";
    });
  }
  function deviceSummary() {
    var s = {};
    deviceKeys().forEach(function (k) {
      var v = real.getItem(NS_DEVICE + k);
      try { var j = JSON.parse(v); if (Array.isArray(j)) s[k] = j.length; } catch (_) {}
    });
    return s;
  }
  function importDeviceData() {
    if (MODE !== "member") return false;
    var backup = {};
    realKeys().forEach(function (k) { if (k.indexOf(PREFIX) === 0 && k.indexOf(PREFIX + "__kfp_sys_") !== 0 && k !== PREFIX + "__kfp_cloud_seen_v1") backup[k.slice(PREFIX.length)] = real.getItem(k); });
    real.setItem(PREFIX + "__kfp_sys_before_import", JSON.stringify({ at: new Date().toISOString(), data: backup }));
    deviceKeys().forEach(function (k) {
      if (k !== "__kfp_profile_cache_v1") real.setItem(PREFIX + k, real.getItem(NS_DEVICE + k));
      real.removeItem(NS_DEVICE + k);
    });
    return true;
  }
  function discardDeviceData() {
    deviceKeys().forEach(function (k) { real.removeItem(NS_DEVICE + k); });
    return true;
  }

  // Phase 12: "log out and remove from this device" — every key of one account namespace
  function wipeUser(uid) {
    if (!uid) return 0;
    var pre = NS_USER + uid + ":", n = 0;
    realKeys().forEach(function (k) { if (k.indexOf(pre) === 0) { real.removeItem(k); n++; } });
    return n;
  }

  window.kfpStorage = Object.freeze({
    mode: MODE,
    userId: sess ? sess.id : null,
    isPreview: function () { return MODE === "preview"; },
    isMember: function () { return MODE === "member"; },
    isShared: isShared,
    isInternal: isInternal,
    isPersonalBare: isPersonalBare,
    userPrefix: function (uid) { return NS_USER + uid + ":"; },
    migratedKeys: migrated,
    reboot: reboot,
    hasDeviceData: hasDeviceData,
    deviceSummary: deviceSummary,
    importDeviceData: importDeviceData,
    discardDeviceData: discardDeviceData,
    wipeUser: wipeUser
  });
})();
