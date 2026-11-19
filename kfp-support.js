/* PLANNER · ข้อความ & ติดต่อแอดมิน (member side)
 *  - red unread badge on the "บัญชี" tab (bottom bar + sidebar) — staff replies + new announcements
 *  - chat sheet: member ↔ admin conversation, announcements in the same timeline
 *  - every read/write goes through get_my_support_unread / get_my_support / support_send / support_mark_read
 *  - pictures: shrunk in the browser (≤ 1280 px WebP/JPEG, no EXIF/GPS) → private Storage bucket → support_send_image.
 *    Shown with short-lived signed links (cached per session so the browser cache is reused); hidden once the
 *    conversation is closed or after 30 days. The button only appears when the server says pictures are on.
 *  - all text is rendered with textContent (no HTML from the server is ever interpreted)
 * Open from anywhere: window.kfpSupport.open() · any [data-support-open] element · account.html#support */
(function () {
  "use strict";
  if (window.kfpSupport) return;
  var BADGE_EVERY = 90000, CHAT_EVERY = 8000, MAX = 2000;
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var S = { unread: 0, feed: null, open: false, missing: false, timer: null, chatTimer: null, sending: false, opener: null, cutoffMsg: null, cutoffAnn: null,
            att: null, shrinking: false, pend: {}, seq: 0 };
  var IMG = { BUCKET: "support-images", SIDE: 1280, TARGET: 450 * 1024, HARD: 950 * 1024, TTL: 3600, UKEY: "__ks_img_urls" };
  var ico = function (n, c) { return window.PI ? window.PI(n, c) : ""; };

  function client() { return window.kfpAuth && window.kfpAuth.client && window.kfpAuth.client(); }
  function isMember() {
    return !!(window.kfpStorage && window.kfpStorage.isMember && window.kfpStorage.isMember() && window.kfpAuth && window.kfpAuth.user && window.kfpAuth.user());
  }
  async function rpc(fn, args, soft) {
    var c = client(); if (!c) throw { message: "no_client" };
    var r = await c.rpc(fn, args || {});
    if (r.error) { if (!soft && (r.error.code === "PGRST202" || /Could not find the function/.test(r.error.message || ""))) S.missing = true; throw r.error; }
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
  var ov, panel, body, form, ta, count, sendBtn, attBtn, fileIn, attBox, noteEl, lb;
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
      '<form class="ks-compose" id="ksForm" novalidate>' +
      '<div class="ks-att" id="ksAtt" hidden><span class="ks-att-thumb"><img alt="รูปที่จะส่ง"></span>' +
      '<span class="ks-att-meta"><b>รูปพร้อมส่ง</b><small></small></span>' +
      '<button type="button" class="ks-att-x" aria-label="เอารูปออก">' + ico("close") + "</button></div>" +
      '<p class="ks-note" id="ksNote" role="status" hidden></p>' +
      '<button type="button" class="ks-attach" aria-label="แนบรูปภาพ" hidden>' + ico("image") + "</button>" +
      '<input type="file" class="ks-file" accept="image/*" hidden tabindex="-1" aria-hidden="true">' +
      '<label class="sr-only" for="ksText">ข้อความถึงแอดมิน</label>' +
      '<textarea id="ksText" rows="1" maxlength="' + MAX + '" placeholder="พิมพ์ข้อความถึงแอดมิน…" autocomplete="off"></textarea>' +
      '<button type="submit" class="ks-send" aria-label="ส่งข้อความ" disabled>' + ico("send") + "</button>" +
      '<small class="ks-count" id="ksCount" aria-live="off"></small></form></section>';
    document.body.appendChild(ov);
    panel = ov.querySelector(".ks-panel"); body = ov.querySelector("#ksBody"); form = ov.querySelector("#ksForm");
    ta = ov.querySelector("#ksText"); count = ov.querySelector("#ksCount"); sendBtn = ov.querySelector(".ks-send");
    attBtn = ov.querySelector(".ks-attach"); fileIn = ov.querySelector(".ks-file"); attBox = ov.querySelector("#ksAtt"); noteEl = ov.querySelector("#ksNote");
    attBtn.addEventListener("click", function () { if (!S.shrinking) { fileIn.value = ""; fileIn.click(); } });
    fileIn.addEventListener("change", function () { if (fileIn.files && fileIn.files[0]) attach(fileIn.files[0]); });
    attBox.querySelector(".ks-att-x").addEventListener("click", function () { clearAtt(); syncSend(); ta.focus({ preventScroll: true }); });
    ta.addEventListener("paste", function (e) {
      if (attBtn.hidden || !e.clipboardData) return;
      var f = [].slice.call(e.clipboardData.files || []).filter(function (x) { return /^image\//.test(x.type); })[0];
      if (f) { e.preventDefault(); attach(f); }
    });
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
      var pic = e.target.closest("[data-ks-img]");
      if (pic) { var im = pic.querySelector("img"); if (im && im.src && !pic.classList.contains("ks-img-err")) openLb(im.src); return; }
      var ri = e.target.closest("[data-ks-retry-img]");
      if (ri) { var pp = S.pend[ri.getAttribute("data-ks-retry-img")]; ri.closest(".ks-row").remove(); if (pp) sendImage(pp); return; }
      var retry = e.target.closest("[data-ks-retry]");
      if (retry) { var t = retry.getAttribute("data-ks-retry"); retry.closest(".ks-row").remove(); ta.value = t; syncSend(); send(); return; }
      if (e.target.closest("[data-ks-login]") && window.kfpAuth) { close(); window.kfpAuth.open("login"); }
    });
    document.addEventListener("keydown", function (e) {
      if (!S.open) return;
      if (e.key === "Escape") { e.preventDefault(); if (lb && !lb.hidden) closeLb(); else close(); return; }
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
    sendBtn.disabled = (!n && !S.att) || n > MAX || S.sending || S.shrinking;
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
      var pics = !!(f.images && client() && client().storage);
      attBtn.hidden = !pics; if (!pics) clearAtt();
      ta.placeholder = pics ? "พิมพ์ข้อความ…" : "พิมพ์ข้อความถึงแอดมิน…";
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
        if (it.m.image) { bub.classList.add("ks-has-img"); bub.appendChild(imgNode(it.m)); }
        else if (it.m.image_removed) bub.appendChild(goneNode());
        if (it.m.body) bub.appendChild(el("p", null, it.m.body));
        bub.appendChild(el("time", null, timeFmt(it.at)));
        row.appendChild(bub); frag.appendChild(row);
      }
    });
    if (f.status === "closed" && f.messages.length) frag.appendChild(el("div", "ks-day", "ทีมงานปิดเรื่องนี้แล้ว · พิมพ์ใหม่ได้เสมอ"));
    // pictures still uploading / waiting for a retry stay at the bottom across refreshes
    Object.keys(S.pend).forEach(function (id) { if (S.pend[id].row) frag.appendChild(S.pend[id].row); });
    body.innerHTML = ""; body.appendChild(frag);
    if (first || nearBottom) scrollEnd(first);
    fillImages();
  }
  function scrollEnd(instant) {
    var nw = body.querySelector(".ks-new");
    if (instant && nw) { body.scrollTop = Math.max(0, nw.offsetTop - 60); return; }
    body.scrollTo({ top: body.scrollHeight, behavior: instant || reduce ? "auto" : "smooth" });
  }

  async function send() {
    var text = ta.value.trim();
    if (S.att && !S.sending && !S.shrinking && text.length <= MAX) {
      var p = S.att; S.att = null; p.text = text; p.id = "p" + (++S.seq); S.pend[p.id] = p;
      attBox.hidden = true; ta.value = ""; autosize();
      return sendImage(p);
    }
    if (!text || text.length > MAX || S.sending) return;
    S.sending = true; syncSend();
    var row = el("div", "ks-row ks-me ks-pending"), bub = el("div", "ks-bubble");
    bub.appendChild(el("p", null, text)); bub.appendChild(el("time", null, "กำลังส่ง…"));
    row.appendChild(bub); body.appendChild(row);
    var chips = body.querySelector(".ks-chips"); if (chips) chips.remove();
    ta.value = ""; autosize(); scrollEnd(false); ta.focus({ preventScroll: true });
    try {
      var m = await rpc("support_send", { p_body: text });
      if (!S.feed.messages.some(function (x) { return x.id === m.id; })) S.feed.messages.push(m);
      row.classList.remove("ks-pending"); bub.querySelector("time").textContent = timeFmt(m.created_at);
      S.feed.status = "open";
    } catch (e) {
      row.classList.remove("ks-pending"); row.classList.add("ks-failed");
      var why = /rate_limited/.test((e && e.message) || "") ? "ส่งบ่อยเกินไป รอสักครู่" : "ส่งไม่สำเร็จ";
      var t = bub.querySelector("time"); t.textContent = "";
      var r = el("button", "ks-retry", why + " · แตะเพื่อลองใหม่"); r.type = "button"; r.setAttribute("data-ks-retry", text); t.appendChild(r);
    } finally { S.sending = false; syncSend(); }
  }

  /* ---------------- pictures ---------------- */
  function note(msg) {
    if (!noteEl) return;
    noteEl.textContent = msg || ""; noteEl.hidden = !msg;
    clearTimeout(note.t); if (msg) note.t = setTimeout(function () { noteEl.hidden = true; }, 6000);
  }
  function kb(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = [].map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }
  function decode(file) {
    var viaImg = function () {
      return new Promise(function (ok, no) {
        var u = URL.createObjectURL(file), im = new Image();
        im.onload = function () { ok({ src: im, w: im.naturalWidth, h: im.naturalHeight, done: function () { URL.revokeObjectURL(u); } }); };
        im.onerror = function () { URL.revokeObjectURL(u); no(new Error("decode")); };
        im.src = u;
      });
    };
    if (!window.createImageBitmap) return viaImg();
    return createImageBitmap(file, { imageOrientation: "from-image" })
      .then(function (bm) { return { src: bm, w: bm.width, h: bm.height, done: function () { bm.close && bm.close(); } }; }, viaImg);
  }
  function toBlob(cv, type, q) { return new Promise(function (ok) { cv.toBlob(ok, type, q); }); }
  // Re-drawing on a canvas drops EXIF (GPS location, camera details) and shrinks a 3–5 MB photo to ~100–300 KB.
  async function shrink(file) {
    var d = await decode(file), out = null, side = IMG.SIDE;
    try {
      if (!d.w || !d.h) throw new Error("decode");
      for (var pass = 0; pass < 4; pass++) {
        var k = Math.min(1, side / Math.max(d.w, d.h)), w = Math.max(1, Math.round(d.w * k)), h = Math.max(1, Math.round(d.h * k));
        var cv = document.createElement("canvas"); cv.width = w; cv.height = h;
        var cx = cv.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, w, h); cx.imageSmoothingQuality = "high"; cx.drawImage(d.src, 0, 0, w, h);
        var q = [0.82, 0.74, 0.66, 0.6][pass], b = await toBlob(cv, "image/webp", q);
        if (!b || b.type !== "image/webp") b = await toBlob(cv, "image/jpeg", q);   // older Safari cannot write WebP
        if (!b) throw new Error("encode");
        out = { blob: b, w: w, h: h, type: b.type, ext: b.type === "image/webp" ? "webp" : "jpg", from: file.size };
        if (b.size <= IMG.TARGET) break;
        side = Math.round(side * 0.8);
      }
    } finally { d.done(); }
    if (!out || out.blob.size > IMG.HARD) throw new Error("too_big");
    return out;
  }
  async function attach(file) {
    if (!/^image\//.test(file.type || "") && !/\.(heic|heif|jpe?g|png|webp|gif|bmp)$/i.test(file.name || "")) return note("เลือกได้เฉพาะไฟล์รูปภาพ");
    if (file.size > 40 * 1048576) return note("ไฟล์ใหญ่เกินไป (เกิน 40 MB)");
    var left = S.feed && S.feed.images ? S.feed.images.left_today : 10;
    if (left <= 0) return note("วันนี้ส่งรูปครบ " + ((S.feed.images || {}).per_day || 10) + " รูปแล้ว · พิมพ์เป็นข้อความได้ตามปกติ");
    S.shrinking = true; syncSend(); note("");
    attBox.hidden = false; attBox.classList.add("busy"); attBox.querySelector("b").textContent = "กำลังย่อรูป…"; attBox.querySelector("small").textContent = "";
    try {
      var r = await shrink(file);
      clearAtt(); r.url = URL.createObjectURL(r.blob); S.att = r;
      attBox.hidden = false; attBox.querySelector("img").src = r.url;
      attBox.querySelector("b").textContent = "รูปพร้อมส่ง · " + kb(r.blob.size);
      attBox.querySelector("small").textContent = "ย่อจาก " + kb(r.from) + " · ลบข้อมูลตำแหน่ง (GPS) แล้ว · รูปจะถูกลบเมื่อปิดเรื่อง";
    } catch (e) {
      clearAtt(); note("เปิดรูปนี้ไม่ได้ ลองเลือกรูป JPG/PNG หรือแคปหน้าจอแทน");
    } finally { S.shrinking = false; attBox.classList.remove("busy"); syncSend(); }
    if (S.att) ta.focus({ preventScroll: true });
  }
  function clearAtt() {
    if (S.att && S.att.url && !S.att.id) URL.revokeObjectURL(S.att.url);
    S.att = null;
    if (attBox) { attBox.hidden = true; attBox.querySelector("img").removeAttribute("src"); }
  }

  // signed links: one batch per render, kept for the session so the same URL (→ browser cache) is reused
  var urlCache = (function () { try { return JSON.parse(sessionStorage.getItem(IMG.UKEY) || "{}"); } catch (_) { return {}; } })();
  var localUrl = {};   // pictures sent from this page: shown from memory, never downloaded again
  function cachedUrl(p) { if (localUrl[p]) return localUrl[p]; var e = urlCache[p]; return e && e.exp > Date.now() + 300000 ? e.u : null; }
  async function signAll(paths) {
    var need = paths.filter(function (p, i) { return !cachedUrl(p) && paths.indexOf(p) === i; });
    if (!need.length) return;
    var c = client(); if (!c || !c.storage) return;
    var r = await c.storage.from(IMG.BUCKET).createSignedUrls(need, IMG.TTL);
    var now = Date.now();
    (r && r.data || []).forEach(function (x) { if (x && x.signedUrl && !x.error) urlCache[x.path] = { u: x.signedUrl, exp: now + IMG.TTL * 1000 }; });
    Object.keys(urlCache).forEach(function (k) { if (urlCache[k].exp < now) delete urlCache[k]; });
    try { sessionStorage.setItem(IMG.UKEY, JSON.stringify(urlCache)); } catch (_) {}
  }
  function imgNode(m) {
    var b = el("button", "ks-img"); b.type = "button"; b.setAttribute("data-ks-img", m.image); b.setAttribute("aria-label", "ดูรูปขนาดเต็ม");
    if (m.image_w && m.image_h) b.style.aspectRatio = m.image_w + " / " + m.image_h;
    var im = el("img"); im.alt = "รูปที่แนบ"; im.decoding = "async";
    im.onerror = function () { b.classList.add("ks-img-err"); b.setAttribute("aria-label", "โหลดรูปไม่ได้"); };
    var u = cachedUrl(m.image); if (u) im.src = u;
    b.appendChild(im); return b;
  }
  function goneNode() {
    var g = el("div", "ks-img-gone"); g.innerHTML = ico("image-off");
    var t = el("span"); t.appendChild(el("b", null, "รูปถูกลบแล้ว")); t.appendChild(el("small", null, "ลบอัตโนมัติเมื่อปิดเรื่องหรือครบ 30 วัน"));
    g.appendChild(t); return g;
  }
  async function fillImages() {
    var nodes = [].slice.call(body.querySelectorAll("[data-ks-img]")).filter(function (b) { return !b.querySelector("img").getAttribute("src"); });
    if (!nodes.length) return;
    try { await signAll(nodes.map(function (b) { return b.getAttribute("data-ks-img"); })); } catch (_) {}
    nodes.forEach(function (b) { var u = cachedUrl(b.getAttribute("data-ks-img")); if (u) b.querySelector("img").src = u; else b.classList.add("ks-img-err"); });
  }
  function openLb(src) {
    if (!lb) {
      lb = el("div", "ks-lb"); lb.hidden = true; lb.setAttribute("role", "dialog"); lb.setAttribute("aria-modal", "true"); lb.setAttribute("aria-label", "รูปขนาดเต็ม");
      lb.innerHTML = '<img alt="รูปที่แนบ (ขนาดเต็ม)"><button type="button" class="ks-x ks-lb-x" aria-label="ปิดรูป">' + ico("close") + "</button>";
      lb.addEventListener("click", closeLb); ov.appendChild(lb);
    }
    lb.querySelector("img").src = src; lb.hidden = false;
    requestAnimationFrame(function () { lb.classList.add("on"); });
    lb.querySelector(".ks-lb-x").focus({ preventScroll: true });
  }
  function closeLb() {
    if (!lb || lb.hidden) return;
    lb.classList.remove("on"); setTimeout(function () { lb.hidden = true; }, reduce ? 0 : 200);
    var t = body.querySelector("[data-ks-img]"); if (t) t.focus({ preventScroll: true });
  }
  function uploadError(e) {
    var m = String((e && (e.message || e.error)) || "") + " " + String((e && e.statusCode) || "");
    if (/row-level security|violates|403|Unauthorized/i.test(m)) return "ส่งรูปได้วันละ 10 รูป (หรือพื้นที่รูปเต็มชั่วคราว)";
    if (/maximum allowed size|too large|413/i.test(m)) return "รูปใหญ่เกินไป";
    if (/mime|type/i.test(m)) return "ชนิดไฟล์นี้ส่งไม่ได้";
    if (/rate_limited/.test(m)) return "ส่งบ่อยเกินไป รอสักครู่";
    return "ส่งรูปไม่สำเร็จ";
  }
  async function sendImage(p) {
    S.sending = true; syncSend();
    var row = el("div", "ks-row ks-me ks-pending"), bub = el("div", "ks-bubble ks-has-img");
    var pic = el("button", "ks-img"); pic.type = "button"; pic.setAttribute("aria-label", "ดูรูปขนาดเต็ม"); if (p.w && p.h) pic.style.aspectRatio = p.w + " / " + p.h;
    var im = el("img"); im.alt = "รูปที่กำลังส่ง"; im.src = p.url; pic.appendChild(im); bub.appendChild(pic);
    if (p.text) bub.appendChild(el("p", null, p.text));
    bub.appendChild(el("time", null, "กำลังส่งรูป…"));
    row.appendChild(bub); body.appendChild(row); p.row = row;
    var chips = body.querySelector(".ks-chips"); if (chips) chips.remove();
    scrollEnd(false);
    try {
      var c = client(), u = window.kfpAuth && window.kfpAuth.user && window.kfpAuth.user();
      if (!c || !c.storage || !u) throw { message: "no_client" };
      if (!p.path) p.path = u.id + "/" + uuid() + "." + p.ext;
      if (!p.uploaded) {
        var up = await c.storage.from(IMG.BUCKET).upload(p.path, p.blob, { contentType: p.type, cacheControl: "31536000", upsert: false });
        if (up.error && !/exists|duplicate/i.test(up.error.message || "")) throw up.error;   // "exists" = an earlier try did upload it
        p.uploaded = true;
      }
      var m = await rpc("support_send_image", { p_path: p.path, p_body: p.text || "", p_w: p.w, p_h: p.h }, true);
      localUrl[m.image || p.path] = p.url; delete S.pend[p.id];
      if (!S.feed.messages.some(function (x) { return x.id === m.id; })) S.feed.messages.push(m);
      S.feed.status = "open";
      if (S.feed.images) S.feed.images.left_today = Math.max(0, (S.feed.images.left_today | 0) - 1);
      row.classList.remove("ks-pending"); bub.querySelector("time").textContent = timeFmt(m.created_at);
      pic.setAttribute("data-ks-img", m.image || p.path);
    } catch (e) {
      row.classList.remove("ks-pending"); row.classList.add("ks-failed");
      var t = bub.querySelector("time"); t.textContent = "";
      var r = el("button", "ks-retry", uploadError(e) + " · แตะเพื่อลองใหม่"); r.type = "button"; r.setAttribute("data-ks-retry-img", p.id); t.appendChild(r);
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
