/* PLANNER navigation — Liquid Glass tab bar (mobile) + sidebar (desktop).
 * <script src="planner-nav.js" data-active="home|gold|debt|account|none" defer></script>
 * Pure UI: links to the existing pages, never touches data or calculations.
 *   - tap an item → the gold lens springs to it, then the page changes (cross-fade via View Transitions)
 *   - press and slide along the bar → the lens follows your finger; release to open that page
 *   - "+" opens quick actions (expense / attendance / gold round / card payment) */
(function () {
  "use strict";
  if (window.__plannerNav) return; window.__plannerNav = true;
  var me = document.currentScript;
  var ACTIVE = (me && me.dataset.active) || "none";
  var SPRITE = "assets/icons/planner-icons.svg";
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var ITEMS = [
    { k: "home", href: "index.html", icon: "home", label: "หน้าหลัก" },
    { k: "gold", href: "gold.html", icon: "gold", label: "ทองคำ", lock: true },
    { k: "debt", href: "credit-debt.html", icon: "card", label: "บัตร·หนี้", side: "บัตรเครดิต·หนี้", lock: true },
    { k: "account", href: "account.html", icon: "user", label: "บัญชี" }
  ];
  var QUICK = [
    { q: "expense", icon: "receipt", t: "บันทึกรายจ่าย", s: "฿ หรือ ₩ ผูกกับการ์ดแบ่งเงิน" },
    { q: "work", icon: "attendance", t: "บันทึกการเข้างาน", s: "ชั่วโมงปกติ · OT · วันหยุด", tier: "PLUS" },
    { q: "gold", icon: "gold", t: "บันทึกรอบซื้อทอง", s: "น้ำหนัก · ราคา · ต้นทุน", tier: "PREMIUM" },
    { q: "pay", icon: "coins", t: "บันทึกชำระบัตร / หนี้", s: "ตัดยอดบัตรหรือค่างวด", tier: "PREMIUM" }
  ];
  var FEAT = { work: "work_records", gold: "gold_portfolio", pay: "credit_debt" };

  function ico(name, cls) { return '<svg class="pi' + (cls ? " " + cls : "") + '" aria-hidden="true" focusable="false"><use href="' + SPRITE + "#pi-" + name + '"/></svg>'; }
  window.plannerIcon = ico;

  function item(it, side) {
    var cur = it.k === ACTIVE ? ' aria-current="page"' : "";
    return '<a class="pn-item" draggable="false" data-k="' + it.k + '" href="' + it.href + '"' + cur + ">" + ico(it.icon) + "<span>" + (side && it.side || it.label) + "</span>" +
      (it.lock ? '<i class="pn-lock" title="ฟีเจอร์ Premium">' + ico("lock") + "</i>" : "") + "</a>";
  }

  function build() {
    if (document.querySelector(".pn")) return;
    document.body.classList.add("pn-on");
    var bar = document.createElement("nav");
    bar.className = "pn"; bar.setAttribute("aria-label", "เมนูหลัก");
    bar.innerHTML = '<div class="pn-bar pn-glass"><span class="pn-lens' + (ACTIVE === "none" ? " pn-none" : "") + '" aria-hidden="true"></span>' +
      ITEMS.map(function (it) { return item(it, false); }).join("") + "</div>" +
      '<button type="button" class="pn-add pn-glass" aria-label="บันทึกด่วน" aria-haspopup="true" aria-expanded="false" aria-controls="pnSheet">' + ico("plus") + "</button>";
    var side = document.createElement("aside");
    side.className = "pn-side pn-glass"; side.setAttribute("aria-label", "เมนูหลัก");
    side.innerHTML = '<a class="pn-brand" href="index.html"><img src="assets/brand/planner-logo-sm.png" alt="" width="360" height="291"><span><b>PLANNER</b><small>Personal Finance Control Center</small></span></a>' +
      '<button type="button" class="pn-side-add" aria-haspopup="true" aria-expanded="false" aria-controls="pnSheet">' + ico("plus", "pi-sm") + "บันทึกด่วน</button>" +
      '<nav class="pn-list" aria-label="หน้า"><span class="pn-lens' + (ACTIVE === "none" ? " pn-none" : "") + '" aria-hidden="true"></span>' + ITEMS.map(function (it) { return item(it, true); }).join("") + "</nav>" +
      '<div class="pn-foot"><a class="pn-item" href="pricing.html"' + (ACTIVE === "pricing" ? ' aria-current="page"' : "") + ">" + ico("crown", "pi-sm") + "<span>แพ็กเกจและราคา</span></a>" +
      '<a class="pn-item" href="showcase.html">' + ico("sparkle", "pi-sm") + "<span>รู้จัก PLANNER</span></a></div>";
    var scrim = document.createElement("div"); scrim.className = "pn-scrim";
    var sheet = document.createElement("div");
    sheet.className = "pn-sheet pn-glass"; sheet.id = "pnSheet"; sheet.setAttribute("role", "menu"); sheet.setAttribute("aria-label", "บันทึกด่วน");
    sheet.innerHTML = "<h2>บันทึกด่วน</h2>" + QUICK.map(function (a) {
      return '<button type="button" role="menuitem" class="pn-act" data-q="' + a.q + '"><span class="pn-act-ico">' + ico(a.icon) + "</span><span><b>" + a.t + "</b><small>" + a.s + "</small></span>" +
        (a.tier ? '<span class="pn-tier">' + a.tier + "</span>" : "") + "</button>";
    }).join("");
    var spacer = document.createElement("div"); spacer.className = "pn-spacer"; spacer.setAttribute("aria-hidden", "true");
    document.body.appendChild(spacer); document.body.appendChild(scrim); document.body.appendChild(sheet); document.body.appendChild(side); document.body.appendChild(bar);

    wireBar(bar.querySelector(".pn-bar"));
    wireList(side.querySelector(".pn-list"));
    wireSheet(sheet, scrim, [bar.querySelector(".pn-add"), side.querySelector(".pn-side-add")]);
    handleQuickHash();
  }

  /* ---------- navigation with a visible spring before the page changes ---------- */
  function go(href, delay) {
    if (reduce || !delay) { location.href = href; return; }
    setTimeout(function () { location.href = href; }, delay);
  }
  function modified(e) { return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1; }

  /* ---------- bottom bar: lens + press-and-slide ---------- */
  function wireBar(bar) {
    var lens = bar.querySelector(".pn-lens"), items = [].slice.call(bar.querySelectorAll(".pn-item"));
    function rectOf(el) { return { x: el.offsetLeft, w: el.offsetWidth }; }
    function place(el, x) {
      if (!el && x == null) return;
      var r = el ? rectOf(el) : null, w = r ? r.w : items[0].offsetWidth;
      var lx = x != null ? Math.max(5, Math.min(bar.clientWidth - w - 5, x - w / 2)) : r.x;
      bar.style.setProperty("--lw", w + "px"); bar.style.setProperty("--lx", lx + "px");
      lens.style.setProperty("--lw", w + "px"); lens.style.setProperty("--lx", lx + "px");
    }
    function current() { return items.filter(function (i) { return i.getAttribute("aria-current") === "page"; })[0]; }
    function hot(el) { items.forEach(function (i) { i.classList.toggle("pn-hot", i === el); }); }
    function at(clientX) {
      var best = null, bd = 1e9; items.forEach(function (i) { var r = i.getBoundingClientRect(), d = Math.abs(clientX - (r.left + r.width / 2)); if (d < bd) { bd = d; best = i; } });
      return best;
    }
    // first paint: no transition, then spring from now on
    lens.style.transition = "none"; place(current()); void lens.offsetWidth; lens.style.transition = "";
    window.addEventListener("resize", function () { lens.style.transition = "none"; place(current()); void lens.offsetWidth; lens.style.transition = ""; });

    var drag = null;
    bar.addEventListener("pointerdown", function (e) {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      var t = e.target.closest(".pn-item"); if (!t) return;
      drag = { id: e.pointerId, x0: e.clientX, moved: false, start: t };
      bar.classList.add("pn-press"); lens.classList.remove("pn-none"); hot(t);
      try { bar.setPointerCapture(e.pointerId); } catch (_) {}
    });
    bar.addEventListener("pointermove", function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.moved && Math.abs(e.clientX - drag.x0) < 8) return;
      if (!drag.moved) { drag.moved = true; bar.classList.add("pn-drag"); }
      var br = bar.getBoundingClientRect();
      place(null, e.clientX - br.left); hot(at(e.clientX));
    });
    function end(e, cancel) {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      var target = cancel ? current() : (drag.moved ? at(e.clientX) : drag.start), was = drag.moved;
      bar.classList.remove("pn-press", "pn-drag"); drag = null;
      if (!target) { hot(null); lens.classList.toggle("pn-none", ACTIVE === "none"); return; }
      place(target); hot(target);
      if (cancel) { hot(null); return; }
      if (target.getAttribute("aria-current") === "page") { setTimeout(function () { hot(null); }, 260); if (was) bar._skipClick = true; return; }
      bar._skipClick = true; go(target.href, 260);
    }
    bar.addEventListener("pointerup", function (e) { end(e, false); });
    bar.addEventListener("pointercancel", function (e) { end(e, true); });
    bar.addEventListener("click", function (e) {
      var t = e.target.closest(".pn-item"); if (!t) return;
      if (modified(e)) return;
      e.preventDefault();
      if (bar._skipClick) { bar._skipClick = false; return; }
      // keyboard / assistive tech activation (no pointer sequence)
      place(t); hot(t);
      if (t.getAttribute("aria-current") !== "page") go(t.href, 220);
    });
  }

  /* ---------- sidebar: vertical lens follows hover, springs on click ---------- */
  function wireList(list) {
    var lens = list.querySelector(".pn-lens"), items = [].slice.call(list.querySelectorAll(".pn-item"));
    function place(el) { if (!el) return; lens.style.setProperty("--ly", el.offsetTop + "px"); lens.style.setProperty("--lh", el.offsetHeight + "px"); }
    var cur = items.filter(function (i) { return i.getAttribute("aria-current") === "page"; })[0];
    function reset() { if (cur) place(cur); else lens.classList.add("pn-none"); }
    lens.style.transition = "none"; reset(); void lens.offsetWidth; lens.style.transition = "";
    // the sidebar is display:none on phones → measure again once it shows
    if (window.matchMedia) { var mq = matchMedia("(min-width:1024px)"); var f = function () { lens.style.transition = "none"; reset(); void lens.offsetWidth; lens.style.transition = ""; }; mq.addEventListener ? mq.addEventListener("change", f) : mq.addListener(f); }
    items.forEach(function (i) {
      i.addEventListener("pointerenter", function () { lens.classList.remove("pn-none"); place(i); });
      i.addEventListener("focus", function () { lens.classList.remove("pn-none"); place(i); });
      i.addEventListener("click", function (e) {
        if (modified(e) || i.getAttribute("aria-current") === "page") { if (!modified(e)) e.preventDefault(); return; }
        e.preventDefault(); place(i); go(i.href, 200);
      });
    });
    list.addEventListener("pointerleave", reset);
    list.addEventListener("focusout", function (e) { if (!list.contains(e.relatedTarget)) reset(); });
  }

  /* ---------- quick-add sheet ---------- */
  function wireSheet(sheet, scrim, openers) {
    var opener = null;
    function open(btn) {
      syncWork(sheet); opener = btn; sheet.classList.add("on"); scrim.classList.add("on");
      openers.forEach(function (b) { b.setAttribute("aria-expanded", "true"); });
      var first = sheet.querySelector(".pn-act"); if (first) setTimeout(function () { first.focus({ preventScroll: true }); }, 60);
    }
    function close(back) {
      sheet.classList.remove("on"); scrim.classList.remove("on");
      openers.forEach(function (b) { b.setAttribute("aria-expanded", "false"); });
      if (back && opener) opener.focus({ preventScroll: true });
    }
    openers.forEach(function (b) { b.addEventListener("click", function () { sheet.classList.contains("on") ? close(true) : open(b); }); });
    scrim.addEventListener("click", function () { close(true); });
    document.addEventListener("keydown", function (e) {
      if (!sheet.classList.contains("on")) return;
      if (e.key === "Escape") { close(true); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        var acts = [].slice.call(sheet.querySelectorAll(".pn-act")), i = acts.indexOf(document.activeElement);
        acts[(i + (e.key === "ArrowDown" ? 1 : acts.length - 1)) % acts.length].focus(); e.preventDefault();
      }
    });
    sheet.addEventListener("click", function (e) {
      var a = e.target.closest(".pn-act"); if (!a) return;
      close(false); quick(a.getAttribute("data-q"));
    });
  }
  // attendance logging is a Korea (₩) feature: hide it for baht-only users (same rule as the app's ₩/฿ switch)
  function thbOnly() {
    var m = document.documentElement.getAttribute("data-mode");
    if (m === "THB" || m === "KRW") return m === "THB";
    try { return localStorage.getItem("kfp_mode_v1") === "THB"; } catch (_) { return false; }
  }
  function syncWork(sheet) { var w = sheet.querySelector('[data-q="work"]'); if (w) w.hidden = thbOnly(); }
  function locked(q) {
    var f = FEAT[q]; if (!f) return false;
    return document.documentElement.getAttribute("data-feat-" + f) === "0";
  }
  function quick(q) {
    var P = window.kfpPlan;
    if (locked(q) && P && P.requireFeature) { P.requireFeature(FEAT[q]); return; }
    if (q === "expense" || q === "work") {
      if (ACTIVE === "home" && typeof window.kfpOpenTool === "function") { window.kfpOpenTool(q); return; }
      go("index.html#quick=" + q, 0); return;
    }
    if (q === "gold") { if (ACTIVE === "gold") { focusLot(); return; } go("gold.html#quick=gold", 0); return; }
    if (q === "pay") { go("credit-debt.html#quick=pay", 0); return; }
  }
  function focusLot() {
    var f = document.getElementById("lotForm"); if (!f || !f.offsetParent) return;
    f.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    var inp = f.querySelector("input:not([type=hidden]),select"); if (inp) setTimeout(function () { inp.focus({ preventScroll: true }); }, reduce ? 0 : 450);
  }
  function handleQuickHash() {
    var m = /quick=(expense|work|gold)/.exec(location.hash || ""); if (!m) return;
    var q = m[1];
    try { history.replaceState(null, "", location.pathname + location.search); } catch (_) {}
    var tries = 0;
    (function wait() {   // the page's own scripts (tools / gold) finish wiring after DOMContentLoaded
      tries++;
      if (q === "gold") { if (document.getElementById("lotForm") && document.documentElement.getAttribute("data-plan-state") !== "loading") return focusLot(); }
      else if (typeof window.kfpOpenTool === "function" && document.documentElement.getAttribute("data-plan-state") !== "loading") return quick(q);
      if (tries < 40) setTimeout(wait, 150);
    })();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build); else build();
})();
