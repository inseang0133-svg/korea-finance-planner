/* Korea Finance Planner · Admin Console (Phase 10)
 * The page only DISPLAYS. Every number and every change goes through admin_* SQL
 * functions that check the caller's role in the database (and write the audit
 * log), or the admin-actions Edge Function for Stripe. Nothing here is trusted.
 * All user-provided text is rendered with textContent / escaping.
 */
(function () {
  "use strict";
  // Phase 12: never run inside a frame (click-jacking) — GitHub Pages cannot send X-Frame-Options.
  if (window.top !== window.self) { document.documentElement.innerHTML = ""; try { window.top.location = window.location.href; } catch (_) {} return; }
  var cfg = window.KFP_SUPABASE_CONFIG || {};
  var KS = window.kfpStorage;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]; }); };
  var safeUrl = function (u) { return /^https:\/\//i.test(String(u || "")) ? String(u) : null; };
  var ME = { id: null, email: "", role: null, canWrite: false, isOwner: false };
  var PLAN = { free: "Free", plus: "Finance Plus", premium: "Finance Premium" };
  var SUB_ST = { active: ["ok", "ใช้งานอยู่"], trialing: ["info", "ทดลองใช้"], past_due: ["bad", "ค้างชำระ"], unpaid: ["bad", "ค้างชำระ (ระงับ)"],
                 canceled: ["", "สิ้นสุดแล้ว"], incomplete: ["warn", "ไม่สมบูรณ์"], incomplete_expired: ["", "หมดอายุ"], paused: ["warn", "พัก"] };
  var ACT = { active: "Active", recent: "Recent", inactive: "Inactive", dormant: "Dormant", never: "ยังไม่เคยใช้" };
  var PAY_ST = { paid: ["ok", "ชำระแล้ว"], failed: ["bad", "ไม่สำเร็จ"], action_required: ["warn", "รอยืนยัน"], open: ["warn", "รอชำระ"], draft: ["", "ร่าง"],
                 void: ["", "ยกเลิก"], uncollectible: ["bad", "เรียกเก็บไม่ได้"], refunded: ["info", "คืนเงินแล้ว"], partially_refunded: ["info", "คืนบางส่วน"] };
  var ACTION_LABEL = { "plan.grant": "ให้สิทธิ์แพ็กเกจ", "plan.revoke_all": "เปลี่ยนเป็น Free", "plan.extend": "ขยายสิทธิ์", "plan.revoke": "ยกเลิกสิทธิ์ที่ให้",
    "user.suspend": "ระงับบัญชี", "user.reactivate": "เปิดบัญชีคืน", "subscription.cancel": "ยกเลิก subscription (สิ้นรอบ)",
    "subscription.cancel_now": "ยกเลิก subscription ทันที", "price.set": "ตั้งราคา", "price.deactivate": "ปิดราคา", "role.set": "เปลี่ยนบทบาท" };
  var ROLE_LABEL = { owner: "Owner", admin: "Admin", viewer: "Viewer" };

  /* ---------------------------------------------------------- format */
  function money(minor, cur) {
    if (minor == null || !cur) return "—";
    var krw = String(cur).toUpperCase() === "KRW", n = Number(minor) / (krw ? 1 : 100);
    return (krw ? "₩" : "฿") + n.toLocaleString("en-US", { minimumFractionDigits: krw || n % 1 === 0 ? 0 : 2, maximumFractionDigits: krw ? 0 : 2 });
  }
  function toMinor(major, cur) { var n = Number(major); if (!(n > 0)) return null; return String(cur).toUpperCase() === "KRW" ? Math.round(n) : Math.round(n * 100); }
  var nf = function (n) { return Number(n || 0).toLocaleString("en-US"); };
  function d(iso) { return iso ? new Date(iso).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" }) : "—"; }
  function dt(iso) { return iso ? new Date(iso).toLocaleString("th-TH", { day: "numeric", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"; }
  function rel(iso) {
    if (!iso) return "—";
    var s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return "เมื่อสักครู่"; if (s < 3600) return Math.floor(s / 60) + " นาทีที่แล้ว";
    if (s < 86400) return Math.floor(s / 3600) + " ชม.ที่แล้ว"; if (s < 86400 * 60) return Math.floor(s / 86400) + " วันที่แล้ว";
    return d(iso);
  }
  var pill = function (cls, t) { return '<span class="pill ' + esc(cls) + '">' + esc(t) + "</span>"; };
  var planPill = function (p) { return pill(p || "free", PLAN[p] || p || "Free"); };
  function subPill(st, cancelling) {
    if (!st) return '<span class="muted">—</span>';
    if (cancelling && (st === "active" || st === "trialing")) return pill("warn", "ตั้งยกเลิก");
    var x = SUB_ST[st] || ["", st]; return pill(x[0], x[1]);
  }
  var actDot = function (b) { return '<span class="dot b-' + esc(b || "never") + '" aria-hidden="true"></span>' + esc(ACT[b] || "—"); };

  /* ---------------------------------------------------------- server */
  function client() { return window.kfpAuth && window.kfpAuth.client && window.kfpAuth.client(); }
  async function rpc(fn, args) {
    var c = client(); if (!c) throw { message: "no client" };
    var r = await c.rpc(fn, args || {});
    if (r.error) throw r.error;
    return r.data;
  }
  async function callFn(name, body) {
    var c = client(), sess = c ? (await c.auth.getSession()).data.session : null;
    if (!sess) return { status: 401, body: { error: "unauthorized" } };
    try {
      var res = await fetch(cfg.SUPABASE_URL + "/functions/v1/" + name, { method: "POST",
        headers: { "Content-Type": "application/json", apikey: cfg.SUPABASE_ANON_KEY, Authorization: "Bearer " + sess.access_token }, body: JSON.stringify(body || {}) });
      var j = {}; try { j = await res.json(); } catch (_) {}
      return { status: res.status, body: j || {} };
    } catch (_) { return { status: 0, body: { error: "network" } }; }
  }
  var ERR = {
    forbidden: "ไม่มีสิทธิ์ทำรายการนี้", cannot_act_on_self: "ทำรายการกับบัญชีของตัวเองไม่ได้", only_owner_can_change_admins: "เฉพาะ Owner เท่านั้นที่จัดการบัญชีผู้ดูแลได้", cannot_change_owner: "เปลี่ยนบทบาทของ Owner ไม่ได้", invalid_role: "บทบาทไม่ถูกต้อง",
    reason_required: "กรุณาใส่เหตุผลอย่างน้อย 3 ตัวอักษร", invalid_expiry: "วันหมดอายุต้องเป็นวันในอนาคต", invalid_days: "จำนวนวันต้องอยู่ระหว่าง 1–3650",
    nothing_to_extend: "สมาชิกนี้ไม่มีสิทธิ์ที่จะขยาย (เป็น Free)", no_expiry: "สิทธิ์ปัจจุบันไม่มีวันหมดอายุ", no_subscription: "ไม่มี subscription ที่ใช้งานอยู่",
    user_not_found: "ไม่พบสมาชิก", rate_limited: "ทำรายการบ่อยเกินไป รอสักครู่", customer_mismatch: "ข้อมูล Stripe ไม่ตรงกัน ตรวจสอบใน Stripe Dashboard",
    network: "เชื่อมต่อไม่ได้", unauthorized: "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่"
  };
  function errText(e) {
    var m = String((e && (e.message || e.error)) || e || "");
    for (var k in ERR) if (m.indexOf(k) >= 0) return ERR[k];
    if (/reason required/.test(m)) return ERR.reason_required;
    return "ทำรายการไม่สำเร็จ (" + m.slice(0, 120) + ")";
  }
  function toast(msg, kind) {
    var t = document.createElement("div"); t.className = "toast " + (kind || "ok"); t.setAttribute("role", "status"); t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 4200);
  }
  function busy(btn, on) { if (!btn) return; btn.disabled = on; btn.classList.toggle("busy", on); }

  /* ---------------------------------------------------------- gate */
  function gate(icon, title, text, actions) {
    $("app").hidden = true; $("gate").hidden = false;
    $("gate").querySelector(".ico").textContent = icon;
    $("gateTitle").textContent = title; $("gateText").textContent = text;
    $("gateActions").innerHTML = actions || "";
  }
  async function boot() {
    if (started) return;
    if (!cfg.SUPABASE_URL || !window.supabase) return gate("⚙️", "ยังไม่ได้ตั้งค่าระบบสมาชิก", "ตั้งค่า supabase-config.js ก่อน");
    if (KS && KS.isPreview && KS.isPreview()) {
      return gate("🔐", "สำหรับผู้ดูแลระบบเท่านั้น", "กรุณาเข้าสู่ระบบด้วยบัญชีผู้ดูแล",
        '<button class="btn gold" type="button" id="gateLogin">เข้าสู่ระบบ</button>');
    }
    var u = window.kfpAuth && window.kfpAuth.user && window.kfpAuth.user();
    if (!u) return;                                                     // wait for kfp:auth-ready
    started = true;
    try {
      var w = await rpc("admin_whoami");
      ME = { id: u.id, email: u.email, role: w.role, canWrite: !!w.can_write, isOwner: !!w.is_owner };
    } catch (e) {
      var missing = e && (e.code === "PGRST202" || /admin_whoami/.test(e.message || ""));
      if (missing) return gate("🧩", "ยังไม่ได้ติดตั้ง Admin", "ผู้ดูแลต้องรัน migration 20261114000900_admin_dashboard.sql ก่อน");
      if (e && (e.code === "42501" || /forbidden/.test(e.message || "")))
        return gate("⛔", "ไม่มีสิทธิ์เข้าหน้านี้", "บัญชีนี้ไม่ใช่ผู้ดูแลระบบ", '<a class="btn" href="index.html">กลับหน้าหลัก</a>');
      return gate("⚠️", "โหลดไม่สำเร็จ", "ตรวจอินเทอร์เน็ตแล้วลองใหม่", '<button class="btn" type="button" id="gateRetry">ลองใหม่</button>');
    }
    $("gate").hidden = true; $("app").hidden = false;
    $("whoEmail").textContent = ME.email || "";
    $("whoRole").textContent = ME.role; $("whoRole").className = "kfa-role " + ME.role;
    route();
  }
  var started = false;
  document.addEventListener("click", function (e) {
    if (e.target.id === "gateLogin" && window.kfpAuth) window.kfpAuth.open("login");
    if (e.target.id === "gateRetry") { started = false; boot(); }
  });
  window.addEventListener("kfp:auth-ready", function () { boot(); });

  /* ---------------------------------------------------------- tabs */
  var TABS = ["overview", "users", "activity", "revenue", "prices", "audit"], loaded = {};
  function route() {
    var t = (location.hash || "#overview").slice(1).split("/")[0];
    if (TABS.indexOf(t) < 0) t = "overview";
    TABS.forEach(function (x) {
      var on = x === t;
      $("tab-" + x).setAttribute("aria-selected", on ? "true" : "false");
      $("tab-" + x).tabIndex = on ? 0 : -1;
      $("view-" + x).hidden = !on;
    });
    if (!loaded[t]) { loaded[t] = true; ({ overview: loadOverview, users: loadUsers, activity: loadActivity, revenue: loadRevenue, prices: loadPrices, audit: loadAudit })[t](); }
  }
  document.querySelector(".kfa-tabs").addEventListener("click", function (e) {
    var b = e.target.closest("[data-tab]"); if (!b) return;
    history.replaceState(null, "", "#" + b.dataset.tab); route();
  });
  document.querySelector(".kfa-tabs").addEventListener("keydown", function (e) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    var i = TABS.indexOf((location.hash || "#overview").slice(1)); if (i < 0) i = 0;
    var n = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    history.replaceState(null, "", "#" + n); route(); $("tab-" + n).focus();
  });
  window.addEventListener("hashchange", function () { if (ME.role) route(); });
  document.addEventListener("click", function (e) {
    var r = e.target.closest("[data-reload]"); if (r) ({ overview: loadOverview })[r.dataset.reload]();
  });

  /* ---------------------------------------------------------- overview */
  function kpi(label, value, sub, cls, id) {
    return '<div class="kpi ' + (cls || "") + '"' + (id ? ' id="' + id + '"' : "") + '><dt>' + esc(label) + '</dt><dd>' + value + (sub ? "<small>" + sub + "</small>" : "") + "</dd></div>";
  }
  function perCur(obj, key) {
    var keys = Object.keys(obj || {}).sort();
    if (!keys.length) return "—";
    return keys.map(function (c) { return '<span class="cur"><span>' + money(obj[c][key], c) + '</span><i>' + esc(c) + "</i></span>"; }).join("");
  }
  async function loadOverview() {
    var box = $("ovBody");
    try {
      var o = await rpc("admin_overview", { p_tz: "Asia/Seoul" });
      var u = o.users || {}, p = o.plans || {}, s = o.subscriptions || {}, a = o.activity || {}, ch = o.churn_30d || {};
      var tot = Number(u.total) || 0, buckets = ["active", "recent", "inactive", "dormant", "never"];
      var colors = { active: "var(--green)", recent: "var(--blue)", inactive: "var(--amber)", dormant: "var(--red)", never: "#55555e" };
      box.innerHTML =
        '<div class="kfa-sec"><h3>สมาชิก</h3><dl class="kpis">' +
          kpi("สมาชิกทั้งหมด", nf(u.total), nf(u.unverified) + " ยังไม่ยืนยันอีเมล", "gold", "kTotal") +
          kpi("สมัครใหม่วันนี้", nf(u.new_today), "", "", "kToday") + kpi("สมัครใหม่เดือนนี้", nf(u.new_month), "", "", "kMonth") +
          kpi("Free", nf(p.free), "", "", "kFree") + kpi("Plus", nf(p.plus), "", "", "kPlus") + kpi("Premium", nf(p.premium), "", "gold", "kPremium") +
          kpi("ได้สิทธิ์จากการให้ (ไม่ได้จ่าย)", nf(p.via_grant), "รวมสิทธิ์สมาชิกเดิม 90 วัน", "", "kGrant") +
          kpi("ถูกระงับ", nf(u.suspended), "", Number(u.suspended) ? "warn" : "", "kSusp") + "</dl></div>" +
        '<div class="kfa-sec"><h3>Subscription</h3><dl class="kpis">' +
          kpi("ใช้งานอยู่ (จ่ายเงิน)", nf(s.active), "", "good", "kActive") + kpi("ทดลองใช้", nf(s.trialing)) +
          kpi("ตั้งยกเลิก (รอสิ้นรอบ)", nf(s.cancelling), "", Number(s.cancelling) ? "warn" : "", "kCancelling") +
          kpi("ค้างชำระ", nf(s.past_due), "", Number(s.past_due) ? "bad" : "", "kPastDue") + kpi("หมดอายุ / สิ้นสุด", nf(s.expired), "", "", "kExpired") +
          kpi("Churn 30 วัน", (Number(ch.rate_pct) || 0).toFixed(1) + "%", nf(ch.churned) + " จาก " + nf(ch.base) + " subscription", Number(ch.rate_pct) > 10 ? "bad" : "", "kChurn") + "</dl></div>" +
        '<div class="kfa-sec"><h3>รายได้ (แยกสกุลเงิน)</h3><dl class="kpis">' +
          kpi("MRR", perCur(o.mrr, "mrr_minor"), "", "gold", "kMrr") + kpi("ARR", perCur(o.mrr, "arr_minor"), "", "", "kArr") +
          kpi("รายได้สุทธิทั้งหมด", perCur(o.revenue, "net_minor"), "หักคืนเงินแล้ว", "", "kRev") +
          kpi("ARPU (ต่อสมาชิกที่จ่าย/เดือน)", perCur(o.mrr, "arpu_minor"), "", "", "kArpu") +
          kpi("จ่ายเงินไม่สำเร็จ 30 วัน", nf(o.failed_payments_30d), "", Number(o.failed_payments_30d) ? "bad" : "", "kFailed") +
          kpi("Webhook ที่ล้มเหลว", nf(o.webhooks_failed), Number(o.webhooks_failed) ? "ตรวจ stripe_webhook_events" : "ปกติ", Number(o.webhooks_failed) ? "bad" : "good", "kHook") + "</dl></div>" +
        '<div class="kfa-sec"><h3>การใช้งาน</h3><div class="kpi" id="kActivity"><div class="actbar" role="img" aria-label="สัดส่วนสมาชิกตามการใช้งาน">' +
          buckets.map(function (b) { return '<span style="width:' + (tot ? (100 * (Number(a[b]) || 0) / tot) : 0) + '%;background:' + colors[b] + '"></span>'; }).join("") +
          '</div><div class="legend">' + buckets.map(function (b) { return "<span>" + actDot(b) + " <b>" + nf(a[b]) + "</b></span>"; }).join("") +
          '</div><p class="count" style="margin:8px 0 0">Active ≤ 24 ชม. · Recent ≤ 7 วัน · Inactive 8–30 วัน · Dormant &gt; 30 วัน</p></div></div>';
      $("ovTime").textContent = "อัปเดต " + dt(o.generated_at) + " (เวลาเกาหลี)";
    } catch (e) { box.innerHTML = '<p class="note">' + esc(errText(e)) + "</p>"; }
  }

  /* ---------------------------------------------------------- users */
  var UQ = { page: 1, page_size: 25, sort: "created_at", dir: "desc" }, utimer = null, ulast = null;
  function filters() {
    var f = $("userFilters"), q = {};
    ["q", "plan", "sub_status", "activity", "country", "suspended", "sort"].forEach(function (k) { var v = f.elements[k].value.trim(); if (v) q[k] = v; });
    q.dir = $("fDir").dataset.dir; q.page = UQ.page; q.page_size = Number($("pgSize").value);
    return q;
  }
  async function loadUsers() {
    var q = filters(), seq = (ulast = {});
    $("userRows").setAttribute("aria-busy", "true");
    try {
      var r = await rpc("admin_list_users", { p: q });
      if (seq !== ulast) return;                                       // a newer search is running
      var pages = Math.max(1, Math.ceil(r.total / r.page_size));
      $("userCount").textContent = nf(r.total) + " บัญชี" + (q.q ? " ที่ตรงกับ “" + q.q + "”" : "");
      $("pgInfo").textContent = "หน้า " + r.page + " / " + pages;
      $("pgPrev").disabled = r.page <= 1; $("pgNext").disabled = r.page >= pages;
      $("userRows").innerHTML = r.rows.length ? r.rows.map(function (x) {
        return '<tr class="click" tabindex="0" data-user="' + esc(x.user_id) + '">' +
          '<td class="u" data-l="สมาชิก"><b>' + esc(x.email || "(ไม่มีอีเมล)") + "</b><span>@" + esc(x.username || "—") + " · " + esc(String(x.user_id).slice(0, 8)) + "</span> " +
            (x.suspended ? pill("bad", "ระงับ") : "") + (x.is_admin ? pill("info", "admin") : "") + (x.verified ? "" : pill("warn", "ยังไม่ยืนยัน")) + "</td>" +
          '<td data-l="ประเทศ">' + esc(x.country || "—") + "</td>" +
          '<td data-l="แพ็กเกจ"><span>' + planPill(x.plan) + (x.plan !== "free" && x.plan_source && x.plan_source.indexOf("subscription") !== 0 ? ' <span class="muted">(ให้สิทธิ์)</span>' : "") + "</span></td>" +
          '<td data-l="สถานะ">' + subPill(x.sub_status, x.cancel_at_period_end) + "</td>" +
          '<td data-l="สมัครเมื่อ" class="num">' + d(x.registered_at) + "</td>" +
          '<td data-l="เริ่ม subscription" class="num">' + d(x.sub_started_at) + "</td>" +
          '<td data-l="หมดอายุ" class="num">' + d(x.expires_at) + "</td>" +
          '<td data-l="เข้าสู่ระบบล่าสุด" class="num">' + rel(x.last_login_at) + "</td>" +
          '<td data-l="ใช้งานล่าสุด"><span>' + actDot(x.activity) + '<br><span class="muted num">' + rel(x.last_active_at) + (x.last_page ? " · " + esc(x.last_page) : "") + "</span></span></td>" +
          '<td data-l="ไม่ได้ใช้ (วัน)" class="r num">' + (x.days_since_active == null ? "—" : nf(x.days_since_active)) + "</td></tr>";
      }).join("") : '<tr><td colspan="10" class="empty">ไม่พบสมาชิกที่ตรงเงื่อนไข</td></tr>';
    } catch (e) {
      $("userRows").innerHTML = '<tr><td colspan="10" class="empty">' + esc(errText(e)) + "</td></tr>";
    }
    $("userRows").removeAttribute("aria-busy");
  }
  function reloadUsers(resetPage) { if (resetPage) UQ.page = 1; clearTimeout(utimer); utimer = setTimeout(loadUsers, 300); }
  $("userFilters").addEventListener("input", function (e) { reloadUsers(true); });
  $("userFilters").addEventListener("submit", function (e) { e.preventDefault(); reloadUsers(true); });
  $("fDir").addEventListener("click", function () {
    var b = $("fDir"), asc = b.dataset.dir === "desc";
    b.dataset.dir = asc ? "asc" : "desc"; b.textContent = asc ? "↑ เก่า → ใหม่" : "↓ ใหม่ → เก่า"; reloadUsers(true);
  });
  $("pgPrev").addEventListener("click", function () { if (UQ.page > 1) { UQ.page--; loadUsers(); } });
  $("pgNext").addEventListener("click", function () { UQ.page++; loadUsers(); });
  $("pgSize").addEventListener("change", function () { reloadUsers(true); });
  $("userRows").addEventListener("click", function (e) { var tr = e.target.closest("[data-user]"); if (tr) openUser(tr.dataset.user); });
  $("userRows").addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var tr = e.target.closest("[data-user]"); if (tr) { e.preventDefault(); openUser(tr.dataset.user); }
  });

  /* ---------------------------------------------------------- user detail */
  var CUR = null;
  function kv(pairs) { return '<dl class="kv">' + pairs.map(function (p) { return "<div><dt>" + esc(p[0]) + "</dt><dd>" + p[1] + "</dd></div>"; }).join("") + "</dl>"; }
  function canActOn(det) {
    if (!ME.canWrite) return "บทบาท viewer ดูได้อย่างเดียว";
    if (det.user.user_id === ME.id) return "ทำรายการกับบัญชีของตัวเองไม่ได้";
    if (det.user.admin_role && !ME.isOwner) return "เฉพาะ Owner เท่านั้นที่จัดการบัญชีผู้ดูแลได้";
    return "";
  }
  async function openUser(uid) {
    var dlg = $("drawer");
    $("drTitle").textContent = "กำลังโหลด…"; $("drIds").textContent = ""; $("drBody").innerHTML = '<div class="sk"></div>';
    if (!dlg.open) dlg.showModal();
    try {
      var both = await Promise.all([rpc("admin_user_detail", { p_user: uid }), rpc("admin_user_activity", { p_user: uid, p_days: 30 }).catch(function () { return null; })]);
      CUR = both[0]; CUR.daily = both[1]; renderUser();
    }
    catch (e) { $("drTitle").textContent = "โหลดไม่สำเร็จ"; $("drBody").innerHTML = '<p class="note">' + esc(errText(e)) + "</p>"; }
  }
  function renderUser() {
    var x = CUR, u = x.user, ef = x.effective || {}, live = (x.subscriptions || []).filter(function (s) { return ["active", "trialing", "past_due", "unpaid"].indexOf(s.status) >= 0; })[0];
    $("drTitle").textContent = u.email || "(ไม่มีอีเมล)";
    $("drIds").innerHTML = '<span class="mono">' + esc(u.user_id) + '</span><button class="copy" type="button" data-copy="' + esc(u.user_id) + '" aria-label="คัดลอก User ID">⧉</button>' +
      planPill(ef.plan_id) + (u.suspended_at ? pill("bad", "ถูกระงับ") : "") + (u.admin_role ? '<span class="pill role-' + esc(u.admin_role) + '">' + esc(ROLE_LABEL[u.admin_role] || u.admin_role) + "</span>" : "") +
      (u.verified_at ? "" : pill("warn", "ยังไม่ยืนยันอีเมล")) + (u.legacy_email ? pill("warn", "Username เดิม") : "");
    var why = canActOn(x), hasGrant = (x.entitlements || []).some(function (g) { return g.active; });
    var acts = why ? '<p class="note" id="actLocked">🔒 ' + esc(why) + "</p>" :
      '<div class="acts" id="userActs">' +
        '<button class="btn sm" type="button" data-act="set_plan">เปลี่ยนแพ็กเกจ</button>' +
        '<button class="btn sm gold" type="button" data-act="grant_premium">ให้ Premium</button>' +
        '<button class="btn sm" type="button" data-act="extend"' + (ef.plan_id === "free" || !ef.valid_until ? " disabled" : "") + ">ขยายสิทธิ์</button>" +
        '<button class="btn sm danger" type="button" data-act="revoke"' + (hasGrant ? "" : " disabled") + ">ยกเลิกสิทธิ์ที่ให้</button>" +
        (u.suspended_at ? '<button class="btn sm" type="button" data-act="reactivate">เปิดบัญชีคืน</button>' : '<button class="btn sm danger" type="button" data-act="suspend">ระงับบัญชี</button>') +
        (live ? '<button class="btn sm danger" type="button" data-act="cancel_sub">ยกเลิก subscription</button>' : "") +
        (ME.isOwner && u.admin_role !== "owner" ? '<button class="btn sm role" type="button" data-act="set_role">🛡️ บทบาท: ' + esc(ROLE_LABEL[u.admin_role] || "สมาชิก") + "</button>" : "") + "</div>" +
      '<p class="count" style="margin-top:8px">ทุกการกระทำต้องยืนยันและใส่เหตุผล · บันทึกใน Audit log</p>';
    var subs = (x.subscriptions || []).map(function (s) {
      return "<tr><td data-l=\"Subscription\" class=\"mono\">" + esc(s.provider_subscription_id || s.id) + "</td><td data-l=\"แพ็กเกจ\">" + planPill(s.plan_id) +
        "</td><td data-l=\"สถานะ\">" + subPill(s.status, s.cancel_at_period_end) + "</td><td data-l=\"ราคา\" class=\"num\">" + money(s.unit_amount_minor, s.currency) + " / " + (s.billing_interval === "year" ? "ปี" : "เดือน") +
        "</td><td data-l=\"รอบปัจจุบัน\" class=\"num\">" + d(s.current_period_start) + " – " + d(s.current_period_end) + "</td><td data-l=\"เริ่ม\" class=\"num\">" + d(s.started_at) + "</td></tr>";
    }).join("");
    var pays = (x.payments || []).map(function (p) {
      var st = PAY_ST[p.status] || ["", p.status], inv = safeUrl(p.hosted_invoice_url), pdf = safeUrl(p.invoice_pdf_url);
      return '<tr><td data-l="วันที่" class="num">' + d(p.paid_at || p.created_at) + '</td><td data-l="ใบแจ้งหนี้" class="mono">' + esc(p.provider_invoice_id || "—") +
        '</td><td data-l="ยอด" class="num r">' + money(p.status === "paid" || p.status.indexOf("refund") >= 0 ? p.amount_paid_minor : p.amount_due_minor, p.currency) +
        (p.amount_refunded_minor > 0 ? '<br><span class="muted">คืน ' + money(p.amount_refunded_minor, p.currency) + "</span>" : "") +
        '</td><td data-l="สถานะ">' + pill(st[0], st[1]) + (p.failure_reason ? '<br><span class="muted">' + esc(p.failure_reason) + "</span>" : "") +
        '</td><td data-l="ลิงก์">' + (inv ? '<a href="' + esc(inv) + '" target="_blank" rel="noopener noreferrer">ใบแจ้งหนี้</a> ' : "") + (pdf ? '<a href="' + esc(pdf) + '" target="_blank" rel="noopener noreferrer">PDF</a>' : "") + "</td></tr>";
    }).join("");
    var ents = (x.entitlements || []).map(function (g) {
      return '<tr><td data-l="แพ็กเกจ">' + planPill(g.plan_id) + '</td><td data-l="ที่มา">' + esc(g.reason === "legacy_launch" ? "สมาชิกเดิม 90 วัน" : g.reason === "admin_grant" ? "ผู้ดูแลให้" : g.reason === "staff" ? "ทีมงาน · ไม่จำกัด" : g.reason) +
        (g.granted_by ? '<br><span class="muted">' + esc(g.granted_by) + "</span>" : "") + '</td><td data-l="ช่วง" class="num">' + d(g.starts_at) + " – " + (g.expires_at ? d(g.expires_at) : "ไม่มีกำหนด") +
        '</td><td data-l="สถานะ">' + (g.revoked_at ? pill("", "ยกเลิก " + d(g.revoked_at)) : g.active ? pill("ok", "ใช้งาน") : pill("", "หมดอายุ")) +
        '</td><td data-l="หมายเหตุ" class="muted">' + esc(g.note || "") + "</td></tr>";
    }).join("");
    var act = (x.activity || []).map(function (a) { return '<tr><td data-l="เวลา" class="num">' + dt(a.at) + '</td><td data-l="ประเภท">' + esc(a.kind) + '</td><td data-l="หน้า">' + esc(a.page || "—") + "</td></tr>"; }).join("");
    var aud = (x.audit || []).map(function (a) { return '<tr><td data-l="เวลา" class="num">' + dt(a.at) + '</td><td data-l="การกระทำ">' + esc(ACTION_LABEL[a.action] || a.action) + '</td><td data-l="ผู้ดูแล">' + esc(a.admin || "—") + '</td><td data-l="เหตุผล">' + esc(a.reason) + "</td></tr>"; }).join("");
    var tbl = function (head, rows, empty, id) { return '<div class="tbl-wrap"' + (id ? ' id="' + id + '"' : "") + '><table class="tbl cards"><thead><tr>' + head.map(function (h) { return '<th scope="col">' + esc(h) + "</th>"; }).join("") + "</tr></thead><tbody>" + (rows || '<tr><td colspan="' + head.length + '" class="empty">' + esc(empty) + "</td></tr>") + "</tbody></table></div>"; };
    $("drBody").innerHTML =
      '<div class="dr-sec"><h3>การจัดการ</h3>' + acts + "</div>" +
      '<div class="dr-sec"><h3>ข้อมูลบัญชี</h3>' + kv([
        ["ชื่อผู้ใช้", "@" + esc(u.username || "—")], ["ชื่อที่แสดง", esc(u.nickname || "—")], ["ประเทศ", esc(u.country || "—")],
        ["สมัครเมื่อ", dt(u.registered_at)], ["ยืนยันอีเมล", u.verified_at ? dt(u.verified_at) : "ยังไม่ยืนยัน"],
        ["เข้าสู่ระบบล่าสุด", dt(u.last_login_at)], ["ใช้งานล่าสุด", actDot(u.activity) + " · " + rel(u.last_active_at)], ["หน้าล่าสุด", esc(u.last_page || "—")],
        ["ถูกระงับ", u.suspended_at ? dt(u.suspended_at) : "ไม่"], ["พอร์ตทองบน Cloud", x.gold_lots == null ? "—" : nf(x.gold_lots) + " รอบ"]]) + "</div>" +
      '<div class="dr-sec"><h3>สิทธิ์ปัจจุบัน (Entitlement)</h3>' + kv([
        ["แพ็กเกจที่ใช้ได้", planPill(ef.plan_id)], ["มาจาก", esc(ef.source === "default" ? "—" : ef.source === "suspended" ? "ถูกระงับ" : ef.source === "staff" ? "ทีมงาน (ไม่จำกัด)" : ef.source || "—")],
        ["ใช้ได้ถึง", ef.valid_until ? dt(ef.valid_until) : (ef.plan_id === "free" ? "—" : "ไม่มีกำหนด")],
        ["Stripe Customer", x.customer ? '<span class="mono">' + esc(x.customer.customer_id) + "</span>" : "—"]]) + "</div>" +
      '<div class="dr-sec"><h3>Subscription</h3>' + tbl(["Subscription ID", "แพ็กเกจ", "สถานะ", "ราคา", "รอบปัจจุบัน", "เริ่ม"], subs, "ไม่เคยสมัครแบบชำระเงิน", "drSubs") + "</div>" +
      '<div class="dr-sec"><h3>ประวัติการชำระเงิน / ใบแจ้งหนี้ (' + nf(x.payments_total) + ")</h3>" + tbl(["วันที่", "ใบแจ้งหนี้", "ยอด", "สถานะ", "ลิงก์"], pays, "ยังไม่มี", "drPays") + "</div>" +
      '<div class="dr-sec"><h3>สิทธิ์ที่ได้รับ (Grants)</h3>' + tbl(["แพ็กเกจ", "ที่มา", "ช่วง", "สถานะ", "หมายเหตุ"], ents, "ไม่มี", "drEnts") + "</div>" +
      stripHtml(x.daily) +
      '<div class="dr-sec"><h3>การใช้งานล่าสุด</h3>' + tbl(["เวลา", "ประเภท", "หน้า"], act, "ยังไม่มีบันทึก", "drAct") + "</div>" +
      '<div class="dr-sec"><h3>Audit log ของสมาชิกนี้</h3>' + tbl(["เวลา", "การกระทำ", "ผู้ดูแล", "เหตุผล"], aud, "ยังไม่มี", "drAudit") + "</div>";
  }
  $("drClose").addEventListener("click", function () { $("drawer").close(); });
  $("drawer").addEventListener("click", function (e) {
    if (e.target === $("drawer")) { $("drawer").close(); return; }
    var c = e.target.closest("[data-copy]");
    if (c) { try { navigator.clipboard.writeText(c.dataset.copy); toast("คัดลอก User ID แล้ว"); } catch (_) {} return; }
    var a = e.target.closest("[data-act]"); if (a && !a.disabled) askAction(a.dataset.act, a);
  });

  /* ---------------------------------------------------------- actions (confirm + reason) */
  function plus(days) { var t = new Date(Date.now() + days * 86400000); return t.toISOString().slice(0, 10); }
  var SPEC = {
    set_plan: { title: "เปลี่ยนแพ็กเกจ", text: "ให้สิทธิ์แพ็กเกจแบบไม่ผ่าน Stripe (สูงกว่า subscription ที่จ่ายอยู่จึงจะมีผล) · เลือก Free = ยกเลิกสิทธิ์ที่ให้ทั้งหมด (subscription ที่จ่ายเงินไม่ถูกยกเลิก)",
      fields: '<label for="cfPlan">แพ็กเกจ</label><select class="sel" id="cfPlan"><option value="premium">Finance Premium</option><option value="plus">Finance Plus</option><option value="free">Free (ยกเลิกสิทธิ์ที่ให้)</option></select>' +
              '<label for="cfUntil">ใช้ได้ถึง (เว้นว่าง = ไม่มีกำหนด)</label><input class="inp" type="date" id="cfUntil">',
      danger: function () { return $("cfPlan").value === "free"; } },
    grant_premium: { title: "ให้ Finance Premium", text: "ให้สิทธิ์ Premium โดยไม่เรียกเก็บเงิน",
      fields: '<label for="cfDays">ระยะเวลา</label><select class="sel" id="cfDays"><option value="30">30 วัน</option><option value="90">90 วัน</option><option value="365">1 ปี</option><option value="">ไม่มีกำหนด</option></select>' },
    extend: { title: "ขยายสิทธิ์", text: "เพิ่มวันใช้งานต่อจากวันหมดอายุปัจจุบัน · ไม่เปลี่ยนรอบบิลของ Stripe",
      fields: '<label for="cfExt">จำนวนวัน</label><input class="inp" type="number" id="cfExt" min="1" max="3650" value="7" inputmode="numeric">' },
    revoke: { title: "ยกเลิกสิทธิ์ที่ให้", text: "ยกเลิกสิทธิ์ที่ผู้ดูแลให้และสิทธิ์สมาชิกเดิม 90 วัน · subscription ที่จ่ายเงินไม่ถูกยกเลิก", danger: true },
    suspend: { title: "ระงับบัญชี", text: "สมาชิกจะกลับเป็น Free ทันที ใช้ Cloud Sync และพอร์ตทองไม่ได้ · ข้อมูลไม่ถูกลบ · ไม่ยกเลิก subscription (ใช้ปุ่มยกเลิก subscription แยก)", danger: true },
    reactivate: { title: "เปิดบัญชีคืน", text: "สมาชิกจะกลับไปใช้สิทธิ์ตาม subscription / สิทธิ์ที่มีอยู่" },
    set_role: { title: "เปลี่ยนบทบาท", text: "Admin = จัดการสมาชิก/ราคาได้ · Viewer = เปิดหน้า Admin ได้แต่ดูอย่างเดียว · ทั้งสองบทบาทได้ Finance Premium แบบไม่จำกัดเวลา · เลือก “สมาชิกทั่วไป” = ถอดบทบาทและสิทธิ์ทีมงาน (สิทธิ์อื่น / subscription ที่จ่ายเงินยังอยู่) · เฉพาะ Owner",
      fields: '<label for="cfRole">บทบาท</label><select class="sel" id="cfRole"><option value="viewer">Viewer · ดูอย่างเดียว + Premium ไม่จำกัด</option><option value="admin">Admin · จัดการได้ + Premium ไม่จำกัด</option><option value="none">สมาชิกทั่วไป (ถอดบทบาท)</option></select>',
      danger: function () { return $("cfRole").value === "admin"; } },
    cancel_sub: { title: "ยกเลิก subscription", text: "ยกเลิกใน Stripe จริง",
      fields: '<label for="cfMode">วิธียกเลิก</label><select class="sel" id="cfMode"><option value="period_end">เมื่อสิ้นรอบบิล (ใช้ได้จนถึงวันนั้น)</option><option value="now">ทันที (หมดสิทธิ์ตอนนี้ ไม่คืนเงินอัตโนมัติ)</option></select>',
      danger: true }
  };
  var pending = null;
  function askAction(kind, btn) {
    var sp = SPEC[kind], u = CUR.user; if (!sp) return;
    pending = { kind: kind, btn: btn };
    $("cfTitle").textContent = sp.title + " · " + (u.email || u.user_id);
    $("cfText").textContent = sp.text;
    $("cfFields").innerHTML = sp.fields || "";
    if (kind === "set_plan") $("cfUntil").min = plus(1);
    if (kind === "set_role") $("cfRole").value = u.admin_role === "admin" || u.admin_role === "viewer" ? (u.admin_role === "admin" ? "viewer" : "admin") : "viewer";
    $("cfReason").value = ""; $("cfErr").textContent = ""; $("cfType").value = "";
    syncDanger();
    $("cf").showModal();
    $("cfReason").focus();
  }
  function isDanger() { var sp = SPEC[pending.kind]; return typeof sp.danger === "function" ? sp.danger() : !!sp.danger; }
  function syncDanger() {
    var dz = isDanger(), want = CUR.user.email || CUR.user.user_id;
    $("cf").classList.toggle("danger", dz);
    $("cfOk").className = "btn " + (dz ? "danger" : "gold");
    $("cfTypeBox").hidden = !dz; $("cfTypeWant").textContent = want;
  }
  $("cfFields").addEventListener("change", function () { if (pending && SPEC[pending.kind]) syncDanger(); });
  $("cfCancel").addEventListener("click", function () { $("cf").close(); });
  $("cfForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    if (!pending) return;
    var u = CUR.user, reason = $("cfReason").value.trim();
    if (reason.length < 3) { $("cfErr").textContent = ERR.reason_required; $("cfReason").focus(); return; }
    if (isDanger() && $("cfType").value.trim().toLowerCase() !== String(u.email || u.user_id).toLowerCase()) {
      $("cfErr").textContent = "พิมพ์อีเมลให้ตรงเพื่อยืนยัน"; $("cfType").focus(); return;
    }
    busy($("cfOk"), true);
    try {
      var k = pending.kind, ok;
      if (k === "set_plan") {
        var until = $("cfUntil").value ? new Date($("cfUntil").value + "T23:59:59").toISOString() : null;
        await rpc("admin_set_plan", { p_user: u.user_id, p_plan: $("cfPlan").value, p_expires_at: $("cfPlan").value === "free" ? null : until, p_reason: reason });
        ok = "เปลี่ยนแพ็กเกจแล้ว";
      } else if (k === "grant_premium") {
        var days = $("cfDays").value;
        await rpc("admin_set_plan", { p_user: u.user_id, p_plan: "premium", p_expires_at: days ? new Date(Date.now() + Number(days) * 86400000).toISOString() : null, p_reason: reason });
        ok = "ให้ Premium แล้ว";
      } else if (k === "extend") {
        await rpc("admin_extend_access", { p_user: u.user_id, p_days: Number($("cfExt").value), p_reason: reason }); ok = "ขยายสิทธิ์แล้ว";
      } else if (k === "revoke") {
        await rpc("admin_revoke_access", { p_user: u.user_id, p_reason: reason }); ok = "ยกเลิกสิทธิ์ที่ให้แล้ว";
      } else if (k === "suspend" || k === "reactivate") {
        await rpc("admin_set_suspended", { p_user: u.user_id, p_suspended: k === "suspend", p_reason: reason }); ok = k === "suspend" ? "ระงับบัญชีแล้ว" : "เปิดบัญชีคืนแล้ว";
      } else if (k === "set_role") {
        var role = $("cfRole").value;
        await rpc("admin_set_role", { p_user: u.user_id, p_role: role, p_reason: reason });
        ok = role === "none" ? "ถอดบทบาทแล้ว" : "ตั้งเป็น " + ROLE_LABEL[role] + " แล้ว · Premium ไม่จำกัด";
      } else if (k === "cancel_sub") {
        var r = await callFn("admin-actions", { action: "cancel_subscription", user_id: u.user_id, mode: $("cfMode").value, reason: reason });
        if (r.status !== 200) throw { message: r.status === 404 && !r.body.error ? "ยังไม่ได้ deploy admin-actions" : (r.body.error || r.status) };
        ok = $("cfMode").value === "now" ? "ยกเลิก subscription ทันทีแล้ว" : "ตั้งยกเลิกเมื่อสิ้นรอบแล้ว";
      }
      $("cf").close();
      toast(ok, "ok");
      await openUser(u.user_id);
      loaded.overview = false; loaded.audit = false;
      if (loaded.users) loadUsers();
    } catch (err) {
      $("cfErr").textContent = errText(err);
    }
    busy($("cfOk"), false);
  });

  /* ---------------------------------------------------------- activity (Phase 11) */
  var FEATURE_LABEL = { work_records: "บันทึกการเข้างาน", expenses: "รายจ่าย", export: "Export Excel", cloud_sync: "Cloud Sync",
                        gold_portfolio: "พอร์ตทอง", tools: "เครื่องมืออื่น" };
  var BUCKET_LABEL = { active: "Active · ≤ 24 ชม.", recent: "Recent · ≤ 7 วัน", inactive: "Inactive · 8–30 วัน", dormant: "Dormant · > 30 วัน", never: "ยังไม่เคยใช้งาน" };
  var WEEKDAY = ["จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส.", "อา."];
  // simple accessible SVG bar chart (values ≥ 0); every n-th label shown
  function barsSvg(values, labels, opt) {
    opt = opt || {};
    var W = 640, H = opt.h || 160, pad = 22, n = values.length, max = Math.max.apply(null, values.concat([1]));
    var bw = (W - pad) / n, every = Math.max(1, Math.ceil(n / (opt.ticks || 10)));
    var bars = values.map(function (v, i) {
      var h = Math.round((H - pad - 6) * v / max), x = pad + i * bw;
      return '<rect class="' + (opt.cls || "b") + '" x="' + (x + bw * 0.12).toFixed(1) + '" y="' + (H - pad - h) + '" width="' + Math.max(1, bw * 0.76).toFixed(1) + '" height="' + h + '" rx="2"><title>' + esc(labels[i]) + ": " + nf(v) + "</title></rect>" +
        (i % every === 0 || i === n - 1 ? '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(labels[i]) + "</text>" : "");
    }).join("");
    return '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(opt.label || "") + " สูงสุด " + nf(max) + '">' +
      '<defs><linearGradient id="gGold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe08a"/><stop offset="1" stop-color="#c9962b"/></linearGradient></defs>' +
      '<line x1="' + pad + '" x2="' + W + '" y1="' + (H - pad) + '" y2="' + (H - pad) + '"/><text x="0" y="12">' + nf(max) + "</text>" + bars + "</svg>";
  }
  function shortDay(iso) { var d0 = new Date(iso + "T00:00:00"); return d0.getDate() + "/" + (d0.getMonth() + 1); }
  async function loadActivity(refresh) {
    var box = $("acBody");
    if (refresh === true) busy($("acRefresh"), true);
    try {
      var a = await rpc("admin_activity_analytics", { p: { days: Number($("acDays").value), refresh: refresh === true } });
      var k = a.kpi || {}, b = a.buckets || {}, tot = 0;
      Object.keys(b).forEach(function (x) { tot += Number(b[x]) || 0; });
      var bp = {};
      (a.buckets_by_plan || []).forEach(function (r) { (bp[r.plan] = bp[r.plan] || {})[r.bucket] = r.users; });
      var stick = k.mau ? (100 * (Number(k.avg_dau_30) || 0) / k.mau) : 0;
      var series = a.series || [];
      var pages = (a.pages || []), maxP = Math.max.apply(null, pages.map(function (p) { return p.views; }).concat([1]));
      var feats = (a.features || []);
      box.innerHTML =
        '<div class="kfa-sec"><dl class="kpis">' +
          kpi("DAU (วันนี้)", nf(k.dau), "", "gold", "aDau") + kpi("WAU (7 วัน)", nf(k.wau), "", "", "aWau") + kpi("MAU (30 วัน)", nf(k.mau), "", "", "aMau") +
          kpi("Stickiness", stick.toFixed(1) + "%", "DAU เฉลี่ย 30 วัน ÷ MAU", stick >= 20 ? "good" : "", "aStick") +
          kpi("ใช้งานในช่วงที่เลือก", nf(k.active_in_range), nf(a.days) + " วัน", "", "aRange") +
          kpi("สมัครใหม่ในช่วงที่เลือก", nf(k.signups_in_range), "", "", "aSign") + "</dl></div>" +
        '<div class="kfa-sec"><h3>สถานะการใช้งานของสมาชิก (แตะเพื่อดูรายชื่อ)</h3><div class="kpis" id="aBuckets">' +
          ["active", "recent", "inactive", "dormant", "never"].map(function (x) {
            return '<button type="button" class="kpi bucket" data-bucket="' + x + '"><span class="lbl"><span class="dot b-' + x + '" aria-hidden="true"></span>' + esc(BUCKET_LABEL[x]) + '</span><span class="val num">' + nf(b[x]) +
              "</span><small>" + (tot ? (100 * (Number(b[x]) || 0) / tot).toFixed(1) : "0") + "% ของสมาชิก</small></button>";
          }).join("") + "</div></div>" +
        '<div class="kfa-sec"><h3>แยกตามแพ็กเกจ</h3><div class="tbl-wrap" id="aByPlan"><table class="tbl cards"><thead><tr><th scope="col">แพ็กเกจ</th>' +
          ["active", "recent", "inactive", "dormant", "never"].map(function (x) { return '<th scope="col" class="r">' + esc(x[0].toUpperCase() + x.slice(1)) + "</th>"; }).join("") + "</tr></thead><tbody>" +
          ["free", "plus", "premium"].map(function (p) {
            var row = bp[p] || {};
            return "<tr><td data-l=\"แพ็กเกจ\">" + planPill(p) + "</td>" + ["active", "recent", "inactive", "dormant", "never"].map(function (x) {
              return '<td data-l="' + x + '" class="r num">' + nf(row[x]) + "</td>"; }).join("") + "</tr>";
          }).join("") + "</tbody></table></div></div>" +
        '<div class="kfa-sec two">' +
          '<div class="chart-card" id="aDauChart"><h3>ผู้ใช้งานรายวัน (DAU) <small>' + esc(shortDay(a.from)) + " – " + esc(shortDay(a.to)) + "</small></h3>" +
            barsSvg(series.map(function (r) { return Number(r.dau) || 0; }), series.map(function (r) { return shortDay(r.day); }), { label: "ผู้ใช้งานรายวัน" }) + "</div>" +
          '<div class="chart-card" id="aSignChart"><h3>สมัครใหม่รายวัน</h3>' +
            barsSvg(series.map(function (r) { return Number(r.signups) || 0; }), series.map(function (r) { return shortDay(r.day); }), { label: "สมัครใหม่รายวัน", cls: "b2" }) + "</div></div>" +
        '<div class="kfa-sec two">' +
          '<div class="chart-card"><h3>ฟีเจอร์ที่ใช้ <small>% ของผู้ใช้งานในช่วงนี้</small></h3><div class="tbl-wrap" id="aFeatures"><table class="tbl cards"><thead><tr><th scope="col">ฟีเจอร์</th><th scope="col" class="r">ผู้ใช้</th><th scope="col">สัดส่วน</th><th scope="col" class="r">ครั้ง</th></tr></thead><tbody>' +
            (feats.map(function (f) {
              return '<tr><td data-l="ฟีเจอร์">' + esc(FEATURE_LABEL[f.feature] || f.feature) + '</td><td data-l="ผู้ใช้" class="r num">' + nf(f.users) +
                '</td><td data-l="สัดส่วน"><span class="meter" title="' + esc(f.adoption_pct) + '%"><i style="width:' + Math.min(100, Number(f.adoption_pct) || 0) + '%"></i></span> <span class="num">' + esc(f.adoption_pct) + '%</span></td><td data-l="ครั้ง" class="r num">' + nf(f.uses) + "</td></tr>";
            }).join("") || '<tr><td colspan="4" class="empty">ยังไม่มีข้อมูล</td></tr>') + "</tbody></table></div></div>" +
          '<div class="chart-card"><h3>หน้าที่เปิดบ่อย</h3><div class="tbl-wrap" id="aPages"><table class="tbl cards"><thead><tr><th scope="col">หน้า</th><th scope="col">ครั้ง</th><th scope="col" class="r">ผู้ใช้</th></tr></thead><tbody>' +
            (pages.map(function (p) {
              return '<tr><td data-l="หน้า" class="mono">' + esc(p.page) + '</td><td data-l="ครั้ง"><span class="meter"><i style="width:' + (100 * p.views / maxP) + '%"></i></span> <span class="num">' + nf(p.views) +
                '</span></td><td data-l="ผู้ใช้" class="r num">' + nf(p.users) + "</td></tr>";
            }).join("") || '<tr><td colspan="3" class="empty">ยังไม่มีข้อมูล</td></tr>') + "</tbody></table></div></div></div>" +
        '<div class="kfa-sec two">' +
          '<div class="chart-card" id="aHours"><h3>ช่วงเวลาที่ใช้งาน <small>เวลาเกาหลี</small></h3>' +
            barsSvg((a.hours || []).map(Number), Array.from({ length: 24 }, function (_, i) { return String(i); }), { label: "จำนวนการใช้งานตามชั่วโมง", ticks: 8, h: 140 }) + "</div>" +
          '<div class="chart-card" id="aWeek"><h3>วันในสัปดาห์</h3>' + barsSvg((a.weekdays || []).map(Number), WEEKDAY, { label: "ผู้ใช้งานตามวันในสัปดาห์", ticks: 7, h: 140 }) + "</div></div>" +
        '<div class="kfa-sec"><h3>Retention ตามสัปดาห์ที่สมัคร <small class="muted">% ที่กลับมาใช้ในสัปดาห์ที่ 1–4</small></h3><div class="tbl-wrap" id="aRet"><table class="tbl cards ret"><thead><tr><th scope="col">สัปดาห์ที่สมัคร</th><th scope="col" class="r">สมาชิก</th><th scope="col">สัปดาห์ 1</th><th scope="col">สัปดาห์ 2</th><th scope="col">สัปดาห์ 3</th><th scope="col">สัปดาห์ 4</th></tr></thead><tbody>' +
          ((a.retention || []).map(function (r) {
            return '<tr><td data-l="สัปดาห์" class="num">' + d(r.week) + '</td><td data-l="สมาชิก" class="r num">' + nf(r.size) + "</td>" + ["w1", "w2", "w3", "w4"].map(function (w, i) {
              var v = r[w];
              return '<td data-l="สัปดาห์ ' + (i + 1) + '" class="c"' + (v == null ? "" : ' style="background:rgba(61,220,151,' + (0.08 + Number(v) / 160).toFixed(2) + ')"') + ">" + (v == null ? '<span class="muted">—</span>' : esc(v) + "%") + "</td>";
            }).join("") + "</tr>";
          }).join("") || '<tr><td colspan="6" class="empty">ยังไม่มีสมาชิกใหม่ใน 8 สัปดาห์</td></tr>') + "</tbody></table></div></div>" +
        '<div class="kfa-sec"><h3>สมาชิกที่จ่ายเงินแต่ไม่ได้ใช้งาน &gt; 14 วัน (เสี่ยงยกเลิก) · ' + nf(a.at_risk_total) + ' คน</h3><div class="tbl-wrap" id="aRisk"><table class="tbl cards"><thead><tr><th scope="col">สมาชิก</th><th scope="col">แพ็กเกจ</th><th scope="col" class="r">MRR</th><th scope="col">ใช้งานล่าสุด</th><th scope="col" class="r">วัน</th></tr></thead><tbody>' +
          ((a.at_risk || []).map(function (r) {
            return '<tr class="click" tabindex="0" data-open-user="' + esc(r.user_id) + '"><td data-l="สมาชิก" class="u"><b>' + esc(r.email || r.user_id) + '</b></td><td data-l="แพ็กเกจ">' + planPill(r.plan) +
              '</td><td data-l="MRR" class="r num">' + money(r.mrr_minor, r.currency) + '</td><td data-l="ใช้งานล่าสุด" class="num">' + (r.last_active_at ? d(r.last_active_at) : "ไม่เคย") +
              '</td><td data-l="วัน" class="r num">' + (r.days_inactive == null ? "—" : nf(r.days_inactive)) + "</td></tr>";
          }).join("") || '<tr><td colspan="5" class="empty">ไม่มี 🎉</td></tr>') + "</tbody></table></div></div>" +
        '<p class="count">เก็บเฉพาะชื่อหน้า/ฟีเจอร์และเวลา (ไม่เก็บเนื้อหา, IP หรือการพิมพ์) · บันทึกเมื่อเปิดหน้าและทุก 5 นาทีที่ใช้งาน · ฟีเจอร์นับครั้งละไม่เกิน 1 ครั้ง/30 นาที</p>';
      $("acTime").textContent = (a.cached ? "ข้อมูลเมื่อ " : "คำนวณเมื่อ ") + dt(a.computed_at || a.generated_at) + (a.cached ? " (แคช 10 นาที)" : "");
    } catch (e) { box.innerHTML = '<p class="note">' + esc(errText(e)) + "</p>"; }
    busy($("acRefresh"), false);
  }
  $("acDays").addEventListener("change", function () { loadActivity(false); });
  $("acRefresh").addEventListener("click", function () { loadActivity(true); });
  $("acBody").addEventListener("click", function (e) {
    var b = e.target.closest("[data-bucket]"); if (!b) return;
    $("fAct").value = b.dataset.bucket; UQ.page = 1;
    history.replaceState(null, "", "#users"); route(); loadUsers();
  });
  $("acBody").addEventListener("keydown", function (e) {
    var tr = e.target.closest && e.target.closest("tr[data-open-user]");
    if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openUser(tr.dataset.openUser); }
  });
  function stripHtml(dd) {
    if (!dd || !dd.daily) return "";
    var max = Math.max.apply(null, dd.daily.map(function (x) { return x.events; }).concat([1]));
    var pages = Object.keys(dd.pages || {}).slice(0, 5).map(function (k) { return esc(k) + " (" + nf(dd.pages[k]) + ")"; }).join(" · ");
    var feats = Object.keys(dd.features || {}).map(function (k) { return esc(FEATURE_LABEL[k] || k); }).join(" · ");
    return '<div class="dr-sec" id="drStrip"><h3>การใช้งาน 30 วัน · ใช้งาน ' + nf(dd.active_days) + " จาก " + nf(dd.daily.length) + " วัน</h3>" +
      '<div class="strip" role="img" aria-label="ใช้งาน ' + nf(dd.active_days) + ' วันใน 30 วัน">' + dd.daily.slice(-30).map(function (x) {
        var lv = x.events ? Math.min(4, 1 + Math.floor(3 * x.events / max)) : 0;
        return '<span data-l="' + lv + '" title="' + esc(x.day) + ": " + nf(x.events) + ' ครั้ง"></span>';
      }).join("") + "</div>" +
      '<p class="count" style="margin:0">หน้าที่ใช้: ' + (pages || "—") + "<br>ฟีเจอร์: " + (feats || "—") + "</p></div>";
  }

  /* ---------------------------------------------------------- revenue */
  async function loadRevenue() {
    var box = $("revBody");
    try {
      var r = await rpc("admin_revenue", { p: { months: Number($("revMonths").value), tz: "Asia/Seoul" } });
      var curs = Object.keys(r.by_currency || {}).sort();
      var cards = curs.map(function (c) {
        var x = r.by_currency[c];
        return '<div class="cur-card" id="rev' + esc(c) + '"><h3>' + (c === "KRW" ? "₩" : "฿") + " " + esc(c) + "</h3><dl>" +
          "<dt>MRR</dt><dd class=\"big\">" + money(x.mrr_minor, c) + "</dd><dt>ARR</dt><dd>" + money(x.arr_minor, c) + "</dd>" +
          "<dt>สมาชิกที่จ่ายอยู่</dt><dd>" + nf(x.payers) + "</dd><dt>ARPU / เดือน</dt><dd>" + (x.payers ? money(Math.round(x.mrr_minor / x.payers), c) : "—") + "</dd>" +
          "<dt>Gross ทั้งหมด</dt><dd>" + money(x.gross_minor, c) + "</dd><dt>คืนเงิน</dt><dd>−" + money(x.refunded_minor, c) + "</dd>" +
          "<dt>Net ทั้งหมด</dt><dd>" + money(x.net_minor, c) + "</dd><dt>Net ช่วงที่เลือก</dt><dd>" + money(x.period_net_minor, c) + "</dd></dl></div>";
      }).join("") || '<p class="note">ยังไม่มีรายได้</p>';
      var monthly = curs.map(function (c) {
        var rows = (r.monthly || []).filter(function (m) { return m.currency === c; });
        var max = Math.max.apply(null, rows.map(function (m) { return Number(m.net_minor) || 0; }).concat([1]));
        return '<div class="cur-card"><h3>รายเดือน · ' + esc(c) + '</h3><div class="bars">' + (rows.map(function (m) {
          return '<div class="bar ' + (c === "KRW" ? "krw" : "") + '"><span class="num">' + esc(m.month) + '</span><i style="width:' + (100 * Math.max(0, m.net_minor) / max) + '%"></i><span>' + money(m.net_minor, c) + "</span></div>";
        }).join("") || '<p class="count">ไม่มีรายการในช่วงนี้</p>') + "</div></div>";
      }).join("");
      var byPlan = (r.by_plan || []).map(function (p) {
        return '<tr><td data-l="แพ็กเกจ">' + planPill(p.plan_id) + '</td><td data-l="สกุลเงิน">' + esc(p.currency) + '</td><td data-l="สมาชิกที่จ่าย" class="r num">' + nf(p.subscribers) +
          '</td><td data-l="MRR" class="r num">' + money(p.mrr_minor, p.currency) + '</td><td data-l="Gross" class="r num">' + money(p.gross_minor, p.currency) + '</td><td data-l="Net" class="r num">' + money(p.net_minor, p.currency) + "</td></tr>";
      }).join("");
      var failed = (r.failed.latest || []).map(function (f) {
        var u = safeUrl(f.hosted_invoice_url);
        return '<tr><td data-l="วันที่" class="num">' + dt(f.created_at) + '</td><td data-l="สมาชิก">' + (f.user_id ? '<a href="#users" data-open-user="' + esc(f.user_id) + '">' + esc(f.email || f.user_id) + "</a>" : "—") +
          '</td><td data-l="ยอด" class="r num">' + money(f.amount_due_minor, f.currency) + '</td><td data-l="เหตุผล">' + esc(f.failure_reason || (PAY_ST[f.status] || [0, f.status])[1]) + '</td><td data-l="">' + (u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">ใบแจ้งหนี้</a>' : "") + "</td></tr>";
      }).join("");
      var refunds = (r.refunds.latest || []).map(function (f) {
        return '<tr><td data-l="วันที่" class="num">' + dt(f.created_at) + '</td><td data-l="สมาชิก">' + esc(f.email || "—") + '</td><td data-l="ยอด" class="r num">' + money(f.amount_minor, f.currency) +
          '</td><td data-l="เหตุผล">' + esc(f.reason || "—") + '</td><td data-l="ใบแจ้งหนี้" class="mono">' + esc(f.invoice || "") + "</td></tr>";
      }).join("");
      var t = function (h, rows, empty, id) { return '<div class="tbl-wrap" id="' + id + '"><table class="tbl cards"><thead><tr>' + h.map(function (x) { return '<th scope="col">' + esc(x) + "</th>"; }).join("") + "</tr></thead><tbody>" + (rows || '<tr><td colspan="' + h.length + '" class="empty">' + esc(empty) + "</td></tr>") + "</tbody></table></div>"; };
      box.innerHTML = '<div class="kfa-sec"><div class="cur-grid">' + cards + "</div></div>" +
        '<div class="kfa-sec"><h3>Net รายเดือน (หักคืนเงิน)</h3><div class="cur-grid">' + monthly + "</div></div>" +
        '<div class="kfa-sec"><h3>รายได้ตามแพ็กเกจ</h3>' + t(["แพ็กเกจ", "สกุลเงิน", "สมาชิกที่จ่าย", "MRR", "Gross", "Net"], byPlan, "ยังไม่มี", "revPlans") + "</div>" +
        '<div class="kfa-sec"><h3>จ่ายเงินไม่สำเร็จ (30 วัน: ' + nf(r.failed.count_30d) + ")</h3>" + t(["วันที่", "สมาชิก", "ยอด", "เหตุผล", ""], failed, "ไม่มี", "revFailed") + "</div>" +
        '<div class="kfa-sec"><h3>คืนเงิน (' + nf(r.refunds.count) + ")</h3>" + t(["วันที่", "สมาชิก", "ยอด", "เหตุผล", "ใบแจ้งหนี้"], refunds, "ไม่มี", "revRefunds") + "</div>";
    } catch (e) { box.innerHTML = '<p class="note">' + esc(errText(e)) + "</p>"; }
  }
  $("revMonths").addEventListener("change", loadRevenue);
  document.addEventListener("click", function (e) {
    var a = e.target.closest("[data-open-user]"); if (a) { e.preventDefault(); openUser(a.dataset.openUser); }
  });

  /* ---------------------------------------------------------- prices */
  var PRICES = [];
  async function loadPrices() {
    var box = $("priceBody");
    try {
      PRICES = await rpc("admin_list_prices") || [];
      var slots = [];
      ["plus", "premium"].forEach(function (p) { ["month", "year"].forEach(function (iv) { ["THB", "KRW"].forEach(function (c) { slots.push([p, iv, c]); }); }); });
      var rows = slots.map(function (s) {
        var act = PRICES.filter(function (x) { return x.active && x.plan_id === s[0] && x.billing_interval === s[1] && x.currency === s[2]; })[0];
        return '<tr><td data-l="แพ็กเกจ">' + planPill(s[0]) + '</td><td data-l="รอบบิล">' + (s[1] === "year" ? "รายปี" : "รายเดือน") + '</td><td data-l="สกุลเงิน">' + esc(s[2]) +
          '</td><td data-l="ราคา" class="r num">' + (act ? "<b>" + money(act.amount_minor, s[2]) + "</b>" : pill("warn", "ยังไม่เปิดขาย")) +
          '</td><td data-l="Stripe" class="mono">' + esc(act && act.provider_price_id || (act ? "สร้างเมื่อมีคนสมัครครั้งแรก" : "")) +
          '</td><td data-l="">' + (ME.canWrite ? '<button class="btn sm" type="button" data-price="' + s.join(":") + '">' + (act ? "แก้ราคา" : "ตั้งราคา") + "</button>" +
            (act ? ' <button class="btn sm danger" type="button" data-price-off="' + esc(act.id) + '">ปิดขาย</button>' : "") : "") + "</td></tr>";
      }).join("");
      var hist = PRICES.filter(function (x) { return !x.active; }).map(function (x) {
        return '<tr><td data-l="แพ็กเกจ">' + planPill(x.plan_id) + '</td><td data-l="รอบ">' + esc(x.billing_interval) + '</td><td data-l="ราคา" class="r num">' + money(x.amount_minor, x.currency) +
          '</td><td data-l="ใช้ช่วง" class="num">' + d(x.created_at) + " – " + d(x.deactivated_at) + "</td></tr>";
      }).join("");
      box.innerHTML = '<div class="tbl-wrap" id="priceTable"><table class="tbl cards"><thead><tr><th scope="col">แพ็กเกจ</th><th scope="col">รอบบิล</th><th scope="col">สกุลเงิน</th><th scope="col" class="r">ราคา</th><th scope="col">Stripe Price</th><th scope="col"></th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
        '<details class="kfa-sec" style="margin-top:14px"><summary>ประวัติราคาเดิม (' + PRICES.filter(function (x) { return !x.active; }).length + ")</summary>" +
        '<div class="tbl-wrap"><table class="tbl cards"><tbody>' + (hist || '<tr><td class="empty">ไม่มี</td></tr>') + "</tbody></table></div></details>";
    } catch (e) { box.innerHTML = '<p class="note">' + esc(errText(e)) + "</p>"; }
  }
  $("priceBody").addEventListener("click", function (e) {
    var b = e.target.closest("[data-price]"), off = e.target.closest("[data-price-off]");
    if (b) {
      var s = b.dataset.price.split(":"), cur = PRICES.filter(function (x) { return x.active && x.plan_id === s[0] && x.billing_interval === s[1] && x.currency === s[2]; })[0];
      pending = { kind: "price", spec: s };
      $("cfTitle").textContent = "ราคา " + PLAN[s[0]] + " · " + (s[1] === "year" ? "รายปี" : "รายเดือน") + " · " + s[2];
      $("cfText").textContent = "ราคาใหม่ใช้กับการสมัครครั้งต่อไป · ลูกค้าเดิมจ่ายราคาเดิม (ต้องแจ้งล่วงหน้าหากจะย้ายลูกค้าเดิมไปราคาใหม่)";
      $("cfFields").innerHTML = '<label for="cfAmt">ราคา (' + (s[2] === "KRW" ? "วอน" : "บาท") + ')</label><input class="inp" type="number" id="cfAmt" min="1" step="' + (s[2] === "KRW" ? "1" : "0.01") + '" inputmode="decimal" value="' + (cur ? Number(cur.amount_minor) / (s[2] === "KRW" ? 1 : 100) : "") + '">';
      $("cfReason").value = ""; $("cfErr").textContent = ""; $("cfTypeBox").hidden = true; $("cf").classList.remove("danger"); $("cfOk").className = "btn gold";
      $("cf").showModal(); $("cfAmt").focus();
    } else if (off) {
      pending = { kind: "price_off", id: off.dataset.priceOff };
      $("cfTitle").textContent = "ปิดขายราคานี้"; $("cfText").textContent = "ผู้ใช้ใหม่จะสมัครรอบบิล/สกุลเงินนี้ไม่ได้ · ลูกค้าเดิมไม่กระทบ";
      $("cfFields").innerHTML = ""; $("cfReason").value = ""; $("cfErr").textContent = ""; $("cfTypeBox").hidden = true; $("cfOk").className = "btn danger";
      $("cf").showModal(); $("cfReason").focus();
    }
  });
  // price confirmations share the dialog; handled before the user-action handler
  $("cfForm").addEventListener("submit", async function (e) {
    if (!pending || (pending.kind !== "price" && pending.kind !== "price_off")) return;
    e.stopImmediatePropagation(); e.preventDefault();
    var reason = $("cfReason").value.trim();
    if (reason.length < 3) { $("cfErr").textContent = ERR.reason_required; return; }
    busy($("cfOk"), true);
    try {
      if (pending.kind === "price") {
        var s = pending.spec, minor = toMinor($("cfAmt").value, s[2]);
        if (!minor) { $("cfErr").textContent = "ใส่ราคาที่มากกว่า 0"; busy($("cfOk"), false); return; }
        await rpc("admin_set_price", { p_plan: s[0], p_interval: s[1], p_currency: s[2], p_amount_minor: minor, p_reason: reason });
        toast("บันทึกราคาแล้ว");
      } else {
        await rpc("admin_deactivate_price", { p_price_id: pending.id, p_reason: reason });
        toast("ปิดขายแล้ว");
      }
      $("cf").close(); pending = null; loaded.audit = false; loadPrices();
    } catch (err) { $("cfErr").textContent = errText(err); }
    busy($("cfOk"), false);
  }, true);

  /* ---------------------------------------------------------- audit */
  var AQ = { page: 1 };
  async function loadAudit() {
    try {
      var r = await rpc("admin_audit_list", { p: { page: AQ.page, page_size: 30, action_prefix: $("auFilter").value } });
      var pages = Math.max(1, Math.ceil(r.total / r.page_size));
      $("auInfo").textContent = "หน้า " + r.page + " / " + pages + " · " + nf(r.total) + " รายการ";
      $("auPrev").disabled = r.page <= 1; $("auNext").disabled = r.page >= pages;
      $("auRows").innerHTML = r.rows.length ? r.rows.map(function (a) {
        return '<tr><td data-l="เวลา" class="num">' + dt(a.at) + '</td><td data-l="ผู้ดูแล">' + esc(a.admin || "—") + '</td><td data-l="การกระทำ">' + esc(ACTION_LABEL[a.action] || a.action) +
          '</td><td data-l="สมาชิก">' + (a.target_user_id ? '<a href="#audit" data-open-user="' + esc(a.target_user_id) + '">' + esc(a.target || a.target_user_id) + "</a>" : "—") +
          '</td><td data-l="เหตุผล">' + esc(a.reason) + '</td><td data-l="รายละเอียด"><details><summary>ก่อน/หลัง</summary><pre class="json"></pre></details></td></tr>';
      }).join("") : '<tr><td colspan="6" class="empty">ยังไม่มีรายการ</td></tr>';
      [].forEach.call($("auRows").querySelectorAll("pre.json"), function (pre, i) {
        pre.textContent = JSON.stringify({ before: r.rows[i].before, after: r.rows[i].after }, null, 2);      // textContent: never HTML
      });
    } catch (e) { $("auRows").innerHTML = '<tr><td colspan="6" class="empty">' + esc(errText(e)) + "</td></tr>"; }
  }
  $("auFilter").addEventListener("change", function () { AQ.page = 1; loadAudit(); });
  $("auPrev").addEventListener("click", function () { if (AQ.page > 1) { AQ.page--; loadAudit(); } });
  $("auNext").addEventListener("click", function () { AQ.page++; loadAudit(); });

  /* ---------------------------------------------------------- start */
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
  setTimeout(function () { if (!started && !(KS && KS.isPreview && KS.isPreview())) gate("⚠️", "เชื่อมต่อบัญชีไม่สำเร็จ", "กรุณาเข้าสู่ระบบอีกครั้ง", '<button class="btn gold" type="button" id="gateLogin">เข้าสู่ระบบ</button>'); }, 12000);
})();
