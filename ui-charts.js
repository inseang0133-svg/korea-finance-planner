/*
  ui-charts.js — ส่วนเสริมหน้าตากราฟ (presentation only)
  - ลงทะเบียน plugin ของ Chart.js เพื่อสร้าง "ยอดกลางโดนัท + legend" และ "chips สรุป" ให้กราฟ
  - อ่านข้อมูลจากกราฟ/ฟังก์ชันเดิม (kfpMonthlySeries) เท่านั้น ไม่แก้ค่าหรือ state ของแอป
*/
(function () {
  "use strict";
  if (window.__kfpCharts) return;
  window.__kfpCharts = true;

  var d = document;
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var COLORS = ["61,220,151", "255,196,64", "80,176,255", "170,120,255", "255,110,150"];
  var pie = { chart: null, pinned: -1, hover: -1, rate: 0, total: 0 };

  function $(id) { return d.getElementById(id); }
  function fmt(n) { return Math.round(n).toLocaleString("en-US"); }

  /* ---------- count-up (เฉพาะตัวเลขในองค์ประกอบที่ไฟล์นี้สร้างเอง) ---------- */
  function countTo(el, to, prefix, dur) {
    if (!el) return;
    if (el._raf) cancelAnimationFrame(el._raf);
    prefix = prefix || "";
    if (reduce) { el.textContent = prefix + fmt(to); el._v = to; return; }
    var from = el._v || 0, t0 = performance.now(); dur = dur || 900;
    (function step(t) {
      var k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = prefix + fmt(from + (to - from) * e);
      if (k < 1) el._raf = requestAnimationFrame(step); else el._v = to;
    })(t0);
  }

  /* ---------- donut: centre + legend ---------- */
  function setCenter(i) {
    var c = $("pieCenter"), ch = pie.chart;
    if (!c || !ch) return;
    var data = ch.data.datasets[0].data, names = ch.data.labels;
    var krw = i < 0 ? pie.total : data[i];
    var label = i < 0 ? "รวมต่อเดือน" : names[i] + " · " + Math.round(data[i] / pie.total * 100) + "%";
    c.style.setProperty("--c", i < 0 ? "232,190,70" : COLORS[i % COLORS.length]);
    c.querySelector(".pc-label").textContent = label;
    countTo(c.querySelector(".pc-num"), krw * pie.rate, "", 600);
    c.querySelector(".pc-sub").textContent = fmt(krw) + " KRW";
    c.classList.remove("swap"); void c.offsetWidth; c.classList.add("swap");
    var rows = d.querySelectorAll("#pieLegend .pie-row");
    rows.forEach(function (r, k) {
      r.classList.toggle("on", k === i);
      r.classList.toggle("dim", i >= 0 && k !== i);
    });
  }

  function highlight(i) {
    var ch = pie.chart; if (!ch) return;
    ch.setActiveElements(i < 0 ? [] : [{ datasetIndex: 0, index: i }]);
    try { ch.update("active"); } catch (_) {}
    setCenter(i);
  }

  function buildPie(chart) {
    var legend = $("pieLegend"), center = $("pieCenter");
    if (!legend || !center) return;
    pie.chart = chart; pie.pinned = -1;
    pie.rate = Number(($("rate") || {}).value) || 0;
    var data = chart.data.datasets[0].data, names = chart.data.labels;
    pie.total = data.reduce(function (a, b) { return a + b; }, 0);

    center.hidden = false;
    center.innerHTML = '<span class="pc-label"></span><b class="pc-value"><i>฿</i><span class="pc-num">0</span></b><span class="pc-sub"></span>';

    legend.innerHTML = data.map(function (v, i) {
      var pct = pie.total ? v / pie.total * 100 : 0;
      return '<div class="pie-row" role="listitem" tabindex="0" data-i="' + i + '" style="--c:' + COLORS[i % COLORS.length] +
        ';--w:' + pct.toFixed(1) + '%;--d:' + (i * 110) + 'ms">' +
        '<i class="pr-dot"></i>' +
        '<span class="pr-name">' + names[i] + '<em>' + Math.round(pct) + '%</em></span>' +
        '<span class="pr-val">฿' + fmt(v * pie.rate) + '</span>' +
        '<span class="pr-bar"><b></b></span></div>';
    }).join("");

    legend.querySelectorAll(".pie-row").forEach(function (row) {
      var i = Number(row.dataset.i);
      row.addEventListener("pointerenter", function (e) { if (e.pointerType === "mouse" && pie.pinned < 0) highlight(i); });
      row.addEventListener("pointerleave", function (e) { if (e.pointerType === "mouse" && pie.pinned < 0) highlight(-1); });
      var toggle = function () { pie.pinned = pie.pinned === i ? -1 : i; highlight(pie.pinned); };
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    });

    // แตะ/คลิกบนโดนัทเพื่อเลือกชิ้น
    chart.canvas.addEventListener("click", function (e) {
      var els = chart.getElementsAtEventForMode(e, "nearest", { intersect: true }, true);
      var i = els.length ? els[0].index : -1;
      pie.pinned = (i === pie.pinned) ? -1 : i;
      highlight(pie.pinned);
    });
    setCenter(-1);
  }

  function clearPie(chart) {
    if (pie.chart !== chart) return;
    pie.chart = null;
    var legend = $("pieLegend"), center = $("pieCenter");
    if (legend) legend.innerHTML = "";
    if (center) { center.hidden = true; center.innerHTML = ""; }
  }

  /* ---------- chips สรุปเหนือกราฟ ---------- */
  function chipsHost(canvasId) {
    var canvas = $(canvasId); if (!canvas) return null;
    var box = canvas.parentElement, host = box.previousElementSibling;
    if (!host || !host.classList.contains("chart-chips")) {
      host = d.createElement("div");
      host.className = "chart-chips";
      box.parentNode.insertBefore(host, box);
    }
    return host;
  }

  function renderChips(canvasId, chips) {
    var host = chipsHost(canvasId); if (!host) return;
    host.innerHTML = chips.map(function (c, i) {
      return '<div class="chip" style="--c:' + c.c + ';--d:' + (i * 90) + 'ms"><span>' + c.label + '</span>' +
        '<b data-to="' + Math.round(c.value) + '" data-prefix="' + (c.prefix || "") + '">' + (c.prefix || "") + '0</b>' +
        (c.sub ? '<small>' + c.sub + '</small>' : '') + '</div>';
    }).join("");
    host.querySelectorAll("b").forEach(function (b) { countTo(b, Number(b.dataset.to), b.dataset.prefix, 1000); });
  }

  function clearChips(canvasId) {
    var canvas = $(canvasId); if (!canvas) return;
    var host = canvas.parentElement.previousElementSibling;
    if (host && host.classList.contains("chart-chips")) host.remove();
  }

  function buildSalary() {
    if (typeof kfpMonthlySeries !== "function") return;
    var rows = kfpMonthlySeries(); if (!rows.length) return;
    var sum = rows.reduce(function (a, r) { return a + r.thb; }, 0);
    var best = rows.reduce(function (a, r) { return r.thb > a.thb ? r : a; }, rows[0]);
    renderChips("salaryChart", [
      { label: "เฉลี่ย / เดือน", value: sum / rows.length, prefix: "฿", c: "232,190,70" },
      { label: "สูงสุด", value: best.thb, prefix: "฿", c: "61,220,151", sub: best.label },
      { label: "รวมทั้งหมด", value: sum, prefix: "฿", c: "80,176,255", sub: rows.length + " เดือน" }
    ]);
  }

  function buildSaving() {
    if (typeof kfpMonthlySeries !== "function") return;
    var rows = kfpMonthlySeries(); if (!rows.length) return;
    var last = rows[rows.length - 1];
    var avg = rows.reduce(function (a, r) { return a + r.savingThb; }, 0) / rows.length;
    renderChips("savingChart", [
      { label: "สะสมล่าสุด", value: last.cumSavingThb, prefix: "฿", c: "61,220,151", sub: last.label },
      { label: "เก็บเฉลี่ย / เดือน", value: avg, prefix: "+฿", c: "232,190,70" },
      { label: "เดือนที่บันทึก", value: rows.length, prefix: "", c: "170,120,255", sub: "เดือน" }
    ]);
  }

  /* ---------- Chart.js plugin ---------- */
  var plugin = {
    id: "kfpFxExtras",
    afterInit: function (chart) {
      try {
        var id = chart.canvas && chart.canvas.id;
        if (id === "pieChart") buildPie(chart);
        else if (id === "salaryChart") buildSalary();
        else if (id === "savingChart") buildSaving();
      } catch (e) { console.warn("ui-charts:", e); }
    },
    afterDestroy: function (chart) {
      try {
        var id = chart.canvas && chart.canvas.id;
        if (id === "pieChart") clearPie(chart);
        else if (id === "salaryChart") clearChips("salaryChart");
        else if (id === "savingChart") clearChips("savingChart");
      } catch (_) {}
    }
  };

  function register() {
    if (typeof Chart === "undefined") return false;
    Chart.register(plugin);
    try {
      Chart.defaults.font.family = "Prompt, system-ui, sans-serif";
      Chart.defaults.color = "#b9b5a8";
    } catch (_) {}
    return true;
  }

  if (!register()) {
    // CDN ช้า/ใช้ตัวสำรอง: รอจน Chart พร้อม (สูงสุด ~20 วิ)
    var tries = 0, t = setInterval(function () {
      if (register() || ++tries > 80) clearInterval(t);
    }, 250);
  }
})();
