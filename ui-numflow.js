/*
  ui-numflow.js — อนิเมชันตัวเลขเปลี่ยนค่า (หน้าทอง) · presentation only
  - เมื่อค่าเปลี่ยน: ตัวเลขไล่ขึ้น/ลงไปยังค่าใหม่ (ข้อความสุดท้ายเท่ากับที่ gold.js เขียนไว้เป๊ะ)
  - เพิ่มขึ้น = เรืองแสงเขียว + ▲   ·   ลดลง = เรืองแสงแดง + ▼   (ค้างไว้ไม่กี่วินาทีแล้วค่อยจาง)
  - การ์ด "รายการซื้อแต่ละรอบ" ไม่กระพริบอีกต่อไป: จำค่าเดิมต่อรอบ แล้วไล่เฉพาะตัวเลขที่เปลี่ยน
*/
(function () {
  "use strict";
  if (window.__kfpNumFlow) return;
  window.__kfpNumFlow = true;

  var d = document;
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var DUR = 900, HOLD = 4800;
  var RE = /(-|−)?([฿$]?)(\d[\d,]*(?:\.\d+)?)/g;

  var IDS = [
    // ราคาตลาด + GOLD2go
    "spotUsd", "usdThb", "goldThbGram", "goldThbOz",
    "thaiBarBuy", "gold2goReceivePrice", "thaiBarSell", "gold2goSellPrice",
    "thaiJewelryBuy", "thaiJewelrySell",
    // ทองทั้งหมด -> รอบที่กำไร
    "totalGold", "totalGoldOz", "totalCost", "currentValue", "netPL", "netPLPct",
    "positivePL", "negativePL", "avgCost", "winRate", "winRatePct"
  ];

  /* ---------- parse / format ---------- */
  function parse(str) {
    var toks = [], m;
    RE.lastIndex = 0;
    while ((m = RE.exec(str))) {
      var raw = m[3], v = parseFloat(raw.replace(/,/g, ""));
      if (m[1]) v = -v;
      toks.push({
        v: v,
        dec: (raw.split(".")[1] || "").length,
        comma: raw.indexOf(",") > -1,
        start: m.index + (m[1] ? m[1].length : 0) + m[2].length,
        len: raw.length
      });
    }
    return toks;
  }
  function fmtNum(v, dec, comma) {
    var s = Math.abs(v).toFixed(dec);
    if (comma) { var p = s.split("."); p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ","); s = p.join("."); }
    return s;
  }
  // ประกอบข้อความจาก "เทมเพลตค่าปลายทาง" แล้วแทนตัวเลขด้วยค่าระหว่างทาง
  function build(target, toToks, fromToks, e) {
    var out = target, shown = [];
    for (var i = toToks.length - 1; i >= 0; i--) {
      var t = toToks[i], f = fromToks[i];
      var v = f.v + (t.v - f.v) * e;
      shown[i] = { v: v };
      out = out.slice(0, t.start) + fmtNum(v, t.dec, t.comma) + out.slice(t.start + t.len);
    }
    return { text: out, toks: shown };
  }
  function direction(prev, next) {
    for (var i = 0; i < next.length; i++) {
      var diff = next[i].v - prev[i].v;
      if (Math.abs(diff) > 1e-9) return diff > 0 ? 1 : -1;
    }
    return 0;
  }
  function allZero(toks) { return toks.every(function (t) { return t.v === 0; }); }

  /* ---------- visual flag ---------- */
  function flag(el, dir) {
    el.classList.remove("nf-up", "nf-down", "nf-lit");
    void el.offsetWidth;
    el.classList.add(dir > 0 ? "nf-up" : "nf-down", "nf-lit");
    clearTimeout(el.__nfT1); clearTimeout(el.__nfT2);
    el.__nfT1 = setTimeout(function () { el.classList.remove("nf-lit"); }, HOLD);
    el.__nfT2 = setTimeout(function () { el.classList.remove("nf-up", "nf-down"); }, HOLD + 1000);
  }

  var mo = null;
  function write(el, text) {
    el.textContent = text;
    if (mo) mo.takeRecords();            // ทิ้ง mutation ที่เกิดจากเราเอง
  }

  /* ---------- tween ---------- */
  function run(el, target, fromToks, toToks, st, startAt) {
    if (st.raf) cancelAnimationFrame(st.raf);
    if (reduce) { write(el, target); st.shown = null; return; }
    var t0 = startAt || performance.now();
    st.t0 = t0;
    (function step(t) {
      if (!el.isConnected) return;
      var k = Math.min(1, (t - t0) / DUR), e = 1 - Math.pow(1 - k, 3);
      if (k < 1) {
        var b = build(target, toToks, fromToks, e);
        st.shown = b.toks;
        write(el, b.text);
        st.raf = requestAnimationFrame(step);
      } else {
        st.raf = 0; st.shown = null;
        write(el, target);               // ค่าสุดท้ายตรงกับที่แอปเขียนไว้เสมอ
      }
    })(t0);
  }

  /* ---------- tracked static elements ---------- */
  function onChange(el) {
    var st = el.__nf;
    if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
    var now = el.textContent;
    if (now === st.target) { st.shown = null; return; }   // เขียนค่าเดิมซ้ำ (รีเฟรชราคา) -> ไม่ทำอะไร
    var toToks = parse(now), prev = st.toks;
    var from = st.shown || prev;
    st.target = now; st.toks = toToks;
    if (!prev || !toToks.length || prev.length !== toToks.length) { st.shown = null; return; }
    var dir = direction(prev, toToks);
    if (!dir) { st.shown = null; return; }
    if (!allZero(prev)) flag(el, dir);                    // จาก 0/ค่าเริ่มต้น -> แค่ไล่ตัวเลข ไม่ต้องมีลูกศร
    run(el, now, from, toToks, st);
  }

  if ("MutationObserver" in window) {
    mo = new MutationObserver(function (list) {
      var hosts = [];
      list.forEach(function (m) {
        var n = m.target.nodeType === 3 ? m.target.parentNode : m.target;
        while (n && !n.__nf) n = n.parentNode;
        if (n && hosts.indexOf(n) < 0) hosts.push(n);
      });
      hosts.forEach(onChange);
    });
    IDS.forEach(function (id) {
      var el = d.getElementById(id);
      if (!el || el.children.length) return;
      el.__nf = { target: el.textContent, toks: parse(el.textContent), raf: 0, shown: null };
      el.classList.add("nf-host");
      mo.observe(el, { childList: true, characterData: true, subtree: true });
    });
  }

  /* ---------- lot cards (re-render ด้วย innerHTML) ---------- */
  var lotMem = {};
  // gold.js สร้างการ์ดใหม่ (innerHTML) ซ้ำหลายครั้งติดกันตอนราคาเปลี่ยน
  // -> เก็บสถานะอนิเมชันต่อ "รอบ+ช่อง" แล้วเล่นต่อบน node ใหม่ ไม่ให้ถูกตัดกลางทาง
  function trackLot(key, el) {
    var now = el.textContent, toks = parse(now), prev = lotMem[key];
    el.classList.add("nf-host");
    if (!prev || !toks.length || prev.toks.length !== toks.length) {
      lotMem[key] = { target: now, toks: toks, st: { raf: 0, shown: null }, dir: 0, from: null, t0: 0 };
      return;
    }
    var m = prev, st = m.st;
    var running = m.dir && m.from && (performance.now() - m.t0) < DUR;

    if (prev.target === now) {
      if (running) {                                   // render ซ้ำระหว่างไล่ตัวเลข -> เล่นต่อ
        if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
        flag(el, m.dir);
        run(el, now, m.from, toks, st, m.t0);
      }
      return;
    }

    var from = (running && st.shown) ? st.shown : prev.toks;   // ค่าเปลี่ยนซ้ำกลางทาง: ไล่ต่อจากตัวเลขที่เห็นอยู่
    if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
    var dir = direction(prev.toks, toks);
    m.target = now; m.toks = toks; m.dir = dir; m.from = from;
    if (!dir) { m.dir = 0; return; }
    if (!allZero(prev.toks)) flag(el, dir);
    run(el, now, from, toks, st);
    m.t0 = st.t0;
  }

  function scanLots() {
    var box = d.getElementById("lotsList");
    if (!box) return;
    box.querySelectorAll(".lot-item").forEach(function (card) {
      var btn = card.querySelector(".delete-lot");
      var id = btn && btn.getAttribute("data-id");
      if (!id) return;
      var pl = card.querySelector(".lot-pl");
      if (pl && !pl.querySelector(".nf-val")) {
        var tn = Array.prototype.filter.call(pl.childNodes, function (n) {
          return n.nodeType === 3 && /\d/.test(n.nodeValue);
        })[0];
        if (tn) {
          var sp = d.createElement("span");
          sp.className = "nf-val";
          pl.insertBefore(sp, tn);
          sp.appendChild(tn);
          tn.nodeValue = tn.nodeValue.trim();
        }
      }
      var slots = [["pl", card.querySelector(".lot-pl .nf-val")], ["pct", card.querySelector(".lot-pl small")]];
      card.querySelectorAll(".lot-cell b").forEach(function (b, i) { slots.push(["c" + i, b]); });
      slots.forEach(function (s) { if (s[1]) trackLot(id + "|" + s[0], s[1]); });
    });
  }

  var lots = d.getElementById("lotsList");
  if (lots && "MutationObserver" in window) {
    new MutationObserver(scanLots).observe(lots, { childList: true });   // เฉพาะตอน re-render ทั้งรายการ
    scanLots();
  }
})();
