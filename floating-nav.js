/*
  Floating Nav v2 — Liquid-Glass bubble with spring physics
  - Vanilla JS + CSS, no dependencies, standalone (touches no other script/state).
  - <script src="floating-nav.js" data-target="gold.html" data-icon="🪙" data-label="..."></script>

  Physics (requestAnimationFrame, fixed sub-steps, semi-implicit Euler):
   • Position spring follows the finger with lag (underdamped -> slight wobble)
   • Squash & stretch along the velocity direction (low-pass filtered)
   • Release: bubble keeps its momentum, is pulled to the nearest edge by a bouncy spring
   • Wall impact: separate squash oscillator makes it flatten against the screen edge, then settle
   • Press / drag / tap use a "scale" spring (press-in, grow while dragging, squish on tap)
   • Specular highlight slides opposite to motion for a liquid "sloshing" look
   • Loop sleeps when everything is at rest
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

  var SIZE = 60;
  var EDGE_GAP = 10;
  var TOP_SAFE = 72;
  var BOTTOM_SAFE = 34;
  var DRAG_THRESHOLD = 6;
  var IDLE_MS = 2600;
  var reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- styles ---------- */
  var css = [
    ".kfp-fab{position:fixed;left:0;top:0;width:" + SIZE + "px;height:" + SIZE + "px;z-index:9000;",
    "padding:0;margin:0;border-radius:50%;cursor:grab;touch-action:none;outline:none;",
    "-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;",
    "display:flex;align-items:center;justify-content:center;font-size:26px;line-height:1;color:#fff6d6;",
    "background:",
    "radial-gradient(90% 90% at 50% 112%,rgba(255,214,102,.34),rgba(255,214,102,0) 62%),",
    "radial-gradient(120% 120% at 30% 12%,rgba(255,255,255,.26),rgba(255,255,255,.05) 42%,rgba(255,255,255,0) 64%),",
    "linear-gradient(150deg,rgba(255,236,170,.20),rgba(212,175,55,.07) 55%,rgba(255,255,255,.04));",
    "-webkit-backdrop-filter:blur(14px) saturate(210%) brightness(1.12) contrast(1.05);",
    "backdrop-filter:blur(14px) saturate(210%) brightness(1.12) contrast(1.05);",
    "border:1px solid rgba(255,240,190,.38);",
    "box-shadow:",
    "inset 0 1.5px 1px rgba(255,255,255,.70),",
    "inset 0 -2px 3px rgba(255,214,102,.45),",
    "inset 4px 0 8px rgba(255,255,255,.07),inset -4px 0 8px rgba(255,214,102,.10),",
    "0 12px 26px rgba(0,0,0,.50),0 3px 8px rgba(0,0,0,.35),0 0 26px rgba(212,175,55,.20);",
    "transform-origin:50% 50%;will-change:transform,opacity;opacity:1;",
    "transition:opacity .45s ease,box-shadow .35s ease}",
    /* top specular blob (slides with motion) */
    ".kfp-fab::before{content:'';position:absolute;left:11px;right:11px;top:4px;height:38%;",
    "border-radius:50% 50% 55% 55%/75% 75% 40% 40%;",
    "background:linear-gradient(180deg,rgba(255,255,255,.62),rgba(255,255,255,.04));",
    "pointer-events:none;opacity:.8;transform:translate(var(--hx,0px),var(--hy,0px));filter:blur(.4px)}",
    /* rim caustic */
    ".kfp-fab::after{content:'';position:absolute;inset:0;border-radius:50%;pointer-events:none;mix-blend-mode:screen;",
    "background:conic-gradient(from 200deg,rgba(255,255,255,0) 0deg,rgba(255,255,255,.26) 38deg,rgba(255,255,255,0) 84deg,",
    "rgba(255,255,255,0) 196deg,rgba(255,224,130,.28) 246deg,rgba(255,255,255,0) 300deg);",
    "-webkit-mask:radial-gradient(circle,transparent 58%,#000 66%);mask:radial-gradient(circle,transparent 58%,#000 66%)}",
    ".kfp-fab .kfp-ico{position:relative;z-index:1;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45));",
    "transform:translate(calc(var(--hx,0px)*-.5),calc(var(--hy,0px)*-.5));pointer-events:none}",
    ".kfp-fab.kfp-idle{opacity:.55}",
    ".kfp-fab.kfp-drag{cursor:grabbing;opacity:1;",
    "box-shadow:inset 0 1.5px 1px rgba(255,255,255,.8),inset 0 -2px 3px rgba(255,214,102,.55),",
    "0 22px 40px rgba(0,0,0,.55),0 6px 12px rgba(0,0,0,.35),0 0 38px rgba(243,216,112,.38)}",
    ".kfp-fab:focus-visible{box-shadow:0 0 0 3px rgba(243,216,112,.8),0 12px 26px rgba(0,0,0,.5)}",
    "@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){",
    ".kfp-fab{background:linear-gradient(150deg,rgba(80,66,24,.94),rgba(34,28,12,.94))}}"
  ].join("");
  var style = document.createElement("style");
  style.id = "kfp-fab-style";
  style.textContent = css;
  document.head.appendChild(style);

  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "kfp-fab";
  btn.setAttribute("aria-label", LABEL);
  btn.title = LABEL;
  btn.innerHTML = '<span class="kfp-ico" aria-hidden="true">' + ICON + "</span>";

  /* ---------- state ---------- */
  var vw = 0, vh = 0;
  var side = "right", dockY = 0;
  var x = 0, y = 0, vx = 0, vy = 0;           // position + velocity (px, px/s)
  var stretch = 0, angle = 0;                  // filtered velocity stretch
  var q = 0, qv = 0;                           // wall-impact squash oscillator
  var sc = 1, scv = 0, scTarget = 1;           // press / drag scale spring
  var dragging = false, pressed = false, moved = false, impacted = true;
  var tx = 0, ty = 0;                          // drag target (finger)
  var grabX = 0, grabY = 0, startPX = 0, startPY = 0, pid = null;
  var raf = 0, lastT = 0;

  function measure() { vw = window.innerWidth; vh = window.innerHeight; }
  function clampY(v) { return Math.max(TOP_SAFE, Math.min(vh - SIZE - BOTTOM_SAFE, v)); }
  function dockX() { return side === "left" ? EDGE_GAP : vw - SIZE - EDGE_GAP; }

  /* ---------- render ---------- */
  function render() {
    var sp = Math.sqrt(vx * vx + vy * vy);
    if (sp > 40) angle = Math.atan2(vy, vx);
    var a = angle, s = stretch;
    // Along motion: elongate. Across motion: thin a little (volume-ish).
    var sx = 1 + s, sy = 1 - s * 0.55;
    var hx = Math.max(-5, Math.min(5, -vx * 0.0025));
    var hy = Math.max(-5, Math.min(5, -vy * 0.0025));
    btn.style.setProperty("--hx", hx.toFixed(2) + "px");
    btn.style.setProperty("--hy", hy.toFixed(2) + "px");
    btn.style.transform =
      "translate3d(" + x.toFixed(2) + "px," + y.toFixed(2) + "px,0)" +
      " rotate(" + a.toFixed(4) + "rad) scale(" + sx.toFixed(4) + "," + sy.toFixed(4) + ") rotate(" + (-a).toFixed(4) + "rad)" +
      " scale(" + (sc * (1 - q)).toFixed(4) + "," + (sc * (1 + q * 0.7)).toFixed(4) + ")";
  }

  /* ---------- physics ---------- */
  function impact(speed) {
    // flatten against the wall proportional to impact speed
    qv += Math.min(speed / 330, 7.5) * 1;
  }

  function step(dt) {
    var k, c, fx, fy;
    if (dragging) {
      k = 420; c = 2 * 0.58 * Math.sqrt(k);              // lag + slight wobble
      fx = k * (tx - x) - c * vx;
      fy = k * (ty - y) - c * vy;
    } else {
      k = 190; c = 2 * 0.40 * Math.sqrt(k);              // bouncy snap
      fx = k * (dockX() - x) - c * vx;
      fy = k * (dockY - y) - c * vy;
    }
    vx += fx * dt; vy += fy * dt;
    x += vx * dt;  y += vy * dt;

    // hard screen edges: balloon bounces off the wall
    var minX = 1, maxX = vw - SIZE - 1;
    if (x < minX) { if (!dragging && vx < -150) impact(-vx); x = minX; vx = dragging ? 0 : -vx * 0.35; }
    else if (x > maxX) { if (!dragging && vx > 150) impact(vx); x = maxX; vx = dragging ? 0 : -vx * 0.35; }
    var minY = TOP_SAFE - 30, maxY = vh - SIZE - 6;
    if (y < minY) { y = minY; vy = dragging ? 0 : -vy * 0.3; }
    else if (y > maxY) { y = maxY; vy = dragging ? 0 : -vy * 0.3; }

    // first time the bubble reaches the dock line moving outward -> impact squash
    if (!dragging && !impacted) {
      var out = side === "right" ? vx : -vx;
      var passed = side === "right" ? x >= dockX() : x <= dockX();
      if (passed) { impacted = true; if (out > 120) impact(out); }
    }

    // squash oscillator + scale spring
    var qk = 430, qc = 2 * 0.27 * Math.sqrt(qk);
    qv += (-qk * q - qc * qv) * dt; q += qv * dt;
    var sk = 360, scc = 2 * 0.52 * Math.sqrt(sk);
    scv += (sk * (scTarget - sc) - scc * scv) * dt; sc += scv * dt;

    // velocity-based stretch, low-pass filtered
    var sp = Math.sqrt(vx * vx + vy * vy);
    var want = Math.min(sp / 3600, 0.26);
    stretch += (want - stretch) * Math.min(1, dt * 16);
  }

  function atRest() {
    return !dragging &&
      Math.abs(vx) < 4 && Math.abs(vy) < 4 &&
      Math.abs(x - dockX()) < 0.3 && Math.abs(y - dockY) < 0.3 &&
      Math.abs(q) < 0.002 && Math.abs(qv) < 0.05 &&
      Math.abs(sc - scTarget) < 0.002 && Math.abs(scv) < 0.05 &&
      stretch < 0.003;
  }

  function frame(t) {
    var dt = Math.min(0.033, (t - lastT) / 1000 || 0.016);
    lastT = t;
    var n = Math.max(1, Math.ceil(dt / (1 / 120)));
    var h = dt / n;
    for (var i = 0; i < n; i++) step(h);
    render();
    if (atRest()) {
      x = dockX(); y = dockY; vx = vy = 0; q = qv = 0; sc = scTarget; scv = 0; stretch = 0;
      render(); raf = 0; return;
    }
    raf = requestAnimationFrame(frame);
  }
  function wakeLoop() {
    if (raf) return;
    lastT = performance.now();
    raf = requestAnimationFrame(frame);
  }

  /* reduced motion: no springs, plain snap */
  function snapInstant() {
    x = dockX(); y = dockY; vx = vy = 0; q = qv = 0; stretch = 0; sc = scTarget = 1; scv = 0;
    render();
  }

  /* ---------- persistence ---------- */
  function savePos() {
    try { localStorage.setItem(POS_KEY, JSON.stringify({ side: side, yr: dockY / Math.max(1, vh) })); } catch (_) {}
  }
  function loadPos() {
    try {
      var p = JSON.parse(localStorage.getItem(POS_KEY) || "null");
      if (p && (p.side === "left" || p.side === "right") && isFinite(p.yr)) {
        side = p.side; dockY = clampY(p.yr * vh); return;
      }
    } catch (_) {}
    side = "right"; dockY = clampY(vh * 0.68);
  }

  /* ---------- idle dimming ---------- */
  var idleTimer = null;
  function wake() {
    btn.classList.remove("kfp-idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { if (!dragging && !pressed) btn.classList.add("kfp-idle"); }, IDLE_MS);
  }

  /* ---------- gestures ---------- */
  btn.addEventListener("pointerdown", function (e) {
    if (e.button !== undefined && e.button !== 0) return;
    pressed = true; moved = false; pid = e.pointerId;
    startPX = e.clientX; startPY = e.clientY;
    grabX = e.clientX - x; grabY = e.clientY - y;
    try { btn.setPointerCapture(pid); } catch (_) {}
    scTarget = 0.9;                       // press in
    if (reduceMotion) { sc = 0.95; render(); } else wakeLoop();
    wake();
  });

  btn.addEventListener("pointermove", function (e) {
    if (!pressed || e.pointerId !== pid) return;
    if (!moved) {
      if (Math.abs(e.clientX - startPX) + Math.abs(e.clientY - startPY) < DRAG_THRESHOLD) return;
      moved = true; dragging = true; impacted = true;
      btn.classList.add("kfp-drag");
      scTarget = 1.1;                     // lift & grow
    }
    tx = e.clientX - grabX; ty = e.clientY - grabY;
    tx = Math.max(-8, Math.min(vw - SIZE + 8, tx));
    ty = Math.max(TOP_SAFE - 30, Math.min(vh - SIZE - 6, ty));
    if (reduceMotion) { x = tx; y = ty; render(); } else wakeLoop();
    e.preventDefault();
  });

  function release(e) {
    if (!pressed || (e && e.pointerId !== undefined && e.pointerId !== pid)) return;
    pressed = false;
    try { btn.releasePointerCapture(pid); } catch (_) {}
    scTarget = 1;
    if (dragging) {
      dragging = false;
      btn.classList.remove("kfp-drag");
      // choose edge by position + momentum (a flick can throw it to the far side)
      var cx = x + SIZE / 2 + vx * 0.12;
      side = cx < vw / 2 ? "left" : "right";
      dockY = clampY(y + vy * 0.08);
      impacted = false;
      savePos();
      if (reduceMotion) snapInstant(); else wakeLoop();
    } else if (!reduceMotion) wakeLoop();
    wake();
  }

  btn.addEventListener("pointerup", function (e) {
    var wasDrag = moved;
    release(e);
    if (!wasDrag) go();
  });
  btn.addEventListener("pointercancel", release);
  btn.addEventListener("lostpointercapture", function () { if (pressed) release(); });
  btn.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  btn.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
  });

  var navigating = false;
  function go() {
    if (navigating) return;
    navigating = true;
    // quick squish-pop so the tap feels alive, then navigate
    scTarget = 1; sc = 0.84; scv = 5; qv += 3;
    if (reduceMotion) { location.href = TARGET; return; }
    wakeLoop();
    setTimeout(function () { location.href = TARGET; }, 170);
    setTimeout(function () { navigating = false; }, 1500); // bfcache / failed nav safety
  }

  /* ---------- lifecycle ---------- */
  ["scroll", "touchstart", "mousemove"].forEach(function (ev) {
    window.addEventListener(ev, wake, { passive: true });
  });
  function relayout() { measure(); dockY = clampY(dockY); snapInstant(); }
  window.addEventListener("resize", relayout);
  window.addEventListener("orientationchange", function () { setTimeout(relayout, 250); });
  window.addEventListener("pageshow", function () { navigating = false; relayout(); wake(); });

  function mount() {
    measure(); loadPos();
    document.body.appendChild(btn);
    x = dockX(); y = dockY;
    // gentle entrance: bubble pops in like a droplet
    if (!reduceMotion) { sc = 0.35; scv = 0; render(); wakeLoop(); }
    else render();
    wake();
  }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
})();
