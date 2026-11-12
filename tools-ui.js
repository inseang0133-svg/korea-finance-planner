/*
  tools-ui.js — 🗂️ บันทึกการเข้างาน (โหมดวอน) + 💸 รายจ่าย (วอน/บาท)
  พอร์ต logic มาจาก bot expense (work.py / app.py /work, /expense) ให้ทำงานในเว็บทั้งหมด
  - เก็บข้อมูลใน localStorage (ซิงก์ขึ้น Cloud ผ่าน DATA_KEYS ใน auth.js)
  - รายจ่ายที่ผูกกับการ์ดใน “สถิติการเงิน” จะถูกหักออกจากยอดการ์ดนั้น (ผ่าน window.kfpExpenseAdjust)
*/
(function () {
  "use strict";
  if (window.__kfpTools) return;
  window.__kfpTools = true;

  var d = document;
  var K_SET = "kfp_work_settings_v1";
  var K_REC = "kfp_work_records_v1";
  var K_DED = "kfp_work_deductions_v1";
  var K_RCV = "kfp_work_received_v1";
  var K_EXP = "kfp_expenses_v1";

  var THAI_MONTHS = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
  var TYPE_NAMES = { normal: "🏭 วันปกติ", weekend: "🗓 เสาร์ / อาทิตย์", holiday: "🎌 วันหยุด", day_off: "💤 วันหยุดงาน" };
  var TYPE_DESC = { normal: "ชั่วโมงปกติ + OT", weekend: "คิดตัวคูณ Weekend ทั้งวัน", holiday: "คิดตัวคูณ Holiday ทั้งวัน", day_off: "ไม่มีรายได้" };
  var DEFAULT_SET = { wage: 10320, normal: 1, ot: 1.5, weekend: 1.5, holiday: 1.5 };

  /* ---------------- helpers ---------------- */
  var esc = function (s) { return window.kfpEsc ? window.kfpEsc(s) : String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]; }); };
  var num = function (v) { var n = Number(v); return isFinite(n) ? n : 0; };
  var $ = function (id) { return d.getElementById(id); };
  var fmt = function (n) { return Math.round(num(n)).toLocaleString("en-US"); };
  var fmt2 = function (n) { return num(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  var hrs = function (v) { v = num(v); return Number.isInteger(v) ? String(v) : String(+v.toFixed(1)); };
  var roundKrw = function (v) { return Math.round(num(v) + 1e-9); };
  var uid = function () { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); };

  function todayStr() {
    try { return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }); }
    catch (_) { var t = new Date(); return t.getFullYear() + "-" + pad(t.getMonth() + 1) + "-" + pad(t.getDate()); }
  }
  function parseYM(ym) { var p = String(ym).split("-"); return { y: +p[0], m: +p[1] }; }
  function ymOf(dateStr) { return String(dateStr).slice(0, 7); }
  function addMonth(ym, delta) { var p = parseYM(ym), t = p.y * 12 + (p.m - 1) + delta; return Math.floor(t / 12) + "-" + pad((t % 12) + 1); }
  function ymLabel(ym) { var p = parseYM(ym); return THAI_MONTHS[p.m] + " " + (p.y + 543); }
  function thDate(s) { var p = String(s).slice(0, 10).split("-"); return p[2] + "/" + p[1] + "/" + (+p[0] + 543); }
  function dayOfWeek(s) { var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]).getDay(); }
  function daysIn(ym) { var p = parseYM(ym); return new Date(p.y, p.m, 0).getDate(); }
  var DOW = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

  function load(key, def) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? def : v; } catch (_) { return def; }
  }
  function store(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {}
    try { if (typeof kfpClearDeleted === "function") kfpClearDeleted(key); } catch (_) {}
    try { if (typeof kfpPersistNow === "function") kfpPersistNow(); } catch (_) {}
  }
  function settings() { var s = load(K_SET, null) || {}; return { wage: num(s.wage) > 0 ? num(s.wage) : DEFAULT_SET.wage, normal: s.normal > 0 ? +s.normal : DEFAULT_SET.normal, ot: s.ot > 0 ? +s.ot : DEFAULT_SET.ot, weekend: s.weekend > 0 ? +s.weekend : DEFAULT_SET.weekend, holiday: s.holiday > 0 ? +s.holiday : DEFAULT_SET.holiday }; }
  function records() { var r = load(K_REC, []); return Array.isArray(r) ? r : []; }
  function deductions() { var r = load(K_DED, []); return Array.isArray(r) ? r : []; }
  function expenses() { var r = load(K_EXP, []); return Array.isArray(r) ? r : []; }
  function received() { var r = load(K_RCV, {}); return r && typeof r === "object" && !Array.isArray(r) ? r : {}; }
  function curRate() { var r = num(($("rate") || {}).value); return r > 0 ? r : 0.025; }
  function mode() { return (typeof kfpGetMode === "function" ? kfpGetMode() : "KRW"); }

  /* ---------------- คำนวณรายได้ 1 วัน (พอร์ตจาก work.py) ---------------- */
  function calcWork(type, reg, ot, s) {
    var out = { type: type, reg: reg, ot: ot, wage: s.wage, regMul: 0, otMul: 0, regInc: 0, otInc: 0, krw: 0 };
    if (type === "day_off") return out;
    if (type === "normal") { out.regMul = s.normal; out.otMul = s.ot; }
    else if (type === "weekend") { out.regMul = out.otMul = s.weekend; }
    else { out.regMul = out.otMul = s.holiday; }
    out.regInc = roundKrw(reg * s.wage * out.regMul);
    out.otInc = roundKrw(ot * s.wage * out.otMul);
    out.krw = out.regInc + out.otInc;
    return out;
  }

  /* ---------------- ตัวช่วยผูกรายจ่ายกับการ์ดสถิติ ---------------- */
  window.kfpExpenseAdjust = function (catId) {
    var krw = 0, thb = 0;
    expenses().forEach(function (e) { if (e.cat && e.cat === catId) { krw += num(e.krw); thb += num(e.thb); } });
    return { krw: krw, thb: thb };
  };
  window.kfpExpenseDecorate = function () {
    var cats = typeof kfpLoadAlloc === "function" ? kfpLoadAlloc() : [];
    cats.forEach(function (c) {
      var box = d.querySelector('.stat-box[data-cat="' + c.id + '"]'); if (!box) return;
      var old = box.querySelector(".stat-spent"); if (old) old.remove();
      var a = window.kfpExpenseAdjust(c.id);
      if (a.thb <= 0 && a.krw <= 0) return;
      var el = d.createElement("div");
      el.className = "stat-spent";
      var hasKrw = (box.querySelector("[data-cat-thb]") || {}).hidden !== true;
      el.textContent = "💸 หักรายจ่ายแล้ว − " + (hasKrw && a.krw > 0 ? fmt(a.krw) + " KRW" : fmt(a.thb) + " THB");
      var anchor = box.querySelector("[data-cat-thb]") || box.querySelector("h3");
      anchor.insertAdjacentElement("afterend", el);
    });
  };
  function refreshStats() {
    try { if (typeof updateAnalytics === "function") updateAnalytics(); } catch (e) { console.warn(e); }
    try { if (typeof updateGoalTracker === "function") updateGoalTracker(); } catch (_) {}
  }

  /* =========================================================
     Modal shell
     ========================================================= */
  var panel = null, body = null, lastFocus = null, S = {};

  function build() {
    if (panel) return;
    panel = d.createElement("div");
    panel.id = "kfpTools";
    panel.className = "kfp-modal tl-modal";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "tlTitle");
    panel.innerHTML = '<div class="kfp-modal-card tl-card" role="document"><div id="tlBody"></div></div>';
    d.body.appendChild(panel);
    body = $("tlBody");

    panel.addEventListener("pointerdown", function (e) { if (e.target === panel) close(); });
    panel.addEventListener("click", onClick);
    panel.addEventListener("input", onInput);
    panel.addEventListener("change", onInput);
    panel.addEventListener("submit", function (e) { e.preventDefault(); });
    d.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && panel && !panel.hidden) { e.preventDefault(); close(); }
    });
    panel.addEventListener("keydown", function (e) {
      if (e.key !== "Tab") return;
      var f = panel.querySelectorAll("input,select,button:not([disabled])");
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && d.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && d.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }

  function open(kind, cur) {
    build();
    lastFocus = d.activeElement;
    S = { kind: kind, cur: cur || "KRW" };
    if (kind === "work") go("wmenu");
    else { S.ex = { month: ymOf(todayStr()), tab: "summary", editing: null, delId: null }; go("expense"); }
    panel.hidden = false;
    d.documentElement.classList.add("kfp-lock");
    requestAnimationFrame(function () { panel.classList.add("open"); });
    setTimeout(function () { var c = panel.querySelector(".tl-close"); if (c) c.focus(); }, 60);
  }

  function close() {
    if (!panel || panel.hidden) return;
    panel.classList.remove("open");
    d.documentElement.classList.remove("kfp-lock");
    setTimeout(function () { panel.hidden = true; }, 230);
    if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (_) {}
  }

  function head(icon, title, sub, backTo) {
    return '<div class="tl-head">' +
      (backTo ? '<button type="button" class="tl-back" data-go="' + backTo + '" aria-label="ย้อนกลับ">‹</button>' : '<span class="tl-back-sp"></span>') +
      '<div class="tl-head-txt"><h2 id="tlTitle">' + icon + " " + title + "</h2>" + (sub ? '<p class="kfp-modal-sub">' + sub + "</p>" : "") + "</div>" +
      '<button type="button" class="tl-close" data-act="close" aria-label="ปิด">✕</button></div>';
  }

  function go(view, params) {
    S.view = view;
    if (params) for (var k in params) S[k] = params[k];
    render();
    var card = panel.querySelector(".tl-card"); if (card) card.scrollTop = 0;
  }

  function render() {
    var v = S.view, h = "";
    switch (v) {
      case "wmenu": h = vMenu(); break;
      case "wtype": h = vType(); break;
      case "whours": h = vHours(); break;
      case "wot": h = vOt(); break;
      case "wconfirm": h = vConfirm(); break;
      case "wcal": h = vCal(); break;
      case "wdetail": h = vDetail(); break;
      case "wsum": h = vSummary(); break;
      case "wset": h = vSettings(); break;
      case "expense": h = vExpense(); break;
    }
    body.innerHTML = '<div class="tl-view" data-view="' + v + '">' + h + "</div>";
    if (v === "expense") { fillExpenseForm(); renderExpenseList(); }
    // re-render ทำให้โฟกัสหลุดไป body -> ดึงกลับเข้าการ์ด (ให้ Tab / Esc ใช้ต่อได้)
    var card = panel.querySelector(".tl-card");
    if (card && !panel.contains(d.activeElement)) { card.setAttribute("tabindex", "-1"); try { card.focus({ preventScroll: true }); } catch (_) {} }
  }

  /* =========================================================
     WORK — เมนูหลัก
     ========================================================= */
  function vMenu() {
    var s = settings(), t = todayStr(), has = records().some(function (r) { return r.date === t; });
    var items = [
      ["today", "➕", "บันทึกเข้างานวันนี้", has ? "วันนี้มีบันทึกแล้ว · กดเพื่อแก้ไข" : thDate(t), "gold"],
      ["past", "🗓", "บันทึกเข้างานย้อนหลัง", "เลือกวันที่จากปฏิทิน", ""],
      ["sum", "📊", "สรุปรายได้", "รายได้ · รายการหัก · เงินเข้าจริง", ""],
      ["hist", "📋", "ประวัติการทำงาน", "ดู แก้ไข หรือลบรายวัน", ""],
      ["set", "⚙️", "ตั้งค่า", "ค่าแรง " + fmt(s.wage) + " ₩/ชม. · OT ×" + hrs(s.ot), ""]
    ];
    return head("💼", "บันทึกการเข้างาน", "ทำงานในเกาหลี · คำนวณเป็นวอนและบาทให้อัตโนมัติ") +
      '<div class="tl-menu">' + items.map(function (it, i) {
        return '<button type="button" class="tl-mbtn ' + it[4] + '" data-act="m-' + it[0] + '" style="--n:' + i + '">' +
          '<span class="tl-mico">' + it[1] + '</span><span class="tl-mtxt"><b>' + it[2] + "</b><small>" + it[3] + '</small></span><i class="tl-chev">›</i></button>';
      }).join("") + "</div>";
  }

  function steps(n) {
    var labels = ["ประเภท", "ชั่วโมง", "OT", "ยืนยัน"];
    return '<ol class="tl-steps">' + labels.map(function (l, i) {
      return '<li class="' + (i + 1 < n ? "done" : i + 1 === n ? "now" : "") + '"><i>' + (i + 1 < n ? "✓" : i + 1) + "</i><span>" + l + "</span></li>";
    }).join("") + "</ol>";
  }

  function vType() {
    var p = S.pend;
    var h = head("💼", "บันทึกการทำงาน", "📅 " + thDate(p.date) + " (" + DOW[dayOfWeek(p.date)] + ")", S.backTo || "wmenu") + steps(1);
    h += '<div class="tl-types">' + ["normal", "weekend", "holiday", "day_off"].map(function (t, i) {
      return '<button type="button" class="tl-type' + (p.type === t ? " sel" : "") + '" data-act="type" data-v="' + t + '" style="--n:' + i + '"><b>' + TYPE_NAMES[t] + "</b><small>" + TYPE_DESC[t] + "</small></button>";
    }).join("") + "</div>";
    return h;
  }

  function stepper(kind, cur, opts) {
    var chips = opts.map(function (v) { return '<button type="button" class="tl-chip' + (+v === cur ? " sel" : "") + '" data-act="' + kind + '-set" data-v="' + v + '">' + v + "</button>"; }).join("");
    return '<div class="tl-chips">' + chips + "</div>" +
      '<div class="tl-stepper"><button type="button" data-act="' + kind + '-adj" data-v="-0.5" aria-label="ลด 0.5">−</button>' +
      '<div class="tl-sval"><b id="tlSv">' + hrs(cur) + '</b><small>ชั่วโมง</small></div>' +
      '<button type="button" data-act="' + kind + '-adj" data-v="0.5" aria-label="เพิ่ม 0.5">+</button></div>';
  }

  function vHours() {
    var p = S.pend;
    return head("⏱", "ชั่วโมงทำงานปกติ", "📅 " + thDate(p.date) + " · " + TYPE_NAMES[p.type], "wtype") + steps(2) +
      stepper("h", p.reg, [6, 7, 7.5, 8, 8.5, 9, 10, 11, 12]) +
      '<button type="button" class="tl-primary" data-act="h-next">ถัดไป ›</button>';
  }

  function vOt() {
    var p = S.pend;
    return head("⏰", "ชั่วโมง OT", "📅 " + thDate(p.date) + " · ปกติ " + hrs(p.reg) + " ชม.", "whours") + steps(3) +
      stepper("o", p.ot, [0, 1, 2, 2.5, 3, 4, 5]) +
      '<p class="tl-hint">ถ้าไม่มี OT ให้เลือก 0 ชั่วโมง</p>' +
      '<button type="button" class="tl-primary" data-act="o-next">ถัดไป ›</button>';
  }

  function vConfirm() {
    var p = S.pend, s = settings(), r = calcWork(p.type, p.reg, p.ot, s), rate = curRate(), thb = r.krw * rate;
    var exists = records().some(function (x) { return x.date === p.date; });
    S.calc = r;
    var rows = [
      ["📅 วันที่", thDate(p.date)], ["🏷 ประเภท", TYPE_NAMES[p.type]],
      ["⏱ ชั่วโมงปกติ", hrs(r.reg) + " ชม."], ["⏰ OT", hrs(r.ot) + " ชม."],
      ["💵 ค่าแรง", fmt(r.wage) + " ₩/ชม."], ["💰 รายได้ปกติ", fmt(r.regInc) + " ₩"], ["🌙 รายได้ OT", fmt(r.otInc) + " ₩"]
    ];
    return head("📋", "ตรวจสอบก่อนบันทึก", exists ? "⚠️ วันนี้มีบันทึกอยู่แล้ว — จะอัปเดตทับ" : "", "wot") + steps(4) +
      '<div class="tl-receipt">' + rows.map(function (x) { return '<div class="tl-rrow"><span>' + x[0] + "</span><b>" + x[1] + "</b></div>"; }).join("") +
      '<div class="tl-total"><span>รวม</span><b>' + fmt(r.krw) + ' ₩</b><em>≈ ' + fmt2(thb) + ' ฿</em></div>' +
      '<div class="tl-rrow dim"><span>💱 เรต</span><b>1 KRW = ' + rate.toFixed(4) + " THB</b></div></div>" +
      '<div class="tl-actions"><button type="button" class="tl-primary" data-act="w-save">✅ บันทึก</button>' +
      '<button type="button" class="tl-ghost" data-act="close">ยกเลิก</button></div>';
  }

  function saveWork() {
    var p = S.pend, r = S.calc || calcWork(p.type, p.reg, p.ot, settings()), rate = curRate();
    var rec = { date: p.date, type: r.type, reg: r.reg, ot: r.ot, wage: r.wage, regMul: r.regMul, otMul: r.otMul, regInc: r.regInc, otInc: r.otInc, krw: r.krw, rate: rate, thb: +(r.krw * rate).toFixed(2) };
    var list = records().filter(function (x) { return x.date !== p.date; });
    list.push(rec);
    list.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    store(K_REC, list);
    S.flash = "✅ บันทึกเรียบร้อย · " + thDate(p.date) + " · " + fmt(rec.krw) + " ₩";
    S.pend = null;
    toast(S.flash);
    go("wmenu");
  }

  /* ---------- ปฏิทิน (ย้อนหลัง / ประวัติ) ---------- */
  function vCal() {
    var mode_ = S.calMode, ym = S.calYM, p = parseYM(ym), today = todayStr();
    var recs = {}; records().forEach(function (r) { recs[r.date] = r; });
    var first = new Date(p.y, p.m - 1, 1).getDay(), n = daysIn(ym), cells = "";
    for (var i = 0; i < first; i++) cells += '<i class="tl-day empty"></i>';
    var monthTotal = 0, monthDays = 0;
    for (var day = 1; day <= n; day++) {
      var ds = ym + "-" + pad(day), r = recs[ds], future = mode_ === "add" && ds > today, cls = "tl-day", dot = "";
      if (ds === today) cls += " today";
      if (future) cls += " off";
      if (r) {
        monthDays++; monthTotal += num(r.krw);
        if (dayOfWeek(ds) === 0 || dayOfWeek(ds) === 6) cls += " wknd"; else if (num(r.ot) > 0) cls += " ot"; else cls += " has";
        if (r.type === "day_off") cls += " dayoff";
      }
      cells += '<button type="button" class="' + cls + '" ' + (future ? "disabled" : 'data-act="cal-day" data-v="' + ds + '"') + "><span>" + day + "</span>" + (r ? "<i></i>" : "") + "</button>";
    }
    var nextOk = mode_ === "add" ? addMonth(ym, 1) <= ymOf(today) : true;
    return head(mode_ === "add" ? "🗓" : "📋", mode_ === "add" ? "บันทึกย้อนหลัง" : "ประวัติการทำงาน", mode_ === "add" ? "กดวันที่ที่ต้องการบันทึก" : "กดวันที่เพื่อดู แก้ไข หรือลบ", "wmenu") +
      monthNav(ym, nextOk, "cal") +
      '<div class="tl-dow">' + DOW.map(function (x, i) { return '<span class="' + (i === 0 || i === 6 ? "w" : "") + '">' + x + "</span>"; }).join("") + "</div>" +
      '<div class="tl-cal">' + cells + "</div>" +
      '<div class="tl-legend"><span><i class="lg has"></i>ทำงานปกติ</span><span><i class="lg ot"></i>มี OT</span><span><i class="lg wknd"></i>เสาร์-อาทิตย์</span></div>' +
      (mode_ === "hist" ? '<div class="tl-mini"><span>📊 ' + monthDays + ' วัน</span><b>' + fmt(monthTotal) + ' ₩</b></div>' : "");
  }

  function monthNav(ym, nextOk, key) {
    return '<div class="tl-mnav"><button type="button" data-act="' + key + '-prev" aria-label="เดือนก่อน">‹</button><b>' + ymLabel(ym) + '</b>' +
      '<button type="button" data-act="' + key + '-next" aria-label="เดือนถัดไป"' + (nextOk ? "" : " disabled") + ">›</button></div>";
  }

  function vDetail() {
    var r = records().filter(function (x) { return x.date === S.detailDate; })[0];
    if (!r) return head("📋", "รายละเอียด", "ไม่พบข้อมูล", "wcal") + '<p class="tl-empty">ยังไม่มีข้อมูลการทำงานของวันนี้</p>';
    var rows = [
      ["🏷 ประเภท", TYPE_NAMES[r.type] || r.type], ["⏱ ชั่วโมงปกติ", hrs(r.reg) + " ชม."], ["⏰ OT", hrs(r.ot) + " ชม."],
      ["💵 ค่าแรง", fmt(r.wage) + " ₩/ชม."], ["💰 รายได้ปกติ", fmt(r.regInc) + " ₩"], ["🌙 รายได้ OT", fmt(r.otInc) + " ₩"]
    ];
    var confirm = S.delConfirm;
    return head("📋", "รายละเอียดการทำงาน", "📅 " + thDate(r.date) + " (" + DOW[dayOfWeek(r.date)] + ")", "wcal") +
      '<div class="tl-receipt">' + rows.map(function (x) { return '<div class="tl-rrow"><span>' + x[0] + "</span><b>" + x[1] + "</b></div>"; }).join("") +
      '<div class="tl-total"><span>รวม</span><b>' + fmt(r.krw) + ' ₩</b><em>≈ ' + fmt2(r.thb) + ' ฿</em></div>' +
      '<div class="tl-rrow dim"><span>💱 เรตตอนบันทึก</span><b>1 KRW = ' + num(r.rate).toFixed(4) + " THB</b></div></div>" +
      (confirm
        ? '<div class="tl-warn">⚠️ ยืนยันการลบข้อมูลวันนี้?</div><div class="tl-actions"><button type="button" class="tl-danger" data-act="w-del-yes">🗑 ยืนยันลบ</button><button type="button" class="tl-ghost" data-act="w-del-no">ยกเลิก</button></div>'
        : '<div class="tl-actions"><button type="button" class="tl-primary" data-act="w-edit">✏️ แก้ไข</button><button type="button" class="tl-danger ghost" data-act="w-del">🗑 ลบ</button></div>');
  }

  /* ---------- สรุปรายได้ ---------- */
  function vSummary() {
    var ym = S.sumYM, recs = records().filter(function (r) { return ymOf(r.date) === ym; });
    var ded = deductions().filter(function (x) { return x.ym === ym; });
    var rcv = received()[ym];
    var days = recs.filter(function (r) { return r.type !== "day_off"; }).length;
    var reg = 0, ot = 0, gk = 0, gt = 0;
    recs.forEach(function (r) { reg += num(r.reg); ot += num(r.ot); gk += num(r.krw); gt += num(r.thb); });
    var dk = 0, dt = 0; ded.forEach(function (x) { dk += num(x.krw); dt += num(x.thb); });
    var nk = gk - dk, nt = gt - dt;
    var nextOk = addMonth(ym, 1) <= ymOf(todayStr());

    var h = head("📊", "สรุปรายได้", "", "wmenu") + monthNav(ym, nextOk, "sum");
    h += '<div class="tl-kpis"><div><small>วันทำงาน</small><b>' + days + '</b><em>วัน</em></div><div><small>ชั่วโมงปกติ</small><b>' + hrs(reg) + '</b><em>ชม.</em></div><div><small>OT รวม</small><b>' + hrs(ot) + '</b><em>ชม.</em></div></div>';
    h += '<div class="tl-sec"><h3>💰 รายได้ก่อนหัก</h3><div class="tl-big">' + fmt(gk) + ' <u>₩</u></div><div class="tl-sub">≈ ' + fmt2(gt) + ' ฿</div></div>';

    h += '<div class="tl-sec"><h3>🧾 หักภาษีและสิ่งจำเป็น</h3>';
    if (ded.length) {
      h += '<div class="tl-list">' + ded.map(function (x) {
        return '<div class="tl-li"><div><b>' + esc(x.name) + "</b><small>" + fmt(x.krw) + " ₩ = " + fmt2(x.thb) + ' ฿</small></div><button type="button" class="tl-x" data-act="ded-del" data-v="' + esc(x.id) + '" aria-label="ลบรายการหัก">🗑</button></div>';
      }).join("") + "</div>";
    } else h += '<p class="tl-empty sm">ยังไม่มีรายการหัก</p>';
    h += '<form class="tl-inline" autocomplete="off"><input id="dedName" type="text" maxlength="40" placeholder="ชื่อ เช่น ภาษีท้องถิ่น / ค่าหอพัก"><input id="dedAmt" type="number" inputmode="numeric" min="0" placeholder="จำนวนเงินวอน">' +
      '<button type="button" class="tl-add" data-act="ded-add">➕ เพิ่มรายการหัก</button></form>';
    if (ded.length) h += '<div class="tl-sub">รวมหัก ' + ded.length + " รายการ · " + fmt(dk) + " ₩ ≈ " + fmt2(dt) + " ฿</div>";
    h += "</div>";

    h += '<div class="tl-sec net"><h3>💵 รายได้สุทธิหลังหัก</h3><div class="tl-big">' + fmt(nk) + ' <u>₩</u></div><div class="tl-sub">≈ ' + fmt2(nt) + " ฿</div></div>";

    h += '<div class="tl-sec"><h3>🏦 เงินเดือนที่เข้าบัญชีจริง</h3>';
    if (rcv) {
      var df = num(rcv.krw) - nk, dfT = num(rcv.thb) - nt;
      h += '<div class="tl-big sm">' + fmt(rcv.krw) + ' <u>₩</u></div><div class="tl-sub">≈ ' + fmt2(rcv.thb) + " ฿</div>" +
        '<div class="tl-diff ' + (df > 0 ? "up" : df < 0 ? "down" : "") + '">' + (df > 0 ? "🟢" : df < 0 ? "🔴" : "⚪") + " ส่วนต่างจากที่คำนวณ<b>" + (df > 0 ? "+" : "") + fmt(df) + " ₩ · " + (dfT > 0 ? "+" : "") + fmt2(dfT) + " ฿</b></div>";
    } else h += '<p class="tl-empty sm">ยังไม่ได้กรอก</p>';
    h += '<form class="tl-inline" autocomplete="off"><input id="rcvAmt" type="number" inputmode="numeric" min="0" placeholder="ยอดที่เข้าบัญชีจริง (วอน)" value="' + (rcv ? esc(rcv.krw) : "") + '">' +
      '<button type="button" class="tl-add" data-act="rcv-save">💾 ' + (rcv ? "อัปเดตยอดเงินจริง" : "บันทึกยอดเงินจริง") + "</button></form></div>";
    return h;
  }

  /* ---------- ตั้งค่า ---------- */
  function vSettings() {
    var s = settings();
    var f = function (id, ico, label, val, step, unit) {
      return '<label class="tl-field"><span>' + ico + " " + label + '</span><div class="tl-inp"><input id="' + id + '" type="number" inputmode="decimal" step="' + step + '" min="0" value="' + val + '"><em>' + unit + "</em></div></label>";
    };
    return head("⚙️", "ตั้งค่าการทำงาน", "ใช้คำนวณรายได้ของการบันทึกครั้งต่อไป (ข้อมูลเก่าไม่เปลี่ยน)", "wmenu") +
      '<form class="tl-form" autocomplete="off">' +
      f("sWage", "💵", "ค่าแรง / ชั่วโมง", s.wage, 1, "₩") + f("sNormal", "⏱", "Normal multiplier", s.normal, 0.05, "×") +
      f("sOt", "⏰", "OT multiplier", s.ot, 0.05, "×") + f("sWeekend", "🗓", "Weekend multiplier", s.weekend, 0.05, "×") +
      f("sHoliday", "🎌", "Holiday multiplier", s.holiday, 0.05, "×") +
      '<div class="tl-actions"><button type="button" class="tl-primary" data-act="set-save">💾 บันทึกการตั้งค่า</button><button type="button" class="tl-ghost" data-act="set-reset">↺ ค่าเริ่มต้น</button></div></form>';
  }

  /* =========================================================
     EXPENSE (วอน / บาท)
     ========================================================= */
  function vExpense() {
    var isK = S.cur === "KRW";
    return head("💸", "บันทึกรายจ่าย", isK ? "บันทึกเป็นเงินวอน · แสดงเรตไทยโดยประมาณ" : "บันทึกเป็นเงินบาท") +
      '<div class="tl-cur ' + (isK ? "k" : "t") + '"><b>' + (isK ? "₩ วอน" : "฿ บาท") + "</b><small>" + (isK ? "1 KRW = " + curRate().toFixed(4) + " THB" : "THB") + "</small></div>" +
      '<form class="tl-form ex-form" id="exForm" autocomplete="off"></form>' +
      '<div class="tl-card2"><div class="tl-seg" role="tablist" id="exSeg" data-on="' + S.ex.tab + '">' +
      '<button type="button" role="tab" data-act="ex-tab" data-v="summary" class="' + (S.ex.tab === "summary" ? "on" : "") + '">📋 รายการรายจ่าย</button>' +
      '<button type="button" role="tab" data-act="ex-tab" data-v="history" class="' + (S.ex.tab === "history" ? "on" : "") + '">🧾 ประวัติรายจ่าย</button><i class="tl-seg-pill"></i></div>' +
      '<div id="exMonth"></div><div id="exList"></div></div>';
  }

  function catOptions(sel) {
    var cats = typeof kfpLoadAlloc === "function" ? kfpLoadAlloc() : [];
    return '<option value="">— ไม่ผูก —</option>' + cats.map(function (c) {
      return '<option value="' + esc(c.id) + '"' + (sel === c.id ? " selected" : "") + ">" + esc(c.emoji + " " + c.name + " " + (window.kfpPctText ? kfpPctText(c.pct) : c.pct) + "%") + "</option>";
    }).join("");
  }

  function fillExpenseForm() {
    var form = $("exForm"); if (!form) return;
    var isK = S.cur === "KRW", e = S.ex.editing ? expenses().filter(function (x) { return x.id === S.ex.editing; })[0] : null;
    form.innerHTML =
      '<label class="tl-field"><span>📝 ชื่อรายการ</span><input id="exName" type="text" maxlength="60" placeholder="เช่น ค่าอาหาร / ค่าเดินทาง" value="' + (e ? esc(e.name) : "") + '"></label>' +
      '<label class="tl-field"><span>' + (isK ? "₩ จำนวนเงิน (วอน)" : "฿ จำนวนเงิน (บาท)") + '</span><div class="tl-inp"><input id="exAmt" type="number" inputmode="decimal" min="0" step="' + (isK ? "1" : "0.01") + '" placeholder="' + (isK ? "เช่น 15000" : "เช่น 250") + '" value="' + (e ? esc(e.amt) : "") + '"><em>' + (isK ? "₩" : "฿") + "</em></div></label>" +
      (isK ? '<div class="tl-approx" id="exApprox">≈ 0.00 ฿ <small>(เรต ' + curRate().toFixed(4) + ")</small></div>" : "") +
      '<label class="tl-field"><span>🔗 หักจากการ์ดใน “📊 สถิติการเงิน”</span><select id="exCat">' + catOptions(e ? e.cat : "") + "</select></label>" +
      '<p class="tl-hint left" id="exCatHint"></p>' +
      '<div class="tl-actions' + (e ? "" : " one") + '"><button type="button" class="tl-primary" data-act="ex-save">' + (e ? "💾 บันทึกการแก้ไข" : "➕ บันทึกรายจ่าย") + "</button>" +
      (e ? '<button type="button" class="tl-ghost" data-act="ex-cancel">ยกเลิกแก้ไข</button>' : "") + "</div>";
    updateApprox();
  }

  function updateApprox() {
    var isK = S.cur === "KRW", amt = num(($("exAmt") || {}).value);
    var a = $("exApprox"); if (a) a.innerHTML = "≈ " + fmt2(amt * curRate()) + " ฿ <small>(เรต " + curRate().toFixed(4) + ")</small>";
    var sel = $("exCat"), hint = $("exCatHint");
    if (hint && sel) hint.textContent = sel.value ? "จะหัก " + (amt > 0 ? (isK ? fmt(amt) + " KRW (≈ " + fmt(amt * curRate()) + " THB)" : fmt2(amt) + " THB") : "ยอดนี้") + " ออกจากการ์ดที่เลือก" : "ไม่ผูก = ไม่กระทบยอดเงินเก็บ";
  }

  function monthExpenses() {
    return expenses().filter(function (e) { return e.cur === S.cur && ymOf(e.date) === S.ex.month; })
      .sort(function (a, b) { return a.date === b.date ? (a.ts || 0) - (b.ts || 0) : (a.date < b.date ? -1 : 1); });
  }

  function renderExpenseList() {
    var ex = S.ex, isK = S.cur === "KRW", list = monthExpenses();
    var nextOk = addMonth(ex.month, 1) <= ymOf(todayStr());
    $("exMonth").innerHTML = monthNav(ex.month, nextOk, "exm");
    var seg = $("exSeg"); if (seg) { seg.setAttribute("data-on", ex.tab); [].forEach.call(seg.querySelectorAll("button"), function (b) { b.classList.toggle("on", b.dataset.v === ex.tab); }); }
    var tk = 0, tt = 0; list.forEach(function (e) { tk += num(e.krw); tt += num(e.thb); });
    var h = "";
    if (ex.tab === "summary") {
      h += '<div class="tl-sumcard"><div class="tl-kpis two"><div><small>ทั้งหมด</small><b>' + list.length + '</b><em>รายการ</em></div>' +
        '<div><small>รวมเป็น' + (isK ? "เงินวอน" : "เงินบาท") + '</small><b>' + (isK ? fmt(tk) : fmt2(tt)) + '</b><em>' + (isK ? "₩" : "฿") + "</em></div></div>" +
        (isK ? '<div class="tl-sumthb">🇹🇭 ≈ <b>' + fmt2(tt) + "</b> บาท</div>" : "") + "</div>";
      var byCat = {}; list.forEach(function (e) { if (e.cat) byCat[e.cat] = (byCat[e.cat] || 0) + (isK ? num(e.krw) : num(e.thb)); });
      var cats = typeof kfpLoadAlloc === "function" ? kfpLoadAlloc() : [], lines = "";
      cats.forEach(function (c, i) { if (byCat[c.id]) lines += '<div class="tl-catrow" style="--ac:' + kfpCatRgb(i) + '"><i></i><span>' + esc(c.emoji + " " + c.name) + "</span><b>− " + (isK ? fmt(byCat[c.id]) + " ₩" : fmt2(byCat[c.id]) + " ฿") + "</b></div>"; });
      if (lines) h += '<div class="tl-sec"><h3>🔗 หักจากสถิติการเงินแล้ว</h3>' + lines + "</div>";
      if (!list.length) h += '<p class="tl-empty">ยังไม่มีรายจ่ายใน' + ymLabel(ex.month) + "</p>";
    } else {
      if (!list.length) h += '<p class="tl-empty">ยังไม่มีรายจ่ายใน' + ymLabel(ex.month) + "</p>";
      else {
        var cats2 = typeof kfpLoadAlloc === "function" ? kfpLoadAlloc() : [];
        h += '<div class="tl-list ex">' + list.slice().reverse().map(function (e, i) {
          var ci = -1, c = cats2.filter(function (x, k) { if (x.id === e.cat) { ci = k; return true; } return false; })[0];
          var del = ex.delId === e.id;
          return '<div class="tl-li ex' + (ex.editing === e.id ? " editing" : "") + '" style="--n:' + i + '">' +
            '<div class="tl-li-main"><b>' + esc(e.name || "-") + "</b><small>📅 " + thDate(e.date) + "</small>" +
            (c ? '<span class="tl-tag" style="--ac:' + kfpCatRgb(ci) + '">🔗 ' + esc(c.emoji + " " + c.name) + "</span>" : "") + "</div>" +
            '<div class="tl-li-amt"><b>' + (isK ? fmt(e.amt) + " ₩" : fmt2(e.amt) + " ฿") + "</b>" + (isK ? "<small>≈ " + fmt2(e.thb) + " ฿</small>" : "") + "</div>" +
            (del
              ? '<div class="tl-li-act confirm"><button type="button" class="tl-danger sm" data-act="ex-del-yes" data-v="' + esc(e.id) + '">ลบ?</button><button type="button" class="tl-ghost sm" data-act="ex-del-no">ไม่</button></div>'
              : '<div class="tl-li-act"><button type="button" class="tl-x" data-act="ex-edit" data-v="' + esc(e.id) + '" aria-label="แก้ไข">✏️</button><button type="button" class="tl-x" data-act="ex-del" data-v="' + esc(e.id) + '" aria-label="ลบ">🗑</button></div>') +
            "</div>";
        }).join("") + "</div>";
      }
    }
    $("exList").innerHTML = h;
  }

  function saveExpense() {
    var name = ($("exName").value || "").trim(), amt = num($("exAmt").value), isK = S.cur === "KRW", rate = curRate();
    if (!name) { toast("⚠️ กรุณาใส่ชื่อรายการ", "warn"); $("exName").focus(); return; }
    if (!(amt > 0)) { toast("⚠️ กรุณาใส่จำนวนเงินให้ถูกต้อง", "warn"); $("exAmt").focus(); return; }
    var cat = $("exCat").value || "";
    var all = expenses(), ex = S.ex;
    var rec;
    if (ex.editing) {
      rec = all.filter(function (x) { return x.id === ex.editing; })[0];
      if (!rec) { ex.editing = null; return; }
      // เรต: ถ้าจำนวนเงินเปลี่ยนใช้เรตล่าสุด · ถ้าไม่เปลี่ยนคงเรตเดิมที่บันทึกไว้
      if (num(rec.amt) !== amt || !(rec.rate > 0)) rec.rate = rate;
      rec.name = name; rec.cat = cat;
    } else {
      rec = { id: uid(), ts: Date.now(), cur: S.cur, name: name, cat: cat, date: todayStr(), rate: rate };
      all.push(rec);
    }
    var r = rec.rate;
    if (isK) { rec.amt = Math.round(amt); rec.krw = rec.amt; rec.thb = +(rec.amt * r).toFixed(2); }
    else { rec.amt = +amt.toFixed(2); rec.thb = rec.amt; rec.krw = Math.round(rec.amt / r); }
    store(K_EXP, all);
    var wasEdit = !!ex.editing;
    ex.editing = null; ex.delId = null;
    var m = ymOf(rec.date); if (m !== ex.month) ex.month = m;
    fillExpenseForm(); renderExpenseList(); refreshStats();
    toast(wasEdit ? "✅ แก้ไขรายการแล้ว" : "✅ บันทึกรายจ่ายแล้ว");
    var nm = $("exName"); if (nm && !wasEdit) nm.focus({ preventScroll: true });
  }

  /* =========================================================
     Events
     ========================================================= */
  function onInput(e) {
    var id = e.target.id;
    if (id === "exAmt" || id === "exCat") updateApprox();
  }

  function startPending(date, backTo) {
    var ex = records().filter(function (r) { return r.date === date; })[0];
    S.pend = { date: date, type: ex ? ex.type : "normal", reg: ex ? num(ex.reg) : 8, ot: ex ? num(ex.ot) : 0 };
    S.backTo = backTo || "wmenu";
    go("wtype");
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function onClick(e) {
    var t = e.target.closest("[data-act],[data-go]"); if (!t || !panel.contains(t)) return;
    if (t.dataset.go) { S.delConfirm = false; go(t.dataset.go); return; }
    var a = t.dataset.act, v = t.dataset.v, p = S.pend;
    switch (a) {
      case "close": close(); break;
      /* เมนูงาน */
      case "m-today": startPending(todayStr(), "wmenu"); break;
      case "m-past": go("wcal", { calMode: "add", calYM: ymOf(todayStr()) }); break;
      case "m-hist": go("wcal", { calMode: "hist", calYM: ymOf(todayStr()) }); break;
      case "m-sum": go("wsum", { sumYM: ymOf(todayStr()) }); break;
      case "m-set": go("wset"); break;
      case "type":
        p.type = v;
        if (v === "day_off") { p.reg = 0; p.ot = 0; go("wconfirm"); }
        else { if (!p.reg) p.reg = 8; go("whours"); }
        break;
      case "h-set": p.reg = +v; render(); break;
      case "h-adj": p.reg = clamp(Math.round((p.reg + +v) * 10) / 10, 0, 24); render(); break;
      case "h-next": go("wot"); break;
      case "o-set": p.ot = +v; render(); break;
      case "o-adj": p.ot = clamp(Math.round((p.ot + +v) * 10) / 10, 0, 24); render(); break;
      case "o-next": go("wconfirm"); break;
      case "w-save": saveWork(); break;
      case "cal-prev": S.calYM = addMonth(S.calYM, -1); render(); break;
      case "cal-next": S.calYM = addMonth(S.calYM, 1); render(); break;
      case "cal-day":
        if (S.calMode === "add") startPending(v, "wcal");
        else { S.detailDate = v; S.delConfirm = false; if (records().some(function (r) { return r.date === v; })) go("wdetail"); else toast("วันนี้ยังไม่มีบันทึก"); }
        break;
      case "w-edit": startPending(S.detailDate, "wdetail"); break;
      case "w-del": S.delConfirm = true; render(); break;
      case "w-del-no": S.delConfirm = false; render(); break;
      case "w-del-yes":
        store(K_REC, records().filter(function (r) { return r.date !== S.detailDate; }));
        S.delConfirm = false; toast("🗑 ลบข้อมูลการทำงานแล้ว"); go("wcal"); break;
      /* สรุป */
      case "sum-prev": S.sumYM = addMonth(S.sumYM, -1); render(); break;
      case "sum-next": S.sumYM = addMonth(S.sumYM, 1); render(); break;
      case "ded-add": {
        var nm = ($("dedName").value || "").trim(), am = Math.round(num($("dedAmt").value));
        if (!nm) { toast("⚠️ กรุณาใส่ชื่อรายการหัก", "warn"); $("dedName").focus(); break; }
        if (!(am > 0)) { toast("⚠️ กรุณาใส่จำนวนเงิน", "warn"); $("dedAmt").focus(); break; }
        var rt = curRate(), list = deductions(); list.push({ id: uid(), ym: S.sumYM, name: nm, krw: am, rate: rt, thb: +(am * rt).toFixed(2) });
        store(K_DED, list); toast("✅ เพิ่มรายการหักแล้ว"); render(); break;
      }
      case "ded-del": store(K_DED, deductions().filter(function (x) { return x.id !== v; })); toast("🗑 ลบรายการหักแล้ว"); render(); break;
      case "rcv-save": {
        var rv = Math.round(num($("rcvAmt").value));
        if (!(rv > 0)) { toast("⚠️ กรุณาใส่ยอดเงินที่เข้าบัญชี", "warn"); $("rcvAmt").focus(); break; }
        var rc = received(), rr = curRate(); rc[S.sumYM] = { krw: rv, rate: rr, thb: +(rv * rr).toFixed(2) };
        store(K_RCV, rc); toast("✅ บันทึกยอดเงินจริงแล้ว"); render(); break;
      }
      /* ตั้งค่า */
      case "set-save": {
        var ns = { wage: Math.round(num($("sWage").value)), normal: num($("sNormal").value), ot: num($("sOt").value), weekend: num($("sWeekend").value), holiday: num($("sHoliday").value) };
        if (!(ns.wage > 0) || !(ns.normal > 0) || !(ns.ot > 0) || !(ns.weekend > 0) || !(ns.holiday > 0)) { toast("⚠️ ทุกช่องต้องมากกว่า 0", "warn"); break; }
        store(K_SET, ns); toast("✅ บันทึกการตั้งค่าแล้ว"); go("wmenu"); break;
      }
      case "set-reset": store(K_SET, DEFAULT_SET); toast("↺ คืนค่าเริ่มต้นแล้ว"); render(); break;
      /* รายจ่าย */
      case "ex-tab": S.ex.tab = v; S.ex.delId = null; renderExpenseList(); break;
      case "exm-prev": S.ex.month = addMonth(S.ex.month, -1); S.ex.delId = null; renderExpenseList(); break;
      case "exm-next": S.ex.month = addMonth(S.ex.month, 1); S.ex.delId = null; renderExpenseList(); break;
      case "ex-save": saveExpense(); break;
      case "ex-cancel": S.ex.editing = null; fillExpenseForm(); renderExpenseList(); break;
      case "ex-edit":
        S.ex.editing = v; S.ex.delId = null; fillExpenseForm(); renderExpenseList();
        var f = $("exForm"); if (f) f.scrollIntoView({ block: "center", behavior: "smooth" });
        break;
      case "ex-del": S.ex.delId = v; renderExpenseList(); break;
      case "ex-del-no": S.ex.delId = null; renderExpenseList(); break;
      case "ex-del-yes":
        store(K_EXP, expenses().filter(function (x) { return x.id !== v; }));
        if (S.ex.editing === v) S.ex.editing = null;
        S.ex.delId = null; fillExpenseForm(); renderExpenseList(); refreshStats(); toast("🗑 ลบรายการแล้ว"); break;
    }
  }

  /* ---------- toast ---------- */
  var toastEl = null, toastT = 0;
  function toast(msg, kind) {
    if (!toastEl) { toastEl = d.createElement("div"); toastEl.className = "tl-toast"; toastEl.setAttribute("role", "status"); toastEl.setAttribute("aria-live", "polite"); d.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.className = "tl-toast show " + (kind || "");
    clearTimeout(toastT); toastT = setTimeout(function () { toastEl.classList.remove("show"); }, 2300);
  }

  /* ---------- ปุ่มบนการ์ดเงินเดือน ---------- */
  d.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-open-tool]"); if (!b) return;
    var k = b.getAttribute("data-open-tool");
    if (k === "work") { if (mode() === "KRW") open("work"); }
    else open("expense", mode() === "THB" ? "THB" : "KRW");
  });

  // หลังดึงข้อมูลจาก Cloud
  var prevRefresh = window.__kfpRefreshFromCloud;
  window.__kfpRefreshFromCloud = function () { if (typeof prevRefresh === "function") prevRefresh.apply(this, arguments); try { window.kfpExpenseDecorate(); } catch (_) {} };

  window.kfpOpenTool = function (k) { var b = d.querySelector('[data-open-tool="' + k + '"]'); if (b) b.click(); };
  window.addEventListener("load", function () { try { window.kfpExpenseDecorate(); } catch (_) {} });
})();
