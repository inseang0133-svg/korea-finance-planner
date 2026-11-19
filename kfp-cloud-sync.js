/* kfp-cloud-sync.js — automatic, quiet Cloud Sync of the member snapshot (table user_data)
 *
 * For members whose plan has "cloud_sync" (Finance Plus and up). The server still decides:
 * writes are refused by RLS without the feature — this file only stops trying when that happens.
 *
 *   • a change on this device  → upload ~1.5 s later (no button, no reload)
 *   • open / come back to the tab / every minute while open → look for changes from other devices
 *   • other device changed, this one did not → apply, then redraw the page in place
 *     (no reload; charts drawn without animation; scroll position kept; redraw waits while typing
 *      or while a pop-up is open)
 *   • both changed → merged key by key against the last synced copy:
 *       lists (salary months, work days, deductions, expenses) item by item — nothing is lost,
 *       a deletion on one side is respected; the same item / setting changed on both → the newer edit wins;
 *       the version that lost is kept in __kfp_cloud_backup_v1
 *   • never uploads before the Cloud copy was read in this visit, never uploads an empty device
 *     over Cloud data unless the person deleted it here, never uploads in Preview or after logout
 *
 * Per account (namespaced by kfp-storage.js):
 *   __kfp_cloud_seen_v1  updated_at of the Cloud row this device last applied / uploaded (shared with auth.js)
 *   __kfp_cloud_sync_v1  { h: hash of that synced data }
 *   __kfp_cloud_base_v1  the synced data itself (base of the 3-way merge)
 *   __kfp_cloud_dirty_v1 { key: time of the last edit on this device not yet uploaded }
 */
(function () {
  "use strict";
  if (window.kfpCloudSync) return;
  var KS = window.kfpStorage, d = document;
  var SEEN = "__kfp_cloud_seen_v1", META = "__kfp_cloud_sync_v1", BASE = "__kfp_cloud_base_v1",
      DIRTY = "__kfp_cloud_dirty_v1", BACKUP = "__kfp_cloud_backup_v1";
  var DEBOUNCE = 1500, MAX_WAIT = 6000, PULL_EVERY = 60000, PULL_MIN_GAP = 8000;
  // lists merged item by item (field = identity of an item)
  var LIST_ID = { salaryRecords: "month", kfp_work_records_v1: "date", kfp_work_deductions_v1: "id", kfp_expenses_v1: "id" };
  // objects merged field by field (one level; kfp_tour_v1 two levels: its "tours" map)
  var OBJ_KEYS = { kfp_work_received_v1: 1, __kfp_deleted_keys_v1: 1, kfp_work_settings_v1: 1, kfp_tour_v1: 2 };
  // worked out by the page on every redraw (goal tracker) — uploaded with the rest, but never a reason to upload
  var VOLATILE = { currentSaving: 1 };

  var S = { ready: false, active: false, locked: false, inflight: false, again: false, timer: null, first: 0,
            retry: null, retries: 0, applying: false, lastPull: 0, refreshDue: false, lastAt: null, phase: "idle" };

  /* ------------------------------------------------------------------ basics */
  function member() { return !!(KS && KS.isMember && KS.isMember() && !KS.isPreview()); }
  function auth() { return window.kfpAuth || null; }
  function client() { var a = auth(); return a && a.client ? a.client() : null; }
  function user() { var a = auth(); return a && a.user ? a.user() : null; }
  function keys() { var a = auth(); return a && a.dataKeys ? a.dataKeys() : []; }
  function canSync() {
    var p = window.kfpPlan;
    if (!p || !p.canUseFeature) return false;
    var st = d.documentElement.getAttribute("data-plan-state");
    return (st === "ready" || st === "cached") && !!p.canUseFeature("cloud_sync");
  }
  function jget(k, fb) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? fb : v; } catch (_) { return fb; } }
  function jset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  function readLocal() { var o = {}; keys().forEach(function (k) { var v = localStorage.getItem(k); if (v !== null) o[k] = v; }); return o; }
  function canon(o) { return Object.keys(o || {}).filter(function (k) { return !VOLATILE[k]; }).sort().map(function (k) { return JSON.stringify(k) + ":" + JSON.stringify(String(o[k])); }).join(","); }
  function hash(o) { var s = canon(o), h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + "." + s.length; }
  function empty(o) {
    return !Object.keys(o || {}).some(function (k) {
      if (k === "kfp_mode_v1" || k === "kfp_tour_v1" || k === "__kfp_deleted_keys_v1") return false;
      var v = o[k]; return v !== "" && v !== "[]" && v !== "{}" && v !== "0" && v != null;
    });
  }
  function cloudObj(row) {
    var c = row && row.data && typeof row.data === "object" && !Array.isArray(row.data) ? row.data : {}, out = {};
    keys().forEach(function (k) { if (c[k] !== undefined && c[k] !== null) out[k] = String(c[k]); });
    return out;
  }
  function stamp(iso) { var t = Date.parse(iso || ""); return isFinite(t) ? t : 0; }
  function timeTxt(iso) { try { return new Date(iso).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }); } catch (_) { return ""; } }

  /* ------------------------------------------------------------------ status (auth panel only — no pop-ups) */
  function setPhase(p, note) {
    S.phase = p;
    var el = d.getElementById("kfpCloudLast"); if (!el) return;
    var txt = { idle: "ซิงก์อัตโนมัติเมื่อข้อมูลเปลี่ยน", saving: "กำลังซิงก์…", synced: "ซิงก์แล้ว" + (S.lastAt ? " · " + timeTxt(S.lastAt) : ""),
                pending: "ออฟไลน์ · จะซิงก์ให้เองเมื่อกลับมาออนไลน์", locked: "Cloud Sync ไม่อยู่ในแพ็กเกจปัจจุบัน · ข้อมูลอยู่ในเครื่องนี้",
                error: "ซิงก์ไม่สำเร็จ · จะลองใหม่อัตโนมัติ" }[p] || "";
    el.textContent = note || txt;
    el.setAttribute("data-phase", p);
  }

  /* ------------------------------------------------------------------ merge */
  function parse(s) { try { return JSON.parse(s); } catch (_) { return undefined; } }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  // newer edit wins when both sides changed the same thing
  function localNewer(key, cloudAt) { var t = (jget(DIRTY, {}) || {})[key]; return !!t && t > stamp(cloudAt); }
  function mergeList(b, l, c, idf, localWins) {
    var id = function (x) { return x && typeof x === "object" ? String(x[idf]) : JSON.stringify(x); };
    var B = {}, L = {}, C = {}, order = [];
    (b || []).forEach(function (x) { B[id(x)] = x; });
    (l || []).forEach(function (x) { var k = id(x); if (!(k in L)) order.push(k); L[k] = x; });
    (c || []).forEach(function (x) { var k = id(x); if (!(k in L) && !(k in C)) order.push(k); C[k] = x; });
    var out = [];
    order.forEach(function (k) {
      var hb = k in B, hl = k in L, hc = k in C;
      if (hl && hc) {
        if (same(L[k], C[k])) out.push(L[k]);
        else if (hb && same(L[k], B[k])) out.push(C[k]);
        else if (hb && same(C[k], B[k])) out.push(L[k]);
        else out.push(localWins ? L[k] : C[k]);
      } else if (hl) { if (!(hb && same(L[k], B[k]))) out.push(L[k]); }          // removed on the other device?
      else if (hc) { if (!(hb && same(C[k], B[k]))) out.push(C[k]); }          // removed on this device?
    });
    return out;
  }
  function mergeObj(b, l, c, localWins, depth) {
    b = b && typeof b === "object" && !Array.isArray(b) ? b : {};
    var out = {}, seen = {};
    [l, c].forEach(function (o) { Object.keys(o).forEach(function (k) { seen[k] = 1; }); });
    Object.keys(b).forEach(function (k) { seen[k] = 1; });
    Object.keys(seen).forEach(function (k) {
      var hl = k in l, hc = k in c, hb = k in b, v;
      if (hl && hc && depth > 1 && l[k] && c[k] && typeof l[k] === "object" && typeof c[k] === "object" && !Array.isArray(l[k]) && !Array.isArray(c[k])) {
        out[k] = mergeObj(b[k], l[k], c[k], localWins, depth - 1); return;
      }
      if (hl && hc) v = same(l[k], c[k]) ? l[k] : hb && same(l[k], b[k]) ? c[k] : hb && same(c[k], b[k]) ? l[k] : (localWins ? l[k] : c[k]);
      else if (hl) { if (hb && same(l[k], b[k])) return; v = l[k]; }
      else if (hc) { if (hb && same(c[k], b[k])) return; v = c[k]; }
      else return;
      out[k] = v;
    });
    return out;
  }
  // three-way merge of the whole snapshot; returns { data, lost } (lost = the overwritten values)
  function merge(base, local, cloud, cloudAt) {
    var out = {}, lost = {}, all = {};
    [base, local, cloud].forEach(function (o) { Object.keys(o).forEach(function (k) { all[k] = 1; }); });
    Object.keys(all).forEach(function (k) {
      var b = base[k], l = local[k], c = cloud[k];
      if (VOLATILE[k]) { if (l !== undefined) out[k] = l; else if (c !== undefined) out[k] = c; return; }
      if (l === c) { if (l !== undefined) out[k] = l; return; }
      if (l === b) { if (c !== undefined) out[k] = c; return; }       // only the Cloud changed
      if (c === b) { if (l !== undefined) out[k] = l; return; }       // only this device changed
      var lw = localNewer(k, cloudAt);
      var pl = parse(l), pc = parse(c), pb = b === undefined ? undefined : parse(b);
      if (LIST_ID[k] && Array.isArray(pl) && Array.isArray(pc)) {
        out[k] = JSON.stringify(mergeList(Array.isArray(pb) ? pb : [], pl, pc, LIST_ID[k], lw));
      } else if (OBJ_KEYS[k] && pl && pc && typeof pl === "object" && typeof pc === "object" && !Array.isArray(pl) && !Array.isArray(pc)) {
        out[k] = JSON.stringify(mergeObj(pb, pl, pc, lw, OBJ_KEYS[k]));
      } else if (l === undefined || c === undefined) {
        // deleted on one side, edited on the other → keep the edit
        out[k] = l === undefined ? c : l;
      } else {
        out[k] = lw ? l : c;
      }
      lost[k] = { device: l, cloud: c };
    });
    return { data: out, lost: lost };
  }

  /* ------------------------------------------------------------------ applying to this device */
  function busy() {
    var a = d.activeElement;
    if (a && a !== d.body && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) && !a.closest("#kfpAuthRoot")) return true;
    return !!d.querySelector(".tl-modal.open, .kfp-modal.open, html.kt-on");
  }
  function write(data) {
    var changed = [], local = readLocal();
    S.applying = true;
    try {
      keys().forEach(function (k) {
        var v = data[k];
        if (v === undefined) { if (local[k] !== undefined) { localStorage.removeItem(k); changed.push(k); } }
        else if (local[k] !== v) { localStorage.setItem(k, v); changed.push(k); }
      });
    } finally { S.applying = false; }
    return changed;
  }
  function remember(data, at) {
    jset(BASE, data); jset(META, { h: hash(data) });
    if (at) { try { localStorage.setItem(SEEN, at); } catch (_) {} S.lastAt = at; }
  }
  // redraw the current page in place — no reload, no chart animation, same scroll position
  function refreshPage() {
    if (busy()) { S.refreshDue = true; return; }
    S.refreshDue = false;
    var y = window.scrollY, C = window.Chart, prev;
    if (C && C.defaults) { prev = C.defaults.animation; C.defaults.animation = false; }
    S.redrawing = true;                                   // values the page re-derives while redrawing are not edits
    try {
      if (typeof window.kfpApplyMode === "function") window.kfpApplyMode();
      if (typeof window.__kfpRefreshFromCloud === "function") window.__kfpRefreshFromCloud();
      window.dispatchEvent(new CustomEvent("kfp:cloud-synced"));
    } catch (e) { console.warn("KFP cloud refresh:", e); }
    finally { S.redrawing = false; if (C && C.defaults) C.defaults.animation = prev; }
    if (Math.abs(window.scrollY - y) > 1) window.scrollTo({ top: y, behavior: "instant" });
  }
  setInterval(function () { if (S.refreshDue && !busy()) refreshPage(); }, 1200);

  /* ------------------------------------------------------------------ reconcile with a Cloud row */
  // called by auth.js on every page open (row already fetched) and by pull()
  function reconcile(row, why) {
    if (!member()) return { action: "none" };
    var local = readLocal(), cloud = cloudObj(row), at = row && row.updated_at || null;
    var meta = jget(META, null), base = jget(BASE, null), seen = localStorage.getItem(SEEN);
    var dirty = meta && meta.h ? hash(local) !== meta.h : null;            // null = unknown (older version of the app)
    var res = { action: "none" };
    S.ready = true;

    if (canSync()) activate();
    if (!row || !Object.keys(cloud).length) {
      // nothing on the Cloud (yet / any more) → this device's data becomes the Cloud copy
      S.applying = true;
      try { localStorage.removeItem(SEEN); localStorage.removeItem(META); localStorage.removeItem(BASE); } finally { S.applying = false; }
      if (!empty(local)) schedule(true);
      res.action = "first";
    } else if (seen && at === seen) {
      S.lastAt = at;
      if (dirty === false) res.action = "same";
      else { if (!meta) remember(base || cloud, at); schedule(true); res.action = "push"; }
    } else if (dirty === false || empty(local) || !base) {
      // only the Cloud changed (or first time on this device): take it — keep a copy of what was here
      if (!empty(local) && hash(local) !== hash(cloud)) jset(BACKUP, { at: new Date().toISOString(), why: "cloud", data: local });
      var ch = write(cloud);
      remember(cloud, at); jset(DIRTY, {});
      if (ch.length) refreshPage();
      res.action = ch.length ? "applied" : "same";
    } else {
      // both changed: merge, keep the losing values, upload the result
      var m = merge(base, local, cloud, at);
      if (Object.keys(m.lost).length) jset(BACKUP, { at: new Date().toISOString(), why: "merge", lost: m.lost });
      var ch2 = write(m.data);
      remember(cloud, at);                                               // base = Cloud; our merged edits are "dirty" on top
      if (ch2.length) refreshPage();
      if (hash(m.data) !== hash(cloud)) schedule(true);
      res.action = "merged";
    }
    setPhase(S.locked ? "locked" : (S.timer || S.inflight ? "saving" : "synced"));
    if (why) res.why = why;
    return res;
  }

  /* ------------------------------------------------------------------ upload */
  function schedule(soon) {
    if (!member() || S.locked) return;
    var now = Date.now();
    if (!S.first) S.first = now;
    clearTimeout(S.timer);
    var wait = soon ? 300 : Math.max(0, Math.min(DEBOUNCE, MAX_WAIT - (now - S.first)));
    S.timer = setTimeout(function () { S.timer = null; push(); }, wait);
    if (S.ready && canSync()) setPhase("saving");
  }
  async function push() {
    S.first = 0;
    if (!member() || S.locked || !S.ready || !user()) return false;
    if (!canSync()) { if (d.documentElement.getAttribute("data-plan-state") === "loading") S.again = true; return false; }
    if (S.inflight) { S.again = true; return false; }
    var c = client(); if (!c) return false;
    var local = readLocal(), h = hash(local), meta = jget(META, null);
    if (meta && meta.h === h && localStorage.getItem(SEEN)) { setPhase("synced"); return true; }
    S.inflight = true; setPhase("saving");
    try {
      // 1) has another device written since we last looked? → merge first (no lost edits)
      var head = await c.from("user_data").select("updated_at").eq("user_id", user().id).maybeSingle();
      if (head.error) throw head.error;
      var row = head.data, seen = localStorage.getItem(SEEN);
      if (row && row.updated_at && row.updated_at !== seen) {
        var full = await c.from("user_data").select("user_id,data,updated_at").eq("user_id", user().id).maybeSingle();
        if (full.error) throw full.error;
        row = full.data;
        S.inflight = false;
        reconcile(row, "push");
        local = readLocal(); h = hash(local);
        if (jget(META, {}).h === h) { setPhase("synced"); return true; }
        S.inflight = true;
      }
      // 2) never wipe the Cloud with an empty device unless the person deleted things here
      var cloudHas = row && row.data ? !empty(cloudObj(row)) : !empty(jget(BASE, {}) || {});
      if (row && empty(local) && cloudHas && !Object.keys(jget(DIRTY, {}) || {}).length) { S.inflight = false; setPhase("synced"); return false; }
      var r = await c.from("user_data").upsert({ user_id: user().id, data: local, updated_at: new Date().toISOString() }, { onConflict: "user_id" })
        .select("updated_at").maybeSingle();
      if (r.error) throw r.error;
      var at = r.data && r.data.updated_at || new Date().toISOString();
      remember(local, at);
      if (hash(readLocal()) === h) jset(DIRTY, {});
      S.inflight = false; S.retries = 0; clearTimeout(S.retry);
      setPhase("synced");
      if (S.again || hash(readLocal()) !== h) { S.again = false; schedule(); }
      return true;
    } catch (e) {
      S.inflight = false;
      var msg = String((e && (e.message || e.code)) || "");
      if (/row-level security|42501|permission denied/i.test(msg)) {          // plan does not include Cloud Sync (any more)
        S.locked = true; setPhase("locked");
        try { if (window.kfpPlan && window.kfpPlan.refresh) window.kfpPlan.refresh(); } catch (_) {}
        return false;
      }
      setPhase(navigator.onLine === false ? "pending" : "error");
      clearTimeout(S.retry);
      S.retries = Math.min(S.retries + 1, 6);
      S.retry = setTimeout(push, 4000 * Math.pow(2, S.retries - 1));
      return false;
    }
  }

  /* ------------------------------------------------------------------ download (other devices) */
  async function pull(force) {
    if (!member() || !S.ready || S.inflight || !user() || !canSync() && !force) return;
    if (!force && Date.now() - S.lastPull < PULL_MIN_GAP) return;
    S.lastPull = Date.now();
    var c = client(); if (!c) return;
    try {
      var head = await c.from("user_data").select("updated_at").eq("user_id", user().id).maybeSingle();
      if (head.error || !head.data || !head.data.updated_at) return;
      if (head.data.updated_at === localStorage.getItem(SEEN)) {
        if (jget(META, {}).h !== hash(readLocal())) schedule();
        return;
      }
      var full = await c.from("user_data").select("user_id,data,updated_at").eq("user_id", user().id).maybeSingle();
      if (full.error || !full.data) return;
      if (S.inflight) return;
      reconcile(full.data, "pull");
    } catch (_) { /* offline: try again next time */ }
  }

  /* ------------------------------------------------------------------ watching this device */
  function onLocalChange(k) {
    if (S.applying || S.redrawing || !member() || k == null || VOLATILE[k] || keys().indexOf(k) < 0) return;
    var base = jget(BASE, {}) || {}, v = localStorage.getItem(k), dt = jget(DIRTY, {}) || {};
    var now = (v === null ? undefined : v);
    if (now === base[k]) delete dt[k]; else dt[k] = Date.now();
    S.applying = true; try { jset(DIRTY, dt); } finally { S.applying = false; }
    if (S.ready) schedule();
  }
  if (KS && KS.onChange) KS.onChange(onLocalChange);

  function flush(ms) {
    if (!S.timer && !S.again && jget(META, {}).h === hash(readLocal())) return Promise.resolve(true);
    clearTimeout(S.timer); S.timer = null;
    return Promise.race([push(), new Promise(function (r) { setTimeout(function () { r(false); }, ms || 4000); })]);
  }

  /* ------------------------------------------------------------------ lifecycle */
  var pullTimer = null;
  // the page-open read in auth.js failed (offline / slow): read the Cloud copy ourselves before any upload
  async function bootstrap() {
    if (S.ready || !member() || !user()) return;
    var c = client(); if (!c) return;
    try {
      var r = await c.from("user_data").select("user_id,data,updated_at").eq("user_id", user().id).maybeSingle();
      if (!r.error && !S.ready) reconcile(r.data || null, "bootstrap");
    } catch (_) {}
  }
  function activate() {
    if (S.active || !member()) return;
    S.active = true;
    if (!S.ready) setTimeout(bootstrap, 2500);
    pullTimer = setInterval(function () { if (d.visibilityState === "visible") pull(); }, PULL_EVERY);
    if (S.again || (jget(META, {}).h && jget(META, {}).h !== hash(readLocal()))) { S.again = false; schedule(true); }
    setPhase("synced");
  }
  function checkPlan() { if (member() && canSync()) activate(); }
  if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", checkPlan); else checkPlan();
  window.addEventListener("kfp:plan", function (e) {
    var dt = e.detail || {};
    if (!member() || (dt.state !== "ready" && dt.state !== "cached")) return;
    if (dt.features && dt.features.cloud_sync === true) { S.locked = false; activate(); }
    else if (dt.state === "ready") { S.locked = true; setPhase("locked"); }
  });
  d.addEventListener("visibilitychange", function () {
    if (!S.active) return;
    if (d.visibilityState === "hidden") { if (S.timer) { clearTimeout(S.timer); S.timer = null; push(); } }
    else pull();
  });
  window.addEventListener("focus", function () { if (S.active) pull(); });
  window.addEventListener("online", function () { if (!S.active) return; if (!S.ready) return bootstrap(); S.retries = 0; push(); pull(true); });
  window.addEventListener("pagehide", function () { if (S.active && S.timer) { clearTimeout(S.timer); S.timer = null; push(); } });

  window.kfpCloudSync = Object.freeze({
    reconcile: reconcile,
    syncNow: function () { S.locked = false; return push().then(function (ok) { return pull(true).then(function () { return ok; }); }); },
    flush: flush,
    pull: function () { return pull(true); },
    status: function () { return { phase: S.phase, active: S.active, locked: S.locked, lastAt: S.lastAt, dirty: Object.keys(jget(DIRTY, {}) || {}) }; },
    _merge: merge
  });
})();
