/* Korea Finance Planner · Gold Cloud Sync (Phase 9)
 *
 * The gold portfolio lives in the Premium-only table user_gold_data. The server
 * checks the plan on every read/write (get_my_gold / save_my_gold); this file
 * only keeps the device copy (localStorage, per account via kfp-storage.js) in
 * step with it:
 *   • on open: pull → apply newer Cloud data, or push local edits, or ask when both changed
 *   • on every change in gold.js: debounced push with the version this device last saw
 *     (the server refuses a stale version → "conflict" → the member chooses, nothing is lost)
 *   • offline / errors: data stays on the device and is pushed later
 * Preview mode and members without "gold_portfolio" never sync.
 */
(function () {
  "use strict";
  if (window.kfpGoldSync) return;
  var KS = window.kfpStorage;
  var LOTS = "kfp_gold_lots_v1", SET = "kfp_gold_settings_v1";
  var META = "__kfp_gold_sync_v1";              // {v: server version, h: hash} — per account (namespaced)
  var BACKUP = "__kfp_gold_backup_v1";          // copy kept before anything is replaced
  // Auto-fetched GOLD2go prices are market data refreshed on every device — not synced
  // (unless the member typed the price by hand: gold2goPriceMode = "manual").
  var VOLATILE = ["gold2goBuyBaht", "gold2goReceiveBaht", "gold2goSellBaht", "gold2goUpdatedAt", "gold2goPriceSource"];
  var DEBOUNCE_MS = 1200, PULL_EVERY_MS = 30000;

  var S = { active: false, phase: "idle", meta: null, timer: null, retry: null, inflight: false, again: false,
            applying: false, conflict: null, lastPull: 0, retries: 0 };

  /* ----------------------------------------------------------- helpers */
  function enabled() { return !!(KS && KS.isMember && KS.isMember() && !KS.isPreview()); }
  function client() { return window.kfpAuth && window.kfpAuth.client && window.kfpAuth.client(); }
  function parse(raw, fallback) { try { var x = JSON.parse(raw); return x == null ? fallback : x; } catch (_) { return fallback; } }
  function canon(x) {                             // key-order independent JSON (Postgres jsonb re-orders keys)
    if (Array.isArray(x)) return "[" + x.map(canon).join(",") + "]";
    if (x && typeof x === "object") return "{" + Object.keys(x).sort().filter(function (k) { return x[k] !== undefined; })
      .map(function (k) { return JSON.stringify(k) + ":" + canon(x[k]); }).join(",") + "}";
    return JSON.stringify(x === undefined ? null : x);
  }
  function hash(str) { var h = 5381; for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + "." + str.length; }
  function syncSettings(s) {
    var out = {}; Object.keys(s || {}).forEach(function (k) { out[k] = s[k]; });
    if (out.gold2goPriceMode !== "manual") VOLATILE.forEach(function (k) { delete out[k]; });
    return out;
  }
  function readLocal() {
    var lots = parse(localStorage.getItem(LOTS), []), settings = parse(localStorage.getItem(SET), {});
    return { lots: Array.isArray(lots) ? lots : [], settings: settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {} };
  }
  function digest(d) { return hash(canon({ lots: d.lots || [], settings: syncSettings(d.settings || {}) })); }
  function isEmpty(d) { return !(d.lots || []).length && !Object.keys(syncSettings(d.settings || {})).length; }
  function readMeta() { var m = parse(localStorage.getItem(META), null); return m && typeof m.v === "number" ? m : null; }
  function writeMeta(v, h) { S.meta = { v: v, h: h }; try { localStorage.setItem(META, JSON.stringify(S.meta)); } catch (_) {} }
  function backup(d, from) {
    try { localStorage.setItem(BACKUP, JSON.stringify({ at: new Date().toISOString(), from: from, lots: d.lots, settings: d.settings })); } catch (_) {}
  }
  function day(iso) { try { return new Date(iso).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" }); } catch (_) { return ""; } }
  function errKind(e) {
    var m = String((e && (e.message || e.msg)) || ""), c = String((e && e.code) || "");
    if (/premium_required/.test(m) || c === "42501") return "locked";
    if (/rate_limited/.test(m) || c === "54000") return "rate";
    if (c === "22023") return "invalid";
    return "network";
  }

  /* ----------------------------------------------------------- status UI */
  var LABEL = {
    loading: ["⏳", "กำลังซิงก์พอร์ตทอง…"], saving: ["⏳", "กำลังบันทึกขึ้น Cloud…"], synced: ["☁️", "ซิงก์กับ Cloud แล้ว"],
    pending: ["📴", "ออฟไลน์ · บันทึกไว้ในเครื่อง จะส่งขึ้น Cloud อัตโนมัติ"], conflict: ["⚠️", "ข้อมูลไม่ตรงกัน · เลือกชุดที่จะใช้"],
    locked: ["🔒", "ซิงก์ทองต้องใช้ Finance Premium"], error: ["⚠️", "บันทึกขึ้น Cloud ไม่สำเร็จ · ข้อมูลยังอยู่ในเครื่อง"]
  };
  function chip() {
    var el = document.getElementById("kfpGoldSync");
    if (el) return el;
    var host = document.querySelector(".gold-hero .hero-top") || document.querySelector(".gold-container");
    if (!host) return null;
    el = document.createElement("span");
    el.id = "kfpGoldSync"; el.className = "kfp-gsync"; el.setAttribute("role", "status"); el.setAttribute("aria-live", "polite");
    host.appendChild(el);
    return el;
  }
  function setPhase(p, detail) {
    S.phase = p;
    var el = chip(); if (!el) return;
    var l = LABEL[p];
    if (!l) { el.hidden = true; return; }
    el.hidden = false; el.setAttribute("data-phase", p);
    el.innerHTML = '<i aria-hidden="true">' + l[0] + '</i><span></span>';
    el.lastChild.textContent = detail || l[1];
    try { window.dispatchEvent(new CustomEvent("kfp:gold-sync", { detail: { phase: p } })); } catch (_) {}
  }

  /* ----------------------------------------------------------- server */
  async function rpc(fn, args) {
    var c = client(); if (!c) throw { message: "no client" };
    var r = await c.rpc(fn, args || {});
    if (r.error) throw r.error;
    return r.data;
  }

  function refreshPage() {
    try { if (typeof window.__kfpRefreshGoldFromCloud === "function") window.__kfpRefreshGoldFromCloud(); } catch (_) {}
  }
  function apply(server, why) {
    var local = readLocal();
    if (!isEmpty(local) && digest(local) !== digest(server)) backup(local, "device");
    var settings = {}, keepVolatile = (server.settings || {}).gold2goPriceMode !== "manual";
    if (keepVolatile) VOLATILE.forEach(function (k) { if (local.settings[k] !== undefined) settings[k] = local.settings[k]; });
    Object.keys(server.settings || {}).forEach(function (k) { settings[k] = server.settings[k]; });
    S.applying = true;
    try {
      localStorage.setItem(LOTS, JSON.stringify(server.lots || []));
      localStorage.setItem(SET, JSON.stringify(settings));
    } finally { S.applying = false; }
    writeMeta(Number(server.version) || 0, digest({ lots: server.lots || [], settings: settings }));
    refreshPage();
    setPhase("synced", why || "อัปเดตพอร์ตทองจาก Cloud แล้ว");
  }

  async function pull() {
    if (!S.active || S.inflight || S.conflict) return;
    S.lastPull = Date.now();
    if (S.phase === "idle") setPhase("loading");
    var r;
    try { r = await rpc("get_my_gold"); }
    catch (e) { var k = errKind(e); if (k === "locked") return lock(null, true); setPhase("pending", "ออฟไลน์ · ใช้ข้อมูลทองในเครื่องนี้"); return; }
    if (!r || !r.allowed) return lock(r, true);
    S.meta = readMeta();
    var local = readLocal(), lh = digest(local), sh = digest(r), m = S.meta;
    if (!r.exists && Number(r.version) === 0) {                    // nothing on the server yet
      if (isEmpty(local)) { writeMeta(0, lh); setPhase("synced"); }
      else push(0);                                                // first upload from this device
      return;
    }
    if (sh === lh) { writeMeta(Number(r.version), sh); setPhase("synced"); return; }
    if (m && m.v === Number(r.version)) { push(m.v); return; }      // only this device changed
    if ((m && m.h === lh) || isEmpty(local)) { apply(r); return; }  // only the server changed
    showConflict(r, local);                                        // both changed (or unknown history)
  }

  function schedule() {
    clearTimeout(S.timer);
    S.timer = setTimeout(function () { S.timer = null; push(S.meta ? S.meta.v : 0); }, DEBOUNCE_MS);
  }
  async function push(base) {
    if (!S.active || S.conflict) return;
    if (S.inflight) { S.again = true; return; }
    var local = readLocal(), sent = digest(local), settings = syncSettings(local.settings);
    if (S.meta && S.meta.h === sent && base === S.meta.v) { setPhase("synced"); return; }
    S.inflight = true; setPhase("saving");
    var r;
    try { r = await rpc("save_my_gold", { p_lots: local.lots, p_settings: settings, p_base_version: base }); }
    catch (e) {
      S.inflight = false;
      var k = errKind(e);
      if (k === "locked") return lock(null, true);
      if (k === "invalid") { setPhase("error", "ข้อมูลทองบางรายการไม่ถูกต้อง · บันทึกไว้ในเครื่องเท่านั้น"); return; }
      setPhase(k === "rate" ? "error" : "pending");
      clearTimeout(S.retry);
      S.retries = Math.min(S.retries + 1, 6);
      S.retry = setTimeout(function () { push(S.meta ? S.meta.v : base); }, 5000 * Math.pow(2, S.retries - 1));
      return;
    }
    S.inflight = false; S.retries = 0; clearTimeout(S.retry);
    if (r && r.ok) {
      writeMeta(Number(r.version), sent);
      if (S.again || digest(readLocal()) !== sent) { S.again = false; schedule(); setPhase("saving"); }
      else setPhase("synced");
      return;
    }
    if (r && r.error === "conflict") { S.again = false; showConflict(r, readLocal()); return; }
    setPhase("error");
  }

  // serverDenied: the page thought the member had Premium but the server said no
  // (plan just expired / changed) → re-read entitlements so kfp-access.js shows the upgrade screen.
  function lock(r, serverDenied) {
    S.active = false; clearTimeout(S.timer); clearTimeout(S.retry);
    var n = r && Number(r.stored_lots), card = document.querySelector("#kfpGoldUpsell .kfp-up-card");
    if (card && n > 0) {
      var p = document.getElementById("kfpUpStored");
      if (!p) { p = document.createElement("p"); p.id = "kfpUpStored"; p.className = "kfp-up-cur"; card.appendChild(p); }
      p.textContent = "☁️ พอร์ตทองของคุณ " + n + " รอบยังเก็บไว้บน Cloud ครบ · จะกลับมาทันทีเมื่อใช้ Finance Premium";
    }
    if (serverDenied) { setPhase("locked"); if (window.kfpPlan) window.kfpPlan.refresh(); }
  }

  /* ----------------------------------------------------------- conflict */
  function showConflict(server, local) {
    S.conflict = { server: server, local: local };
    clearTimeout(S.timer);
    setPhase("conflict");
    var box = document.getElementById("kfpGoldConflict");
    if (!box) {
      box = document.createElement("section");
      box.id = "kfpGoldConflict"; box.className = "kfp-gconflict"; box.setAttribute("role", "alert");
      var hero = document.querySelector(".gold-hero");
      if (hero) hero.insertAdjacentElement("afterend", box); else (document.querySelector(".gold-container") || document.body).prepend(box);
    }
    box.innerHTML =
      '<h2>☁️ ข้อมูลพอร์ตทองไม่ตรงกัน</h2>' +
      '<p>มีการแก้ไขพอร์ตทองจากอุปกรณ์อื่น และเครื่องนี้ก็มีข้อมูลที่ต่างออกไป · เลือกชุดที่จะใช้ต่อ (อีกชุดจะสำรองไว้ในเครื่องนี้)</p>' +
      '<div class="kfp-gc-opts">' +
      '<div class="kfp-gc-opt"><b>☁️ Cloud</b><span id="kfpGcCloud"></span></div>' +
      '<div class="kfp-gc-opt"><b>📱 เครื่องนี้</b><span id="kfpGcLocal"></span></div></div>' +
      '<div class="kfp-gc-row"><button type="button" class="kfp-gc-btn gold" data-gold-choice="cloud">ใช้ข้อมูลจาก Cloud</button>' +
      '<button type="button" class="kfp-gc-btn" data-gold-choice="device">ใช้ข้อมูลเครื่องนี้</button></div>';
    document.getElementById("kfpGcCloud").textContent = (server.lots || []).length + " รอบ" + (server.updated_at ? " · แก้ล่าสุด " + day(server.updated_at) : "");
    document.getElementById("kfpGcLocal").textContent = (local.lots || []).length + " รอบ";
    box.hidden = false;
    box.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  async function choose(which) {
    var c = S.conflict; if (!c) return;
    var box = document.getElementById("kfpGoldConflict");
    [].forEach.call(box.querySelectorAll("button"), function (b) { b.disabled = true; });
    S.conflict = null;
    if (which === "cloud") {
      apply(c.server, "ใช้ข้อมูลจาก Cloud แล้ว · ข้อมูลเดิมของเครื่องนี้สำรองไว้");
      box.hidden = true;
    } else {
      backup({ lots: c.server.lots || [], settings: c.server.settings || {} }, "cloud");
      await push(null);                                            // overwrite on purpose
      if (S.phase === "synced") { box.hidden = true; setPhase("synced", "บันทึกข้อมูลเครื่องนี้ขึ้น Cloud แล้ว · ข้อมูล Cloud เดิมสำรองไว้"); }
      else [].forEach.call(box.querySelectorAll("button"), function (b) { b.disabled = false; });
    }
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-gold-choice]");
    if (b && !b.disabled) choose(b.getAttribute("data-gold-choice"));
  });

  /* ----------------------------------------------------------- lifecycle */
  function start() {
    if (S.active || !enabled() || !document.querySelector(".gold-container")) return;
    S.active = true; S.meta = readMeta();
    pull();
  }
  window.addEventListener("kfp:plan", function (e) {
    var d = e.detail || {};
    if (!enabled() || (d.state !== "ready")) return;                // offline cache → no server calls
    var ok = !!(d.features && d.features.gold_portfolio === true);
    if (ok) start();
    else if (document.querySelector(".gold-container") && !S.infoAsked) {
      S.active = false; S.infoAsked = true;
      rpc("get_my_gold").then(function (r) { lock(r, false); }, function () {});   // only "N lots kept" — no content
    }
  });
  window.addEventListener("online", function () { if (S.active && S.phase === "pending") { S.retries = 0; push(S.meta ? S.meta.v : 0); } });
  document.addEventListener("visibilitychange", function () {
    if (!S.active) return;
    if (document.visibilityState === "hidden" && S.timer) { clearTimeout(S.timer); S.timer = null; push(S.meta ? S.meta.v : 0); }
    else if (document.visibilityState === "visible" && Date.now() - S.lastPull > PULL_EVERY_MS && !S.timer) pull();
  });

  window.kfpGoldSync = Object.freeze({
    // gold.js calls this after every saveLots / saveSettings / clear
    changed: function () {
      if (!S.active || S.applying || S.conflict) return;
      if (S.meta && S.meta.h === digest(readLocal())) return;      // e.g. only an auto price refresh
      setPhase("saving"); schedule();
    },
    status: function () { return S.phase; },
    pull: pull
  });
})();
