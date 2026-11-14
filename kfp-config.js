/*
  kfp-config.js — ตั้งค่าการแบ่งเงิน (การ์ด/ชื่อ/%) + โหมดสกุลเงิน (KRW / THB)
  โหลดก่อน script.js  ·  ฟังก์ชันที่ผูกกับหน้าจอจะถูกเรียกหลัง script.js พร้อมแล้วเท่านั้น
*/
(function () {
  "use strict";

  var ALLOC_KEY = "kfp_alloc_v1";
  var MODE_KEY = "kfp_mode_v1";
  var MAX_CARDS = 12;

  // สีประจำการ์ด (เรียงตามลำดับการ์ด) — 5 สีแรกตรงกับธีมเดิม
  var PALETTE = [
    "61,220,151", "255,196,64", "80,176,255", "170,120,255", "255,110,150",
    "45,212,191", "255,140,66", "140,160,255", "190,242,100", "244,114,182",
    "56,189,248", "250,204,21"
  ];

  var DEFAULT_CATS = [
    { id: "saving",   emoji: "💰", name: "เงินเก็บ",   pct: 45, role: "saving" },
    { id: "gold",     emoji: "🥇", name: "ออมทอง",    pct: 15, role: "gold" },
    { id: "family",   emoji: "🏠", name: "ส่งบ้าน",    pct: 25, role: "" },
    { id: "personal", emoji: "🛒", name: "ใช้ส่วนตัว", pct: 10, role: "" },
    { id: "travel",   emoji: "✈️", name: "เที่ยว",     pct: 5,  role: "" }
  ];

  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c];
    });
  }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  /* ---------- ตรวจ/ทำความสะอาดรายการการ์ด ---------- */
  // คืน {ok, cats, error}   (ใช้ทั้งตอนโหลด และตอนกดบันทึกในหน้าจัดการ)
  function validate(list) {
    if (!Array.isArray(list) || !list.length) return { ok: false, error: "ต้องมีอย่างน้อย 1 การ์ด" };
    if (list.length > MAX_CARDS) return { ok: false, error: "เพิ่มได้สูงสุด " + MAX_CARDS + " การ์ด" };
    var seenId = {}, seenRole = {}, out = [], sum = 0;
    for (var i = 0; i < list.length; i++) {
      var c = list[i] || {};
      var name = String(c.name == null ? "" : c.name).trim();
      var pct = Math.round(num(c.pct) * 100) / 100;
      if (!name) return { ok: false, error: "การ์ดที่ " + (i + 1) + " ยังไม่มีชื่อ" };
      if (pct < 0 || pct > 100) return { ok: false, error: "% ของ “" + name + "” ต้องอยู่ระหว่าง 0–100" };
      var id = String(c.id || "").replace(/[^A-Za-z0-9_-]/g, "") || ("c" + Date.now().toString(36) + i);
      while (seenId[id]) id += "x";
      seenId[id] = 1;
      var role = (c.role === "saving" || c.role === "gold") ? c.role : "";
      if (role) { if (seenRole[role]) role = ""; else seenRole[role] = 1; }   // แต่ละบทบาทมีได้การ์ดเดียว
      var emoji = Array.from(String(c.emoji == null ? "" : c.emoji).trim()).slice(0, 3).join("") || "📌";
      out.push({ id: id, emoji: emoji, name: name.slice(0, 24), pct: pct, role: role });
      sum += pct;
    }
    if (Math.abs(sum - 100) > 0.005) return { ok: false, error: "รวมต้องได้ 100% (ตอนนี้ " + (Math.round(sum * 100) / 100) + "%)", sum: sum };
    return { ok: true, cats: out, sum: sum };
  }

  function loadAlloc() {
    try {
      var raw = localStorage.getItem(ALLOC_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        var r = validate(data && data.cats);
        if (r.ok) return r.cats;
      }
    } catch (_) {}
    return clone(DEFAULT_CATS);
  }

  function persist() { try { if (typeof kfpPersistNow === "function") kfpPersistNow(); } catch (_) {} }

  function saveAlloc(cats) {
    var r = validate(cats);
    if (!r.ok) return r;
    // เก็บค่าเสมอ (รวมกรณีรีเซ็ต) ไม่ลบคีย์ — กัน snapshot เก่าของ PWA ย้อนกลับมาทับ
    localStorage.setItem(ALLOC_KEY, JSON.stringify({ v: 1, cats: r.cats }));
    persist();
    return r;
  }

  function getMode() { return localStorage.getItem(MODE_KEY) === "THB" ? "THB" : "KRW"; }
  function setMode(m) { localStorage.setItem(MODE_KEY, m === "THB" ? "THB" : "KRW"); persist(); }

  /* ---------- ตัวช่วยอ่านรายการเงินเดือน (รองรับทั้งโหมด KRW และ THB) ---------- */
  function recThb(r) {
    if (!r) return 0;
    return r.currency === "THB" ? num(r.thb) : num(r.salary) * num(r.rate);
  }
  function recKrw(r) { return (!r || r.currency === "THB") ? 0 : num(r.salary); }

  function pctText(p) { return String(+Number(p).toFixed(2)); }
  function catLabel(c) { return c.emoji + " " + c.name + " " + pctText(c.pct) + "%"; }
  function catRgb(i) { return PALETTE[i % PALETTE.length]; }
  function roleCat(role) {
    var list = loadAlloc();
    for (var i = 0; i < list.length; i++) if (list[i].role === role) return list[i];
    return null;
  }

  window.KFP_ALLOC_DEFAULT = DEFAULT_CATS;
  window.KFP_MAX_CARDS = MAX_CARDS;
  window.kfpValidateAlloc = validate;
  window.kfpLoadAlloc = loadAlloc;
  window.kfpSaveAlloc = saveAlloc;
  window.kfpResetAlloc = function () { return saveAlloc(clone(DEFAULT_CATS)); };
  window.kfpDefaultAlloc = function () { return clone(DEFAULT_CATS); };
  window.kfpGetMode = getMode;
  window.kfpSetMode = setMode;
  window.kfpRecThb = recThb;
  window.kfpRecKrw = recKrw;
  window.kfpCatRgb = catRgb;
  window.kfpCatLabel = catLabel;
  window.kfpPctText = pctText;
  window.kfpSavingCat = function () { return roleCat("saving"); };
  window.kfpGoldCat = function () { return roleCat("gold"); };
  window.kfpEsc = esc;

  /* =========================================================
     การ์ดผลคำนวณ + การ์ดสถิติ (วาดตามรายการการ์ดที่ตั้งไว้)
     ========================================================= */

  // เรนเดอร์โครงการ์ด "ผลคำนวณ" — เลขคี่: การ์ดแรกเต็มแถว ที่เหลือเรียง 2 ช่อง / เลขคู่: 2 ช่องทั้งหมด
  window.kfpRenderResults = function (animate) {
    var box = $("results");
    if (!box) return;
    var cats = loadAlloc();
    box.classList.toggle("odd", cats.length % 2 === 1);
    box.innerHTML = cats.map(function (c, i) {
      return '<div class="result-card' + (animate ? " kfp-new" : "") + '" data-cat="' + esc(c.id) + '" style="--ac:' + catRgb(i) + ';--n:' + i + '">' +
        '<h3>' + esc(catLabel(c)) + '</h3><p data-fx data-cat-val="' + esc(c.id) + '">-</p></div>';
    }).join("");
  };

  // เติมตัวเลขผลคำนวณ (amount = เงินเดือนในสกุลที่กรอก, rate = THB ต่อ 1 หน่วย; โหมด THB rate=1)
  window.kfpFillResults = function (amount, rate, mode) {
    var cats = loadAlloc();
    cats.forEach(function (c) {
      var el = document.querySelector('[data-cat-val="' + c.id + '"]');
      if (!el) return;
      var v = Math.round(amount * c.pct) / 100;
      var fmt = typeof formatNumber === "function" ? formatNumber : function (n) { return String(n); };
      if (mode === "THB") {
        el.innerHTML = fmt(v) + " THB";
      } else {
        el.innerHTML = fmt(v) + " KRW<br>\n        ≈ " + fmt((v * rate).toFixed(0)) + " THB";
      }
    });
  };

  window.kfpResetResults = function () {
    document.querySelectorAll("[data-cat-val]").forEach(function (el) { el.textContent = "-"; });
  };

  // การ์ดสถิติ: รวมรายได้เต็มแถวเสมอ · การ์ดที่เป็น “ออมทอง” อยู่ท้ายสุดเต็มแถว (มีกล่องมูลค่าพอร์ตทอง)
  // ส่วนที่เหลือ: เลขคี่ -> ใบแรกเต็มแถว ที่เหลือเรียง 2 ช่อง / เลขคู่ -> 2 ช่อง
  window.kfpRenderStats = function (animate) {
    var box = $("statsGrid");
    if (!box) return;
    var cats = loadAlloc();
    var cls = animate ? " kfp-new" : "";
    var html = '<div class="stat-box wide' + cls + '" style="--ac:232,190,70;--n:0"><span>🎯 รายได้ทั้งหมด</span>' +
      '<h3 id="totalSalaryKRW" data-fx>0 KRW</h3><p id="totalSalaryTHB" data-fx>0 THB</p></div>';

    var indexed = cats.map(function (c, i) { return { c: c, i: i }; });
    var goldItem = indexed.filter(function (x) { return x.c.role === "gold"; })[0] || null;
    var rest = indexed.filter(function (x) { return x !== goldItem; });

    function card(x, wide, n) {
      var c = x.c;
      var portfolio = x.c.role === "gold"
        ? '<div id="goldPortfolioInfo" class="stat-portfolio" data-feature="gold_portfolio" hidden>' +
            '<div class="sp-label">🪙 พอร์ตทอง · มูลค่าปัจจุบัน</div>' +
            '<div class="sp-value" id="goldPortfolioValue">-</div>' +
            '<div class="sp-pl" id="goldPortfolioPL">-</div>' +
            '<div class="sp-time" id="goldPortfolioTime"></div></div>'
        : "";
      return '<div class="stat-box' + (wide ? " wide" : "") + cls + '" data-cat="' + esc(c.id) + '" style="--ac:' + catRgb(x.i) + ';--n:' + n + '">' +
        '<span>' + esc(catLabel(c)) + '</span>' +
        '<h3 data-fx data-cat-krw="' + esc(c.id) + '">0 KRW</h3>' +
        '<p data-fx data-cat-thb="' + esc(c.id) + '">0 THB</p>' + portfolio + '</div>';
    }

    var n = 1;
    rest.forEach(function (x, k) { html += card(x, rest.length % 2 === 1 && k === 0, n++); });
    if (goldItem) html += card(goldItem, true, n++);
    box.innerHTML = html;
    try { if (typeof kfpRenderGoldPortfolio === "function") kfpRenderGoldPortfolio(); } catch (_) {}
  };

  // ข้อความที่อ้างอิงชื่อการ์ดเงินเก็บ: หัวกราฟสะสม + โน้ตเป้าหมาย + การซ่อน/แสดงกราฟ
  window.kfpUpdateSavingTexts = function () {
    var s = window.kfpSavingCat();
    var title = $("savingChartTitle"), block = $("savingChartBlock"), note = $("goalNote");
    if (block) block.hidden = !s;
    if (title) title.innerHTML = s
      ? esc("📈 " + s.name + "สะสม " + pctText(s.pct) + "%") + " <small>(บาท)</small>"
      : "";
    if (note) note.textContent = s
      ? "🔗 อ้างอิงอัตโนมัติจาก “สถิติการเงิน → " + s.name + " " + pctText(s.pct) + "%” (บาท)"
      : "⚠️ ยังไม่ได้ตั้งการ์ดใดเป็น “เงินเก็บ” (กด ⚙️ จัดการ แล้วเลือกบทบาทของการ์ด) เงินสะสมจึงเป็น 0";
  };

  /* ---------- โหมดสกุลเงิน ---------- */
  window.kfpApplyMode = function () {
    var m = getMode();
    document.documentElement.setAttribute("data-mode", m);
    document.querySelectorAll("#modeSwitch [data-mode]").forEach(function (b) {
      var on = b.getAttribute("data-mode") === m;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    var sw = $("modeSwitch");
    if (sw) sw.setAttribute("data-on", m);
    var lab = $("salaryRecordLabel");
    if (lab) lab.textContent = m === "THB" ? "รายได้สุทธิ (THB)" : "รายได้สุทธิ (KRW)";
    var inp = $("salaryRecord");
    if (inp) inp.placeholder = m === "THB" ? "เช่น 45000" : "เช่น 2567890";
  };

  // สลับโหมด: เก็บค่า -> ปรับหน้าจอ -> คำนวณใหม่ถ้ามีตัวเลขในช่อง ไม่งั้นล้างผลเดิม
  window.kfpSwitchMode = function (m) {
    if (m === getMode()) return;
    setMode(m);
    window.kfpApplyMode();
    var amount = m === "THB" ? num(($("salaryThb") || {}).value) : num(($("salary") || {}).value);
    if (amount > 0 && typeof calculate === "function") calculate();
    else {
      window.kfpResetResults();
      if (typeof renderPieChart === "function") renderPieChart();
    }
    if (typeof updateSalaryPreview === "function") updateSalaryPreview();
  };

  // หลังแก้การ์ด (ชื่อ/%/เพิ่ม/ลบ/รีเซ็ต): วาดการ์ดใหม่ + คำนวณใหม่ + สถิติ/กราฟ/เป้าหมายตามไปด้วย
  window.kfpOnAllocChanged = function () {
    window.kfpRenderResults(true);
    window.kfpRenderStats(true);
    window.kfpUpdateSavingTexts();
    var m = getMode();
    var amount = m === "THB" ? num(($("salaryThb") || {}).value) : num(($("salary") || {}).value);
    if (amount > 0 && typeof calculate === "function") calculate();
    else if (typeof renderPieChart === "function") renderPieChart();
    if (typeof updateAnalytics === "function") updateAnalytics();
    if (typeof updateGoalTracker === "function") { try { updateGoalTracker(); } catch (_) {} }
  };

  window.kfpRenderAllCards = function () {
    window.kfpApplyMode();
    window.kfpRenderResults(false);
    window.kfpRenderStats(false);
    window.kfpUpdateSavingTexts();
  };

  // ปุ่มสลับสกุลเงิน
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("#modeSwitch [data-mode]");
    if (b) window.kfpSwitchMode(b.getAttribute("data-mode"));
  });
})();
