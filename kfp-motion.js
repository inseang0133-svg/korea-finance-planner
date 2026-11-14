/* kfp-motion.js — presentation-only motion for pricing.html · account.html · admin.html
 * (pairs with kfp-motion.css). Never changes text, values or app state: it only adds
 * classes, CSS variables and decorative elements (aria-hidden). Works with content that
 * the page renders later (MutationObserver). Respects prefers-reduced-motion. */
(function () {
  "use strict";
  if (window.__kfpMotion) return;
  window.__kfpMotion = true;

  var d = document, root = d.documentElement, body = d.body;
  var reduce = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  var finePointer = !!(window.matchMedia && matchMedia("(hover:hover) and (pointer:fine)").matches);
  var page = (location.pathname.split("/").pop() || "index.html").replace(/\.html$/, "");

  body.classList.add("kfm-on", "kfm-" + page);

  /* ---------- aurora background ---------- */
  if (!d.querySelector(".fx-aurora,.kfm-aurora")) {
    var aurora = d.createElement("div");
    aurora.className = "kfm-aurora";
    aurora.setAttribute("aria-hidden", "true");
    aurora.innerHTML = "<i></i><i></i><i></i>";
    body.insertBefore(aurora, body.firstChild);
  }

  /* ---------- staggered reveal ---------- */
  var REVEAL = ".plan,.kfm-account .card,.kpi,.tbl-wrap,.note";
  var io = null;
  if (!reduce && "IntersectionObserver" in window) {
    root.classList.add("kfm-js");
    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.06, rootMargin: "0px 0px -3% 0px" });
  }
  function tagReveal(scope) {
    if (!io) return;
    (scope || d).querySelectorAll(REVEAL).forEach(function (el) {
      if (el.classList.contains("kfm-r")) return;
      var sibs = el.parentElement ? Array.prototype.filter.call(el.parentElement.children, function (c) { return c.matches(REVEAL); }) : [el];
      el.style.setProperty("--i", Math.min(Math.max(sibs.indexOf(el), 0), 8));
      el.classList.add("kfm-r");
      io.observe(el);
      setTimeout(function () { el.classList.add("in"); }, 2600);       // never leave anything hidden
    });
  }

  /* ---------- value flash when numbers/plan change ---------- */
  var FLASH = ".kpi dd,.price b,.plan-name,.plan-price b";
  function flash(el) {
    if (reduce || !el || !el.classList) return;
    el.classList.remove("kfm-flash"); void el.offsetWidth; el.classList.add("kfm-flash");
  }

  /* ---------- sliding thumb on segmented toggles (pricing) ---------- */
  function placeThumb(seg) {
    var on = seg.querySelector("button.on"), th = seg.querySelector(".kfm-thumb");
    if (!on || !th) return;
    th.style.width = on.offsetWidth + "px";
    th.style.transform = "translateX(" + on.offsetLeft + "px)";
  }
  function initSegs() {
    d.querySelectorAll(".seg").forEach(function (seg) {
      if (seg.querySelector(".kfm-thumb")) return placeThumb(seg);
      var th = d.createElement("span");
      th.className = "kfm-thumb"; th.setAttribute("aria-hidden", "true");
      seg.insertBefore(th, seg.firstChild);
      seg.classList.add("kfm-slide");
      placeThumb(seg);
      new MutationObserver(function () { placeThumb(seg); }).observe(seg, { subtree: true, attributes: true, attributeFilter: ["class"] });
    });
  }

  /* ---------- gliding ink under admin tabs ---------- */
  function placeInk(tabs) {
    var on = tabs.querySelector('[aria-selected="true"]'), ink = tabs.querySelector(".kfm-ink");
    if (!on || !ink) return;
    ink.style.width = on.offsetWidth + "px";
    ink.style.transform = "translateX(" + on.offsetLeft + "px)";
  }
  function initTabs() {
    d.querySelectorAll(".kfa-tabs").forEach(function (tabs) {
      if (tabs.querySelector(".kfm-ink")) return placeInk(tabs);
      var ink = d.createElement("span");
      ink.className = "kfm-ink"; ink.setAttribute("aria-hidden", "true");
      tabs.appendChild(ink);
      tabs.classList.add("kfm-ink-on");
      placeInk(tabs);
      new MutationObserver(function () { placeInk(tabs); }).observe(tabs, { subtree: true, attributes: true, attributeFilter: ["aria-selected"] });
    });
  }
  function relayout() {
    d.querySelectorAll(".seg").forEach(placeThumb);
    d.querySelectorAll(".kfa-tabs").forEach(placeInk);
  }
  window.addEventListener("resize", relayout);
  if (d.fonts && d.fonts.ready) d.fonts.ready.then(relayout);

  /* ---------- watch for content the page renders later ---------- */
  var pending = false;
  function sweep() { pending = false; tagReveal(); initSegs(); initTabs(); }
  new MutationObserver(function (muts) {
    muts.forEach(function (m) {
      var t = m.target.nodeType === 3 ? m.target.parentElement : m.target;
      if (t && t.closest && t.closest(FLASH) && (m.type === "characterData" || m.type === "childList")) flash(t.closest(FLASH));
      if (m.type === "childList") {
        m.addedNodes.forEach(function (n) {
          if (n.nodeType === 1 && n.matches && n.matches(FLASH)) flash(n);
        });
      }
    });
    if (!pending) { pending = true; Promise.resolve().then(sweep); }   // before paint → no flicker
  }).observe(body, { childList: true, subtree: true, characterData: true });
  sweep();

  /* ---------- pointer spotlight on glass ---------- */
  if (finePointer) {
    var SPOT = ".plan,.kfm-account .card,.kpi,.tbl-wrap", raf = 0, last = null;
    d.addEventListener("pointermove", function (e) {
      last = e;
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = 0;
        var el = last.target.closest && last.target.closest(SPOT);
        if (!el) return;
        var r = el.getBoundingClientRect();
        el.style.setProperty("--mx", (last.clientX - r.left) + "px");
        el.style.setProperty("--my", (last.clientY - r.top) + "px");
      });
    }, { passive: true });
  }

  /* ---------- ripple on press ---------- */
  if (!reduce) {
    d.addEventListener("pointerdown", function (e) {
      var b = e.target.closest && e.target.closest(".cta,.btn,.opt,.kfa-tab,.kfp-gc-btn");
      if (!b || b.disabled) return;
      var r = b.getBoundingClientRect(), s = Math.max(r.width, r.height) * 2.2;
      var dot = d.createElement("span");
      dot.className = "kfm-ripple"; dot.setAttribute("aria-hidden", "true");
      dot.style.cssText = "width:" + s + "px;height:" + s + "px;left:" + (e.clientX - r.left - s / 2) + "px;top:" + (e.clientY - r.top - s / 2) + "px";
      b.appendChild(dot);
      setTimeout(function () { if (dot.parentNode) dot.parentNode.removeChild(dot); }, 700);
    }, { passive: true });
  }
})();
