/* kfp-tours.js — content of "วิธีใช้งานเว็บไซต์" (loaded on demand by kfp-tour.js).
 * Every formula below is the one the page really uses (script.js, kfp-config.js, tools-ui.js, gold.js,
 * debt-engine.js). A tour only highlights and explains — it opens existing tabs/pop-ups, never saves. */
(function () {
  "use strict";
  var T = window.KfpTour; if (!T) return;
  var C = T.ctx, d = document, esc = C.esc, fmt = C.fmt;

  /* ---------------------------------------------------------------- helpers */
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function rate() { var r = num((d.getElementById("rate") || {}).value); return r > 0 ? r : 0.024; }
  function ym() { try { return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 7); } catch (_) { return new Date().toISOString().slice(0, 7); } }
  function tools() { return C.tools(); }
  function openTool(kind) {
    var t = tools(); if (!t || !t.open(kind)) return Promise.resolve();
    return C.wait(".tl-modal.open .tl-view", 1500).then(function () { return C.sleep(120); });
  }
  function workView(v, params) { return openTool("work").then(function () { var t = tools(); if (t) t.view(v, params); return C.sleep(60); }); }
  function workExample(v) { return openTool("work").then(function () { var t = tools(); if (t) t.example({ view: v, reg: 8, ot: 2 }); return C.sleep(60); }); }
  function closeTools() { var t = tools(); if (t) t.close(); }
  function closeSheet() { var s = d.querySelector(".pn-sheet.on"), sc = d.querySelector(".pn-scrim"); if (s && sc) sc.click(); }
  function canWork() { return C.mode() === "KRW" && C.can("work_records"); }
  function lockNote(plan) { return "🔒 ฟีเจอร์นี้อยู่ในแพ็กเกจ <b>" + plan + "</b> — ดูรายละเอียดได้ที่หน้า <b>แพ็กเกจ</b> (เมนูบัญชี หรือแถบด้านข้าง)"; }
  function settings() { var t = tools(); return t ? t.settings() : { wage: 10320, normal: 1, ot: 1.5, weekend: 1.5, holiday: 1.5 }; }
  function x(v) { return "×" + (Math.round(num(v) * 100) / 100); }
  function cats() { try { return typeof window.kfpLoadAlloc === "function" ? window.kfpLoadAlloc() : []; } catch (_) { return []; } }
  // the server's quota for this account (null = no limit / guest demo)
  function quota(key) { try { return window.kfpPlan && window.kfpPlan.limit(key); } catch (_) { return null; } }
  function first(sel) { var l = d.querySelectorAll(sel); for (var i = 0; i < l.length; i++) { var r = l[i].getBoundingClientRect(); if (r.width || r.height) return l[i]; } return null; }

  /* ================================================================ 1. ภาพรวมเว็บไซต์ */
  T.register({
    id: "overview", icon: "compass", page: "any",
    title: "ภาพรวมเว็บไซต์", desc: "เมนูหลัก ปุ่มบันทึกด่วน ป้ายแพ็กเกจ และจุดเปิดคู่มือ",
    outro: "ต่อไปลองดู <b>หน้าหลักและการแบ่งเงินเดือน</b> — หัวใจของการวางแผนเงินใน PLANNER",
    cleanup: closeSheet,
    steps: [
      { center: true, title: "PLANNER ทำอะไรได้บ้าง",
        text: "<p>PLANNER คือศูนย์ควบคุมการเงินส่วนตัว: กรอกเงินเดือน → ระบบแบ่งเงินให้ตามสัดส่วนที่คุณตั้ง → บันทึกเป็นประวัติ → ดูสถิติ เป้าหมายเงินเก็บ พอร์ตทอง และหนี้บัตรในที่เดียว</p>" +
          "<p>ทัวร์นี้จะ<b>ไฮไลต์ตำแหน่งจริง</b>บนหน้าจอทีละจุด ออกได้ทุกเมื่อด้วยปุ่ม ✕ และไม่แก้ไขข้อมูลของคุณ</p>",
        flow: ["เงินเดือน", "แบ่งเงิน", "บันทึกประวัติ", "สถิติ & เป้าหมาย"] },
      { target: '[data-tour="nav-side"], [data-tour="nav-bar"]', placement: "right", title: "เมนูหลัก 4 หน้า",
        text: function () {
          return "<ul><li><b>หน้าหลัก</b> — เงินเดือน การแบ่งเงิน ประวัติ สถิติ และเครื่องมือแปลงเงิน</li><li><b>ทองคำ</b> — ราคาทองและพอร์ตการซื้อแต่ละรอบ</li>" +
            "<li><b>บัตร·หนี้</b> — บัตรเครดิต หนี้ผ่อน และแผนปลดหนี้</li><li><b>บัญชี</b> — แพ็กเกจ การชำระเงิน และแชทติดต่อแอดมิน</li></ul>" +
            (C.desktop() ? "" : "<p>เคล็ดลับ: กดค้างที่แถบแล้วเลื่อนนิ้วไปทางซ้าย/ขวาเพื่อเลือกหน้าได้</p>");
        },
        note: "ไอคอนแม่กุญแจเล็กๆ บนเมนู = หน้านั้นต้องใช้แพ็กเกจ Finance Premium (แพ็กเกจของคุณยังไม่รวม)" },
      { target: '[data-tour="nav-add"]', placement: "right", title: "ปุ่ม + บันทึกด่วน",
        text: "<p>เปิดได้จากทุกหน้า สำหรับงานที่ทำบ่อย: <b>บันทึกรายจ่าย</b> · <b>บันทึกการเข้างาน</b> · <b>รอบซื้อทอง</b> · <b>ชำระบัตร/หนี้</b> · <b>ติดต่อแอดมิน</b> · <b>วิธีใช้งานเว็บไซต์</b></p>",
        note: "ป้าย PLUS / PREMIUM ในเมนูนี้บอกว่ารายการนั้นใช้ได้ตั้งแต่แพ็กเกจไหน" },
      { target: "#kfpBadge", optional: true, title: "ป้ายแพ็กเกจของคุณ",
        text: "<p>บอกสิทธิ์ปัจจุบัน: <b>FREE</b> · <b>PLUS</b> · <b>PREMIUM</b> (ทีมงานจะเห็น OWNER / ADMIN / VIEWER)</p><p>สิทธิ์ทั้งหมดตรวจจากเซิร์ฟเวอร์ทุกครั้ง ระบบแนะนำนี้ไม่เปลี่ยนสิทธิ์ใดๆ</p>" },
      { target: "#kfpAuthButton", optional: true, title: "เข้าสู่ระบบ / โปรไฟล์",
        text: function () {
          return C.preview()
            ? "<p>ตอนนี้คุณกำลังดู<b>ข้อมูลตัวอย่าง (Demo)</b> — ลองกดดูได้ทุกอย่าง แต่การบันทึกต้อง<b>เข้าสู่ระบบ</b>ก่อน ข้อมูลจริงจะแยกเก็บตามบัญชีของคุณ</p>"
            : "<p>เปิดเมนูโปรไฟล์: ชื่อ อีเมล สถานะ Cloud Sync (Finance Plus ขึ้นไป ซิงก์ให้อัตโนมัติเมื่อข้อมูลเปลี่ยน) และออกจากระบบ</p>";
        } },
      { target: function () { return first('[data-tour="help-entry"]') || first('[data-tour="nav-help"]') || first('[data-tour="nav-add"]'); },
        title: "เปิดคู่มือนี้ได้ทุกเมื่อ",
        text: "<p>ปุ่ม <b>วิธีใช้งานเว็บไซต์</b> อยู่ใต้โลโก้บนหน้าหลัก ในแถบด้านข้างบนคอมพิวเตอร์ และในเมนู <b>+ บันทึกด่วน</b> — เลือกดูทีละหัวข้อหรือเริ่มใหม่ทั้งหมดก็ได้</p>" },
      { center: true, title: "ข้อมูลของคุณเก็บที่ไหน",
        text: "<p>สมาชิกแต่ละบัญชีมีพื้นที่ข้อมูลแยกกันบนเครื่องนี้ · <b>Cloud Sync</b> (Finance Plus ขึ้นไป) ซิงก์อัตโนมัติ ใช้ข้ามเครื่องได้ · บัตร·หนี้ เก็บในบัญชีบนเซิร์ฟเวอร์</p>" +
          "<p>แพ็กเกจหมดอายุแล้ว<b>ข้อมูลไม่หาย</b> — ยังดูได้ แต่เพิ่ม/แก้ในฟีเจอร์ที่จำกัดไม่ได้จนกว่าจะต่ออายุ</p>" }
    ]
  });

  /* ================================================================ 2. หน้าหลัก & การแบ่งเงินเดือน */
  T.register({
    id: "home", icon: "salary", page: "home",
    title: "หน้าหลักและการแบ่งเงินเดือน", desc: "กรอกเงินเดือน เรตเงิน คำนวณ แบ่งเงินเป็นการ์ด และบันทึกประวัติ",
    outro: "ลองต่อด้วย <b>บันทึกการเข้างาน</b> (คำนวณค่าแรงและ OT) หรือ <b>สถิติและเป้าหมาย</b>",
    steps: [
      { section: "เงินเดือน", target: '[data-tour="mode"]', interactive: true, optional: true, title: "เลือกสกุลเงินของเงินเดือน",
        text: "<p><b>₩ วอน</b> — สำหรับคนทำงานเกาหลี กรอกเงินเดือนเป็นวอน ระบบแปลงเป็นบาทให้</p><p><b>฿ บาท</b> — กรอกเป็นบาทตรงๆ (เครื่องมือเฉพาะวอน เช่น บันทึกการเข้างาน ตัวแปลงเงิน ส่งเงินกลับบ้าน สัญญาจ้าง จะซ่อนในโหมดนี้)</p>",
        note: "ลองแตะสลับดูได้ — เป็นการตั้งค่าการแสดงผล ไม่ลบข้อมูล" },
      { section: "เงินเดือน", when: function () { return C.mode() !== "THB"; }, union: ['[data-tour="salary-label"]', "#salary", "#salaryTHBPreview"],
        title: "เงินเดือนสุทธิ (KRW)",
        facts: [["กรอก", "เงินเดือน<b>สุทธิ</b>ที่เข้าบัญชีจริงต่อเดือน (หลังหักแล้ว)"], ["รูปแบบ", "ตัวเลขล้วน ไม่ต้องใส่จุลภาค เช่น 2567890"],
                ["ใช้ทำอะไร", "ฐานของการแบ่งเงินทุกการ์ด และยอดที่บันทึกเป็นประวัติเดือนนี้"], ["ผลลัพธ์", "ตัวเลข ≈ THB ใต้ช่องเปลี่ยนทันทีที่พิมพ์"],
                ["แก้ไข", "พิมพ์ใหม่ได้ตลอด ระบบจำค่าล่าสุดไว้ให้"]],
        formula: [["≈ บาท", "เงินเดือน (KRW) × เรต"]],
        example: function () {
          var s = num((d.getElementById("salary") || {}).value);
          return s > 0 ? "ตอนนี้: " + fmt(s) + " ₩ × " + rate().toFixed(4) + " ≈ <b>" + fmt(Math.round(s * rate())) + " ฿</b>" : "";
        } },
      { section: "เงินเดือน", when: function () { return C.mode() === "THB"; }, union: ['[data-tour="salary-thb-label"]', "#salaryThb"],
        title: "เงินเดือนสุทธิ (THB)",
        facts: [["กรอก", "เงินเดือนสุทธิที่เข้าบัญชีจริงต่อเดือน เป็นบาท"], ["รูปแบบ", "ตัวเลขล้วน เช่น 45000"],
                ["ใช้ทำอะไร", "ฐานของการแบ่งเงินทุกการ์ด"], ["แก้ไข", "พิมพ์ใหม่ได้ตลอด"]] },
      { section: "เงินเดือน", when: function () { return C.mode() !== "THB"; }, union: ['[data-tour="rate-label"]', "#rate", '[data-tour="rate-update"]'],
        title: "อัตราแลกเปลี่ยน (1 KRW = ? THB)",
        facts: [["กรอก", "เงิน 1 วอน = กี่บาท เช่น 0.0240"], ["อัปเดต", "กด <b>อัปเดตค่าเงินล่าสุด</b> เพื่อดึงเรตตลาด (ขณะเปิดหน้า ระบบดึงให้เองเมื่อเรตเก่ากว่า 5 นาที)"],
                ["ใช้ที่ไหน", "ตัวเลข ≈ บาท · การ์ดแบ่งเงิน · ประวัติเงินเดือน · บันทึกการเข้างาน"], ["สำคัญ", "ตอนกดบันทึกเงินเดือนของเดือนไหน ระบบ<b>ล็อกเรตของเดือนนั้น</b>ไว้ เปลี่ยนเรตทีหลังยอดเก่าไม่เปลี่ยน"]] },
      { section: "เงินเดือน", target: '[data-tour="calc"]', title: "คำนวณ และ บันทึกเงินเดือนเดือนนี้",
        text: "<p><b>คำนวณ</b> — แบ่งเงินเดือนเป็นการ์ดด้านล่างและวาดกราฟวงกลม (จำตัวเลขที่กรอกไว้ให้)</p>" +
          "<p><b>บันทึกเงินเดือนเดือนนี้</b> — เก็บยอดในช่องเป็นรายการของเดือนปัจจุบันในประวัติ พร้อมเรต ณ ตอนนั้น</p>",
        flow: ["เงินเดือน", "คำนวณ", "การ์ดแบ่งเงิน + กราฟ"],
        note: "เดือนเดียวกันบันทึกซ้ำไม่ได้ — ถ้าต้องการแก้ ให้ลบรายการของเดือนนั้นในประวัติก่อน แล้วบันทึกใหม่" },
      { section: "การแบ่งเงิน", union: ['[data-tour="results-head"]', '[data-tour="results"]'], title: "การ์ดแบ่งเงินเดือน",
        text: "<p>หลังกดคำนวณ แต่ละการ์ดแสดงยอดของหมวดนั้น (ค่าเริ่มต้น: เงินเก็บ 45% · ออมทอง 15% · ส่งบ้าน 25% · ใช้ส่วนตัว 10% · เที่ยว 5%)</p>",
        formula: [["ยอดการ์ด", "เงินเดือน × % ของการ์ด"], ["≈ บาท (โหมดวอน)", "ยอดการ์ด (KRW) × เรต"]],
        example: function () {
          var c = cats()[0], s = num((d.getElementById(C.mode() === "THB" ? "salaryThb" : "salary") || {}).value);
          if (!c || !(s > 0)) return "";
          var v = Math.round(s * c.pct) / 100;
          return "ตัวอย่างจากข้อมูลตอนนี้: " + esc(c.name) + " = " + fmt(s) + " × " + c.pct + "% = <b>" + fmt(v) + (C.mode() === "THB" ? " ฿" : " ₩") + "</b>";
        } },
      { section: "การแบ่งเงิน", target: '[data-tour="alloc-manage"]', title: "จัดการการ์ด",
        text: "<p>เปลี่ยนชื่อ ไอคอน และ % ของแต่ละการ์ด เพิ่มได้สูงสุด 12 การ์ด · <b>รวมทุกการ์ดต้องได้ 100%</b> จึงบันทึกได้</p>" +
          "<p>ตั้ง<b>บทบาท</b>ให้การ์ดได้: <b>เงินเก็บ</b> (ใช้เป็นเงินสะสมของเป้าหมายเงินเก็บ) และ <b>ออมทอง</b> (แสดงมูลค่าพอร์ตทองในสถิติ)</p>",
        note: "เปลี่ยน % แล้ว การ์ด สถิติ และเป้าหมาย คำนวณใหม่ตาม % ใหม่ทันที" },
      { section: "การแบ่งเงิน", target: '[data-tour="pie"]', optional: true, title: "กราฟสัดส่วนการเงิน",
        text: "<p>แสดงสัดส่วนของทุกการ์ดจากการคำนวณล่าสุด แตะชิ้นกราฟหรือรายการด้านล่างเพื่อดูยอด</p>" },
      { section: "ประวัติเงินเดือน", target: '[data-tour="salary-records"]', title: "บันทึกเงินเดือนรายเดือน",
        facts: [["กรอก", "<b>เดือน</b> และ <b>รายได้สุทธิ</b> ของเดือนนั้น (วอนหรือบาทตามโหมด)"], ["ใช้ทำอะไร", "เป็นข้อมูลของสถิติ กราฟรายได้ เงินเก็บสะสม และเป้าหมาย"],
                ["เรต", "โหมดวอนล็อกเรตปัจจุบันไว้กับเดือนนั้น"], ["แก้ไข", "ลบรายการแล้วเพิ่มใหม่ (1 เดือนมีได้ 1 รายการ)"]],
        flow: ["บันทึกเดือน", "ประวัติ", "สถิติการเงิน", "เป้าหมายเงินเก็บ"],
        note: function () { var n = quota("salary_records_max"); return n ? "แพ็กเกจของคุณเก็บได้สูงสุด " + n + " เดือน · Finance Plus ไม่จำกัด" : ""; } },
      { section: "ประวัติเงินเดือน", target: '[data-tour="salary-history"]', title: "ประวัติการบันทึก",
        text: "<p>รายการเงินเดือนแต่ละเดือนพร้อมยอดบาท เลือกปีได้จากตัวกรองด้านบน (ค่าเริ่มต้น 3 เดือนล่าสุด) และลบรายการที่ผิดได้</p>",
        missing: "ยังไม่มีประวัติ — บันทึกเดือนแรกแล้วรายการจะขึ้นตรงนี้" },
      { section: "เครื่องมือ", target: '[data-tour="tools"]', title: "บันทึกการเข้างาน และ รายจ่าย",
        text: "<p><b>บันทึกการเข้างาน</b> — คำนวณค่าแรงรายวัน OT วันหยุด และสรุปรายได้ประจำเดือน (โหมดวอน · Finance Plus)</p><p><b>รายจ่าย</b> — จดค่าใช้จ่าย และผูกกับการ์ดเพื่อหักออกจากยอดสะสม</p>",
        note: "แต่ละเครื่องมือมีหัวข้อแนะนำแยก ในเมนู วิธีใช้งานเว็บไซต์" },
      { section: "เครื่องมือ", target: '[data-tour="debt-entry"]', title: "ทางเข้า Smart Credit & Debt",
        text: "<p>ไปหน้า <b>บัตร·หนี้</b> สำหรับบัตรเครดิต หนี้ผ่อน และแผนปลดหนี้ (Finance Premium)</p>" }
    ]
  });

  /* ================================================================ 3. สถิติ เป้าหมาย และเครื่องมือแปลงเงิน */
  T.register({
    id: "money-tools", icon: "chart", page: "home",
    title: "สถิติ เป้าหมาย และเครื่องมือเงิน", desc: "สถิติสะสม เป้าหมายเงินเก็บ สัญญาจ้าง ตัวแปลงเงิน และเงินส่งกลับบ้าน",
    steps: [
      { section: "สถิติ", when: function () { return C.can("advanced_statistics"); },
        target: function () { var c = first('[data-tour="stats"]'); return c ? [c.querySelector("h2"), c.querySelector("#statsGrid .stat-box")] : null; }, title: "สถิติการเงิน",
        text: "<p>รวมทุกเดือนใน<b>ประวัติเงินเดือน</b> แล้วแบ่งตาม % ของแต่ละการ์ด พร้อมกราฟรายได้รายเดือนและกราฟเงินเก็บสะสม และปุ่ม Export Excel</p>",
        formula: [["รายได้ทั้งหมด (บาท)", "ผลรวมรายได้ทุกเดือน × เรตที่ล็อกไว้ของเดือนนั้น"], ["ยอดสะสมของการ์ด", "รายได้ทั้งหมด × % ของการ์ด − รายจ่ายที่ผูกกับการ์ดนั้น"]],
        flow: ["ประวัติเงินเดือน", "สถิติการเงิน", "เป้าหมายเงินเก็บ"] },
      { section: "สถิติ", when: function () { return !C.can("advanced_statistics"); }, target: '[data-tour="stats-locked"]', title: "สถิติการเงิน (Finance Plus)",
        text: "<p>รวมรายได้ทุกเดือนแล้วแบ่งตาม % ของการ์ด ดูกราฟรายได้รายเดือนและเงินเก็บสะสม และ Export Excel</p>",
        formula: [["ยอดสะสมของการ์ด", "รายได้ทั้งหมด × % ของการ์ด − รายจ่ายที่ผูกกับการ์ด"]], note: lockNote("Finance Plus") },
      { section: "เป้าหมาย", when: function () { return C.can("planning"); }, target: '[data-tour="goal"]', title: "เป้าหมายเงินเก็บ",
        facts: [["กรอก", "<b>เป้าหมาย</b> เป็นบาท เช่น 2000000"], ["เงินสะสม", "ระบบเติมให้เอง = ยอดสะสมของการ์ดบทบาท <b>เงินเก็บ</b> ในสถิติ (แก้เองไม่ได้)"],
                ["ผลลัพธ์", "แถบความคืบหน้า % · สะสมแล้ว · เหลืออีกกี่บาท"]],
        formula: [["ความคืบหน้า", "เงินสะสม ÷ เป้าหมาย × 100 (สูงสุด 100%)"], ["เหลืออีก", "เป้าหมาย − เงินสะสม"]] },
      { section: "สัญญาจ้าง", when: function () { return C.can("planning") && C.mode() !== "THB"; }, target: '[data-tour="contract"]', title: "สัญญาทำงานเกาหลี",
        facts: [["กรอก", "<b>วันที่เริ่มงาน</b> แล้วกดบันทึก"], ["เลือก", "ระยะสัญญา 1 ปี 10 เดือน · 3 ปี · 4 ปี 10 เดือน"],
                ["ผลลัพธ์", "วันครบสัญญา และเวลาที่เหลือ (ปี เดือน วัน)"], ["แก้ไข", "เลือกระยะใหม่หรือลบข้อมูลสัญญาได้"]],
        formula: [["วันครบสัญญา", "วันเริ่มงาน + จำนวนเดือนของสัญญา"]] },
      { section: "แปลงเงิน", when: function () { return C.mode() !== "THB"; }, target: '[data-tour="converter"]', interactive: true, title: "ตัวแปลงสกุลเงิน",
        text: "<p>เลือกทิศทาง กรอกจำนวน ผลขึ้นทันที — ใช้เรตเดียวกับช่องอัตราแลกเปลี่ยนด้านบน ลองพิมพ์ดูได้ ไม่มีการบันทึก</p>",
        formula: [["KRW → THB", "จำนวน × เรต"], ["THB → KRW", "จำนวน ÷ เรต"]] },
      { section: "ส่งเงิน", when: function () { return C.mode() !== "THB"; }, target: '[data-tour="remit"]', interactive: true, title: "คำนวณเงินส่งกลับบ้าน",
        facts: [["กรอก", "จำนวนบาทที่อยากให้ปลายทางได้รับ · ค่าโอนของธนาคาร (วอน) · เรตส่งเงินจริง (1 THB = ? KRW)"],
                ["ผลลัพธ์", "ค่าธรรมเนียมรวม และยอดวอนที่ต้องโอน"]],
        formula: [["ค่ารับเงินปลายทาง", "60 บาท × เรตส่งเงิน"], ["ต้องโอน", "บาทที่ต้องการ × เรตส่งเงิน + ค่าโอน + ค่ารับปลายทาง"]],
        note: "ลองพิมพ์จำนวนบาทดูได้ — คำนวณอย่างเดียว ไม่บันทึกข้อมูล" }
    ]
  });

  /* ================================================================ 4. บันทึกการเข้างาน */
  var WORK_FX = function () {
    var s = settings();
    return [["รายได้ปกติ", "ชั่วโมงปกติ × ค่าแรง/ชม. × ตัวคูณปกติ (" + x(s.normal) + ")"], ["รายได้ OT", "ชั่วโมง OT × ค่าแรง/ชม. × ตัวคูณ OT (" + x(s.ot) + ")"], ["เงินเพิ่มกลางคืน", "ชั่วโมง 22:00–06:00 × ค่าแรง/ชม. × " + num(s.night)], ["รวมต่อวัน", "รายได้ปกติ + รายได้ OT + เงินเพิ่มกลางคืน (ปัดเป็นวอนเต็ม)"]];
  };
  T.register({
    id: "work", icon: "attendance", page: "home", feature: "work_records", featurePlan: "Finance Plus",
    title: "บันทึกการเข้างาน", desc: "ประเภทวัน ชั่วโมงปกติ OT ค่าแรง สูตรรายได้ และประวัติการทำงาน",
    unavailable: function () { return C.mode() === "THB" ? "ใช้ในโหมดวอน" : ""; },
    outro: "ต่อไปดู <b>สรุปรายได้ประจำเดือน</b> — รวมทุกวันที่บันทึก หักภาษี และเทียบกับเงินเข้าจริง",
    cleanup: closeTools,
    steps: [
      { when: function () { return C.mode() === "THB"; }, target: '[data-tour="mode"]', interactive: true,
        advanceWhen: function () { return C.mode() === "KRW"; },
        title: "สลับเป็นโหมดวอนก่อน", text: "<p>บันทึกการเข้างานใช้สำหรับงานในเกาหลี จึงแสดงเฉพาะ<b>โหมด ₩ วอน</b> — แตะ <b>₩ วอน</b> แล้วทัวร์จะไปต่อเอง</p>",
        note: "สลับกลับเป็นบาทได้ทุกเมื่อ ไม่กระทบข้อมูล" },
      { when: function () { return C.mode() === "KRW" && !C.can("work_records"); }, center: true, title: "บันทึกการเข้างาน (Finance Plus)",
        text: "<p>บันทึกงานรายวัน เลือกประเภทวัน กรอกชั่วโมงปกติและ OT ระบบคำนวณค่าแรงเป็นวอนและบาท แล้วรวมเป็นสรุปรายได้ประจำเดือน</p>",
        formula: WORK_FX, note: lockNote("Finance Plus") },
      { when: canWork, target: '[data-tour="work-record"]', before: closeTools, title: "ปุ่มบันทึกการเข้างาน",
        text: "<p>เปิดหน้าต่างบันทึกงาน (หรือใช้ <b>+ บันทึกด่วน → บันทึกการเข้างาน</b> จากหน้าไหนก็ได้)</p>",
        flow: ["บันทึกวันทำงาน", "ประวัติการทำงาน", "สรุปรายได้"] },
      { when: canWork, before: function () { return workView("wmenu"); }, target: ".tl-modal.open .tl-menu", title: "เมนูบันทึกการเข้างาน",
        text: "<ul><li><b>บันทึกเข้างานวันนี้</b> — วันนี้ (ถ้ามีแล้วจะเป็นการแก้ไข)</li><li><b>บันทึกย้อนหลัง</b> — เลือกวันจากปฏิทิน</li><li><b>สรุปรายได้</b> — รวมรายเดือน</li>" +
          "<li><b>ประวัติการทำงาน</b> — ดู แก้ไข ลบรายวัน</li><li><b>ตั้งค่า</b> — ค่าแรงและตัวคูณ</li></ul>" },
      { section: "ขั้นตอนบันทึก", when: canWork, before: function () { return workExample("wtype"); }, target: ".tl-modal.open .tl-types",
        title: "1 · เลือกประเภทวัน",
        text: function () {
          var s = settings();
          return "<p>ตัวคูณที่ใช้: <b>วันปกติ</b> ปกติ " + x(s.normal) + " · OT " + x(s.ot) + " · <b>เสาร์-อาทิตย์</b> " + x(s.weekend) + " ทั้งวัน · <b>วันหยุดนักขัตฤกษ์</b> " + x(s.holiday) +
            " ทั้งวัน · <b>วันหยุดงาน</b> บันทึกไว้ ไม่มีรายได้</p>";
        },
        note: "หน้าจอนี้เป็นตัวอย่างระหว่างแนะนำ ยังไม่มีการบันทึก" },
      { section: "ขั้นตอนบันทึก", when: canWork, before: function () { return workExample("whours"); }, union: [".tl-modal.open .tl-chips", ".tl-modal.open .tl-stepper"],
        title: "2 · ชั่วโมงทำงานปกติ",
        facts: [["กรอก", "ชั่วโมงทำงานปกติของวันนั้น <b>ไม่รวม OT</b>"], ["รูปแบบ", "แตะตัวเลขสำเร็จรูป หรือปุ่ม − / + ทีละ 0.5 ชั่วโมง"], ["ค่าเริ่มต้น", "กด <b>☆ ตั้งเป็นค่าเริ่มต้น</b> ครั้งหน้าจะเลือกไว้ให้ กดถัดไปได้เลย"]] },
      { section: "ขั้นตอนบันทึก", when: canWork, before: function () { return workExample("wot"); }, union: [".tl-modal.open .tl-chips", ".tl-modal.open .tl-stepper"],
        title: "3 · ชั่วโมง OT",
        facts: function () { return [["กรอก", "ชั่วโมงล่วงเวลา ไม่มีกด <b>ไม่มี</b> · มีเศษเช่น 2.5 ใช้ − / +"], ["ตัวคูณ", "วันปกติใช้ OT " + x(settings().ot) + " · เสาร์-อาทิตย์/วันหยุดใช้ตัวคูณของวันนั้น"],
                ["ค่าเริ่มต้น", "ตั้งได้เหมือนชั่วโมงปกติ"]]; } },
      { section: "ขั้นตอนบันทึก", when: canWork, before: function () { return workExample("wnight"); }, union: [".tl-modal.open .tl-chips", ".tl-modal.open .tl-stepper"],
        title: "4 · ชั่วโมงกลางคืน",
        facts: function () { return [["กรอก", "ชั่วโมงที่ทำช่วง 22:00–06:00 (นับอยู่ในชั่วโมงปกติ/OT แล้ว) · ไม่มีกด <b>ไม่มี</b>"], ["ได้เพิ่ม", "ค่าแรง × " + num(settings().night) + " ต่อชั่วโมง (야간근로수당)"]]; } },
      { section: "ค่าแรง", when: canWork, before: function () { return workView("wset"); },
        target: function () { return ["sWage", "sOt"].map(function (id) { var i = d.getElementById(id); return i && i.closest(".tl-field"); }); },
        title: "5 · ค่าแรงและตัวคูณ (ตั้งค่า)",
        facts: function () {
          var s = settings();
          return [["ค่าแรง", "<b>" + fmt(s.wage) + " ₩</b> ต่อชั่วโมง (ค่าที่ตั้งไว้ตอนนี้)"], ["ตัวคูณ", "ปกติ " + x(s.normal) + " · OT " + x(s.ot) + " · Weekend " + x(s.weekend) + " · Holiday " + x(s.holiday) + " (ช่องถัดลงไป)"],
                  ["มีผลกับ", "การบันทึก<b>ครั้งต่อไป</b> — วันที่บันทึกไว้แล้วจำค่าแรงของวันนั้น ไม่เปลี่ยนตาม"]];
        } },
      { section: "คำนวณ", when: canWork, before: function () { return workExample("wconfirm"); },
        target: function () { var rows = d.querySelectorAll(".tl-modal.open .tl-receipt .tl-rrow"), t = d.querySelector(".tl-modal.open .tl-total"); return rows.length > 4 ? [rows[4], t] : [t]; },
        title: "6 · ระบบคำนวณรายได้",
        formula: WORK_FX,
        example: function () {
          var t = tools(); if (!t) return "";
          var s = settings(), r = t.calc("normal", 8, 2);
          return "ตัวอย่าง วันปกติ 8 ชม. + OT 2 ชม.: 8 × " + fmt(s.wage) + " × " + num(s.normal) + " = " + fmt(r.regInc) + " ₩ · 2 × " + fmt(s.wage) + " × " + num(s.ot) + " = " + fmt(r.otInc) + " ₩ → <b>รวม " + fmt(r.krw) + " ₩</b>";
        },
        note: "เสาร์-อาทิตย์และวันหยุดใช้ตัวคูณของวันนั้นแทนทั้งชั่วโมงปกติและ OT" },
      { section: "คำนวณ", when: canWork, before: function () { return workExample("wconfirm"); }, union: [".tl-modal.open .tl-total", ".tl-modal.open .tl-rrow.dim"], title: "7 · แปลงเป็นเงินบาท",
        formula: [["≈ บาท", "รวม (KRW) × เรต"]],
        example: function () { var t = tools(); if (!t) return ""; var r = t.calc("normal", 8, 2), rt = t.rate(); return fmt(r.krw) + " ₩ × " + rt.toFixed(4) + " ≈ <b>" + fmt(r.krw * rt, 2) + " ฿</b>"; },
        note: "เรตมาจากช่องอัตราแลกเปลี่ยนบนหน้าหลัก และถูก<b>ล็อกไว้กับวันนั้น</b>ตอนบันทึก" },
      { section: "คำนวณ", when: canWork, before: function () { return workExample("wconfirm"); }, target: ".tl-modal.open .tl-actions", title: "8 · บันทึก แล้วข้อมูลไปไหน",
        text: "<p>กด <b>บันทึก</b> แล้ววันนั้นจะไปอยู่ใน<b>ประวัติการทำงาน</b> และถูกรวมใน<b>สรุปรายได้</b>ของเดือนทันที · บันทึกวันเดิมซ้ำ = อัปเดตทับ</p>",
        flow: ["บันทึก", "ประวัติการทำงาน", "สรุปรายได้ประจำเดือน"] },
      { when: canWork, before: function () { return workView("wcal", { calMode: "hist", calYM: ym() }); }, union: [".tl-modal.open .tl-cal", ".tl-modal.open .tl-legend"],
        title: "ประวัติการทำงาน (ปฏิทิน)",
        text: "<p>จุดสีบอกประเภทวัน: ทำงานปกติ · มี OT · เสาร์-อาทิตย์ — แตะวันที่เพื่อดูรายละเอียด <b>แก้ไข</b> หรือ <b>ลบ</b> และดูยอดรวมของเดือนด้านล่าง</p>" }
    ]
  });

  /* ================================================================ 5. สรุปรายได้ */
  T.register({
    id: "income", icon: "trend", page: "home", feature: "work_records", featurePlan: "Finance Plus",
    title: "สรุปรายได้ประจำเดือน", desc: "รายได้ก่อนหัก รายการหัก รายได้สุทธิ และเทียบกับเงินเข้าจริง",
    unavailable: function () { return C.mode() === "THB" ? "ใช้ในโหมดวอน" : ""; },
    cleanup: closeTools,
    steps: [
      { when: function () { return !canWork(); }, center: true, title: "สรุปรายได้ (Finance Plus · โหมดวอน)",
        text: "<p>รวมทุกวันที่บันทึกการเข้างานในเดือน หักภาษีและค่าใช้จ่ายจำเป็น ได้รายได้สุทธิ แล้วเทียบกับเงินที่เข้าบัญชีจริง</p>",
        formula: [["รายได้สุทธิ", "รายได้ก่อนหัก − รายการหักทั้งหมด"], ["ส่วนต่าง", "เงินเข้าจริง − รายได้สุทธิที่คำนวณ"]],
        note: function () { return C.mode() === "THB" ? "สลับเป็นโหมด ₩ วอนบนหน้าหลักเพื่อใช้งาน" : lockNote("Finance Plus"); } },
      { when: canWork, before: function () { return workView("wmenu"); }, target: '.tl-modal.open [data-act="m-sum"]', title: "เปิดสรุปรายได้",
        text: "<p>อยู่ในหน้าต่าง <b>บันทึกการเข้างาน</b> → <b>สรุปรายได้</b></p>" },
      { when: canWork, before: function () { return workView("wsum", { sumYM: ym() }); }, union: [".tl-modal.open .tl-mnav", ".tl-modal.open .tl-kpis"], title: "เลือกเดือน และตัวเลขสรุป",
        text: "<p>เลื่อนเดือนด้วยลูกศร ‹ › · <b>วันทำงาน</b> (ไม่นับวันหยุดงาน) · <b>ชั่วโมงปกติ</b>รวม · <b>OT</b>รวม ของเดือนนั้น</p>" },
      { when: canWork, before: function () { return workView("wsum", { sumYM: ym() }); }, target: function () { var b = d.querySelector(".tl-modal.open .tl-big"); return b && b.closest(".tl-sec"); },
        title: "รายได้ก่อนหัก",
        formula: [["วอน", "ผลรวม “รวมต่อวัน” ของทุกวันในเดือน"], ["บาท", "ผลรวมยอดบาทของแต่ละวัน (เรตของวันนั้น)"]] },
      { when: canWork, before: function () { return workView("wsum", { sumYM: ym() }); }, target: function () { var i = d.getElementById("dedName"); return i && i.closest(".tl-sec"); },
        title: "หักภาษีและสิ่งจำเป็น",
        facts: [["กรอก", "ชื่อรายการ (เช่น ภาษีท้องถิ่น ค่าหอพัก ประกัน) และจำนวนเงินวอน"], ["ผลลัพธ์", "แปลงเป็นบาทด้วยเรตปัจจุบัน และรวมยอดหักของเดือน"],
                ["แก้ไข", "เพิ่มได้หลายรายการ ลบรายการที่ผิดได้ด้วยปุ่มถังขยะ"]] },
      { when: canWork, before: function () { return workView("wsum", { sumYM: ym() }); }, target: ".tl-modal.open .tl-sec.net", title: "รายได้สุทธิหลังหัก",
        formula: [["รายได้สุทธิ", "รายได้ก่อนหัก − รวมรายการหัก"]] },
      { when: canWork, before: function () { return workView("wsum", { sumYM: ym() }); }, target: function () { var i = d.getElementById("rcvAmt"); return i && i.closest(".tl-sec"); },
        title: "เงินเดือนที่เข้าบัญชีจริง",
        facts: [["กรอก", "ยอดที่โอนเข้าบัญชีจริงของเดือนนั้น (วอน)"], ["ผลลัพธ์", "ส่วนต่างจากที่คำนวณ 🟢 มากกว่า / 🔴 น้อยกว่า — ช่วยตรวจว่าได้เงินครบ"]],
        formula: [["ส่วนต่าง", "เงินเข้าจริง − รายได้สุทธิที่คำนวณ"]] },
      { when: function () { return canWork() && C.can("monthly_digest"); }, before: function () { return workView("wset"); }, target: '.tl-modal.open [data-feature="monthly_digest"]', optional: true,
        title: "แจ้งเตือนสรุปประจำเดือน (Premium)",
        text: "<p>ตั้งวันที่ (1–31) ให้ระบบเด้งสรุปรายได้ ชั่วโมง วันทำงาน และ OT ของเดือนที่ผ่านมา เมื่อเปิดเว็บในวันนั้นหรือหลังจากนั้น</p>" },
      { center: true, title: "เชื่อมกับหน้าหลักอย่างไร",
        text: "<p>สรุปรายได้นี้แยกจาก <b>ประวัติเงินเดือน</b> บนหน้าหลัก ถ้าต้องการให้เดือนนั้นเข้า <b>สถิติการเงิน</b> และ <b>เป้าหมายเงินเก็บ</b> ให้นำยอดเงินเข้าจริงไปบันทึกที่ <b>บันทึกเงินเดือนรายเดือน</b></p>",
        flow: ["สรุปรายได้", "บันทึกเงินเดือนรายเดือน", "สถิติ", "เป้าหมาย"] }
    ]
  });

  /* ================================================================ 6. รายจ่าย */
  T.register({
    id: "expense", icon: "receipt", page: "home", title: "บันทึกรายจ่าย", desc: "จดค่าใช้จ่าย วอนหรือบาท และผูกกับการ์ดเพื่อหักยอดสะสม",
    cleanup: closeTools,
    steps: [
      { target: '[data-tour="expense"]', before: closeTools, title: "ปุ่มรายจ่าย",
        text: "<p>เปิดหน้าต่างบันทึกรายจ่าย — สกุลเงินตามโหมดที่เลือก (วอนหรือบาท) หรือใช้ <b>+ บันทึกด่วน → บันทึกรายจ่าย</b></p>" },
      { before: function () { return openTool("expense"); }, target: ".tl-modal.open #exForm", title: "กรอกรายจ่าย",
        facts: function () {
          var k = C.mode() !== "THB";
          return [["ชื่อรายการ", "เช่น ค่าอาหาร ค่าเดินทาง"], ["จำนวนเงิน", k ? "เป็นวอน — ระบบแสดง ≈ บาทให้ (จำนวน × เรต)" : "เป็นบาท"],
                  ["ผูกกับการ์ด", "เลือกการ์ดแบ่งเงิน เพื่อหักออกจากยอดสะสมของการ์ดนั้นใน “สถิติการเงิน” (Finance Plus)"], ["แก้ไข", "แก้หรือลบรายการได้จากรายการด้านล่าง"]];
        } },
      { when: function () { return C.can("advanced_statistics"); }, before: function () { return openTool("expense"); }, target: ".tl-modal.open #exCat", optional: true, title: "ผูกรายจ่ายกับการ์ด",
        formula: [["ยอดสะสมในสถิติ", "รายได้ทั้งหมด × % ของการ์ด − รายจ่ายที่ผูกกับการ์ดนั้น"]],
        flow: ["รายจ่าย", "การ์ดที่ผูก", "สถิติการเงิน", "เป้าหมาย (ถ้าเป็นการ์ดเงินเก็บ)"] },
      { before: function () { return openTool("expense"); }, union: [".tl-modal.open #exSeg", ".tl-modal.open #exList"], title: "รายการและประวัติรายจ่าย",
        text: "<p><b>รายการรายจ่าย</b> — ของเดือนที่เลือก พร้อมยอดรวม · <b>ประวัติรายจ่าย</b> — ย้อนดูทุกเดือน</p>",
        note: function () { var n = quota("expense_items_max"); return n ? "แพ็กเกจของคุณบันทึกได้สูงสุด " + n + " รายการ · Finance Plus ไม่จำกัด" : ""; } }
    ]
  });

  /* ================================================================ 7. ทองคำ */
  T.register({
    id: "gold", icon: "gold", page: "gold", title: "ระบบทองคำ", desc: "ราคาทอง ตั้งราคาซื้อ บันทึกรอบซื้อ ต้นทุน กำไร/ขาดทุน และจำลองขาย",
    steps: [
      { section: "ราคาทอง", union: ['[data-tour="gold-hero"] h1', '[data-tour="gold-market"]'], title: "พอร์ตทองคำ และสถานะราคา",
        text: "<p>ราคาทองโหลดอัตโนมัติ จุดสีบอกสถานะการเชื่อมต่อ และเวลาที่อัปเดตล่าสุด</p>" },
      { section: "ราคาทอง", target: '[data-tour="gold-buycalc"]', interactive: true, title: "ตั้งราคาซื้อ (troy oz → ทองแท่ง 96.5%)",
        facts: [["กรอก", "ราคาทองที่ต้องการเป็น USD ต่อ troy oz เช่น 4050"], ["ผลลัพธ์", "ราคาทองแท่ง 96.5% ของไทยต่อบาททองตามสูตรทฤษฎี"]],
        formula: [["บาท / บาททอง", "USD/oz × USD/THB ÷ 31.1034768 × 15.244 × 0.965"]],
        note: "ยังไม่รวมส่วนต่างของร้าน · ลองกรอกแล้วกดคำนวณดูได้ ไม่มีการบันทึก" },
      { section: "ราคาทอง", target: '[data-tour="gold-chart"]', title: "กราฟราคาทองย้อนหลัง",
        text: "<p>เลือกช่วงเวลา สลับรูปแบบกราฟ และใช้ปุ่ม Fit · Reset · เต็มจอ — สำหรับดูแนวโน้มเท่านั้น ไม่มีผลกับพอร์ต</p>" },
      { section: "ราคาทอง", union: ['[data-tour="gold-prices-head"]', '[data-tour="gold-prices"]'], title: "ราคาตลาดและราคาไทย",
        text: "<p>Gold Spot (USD/oz) · USD/THB · ราคาต่อกรัมและต่อ oz เป็นบาท · ทองแท่งและทองรูปพรรณ รับซื้อ/ขายออก · กด <b>อัปเดต</b> เพื่อดึงใหม่</p>" },
      { section: "บันทึกรอบซื้อ", target: function () { var r = d.querySelectorAll('[data-tour="gold-lot-form"] .form-row'); return r.length ? [].slice.call(r) : first('[data-tour="gold-lot-form"]'); },
        title: "บันทึกรอบซื้อ",
        facts: [["วันที่ / เวลา", "วันที่ซื้อจริง"], ["ประเภททอง", "99.99% หรือ 96.5%"], ["จำนวน + หน่วย", "troy oz · กรัม · บาททอง (น้ำหนัก)"],
                ["เงินที่จ่ายจริง", "บาท รวมค่าธรรมเนียมแล้ว — นี่คือต้นทุน"], ["ราคาต่อบาททอง", "(ช่องถัดลงไป) ไม่บังคับ ไว้อ้างอิงราคาตอนซื้อ"], ["หมายเหตุ", "ไม่บังคับ"]],
        formula: [["น้ำหนัก (กรัม)", "oz × 31.1034768 · บาททอง × 15.244 · กรัม = เท่าเดิม"]] },
      { section: "บันทึกรอบซื้อ", target: '[data-tour="gold-lot-preview"]', title: "ตัวอย่างก่อนบันทึก",
        text: "<p>แสดงน้ำหนักทองและต้นทุนเฉลี่ยทันทีที่กรอก กด <b>บันทึกรอบนี้</b> แล้วรอบซื้อจะเข้าพอร์ตด้านล่าง</p>",
        formula: [["ต้นทุนเฉลี่ย", "เงินที่จ่าย ÷ น้ำหนัก (กรัม)"]] },
      { section: "ผลของพอร์ต", union: ['[data-tour="gold-stats"]', '[data-tour="gold-stats2"]'], title: "ภาพรวมพอร์ต",
        formula: [["ต้นทุนสะสม", "ผลรวมเงินที่จ่ายทุกรอบ"], ["มูลค่าปัจจุบัน", "ผลรวมมูลค่าของทุกรอบตามราคาขายคืน"], ["P/L สุทธิ", "มูลค่าปัจจุบัน − ต้นทุนสะสม (% = P/L ÷ ต้นทุน)"],
                  ["ต้นทุนเฉลี่ย", "ต้นทุนสะสม ÷ ทองทั้งหมด (กรัม)"]] },
      { section: "ผลของพอร์ต", target: '[data-tour="gold-valuation"]', title: "ราคาที่ใช้คำนวณ P/L",
        text: "<p><b>GOLD2go รับซื้อ 96.5%</b> (แนะนำ) — ราคาที่ขายคืนได้จริง: ดึงอัตโนมัติ · กรอกเองจากแอป · หรือใช้ราคาล่าสุดที่จำไว้เมื่อออฟไลน์</p><p><b>XAU/THB ตลาดโลก</b> — ราคาประมาณการ</p>",
        formula: [["รอบทอง 96.5% (โหมด GOLD2go)", "น้ำหนักเป็นบาททอง × ราคารับซื้อ"], ["รอบอื่น / โหมดตลาด", "กรัม × ราคา THB/กรัม × (ความบริสุทธิ์ ÷ 99.99)"]] },
      { section: "ผลของพอร์ต", target: '[data-tour="gold-lots-card"]', title: "รายการซื้อแต่ละรอบ",
        text: "<p>ดู P/L ของแต่ละรอบ ลบรอบที่ผิด Export เป็นไฟล์สำรอง และกู้คืนจากไฟล์ได้</p>" },
      { section: "จำลองขาย", target: '[data-tour="gold-simulate"]', interactive: true, title: "จำลองขาย",
        formula: [["ต้นทุนส่วนที่ขาย", "ต้นทุนสะสม × %"], ["มูลค่าขาย", "มูลค่าปัจจุบัน × %"], ["กำไร/ขาดทุน", "มูลค่าขาย − ต้นทุนส่วนที่ขาย"]],
        note: "ลองกด ขาย 25% / 50% ดูได้ — เป็นการจำลอง ไม่ลบหรือเปลี่ยนรอบซื้อ" },
      { center: true, title: "พอร์ตทองเชื่อมกับส่วนอื่นอย่างไร",
        text: "<p>รอบซื้อเก็บในบัญชีของคุณบนเครื่องนี้ · <b>Finance Premium</b> ซิงก์พอร์ตทองข้ามอุปกรณ์ และแสดงมูลค่าพอร์ตล่าสุดในการ์ดบทบาท <b>ออมทอง</b> ของสถิติการเงิน</p>",
        flow: ["รอบซื้อ", "พอร์ตทอง", "การ์ดออมทอง (สถิติ)"] }
    ]
  });

  /* ================================================================ 8. บัตรเครดิต & หนี้ */
  var DEBT = { ws: null, tab: null };
  function debtWs() { return !!d.querySelector(".cd-ws"); }
  function debtTab(tab) {
    return function () {
      if (!debtWs()) return;
      var on = d.querySelector(".cd-ws-t.on");
      if (DEBT.ws === null) { DEBT.ws = on ? on.getAttribute("data-ws") : "overview"; var t0 = d.querySelector(".cd-tab.on"); DEBT.tab = t0 ? t0.getAttribute("data-tab") : "cards"; }
      if (!on || on.getAttribute("data-ws") === "overview") { C.click('.cd-ws-t[data-ws="THB"]'); }
      return C.wait(".cd-tabs", 1500).then(function () {
        if (tab) { var b = d.querySelector('.cd-tab[data-tab="' + tab + '"]'); if (b && !b.classList.contains("on")) b.click(); }
        return C.sleep(120);
      });
    };
  }
  T.register({
    id: "debt", icon: "card", page: "debt", feature: "credit_debt", featurePlan: "Finance Premium",
    title: "ระบบบัตรเครดิตและหนี้", desc: "พื้นที่ ฿/₩ ตัวเลขสำคัญ บัตร ผ่อน ปฏิทิน และแผนปลดหนี้",
    cleanup: function () {                                      // put the page back on the view the person had
      var ws0 = DEBT.ws, tab0 = DEBT.tab;
      DEBT.ws = DEBT.tab = null;
      if (!ws0 || !debtWs()) return;
      var ws = d.querySelector('.cd-ws-t[data-ws="' + ws0 + '"]'); if (ws && !ws.classList.contains("on")) ws.click();
      setTimeout(function () { var t = tab0 && d.querySelector('.cd-tab[data-tab="' + tab0 + '"]'); if (t && !t.classList.contains("on")) t.click(); }, 60);
    },
    steps: [
      { when: function () { return !debtWs(); }, target: ".cd-intro", title: "Smart Credit & Debt",
        text: "<p>รวมบัตรเครดิตทุกใบ แผนผ่อน การโอนหนี้ ปฏิทินครบกำหนด และแผนปลดหนี้ไว้ที่เดียว แยกสกุลบาทและวอน — สำหรับสมาชิก <b>Finance Premium</b></p>",
        note: "ไม่เก็บเลขบัตรเต็ม CVV หรือ PIN — เก็บแค่เลข 4 ตัวท้ายไว้แยกบัตร" },
      { when: function () { return !debtWs(); }, target: '[data-act="demo-on"]', interactive: true, optional: true,
        advanceWhen: function () { return debtWs(); }, title: "ลองดูตัวอย่าง (Demo)",
        text: "<p>แตะ <b>ดูตัวอย่าง</b> เพื่อเปิดข้อมูลสมมติ แล้วทัวร์จะพาดูแต่ละส่วนต่อ — ข้อมูลตัวอย่างไม่ถูกบันทึกลงบัญชี</p>" },
      { when: debtWs, target: ".cd-ws", title: "พื้นที่สกุลเงิน",
        text: "<p><b>ภาพรวม</b> รวมสองสกุล (แปลงด้วยเรตแสดงผลเพื่อดูภาพรวมเท่านั้น) · <b>฿ บาท</b> และ <b>₩ วอน</b> แยกบัตรและหนี้ของแต่ละสกุล ไม่ปนกัน</p>" },
      { when: debtWs, before: debtTab(null), target: ".cd-ws-head .cd-kpis", title: "ตัวเลขสำคัญของสกุลนี้",
        formula: [["หนี้รวม", "ยอดค้างบัตร + หนี้ผ่อนนอกบัตร"], ["ต้องจ่ายใน 30 วัน", "งวดผ่อนที่ครบกำหนดใน 30 วัน"], ["ใช้วงเงิน", "ยอดที่ใช้ ÷ วงเงินรวม (ควรต่ำกว่า 30%)"],
                  ["ค้างชำระ", "งวดที่เลยกำหนดแล้วยังจ่ายไม่ครบ"]] },
      { when: debtWs, before: debtTab(null), target: ".cd-tabs", title: "เมนูย่อย",
        text: "<p><b>บัตร</b> · <b>ผ่อน</b> · <b>โอนหนี้</b> · <b>ชำระ</b> · <b>ปฏิทิน</b> · <b>วิเคราะห์</b> · <b>แผนปลดหนี้</b> — เลื่อนแถบไปทางซ้ายเพื่อดูครบ</p>" },
      { section: "บัตร", when: debtWs, before: debtTab("cards"), target: function () { return first('.cd-panel [data-act="card-new"]') || first(".cd-panel"); }, title: "บัตรเครดิต",
        facts: [["กรอก", "ชื่อบัตร ธนาคาร เลข 4 ตัวท้าย วงเงิน วันตัดรอบ วันครบกำหนด"], ["ผลลัพธ์", "หน้าบัตร ยอดค้าง % การใช้วงเงิน และวันครบกำหนดในปฏิทิน"],
                ["ปลอดภัย", "ไม่ขอเลขบัตรเต็ม วันหมดอายุ CVV หรือ PIN"]] },
      { section: "ผ่อน", when: debtWs, before: debtTab("plans"), target: ".cd-panel", title: "แผนผ่อน",
        text: "<p>ผ่อน 0% · ดอกคงที่ · ลดต้นลดดอก — ระบบสร้างตารางงวดให้อัตโนมัติ และยืนยันยอดจริงตาม statement ได้</p>" },
      { section: "ปฏิทิน", when: debtWs, before: debtTab("calendar"), target: ".cd-panel", title: "ปฏิทินครบกำหนด",
        text: "<p>รวมวันครบกำหนดบัตร งวดผ่อน และการโอนหนี้ของทั้งเดือนไว้ที่เดียว แตะวันที่เพื่อดูรายการ</p>" },
      { section: "แผนปลดหนี้", when: debtWs, before: debtTab("planner"), target: ".cd-panel", title: "แผนปลดหนี้",
        text: "<p>ใส่งบที่จ่ายได้ต่อเดือน แล้วเลือกวิธี: <b>Avalanche</b> จ่ายหนี้ดอกเบี้ยสูงก่อน (ประหยัดดอกเบี้ยสุด) · <b>Snowball</b> ปิดหนี้ยอดน้อยก่อน (เห็นผลเร็ว) — ระบบบอกเดือนที่หมดหนี้และดอกเบี้ยรวม</p>" },
      { center: true, title: "ถ้า Premium หมดอายุ",
        text: "<p>หน้านี้จะเป็น<b>โหมดอ่านอย่างเดียว</b>: ข้อมูลทั้งหมดยังอยู่ครบ ดูปฏิทิน กราฟ และส่งออกได้ แต่เพิ่ม/แก้ไข/ลบไม่ได้จนกว่าจะต่ออายุ</p>" }
    ]
  });

  /* ================================================================ 9. บัญชีและสมาชิก */
  T.register({
    id: "account", icon: "user", page: "account", title: "ระบบบัญชีและสมาชิก", desc: "แพ็กเกจ วันหมดอายุ การจัดการ ใบเสร็จ ข้อมูลของฉัน และแชทแอดมิน",
    steps: [
      { target: "#whoami", title: "บัญชีของคุณ", text: "<p>หน้านี้รวมทุกอย่างเกี่ยวกับสมาชิกและการชำระเงินของบัญชีที่เข้าสู่ระบบอยู่</p>" },
      { target: '[data-tour="account-support"]', title: "ติดต่อแอดมิน / Feedback",
        text: "<p>กด <b>เปิดแชท</b> เพื่อพิมพ์ติชม แจ้งปัญหา หรือส่งรูปภาพหน้าจอถึงทีมงาน · ประกาศจากทีมงานก็อยู่ในแชทนี้</p><p>เมื่อแอดมินตอบ จะมี<b>ตัวเลขสีแดง</b>ที่เมนูบัญชี และหายไปเมื่อเปิดอ่าน</p>" },
      { target: '[data-tour="account-plan"]', title: "แพ็กเกจปัจจุบัน",
        text: function () {
          return C.preview() ? "<p>เข้าสู่ระบบเพื่อดูแพ็กเกจ วันต่ออายุ และใบเสร็จของคุณ</p>"
            : "<p>ชื่อแพ็กเกจ สถานะ ราคา และ<b>วันหมดอายุ / วันต่ออายุ</b> พร้อมจำนวนวันที่เหลือ</p>";
        } },
      { target: "#alerts .alert", optional: true, title: "การแจ้งเตือนสำคัญ",
        text: "<p>เช่น ชำระเงินรอบล่าสุดไม่สำเร็จ หรือแพ็กเกจจะสิ้นสุดวันไหน — มีปุ่มจัดการต่อในกล่องนี้</p>" },
      { target: '[data-tour="account-manage"]', optional: true, title: "จัดการแพ็กเกจ",
        text: "<p>เปลี่ยนแพ็กเกจ (ยืนยันในหน้าของ Stripe) หรือยกเลิกการต่ออายุอัตโนมัติ — ยกเลิกแล้วยังใช้ได้ถึงวันสิ้นสุดรอบบิล</p>" },
      { target: '[data-tour="account-addons"]', optional: true, title: "Add-on ของฉัน", text: "<p>ฟีเจอร์ที่ซื้อแยกเป็นรายเดือน ยกเลิกทีละตัวได้</p>" },
      { target: '[data-tour="account-history"]', optional: true, title: "ประวัติการชำระเงิน", text: "<p>ทุกรายการที่ชำระ พร้อมลิงก์ใบเสร็จจาก Stripe</p>" },
      { target: '[data-tour="account-data"]', optional: true, title: "ข้อมูลของฉัน", text: "<p>ดาวน์โหลดข้อมูลทั้งหมดของบัญชีเป็นไฟล์ JSON ได้ทุกแพ็กเกจ</p>" },
      { center: true, title: "เมื่อแพ็กเกจหมดอายุ ข้อมูลไม่หาย",
        text: "<p>บัญชีกลับเป็น <b>Free</b> โดย<b>ข้อมูลทั้งหมดยังอยู่</b> และยังดูได้ แต่เพิ่มหรือแก้ในฟีเจอร์ที่จำกัดไม่ได้ เช่น บัตร·หนี้เป็นโหมดอ่านอย่างเดียว และประวัติเงินเดือน/รายจ่ายเพิ่มได้ตามโควตา Free</p><p>ต่ออายุเมื่อไรก็ใช้งานต่อจากเดิมได้ทันที</p>" }
    ]
  });

  /* ================================================================ 10. Premium และการชำระเงิน */
  T.register({
    id: "premium", icon: "crown", page: "pricing", title: "แพ็กเกจ Premium และการชำระเงิน", desc: "เปรียบเทียบแพ็กเกจ รายเดือน/รายปี Add-on และวิธีสมัครหรือต่ออายุ",
    steps: [
      { target: '[data-tour="pricing-toggles"]', interactive: true, title: "รอบบิลและสกุลเงิน",
        text: "<p>สลับ <b>รายเดือน / รายปี</b> (รายปีมีส่วนลด) และ <b>บาท / วอน</b> เพื่อดูราคาในสกุลที่จะจ่าย — ลองแตะได้</p>" },
      { target: '[data-tour="pricing-plans"]', title: "เปรียบเทียบแพ็กเกจ",
        text: "<ul><li><b>Free</b> — เงินเดือน การแบ่งเงิน รายจ่าย (มีโควตา)</li><li><b>Finance Plus</b> — บันทึกการเข้างาน สถิติและกราฟ เป้าหมาย สัญญาจ้าง Export Cloud Sync ไม่จำกัดประวัติ</li>" +
          "<li><b>Finance Premium</b> — ทุกอย่างของ Plus + พอร์ตทองซิงก์ บัตร·หนี้ และแจ้งเตือนสรุปประจำเดือน</li></ul>",
        note: "รายละเอียดล่าสุดอยู่ในการ์ดของแต่ละแพ็กเกจ" },
      { target: '[data-tour="pricing-addons"]', optional: true, title: "Add-on", text: "<p>ซื้อเฉพาะฟีเจอร์ที่ต้องการเป็นรายเดือนได้ทั้ง Free และ Finance Plus</p>" },
      { center: true, title: "วิธีสมัครหรือต่ออายุ",
        text: "<p>กดปุ่มในการ์ดแพ็กเกจ → ชำระผ่าน <b>Stripe</b> (บัตรเครดิต/เดบิต — PLANNER ไม่เห็นเลขบัตรของคุณ) → กลับมาที่เว็บ ป้ายแพ็กเกจจะเปลี่ยนเมื่อระบบยืนยันการชำระ</p>",
        flow: ["เลือกแพ็กเกจ", "ชำระที่ Stripe", "ป้ายแพ็กเกจอัปเดต", "จัดการได้ที่หน้าบัญชี"] },
      { target: '[data-tour="pricing-note"]', title: "เงื่อนไขสำคัญ",
        text: "<p>ต่ออายุอัตโนมัติจนกว่าจะยกเลิก · ยกเลิกแล้วใช้ได้ถึงสิ้นรอบบิล · หมดอายุแล้วกลับเป็น Free โดย<b>ข้อมูลทั้งหมดยังอยู่</b></p>" }
    ]
  });

  window.KfpTourContent = true;
})();
