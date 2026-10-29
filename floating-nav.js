/*
  Floating Nav — Draggable Liquid-Glass FAB with Magnetic Edge Dock
  - Standalone: does not touch any other script / state.
  - Usage: <script src="floating-nav.js" data-target="gold.html" data-icon="🪙" data-label="ดูพอร์ตทอง"></script>
  - Drag freely, release -> springs to the nearest left/right edge.
  - Tap (no drag) -> navigates to data-target.
  - Non-dismissible. Dims + tucks half into the edge when idle.
*/
(function () {
  "use strict";
  if (window.__kfpFloatingNav) return;
  window.__kfpFloatingNav = true;

  var script = document.currentScript;
  var TARGET = (script && script.dataset.target) || "index.html";
  var ICON = (script && script.dataset.icon) || "🏠";
  var LABEL = (script && script.dataset.label) || "นำทาง";
  var POS_KEY = "kfp_fab_pos_v1";

  var SIZE = 58;            // bubble diameter
  var EDGE_GAP = 10;        // gap from screen edge (keeps clear of OS edge-swipe)
  var TOP_SAFE = 70;        // keeps clear of the user pill at the top
  var BOTTOM_SAFE = 24;
  var DRAG_THRESHOLD = 6;   // px before a press becomes a drag
  var IDLE_MS = 2600;

  /* ---------- styles ---------- */
  var css = [
    ".kfp-fab{position:fixed;left:0;top:0;width:" + SIZE + "px;height:" + SIZE + "px;z-index:9000;",
    "border:0;padding:0;margin:0;border-radius:50%;cursor:grab;touch-action:none;",
    "-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none;",
    "display:flex;align-items:center;justify-content:center;font-size:25px;line-height:1;color:#fff4cf;",
    "background:",
    "radial-gradient(120% 120% at 28% 18%,rgba(255,255,255,.34) 0%,rgba(255,255,255,.08) 38%,rgba(255,255,255,0) 60%),",
    "linear-gradient(145deg,rgba(243,216,112,.30),rgba(212,175,55,.10) 55%,rgba(255,255,255,.06));",
    "-webkit-backdrop-filter:blur(18px) saturate(190%) brightness(1.08);backdrop-filter:blur(18px) saturate(190%) brightness(1.08);",
    "border:1px solid rgba(255,238,170,.42);",
    "box-shadow:inset 0 1.5px 1px rgba(255,255,255,.55),inset 0 -6px 12px rgba(212,175,55,.18),",
    "inset 0 0 0 .5px rgba(255,255,255,.12),0 10px 28px rgba(0,0,0,.55),0 0 24px rgba(212,175,55,.22);",
    "transition:transform .5s cubic-bezier(.34,1.56,.64,1),opacity .35s ease,box-shadow .3s ease;",
    "will-change:transform;opacity:1}",
    ".kfp-fab::before{content:'';position:absolute;inset:3px 7px auto 7px;height:42%;border-radius:50% 50% 60% 60%/70% 70% 40% 40%;",
    "background:linear-gradient(180deg,rgba(255,255,255,.5),rgba(255,255,255,0));pointer-events:none;opacity:.75}",
    ".kfp-fab::after{content:'';position:absolute;inset:0;border-radius:50%;pointer-events:none;",
    "background:conic-gradient(from 210deg,rgba(255,255,255,0) 0deg,rgba(255,255,255,.22) 40deg,rgba(255,255,255,0) 90deg,rgba(255,255,255,0) 200deg,rgba(255,226,140,.2) 250deg,rgba(255,255,255,0) 300deg);",
    "mix-blend-mode:screen}",
    ".kfp-fab .kfp-ico{position:relative;z-index:1;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45));transition:transform .3s cubic-bezier(.34,1.56,.64,1)}",
    ".kfp-fab.kfp-idle{opacity:.55}",
    ".kfp-fab.kfp-drag{cursor:grabbing;transition:box-shadow .2s ease,opacity .2s ease;opacity:1;",
    "box-shadow:inset 0 1.5px 1px rgba(255,255,255,.65),inset 0 -6px 12px rgba(212,175,55,.25),0 18px 40px rgba(0,0,0,.6),0 0 34px rgba(243,216,112,.4)}",
    ".kfp-fab.kfp-drag .kfp-ico{transform:scale(1.08)}",
    ".kfp-fab:focus-visible{outline:2px solid #f3d870;outline-offset:3px}",
    "@media (prefers-reduced-motion:reduce){.kfp-fab{transition:opacity .2s ease}}",
    "@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.kfp-fab{background:linear-gradient(145deg,rgba(60,50,20,.92),rgba(30,26,12,.92))}}"
  ].join("");

  var style = document.createElement("style");
  style.id = "kfp-fab-style";
  style.textContent = css;
  document.head.appendChild(style);

  /* ---------- element ---------- */
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "kfp-fab";
  btn.setAttribute("aria-label", LABEL);
  btn.title = LABEL;
  btn.innerHTML = '<span class="kfp-ico" aria-hidden="true">' + ICON + "</span>";

  /* ---------- geometry ---------- */
  var side = "right";   // "left" | "right"
  var yPos = 0;         // top (px)
  var x = 0, y = 0;     // current translate
  var vw = 0, vh = 0;

  function measure() {
    vw = window.innerWidth;
    vh = window.innerHeight;
  }
  function clampY(v) {
    return Math.max(TOP_SAFE, Math.min(vh - SIZE - BOTTOM_SAFE, v));
  }
  function dockX(s) {
    return s === "left" ? EDGE_GAP : vw - SIZE - EDGE_GAP;
  }
  function apply(nx, ny) {
    x = nx; y = ny;
    btn.style.transform = "translate3d(" + nx + "px," + ny + "px,0)";
  }
  function dock(animate) {
    if (!animate) btn.style.transition = "none";
    else btn.style.transition = "";
    yPos = clampY(yPos);
    apply(dockX(side), yPos);
    if (!animate) { void btn.offsetWidth; btn.style.transition = ""; }
  }
  function savePos() {
    try { localStorage.setItem(POS_KEY, JSON.stringify({ side: side, yr: yPos / Math.max(1, vh) })); } catch (_) {}
  }
  function loadPos() {
    try {
      var p = JSON.parse(localStorage.getItem(POS_KEY) || "null");
      if (p && (p.side === "left" || p.side === "right") && isFinite(p.yr)) {
        side = p.side; yPos = p.yr * vh; return;
      }
    } catch (_) {}
    side = "right"; yPos = vh * 0.68;
  }

  /* ---------- idle dimming ---------- */
  var idleTimer = null;
  function wake() {
    btn.classList.remove("kfp-idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (!dragging) btn.classList.add("kfp-idle");
    }, IDLE_MS);
  }

  /* ---------- drag ---------- */
  var dragging = false, pressed = false, moved = false;
  var startPX = 0, startPY = 0, startX = 0, startY = 0, pid = null;

  btn.addEventListener("pointerdown", function (e) {
    if (e.button !== undefined && e.button !== 0) return;
    pressed = true; moved = false; pid = e.pointerId;
    startPX = e.clientX; startPY = e.clientY; startX = x; startY = y;
    try { btn.setPointerCapture(pid); } catch (_) {}
    wake();
  });

  btn.addEventListener("pointermove", function (e) {
    if (!pressed || e.pointerId !== pid) return;
    var dx = e.clientX - startPX, dy = e.clientY - startPY;
    if (!moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
    if (!moved) {
      moved = true; dragging = true;
      btn.classList.add("kfp-drag");
      btn.style.transition = "box-shadow .2s ease,opacity .2s ease"; // follow finger 1:1
    }
    var nx = Math.max(0, Math.min(vw - SIZE, startX + dx));
    var ny = Math.max(TOP_SAFE - 20, Math.min(vh - SIZE - 4, startY + dy));
    apply(nx, ny);
    e.preventDefault();
  });

  function release(e) {
    if (!pressed || (e && e.pointerId !== pid)) return;
    pressed = false;
    try { btn.releasePointerCapture(pid); } catch (_) {}
    if (dragging) {
      dragging = false;
      btn.classList.remove("kfp-drag");
      side = (x + SIZE / 2) < vw / 2 ? "left" : "right"; // magnetic: nearest edge
      yPos = clampY(y);
      btn.style.transition = ""; // spring back via CSS cubic-bezier
      apply(dockX(side), yPos);
      savePos();
    }
    wake();
  }
  btn.addEventListener("pointerup", function (e) {
    var wasDrag = moved;
    release(e);
    if (!wasDrag) go();
  });
  btn.addEventListener("pointercancel", release);
  btn.addEventListener("lostpointercapture", function () { if (pressed) release(); });

  // keyboard accessibility
  btn.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
  });

  function go() {
    btn.style.transform += " scale(.9)";
    setTimeout(function () { location.href = TARGET; }, 90);
  }

  /* ---------- lifecycle ---------- */
  ["scroll", "touchstart", "mousemove"].forEach(function (ev) {
    window.addEventListener(ev, wake, { passive: true });
  });
  window.addEventListener("resize", function () { measure(); dock(false); });
  window.addEventListener("orientationchange", function () { setTimeout(function () { measure(); dock(false); }, 250); });
  window.addEventListener("pageshow", function () { measure(); dock(false); wake(); });

  function mount() {
    measure();
    loadPos();
    document.body.appendChild(btn);
    dock(false);
    wake();
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
