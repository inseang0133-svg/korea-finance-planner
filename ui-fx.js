/*
  ui-fx.js — visual effects layer (presentation only)
  - ไม่แก้ข้อความ/ค่า/state ของแอป  ไม่เรียกฟังก์ชันเดิม
  - ใส่/ถอดเฉพาะ class และ CSS variable เพื่อทำอนิเมชัน
*/
(function () {
  "use strict";
  if (window.__kfpFx) return;
  window.__kfpFx = true;

  var d = document, root = d.documentElement, body = d.body;
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var finePointer = window.matchMedia && matchMedia("(hover:hover) and (pointer:fine)").matches;

  /* ---------- background + scroll progress ---------- */
  var aurora = d.createElement("div");
  aurora.className = "fx-aurora";
  aurora.setAttribute("aria-hidden", "true");
  aurora.innerHTML = "<i></i><i></i><i></i>";
  body.insertBefore(aurora, body.firstChild);

  var bar = d.createElement("div");
  bar.className = "fx-progress";
  bar.setAttribute("aria-hidden", "true");
  body.appendChild(bar);

  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      var max = root.scrollHeight - window.innerHeight;
      bar.style.transform = "scaleX(" + (max > 0 ? Math.min(1, window.scrollY / max) : 0) + ")";
      ticking = false;
    });
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- reveal on scroll (staggered) ---------- */
  var REVEAL = ".card,.gold-card,.result-card,.stat-box,.gold-stat,.news-item";
  var io = null;

  function revealAll() {
    d.querySelectorAll(".fx-reveal:not(.in)").forEach(function (el) { el.classList.add("in"); });
  }

  if (!reduce && "IntersectionObserver" in window) {
    root.classList.add("fx-on");
    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add("in");
          io.unobserve(en.target);
        }
      });
    }, { threshold: 0.08, rootMargin: "0px 0px -4% 0px" });

    d.querySelectorAll(REVEAL).forEach(function (el) {
      var sibs = el.parentElement ? Array.prototype.filter.call(el.parentElement.children, function (c) {
        return c.matches(REVEAL);
      }) : [el];
      el.style.setProperty("--i", Math.min(sibs.indexOf(el), 7));
      el.classList.add("fx-reveal");
      io.observe(el);
    });
    // failsafe: never leave content hidden
    setTimeout(revealAll, 3500);
  }

  /* ---------- pointer spotlight on surfaces ---------- */
  if (finePointer) {
    var SPOT = ".card,.gold-card,.result-card,.stat-box,.gold-stat,.market-box,.lot-item,.news-item";
    var raf = 0, lastEv = null;
    d.addEventListener("pointermove", function (e) {
      lastEv = e;
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = 0;
        var el = lastEv.target.closest && lastEv.target.closest(SPOT);
        if (!el) return;
        var r = el.getBoundingClientRect();
        el.style.setProperty("--mx", (lastEv.clientX - r.left) + "px");
        el.style.setProperty("--my", (lastEv.clientY - r.top) + "px");
      });
    }, { passive: true });
  }

  /* ---------- button ripple ---------- */
  d.addEventListener("pointerdown", function (e) {
    if (reduce) return;
    var btn = e.target.closest && e.target.closest("button");
    if (!btn || btn.classList.contains("kfp-fab") || (btn.id && btn.id.indexOf("kfp") === 0)) return;
    var r = btn.getBoundingClientRect();
    var size = Math.max(r.width, r.height) * 2;
    var s = d.createElement("span");
    s.className = "fx-ripple";
    s.style.width = s.style.height = size + "px";
    s.style.left = (e.clientX - r.left - size / 2) + "px";
    s.style.top = (e.clientY - r.top - size / 2) + "px";
    btn.classList.add("fx-ripple-host");
    btn.appendChild(s);
    setTimeout(function () { if (s.parentNode) s.parentNode.removeChild(s); }, 700);
  }, { passive: true });

  /* ---------- flash when a computed value changes ---------- */
  var WATCH = [
    // index.html
    "saving", "gold", "family", "personal", "travel", "salaryTHBPreview",
    "totalSalaryKRW", "totalSalaryTHB", "totalSavingKRW", "totalSavingTHB",
    "totalFamilyKRW", "totalFamilyTHB", "totalGoldKRW", "totalGoldTHB",
    "totalPersonalKRW", "totalPersonalTHB", "totalTravelKRW", "totalTravelTHB",
    "goldPortfolioValue", "goldPortfolioPL", "convertResult", "remitResult",
    "progressText", "goalInfo", "contractResult",
    // gold.html
    "spotUsd", "usdThb", "goldThbGram", "goldThbOz", "thaiBarBuy", "thaiBarSell",
    "gold2goReceivePrice", "gold2goSellPrice", "thaiJewelryBuy", "thaiJewelrySell",
    "totalGold", "totalGoldOz", "totalCost", "currentValue", "netPL", "netPLPct",
    "positivePL", "negativePL", "avgCost", "winRate", "winRatePct",
    "chartCurrentOz", "buyCalcResult", "simulateResult"
  ];
  if (!reduce && "MutationObserver" in window) {
    var mo = new MutationObserver(function (list) {
      var seen = [];
      list.forEach(function (m) {
        var el = m.target.nodeType === 3 ? m.target.parentElement : m.target;
        while (el && !(el.id && WATCH.indexOf(el.id) > -1)) el = el.parentElement;
        if (el && seen.indexOf(el) < 0) seen.push(el);
      });
      seen.forEach(function (el) {
        el.classList.remove("fx-flash");
        void el.offsetWidth; // restart animation
        el.classList.add("fx-flash");
      });
    });
    WATCH.forEach(function (id) {
      var el = d.getElementById(id);
      if (el) mo.observe(el, { childList: true, characterData: true, subtree: true });
    });
    d.addEventListener("animationend", function (e) {
      if (e.animationName === "fx-flash") e.target.classList.remove("fx-flash");
    });
  }
})();
