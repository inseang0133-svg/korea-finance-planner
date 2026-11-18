/* PLANNER · ข้อความ & ติดต่อแอดมิน (member side)
 *  - red unread badge on the "บัญชี" tab (bottom bar + sidebar) — staff replies + new announcements
 *  - chat sheet: member ↔ admin conversation, announcements in the same timeline
 *  - every read/write goes through get_my_support_unread / get_my_support / support_send / support_mark_read
 *  - all text is rendered with textContent (no HTML from the server is ever interpreted)
 * Open from anywhere: window.kfpSupport.open() · any [data-support-open] element · account.html#support */
(function () {
  "use strict";
  if (window.kfpSupport) return;
  var BADGE_EVERY = 90000, CHAT_EVERY = 8000, MAX = 2000;
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var S = { unread: 0, feed: null, open: false, missing: false, timer: null, chatTimer: null, sending: false, opener: null, cutoffMsg: null, cutoffAnn: null };
  var ico = function (n, c) { return window.PI ? window.PI(n, c) : ""; };

  function client() { return window.kfpAuth && window.kfpAuth.client && window.kfpAuth.client(); }
  function isMember() {
    return !!(window.kfpStorage && window.kfpStorage.isMember && window.kfpStorage.isMember() && window.kfpAuth && window.kfpAuth.user && window.kfpAuth.user());
  }
  async function rpc(fn, args) {
    var c = client(); if (!c) throw { message: "no_client" };
    var r = await c.rpc(fn, args || {});
    if (r.error) { if (r.error.code === "PGRST202" || /Could not find the function/.test(r.error.message || "")) S.missing = true; throw r.error; }
    return r.data;
  }

  /* ---------------- badge ---------------- */
  function setBadge(n) {
    S.unread = Math.max(0, n | 0);
    var txt = S.unread > 9 ? "9+" : String(S.unread);
    document.querySelectorAll('.pn-item[data-k="account"], .pn-item[data-k="support"]').forEach(function (a) {
      var b = a.querySelector(".pn-badge");
      if (!b) { b = document.createElement("i"); b.className = "pn-badge"; b.setAttribute("aria-hidden", "true"); a.appendChild(b); }
      var was = !b.hidden && b.textContent;
      b.textContent = txt; b.hidden = S.unread === 0;
      if (S.unread && was !== txt) { b.classList.remove("pn-pop"); void b.offsetWidth; b.classList.add("pn-pop"); }
      var label = a.querySelector("span") ? a.querySelector("span").textContent : "";
      if (S.unread) a.setAttribute("aria-label", label + " — ข้อความใหม่ " + S.unread + " รายการ"); else a.removeAttribute("aria-label");
      if (a.getAttribute("data-k") === "account") a.setAttribute("href", S.unread ? "account.html#support" : "account.html");
    });
    var c = document.getElementById("supportCount");
    if (c) { c.textContent = S.unread ? S.unread + " ใหม่" : ""; c.hidden = !S.unread; }
  }
  async function refreshBadge() {
    if (S.missing || !isMember() || document.visibilityState === "hidden") { if (!isMember()) setBadge(0); return; }
    try { setBadge(await rpc("get_my_support_unread")); } catch (_) {}
  }
  function startBadge() {
    clearInterval(S.timer); refreshBadge();
    S.timer = setInterval(refreshBadge, BADGE_EVERY);
  }

  /* ---------------- chat sheet ---------------- */
  var ov, panel, body, form, ta, count, sendBtn;
  function build() {
    if (ov) return;
    ov = document.createElement("div");
    ov.className = "ks-ov"; ov.hidden = true;
    ov.innerHTML =
      '<section class="ks-panel" role="dialog" aria-modal="true" aria-labelledby="ksTitle">' +
      '<header class="ks-head"><span class="ks-ava" aria-hidden="true"><img src="assets/brand/planner-logo-sm.png" alt="" width="360" height="291"></span>' +
      '<div class="ks-who"><h2 id="ksTitle">แอดมิน PLANNER</h2><small id="ksSub">ติชม · แจ้งปัญหา · สอบถาม — ตอบกลับในแอปนี้</small></div>' +
      '<button type="button" class="ks-x" aria-label="ปิดแชท">' + ico("close") + "</button></header>" +
      '<div class="ks-body" id="ksBody" role="log" aria-live="polite" aria-label="ข้อความ" tabindex="0"></div>' +
      '<form class="ks-compose" id="ksForm" novalidate><label class="sr-only" for="ksText">ข้อความถึงแอดมิน</label>' +
      '<textarea id="ksText" rows="1" maxlength="' + MAX + '" placeholder="พิมพ์ข้อความถึงแอดมิน…" autocomplete="off"></textarea>' +
      '<button type="submit" class="ks-send" aria-label="ส่งข้อความ" disabled>' + ico("send") + "</button>" +
      '<small class="ks-count" id="ksCount" aria-live="off"></small></form></section>';
    document.body.appendChild(ov);
    panel = ov.querySelector(".ks-panel"); body = ov.querySelector("#ksBody"); form = ov.querySelector("#ksForm");
    ta = ov.querySelector("#ksText"); count = ov.querySelector("#ksCount"); sendBtn = ov.querySelector(".ks-send");
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    ov.querySelector(".ks-x").addEventListener("click", close);
    ta.addEventListener("input", function () { autosize(); syncSend(); });
    ta.addEventListener("keydown", function (e) {
      // desktop: Enter sends, Shift+Enter = new line · phones: the send button
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(hover:hover) and (pointer:fine)").matches) { e.preventDefault(); send(); }
    });
    form.addEventListener("submit", function (e) { e.preventDefault(); send(); });
    body.addEventListener("click", function (e) {
      var chip = e.target.closest("[data-ks-chip]");
      if (chip) { ta.value = chip.getAttribute("data-ks-chip") + " "; autosize(); syncSend(); ta.focus(); return; }
      var retry = e.target.closest("[data-ks-retry]");
      if (retry) { var t = retry.getAttribute("data-ks-retry"); retry.closest(".ks-row").remove(); ta.value = t; syncSend(); send(); return; }
      if (e.target.closest("[data-ks-login]") && window.kfpAuth) { close(); window.kfpAuth.open("login"); }
    });
    document.addEventListener("keydown", function (e) {
      if (!S.open) return;
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key !== "Tab") return;
      var f = [].slice.call(panel.querySelectorAll("button:not([disabled]),textarea,[tabindex='0'],a[href]")).filter(function (x) { return x.offsetParent !== null; });
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    });
  }
  function autosize() { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 140) + "px"; }
  function syncSend() {
    var n = ta.value.trim().length;
    sendBtn.disabled = !n || n > MAX || S.sending;
    count.textContent = ta.value.length > MAX - 200 ? ta.value.length + "/" + MAX : "";
  }

  async function open(opener) {
    build();
    S.opener = opener || document.activeElement;
    ov.hidden = false; document.documentElement.classList.add("ks-lock");
    requestAnimationFrame(function () { ov.classList.add("on"); });
    S.open = true;
    if (!isMember()) return renderGuest();
    if (S.missing) return renderMissing();
    if (!S.feed) body.innerHTML = '<div class="ks-loading"><span class="ks-dot"></span><span class="ks-dot"></span><span class="ks-dot"></span></div>';
    await load(true);
    setTimeout(function () { if (S.open && matchMedia("(hover:hover)").matches) ta.focus({ preventScroll: true }); }, reduce ? 0 : 280);
    clearInterval(S.chatTimer);
    S.chatTimer = setInterval(function () { if (document.visibilityState === "visible") load(false); }, CHAT_EVERY);
  }
  function close() {
    if (!ov || !S.open) return;
    S.open = false; clearInterval(S.chatTimer);
    ov.classList.remove("on"); document.documentElement.classList.remove("ks-lock");
    setTimeout(function () { if (!S.open) ov.hidden = true; }, reduce ? 0 : 260);
    if (location.hash === "#support") try { history.replaceState(null, "", location.pathname + location.search); } catch (_) {}
    if (S.opener && S.opener.focus) S.opener.focus({ preventScroll: true });
  }
  function renderGuest() {
    form.hidden = true;
    body.innerHTML = '<div class="ks-empty">' + ico("chat", "ks-big") + "<b>เข้าสู่ระบบเพื่อคุยกับแอดมิน</b>" +
      "<p>สมาชิกทุกแพ็กเกจ (รวม Free) ส่งข้อความ ติชม หรือแจ้งปัญหาถึงทีมงานได้ และรับประกาศสำคัญในที่เดียว</p>" +
      '<button type="button" class="ks-btn" data-ks-login>เข้าสู่ระบบ / สมัครฟรี</button></div>';
  }
  function renderMissing() {
    form.hidden = true;
    body.innerHTML = '<div class="ks-empty">' + ico("clock", "ks-big") + "<b>ระบบข้อความกำลังเปิดใช้งาน</b><p>ลองใหม่อีกครั้งภายหลัง</p></div>";
  }

  async function load(first) {
    try {
      var f = await rpc("get_my_support", { p_limit: 150 });
      var sig = function (x) { return x ? x.messages.length + ":" + (x.messages.length ? x.messages[x.messages.length - 1].id : "") + ":" + x.announcements.map(function (a) { return a.id; }).join(",") + ":" + x.status : ""; };
      if (first) { S.cutoffMsg = f.user_read_at; S.cutoffAnn = f.ann_read_at; }
      var changed = sig(f) !== sig(S.feed);
      S.feed = f; form.hidden = false;
      if (first || changed) render(first);
      if (f.unread > 0) { try { await rpc("support_mark_read"); } catch (_) {} }
      setBadge(0);
    } catch (e) {
      if (S.missing) return renderMissing();
      if (first) body.innerHTML = '<div class="ks-empty">' + ico("offline", "ks-big") + "<b>โหลดข้อความไม่สำเร็จ</b><p>ตรวจอินเทอร์เน็ตแล้วเปิดใหม่อีกครั้ง</p></div>";
    }
  }

  var dayFmt = function (d) {
    var t = new Date(); t.setHours(0, 0, 0, 0);
    var x = new Date(d); x.setHours(0, 0, 0, 0);
    var diff = Math.round((t - x) / 86400000);
    if (diff === 0) return "วันนี้"; if (diff === 1) return "เมื่อวาน";
    return new Date(d).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: diff > 300 ? "numeric" : undefined });
  };
  var timeFmt = function (d) { return new Date(d).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function render(first) {
    var f = S.feed, nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 120;
    var items = f.messages.map(function (m) { return { t: "m", at: m.created_at, m: m }; })
      .concat(f.announcements.map(function (a) { return { t: "a", at: a.created_at, a: a }; }))
      .sort(function (x, y) { return x.at < y.at ? -1 : x.at > y.at ? 1 : 0; });
    var frag = document.createDocumentFragment(), lastDay = "", unreadShown = false;
    var hello = el("div", "ks-row ks-them ks-hello");
    hello.innerHTML = '<span class="ks-ava sm" aria-hidden="true"><img src="assets/brand/planner-logo-sm.png" alt=""></span>';
    var hb = el("div", "ks-bubble");
    hb.appendChild(el("p", null, "สวัสดีครับ ยินดีต้อนรับสู่ PLANNER — มีอะไรให้ช่วย พิมพ์ถึงทีมงานได้เลย ติชม แจ้งปัญหา หรือขอฟีเจอร์ใหม่ เราจะตอบกลับในแชทนี้"));
    hello.appendChild(hb); frag.appendChild(hello);
    if (!f.messages.length) {
      var chips = el("div", "ks-chips");
      ["แจ้งปัญหาการใช้งาน:", "สอบถามแพ็กเกจ / การชำระเงิน:", "อยากให้เพิ่มฟีเจอร์:", "ติชมแอป:"].forEach(function (c) {
        var b = el("button", "ks-chip", c.replace(/:$/, "")); b.type = "button"; b.setAttribute("data-ks-chip", c); chips.appendChild(b);
      });
      frag.appendChild(chips);
    }
    items.forEach(function (it) {
      var day = dayFmt(it.at);
      if (day !== lastDay) { lastDay = day; frag.appendChild(el("div", "ks-day", day)); }
      var cutoff = it.t === "m" ? S.cutoffMsg : S.cutoffAnn;
      var isNew = (it.t === "a" || it.m.sender === "admin") && (!cutoff || it.at > cutoff);
      if (isNew && !unreadShown && first) { unreadShown = true; frag.appendChild(el("div", "ks-new", "ข้อความใหม่")); }
      if (it.t === "a") {
        var card = el("article", "ks-ann " + (it.a.kind || "info"));
        var h = el("header"); h.innerHTML = ico("megaphone", "pi-sm"); h.appendChild(el("span", null, "ประกาศจากทีมงาน"));
        card.appendChild(h); card.appendChild(el("b", null, it.a.title)); card.appendChild(el("p", null, it.a.body));
        card.appendChild(el("time", null, timeFmt(it.at))); frag.appendChild(card);
      } else {
        var mine = it.m.sender === "user", row = el("div", "ks-row " + (mine ? "ks-me" : "ks-them"));
        if (!mine) row.innerHTML = '<span class="ks-ava sm" aria-hidden="true"><img src="assets/brand/planner-logo-sm.png" alt=""></span>';
        var bub = el("div", "ks-bubble");
        if (!mine) bub.appendChild(el("small", "ks-from", "แอดมิน"));
        bub.appendChild(el("p", null, it.m.body));
        bub.appendChild(el("time", null, timeFmt(it.at)));
        row.appendChild(bub); frag.appendChild(row);
      }
    });
    if (f.status === "closed" && f.messages.length) frag.appendChild(el("div", "ks-day", "ทีมงานปิดเรื่องนี้แล้ว · พิมพ์ใหม่ได้เสมอ"));
    body.innerHTML = ""; body.appendChild(frag);
    if (first || nearBottom) scrollEnd(first);
  }
  function scrollEnd(instant) {
    var nw = body.querySelector(".ks-new");
    if (instant && nw) { body.scrollTop = Math.max(0, nw.offsetTop - 60); return; }
    body.scrollTo({ top: body.scrollHeight, behavior: instant || reduce ? "auto" : "smooth" });
  }

  async function send() {
    var text = ta.value.trim();
    if (!text || text.length > MAX || S.sending) return;
    S.sending = true; syncSend();
    var row = el("div", "ks-row ks-me ks-pending"), bub = el("div", "ks-bubble");
    bub.appendChild(el("p", null, text)); bub.appendChild(el("time", null, "กำลังส่ง…"));
    row.appendChild(bub); body.appendChild(row);
    var chips = body.querySelector(".ks-chips"); if (chips) chips.remove();
    ta.value = ""; autosize(); scrollEnd(false); ta.focus({ preventScroll: true });
    try {
      var m = await rpc("support_send", { p_body: text });
      S.feed.messages.push(m); row.classList.remove("ks-pending"); bub.querySelector("time").textContent = timeFmt(m.created_at);
      S.feed.status = "open";
    } catch (e) {
      row.classList.remove("ks-pending"); row.classList.add("ks-failed");
      var why = /rate_limited/.test((e && e.message) || "") ? "ส่งบ่อยเกินไป รอสักครู่" : "ส่งไม่สำเร็จ";
      var t = bub.querySelector("time"); t.textContent = "";
      var r = el("button", "ks-retry", why + " · แตะเพื่อลองใหม่"); r.type = "button"; r.setAttribute("data-ks-retry", text); t.appendChild(r);
    } finally { S.sending = false; syncSend(); }
  }

  /* ---------------- wiring ---------------- */
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-support-open], .pn-item[data-k=\"support\"]");
    if (!t) return;
    e.preventDefault(); open(t);
  });
  function maybeHash() { if (location.hash === "#support") open(null); }
  window.addEventListener("hashchange", maybeHash);
  window.addEventListener("kfp:auth-ready", function () { startBadge(); maybeHash(); });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") refreshBadge(); });
  if (window.kfpAuth && window.kfpAuth.user && window.kfpAuth.user()) startBadge();
  // nav is built at the end of the page: paint the badge into it once it exists
  document.addEventListener("DOMContentLoaded", function () { setBadge(S.unread); if (!isMember() && location.hash === "#support") maybeHash(); });

  window.kfpSupport = { open: open, close: close, refresh: refreshBadge, unread: function () { return S.unread; } };
})();
