/*
  kfp-demo-data.js — ข้อมูลจำลองสำหรับ PREVIEW MODE (ผู้เข้าชมที่ยังไม่ Login)
  * ไม่ใช่ข้อมูลของสมาชิกคนใด · สร้างใหม่ทุกครั้งที่เปิดหน้า (อิงวันที่ปัจจุบันให้ดูสมจริง)
  * ถูกใส่ลง storage ในหน่วยความจำเท่านั้น (kfp-storage.js) — ไม่ลงเครื่อง ไม่ขึ้น Cloud
  * รูปแบบค่าตรงกับที่ script.js / tools-ui.js / gold.js ใช้จริง (ค่าทุกตัวเป็น string)
*/
(function () {
  "use strict";

  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  function today() {
    try { return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }); }
    catch (_) { var t = new Date(); return t.getFullYear() + "-" + pad(t.getMonth() + 1) + "-" + pad(t.getDate()); }
  }
  var T = today();
  var Y = +T.slice(0, 4), M = +T.slice(5, 7), D = +T.slice(8, 10);
  function ym(offset) { var t = Y * 12 + (M - 1) + offset; return Math.floor(t / 12) + "-" + pad((t % 12) + 1); }
  function dateIn(ymStr, day) { return ymStr + "-" + pad(day); }
  function dow(s) { var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]).getDay(); }
  var RATE = 0.0252;
  var id = 0; function uid() { return "demo-" + (++id); }

  /* ---------- เงินเดือนย้อนหลัง 10 เดือน (KRW, เรตล็อกต่อเดือน) ---------- */
  var salaries = [2380000, 2410000, 2455000, 2390000, 2520000, 2475000, 2560000, 2498000, 2610000, 2500000];
  var rates    = [0.0241, 0.0243, 0.0246, 0.0244, 0.0249, 0.0247, 0.0251, 0.0250, 0.0253, 0.0252];
  var salaryRecords = salaries.map(function (s, i) {
    return { month: ym(i - salaries.length), salary: s, rate: rates[i] };
  });

  /* ---------- บันทึกการเข้างานเดือนนี้ (สูตรเดียวกับ tools-ui.js) ---------- */
  var WAGE = 10320, OT = 1.5, WKND = 1.5;
  var cur = ym(0), workRecords = [];
  for (var d = 1; d <= Math.min(D, 28); d++) {
    var ds = dateIn(cur, d), w = dow(ds), rec;
    if (w === 0) continue;                                   // อาทิตย์หยุด
    if (w === 6) {                                           // เสาร์ทำ OT บางสัปดาห์
      if (d % 14 > 7) continue;
      rec = { type: "weekend", reg: 8, ot: 0, regMul: WKND, otMul: WKND };
    } else {
      rec = { type: "normal", reg: 8, ot: (d % 3 === 0 ? 2 : d % 5 === 0 ? 3 : 0), regMul: 1, otMul: OT };
    }
    rec.date = ds; rec.wage = WAGE;
    rec.regInc = Math.round(rec.reg * WAGE * rec.regMul);
    rec.otInc = Math.round(rec.ot * WAGE * rec.otMul);
    rec.krw = rec.regInc + rec.otInc; rec.rate = RATE; rec.thb = +(rec.krw * RATE).toFixed(2);
    workRecords.push(rec);
  }
  var prev = ym(-1);
  var deductions = [
    { id: uid(), ym: prev, name: "บำนาญแห่งชาติ (국민연금)", krw: 112500, rate: RATE, thb: +(112500 * RATE).toFixed(2) },
    { id: uid(), ym: prev, name: "ประกันสุขภาพ (건강보험)",  krw: 88600,  rate: RATE, thb: +(88600 * RATE).toFixed(2) },
    { id: uid(), ym: prev, name: "ภาษีเงินได้ + ภาษีท้องถิ่น", krw: 41200,  rate: RATE, thb: +(41200 * RATE).toFixed(2) },
    { id: uid(), ym: cur,  name: "บำนาญแห่งชาติ (국민연금)", krw: 112500, rate: RATE, thb: +(112500 * RATE).toFixed(2) }
  ];
  var received = {}; received[prev] = { krw: 2462000, rate: RATE, thb: +(2462000 * RATE).toFixed(2) };

  /* ---------- รายจ่าย (วอน + บาท) ---------- */
  function ex(cur_, name, amt, day, cat, monthOffset) {
    var date = dateIn(ym(monthOffset || 0), Math.max(1, Math.min(day, monthOffset ? 28 : D)));
    var krw = cur_ === "KRW" ? amt : Math.round(amt / RATE);
    var thb = cur_ === "KRW" ? +(amt * RATE).toFixed(2) : amt;
    return { id: uid(), ts: Date.parse(date) || 0, cur: cur_, name: name, cat: cat || "", date: date, rate: RATE, amt: amt, krw: krw, thb: thb };
  }
  var expenses = [
    ex("KRW", "ค่าห้องพัก (원룸)", 350000, 1, "personal"),
    ex("KRW", "บัตร T-money", 50000, 2, "personal"),
    ex("KRW", "ค่าโทรศัพท์", 33000, 3, "personal"),
    ex("KRW", "ซื้อของ Emart", 68400, 5, "personal"),
    ex("KRW", "ข้าวเย็นกับเพื่อน", 27000, 8, ""),
    ex("KRW", "ค่าส่งพัสดุกลับไทย", 45000, 10, "family"),
    ex("KRW", "กาแฟ", 4500, 11, ""),
    ex("KRW", "ค่าห้องพัก (원룸)", 350000, 1, "personal", -1),
    ex("KRW", "รองเท้าทำงาน", 59000, 14, "personal", -1),
    ex("THB", "ค่าประกันชีวิตแม่", 1850, 4, "family"),
    ex("THB", "ผ่อนมือถือที่ไทย", 1290, 6, "personal"),
    ex("THB", "ค่าไฟบ้านที่ไทย", 960, 9, "family")
  ];

  /* ---------- พอร์ตทอง (ทอง 96.5% หน่วยบาท) ---------- */
  var BAHT_GRAM = 15.244;
  function lot(monthOffset, day, qty, cost, note) {
    return { id: uid(), date: dateIn(ym(monthOffset), day), time: "10:30", goldType: "96.5", quantity: qty, unit: "baht",
             grams: qty * BAHT_GRAM, costThb: cost, buyPriceThbGram: null, buyFx: null, entryBahtPrice: null,
             note: note || "", createdAt: dateIn(ym(monthOffset), day) + "T01:30:00.000Z" };
  }
  var goldLots = [
    lot(-11, 5, 0.25, 12950, "ออมทองเดือนแรก"),
    lot(-8, 3, 0.25, 13480, ""),
    lot(-5, 7, 0.5, 28150, "โบนัส"),
    lot(-2, 4, 0.25, 15320, ""),
    lot(-1, 6, 0.25, 15890, "")
  ];

  window.KFP_DEMO = Object.freeze({
    version: 1,
    data: {
      "salary": "2500000",
      "salaryThb": "45000",
      "goal": "300000",
      "currentSaving": "0",
      "contractStartDate": dateIn(ym(-14), 1),
      "contractMonths": "36",
      "kfp_mode_v1": "KRW",
      "salaryRecords": JSON.stringify(salaryRecords),
      "kfp_work_settings_v1": JSON.stringify({ wage: WAGE, normal: 1, ot: OT, weekend: WKND, holiday: 1.5 }),
      "kfp_work_records_v1": JSON.stringify(workRecords),
      "kfp_work_deductions_v1": JSON.stringify(deductions),
      "kfp_work_received_v1": JSON.stringify(received),
      "kfp_expenses_v1": JSON.stringify(expenses),
      "kfp_gold_lots_v1": JSON.stringify(goldLots),
      "kfp_gold_settings_v1": "{}"
    }
  });
})();
