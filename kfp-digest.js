/* kfp-digest.js — monthly summary pop-ups for Finance Premium (feature "monthly_digest"), index.html.
 *
 *  Work summary   on the day set in บันทึกการเข้างาน → ⚙️ ตั้งค่า (notifyDay), or the first visit after it:
 *                 last month, 1st to last day — income, hours, work days, OT hours, weekend days, holidays.
 *  Expense summary on the 1st of every month, or the first visit after it: last month's expenses
 *                 (in the page's currency) compared with the month before (saved / spent more, % and amount).
 *  Each shows once per month (kfp_digest_seen_v1, synced with the rest of the account's data),
 *  with fireworks + confetti behind the card. Nothing is marked as seen while there is no data yet. */
(function () {
  "use strict";
  var d = document, SEEN_KEY = "kfp_digest_seen_v1";
  var THAI_MONTHS = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
  var num = function (v) { var n = Number(v); return isFinite(n) ? n : 0; };
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]; }); };
  function load(k, def) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; } catch (_) { return def; } }
  function save(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {}
    try { if (typeof kfpClearDeleted === "function") kfpClearDeleted(k); } catch (_) {}
    try { if (typeof kfpPersistNow === "function") kfpPersistNow(); } catch (_) {}
  }
  function now() { var t = window.__kfpDigestNow ? new Date(window.__kfpDigestNow) : new Date(); return t; }
  function ymOf(t) { return t.getFullYear() + "-" + pad(t.getMonth() + 1); }
  function addMonth(ym, delta) { var p = ym.split("-"), x = +p[0] * 12 + (+p[1] - 1) + delta; return Math.floor(x / 12) + "-" + pad((x % 12) + 1); }
  function daysIn(ym) { var p = ym.split("-"); return new Date(+p[0], +p[1], 0).getDate(); }
  function ymLabel(ym) { var p = ym.split("-"); return THAI_MONTHS[+p[1]] + " " + (+p[0] + 543); }
  function hrs(v) { v = num(v); return Number.isInteger(v) ? String(v) : String(+v.toFixed(1)); }
  function mode() { return typeof kfpGetMode === "function" ? kfpGetMode() : "KRW"; }
  function money(n, cur) {
    return cur === "KRW" ? "₩" + Math.round(num(n)).toLocaleString("en-US")
      : "฿" + num(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  /* ---------------- summaries (pure, exposed for tests) ---------------- */
  function workSummary(ym) {
    var list = (load("kfp_work_records_v1", []) || []).filter(function (r) { return r && String(r.date).slice(0, 7) === ym; });
    var s = { ym: ym, days: 0, hours: 0, ot: 0, weekend: 0, holiday: 0, krw: 0, thb: 0, otKrw: 0, received: null };
    list.forEach(function (r) {
      if (r.type === "day_off") return;
      s.days++; s.hours += num(r.reg) + num(r.ot); s.ot += num(r.ot);
      if (r.type === "weekend") s.weekend++;
      if (r.type === "holiday") s.holiday++;
      s.krw += num(r.krw); s.thb += num(r.thb); s.otKrw += num(r.otInc);
    });
    var rcv = load("kfp_work_received_v1", {}) || {};
    if (rcv[ym] && num(rcv[ym].krw) > 0) s.received = num(rcv[ym].krw);
    return s;
  }
  function expenseTotal(ym, cur) {
    var t = { total: 0, count: 0, top: null, other: 0 };
    (load("kfp_expenses_v1", []) || []).forEach(function (e) {
      if (!e || e.cur !== cur || String(e.date).slice(0, 7) !== ym) return;
      var a = num(e.amt); t.total += a; t.count++; t.other += cur === "KRW" ? num(e.thb) : num(e.krw);
      if (!t.top || a > num(t.top.amt)) t.top = e;
    });
    return t;
  }
  function expenseSummary(ym, cur) {
    var a = expenseTotal(ym, cur), b = expenseTotal(addMonth(ym, -1), cur);
    var diff = a.total - b.total;
    return { ym: ym, cur: cur, total: a.total, count: a.count, other: a.other, top: a.top, prevTotal: b.total, prevCount: b.count,
             diff: diff, pct: b.total > 0 ? Math.abs(diff) / b.total * 100 : null, perDay: a.total / daysIn(ym) };
  }

  /* ---------------- which pop-ups are due ---------------- */
  function due() {
    var t = now(), cur = ymOf(t), prev = addMonth(cur, -1), seen = load(SEEN_KEY, {}) || {}, out = [];
    var set = load("kfp_work_settings_v1", {}) || {}, nd = Math.round(num(set.notifyDay));
    if (nd >= 1 && nd <= 31 && seen.work !== cur && t.getDate() >= Math.min(nd, daysIn(cur))) {
      var w = workSummary(prev);
      if (w.days > 0) out.push({ kind: "work", data: w });
    }
    if (seen.exp !== cur) {
      var e = expenseSummary(prev, mode() === "THB" ? "THB" : "KRW");
      if (e.count > 0) out.push({ kind: "exp", data: e });
    }
    return out;
  }
  function markSeen(kind) { var s = load(SEEN_KEY, {}) || {}; s[kind] = ymOf(now()); save(SEEN_KEY, s); }

  /* ---------------- fireworks + confetti (canvas) ---------------- */
  var COLORS = ["#ffd66b", "#e8be46", "#fff2b8", "#3ddc97", "#5aa8ff", "#ff7aa8", "#ffffff"];
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

  function countUp(el, to, fmt) {
    if (!el) return;
    if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) { el.textContent = fmt(to); return; }
    var t0 = performance.now(), dur = 1100;
    (function step(ts) {
      var k = Math.min(1, (ts - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(to * e);
      if (k < 1) requestAnimationFrame(step);
    })(t0);
  }

  /* ---------------- pop-up ---------------- */
  function tile(label, value, i, wide) {
    return '<div class="kdg-tile' + (wide ? " wide" : "") + '" style="animation-delay:' + (0.35 + i * 0.06).toFixed(2) + 's"><span>' + label + "</span><b>" + value + "</b></div>";
  }
  function workHtml(w) {
    return '<div class="kdg-medal" aria-hidden="true">🏆</div><span class="kdg-eyebrow">MONTHLY · WORK</span>' +
      '<h2 id="kdgTitle">สรุปการทำงานเดือนที่แล้ว</h2><p class="kdg-month">' + esc(ymLabel(w.ym)) + " · วันที่ 1–" + daysIn(w.ym) + "</p>" +
      '<div class="kdg-hero"><small>รายได้รวมจากการทำงาน</small><b data-count="' + w.krw + '">' + money(w.krw, "KRW") + "</b>" +
      (w.thb > 0 ? "<em>≈ " + money(w.thb, "THB") + "</em>" : "") + "</div>" +
      '<div class="kdg-grid">' +
      tile("⏱ ชั่วโมงทำงานรวม", hrs(w.hours) + " ชม.", 0) + tile("📅 วันทำงาน", w.days + " วัน", 1) +
      tile("⏰ OT รวม", hrs(w.ot) + " ชม.", 2) + tile("🌙 รายได้ OT", money(w.otKrw, "KRW"), 3) +
      tile("🗓 ทำงานเสาร์-อาทิตย์", w.weekend + " วัน", 4) + tile("🎌 ทำงานวันหยุด", w.holiday + " วัน", 5) +
      (w.received ? tile("🏦 ยอดเข้าบัญชีจริง", money(w.received, "KRW"), 6, true) : "") + "</div>" +
      '<p class="kdg-foot">คำนวณจากบันทึกการเข้างานของเดือน' + esc(ymLabel(w.ym)) + " · ตั้งวันแจ้งเตือนได้ที่ ⚙️ ตั้งค่า</p>";
  }
  function expHtml(e) {
    var cur = e.cur, cmp;
    if (!e.prevCount) cmp = '<span class="kdg-cmp flat">📊 ยังไม่มีข้อมูลเดือนก่อนให้เทียบ</span>';
    else if (Math.abs(e.diff) < 0.005) cmp = '<span class="kdg-cmp flat">➖ ใช้จ่ายเท่ากับเดือนก่อน</span>';
    else if (e.diff < 0) cmp = '<span class="kdg-cmp good">🎉 ประหยัดขึ้น ' + e.pct.toFixed(1) + "% · น้อยลง " + money(-e.diff, cur) + "</span>";
    else cmp = '<span class="kdg-cmp bad">📈 ใช้มากขึ้น ' + e.pct.toFixed(1) + "% · เพิ่มขึ้น " + money(e.diff, cur) + "</span>";
    var other = cur === "KRW" && e.other > 0 ? "<em>≈ " + money(e.other, "THB") + "</em>" : "";
    return '<div class="kdg-medal" aria-hidden="true">🧾</div><span class="kdg-eyebrow">MONTHLY · EXPENSES</span>' +
      '<h2 id="kdgTitle">สรุปรายจ่ายเดือนที่แล้ว</h2><p class="kdg-month">' + esc(ymLabel(e.ym)) + "</p>" +
      '<div class="kdg-hero"><small>รายจ่ายรวม</small><b data-count="' + e.total + '" data-cur="' + cur + '">' + money(e.total, cur) + "</b>" + other + "</div>" +
      cmp + '<div class="kdg-grid">' +
      tile("🧮 จำนวนรายการ", e.count + " รายการ", 0) + tile("📆 เดือนก่อน (" + esc(ymLabel(addMonth(e.ym, -1)).split(" ")[0]) + ")", e.prevCount ? money(e.prevTotal, cur) : "—", 1) +
      tile("📉 เฉลี่ยต่อวัน", money(e.perDay, cur), 2) + tile("🔢 เดือนก่อน", e.prevCount + " รายการ", 3) +
      (e.top ? tile("💸 จ่ายมากที่สุด", esc(e.top.name) + " · " + money(e.top.amt, cur), 4, true) : "") + "</div>" +
      '<p class="kdg-foot">นับเฉพาะรายจ่ายที่บันทึกเป็น' + (cur === "KRW" ? "เงินวอน" : "เงินบาท") + " · สรุปเด้งทุกวันที่ 1 ของเดือน</p>";
  }

  var queue = [], open = null;
  function show(item) {
    var ov = d.createElement("div");
    ov.className = "kdg-ov"; ov.id = "kfpDigest"; ov.setAttribute("data-kind", item.kind);
    ov.innerHTML = '<canvas class="kdg-fx" aria-hidden="true"></canvas><div class="kdg-card" role="dialog" aria-modal="true" aria-labelledby="kdgTitle">' +
      (item.kind === "work" ? workHtml(item.data) : expHtml(item.data)) +
      '<div class="kdg-actions"><button type="button" class="kdg-go" data-kdg="go">' + (item.kind === "work" ? "ดูบันทึกการเข้างาน" : "ดูรายจ่าย") +
      '</button><button type="button" class="kdg-ok" data-kdg="ok">เยี่ยมเลย!</button></div></div>';
    d.body.appendChild(ov);
    markSeen(item.kind);                               // once per month, even if the page is closed right away
    var stop = fireworks(ov.querySelector(".kdg-fx"));
    var hero = ov.querySelector(".kdg-hero b[data-count]");
    if (hero) { var to = num(hero.getAttribute("data-count")), cur = hero.getAttribute("data-cur") || "KRW"; countUp(hero, to, function (v) { return money(item.kind === "work" ? Math.round(v) : (cur === "KRW" ? Math.round(v) : Math.round(v * 100) / 100), cur); }); }
    var last = d.activeElement;
    function close(go) {
      stop(); ov.remove(); d.removeEventListener("keydown", onKey, true); open = null;
      try { if (last && last.focus) last.focus({ preventScroll: true }); } catch (_) {}
      if (go && typeof window.kfpOpenTool === "function") window.kfpOpenTool(item.kind === "work" ? "work" : "expense");
      else setTimeout(next, 350);
    }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(false); }
      else if (e.key === "Tab") { var b = ov.querySelectorAll("button"); if (e.shiftKey && d.activeElement === b[0]) { e.preventDefault(); b[b.length - 1].focus(); } else if (!e.shiftKey && d.activeElement === b[b.length - 1]) { e.preventDefault(); b[0].focus(); } }
    }
    d.addEventListener("keydown", onKey, true);
    ov.addEventListener("click", function (e) { var b = e.target.closest("[data-kdg]"); if (b) close(b.getAttribute("data-kdg") === "go"); });
    open = ov;
    setTimeout(function () { var ok = ov.querySelector(".kdg-ok"); if (ok) ok.focus({ preventScroll: true }); }, 60);
  }
  function next() { if (!open && queue.length) show(queue.shift()); }

  var checked = false;
  function check() {
    if (checked) return;
    var P = window.kfpPlan && window.kfpPlan.info ? window.kfpPlan.info() : null;
    if (!P || P.state !== "ready" || !P.features || !P.features.monthly_digest) return;
    checked = true;
    queue = due();
    next();
  }
  // after the plan is known and the account's data (incl. Cloud) has had time to load
  window.addEventListener("kfp:plan", function () { setTimeout(check, 1800); });
  window.kfpDigest = { due: due, workSummary: workSummary, expenseSummary: expenseSummary, check: function () { checked = false; check(); }, show: show };
})();
