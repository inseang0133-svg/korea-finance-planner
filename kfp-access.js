/*
  kfp-access.js — Preview Mode UI (Phase 3) + Global Login Gate (Phase 4) + Plan Visibility (Phase 5)

  PLAN VISIBILITY (Phase 5)
  • สิทธิ์มาจาก RPC get_my_entitlements() ในฐานข้อมูลเท่านั้น (คำนวณจาก subscription / grant ฝั่ง server)
  • canUseFeature(key) · renderFeaturesByPlan(ent) · applyPlanVisibility() = จุดควบคุมกลาง
  • element ใส่ data-feature="gold_portfolio" → ไม่มีสิทธิ์ = ไม่แสดงเลย (display:none ผ่าน CSS ไม่ใช่ล็อก)
    element ใส่ data-feature-off="cloud_sync" → แสดงเฉพาะตอน "ไม่มี" สิทธิ์ (เช่น ข้อความชวนอัปเกรด)
  • ระหว่างรอผลจาก server ซ่อนทุก data-feature ไว้ก่อน · Preview (ยังไม่ Login) เห็นครบทุกฟีเจอร์ด้วยข้อมูล Demo
  • การซ่อน UI ไม่ใช่ความปลอดภัย: Cloud Sync / ข้อมูลทอง ถูกบังคับด้วย RLS ใน migration 0400

  LOGIN GATE
  • requireAuth(action, options) → true ถ้าเป็นสมาชิก (ยืนยันอีเมลแล้ว) ไม่งั้นเปิด Modal
    "กรุณาเข้าสู่ระบบหรือสมัครสมาชิกเพื่อใช้งานฟีเจอร์นี้" (ปุ่ม Login / Create Account) แล้วคืน false
  • ดักแบบ capture-phase ที่ระดับ document (click / submit / change) ตามตาราง GATES ด้านล่าง
    → handler เดิมของปุ่ม (onclick, addEventListener) ไม่ถูกเรียกเลยถ้ายังไม่ Login
  • โค้ดใหม่ใส่ data-requires-auth="ชื่อการกระทำ" ที่ปุ่มได้เลย ไม่ต้องแก้ไฟล์นี้
  • ปุ่มที่แค่ดู/เลื่อน/เปิดเมนู/คิดเลขโดยไม่เปลี่ยนข้อมูล ไม่ถูกดัก (ดูตาราง OPEN ด้านล่าง)

  • ผู้เข้าชม (Preview): ป้าย PREVIEW MODE มุมจอ + แถบ "DEMO DATA — ตัวอย่างการใช้งาน" บนสุดของหน้า
    พร้อมปุ่มสมัคร/เข้าสู่ระบบ · popup ทุกอันมีป้าย DEMO (ผ่าน CSS)
  • สมาชิก: ไม่แสดงอะไร
*/
(function () {
  "use strict";
  if (window.__kfpAccessUI) return;
  window.__kfpAccessUI = true;

  var KS = window.kfpStorage;
  var isPreview = function () { return !KS || KS.isPreview(); };

  function openAuth(view) {
    if (window.kfpAuth && typeof window.kfpAuth.open === "function") window.kfpAuth.open(view);
    else { var b = document.getElementById("kfpAuthButton"); if (b) b.click(); }
  }

  /* =========================================================
     LOGIN GATE (Phase 4)
     ========================================================= */
  var GATE_MESSAGE = "กรุณาเข้าสู่ระบบหรือสมัครสมาชิกเพื่อใช้งานฟีเจอร์นี้";

  // [selector, ชื่อการกระทำที่แสดงใน Modal]  — ตรวจตามลำดับ ตัวแรกที่ตรงชนะ
  var GATES = [
    ["[data-requires-auth]", null],
    /* index.html — เงินเดือน / สัญญา / Export */
    ['[onclick^="calculate("]', "คำนวณเงินเดือน"],
    ['[onclick^="saveThisMonthSalary("]', "บันทึกเงินเดือนเดือนนี้"],
    ['[onclick^="addSalaryRecord("]', "เพิ่มประวัติเงินเดือน"],
    ['[onclick^="deleteSalaryRecord("]', "ลบประวัติเงินเดือน"],
    ['[onclick^="exportExcel("]', "Export Excel"],
    ['[onclick^="saveContract("]', "บันทึกสัญญาจ้าง"],
    ['[onclick^="setContractDuration("]', "ตั้งระยะสัญญาจ้าง"],
    ['[onclick^="deleteContract("]', "ลบสัญญาจ้าง"],
    ["#allocSave", "บันทึกการแบ่งเงินเดือน"],
    /* tools-ui.js — บันทึกการเข้างาน / รายจ่าย */
    ['[data-act="m-today"]', "บันทึกเข้างานวันนี้"],
    ['[data-act="m-past"]', "บันทึกเข้างานย้อนหลัง"],
    ['[data-act="w-edit"]', "แก้ไขบันทึกการทำงาน"],
    ['[data-act="w-save"]', "บันทึกการทำงาน"],
    ['[data-act="w-del"],[data-act="w-del-yes"]', "ลบบันทึกการทำงาน"],
    ['[data-act="ded-add"]', "เพิ่มรายการหัก"],
    ['[data-act="ded-del"]', "ลบรายการหัก"],
    ['[data-act="rcv-save"]', "บันทึกเงินเดือนที่เข้าบัญชีจริง"],
    ['[data-act="set-save"],[data-act="set-reset"]', "บันทึกการตั้งค่าการทำงาน"],
    ['[data-act="ex-save"]', "บันทึกรายจ่าย"],
    ['[data-act="ex-edit"]', "แก้ไขรายจ่าย"],
    ['[data-act="ex-del"],[data-act="ex-del-yes"]', "ลบรายจ่าย"],
    /* gold.html — พอร์ตทอง */
    ['#lotForm button[type="submit"]', "บันทึกการซื้อทอง"],
    [".delete-lot", "ลบรอบซื้อทอง"],
    ["#clearGoldBtn", "ลบข้อมูลทองทั้งหมด"],
    ["#exportGoldBtn", "Export ข้อมูลทอง"],
    ["#importGoldBtn", "กู้คืนข้อมูลทอง"],
    ["#undoGoldBtn", "ย้อนกลับข้อมูลทอง"],
    ["#saveGold2goQuoteBtn", "บันทึกราคา GOLD2go"],
    ["#autoGold2goBtn", "ตั้งค่าดึงราคา GOLD2go อัตโนมัติ"],
    /* pricing.html — สมัคร / จัดการบิล */
    ["[data-checkout]", "สมัครแพ็กเกจ"],
    ["[data-portal]", "จัดการการชำระเงิน"],
    /* Cloud */
    ["#kfpUploadCloudBtn", "อัปโหลดข้อมูลขึ้น Cloud"]
  ];
  // ฟอร์มที่ submit แล้วบันทึกข้อมูล
  var GATED_FORMS = [["#lotForm", "บันทึกการซื้อทอง"]];
  // ช่องเลือกที่บันทึกค่าทันทีเมื่อเปลี่ยน (จะคืนค่าเดิมให้ถ้ายังไม่ Login)
  var GATED_CHANGES = [["#valuationSource", "เปลี่ยนแหล่งราคาที่ใช้คำนวณ P/L"]];
  /* ไม่ดัก (ดู/คิดเลขอย่างเดียว): อัปเดตค่าเงิน, เครื่องแปลงเงิน, สลับวอน/บาท, เปิด popup/ปฏิทิน/ประวัติ/สรุป/ตั้งค่า,
     เลื่อนเดือน, เครื่องคิดราคาทอง (buyCalc), จำลองขาย, กราฟ, รีเฟรชราคา, ข่าว, เมนูนำทาง */

  function canAct() {
    if (KS) return KS.isMember();
    return !!(window.kfpAuth && window.kfpAuth.user && window.kfpAuth.user());
  }

  function match(el, rules) {
    if (!el || !el.closest) return null;
    for (var i = 0; i < rules.length; i++) {
      var hit = el.closest(rules[i][0]);
      if (hit) return { el: hit, action: rules[i][1] || hit.getAttribute("data-requires-auth") || "" };
    }
    return null;
  }

  function requireAuth(action, options) {
    options = options || {};
    if (canAct()) return true;
    var msg = options.message || GATE_MESSAGE;
    if (window.kfpAuth && typeof window.kfpAuth.open === "function") {
      window.kfpAuth.open(options.view || "login", msg, action || "");
    } else {
      fallbackDialog(msg, action);
    }
    try { window.dispatchEvent(new CustomEvent("kfp:auth-required", { detail: { action: action || "" } })); } catch (_) {}
    return false;
  }

  // ใช้เฉพาะกรณี auth.js โหลดไม่ขึ้น (เช่น เน็ตตัด) — ไม่ปลดล็อกอะไร แค่บอกผู้ใช้
  function fallbackDialog(msg, action) {
    var d = document.getElementById("kfpGateFallback");
    if (!d) {
      d = document.createElement("div");
      d.id = "kfpGateFallback";
      d.className = "kfp-gate-fb";
      d.setAttribute("role", "alertdialog");
      d.setAttribute("aria-modal", "true");
      d.innerHTML = '<div class="kfp-gate-fb-card"><div class="kfp-gate-fb-ico" aria-hidden="true">🔐</div><b></b><small></small>' +
        '<p>ระบบบัญชียังโหลดไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ตแล้วโหลดหน้าใหม่</p>' +
        '<div class="kfp-pv-actions"><button type="button" class="kfp-pv-cta" data-fb="reload">โหลดหน้าใหม่</button><button type="button" class="kfp-pv-ghost" data-fb="close">ปิด</button></div></div>';
      d.addEventListener("click", function (e) {
        var t = e.target.closest("[data-fb]");
        if (e.target === d || (t && t.getAttribute("data-fb") === "close")) d.hidden = true;
        else if (t) location.reload();
      });
      document.body.appendChild(d);
    }
    d.querySelector("b").textContent = msg;
    d.querySelector("small").textContent = action ? "การกระทำ: " + action : "";
    d.hidden = false;
    var c = d.querySelector("[data-fb=close]"); if (c) c.focus();
  }

  function block(e, hit) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    requireAuth(hit.action, { source: hit.el });
  }

  // capture-phase ที่ document: ทำงานก่อน onclick / listener ของปุ่มเสมอ
  document.addEventListener("click", function (e) {
    if (canAct()) return;
    var hit = match(e.target, GATES);
    if (hit && !hit.el.disabled) block(e, hit);
  }, true);

  document.addEventListener("submit", function (e) {
    if (canAct()) return;
    var hit = match(e.target, GATED_FORMS);
    if (hit) block(e, hit);
  }, true);

  // <select>/<input> ที่บันทึกทันทีเมื่อเปลี่ยนค่า: จำค่าเดิม แล้วคืนให้ถ้าถูกดัก
  var lastValue = new WeakMap();
  document.addEventListener("focusin", function (e) {
    if (match(e.target, GATED_CHANGES)) lastValue.set(e.target, e.target.value);
  }, true);
  document.addEventListener("pointerdown", function (e) {
    var hit = match(e.target, GATED_CHANGES);
    if (hit && !lastValue.has(hit.el)) lastValue.set(hit.el, hit.el.value);
  }, true);
  // ค่าตั้งต้นหลังหน้าโหลดเสร็จ (gold.js ตั้งค่าจาก settings ตอน DOMContentLoaded) — ไม่พึ่ง focus/pointer
  function snapshotGatedValues() {
    GATED_CHANGES.forEach(function (r) {
      [].forEach.call(document.querySelectorAll(r[0]), function (el) { if (!lastValue.has(el)) lastValue.set(el, el.value); });
    });
  }
  if (document.readyState === "complete") snapshotGatedValues();
  else window.addEventListener("load", snapshotGatedValues);
  document.addEventListener("change", function (e) {
    if (canAct()) return;
    var hit = match(e.target, GATED_CHANGES);
    if (!hit) return;
    if (lastValue.has(hit.el)) hit.el.value = lastValue.get(hit.el);
    block(e, hit);
  }, true);

  /* =========================================================
     PLAN VISIBILITY (Phase 5)
     ========================================================= */
  var FEATURES = ["salary", "salary_history", "expenses", "work_records", "advanced_statistics", "export", "cloud_sync", "gold_portfolio"];
  var FEATURE_LABEL = {
    work_records: "บันทึกการเข้างาน", advanced_statistics: "สถิติขั้นสูงและกราฟ", export: "Export ข้อมูล",
    cloud_sync: "Cloud Sync", gold_portfolio: "พอร์ตทอง", salary_history: "ประวัติเงินเดือนทั้งหมด", expenses: "ประวัติรายจ่ายทั้งหมด"
  };
  var FEATURE_PLAN = { work_records: "Finance Plus", advanced_statistics: "Finance Plus", export: "Finance Plus", cloud_sync: "Finance Plus",
                       salary_history: "Finance Plus", expenses: "Finance Plus", gold_portfolio: "Finance Premium" };
  var ENT_CACHE_KEY = "__kfp_ent_cache_v1";          // per-account (namespaced by kfp-storage.js)
  var ENT_TIMEOUT_MS = 8000;
  var html = document.documentElement;
  // state: preview | loading | ready | offline | unconfigured
  var PLAN = { state: isPreview() ? "preview" : "loading", ent: null };

  function canUseFeature(key) {
    if (PLAN.state === "preview" || PLAN.state === "unconfigured") return true;
    if (!PLAN.ent || PLAN.state === "loading") return false;
    return !!(PLAN.ent.features && PLAN.ent.features[key] === true);
  }
  function planLimit(key) {
    if (PLAN.state === "preview" || PLAN.state === "unconfigured" || !PLAN.ent || !PLAN.ent.limits) return null;
    var v = PLAN.ent.limits[key];
    return typeof v === "number" && v > 0 ? v : null;
  }

  function applyPlanVisibility() {
    html.setAttribute("data-plan-state", PLAN.state);
    html.setAttribute("data-plan", PLAN.state === "preview" ? "preview" : (PLAN.ent && PLAN.ent.plan) || "");
    FEATURES.forEach(function (k) {
      if (PLAN.state === "loading") html.removeAttribute("data-feat-" + k);
      else html.setAttribute("data-feat-" + k, canUseFeature(k) ? "1" : "0");
    });
  }

  function renderFeaturesByPlan(ent, state) {
    if (isPreview()) { PLAN = { state: "preview", ent: null }; }
    else { PLAN = { state: state || (ent ? "ready" : "loading"), ent: ent || null }; }
    applyPlanVisibility();
    try { window.dispatchEvent(new CustomEvent("kfp:plan", { detail: planInfo() })); } catch (_) {}
  }
  function planInfo() {
    return { state: PLAN.state, plan: PLAN.ent ? PLAN.ent.plan : null, planName: PLAN.ent ? PLAN.ent.plan_name : null,
             source: PLAN.ent ? PLAN.ent.source : null, status: PLAN.ent ? PLAN.ent.status : null,
             validUntil: PLAN.ent ? PLAN.ent.valid_until : null, features: PLAN.ent ? PLAN.ent.features : null, limits: PLAN.ent ? PLAN.ent.limits : null };
  }

  function readCache() {
    try {
      var c = JSON.parse(localStorage.getItem(ENT_CACHE_KEY) || "null");
      if (c && c.ent && c.ent.user_id === (KS && KS.userId) && Date.now() - c.at < 7 * 86400000) return c.ent;
    } catch (_) {}
    return null;
  }

  var loading = false, loadedAt = 0;
  function loadEntitlements() {
    if (isPreview() || loading) return;
    var client = window.kfpAuth && window.kfpAuth.client && window.kfpAuth.client();
    if (!client || typeof client.rpc !== "function") return;
    loading = true;
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; loading = false; fallback("timeout"); } }, ENT_TIMEOUT_MS);
    Promise.resolve(client.rpc("get_my_entitlements")).then(function (res) {
      if (done) return; done = true; clearTimeout(timer); loading = false;
      var err = res && res.error, ent = res && res.data;
      if (err) {
        var code = String(err.code || ""), msg = String(err.message || "");
        // migration 0400 not deployed yet → keep the pre-SaaS behaviour (everything visible)
        if (code === "PGRST202" || code === "42883" || /could not find the function|does not exist/i.test(msg)) {
          console.warn("kfp: get_my_entitlements() missing — run migration 0400"); renderFeaturesByPlan(null, "unconfigured"); return;
        }
        fallback(msg); return;
      }
      if (!ent || !ent.plan || (KS && ent.user_id && ent.user_id !== KS.userId)) { fallback("bad response"); return; }
      loadedAt = Date.now();
      try { localStorage.setItem(ENT_CACHE_KEY, JSON.stringify({ at: loadedAt, ent: ent })); } catch (_) {}
      renderFeaturesByPlan(ent, "ready");
    }, function (e) {
      if (done) return; done = true; clearTimeout(timer); loading = false; fallback(e && e.message);
    });
  }
  // Offline / server error: last answer the SERVER gave this account (≤ 7 days), else Free.
  function fallback(reason) {
    if (PLAN.state === "ready") return;
    var c = readCache();
    if (reason) console.warn("kfp: entitlements unavailable (" + reason + ")" + (c ? " — using last server answer" : " — Free until online"));
    renderFeaturesByPlan(c || { plan: "free", plan_name: "Free", source: "offline", features: { salary: true, salary_history: true, expenses: true }, limits: {} }, "offline");
  }

  // ---- upgrade prompt (members without a feature) ----
  function upgradeUrl(key) { return "pricing.html" + (key === "gold_portfolio" ? "#premium" : "#plus"); }
  function requireFeature(key, options) {
    options = options || {};
    if (!requireAuth(options.action || FEATURE_LABEL[key] || key)) return false;
    if (canUseFeature(key)) return true;
    showUpsell(key);
    return false;
  }
  function showUpsell(key) {
    var d = document.getElementById("kfpUpsell");
    if (!d) {
      d = document.createElement("div");
      d.id = "kfpUpsell"; d.className = "kfp-gate-fb"; d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true");
      d.innerHTML = '<div class="kfp-gate-fb-card"><div class="kfp-gate-fb-ico" aria-hidden="true">✨</div><b></b><small></small>' +
        '<div class="kfp-pv-actions" style="margin-top:16px"><a class="kfp-pv-cta kfp-btnlink" data-up="go">ดูแพ็กเกจ</a><button type="button" class="kfp-pv-ghost" data-up="close">ไว้ทีหลัง</button></div></div>';
      d.addEventListener("click", function (e) {
        var t = e.target.closest("[data-up]");
        if (e.target === d || (t && t.getAttribute("data-up") === "close")) d.hidden = true;
      });
      d.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.stopPropagation(); d.hidden = true; } });
      document.body.appendChild(d);
    }
    d.querySelector("b").textContent = (FEATURE_LABEL[key] || "ฟีเจอร์นี้") + " มีในแพ็กเกจ " + (FEATURE_PLAN[key] || "ที่สูงกว่า");
    d.querySelector("small").textContent = "อัปเกรดเพื่อปลดล็อก · ข้อมูลเดิมของคุณยังอยู่ครบ";
    d.querySelector("[data-up=go]").setAttribute("href", upgradeUrl(key));
    d.hidden = false;
    var c = d.querySelector("[data-up=close]"); if (c) c.focus();
  }

  // ---- Free "Limited History": salary list on index.html (data is never deleted) ----
  function cutoffMonth(months) {
    var t; try { t = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }); } catch (_) { t = new Date().toISOString(); }
    var y = +t.slice(0, 4), m = +t.slice(5, 7), n = y * 12 + (m - 1) - (months - 1);
    return Math.floor(n / 12) + "-" + ("0" + ((n % 12) + 1)).slice(-2);
  }
  window.kfpHistoryCutoff = function (limitKey) { var n = planLimit(limitKey); return n ? cutoffMonth(n) : null; };
  function limitSalaryHistory() {
    var box = document.getElementById("salaryHistory"); if (!box) return;
    var old = box.querySelector(".kfp-limit-note"); if (old) old.remove();
    var cut = window.kfpHistoryCutoff("salary_history_months"); if (!cut) return;
    var hidden = 0;
    [].forEach.call(box.querySelectorAll(".history-item"), function (it) {
      var b = it.querySelector('[onclick^="deleteSalaryRecord("]');
      var m = b && /'(\d{4}-\d{2})'/.exec(b.getAttribute("onclick"));
      if (m && m[1] < cut) { it.remove(); hidden++; }
    });
    if (!hidden) return;
    var note = document.createElement("div");
    note.className = "kfp-limit-note";
    note.innerHTML = '<span>🔒 ซ่อนประวัติที่เก่ากว่า ' + planLimit("salary_history_months") + ' เดือน (' + hidden + ' รายการ) · ข้อมูลยังอยู่ครบ</span><a href="pricing.html#plus">ดูทั้งหมดด้วย Finance Plus</a>';
    box.appendChild(note);
  }
  if (typeof window.loadSalaryRecords === "function") {
    var origLoad = window.loadSalaryRecords;
    window.loadSalaryRecords = function () { var r = origLoad.apply(this, arguments); try { limitSalaryHistory(); } catch (_) {} return r; };
  }
  window.addEventListener("kfp:plan", function () {
    try { if (typeof window.loadSalaryRecords === "function" && document.getElementById("salaryHistory")) window.loadSalaryRecords(); } catch (_) {}
  });

  // ---- activity heartbeat (Phase 6): throttled here AND in the database (touch_activity) ----
  var HEARTBEAT_MS = 5 * 60 * 1000;
  function pageName() { return (location.pathname.split("/").pop() || "index.html").slice(0, 64); }
  function touchActivity(kind) {
    if (isPreview()) return;
    var client = window.kfpAuth && window.kfpAuth.client && window.kfpAuth.client();
    if (!client || typeof client.rpc !== "function") return;
    var key = "__kfp_act_" + pageName(), now = Date.now(), last = 0;
    try { last = +sessionStorage.getItem(key) || 0; } catch (_) {}
    if (kind !== "login" && now - last < HEARTBEAT_MS) return;
    try { sessionStorage.setItem(key, String(now)); } catch (_) {}
    Promise.resolve(client.rpc("touch_activity", { p_page: pageName(), p_kind: kind || "page" })).catch(function () {});
  }
  function startHeartbeat() {
    var first = false;
    try { first = !sessionStorage.getItem("__kfp_act_session"); sessionStorage.setItem("__kfp_act_session", "1"); } catch (_) {}
    touchActivity(first ? "login" : "page");
    setInterval(function () { if (document.visibilityState === "visible") touchActivity("heartbeat"); }, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") touchActivity("page"); });
  }
  var heartbeatStarted = false;
  window.addEventListener("kfp:auth-ready", function () { if (!heartbeatStarted) { heartbeatStarted = true; startHeartbeat(); } });

  // Phase 11 · feature usage (which tools members actually use). Only the feature NAME
  // is sent, at most once per feature per 30 min per tab; the server throttles again.
  var FEATURE_MS = 30 * 60 * 1000;
  var TRACK = [
    ['[data-open-tool="work"]', "work_records"], ['[data-open-tool="expense"]', "expenses"],
    ['button[onclick^="exportExcel("]', "export"], ["#kfpUploadCloudBtn", "cloud_sync"],
    ['[data-open-tool]', "tools"], ["[data-track]", null]
  ];
  function trackFeature(name) {
    if (isPreview() || !name) return;
    var client = window.kfpAuth && window.kfpAuth.client && window.kfpAuth.client();
    if (!client || typeof client.rpc !== "function" || !(window.kfpAuth.user && window.kfpAuth.user())) return;
    name = String(name).toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 40);
    var key = "__kfp_ft_" + name, now = Date.now(), last = 0;
    try { last = +sessionStorage.getItem(key) || 0; } catch (_) {}
    if (!name || now - last < FEATURE_MS) return;
    try { sessionStorage.setItem(key, String(now)); } catch (_) {}
    Promise.resolve(client.rpc("touch_activity", { p_page: name, p_kind: "feature" })).catch(function () {});
  }
  document.addEventListener("click", function (e) {
    if (!e.target || !e.target.closest) return;
    for (var i = 0; i < TRACK.length; i++) {
      var el = e.target.closest(TRACK[i][0]);
      if (el) { trackFeature(TRACK[i][1] || el.getAttribute("data-track")); return; }
    }
  }, true);
  // a page that IS a feature counts once it is actually shown (gold portfolio only with the plan)
  window.addEventListener("kfp:plan", function (e) {
    var d = e.detail || {};
    if (d.state !== "ready") return;
    if (document.querySelector(".gold-container") && d.features && d.features.gold_portfolio) trackFeature("gold_portfolio");
  });

  // ---- start ----
  // gold.html opened directly by a member: content needs "gold_portfolio",
  // otherwise an upgrade screen is shown instead (gold.js never renders visibly).
  function buildGoldGate() {
    var gc = document.querySelector(".gold-container");
    if (!gc || isPreview() || document.getElementById("kfpGoldUpsell")) return;
    if (!gc.hasAttribute("data-feature")) gc.setAttribute("data-feature", "gold_portfolio");
    var ld = document.createElement("div");
    ld.className = "kfp-plan-loading"; ld.setAttribute("role", "status");
    ld.innerHTML = '<i aria-hidden="true"></i>กำลังตรวจสอบสิทธิ์การใช้งาน…';
    var up = document.createElement("section");
    up.id = "kfpGoldUpsell"; up.className = "kfp-gold-upsell"; up.setAttribute("data-feature-off", "gold_portfolio");
    up.innerHTML =
      '<div class="kfp-up-card"><div class="kfp-up-ico" aria-hidden="true">🪙</div><span class="kfp-up-tag">FINANCE PREMIUM</span>' +
      '<h1>พอร์ตทองคำอยู่ในแพ็กเกจ Finance Premium</h1>' +
      '<p>ติดตามทองที่ออมไว้ทุกรอบ ดูต้นทุน กำไร/ขาดทุน และมูลค่าพอร์ตแบบเรียลไทม์</p>' +
      '<ul class="kfp-up-list"><li>บันทึกการซื้อทองทุกรอบ พร้อมต้นทุนเฉลี่ย</li><li>กำไร/ขาดทุนตามราคา GOLD2go และราคาตลาดโลก</li>' +
      '<li>กราฟราคา จำลองการขาย และประวัติพอร์ต</li><li>ซิงก์ข้อมูลทองข้ามเครื่องผ่าน Cloud</li></ul>' +
      '<div class="kfp-pv-actions"><a class="kfp-pv-cta kfp-btnlink" href="pricing.html#premium">✨ ดูแพ็กเกจ Premium</a>' +
      '<a class="kfp-pv-ghost kfp-btnlink" href="index.html">🏠 กลับหน้าหลัก</a></div>' +
      '<p class="kfp-up-cur" id="kfpUpCur"></p></div>';
    gc.parentNode.insertBefore(ld, gc);
    gc.parentNode.insertBefore(up, gc);
    window.addEventListener("kfp:plan", function (e) {
      var d = e.detail || {}, el = document.getElementById("kfpUpCur");
      if (el) el.textContent = d.planName ? "แพ็กเกจปัจจุบันของคุณ: " + d.planName + " · ข้อมูลทองเดิม (ถ้ามี) ยังเก็บไว้ครบ" : "";
    });
  }
  buildGoldGate();
  renderFeaturesByPlan(null, isPreview() ? "preview" : "loading");
  if (!isPreview()) {
    window.addEventListener("kfp:auth-ready", loadEntitlements);
    loadEntitlements();                                         // if auth.js was already ready
    setTimeout(function () { if (PLAN.state === "loading") { loadEntitlements(); setTimeout(function () { if (PLAN.state === "loading") fallback("auth not ready"); }, ENT_TIMEOUT_MS); } }, 1500);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && Date.now() - loadedAt > 10 * 60 * 1000) loadEntitlements();
    });
  }

  window.canUseFeature = canUseFeature;
  window.renderFeaturesByPlan = function () { renderFeaturesByPlan(PLAN.ent, PLAN.state); };
  window.applyPlanVisibility = applyPlanVisibility;
  window.requireFeature = requireFeature;
  window.kfpPlan = Object.freeze({ info: planInfo, canUseFeature: canUseFeature, limit: planLimit, refresh: loadEntitlements, requireFeature: requireFeature, features: FEATURES.slice() });

  window.requireAuth = requireAuth;
  window.kfpTrackFeature = function (name) { trackFeature(name); };
  window.kfpGate = Object.freeze({
    requireAuth: requireAuth,
    canAct: canAct,
    message: GATE_MESSAGE,
    rules: GATES.map(function (r) { return { selector: r[0], action: r[1] }; })
  });

  /* =========================================================
     PREVIEW UI (Phase 3)
     ========================================================= */
  function build() {
    if (!isPreview() || document.getElementById("kfpPreviewBanner") || document.body.hasAttribute("data-no-preview-ui")) return;

    var pill = document.createElement("button");
    pill.type = "button";
    pill.id = "kfpPreviewPill";
    pill.className = "kfp-pv-pill";
    pill.setAttribute("aria-label", "Preview mode: ข้อมูลทั้งหมดเป็นข้อมูลตัวอย่าง แตะเพื่อดูรายละเอียด");
    pill.innerHTML = '<i aria-hidden="true"></i>PREVIEW MODE';
    pill.addEventListener("click", function () {
      var b = document.getElementById("kfpPreviewBanner");
      if (!b) return;
      b.scrollIntoView({ behavior: "smooth", block: "center" });
      b.classList.remove("kfp-pv-flash"); void b.offsetWidth; b.classList.add("kfp-pv-flash");
    });
    document.body.appendChild(pill);

    var host = document.querySelector(".container, .gold-container") || document.body;
    var ban = document.createElement("section");
    ban.id = "kfpPreviewBanner";
    ban.className = "kfp-pv-banner";
    ban.setAttribute("role", "note");
    ban.setAttribute("aria-label", "ข้อมูลตัวอย่าง");
    ban.innerHTML =
      '<div class="kfp-pv-top"><span class="kfp-pv-tag">PREVIEW MODE</span><span class="kfp-pv-tag demo">DEMO DATA</span></div>' +
      '<h2>DEMO DATA — ตัวอย่างการใช้งาน</h2>' +
      '<p>ตัวเลขทุกอย่างในหน้านี้เป็น<b>ข้อมูลจำลอง</b> ไม่ใช่ข้อมูลของสมาชิกจริง · เลื่อนดูและเปิดทุกเมนูได้เลย ' +
      'ส่วนการบันทึก แก้ไข ลบ คำนวณ หรือ Export ต้องเข้าสู่ระบบก่อน</p>' +
      '<div class="kfp-pv-actions"><button type="button" class="kfp-pv-cta" data-pv="register">✨ สมัครใช้งานฟรี</button>' +
      '<button type="button" class="kfp-pv-ghost" data-pv="login">เข้าสู่ระบบ</button></div>';
    ban.addEventListener("click", function (e) {
      var t = e.target.closest("[data-pv]"); if (t) openAuth(t.getAttribute("data-pv"));
    });
    var sub = document.querySelector(".container > .subtitle");
    if (sub) sub.insertAdjacentElement("afterend", ban);
    else host.insertBefore(ban, host.firstChild);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
})();
