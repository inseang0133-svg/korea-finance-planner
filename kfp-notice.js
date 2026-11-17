/* kfp-notice.js — one-time celebration pop-ups (Phase 17)
 *   purchase → "ชำระเงินสำเร็จ" after a Stripe checkout (PLUS / PREMIUM / Add-on)
 *   gift     → "ของขวัญจากแอดมิน" when an admin grants a plan or add-on
 * Notices are created by the database (subscription trigger / admin RPCs); the browser only reads its own
 * unseen ones (get_my_notices) and marks them seen (ack_my_notices). Shown once per notice, on any page. */
(function () {
  "use strict";
  if (window.kfpNotice) return;
  var COLORS = ["#ffd66b", "#e8be46", "#fff2b8", "#3ddc97", "#5aa8ff", "#ff7aa8", "#ffffff"];
  var busy = false, shown = {}, queue = [];
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  function client() { return window.kfpAuth && window.kfpAuth.client && window.kfpAuth.client(); }
  function user() { return window.kfpAuth && window.kfpAuth.user && window.kfpAuth.user(); }

  function fireworks(canvas) {
    if (!canvas || !canvas.getContext) return function () {};
    if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return function () {};
    var ctx = canvas.getContext("2d"), dpr = Math.min(window.devicePixelRatio || 1, 2), W, H, parts = [], rockets = [], raf = 0, t0 = performance.now(), stopped = false;
    function size() { W = canvas.clientWidth; H = canvas.clientHeight; canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
    size(); window.addEventListener("resize", size);
    var rnd = function (a, b) { return a + Math.random() * (b - a); };
    function burst(x, y) {
      var n = 46 + (Math.random() * 18 | 0), c1 = COLORS[Math.random() * COLORS.length | 0], c2 = COLORS[Math.random() * COLORS.length | 0];
      for (var i = 0; i < n; i++) {
        var a = (Math.PI * 2 * i) / n + rnd(-0.05, 0.05), sp = rnd(1.6, 4.6);
        parts.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, decay: rnd(0.011, 0.02), r: rnd(1.4, 2.6), c: i % 2 ? c1 : c2, spark: true });
      }
    }
    function confetti() {
      for (var i = 0; i < 90; i++) parts.push({ x: rnd(0, W), y: rnd(-H * 0.4, -10), vx: rnd(-1, 1), vy: rnd(1.5, 3.4), life: 1, decay: rnd(0.003, 0.006),
        w: rnd(5, 9), h: rnd(8, 14), rot: rnd(0, 6.28), vr: rnd(-0.18, 0.18), c: COLORS[i % COLORS.length], spark: false });
    }
    var plan = [[0, 0.22, 0.30], [260, 0.78, 0.26], [520, 0.5, 0.18], [900, 0.3, 0.36], [1150, 0.7, 0.32], [1500, 0.5, 0.24]];
    plan.forEach(function (p) { setTimeout(function () { if (!stopped) rockets.push({ x: W * p[1], y: H + 10, ty: H * p[2], vy: -rnd(9, 11) }); }, p[0]); });
    confetti();
    function frame(ts) {
      ctx.clearRect(0, 0, W, H);
      for (var i = rockets.length - 1; i >= 0; i--) {
        var r = rockets[i]; r.y += r.vy; r.vy *= 0.985;
        ctx.fillStyle = "rgba(255,240,190,.95)"; ctx.beginPath(); ctx.arc(r.x, r.y, 2.2, 0, 6.29); ctx.fill();
        ctx.fillStyle = "rgba(232,190,70,.35)"; ctx.fillRect(r.x - 1, r.y + 3, 2, 14);
        if (r.y <= r.ty || r.vy > -2) { burst(r.x, r.y); rockets.splice(i, 1); }
      }
      for (var j = parts.length - 1; j >= 0; j--) {
        var p = parts[j];
        p.x += p.vx; p.y += p.vy; p.life -= p.decay;
        if (p.spark) { p.vx *= 0.975; p.vy = p.vy * 0.975 + 0.055; }
        else { p.rot += p.vr; p.vx += Math.sin(ts / 400 + j) * 0.02; }
        if (p.life <= 0 || p.y > H + 30) { parts.splice(j, 1); continue; }
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life * (p.spark ? 1.2 : 1.4)));
        ctx.fillStyle = p.c;
        if (p.spark) { ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.29); ctx.fill(); }
        else { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot * 1.3))); ctx.restore(); }
      }
      ctx.globalAlpha = 1;
      if (!stopped && (rockets.length || parts.length || ts - t0 < 1700)) raf = requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, W, H);
    }
    raf = requestAnimationFrame(frame);
    return function stop() { stopped = true; cancelAnimationFrame(raf); window.removeEventListener("resize", size); try { ctx.clearRect(0, 0, W, H); } catch (_) {} };
  }

  var ICON = { premium: "👑", plus: "⭐", addon_salary: "💰", addon_expense: "🧾", addon_work: "⏱️", addon_planning: "🎯", addon_cloud: "☁️", addon_gold: "🪙" };
  function itemHTML(it) {
    var tag = it.kind === "addon" ? '<span class="kfn-tag addon">ADD-ON</span>' : '<span class="kfn-tag ' + esc(it.id) + '">' + (it.id === "premium" ? "PREMIUM" : it.id === "plus" ? "PLUS" : esc(it.id)) + "</span>";
    return '<li><span class="kfn-ico" aria-hidden="true">' + (ICON[it.id] || "✨") + '</span><span class="kfn-name">' + esc(it.name || it.id) + "</span>" + tag + "</li>";
  }
  function until(n) {
    if (!n.expires_at) return n.kind === "gift" ? "ใช้ได้ไม่มีวันหมดอายุ" : "";
    try { return (n.kind === "gift" ? "ใช้ได้ถึง " : "รอบบิลถัดไป ") + new Date(n.expires_at).toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "numeric" }); } catch (_) { return ""; }
  }
  function show(n) {
    var gift = n.kind === "gift", items = Array.isArray(n.items) ? n.items : [];
    var ov = document.createElement("div");
    ov.className = "kfn-ov " + (gift ? "gift" : "purchase");
    ov.setAttribute("role", "dialog"); ov.setAttribute("aria-modal", "true"); ov.setAttribute("aria-labelledby", "kfnTitle");
    ov.innerHTML = '<canvas class="kfn-fx" aria-hidden="true"></canvas><div class="kfn-card">' +
      '<button type="button" class="kfn-x" aria-label="ปิด">✕</button>' +
      '<div class="kfn-badge" aria-hidden="true">' + (gift ? "🎁" : "🎉") + "</div>" +
      '<p class="kfn-eyebrow">' + (gift ? "GIFT FROM ADMIN" : "PAYMENT SUCCESSFUL") + "</p>" +
      '<h2 id="kfnTitle">' + (gift ? "ของขวัญจากแอดมิน!" : "ชำระเงินสำเร็จ ยินดีด้วย!") + "</h2>" +
      '<p class="kfn-sub">' + (gift ? "คุณได้รับสิทธิพิเศษต่อไปนี้ เปิดใช้งานให้แล้ว" : "ขอบคุณที่สนับสนุน ตอนนี้บัญชีของคุณใช้งาน") + "</p>" +
      '<ul class="kfn-list">' + items.map(itemHTML).join("") + "</ul>" +
      (until(n) ? '<p class="kfn-until">' + esc(until(n)) + "</p>" : "") +
      '<button type="button" class="kfn-go">เริ่มใช้งานเลย</button></div>';
    document.body.appendChild(ov);
    document.documentElement.classList.add("kfn-lock");
    var stop = fireworks(ov.querySelector(".kfn-fx")), go = ov.querySelector(".kfn-go");
    setTimeout(function () { ov.classList.add("in"); try { go.focus(); } catch (_) {} }, 20);
    function close() {
      ack([n.id]); stop(); ov.classList.remove("in");
      document.removeEventListener("keydown", key);
      setTimeout(function () { ov.remove(); document.documentElement.classList.remove("kfn-lock"); busy = false; next(); }, 220);
    }
    function key(e) { if (e.key === "Escape") close(); if (e.key === "Tab") { e.preventDefault(); (document.activeElement === go ? ov.querySelector(".kfn-x") : go).focus(); } }
    go.addEventListener("click", close); ov.querySelector(".kfn-x").addEventListener("click", close);
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    document.addEventListener("keydown", key);
  }
  function ack(ids) {
    var c = client(); if (!c || !ids.length) return;
    try { Promise.resolve(c.rpc("ack_my_notices", { p_ids: ids })).catch(function () {}); } catch (_) {}
  }
  function next() {
    if (busy || !queue.length) return;
    busy = true; show(queue.shift());
  }
  // returns a promise of how many new notices were queued
  function check() {
    var c = client();
    if (!c || !user() || (window.kfpStorage && window.kfpStorage.isPreview && window.kfpStorage.isPreview())) return Promise.resolve(0);
    return Promise.resolve(c.rpc("get_my_notices")).then(function (r) {
      var list = r && !r.error && Array.isArray(r.data) ? r.data : [], added = 0;
      list.forEach(function (n) { if (n && n.id && !shown[n.id]) { shown[n.id] = 1; queue.push(n); added++; } });
      next();
      return added;
    }, function () { return 0; });
  }
  var t = null;
  function soon(ms) { clearTimeout(t); t = setTimeout(check, ms); }
  window.addEventListener("kfp:plan", function () { soon(900); });
  window.addEventListener("kfp:auth-ready", function () { soon(1200); });
  window.kfpNotice = { check: check, show: show };
})();
