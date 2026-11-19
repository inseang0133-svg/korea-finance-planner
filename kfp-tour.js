/* kfp-tour.js — PLANNER Guided Tour engine · first-visit welcome · help centre ("วิธีใช้งานเว็บไซต์")
 *
 * Pure UI. A tour never writes the person's data: it only highlights the real element, opens tabs /
 * pop-ups that the page already has, and explains. The only thing stored is which tours were finished
 * or skipped:
 *   members → per-account key "kfp_tour_v1" (namespaced by kfp-storage.js; travels with Cloud Sync)
 *   guests  → "kfp_tour_guest_v1" on this device
 * Never used for permissions — plan/feature checks always come from the server (kfp-access.js).
 *
 * Content (titles, steps, formulas) lives in kfp-tours.js and is loaded only when needed.
 *
 *   KfpTour.register({ id, title, desc, icon, page, steps:[step…], cleanup(ctx) })
 *   step = { target | union, title, text, facts, formula, example, flow, note, section, placement,
 *            before(ctx), after(ctx), when(ctx), interactive, advanceWhen(ctx), optional, page, center }
 *   KfpTour.start(id) · KfpTour.openHelp() · KfpTour.stop()
 *   <button data-tour-open="help|<tourId>"> anywhere opens the help centre / a tour.
 */
(function () {
  "use strict";
  if (window.KfpTour) return;
  var d = document, w = window, html = d.documentElement;
  var me = d.currentScript;
  var VER = ((me && /[?&]v=([^&]+)/.exec(me.src)) || [])[1] || "";
  var SPRITE = "assets/icons/planner-icons.svg";
  var RUN_KEY = "kfp_tour_run_v1";                 // sessionStorage: tour in progress (survives page changes)
  var KEY_MEMBER = "kfp_tour_v1", KEY_GUEST = "kfp_tour_guest_v1";
  var PAGES = { home: "index.html", gold: "gold.html", debt: "credit-debt.html", account: "account.html", pricing: "pricing.html" };
  var PAGE_NAME = { home: "หน้าหลัก", gold: "ทองคำ", debt: "บัตร·หนี้", account: "บัญชี", pricing: "แพ็กเกจ" };
  var PAGE = (function () {
    var f = (location.pathname.split("/").pop() || "index.html").toLowerCase();
    for (var k in PAGES) if (PAGES[k] === f) return k;
    return f === "" ? "home" : "other";
  })();
  var reduce = !!(w.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  var TOURS = {}, ORDER = [];

  /* ------------------------------------------------------------ utils */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function ico(name, cls) { return '<svg class="pi' + (cls ? " " + cls : "") + '" aria-hidden="true" focusable="false"><use href="' + SPRITE + "#pi-" + name + '"/></svg>'; }
  function val(x, ctx) { return typeof x === "function" ? x(ctx) : x; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function fmt(n, dp) { n = Number(n) || 0; return n.toLocaleString("en-US", { minimumFractionDigits: dp || 0, maximumFractionDigits: dp || 0 }); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function emit(type, detail) { try { w.dispatchEvent(new CustomEvent("kfp:tour", { detail: Object.assign({ type: type }, detail || {}) })); } catch (_) {} }
  function visible(el) {
    if (!el || !el.isConnected) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.02;
  }
  function firstVisible(sel) {
    var list = []; try { list = d.querySelectorAll(sel); } catch (_) { return null; }
    for (var i = 0; i < list.length; i++) if (visible(list[i])) return list[i];
    return null;
  }

  /* ------------------------------------------------------------ remembered state */
  function store() {
    var KS = w.kfpStorage, member = !!(KS && KS.isMember && KS.isMember());
    return member ? { ls: w.localStorage, key: KEY_MEMBER } : { ls: w.__kfpRealLocalStorage || w.localStorage, key: KEY_GUEST };
  }
  function readState() {
    var st = store();
    try { var s = JSON.parse(st.ls.getItem(st.key) || "null"); if (s && s.v === 1 && s.tours) return s; } catch (_) {}
    return { v: 1, welcome: null, tours: {} };
  }
  function writeState(s) { var st = store(); try { st.ls.setItem(st.key, JSON.stringify(s)); } catch (_) {} }
  function mark(id, status, extra) {
    var s = readState(); s.tours[id] = Object.assign({ status: status, at: Date.now() }, extra || {}); writeState(s);
  }
  function setWelcome(v) { var s = readState(); s.welcome = v; s.welcomeAt = Date.now(); writeState(s); }
  function tourStatus(id) { var t = readState().tours[id]; return t ? t.status : "new"; }
  function readRun() { try { return JSON.parse(sessionStorage.getItem(RUN_KEY) || "null"); } catch (_) { return null; } }
  function writeRun(r) { try { if (r) sessionStorage.setItem(RUN_KEY, JSON.stringify(r)); else sessionStorage.removeItem(RUN_KEY); } catch (_) {} }

  /* ------------------------------------------------------------ what a tour may ask about the page */
  var ctx = {
    page: PAGE, esc: esc, fmt: fmt, sleep: sleep, ico: ico,
    q: function (s) { return d.querySelector(s); },
    vis: function (s) { return !!firstVisible(s); },
    mode: function () { return typeof w.kfpGetMode === "function" ? w.kfpGetMode() : "KRW"; },
    preview: function () { var KS = w.kfpStorage; return !KS || !KS.isMember || !KS.isMember(); },
    member: function () { var KS = w.kfpStorage; return !!(KS && KS.isMember && KS.isMember()); },
    planState: function () { return html.getAttribute("data-plan-state") || ""; },
    // the server's answer, as kfp-access.js shows it — preview (guest demo) shows everything
    can: function (f) {
      var s = html.getAttribute("data-plan-state");
      if (s === "preview" || s === "unconfigured") return true;
      return html.getAttribute("data-feat-" + f) === "1";
    },
    plan: function () { try { return (w.kfpPlan && w.kfpPlan.info().plan) || null; } catch (_) { return null; } },
    desktop: function () { return w.innerWidth >= 1024; },
    click: function (sel) { var el = typeof sel === "string" ? firstVisible(sel) : sel; if (el) el.click(); return !!el; },
    wait: function (test, ms) {
      var fn = typeof test === "string" ? function () { return firstVisible(test); } : test, t0 = Date.now();
      return new Promise(function (ok) {
        (function tick() {
          var v = null; try { v = fn(); } catch (_) {}
          if (v || Date.now() - t0 > (ms || 2000)) return ok(v || null);
          setTimeout(tick, 60);
        })();
      });
    },
    tools: function () { return w.kfpToolsTour || null; },
    go: function (page) { return PAGES[page]; }
  };

  /* ------------------------------------------------------------ content (kfp-tours.js) */
  var contentP = null;
  function loadContent() {
    if (w.KfpTourContent) return Promise.resolve();
    if (!contentP) contentP = new Promise(function (ok, no) {
      var s = d.createElement("script");
      s.src = "kfp-tours.js" + (VER ? "?v=" + VER : ""); s.async = true;
      s.onload = function () { w.KfpTourContent ? ok() : no(new Error("empty")); };
      s.onerror = function () { contentP = null; s.remove(); no(new Error("load")); };
      d.head.appendChild(s);
    });
    return contentP;
  }
  function register(t) { if (!t || !t.id) return; TOURS[t.id] = t; if (ORDER.indexOf(t.id) < 0) ORDER.push(t.id); }
  function available(t) { try { return t.available ? t.available(ctx) !== false : true; } catch (_) { return true; } }

  /* ------------------------------------------------------------ listeners that always go away together */
  var bag = [];
  function on(target, type, fn, opt) { target.addEventListener(type, fn, opt); bag.push([target, type, fn, opt]); }
  function offAll() { bag.forEach(function (b) { b[0].removeEventListener(b[1], b[2], b[3]); }); bag = []; }

  /* ------------------------------------------------------------ geometry */
  var safe = { top: 0, bottom: 0 };
  function readSafe() {
    var p = d.createElement("div");
    p.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)";
    d.body.appendChild(p);
    var cs = getComputedStyle(p); safe = { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 };
    p.remove();
  }
  function viewport() {
    var vv = w.visualViewport;
    return { w: w.innerWidth, h: vv ? vv.height : w.innerHeight, top: vv ? vv.offsetTop : 0 };
  }
  // usable area for the bubble: below the notch, above the bottom tab bar (mobile)
  function zone(targetInNav) {
    var vp = viewport(), top = vp.top + Math.max(safe.top, 0) + 8, bottom = vp.top + vp.h - Math.max(safe.bottom, 0) - 8;
    if (!targetInNav) {
      var bar = firstVisible(".pn .pn-bar");
      if (bar) bottom = Math.min(bottom, bar.getBoundingClientRect().top - 10);
    }
    return { top: top, bottom: bottom, left: 8, right: vp.w - 8, w: vp.w, h: bottom - top };
  }
  function unionRect(els) {
    var r = null;
    els.forEach(function (el) {
      var b = el.getBoundingClientRect(); if (b.width < 1 && b.height < 1) return;
      r = r ? { left: Math.min(r.left, b.left), top: Math.min(r.top, b.top), right: Math.max(r.right, b.right), bottom: Math.max(r.bottom, b.bottom) }
            : { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    });
    if (r) { r.width = r.right - r.left; r.height = r.bottom - r.top; }
    return r;
  }
  function isFixed(el) {
    for (var p = el; p && p !== d.documentElement; p = p.parentElement) if (getComputedStyle(p).position === "fixed") return true;
    return false;
  }
  function scrollParent(el) {
    for (var p = el.parentElement; p && p !== d.body && p !== d.documentElement; p = p.parentElement) {
      var oy = getComputedStyle(p).overflowY;
      if (/(auto|scroll|overlay)/.test(oy) && p.scrollHeight > p.clientHeight + 2) return p;
    }
    return null;
  }

  /* ------------------------------------------------------------ DOM of the running tour */
  var R = null;          // current run
  var root, spot, tip, live, blocks, dim;
  function mount() {
    if (root) return;
    readSafe();
    root = d.createElement("div");
    root.className = "kt-root"; root.setAttribute("data-kt", "");
    root.innerHTML =
      '<div class="kt-dim"></div>' +
      '<div class="kt-block" data-b="t"></div><div class="kt-block" data-b="b"></div><div class="kt-block" data-b="l"></div><div class="kt-block" data-b="r"></div>' +
      '<div class="kt-block kt-hole" data-b="h"></div>' +
      '<div class="kt-spot" aria-hidden="true"><i class="kt-ring"></i></div>' +
      '<div class="kt-tip" role="dialog" aria-modal="true" aria-labelledby="ktTitle" aria-describedby="ktText" tabindex="-1">' +
        '<i class="kt-arrow" aria-hidden="true"></i>' +
        '<div class="kt-head"><span class="kt-count" id="ktCount"></span><span class="kt-tname"></span>' +
        '<button type="button" class="kt-x" data-k="exit" aria-label="ออกจากการแนะนำ (Esc)">' + ico("close") + "</button></div>" +
        '<div class="kt-prog" role="progressbar" aria-label="ความคืบหน้า" aria-valuemin="0"><i></i></div>' +
        '<div class="kt-body"></div><p class="kt-morehint" aria-hidden="true">เลื่อนอ่านต่อ ▾</p>' +
        '<div class="kt-foot"><button type="button" class="kt-btn kt-prev" data-k="prev">' + ico("chevron", "kt-flip") + "<span>ย้อนกลับ</span></button>" +
        '<button type="button" class="kt-btn kt-skip" data-k="skip">ข้าม</button>' +
        '<button type="button" class="kt-btn kt-next" data-k="next"><span>ถัดไป</span>' + ico("chevron") + "</button></div>" +
        '<p class="kt-hint"></p></div>' +
      '<div class="kt-live sr-only" aria-live="polite" aria-atomic="true"></div>';
    d.body.appendChild(root);
    dim = root.querySelector(".kt-dim"); spot = root.querySelector(".kt-spot"); tip = root.querySelector(".kt-tip");
    live = root.querySelector(".kt-live"); blocks = [].slice.call(root.querySelectorAll(".kt-block"));
    html.classList.add("kt-on");
    requestAnimationFrame(function () { root.classList.add("on"); });

    on(tip, "click", function (e) {
      var b = e.target.closest("[data-k]"); if (!b || b.disabled) return;
      var k = b.getAttribute("data-k");
      if (k === "next") next(); else if (k === "prev") prev(); else if (k === "skip") skip(); else if (k === "exit") stop("exit");
      else if (k === "start") { var id = b.getAttribute("data-id"); stop("switch", true); start(id, { chain: R && R.chain }); }
      else if (k === "help") { stop("done-close"); openHelp(); }
      else if (k === "close") stop("done-close");
      else if (k === "pricing") { stop("done-close"); location.href = "pricing.html"; }
    });
    // tap the dimmed area (not the bubble, not the highlighted element on "try it" steps) to continue
    blocks.forEach(function (b) {
      on(b, "click", function (e) {
        e.preventDefault(); e.stopPropagation();
        if (!R || R.busy || R.end || (R.cur && R.cur.interactive)) return;
        next();
      });
    });
    on(w, "keydown", onKey, true);
    on(tip.querySelector(".kt-body"), "scroll", moreHint, { passive: true });
    var schedule = function () { if (R && !R.raf) R.raf = requestAnimationFrame(function () { R.raf = 0; place(); }); };
    on(w, "resize", schedule, { passive: true });
    on(w, "orientationchange", function () { readSafe(); schedule(); }, { passive: true });
    on(w, "scroll", schedule, { passive: true, capture: true });
    if (w.visualViewport) { on(w.visualViewport, "resize", schedule, { passive: true }); on(w.visualViewport, "scroll", schedule, { passive: true }); }
    if (w.ResizeObserver) { R.ro = new ResizeObserver(schedule); R.ro.observe(tip); R.ro.observe(d.body); }
    R.watch = setInterval(function () {                                 // target re-rendered / removed?
      if (!R || R.busy || !R.cur || R.end) return;
      if (R.els && R.els.some(function (el) { return !el.isConnected || !visible(el); })) {
        var again = resolve(R.cur);
        R.els = again; R.ro && again && again.forEach(function (el) { R.ro.observe(el); });
        place();
      }
      if (R.cur.advanceWhen && !R.advanced) {
        var ok = false; try { ok = !!R.cur.advanceWhen(ctx); } catch (_) {}
        if (ok) { R.advanced = true; setTimeout(function () { if (R && !R.busy) next(); }, 450); }
      }
    }, 400);
  }
  function unmount() {
    if (!root) return;
    var el = root; root = null;
    if (R && R.ro) R.ro.disconnect();
    if (R && R.watch) clearInterval(R.watch);
    offAll();
    html.classList.remove("kt-on");
    el.classList.remove("on");
    setTimeout(function () { el.remove(); }, reduce ? 0 : 260);
  }

  function onKey(e) {
    if (!R) return;
    var t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); stop("exit"); return; }
    if (R.end) return;
    if (!typing && e.key === "ArrowRight") { e.preventDefault(); e.stopImmediatePropagation(); if (!R.busy) next(); }
    else if (!typing && e.key === "ArrowLeft") { e.preventDefault(); e.stopImmediatePropagation(); if (!R.busy) prev(); }
    else if (e.key === "Tab") trap(e);
  }
  function trap(e) {
    var list = [].slice.call(tip.querySelectorAll("button:not([disabled]),a[href]"));
    if (R.cur && R.cur.interactive && R.els) R.els.forEach(function (el) {
      list = list.concat([].slice.call(el.matches("button,a[href],input,select,textarea") ? [el] : el.querySelectorAll("button:not([disabled]),a[href],input,select,textarea")));
    });
    list = list.filter(visible);
    if (!list.length) return;
    var i = list.indexOf(d.activeElement);
    e.preventDefault();
    var n = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i < 0 || i === list.length - 1 ? 0 : i + 1);
    list[n].focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------ running a tour */
  function applies(s) {
    try {
      if (s.when && !s.when(ctx)) return false;
      // an optional step whose element is not on this page right now is left out of the count
      var pg = s.page || (R && R.t.page);
      if (s.optional && !s.before && (!pg || pg === "any" || pg === PAGE) && !resolve(s)) return false;
      return true;
    } catch (_) { return false; }
  }
  function stepsNow() { return R.t.steps.filter(applies); }

  function start(id, opts) {
    opts = opts || {};
    closeWelcome(); closeHelp(); hidePill();
    if (toastEl) toastEl.classList.remove("show");
    return loadContent().then(function () {
      var t = TOURS[id]; if (!t) return;
      if (R) stop("switch", true);
      R = { t: t, i: 0, chain: opts.chain || null, token: 0, focusBack: d.activeElement };
      mark(id, "active", { step: 0 });
      mount();
      emit("start", { id: id });
      show(opts.step || 0, 1);
    }, function () { toast("โหลดคู่มือไม่สำเร็จ — ตรวจอินเทอร์เน็ตแล้วลองใหม่"); });
  }

  function resolve(s) {
    var els = [];
    if (s.union) s.union.forEach(function (sel) { var el = firstVisible(sel); if (el) els.push(el); });
    else if (s.target) {
      var t = typeof s.target === "function" ? s.target(ctx) : s.target;
      if (Array.isArray(t)) t.forEach(function (el) { if (el && visible(el)) els.push(el); });   // several elements = one highlight
      else { var el = typeof t === "string" ? firstVisible(t) : (t && visible(t) ? t : null); if (el) els.push(el); }
    }
    return els.length ? els : null;
  }

  function show(i, dir) {
    if (!R) return;
    var token = ++R.token, steps = R.t.steps;
    while (i >= 0 && i < steps.length && !applies(steps[i])) i += dir;
    if (i < 0) { i = 0; while (i < steps.length && !applies(steps[i])) i++; dir = 1; }
    if (i >= steps.length) return finish();
    var prevStep = R.cur;
    if (prevStep && prevStep !== steps[i] && prevStep.after) { try { prevStep.after(ctx); } catch (_) {} }
    R.i = i; R.cur = steps[i]; R.dir = dir; R.advanced = false; R.end = false;
    var s = R.cur;
    writeRun({ id: R.t.id, i: i, chain: R.chain, nav: false, at: Date.now() });
    mark(R.t.id, "active", { step: i });

    var pg = s.page || R.t.page;
    if (pg && pg !== "any" && pg !== PAGE && PAGES[pg]) return travel(pg, i);

    busy(true);
    Promise.resolve().then(function () { return s.before ? s.before(ctx) : null; }).catch(function () {}).then(function () {
      if (!R || token !== R.token) return;
      var waitMs = s.center ? 0 : (s.wait || 2200);
      return ctx.wait(function () { return s.center ? true : resolve(s); }, waitMs);
    }).then(function () {
      if (!R || token !== R.token) return;
      var els = s.center ? null : resolve(s);
      if (!els && !s.center && s.optional) { busy(false); return show(i + (dir || 1), dir || 1); }
      R.els = els;
      if (R.ro && els) els.forEach(function (el) { R.ro.observe(el); });
      paint(s, !!els || !!s.center);
      return bringIntoView(els);
    }).then(function () {
      if (!R || token !== R.token) return;
      place(); busy(false);
      var h = tip.querySelector("#ktTitle"); if (h) h.focus({ preventScroll: true });
      emit("step", { id: R.t.id, i: R.i, step: s.id || null });
    });
  }

  function busy(on) {
    if (!R) return;
    R.busy = on;
    root.classList.toggle("busy", on);
    tip.setAttribute("aria-busy", on ? "true" : "false");
  }

  function paint(s, found) {
    var list = stepsNow(), k = list.indexOf(s) + 1, n = list.length;
    var title = val(s.title, ctx) || "", text = val(s.text, ctx) || "";
    var h = "";
    if (s.section) h += '<span class="kt-sec">' + esc(val(s.section, ctx)) + "</span>";
    h += '<h3 id="ktTitle" tabindex="-1">' + title + "</h3>";
    h += '<div class="kt-text" id="ktText">' + text + "</div>";
    if (!found) h += '<p class="kt-miss">' + ico("info") + "<span>" + esc(val(s.missing, ctx) || "ส่วนนี้ยังไม่แสดงบนหน้าจอของคุณตอนนี้ (อาจขึ้นกับแพ็กเกจ โหมดเงิน หรือการเข้าสู่ระบบ) — อ่านคำอธิบายแล้วไปต่อได้เลย") + "</span></p>";
    var facts = val(s.facts, ctx);
    if (facts && facts.length) h += '<dl class="kt-facts">' + facts.map(function (f) { return "<div><dt>" + f[0] + "</dt><dd>" + f[1] + "</dd></div>"; }).join("") + "</dl>";
    var fx = val(s.formula, ctx);
    if (fx && fx.length) h += '<div class="kt-formula"><b class="kt-fx-h">' + ico("calculator") + "สูตรที่ระบบใช้</b>" +
      fx.map(function (f) { return '<div class="kt-fx"><span>' + f[0] + "</span><code>" + f[1] + "</code></div>"; }).join("") + "</div>";
    var ex = val(s.example, ctx);
    if (ex) h += '<div class="kt-example">' + ex + "</div>";
    var flow = val(s.flow, ctx);
    if (flow && flow.length) h += '<ol class="kt-flow" aria-label="ข้อมูลไหลไปที่">' + flow.map(function (f, j) {
      return "<li" + (j ? "" : ' class="first"') + ">" + (j ? '<i aria-hidden="true">→</i>' : "") + f + "</li>";
    }).join("") + "</ol>";
    var note = val(s.note, ctx);
    if (note) h += '<p class="kt-note">' + note + "</p>";
    tip.querySelector(".kt-body").innerHTML = h;
    tip.querySelector(".kt-body").scrollTop = 0;
    tip.querySelector("#ktCount").innerHTML = "ขั้นตอน <b>" + k + "</b> / " + n;
    tip.querySelector(".kt-tname").textContent = R.t.title;
    var pr = tip.querySelector(".kt-prog");
    pr.setAttribute("aria-valuemax", String(n)); pr.setAttribute("aria-valuenow", String(k));
    pr.firstChild.style.width = (n ? (k / n) * 100 : 0) + "%";
    tip.querySelector(".kt-prev").disabled = k <= 1;
    var last = k >= n;
    tip.querySelector(".kt-next span").textContent = last ? "เสร็จสิ้น" : (s.nextLabel || "ถัดไป");
    tip.querySelector(".kt-skip").hidden = last;
    tip.querySelector(".kt-skip").textContent = s.section && sectionRest(s) > 1 ? "ข้ามส่วนนี้" : "ข้าม";
    tip.querySelector(".kt-foot").hidden = false;
    tip.querySelector(".kt-hint").textContent = s.interactive
      ? "ลองแตะส่วนที่ไฮไลต์ได้เลย หรือกด “" + (last ? "เสร็จสิ้น" : "ถัดไป") + "” เมื่อพร้อม"
      : (ctx.desktop() ? "แตะที่ว่างหรือกด → เพื่อไปต่อ · ← ย้อนกลับ · Esc ออก" : "แตะที่ว่างเพื่อไปต่อ");
    root.classList.toggle("interactive", !!s.interactive && !!found);
    root.classList.toggle("nospot", !R.els);
    live.textContent = "ขั้นตอนที่ " + k + " จาก " + n + ": " + tip.querySelector("#ktTitle").textContent;
  }

  function sectionRest(s) {
    var list = stepsNow(), at = list.indexOf(s), n = 0;
    for (var j = at; j < list.length && list[j].section === s.section; j++) n++;
    return n;
  }

  // bring the target to where the bubble also fits (inside a scrolling pop-up too)
  function sizeTip(z) {
    var vp = viewport(), tw = vp.w < 640 ? vp.w - 20 : Math.min(400, vp.w - 32);
    tip.style.width = tw + "px";
    tip.style.maxHeight = Math.max(200, z.h) + "px";
    return tw;
  }
  function bringIntoView(els) {
    if (!els || !els.length) return Promise.resolve();
    var el = els[0];
    var z = zone(!!el.closest(".pn")), r = unionRect(els); if (!r) return Promise.resolve();
    sizeTip(z);
    var tipH = Math.min(tip.offsetHeight || 260, z.h * 0.62), gap = 16;
    var want = r.height + gap + tipH <= z.h ? z.top + Math.max(10, (z.h - (r.height + gap + tipH)) * 0.4) : z.top + 12;
    var tw = Math.min(400, w.innerWidth - 32), sideRoom = Math.max(w.innerWidth - r.right, r.left) - gap - 12 >= tw;
    if (w.innerWidth >= 1024 && sideRoom && r.height <= z.h * 0.7) want = z.top + Math.max(10, (z.h - r.height) * 0.35);   // bubble goes beside it
    var inView = r.top >= z.top && r.bottom <= z.bottom && (r.bottom + gap + tipH <= z.bottom || r.top - gap - tipH >= z.top || (w.innerWidth >= 1024 && sideRoom));
    if (inView) return Promise.resolve();
    var delta = r.top - want, behavior = reduce ? "auto" : "smooth";
    var sp = scrollParent(el);
    if (sp) { var before = sp.scrollTop; sp.scrollTo({ top: before + delta, behavior: behavior }); delta = 0; }
    if (!sp && !isFixed(el)) w.scrollTo({ top: w.scrollY + delta, behavior: behavior });
    return settle(els);
  }
  function settle(els) {
    return new Promise(function (ok) {
      var last = null, same = 0, t0 = Date.now();
      (function tick() {
        var r = unionRect(els), key = r ? Math.round(r.top) + ":" + Math.round(r.left) : "";
        same = key === last ? same + 1 : 0; last = key;
        if (same >= 3 || Date.now() - t0 > 900) return ok();
        requestAnimationFrame(tick);
      })();
    });
  }

  function place() {
    if (!R || !root) return;
    var vp = viewport(), els = R.els && R.els.filter(function (el) { return el.isConnected; });
    var r = els && els.length ? unionRect(els) : null;
    var inNav = !!(els && els[0] && els[0].closest(".pn"));
    var z = zone(inNav);
    var mobile = vp.w < 640, gap = 14;
    var pad = R.cur && R.cur.pad != null ? R.cur.pad : 8;
    var tw = sizeTip(z);
    tip.style.maxHeight = Math.max(200, z.h) + "px";
    tip.classList.remove("tight");
    var th = tip.offsetHeight;

    if (!r) {                                                   // no target: centred card, whole page dimmed
      root.classList.add("nospot");
      setBlocks(null);
      var top = clamp(z.top + (z.h - th) / 2, z.top, Math.max(z.top, z.bottom - th));
      tip.style.left = Math.round((vp.w - tw) / 2) + "px"; tip.style.top = Math.round(top) + "px";
      tip.setAttribute("data-side", "none");
      return;
    }
    root.classList.remove("nospot");
    var s = { left: r.left - pad, top: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
    s.right = s.left + s.width; s.bottom = s.top + s.height;
    var rad = 14;
    try { rad = Math.min(26, (parseFloat(getComputedStyle(els[0]).borderTopLeftRadius) || 8) + pad); } catch (_) {}
    spot.style.transform = "translate(" + Math.round(s.left) + "px," + Math.round(s.top) + "px)";
    spot.style.width = Math.round(s.width) + "px"; spot.style.height = Math.round(s.height) + "px";
    spot.style.borderRadius = rad + "px";
    setBlocks(s);

    var cx = s.left + s.width / 2, cy = s.top + s.height / 2;
    var below = z.bottom - s.bottom - gap, above = s.top - gap - z.top;
    var right = vp.w - 12 - s.right - gap, left = s.left - gap - 12;
    var pref = (R.cur && R.cur.placement) || "auto";
    var order = pref === "top" ? ["top", "bottom", "right", "left"] : pref === "right" ? ["right", "left", "bottom", "top"] :
                pref === "left" ? ["left", "right", "bottom", "top"] : ["bottom", "top", "right", "left"];
    if (mobile) order = order.filter(function (x) { return x === "top" || x === "bottom"; });
    var side = null;
    for (var k = 0; k < order.length && !side; k++) {
      var o = order[k];
      if ((o === "bottom" && below >= th) || (o === "top" && above >= th)) side = o;
      if ((o === "right" && right >= tw && th <= z.h) || (o === "left" && left >= tw && th <= z.h)) side = o;
    }
    // long explanation: keep the target visible and let the bubble scroll inside the bigger free side
    if (!side && Math.max(below, above) >= 260) {
      side = below >= above ? "bottom" : "top";
      tip.classList.add("tight");                               // smaller header, no hint line
      th = Math.min(tip.offsetHeight, Math.floor(side === "bottom" ? below : above));
      tip.style.maxHeight = th + "px";
    }
    var x, y, ax = null, ay = null;
    if (side === "bottom" || side === "top") {
      x = clamp(cx - tw / 2, 10, vp.w - 10 - tw);
      y = side === "bottom" ? s.bottom + gap : s.top - gap - th;
      ax = clamp(cx - x, 22, tw - 22);
    } else if (side === "right" || side === "left") {
      y = clamp(cy - th / 2, z.top, Math.max(z.top, z.bottom - th));
      x = side === "right" ? s.right + gap : s.left - gap - tw;
      ay = clamp(cy - y, 22, th - 22);
    } else {
      // no room next to it (tall element or small phone): bubble sits at the edge farther from the target
      x = vp.w >= 1024 ? vp.w - tw - 20 : clamp(cx - tw / 2, 10, vp.w - 10 - tw);   // desktop: dock to the right edge
      var spaceTop = s.top - z.top, spaceBottom = z.bottom - s.bottom;
      y = spaceBottom >= spaceTop ? Math.max(z.top, z.bottom - th) : z.top;
      side = "over";
    }
    tip.setAttribute("data-side", side);
    tip.style.left = Math.round(x) + "px"; tip.style.top = Math.round(y) + "px";
    moreHint();
    var arrow = tip.querySelector(".kt-arrow");
    arrow.style.left = ax != null ? Math.round(ax) + "px" : ""; arrow.style.top = ay != null ? Math.round(ay) + "px" : "";
  }

  function moreHint() {
    var b = tip && tip.querySelector(".kt-body"); if (!b) return;
    tip.classList.toggle("kt-more", b.scrollHeight - b.clientHeight - b.scrollTop > 6);
  }
  // four click-catchers around the hole (+ one over it unless the step lets you try the real control)
  function setBlocks(s) {
    var vw = w.innerWidth, vh = w.innerHeight;
    var st = function (b, l, t, wd, ht) { b.style.left = l + "px"; b.style.top = t + "px"; b.style.width = Math.max(0, wd) + "px"; b.style.height = Math.max(0, ht) + "px"; };
    if (!s) { st(blocks[0], 0, 0, vw, vh); st(blocks[1], 0, 0, 0, 0); st(blocks[2], 0, 0, 0, 0); st(blocks[3], 0, 0, 0, 0); st(blocks[4], 0, 0, 0, 0); return; }
    var L = Math.max(0, s.left), T = Math.max(0, s.top), Rr = Math.min(vw, s.right), B = Math.min(vh, s.bottom);
    st(blocks[0], 0, 0, vw, T);
    st(blocks[1], 0, B, vw, vh - B);
    st(blocks[2], 0, T, L, B - T);
    st(blocks[3], Rr, T, vw - Rr, B - T);
    var interactive = R && R.cur && R.cur.interactive;
    if (interactive) st(blocks[4], 0, 0, 0, 0); else st(blocks[4], L, T, Rr - L, B - T);
  }

  function next() {
    if (!R || R.busy) return;
    if (R.end) return stop("done-close");
    var list = stepsNow(), at = list.indexOf(R.cur);
    if (at >= list.length - 1) return finish();
    show(R.t.steps.indexOf(list[at + 1]), 1);
  }
  function prev() {
    if (!R || R.busy || R.end) return;
    var list = stepsNow(), at = list.indexOf(R.cur);
    if (at <= 0) return;
    show(R.t.steps.indexOf(list[at - 1]), -1);
  }
  // "ข้าม": past this step — or past the whole section when the step belongs to one
  function skip() {
    if (!R || R.busy || R.end) return;
    var list = stepsNow(), at = list.indexOf(R.cur), j = at + 1;
    if (R.cur.section) while (j < list.length && list[j].section === R.cur.section) j++;
    if (j >= list.length) return finish();
    show(R.t.steps.indexOf(list[j]), 1);
  }

  function travel(page, i) {
    writeRun({ id: R.t.id, i: i, chain: R.chain, nav: true, page: page, at: Date.now() });
    busy(true);
    tip.querySelector(".kt-body").innerHTML = '<h3 id="ktTitle" tabindex="-1">กำลังไปที่หน้า' + esc(PAGE_NAME[page] || "") + "…</h3>";
    location.href = PAGES[page];
  }

  function finish() {
    if (!R) return;
    var t = R.t;
    if (R.cur && R.cur.after) { try { R.cur.after(ctx); } catch (_) {} }
    R.cur = null; R.els = null; R.end = true;
    mark(t.id, "done");
    writeRun(null);
    emit("done", { id: t.id });
    try { if (t.cleanup) t.cleanup(ctx); } catch (_) {}
    // what next: the rest of a "learn everything" run, else the next unread topics
    var chain = (R.chain || []).filter(function (id) { return id !== t.id && TOURS[id] && available(TOURS[id]); });
    var nextIds = chain.length ? chain.slice(0, 1) :
      ORDER.filter(function (id) { return id !== t.id && TOURS[id] && available(TOURS[id]) && tourStatus(id) !== "done"; }).slice(0, 2);
    R.chain = chain.length ? chain : null;
    var h = '<div class="kt-done-ico">' + ico("medal") + "</div>" +
      '<h3 id="ktTitle" tabindex="-1">เรียนรู้ “' + esc(t.title) + "” จบแล้ว</h3>" +
      '<div class="kt-text" id="ktText">' + (val(t.outro, ctx) || "กลับมาดูซ้ำได้ทุกเมื่อจากเมนู <b>วิธีใช้งานเว็บไซต์</b>") + "</div>";
    if (nextIds.length) h += '<p class="kt-sec">' + (chain.length ? "หัวข้อถัดไป" : "แนะนำต่อ") + "</p>" + '<div class="kt-next-list">' + nextIds.map(function (id) {
      var x = TOURS[id];
      return '<button type="button" class="kt-nx" data-k="start" data-id="' + esc(id) + '"><span class="kt-nx-i">' + ico(x.icon || "sparkle") + "</span><span><b>" + esc(x.title) + "</b><small>" + esc(x.desc || "") + "</small></span>" + ico("chevron") + "</button>";
    }).join("") + "</div>";
    h += '<div class="kt-end-row"><button type="button" class="kt-btn" data-k="help">หัวข้อทั้งหมด</button><button type="button" class="kt-btn kt-next" data-k="close"><span>ปิด</span></button></div>';
    tip.querySelector(".kt-body").innerHTML = h;
    tip.querySelector("#ktCount").innerHTML = "เสร็จแล้ว";
    tip.querySelector(".kt-prog").firstChild.style.width = "100%";
    tip.querySelector(".kt-foot").hidden = true;
    tip.querySelector(".kt-hint").textContent = "";
    root.classList.remove("interactive");
    live.textContent = "จบหัวข้อ " + t.title;
    place();
    var f = tip.querySelector("#ktTitle"); if (f) f.focus({ preventScroll: true });
  }

  // reason: exit (person left) · done-close (closed the end card) · switch (another tour starts)
  function stop(reason, keepUi) {
    if (!R) return;
    var t = R.t, run = R, cur = R.cur;
    if (cur && cur.after) { try { cur.after(ctx); } catch (_) {} }
    if (!run.end) { try { if (t.cleanup) t.cleanup(ctx); } catch (_) {} }
    if (reason === "exit" && !run.end) mark(t.id, "skipped", { step: run.i });
    writeRun(null);
    emit("end", { id: t.id, reason: reason });
    unmount();
    R = null;
    if (!keepUi) {
      var back = run.focusBack;
      if (back && back.isConnected && back.focus) try { back.focus({ preventScroll: true }); } catch (_) {}
    }
  }

  /* ------------------------------------------------------------ small toast */
  var toastEl, toastT;
  function toast(msg) {
    if (!toastEl) { toastEl = d.createElement("div"); toastEl.className = "kt-toast"; toastEl.setAttribute("role", "status"); d.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(function () { toastEl.classList.remove("show"); }, 4200);
  }

  /* ------------------------------------------------------------ modal shell (welcome + help centre) */
  function sheet(id, label) {
    var ov = d.createElement("div");
    ov.className = "kt-ov"; ov.id = id;
    ov.innerHTML = '<div class="kt-sheet" role="dialog" aria-modal="true" aria-label="' + esc(label) + '" tabindex="-1"></div>';
    d.body.appendChild(ov);
    ov._back = d.activeElement;
    ov.addEventListener("pointerdown", function (e) { if (e.target === ov) ov._close(); });
    ov.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); ov._close(); return; }
      if (e.key !== "Tab") return;
      var f = [].slice.call(ov.querySelectorAll("button:not([disabled]),a[href],[tabindex='0']")).filter(visible);
      if (!f.length) return;
      var i = f.indexOf(d.activeElement); e.preventDefault();
      f[e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i === f.length - 1 ? 0 : i + 1)].focus();
    });
    ov._close = function (keepFocus) {
      if (!ov.isConnected) return;
      ov.classList.remove("on"); html.classList.remove("kt-modal");
      setTimeout(function () { ov.remove(); }, reduce ? 0 : 240);
      if (!keepFocus && ov._back && ov._back.isConnected) try { ov._back.focus({ preventScroll: true }); } catch (_) {}
    };
    html.classList.add("kt-modal");
    requestAnimationFrame(function () { ov.classList.add("on"); });
    return ov;
  }

  /* ------------------------------------------------------------ first visit */
  function welcome() {
    if (d.getElementById("ktWelcome")) return;
    var ov = sheet("ktWelcome", "ยินดีต้อนรับสู่ PLANNER"), box = ov.firstChild;
    box.classList.add("kt-welcome");
    box.innerHTML =
      '<button type="button" class="kt-x" data-w="later" aria-label="ปิด">' + ico("close") + "</button>" +
      '<div class="kt-w-logo"><img src="assets/brand/planner-logo-sm.png" alt="" width="360" height="291"></div>' +
      '<span class="kt-eyebrow">ครั้งแรกที่นี่?</span>' +
      '<h2 id="ktWTitle">ยินดีต้อนรับสู่ PLANNER</h2>' +
      "<p>เราจะพาคุณไปรู้จักวิธีใช้งานเว็บไซต์ ตั้งแต่การจัดการรายได้ การบันทึกการทำงาน การบริหารเงินออม ไปจนถึงการติดตามค่าใช้จ่าย</p>" +
      '<ul class="kt-w-chips">' + [["salary", "แบ่งเงินเดือน"], ["attendance", "บันทึกงาน & OT"], ["receipt", "รายจ่าย"], ["gold", "พอร์ตทอง"], ["card", "บัตร·หนี้"]].map(function (c) {
        return "<li>" + ico(c[0]) + "<span>" + c[1] + "</span></li>";
      }).join("") + "</ul>" +
      '<p class="kt-w-fine">' + ico("pin") + "ระบบจะไฮไลต์ตำแหน่งจริงบนหน้าจอทีละขั้น ออกได้ทุกเมื่อ และไม่แก้ไขข้อมูลของคุณ</p>" +
      '<div class="kt-w-act"><button type="button" class="kt-btn kt-next" data-w="start"><span>เริ่มแนะนำการใช้งาน</span>' + ico("chevron") + "</button>" +
      '<button type="button" class="kt-btn" data-w="later">ไว้ทีหลัง</button></div>';
    box.setAttribute("aria-labelledby", "ktWTitle"); box.removeAttribute("aria-label");
    box.addEventListener("click", function (e) {
      var b = e.target.closest("[data-w]"); if (!b) return;
      if (b.getAttribute("data-w") === "start") { setWelcome("started"); ov._close(true); start("overview", { chain: ["overview", "home"] }); }
      else { ov._close(); }
    });
    var close0 = ov._close;
    ov._close = function (keep) {
      if (readState().welcome == null) { setWelcome("later"); toast("เปิดคู่มือได้ทุกเมื่อ: ปุ่ม “วิธีใช้งานเว็บไซต์” ใต้โลโก้ หรือเมนู + บันทึกด่วน"); }
      close0(keep);
    };
    setTimeout(function () { var b = box.querySelector('[data-w="start"]'); if (b) b.focus({ preventScroll: true }); }, 60);
    emit("welcome");
  }
  function closeWelcome() { var x = d.getElementById("ktWelcome"); if (x && x._close) x._close(true); }

  /* ------------------------------------------------------------ help centre */
  function openHelp() {
    if (d.getElementById("ktHelp")) return;
    if (toastEl) toastEl.classList.remove("show");
    var ov = sheet("ktHelp", "วิธีใช้งานเว็บไซต์"), box = ov.firstChild;
    box.classList.add("kt-help");
    box.innerHTML = '<div class="kt-h-head"><span class="kt-h-ico">' + ico("compass") + '</span><div><h2 id="ktHTitle">วิธีใช้งานเว็บไซต์</h2>' +
      "<p>เลือกหัวข้อ ระบบจะพาไปยังตำแหน่งจริงบนหน้าจอทีละขั้น</p></div>" +
      '<button type="button" class="kt-x" data-h="close" aria-label="ปิดหน้าต่าง">' + ico("close") + "</button></div>" +
      '<div class="kt-h-body"><div class="kt-h-load" role="status">กำลังโหลดหัวข้อ…</div></div>';
    box.setAttribute("aria-labelledby", "ktHTitle"); box.removeAttribute("aria-label");
    hidePill(); setNewDot(false);
    var s0 = readState(); if (s0.welcome == null || s0.welcome === "existing") setWelcome("help");
    box.addEventListener("click", function (e) {
      var b = e.target.closest("[data-h]"); if (!b) return;
      var k = b.getAttribute("data-h");
      if (k === "close") ov._close();
      else if (k === "pick") selectRow(box, b.getAttribute("data-id"));
      else if (k === "go") { var id = box.getAttribute("data-sel"); if (id) { ov._close(true); start(id); } }
      else if (k === "all") {
        var ids = ORDER.filter(function (id) { return available(TOURS[id]); });
        var s = readState(); ids.forEach(function (id) { delete s.tours[id]; }); writeState(s);
        ov._close(true); start(ids[0], { chain: ids });
      }
    });
    box.addEventListener("keydown", function (e) {
      var row = e.target.closest && e.target.closest(".kt-row"); if (!row) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        var rows = [].slice.call(box.querySelectorAll(".kt-row")), i = rows.indexOf(row);
        var n = rows[clamp(i + (e.key === "ArrowDown" ? 1 : -1), 0, rows.length - 1)];
        selectRow(box, n.getAttribute("data-id")); n.focus();
      } else if (e.key === "Enter" && e.target === row) { e.preventDefault(); selectRow(box, row.getAttribute("data-id")); var go = box.querySelector('[data-h="go"]'); if (go) go.click(); }
    });
    loadContent().then(function () { if (ov.isConnected) fillHelp(box); }, function () {
      var b = box.querySelector(".kt-h-body"); if (b) b.innerHTML = '<p class="kt-h-load">โหลดหัวข้อไม่สำเร็จ — ตรวจอินเทอร์เน็ตแล้วเปิดใหม่อีกครั้ง</p>';
    });
    setTimeout(function () { box.focus({ preventScroll: true }); }, 40);
    emit("help");
  }
  var STATUS_TXT = { done: ["ok", "เรียนรู้แล้ว"], skipped: ["mute", "ข้ามไว้"], active: ["warn", "ทำค้างไว้"], "new": ["", "ยังไม่ได้ดู"] };
  function fillHelp(box) {
    var ids = ORDER.filter(function (id) { return TOURS[id]; });
    var done = ids.filter(function (id) { return tourStatus(id) === "done"; }).length;
    var first = ids.filter(function (id) { return available(TOURS[id]) && tourStatus(id) !== "done"; })[0] || ids[0];
    var h = '<div class="kt-h-prog"><span>เรียนรู้แล้ว <b>' + done + "</b> / " + ids.length + " หัวข้อ</span><i><b style=\"width:" + (ids.length ? done / ids.length * 100 : 0) + '%"></b></i></div>' +
      '<div class="kt-rows" role="radiogroup" aria-label="หัวข้อแนะนำการใช้งาน">';
    ids.forEach(function (id, n) {
      var t = TOURS[id], st = STATUS_TXT[tourStatus(id)] || STATUS_TXT["new"], ok = available(t);
      var lock = t.feature && !ctx.can(t.feature) ? '<span class="kt-chip lock">' + ico("lock") + esc(t.featurePlan || "แพ็กเกจ") + "</span>" : "";
      var why = !ok && t.unavailable ? '<span class="kt-chip">' + esc(val(t.unavailable, ctx)) + "</span>" : "";
      h += '<div class="kt-row" role="radio" tabindex="-1" aria-checked="false" data-h="pick" data-id="' + esc(id) + '">' +
        '<span class="kt-row-n">' + (n + 1) + '</span><span class="kt-row-i">' + ico(t.icon || "sparkle") + "</span>" +
        '<span class="kt-row-t"><b>' + esc(t.title) + "</b><small>" + esc(t.desc || "") + "</small>" +
        '<span class="kt-row-m"><span>' + stepCount(t) + " ขั้นตอน · " + esc(t.page === "home" ? "หน้าหลัก" : PAGE_NAME[t.page] ? "หน้า" + PAGE_NAME[t.page] : "ทุกหน้า") + "</span>" +
        '<span class="kt-chip ' + st[0] + '">' + st[1] + "</span>" + lock + why + "</span></span></div>";
    });
    h += "</div>";
    box.querySelector(".kt-h-body").innerHTML = h;
    var foot = d.createElement("div"); foot.className = "kt-h-foot";
    foot.innerHTML = '<button type="button" class="kt-btn kt-next" data-h="go"><span>ดูหัวข้อที่เลือก</span>' + ico("chevron") + "</button>" +
      '<button type="button" class="kt-btn" data-h="all">' + ico("refresh") + "<span>เริ่มแนะนำใหม่ทั้งหมด</span></button>" +
      '<button type="button" class="kt-btn kt-ghost" data-h="close">ปิดหน้าต่าง</button>';
    box.appendChild(foot);
    selectRow(box, first);
  }
  // steps this person will actually see (plan / money mode), for the help list
  function stepCount(t) { return t.steps.filter(function (s) { try { return !s.when || s.when(ctx); } catch (_) { return true; } }).length; }
  function selectRow(box, id) {
    box.setAttribute("data-sel", id);
    [].forEach.call(box.querySelectorAll(".kt-row"), function (r) {
      var on = r.getAttribute("data-id") === id;
      r.setAttribute("aria-checked", on ? "true" : "false"); r.tabIndex = on ? 0 : -1; r.classList.toggle("sel", on);
    });
    var go = box.querySelector('[data-h="go"] span'), t = TOURS[id];
    if (go && t) go.textContent = "ดูหัวข้อ: " + t.title;
  }
  function closeHelp() { var x = d.getElementById("ktHelp"); if (x && x._close) x._close(true); }

  /* ------------------------------------------------------------ "continue where you left off" pill */
  var pill;
  function showPill(run) {
    loadContent().then(function () {
      var t = TOURS[run.id]; if (!t || R) return;
      if (!pill) {
        pill = d.createElement("div"); pill.className = "kt-pill"; pill.setAttribute("role", "region"); pill.setAttribute("aria-label", "การแนะนำที่ค้างไว้");
        d.body.appendChild(pill);
        pill.addEventListener("click", function (e) {
          var b = e.target.closest("[data-p]"); if (!b) return;
          var r = readRun(); hidePill();
          if (b.getAttribute("data-p") === "go" && r) start(r.id, { step: r.i, chain: r.chain });
          else { if (r) mark(r.id, "skipped", { step: r.i }); writeRun(null); }
        });
      }
      pill.innerHTML = '<span class="kt-pill-i">' + ico("compass") + '</span><span class="kt-pill-t"><small>แนะนำการใช้งานค้างไว้</small><b>' + esc(t.title) + "</b></span>" +
        '<button type="button" class="kt-btn kt-next" data-p="go">ทำต่อ</button><button type="button" class="kt-x" data-p="no" aria-label="เลิกแนะนำหัวข้อนี้">' + ico("close") + "</button>";
      requestAnimationFrame(function () { pill.classList.add("on"); });
    });
  }
  function hidePill() { if (pill) { pill.classList.remove("on"); } }

  /* ------------------------------------------------------------ entry points */
  function setNewDot(on) { [].forEach.call(d.querySelectorAll(".kt-help-pill,[data-k=\"help\"]"), function (b) { b.classList.toggle("kt-new", !!on); }); }
  function homeButton() {
    if (PAGE !== "home" || d.querySelector(".kt-help-pill")) return;
    var sub = d.querySelector(".pl-brand .pl-brand-sub"); if (!sub) return;
    var b = d.createElement("button");
    b.type = "button"; b.className = "kt-help-pill"; b.setAttribute("data-tour-open", "help"); b.setAttribute("data-tour", "help-entry");
    b.innerHTML = ico("compass") + "<span>วิธีใช้งานเว็บไซต์</span><i class=\"kt-dot\" aria-hidden=\"true\"></i>";
    sub.insertAdjacentElement("afterend", b);
  }
  d.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-tour-open]"); if (!b) return;
    e.preventDefault();
    var v = b.getAttribute("data-tour-open");
    if (v === "help") openHelp(); else start(v);
  });

  // first visit: welcome card on the home page once the page has settled (never over another pop-up)
  function hasOwnData() {
    if (ctx.preview()) return false;
    try {
      var keys = ["salaryRecords", "kfp_work_records_v1", "kfp_expenses_v1", "kfp_gold_lots_v1"];
      for (var i = 0; i < keys.length; i++) { var v = JSON.parse(localStorage.getItem(keys[i]) || "null"); if (Array.isArray(v) && v.length) return true; }
      return Number(localStorage.getItem("salary")) > 0;
    } catch (_) { return false; }
  }
  function busyScreen() {
    return !!d.querySelector('.kfp-modal:not([hidden]),.kfn-ov,.kdg-ov,#kfpUpsell:not([hidden]),.kfp-gate-fb:not([hidden]),.ks-ov.on,dialog[open],.pn-sheet.on,.kt-ov,.kt-root') ||
      html.getAttribute("data-plan-state") === "loading";
  }
  // automated browsers (tests of other features) never get the automatic pop-up unless they ask for it
  function autoAllowed() {
    try { if (sessionStorage.getItem("__kfp_tour_auto") === "1") return true; } catch (_) {}
    return !navigator.webdriver;
  }
  function maybeWelcome() {
    if (PAGE !== "home" || !autoAllowed()) return;
    var s = readState(); if (s.welcome != null) { if (s.welcome === "existing") setNewDot(true); return; }
    if (hasOwnData()) { setWelcome("existing"); setNewDot(true); return; }       // not a first visit: just a small "new" dot
    var tries = 0;
    (function wait() {
      if (R || readState().welcome != null) return;
      if (!busyScreen() && d.visibilityState === "visible") return welcome();
      if (++tries < 40) setTimeout(wait, 700);
    })();
  }

  function init() {
    homeButton();
    var run = readRun();
    if (run && run.id) {
      var fresh = Date.now() - (run.at || 0) < 30 * 60000;
      if (run.nav && fresh && (!run.page || run.page === PAGE)) {
        writeRun(Object.assign({}, run, { nav: false }));
        var go = function () { start(run.id, { step: run.i, chain: run.chain }); };
        // let the page draw its own content first
        if (d.readyState === "complete") setTimeout(go, 250); else w.addEventListener("load", function () { setTimeout(go, 250); });
        return;
      }
      if (fresh) showPill(run); else writeRun(null);
    }
    if (d.readyState === "complete") setTimeout(maybeWelcome, 900); else w.addEventListener("load", function () { setTimeout(maybeWelcome, 900); });
    if (location.hash === "#help") { try { history.replaceState(null, "", location.pathname + location.search); } catch (_) {} setTimeout(openHelp, 300); }
  }

  w.KfpTour = {
    register: register, start: start, openHelp: openHelp, stop: function () { stop("exit"); },
    next: next, prev: prev, skip: skip,
    isRunning: function () { return !!R; },
    state: readState, tours: function () { return ORDER.slice(); }, page: PAGE, ctx: ctx,
    welcome: welcome, load: loadContent
  };
  if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", init); else init();
})();
