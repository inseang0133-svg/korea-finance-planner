/* PLANNER · Product Showcase — interactive demos. Every number here is DEMO DATA generated in this file:
 * nothing is read from or written to a member's data. */
(function () {
  "use strict";
  var DEMO_RATE = 0.024;                       // 1 KRW = 0.0240 THB (same default as the app's rate field)
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var AUD_KEY = "kfp_showcase_aud";
  var aud = "KR";
  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n, d) { return Number(n).toLocaleString("en-US", { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); };
  var krw = function (n) { return "₩" + fmt(Math.round(n)); };
  var thb = function (n, d) { return "฿" + fmt(n, d == null ? 0 : d); };
  var money = function (n) { return aud === "KR" ? krw(n) : thb(n); };

  /* ---------- session-aware CTAs ---------- */
  function isMember() { return !!(window.kfpStorage && window.kfpStorage.isMember && window.kfpStorage.isMember()); }
  function applySession() {
    var m = isMember();
    document.querySelectorAll("[data-guest]").forEach(function (e) { e.hidden = m; });
    document.querySelectorAll("[data-member]").forEach(function (e) { e.hidden = !m; });
    if (m) document.querySelectorAll("[data-demo]").forEach(function (e) { e.setAttribute("href", "index.html"); });
  }
  // came here to sign up / log in → after the auth reload land in the app
  try { if (isMember() && sessionStorage.getItem("kfp_sc_go") === "1") { sessionStorage.removeItem("kfp_sc_go"); location.replace("index.html"); return; } } catch (_) {}
  document.addEventListener("click", function (e) {
    var a = e.target.closest("[data-auth]");
    if (a) {
      e.preventDefault();
      try { sessionStorage.setItem("kfp_sc_go", "1"); } catch (_) {}
      if (window.kfpAuth && window.kfpAuth.open) window.kfpAuth.open(a.getAttribute("data-auth"));
      else location.href = "index.html?demo=1";
      return;
    }
    var d = e.target.closest("[data-demo]");
    if (d && !isMember()) { try { sessionStorage.setItem("kfp_demo", "1"); } catch (_) {} }
    var s = e.target.closest("[data-aud]");
    if (s) { setAud(s.getAttribute("data-aud"), true); if (s.closest(".sc-kr-teaser")) document.getElementById("work").scrollIntoView({ behavior: reduce ? "auto" : "smooth" }); }
  });
  window.addEventListener("kfp:auth-ready", applySession);

  /* ---------- audience (KR / TH) ---------- */
  function setAud(a, save) {
    aud = a === "TH" ? "TH" : "KR";
    if (save) try { sessionStorage.setItem(AUD_KEY, aud); } catch (_) {}
    document.documentElement.setAttribute("data-aud", aud);
    document.querySelectorAll("[data-aud][role=tab]").forEach(function (b) { b.setAttribute("aria-selected", String(b.getAttribute("data-aud") === aud)); });
    document.querySelectorAll("[data-show-kr]").forEach(function (e) { e.hidden = aud !== "KR"; });
    document.querySelectorAll("[data-show-th]").forEach(function (e) { e.hidden = aud !== "TH"; });
    document.querySelectorAll("[data-kr-section]").forEach(function (e) { e.hidden = aud !== "KR"; });
    document.querySelectorAll("[data-kr-text]").forEach(function (e) { e.textContent = e.getAttribute(aud === "KR" ? "data-kr-text" : "data-th-text"); });
    var hero = document.querySelector(".sc-count");
    if (hero) { hero.setAttribute("data-to", String(salary())); if (hero._done) hero.textContent = money(salary()); }
    renderSalary(); renderExpenses(); renderHistory(); renderGold(); renderOverview();
  }

  /* ---------- 01 salary planner ---------- */
  var SAL = [{ id: "save", name: "เงินออม", pct: 40, c: "var(--g1)", hex: "#e3b84a" }, { id: "spend", name: "ค่าใช้จ่าย", pct: 35, c: "var(--g2)", hex: "#ff8a5c" },
             { id: "reserve", name: "เงินสำรอง", pct: 15, c: "var(--g3)", hex: "#5aa9ff" }, { id: "goal", name: "เป้าหมายส่วนตัว", pct: 10, c: "var(--g4)", hex: "#a98bff" }];
  function salary() { return aud === "KR" ? 2500000 : 35000; }
  function buildSalaryRows() {
    $("salRows").innerHTML = SAL.map(function (s, i) {
      return '<div class="sc-sal-row" style="--c:' + s.c + '"><span class="dot"></span><label for="sal_' + s.id + '">' + s.name + ' <b id="salPct_' + s.id + '">' + s.pct + '%</b></label>' +
        '<span class="val" id="salVal_' + s.id + '"></span><input type="range" id="sal_' + s.id + '" min="0" max="100" step="1" value="' + s.pct + '" data-i="' + i + '" aria-label="' + s.name + ' เปอร์เซ็นต์"></div>';
    }).join("");
    $("salRows").addEventListener("input", function (e) {
      var i = e.target.getAttribute("data-i"); if (i == null) return;
      SAL[+i].pct = +e.target.value; renderSalary();
    });
  }
  function renderSalary() {
    var base = salary(), tot = 0;
    $("salAmt").textContent = money(base);
    if ($("salSub")) $("salSub").textContent = "≈ " + thb(base * DEMO_RATE) + " · เรตตัวอย่าง 1 ₩ = " + DEMO_RATE.toFixed(4) + " ฿";
    SAL.forEach(function (s) {
      tot += s.pct;
      var amt = base * s.pct / 100;
      $("salPct_" + s.id).textContent = s.pct + "%";
      $("salVal_" + s.id).innerHTML = money(amt) + (aud === "KR" ? "<small>≈ " + thb(amt * DEMO_RATE) + "</small>" : "");
    });
    // donut
    var r = 46, C = 2 * Math.PI * r, off = 0, g = "";
    g += '<circle cx="60" cy="60" r="' + r + '" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="14"/>';
    SAL.forEach(function (s) {
      var len = C * Math.min(s.pct, Math.max(0, 100 - off)) / 100;
      g += '<circle cx="60" cy="60" r="' + r + '" fill="none" stroke="' + s.hex + '" stroke-width="14" stroke-dasharray="' + len.toFixed(2) + " " + C.toFixed(2) + '" stroke-dashoffset="' + (-C * off / 100).toFixed(2) + '"/>';
      off += s.pct;
    });
    $("salDonut").innerHTML = g;
    $("salTotPct").textContent = tot + "%";
    var w = $("salWarn");
    if (tot === 100) { w.hidden = true; }
    else { w.hidden = false; w.textContent = tot < 100 ? "ยังเหลือเงินไม่ได้จัดสรร " + (100 - tot) + "% = " + money(base * (100 - tot) / 100) : "จัดสรรเกินเงินเดือนไป " + (tot - 100) + "% — ในแอปจะเตือนแบบนี้เช่นกัน"; }
  }

  /* ---------- 02 expenses ---------- */
  // [icon, category, note (KR), KRW, THB (TH audience), note (TH)]
  var EXP = [["🍜", "ค่าอาหาร", "ร้านอาหารใกล้โรงงาน", 9500, 230, "ข้าวกลางวัน"], ["🚌", "ค่าเดินทาง", "บัตร T-money", 25000, 600, "BTS / MRT"],
             ["🏠", "ค่าที่พัก", "ค่าห้องเดือนนี้", 300000, 7200, "ค่าห้องเดือนนี้"], ["🛒", "ค่าซื้อของ", "ซูเปอร์มาร์เก็ต", 48700, 1170, "ซูเปอร์มาร์เก็ต"],
             ["🎧", "ค่าใช้จ่ายส่วนตัว", "หูฟัง", 39000, 940, "หูฟัง"]];
  var expShown = false;
  function renderExpenses() {
    var ul = $("expList"), tk = 0, tt = 0;
    ul.innerHTML = EXP.map(function (e) {
      var k = e[3], t = aud === "KR" ? k * DEMO_RATE : e[4];
      tk += k; tt += t;
      return '<li><span class="ic" aria-hidden="true">' + e[0] + '</span><span class="nm">' + e[1] + "<small>" + (aud === "KR" ? e[2] : e[5]) + '</small></span><span class="am">' +
        (aud === "KR" ? krw(k) + "<small>≈ " + thb(t) + "</small>" : thb(t)) + "</span></li>";
    }).join("");
    var lis = ul.querySelectorAll("li");
    var total = aud === "KR" ? tk : tt;
    if (expShown) { lis.forEach(function (l) { l.classList.add("in"); }); $("expTotal").textContent = money(total); }
    else { $("expTotal").textContent = money(0); }
    if ($("expTotal2")) $("expTotal2").textContent = "≈ " + thb(tk * DEMO_RATE);
    ul._play = function () {
      expShown = true;
      lis.forEach(function (l, i) { setTimeout(function () { l.classList.add("in"); }, reduce ? 0 : 140 * i); });
      countTo($("expTotal"), total, money, reduce ? 0 : 1300);
    };
  }

  /* ---------- 03 work calendar ---------- */
  var WAGE = 10320, OT = 1.5, WKND = 1.5, HOL = 1.5, workShown = false, workExpected = 0;
  function buildWork() {
    // a 30-day month starting on a Monday (demo); day 15 is a public holiday worked
    var cells = [], reg = 0, ot = 0, inc = 0;
    for (var d = 1; d <= 30; d++) {
      var dow = (d - 1) % 7, cls = "", r = 0, o = 0, mul = 1;
      if (d === 15) { cls = "h"; r = 8; mul = HOL; }
      else if (dow === 5 && d % 2 === 0) { cls = "w"; r = 8; mul = WKND; }
      else if (dow >= 5) { cls = ""; }
      else { r = 8; o = (d % 3 === 0) ? 2 : 0; cls = o ? "o" : "n"; }
      if (cls === "h" || cls === "w") inc += r * WAGE * mul;
      else { inc += r * WAGE + o * WAGE * OT; }
      reg += r; ot += o;
      cells.push('<span class="' + cls + '">' + d + "</span>");
    }
    $("workCal").innerHTML = cells.join("");
    workExpected = Math.round(inc);
    $("workCal")._play = function () {
      workShown = true;
      $("workCal").querySelectorAll("span").forEach(function (s, i) { setTimeout(function () { s.classList.add("in"); }, reduce ? 0 : 22 * i); });
      countTo($("wReg"), reg, function (v) { return fmt(v); }, reduce ? 0 : 1200);
      countTo($("wOt"), ot, function (v) { return fmt(v); }, reduce ? 0 : 1200);
      countTo($("wExp"), workExpected, krw, reduce ? 0 : 1500, workDiff);
    };
    $("wActual").addEventListener("input", workDiff);
  }
  function workDiff() {
    var a = Number(String($("wActual").value).replace(/[^\d]/g, ""));
    var el = $("wDiff");
    if (!a) { el.textContent = "กรอกยอดที่ได้รับจริงเพื่อเทียบ"; el.className = "sc-diff"; return; }
    var df = a - workExpected;
    el.className = "sc-diff " + (df >= 0 ? "sc-pos" : "sc-neg");
    el.textContent = (df >= 0 ? "🟢 ได้มากกว่าที่คำนวณ " : "🔴 ได้น้อยกว่าที่คำนวณ ") + krw(Math.abs(df)) + " · ≈ " + thb(Math.abs(df) * DEMO_RATE);
  }

  /* ---------- 04 salary history ---------- */
  var HIST_KRW = [2310000, 2450000, 2380000, 2620000, 2540000, 2700000], HIST_THB = [29500, 30200, 30200, 31800, 31800, 33500];
  var MONTHS = ["มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย."], histCur = "KRW";
  function histData() {
    if (aud === "TH") return { v: HIST_THB, f: thb };
    return histCur === "KRW" ? { v: HIST_KRW, f: krw } : { v: HIST_KRW.map(function (x) { return x * DEMO_RATE; }), f: thb };
  }
  function renderHistory() {
    var d = histData(), v = d.v, W = 320, H = 170, pl = 8, pr = 8, pt = 24, pb = 26;
    var min = Math.min.apply(null, v) * 0.94, max = Math.max.apply(null, v) * 1.02;
    var X = function (i) { return pl + i * (W - pl - pr) / (v.length - 1); }, Y = function (x) { return pt + (1 - (x - min) / (max - min)) * (H - pt - pb); };
    var path = v.map(function (x, i) { return (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(x).toFixed(1); }).join(" ");
    var area = path + " L" + X(v.length - 1).toFixed(1) + " " + (H - pb) + " L" + X(0).toFixed(1) + " " + (H - pb) + " Z";
    var g = '<defs><linearGradient id="scLineFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#e3b84a" stop-opacity=".35"/><stop offset="1" stop-color="#e3b84a" stop-opacity="0"/></linearGradient></defs>';
    [0, 1, 2, 3].forEach(function (k) { var y = pt + k * (H - pt - pb) / 3; g += '<line class="grid" x1="0" x2="' + W + '" y1="' + y + '" y2="' + y + '"/>'; });
    g += '<path class="ar" d="' + area + '"/><path class="ln" id="histLn" d="' + path + '"/>';
    v.forEach(function (x, i) {
      g += '<circle class="pt" cx="' + X(i) + '" cy="' + Y(x) + '" r="4"/><text x="' + X(i) + '" y="' + (H - 8) + '" text-anchor="middle">' + MONTHS[i] + "</text>";
      if (i === v.length - 1 || i === 0) g += '<text class="vl" x="' + X(i) + '" y="' + (Y(x) - 10) + '" text-anchor="' + (i ? "end" : "start") + '">' + d.f(x) + "</text>";
    });
    var svg = $("histChart"); svg.innerHTML = g;
    var ln = $("histLn"), L = ln.getTotalLength ? ln.getTotalLength() : 600;
    ln.style.strokeDasharray = L; ln.style.strokeDashoffset = svg._drawn || reduce ? 0 : L;
    var avg = v.reduce(function (a, b) { return a + b; }, 0) / v.length;
    $("histAvg").textContent = d.f(avg);
    var chg = (v[v.length - 1] - v[v.length - 2]) / v[v.length - 2] * 100;
    $("histLast").textContent = d.f(v[v.length - 1]) + " (" + (chg >= 0 ? "+" : "") + chg.toFixed(1) + "%)";
    svg._play = function () { svg._drawn = true; requestAnimationFrame(function () { ln.style.strokeDashoffset = 0; }); };
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-hist]"); if (!b) return;
    histCur = b.getAttribute("data-hist");
    document.querySelectorAll("[data-hist]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
    renderHistory(); $("histChart")._play();
  });

  /* ---------- 05 contract countdown (live) ---------- */
  var cStart = new Date(Date.now() - 412 * 86400000), cEnd = new Date(cStart.getTime() + 1095 * 86400000);
  cEnd.setHours(17, 0, 0, 0);
  function thDate(d) { return d.toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" }); }
  function tickContract() {
    var left = Math.max(0, cEnd - Date.now()), s = Math.floor(left / 1000);
    var dd = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), mm = Math.floor(s % 3600 / 60), ss = s % 60;
    var set = function (k, v) { var e = document.querySelector('[data-cd="' + k + '"]'); if (e) e.textContent = v; };
    set("d", fmt(dd)); set("h", String(hh).padStart(2, "0")); set("m", String(mm).padStart(2, "0")); set("s", String(ss).padStart(2, "0"));
    var mini = document.querySelector("[data-cd-days-mini]"); if (mini) mini.textContent = fmt(dd);
    var p = Math.min(100, (Date.now() - cStart) / (cEnd - cStart) * 100);
    $("cdBar").style.setProperty("--p", p.toFixed(2) + "%");
    $("cdPct").textContent = "ผ่านไปแล้ว " + p.toFixed(1) + "% ของสัญญา 3 ปี";
  }
  $("cdRange").textContent = thDate(cStart) + " – " + thDate(cEnd);

  /* ---------- 06 debt flow ---------- */
  var debtTimer = [];
  function playDebt() {
    debtTimer.forEach(clearTimeout); debtTimer = [];
    var flow = document.querySelector(".sc-flow"), a = document.querySelector('[data-cc="a"]'), b = document.querySelector('[data-cc="b"]');
    flow.classList.remove("go"); a.textContent = "฿20,000"; b.textContent = "฿5,000"; $("instPaid").textContent = "0"; $("instBar").style.setProperty("--p", "0%");
    $("flowLabel").textContent = "บัตร A มียอดค้าง ฿20,000 …";
    var T = function (fn, ms) { debtTimer.push(setTimeout(fn, reduce ? 0 : ms)); };
    T(function () { void flow.offsetWidth; flow.classList.add("go"); $("flowLabel").textContent = "ใช้บัตร B จ่ายยอดบัตร A ฿20,000 · ผ่อน 0% 10 งวด"; }, 500);
    T(function () {
      countTo(a, 0, thb, reduce ? 0 : 900); countTo(b, 25000, thb, reduce ? 0 : 900, null, 5000);
      a.parentNode.classList.add("pulse"); b.parentNode.classList.add("pulse");
    }, 1500);
    T(function () { a.parentNode.classList.remove("pulse"); b.parentNode.classList.remove("pulse"); $("flowLabel").textContent = "ต้นทาง: บัตร A → ปลายทาง: บัตร B · หนี้ย้ายที่ ไม่ได้เพิ่ม"; }, 2600);
    var n = 0;
    (function step() { T(function () { n++; $("instPaid").textContent = String(n); $("instBar").style.setProperty("--p", n * 10 + "%"); if (n < 7) step(); }, n ? 380 : 2900); })();
  }
  $("debtPlay").addEventListener("click", playDebt);

  /* ---------- 07 gold ---------- */
  var LOTS = [{ n: "#001", bw: 1, cost: 58000, d: "ม.ค." }, { n: "#002", bw: 0.5, cost: 30600, d: "พ.ค." }, { n: "#003", bw: 0.25, cost: 15600, d: "ต.ค." }];
  function renderGold() {
    var px = +$("goldPx").value, tw = 0, tc = 0, tv = 0;
    $("goldPxTxt").textContent = thb(px);
    $("goldRows").innerHTML = LOTS.map(function (l) {
      var v = l.bw * px, pl = v - l.cost; tw += l.bw; tc += l.cost; tv += v;
      return "<tr><td>" + l.n + " <small class='sc-muted'>" + l.d + "</small></td><td>" + l.bw + "</td><td>" + thb(l.cost) + "</td><td>" + thb(v) + '</td><td class="pl ' + (pl >= 0 ? "sc-pos" : "sc-neg") + '">' + (pl >= 0 ? "+" : "−") + thb(Math.abs(pl)) + "</td></tr>";
    }).join("");
    var tp = tv - tc;
    $("gW").textContent = String(tw); $("gC").textContent = thb(tc); $("gV").textContent = thb(tv);
    $("gP").textContent = (tp >= 0 ? "+" : "−") + thb(Math.abs(tp)); $("gP").className = tp >= 0 ? "sc-pos" : "sc-neg";
    $("gAvg").textContent = thb(tc / tw);
    renderOverview(tv);
  }
  $("goldPx").addEventListener("input", renderGold);
  var goldAuto = null;
  function autoGold() {   // gentle "live market" wiggle while the section is on screen; stops as soon as the user drags
    if (reduce || goldAuto) return;
    var base = 61900, t = 0;
    goldAuto = setInterval(function () {
      t++; var v = Math.round((base + Math.sin(t / 2.2) * 900 + Math.sin(t / 0.9) * 250) / 50) * 50;
      $("goldPx").value = v; renderGold();
      document.querySelectorAll("#goldRows td.pl").forEach(function (td) { td.classList.remove("sc-flash"); void td.offsetWidth; td.classList.add("sc-flash"); });
    }, 1600);
  }
  ["pointerdown", "keydown"].forEach(function (ev) { $("goldPx").addEventListener(ev, function () { clearInterval(goldAuto); goldAuto = -1; }); });

  /* ---------- overview mockup ---------- */
  function renderOverview(goldValue) {
    var kr = aud === "KR";
    var gv = goldValue || (LOTS.reduce(function (a, l) { return a + l.bw; }, 0) * +$("goldPx").value);
    var set = function (k, v, sub) { var e = document.querySelector('[data-ov="' + k + '"]'); if (e) e.innerHTML = v + (sub ? '<small class="sc-ov-sub">' + sub + "</small>" : ""); };
    set("income", kr ? krw(2700000) : thb(33500), kr ? "≈ " + thb(64800) : "");
    set("saving", thb(kr ? 186400 : 152000));
    set("expense", kr ? krw(422200) : thb(10140), kr ? "≈ " + thb(10133) : "");
    set("install", thb(6268));
    set("gold", thb(gv));
    set("debt", thb(42300));
  }

  /* ---------- helpers: count-up + reveal ---------- */
  function countTo(el, to, f, ms, done, from) {
    var start = from != null ? from : 0, t0 = performance.now();
    if (!ms) { el.textContent = f(to); if (done) done(); return; }
    (function frame(t) {
      var k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      el.textContent = f(start + (to - start) * e);
      if (k < 1) requestAnimationFrame(frame); else if (done) done();
    })(t0);
  }
  function onView(el, fn, once) {
    if (!el) return;
    if (!("IntersectionObserver" in window)) { fn(); return; }
    var io = new IntersectionObserver(function (ents) {
      ents.forEach(function (en) { if (en.isIntersecting) { fn(en.target); if (once !== false) io.unobserve(en.target); } });
    }, { threshold: 0.25 });
    io.observe(el);
  }

  /* ---------- boot ---------- */
  function boot() {
    try {
      var saved = sessionStorage.getItem(AUD_KEY);
      aud = saved ? (saved === "TH" ? "TH" : "KR") : (isMember() && localStorage.getItem("kfp_mode_v1") === "THB" ? "TH" : "KR");
    } catch (_) {}
    buildSalaryRows(); buildWork();
    setAud(aud, false);
    applySession();
    document.querySelectorAll(".sc-reveal").forEach(function (el) { onView(el, function (t) { t.classList.add("sc-in"); }); });
    document.querySelectorAll(".sc-count").forEach(function (el) {
      onView(el, function () { countTo(el, +el.getAttribute("data-to"), money, reduce ? 0 : 1600, function () { el._done = true; }); });
    });
    onView($("expList"), function () { $("expList")._play(); });
    onView($("workCal"), function () { $("workCal")._play(); });
    onView($("histChart"), function () { $("histChart")._play(); });
    onView(document.querySelector(".sc-debt-demo"), playDebt);
    onView($("goldRows"), function () { if (goldAuto !== -1) autoGold(); });
    tickContract(); setInterval(tickContract, 1000);
    workDiff();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
