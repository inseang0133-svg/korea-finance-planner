/*
  alloc-ui.js — หน้าจอ “⚙️ จัดการ” การ์ดแบ่งเงิน (เพิ่ม/ลบ/เปลี่ยนชื่อ/ตั้ง %/รีเซ็ต)
  ใช้ฟังก์ชันจาก kfp-config.js; เมื่อบันทึกจะเรียก kfpOnAllocChanged() เพื่ออัปเดตการ์ดทั้งหมดตามไปด้วย
*/
(function () {
  "use strict";
  if (window.__kfpAllocUi) return;
  window.__kfpAllocUi = true;

  var d = document, panel = null, rows = [], lastFocus = null;
  var $ = function (id) { return d.getElementById(id); };
  var esc = function (s) { return window.kfpEsc(s); };
  var num = function (v) { var n = Number(v); return isFinite(n) ? n : 0; };

  var SHELL =
    '<div class="kfp-modal-card" role="document">' +
      '<h2 id="allocTitle">⚙️ จัดการการ์ดแบ่งเงิน</h2>' +
      '<p class="kfp-modal-sub">ตั้งชื่อ อีโมจิ และ % ของแต่ละการ์ด · รวมกันต้องได้ 100%</p>' +
      '<div class="alloc-rows" id="allocRows"></div>' +
      '<button type="button" class="alloc-add" id="allocAdd">➕ เพิ่มการ์ด</button>' +
      '<div class="alloc-total" id="allocTotal" aria-live="polite"><div class="at-bar"><i></i></div><div class="at-text"></div></div>' +
      '<div class="alloc-tools">' +
        '<button type="button" class="alloc-ghost" id="allocEqual">⚖️ แบ่งเท่าๆ กัน</button>' +
        '<button type="button" class="alloc-ghost" id="allocReset">↺ ค่าเริ่มต้น 5 การ์ด</button>' +
      '</div>' +
      '<p class="alloc-msg" id="allocMsg" role="status"></p>' +
      '<div class="alloc-actions">' +
        '<button type="button" id="allocSave">💾 บันทึก</button>' +
        '<button type="button" class="alloc-close" id="allocClose">ปิด</button>' +
      '</div>' +
      '<p class="alloc-note">เมื่อบันทึก การ์ดผลคำนวณ กราฟ สัดส่วน และ “สถิติการเงิน” จะเปลี่ยนตามทันที (คำนวณจากรายการเงินเดือนที่บันทึกไว้ทั้งหมดด้วยสัดส่วนใหม่)</p>' +
    '</div>';

  function build() {
    if (panel) return;
    panel = d.createElement("div");
    panel.id = "kfpAllocPanel";
    panel.className = "kfp-modal";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "allocTitle");
    panel.innerHTML = SHELL;
    d.body.appendChild(panel);

    panel.addEventListener("pointerdown", function (e) { if (e.target === panel) close(); });
    $("allocClose").onclick = close;
    $("allocAdd").onclick = addRow;
    $("allocEqual").onclick = equalize;
    $("allocReset").onclick = resetDefault;
    $("allocSave").onclick = save;

    var list = $("allocRows");
    list.addEventListener("input", function (e) {
      var row = e.target.closest(".alloc-row"); if (!row) return;
      var r = rows[Number(row.dataset.i)]; if (!r) return;
      if (e.target.classList.contains("al-emoji")) r.emoji = e.target.value;
      else if (e.target.classList.contains("al-name")) r.name = e.target.value;
      else if (e.target.classList.contains("al-pct-in")) r.pct = e.target.value === "" ? 0 : num(e.target.value);
      refreshTotal();
    });
    list.addEventListener("change", function (e) {
      if (!e.target.classList.contains("al-role")) return;
      var i = Number(e.target.closest(".alloc-row").dataset.i), v = e.target.value;
      rows[i].role = v;
      if (v) rows.forEach(function (r, k) { if (k !== i && r.role === v) r.role = ""; });   // แต่ละบทบาทมีได้ 1 การ์ด
      list.querySelectorAll(".al-role").forEach(function (sel, k) { sel.value = rows[k].role || ""; });
      refreshTotal();
    });
    list.addEventListener("click", function (e) {
      var del = e.target.closest(".al-del"); if (!del) return;
      if (rows.length <= 1) { msg("ต้องเหลืออย่างน้อย 1 การ์ด", "warn"); return; }
      rows.splice(Number(del.closest(".alloc-row").dataset.i), 1);
      renderRows();
    });

    panel.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key !== "Tab") return;
      var f = panel.querySelectorAll("input,select,button:not([disabled])");
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && d.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && d.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }

  function msg(text, cls) {
    var m = $("allocMsg"); if (!m) return;
    m.textContent = text || "";
    m.className = "alloc-msg " + (cls || "");
  }

  function renderRows() {
    var roleOpts = function (cur) {
      return [["", "การ์ดทั่วไป"], ["saving", "เป็น “เงินเก็บ” (เป้าหมาย + กราฟสะสม)"], ["gold", "เป็น “ออมทอง” (เชื่อมพอร์ตทอง)"]]
        .map(function (o) { return '<option value="' + o[0] + '"' + (cur === o[0] ? " selected" : "") + ">" + o[1] + "</option>"; }).join("");
    };
    $("allocRows").innerHTML = rows.map(function (r, i) {
      return '<div class="alloc-row" data-i="' + i + '" style="--ac:' + window.kfpCatRgb(i) + '">' +
        '<i class="al-dot" aria-hidden="true"></i>' +
        '<input class="al-emoji" value="' + esc(r.emoji) + '" maxlength="8" aria-label="อีโมจิการ์ดที่ ' + (i + 1) + '" autocomplete="off">' +
        '<input class="al-name" value="' + esc(r.name) + '" maxlength="24" placeholder="ชื่อการ์ด" aria-label="ชื่อการ์ดที่ ' + (i + 1) + '" autocomplete="off">' +
        '<button type="button" class="al-del" aria-label="ลบการ์ดที่ ' + (i + 1) + '">✕</button>' +
        '<label class="al-pct"><input class="al-pct-in" type="number" inputmode="decimal" step="0.5" min="0" max="100" value="' + esc(r.pct) + '" aria-label="เปอร์เซ็นต์การ์ดที่ ' + (i + 1) + '"><span>%</span></label>' +
        '<select class="al-role" aria-label="บทบาทการ์ดที่ ' + (i + 1) + '">' + roleOpts(r.role || "") + '</select>' +
      '</div>';
    }).join("");
    $("allocAdd").disabled = rows.length >= window.KFP_MAX_CARDS;
    refreshTotal();
  }

  function refreshTotal() {
    var sum = Math.round(rows.reduce(function (a, r) { return a + num(r.pct); }, 0) * 100) / 100;
    var box = $("allocTotal"), diff = Math.round((100 - sum) * 100) / 100;
    var okSum = Math.abs(diff) < 0.005;
    box.classList.toggle("ok", okSum);
    box.classList.toggle("bad", !okSum);
    box.querySelector(".at-bar i").style.width = Math.max(0, Math.min(100, sum)) + "%";
    box.querySelector(".at-text").textContent = okSum
      ? "รวม 100% ✓"
      : "รวม " + sum + "% · " + (diff > 0 ? "ขาดอีก " + diff + "%" : "เกินอยู่ " + (-diff) + "%");
    var v = window.kfpValidateAlloc(rows);
    $("allocSave").disabled = !v.ok;
    if (v.ok) msg("", "");
    else if (!okSum) msg("", "");           // ส่วนต่าง % แสดงในแถบรวมอยู่แล้ว
    else msg(v.error, "warn");               // เช่น ยังไม่ได้ตั้งชื่อ
  }

  function addRow() {
    if (rows.length >= window.KFP_MAX_CARDS) return;
    rows.push({ id: "c" + Date.now().toString(36), emoji: "📌", name: "", pct: 0, role: "" });
    renderRows();
    var inputs = $("allocRows").querySelectorAll(".al-name");
    var last = inputs[inputs.length - 1];
    if (last) { last.focus(); last.scrollIntoView({ block: "center", behavior: "smooth" }); }
  }

  function equalize() {
    var n = rows.length, each = Math.floor(10000 / n) / 100;
    rows.forEach(function (r) { r.pct = each; });
    rows[0].pct = Math.round((100 - each * (n - 1)) * 100) / 100;   // เศษไปที่การ์ดแรก ให้รวมได้ 100 พอดี
    renderRows();
  }

  function resetDefault() {
    if (!window.confirm("โหลดค่าเริ่มต้น (5 การ์ด: เงินเก็บ 45% · ออมทอง 15% · ส่งบ้าน 25% · ใช้ส่วนตัว 10% · เที่ยว 5%) ?\nยังไม่เปลี่ยนจริงจนกว่าจะกด “บันทึก”")) return;
    rows = window.kfpDefaultAlloc();
    renderRows();
    msg("โหลดค่าเริ่มต้นแล้ว · กด “บันทึก” เพื่อใช้งาน", "ok");
  }

  function save() {
    var r = window.kfpSaveAlloc(rows);
    if (!r.ok) { msg(r.error, "warn"); return; }
    close();
    window.kfpOnAllocChanged();
  }

  function open() {
    build();
    lastFocus = d.activeElement;
    rows = window.kfpLoadAlloc().map(function (c) { return { id: c.id, emoji: c.emoji, name: c.name, pct: c.pct, role: c.role }; });
    msg("", "");
    renderRows();
    panel.hidden = false;
    d.documentElement.classList.add("kfp-lock");
    requestAnimationFrame(function () { panel.classList.add("open"); });
    var first = panel.querySelector(".al-name");
    if (first) setTimeout(function () { first.focus({ preventScroll: true }); }, 60);
  }

  function close() {
    if (!panel || panel.hidden) return;
    panel.classList.remove("open");
    d.documentElement.classList.remove("kfp-lock");
    setTimeout(function () { panel.hidden = true; }, 220);
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus({ preventScroll: true }); } catch (_) {} }
  }

  d.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest("#btnManageAlloc")) open();
  });
})();
