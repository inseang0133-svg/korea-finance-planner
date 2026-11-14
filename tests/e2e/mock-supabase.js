/* Test double for @supabase/supabase-js@2 (served instead of the CDN file in e2e tests).
 * Records every call in window.__sb.calls. Seed users live in window.__sb.users. */
(function () {
  "use strict";
  var REF = (function () { try { return new URL(window.KFP_SUPABASE_CONFIG.SUPABASE_URL).hostname.split(".")[0]; } catch (_) { return "mock"; } })();
  var KEY = "sb-" + REF + "-auth-token";   // same key format as supabase-js v2
  var real = window.__kfpRealLocalStorage || window.localStorage;
  var S = window.__sb = window.__sb || {};
  // call log survives reloads (login/logout now reload the page)
  try { S.calls = JSON.parse(sessionStorage.getItem("__mock_calls") || "[]"); } catch (_) { S.calls = []; }
  S.users = S.users || {
    "john@kfp.example.com": { id: "u-legacy", password: "oldpass", confirmed: true, username: "john" },
    "a@gmail.com":          { id: "u-real",   password: "Passw0rd1", confirmed: true, username: "alice" },
    "u@gmail.com":          { id: "u-unconf", password: "Passw0rd1", confirmed: false, username: "uncle" }
  };
  S.taken = S.taken || ["john", "alice", "uncle"];
  function log(name, args) { S.calls.push({ name: name, args: args }); try { sessionStorage.setItem("__mock_calls", JSON.stringify(S.calls)); } catch (_) {} }
  function userObj(email) {
    var u = S.users[email];
    return { id: u.id, email: email, email_confirmed_at: u.confirmed ? "2026-01-01T00:00:00Z" : null };
  }
  function err(code, message) { return { code: code, message: message || code }; }

  var PLANS = [
    { id: "free", name: "Free", description: "เครื่องคิดเงินเดือน แบ่งเงิน และรายจ่ายพื้นฐาน", sort: 0,
      features: { salary: true, salary_history: true, expenses: true, work_records: false, advanced_statistics: false, export: false, cloud_sync: false, gold_portfolio: false },
      limits: { salary_history_months: 6, expense_history_months: 2, grace_days: 0 } },
    { id: "plus", name: "Finance Plus", description: "ทุกอย่างใน Free + บันทึกงาน สถิติขั้นสูง Export และ Cloud Sync", sort: 1,
      features: { salary: true, salary_history: true, expenses: true, work_records: true, advanced_statistics: true, export: true, cloud_sync: true, gold_portfolio: false },
      limits: { salary_history_months: null, expense_history_months: null, grace_days: 7 } },
    { id: "premium", name: "Finance Premium", description: "ทุกอย่างใน Plus + พอร์ตทองครบชุด", sort: 2,
      features: { salary: true, salary_history: true, expenses: true, work_records: true, advanced_statistics: true, export: true, cloud_sync: true, gold_portfolio: true },
      limits: { salary_history_months: null, expense_history_months: null, grace_days: 7 } }
  ];
  var PRICES = [
    { plan_id: "plus", billing_interval: "month", currency: "THB", amount_minor: 12900 },
    { plan_id: "plus", billing_interval: "year", currency: "THB", amount_minor: 129000 },
    { plan_id: "plus", billing_interval: "month", currency: "KRW", amount_minor: 5900 },
    { plan_id: "premium", billing_interval: "month", currency: "THB", amount_minor: 19900 },
    { plan_id: "premium", billing_interval: "year", currency: "THB", amount_minor: 199000 },
    { plan_id: "premium", billing_interval: "month", currency: "KRW", amount_minor: 8900 }
  ];
  function createClient() {
    var listeners = [];
    var session = null;
    try { session = JSON.parse(real.getItem(KEY) || "null"); } catch (_) {}
    function setS(s, event) {
      session = s;
      if (s) real.setItem(KEY, JSON.stringify(s)); else real.removeItem(KEY);
      listeners.forEach(function (cb) { setTimeout(function () { cb(event, s); }, 0); });
    }
    function sessionFor(email) { return { access_token: "at-" + email, refresh_token: "rt-" + email, user: userObj(email) }; }

    var auth = {
      getSession: function () {
        log("getSession");
        if (session && sessionStorage.getItem("__mock_revoked") === "1") {
          // supabase-js drops a session whose refresh token was revoked
          sessionStorage.removeItem("__mock_revoked");
          setS(null, "SIGNED_OUT");
        }
        return Promise.resolve({ data: { session: session }, error: null });
      },
      onAuthStateChange: function (cb) {
        listeners.push(cb);
        var h = new URLSearchParams(location.hash.slice(1));
        if (h.get("type") === "recovery" && h.get("access_token")) {
          var s = sessionFor("a@gmail.com"); setS(s, "PASSWORD_RECOVERY"); history.replaceState(null, "", location.pathname);
        } else if (h.get("access_token")) {
          var s2 = sessionFor("a@gmail.com"); setS(s2, "SIGNED_IN"); history.replaceState(null, "", location.pathname);
        }
        return { data: { subscription: { unsubscribe: function () {} } } };
      },
      signInWithPassword: function (c) {
        log("signInWithPassword", { email: c.email });
        var u = S.users[c.email];
        if (!u || u.password !== c.password) return Promise.resolve({ data: { user: null, session: null }, error: err("invalid_credentials", "Invalid login credentials") });
        if (!u.confirmed) return Promise.resolve({ data: { user: null, session: null }, error: err("email_not_confirmed", "Email not confirmed") });
        var s = sessionFor(c.email); setS(s, "SIGNED_IN");
        return Promise.resolve({ data: { user: s.user, session: s }, error: null });
      },
      signUp: function (c) {
        log("signUp", { email: c.email, options: c.options });
        S.users[c.email] = S.users[c.email] || { id: "u-new", password: c.password, confirmed: false, username: c.options && c.options.data && c.options.data.username };
        return Promise.resolve({ data: { user: userObj(c.email), session: null }, error: null });
      },
      resend: function (c) { log("resend", c); return Promise.resolve({ data: {}, error: null }); },
      resetPasswordForEmail: function (e, o) { log("resetPasswordForEmail", { email: e, opts: o }); return Promise.resolve({ data: {}, error: null }); },
      updateUser: function (a, o) {
        log("updateUser", { attrs: a, opts: o });
        if (a.password && session) S.users[session.user.email].password = a.password;
        return Promise.resolve({ data: { user: session && session.user }, error: null });
      },
      setSession: function (t) {
        log("setSession", t);
        var email = String(t.access_token).replace(/^at-/, "");
        if (!S.users[email]) return Promise.resolve({ data: {}, error: err("bad_jwt") });
        var s = sessionFor(email); setS(s, "SIGNED_IN");
        return Promise.resolve({ data: { user: s.user, session: s }, error: null });
      },
      exchangeCodeForSession: function () { return Promise.resolve({ data: {}, error: err("pkce") }); },
      signOut: function () { log("signOut"); setS(null, "SIGNED_OUT"); return Promise.resolve({ error: null }); }
    };

    function query(table) {
      var q = { _t: table, _f: {} };
      q.select = function () { return q; };
      q.eq = function (c, v) { q._f[c] = v; return q; };
      q.order = function () { return q; };
      q.range = function (a, b) { q._r = [a, b]; return q; };
      q.update = function (v) { log("update:" + table, v); q._u = v; return q; };
      q.upsert = function (v) {
        log("upsert:" + table, v);
        var at = new Date(Date.now() + Math.floor(Math.random() * 1000)).toISOString();
        if (table === "user_data") sessionStorage.setItem("__mock_cloud_" + v.user_id, JSON.stringify({ user_id: v.user_id, data: v.data, updated_at: at }));
        var r = { error: null, data: { updated_at: at } };
        var chain = { select: function () { return chain; }, maybeSingle: function () { return Promise.resolve(r); }, single: function () { return Promise.resolve(r); },
                      then: function (a, b) { return Promise.resolve(r).then(a, b); } };
        return chain;
      };
      q.maybeSingle = function () {
        if (table === "user_data") {
          var row = sessionStorage.getItem("__mock_cloud_" + q._f.user_id);
          return Promise.resolve({ data: row ? JSON.parse(row) : null, error: null });
        }
        if (table === "profiles") {
          var email = Object.keys(S.users).find(function (e) { return S.users[e].id === q._f.user_id; });
          return Promise.resolve({ data: email ? { user_id: q._f.user_id, username: S.users[email].username, nickname: S.users[email].username } : null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      };
      q.then = function (res, rej) {
        if (table === "plans") return Promise.resolve({ data: PLANS, error: null }).then(res, rej);
        if (table === "plan_prices") {
          var override = sessionStorage.getItem("__mock_prices");
          return Promise.resolve({ data: override ? JSON.parse(override) : PRICES, error: null }).then(res, rej);
        }
        if (table === "payments") {
          // test control: sessionStorage __mock_payments_<uid> = JSON array (any order)
          log("select:payments", { f: q._f, r: q._r });
          var all = JSON.parse(sessionStorage.getItem("__mock_payments_" + q._f.user_id) || "[]")
            .sort(function (x, y) { return x.created_at < y.created_at ? 1 : -1; });
          var rows = q._r ? all.slice(q._r[0], q._r[1] + 1) : all;
          return Promise.resolve({ data: rows, error: null }).then(res, rej);
        }
        return Promise.resolve({ error: null }).then(res, rej);
      };
      return q;
    }

    return {
      auth: auth,
      from: query,
      rpc: function (fn, args) {
        log("rpc:" + fn, args);
        if (fn === "is_username_available") return Promise.resolve({ data: S.taken.indexOf(args.p_username) < 0, error: null });
        if (fn === "touch_activity") return Promise.resolve({ data: null, error: null });
        if (fn === "get_my_entitlements") {
          // test controls: sessionStorage __mock_plan_<uid> = free|plus|premium · __mock_ent_mode = error|missing|slow
          var mode = sessionStorage.getItem("__mock_ent_mode") || "";
          if (!session) return Promise.resolve({ data: null, error: null });
          if (mode === "error") return Promise.resolve({ data: null, error: err("PGRST301", "server error") });
          if (mode === "missing") return Promise.resolve({ data: null, error: err("PGRST202", "Could not find the function public.get_my_entitlements") });
          var uid = session.user.id, pid = sessionStorage.getItem("__mock_plan_" + uid) || "premium";   // default = full access (like the legacy 90-day grant)
          var pl = PLANS.filter(function (p) { return p.id === pid; })[0];
          var src = sessionStorage.getItem("__mock_source") || (pid === "free" ? "default" : "subscription:stripe");
          var ent = { user_id: uid, plan: pl.id, plan_name: pl.name, source: src, status: pid === "free" ? "none" : "active",
                      valid_until: pid === "free" ? null : "2026-12-13T00:00:00Z", features: pl.features, limits: pl.limits, admin_role: sessionStorage.getItem("__mock_admin_role") || null, checked_at: new Date().toISOString() };
          var out = Promise.resolve({ data: ent, error: null });
          return mode === "slow" ? new Promise(function (r) { setTimeout(function () { r({ data: ent, error: null }); }, 2500); }) : out;
        }
        if (fn === "is_admin" || fn.indexOf("admin_") === 0) return Promise.resolve(window.__mockAdmin(fn, args || {}, session));
        if (fn === "export_my_gold") {
          if (!session) return Promise.resolve({ data: null, error: err("42501", "not authenticated") });
          var gr = JSON.parse(sessionStorage.getItem("__mock_gold_" + session.user.id) || "null");
          return Promise.resolve({ data: { exported_at: new Date().toISOString(), lots: gr ? gr.lots : [], settings: gr ? gr.settings : {} }, error: null });
        }
        if (fn === "get_my_gold" || fn === "save_my_gold") {
          // test controls: sessionStorage __mock_gold_<uid> = {lots, settings, version, updated_at} · __mock_gold_mode = offline
          if (!session) return Promise.resolve({ data: null, error: err("42501", "not authenticated") });
          if (sessionStorage.getItem("__mock_gold_mode") === "offline") return Promise.resolve({ data: null, error: { message: "TypeError: Failed to fetch", code: "" } });
          var gu = session.user.id, gkey = "__mock_gold_" + gu;
          var gplan = sessionStorage.getItem("__mock_plan_" + gu) || "premium";
          var row = JSON.parse(sessionStorage.getItem(gkey) || "null");
          if (fn === "get_my_gold") {
            if (gplan !== "premium") return Promise.resolve({ data: { allowed: false, stored_lots: row ? row.lots.length : 0 }, error: null });
            return Promise.resolve({ data: { allowed: true, exists: !!row, lots: row ? row.lots : [], settings: row ? row.settings : {}, version: row ? row.version : 0, updated_at: row ? row.updated_at : null }, error: null });
          }
          if (gplan !== "premium") return Promise.resolve({ data: null, error: err("42501", "premium_required") });
          var curV = row ? row.version : 0;
          if (args.p_base_version !== null && args.p_base_version !== undefined && args.p_base_version !== curV)
            return Promise.resolve({ data: { ok: false, error: "conflict", version: curV, updated_at: row && row.updated_at, lots: row ? row.lots : [], settings: row ? row.settings : {} }, error: null });
          var next = { lots: args.p_lots, settings: args.p_settings, version: curV + 1, updated_at: new Date().toISOString() };
          sessionStorage.setItem(gkey, JSON.stringify(next));
          return Promise.resolve({ data: { ok: true, version: next.version, updated_at: next.updated_at }, error: null });
        }
        if (fn === "get_my_billing") {
          // test control: sessionStorage __mock_billing_<uid> = JSON (entitlements filled in from get_my_entitlements)
          if (!session) return Promise.resolve({ data: null, error: null });
          if (sessionStorage.getItem("__mock_billing_mode") === "missing") return Promise.resolve({ data: null, error: err("PGRST202", "Could not find the function public.get_my_billing") });
          var u2 = session.user.id, raw = sessionStorage.getItem("__mock_billing_" + u2);
          var b = raw ? JSON.parse(raw) : { subscription: null, grants: [], has_customer: false, open_invoice: null };
          b.payments_total = JSON.parse(sessionStorage.getItem("__mock_payments_" + u2) || "[]").length;
          return this.rpc("get_my_entitlements").then(function (r) { b.entitlements = r.data; return { data: b, error: null }; });
        }
        return Promise.resolve({ data: null, error: err("not_found") });
      }
    };
  }
  window.supabase = { createClient: createClient };

  /* ---------- Admin Console fixtures (Phase 10) · role: sessionStorage __mock_admin_role = owner|admin|viewer ---------- */
  var DAY = 86400000, iso = function (d) { return new Date(Date.now() + d * DAY).toISOString(); };
  function adminUsers() {
    var out = [], plans = ["free", "plus", "premium"], acts = ["active", "recent", "inactive", "dormant", "never"];
    for (var i = 1; i <= 60; i++) {
      var pl = plans[i % 3], st = pl === "free" ? null : (i % 7 === 0 ? "past_due" : "active");
      out.push({ user_id: "00000000-0000-4000-8000-" + String(i).padStart(12, "0"), email: "user" + i + "@mail.test",
        username: i === 5 ? "<img src=x onerror=alert(1)>" : "user" + i, country: i % 2 ? "TH" : "KR", plan: pl, plan_source: pl === "free" ? "default" : (i % 10 === 0 ? "admin_grant" : "subscription:stripe"),
        sub_status: st, cancel_at_period_end: i % 11 === 0, registered_at: iso(-i * 3), sub_started_at: st ? iso(-i * 2) : null, expires_at: st ? iso(30 - i % 20) : null,
        last_login_at: iso(-(i % 9)), last_active_at: i % 5 === 4 ? null : iso(-(i % 40)), last_page: "index.html", days_since_active: i % 5 === 4 ? null : i % 40,
        activity: acts[i % 5], suspended: !!sessionStorage.getItem("__mock_susp_" + i), verified: i !== 3, is_admin: i === 2 });
    }
    out.push({ user_id: "u-real", email: "a@gmail.com", username: "alice", country: "TH", plan: "premium", plan_source: "admin_grant", sub_status: null, registered_at: iso(-400),
      last_login_at: iso(0), last_active_at: iso(0), activity: "active", days_since_active: 0, suspended: false, verified: true, is_admin: true });
    return out;
  }
  window.__mockAdmin = function (fn, a, session) {
    var role = sessionStorage.getItem("__mock_admin_role") || "", ok = function (d) { return { data: d, error: null }; };
    var no = function (m, c) { return { data: null, error: { code: c || "42501", message: m || "forbidden" } }; };
    if (!session) return no();
    if (fn === "is_admin") return ok(!!role);
    if (!role) return no();
    var canWrite = role === "owner" || role === "admin", U = adminUsers();
    if (fn === "admin_whoami") return ok({ user_id: session.user.id, role: role, can_write: canWrite, is_owner: role === "owner" });
    if (fn === "admin_overview") return ok({ tz: "Asia/Seoul", generated_at: new Date().toISOString(),
      users: { total: 1234, new_today: 7, new_month: 88, suspended: 2, unverified: 31 }, plans: { free: 900, plus: 200, premium: 134, via_subscription: 280, via_grant: 54 },
      subscriptions: { active: 250, trialing: 3, cancelling: 12, past_due: 9, expired: 40 },
      activity: { active: 300, recent: 400, inactive: 200, dormant: 300, never: 34 },
      mrr: { THB: { mrr_minor: 3225000, arr_minor: 38700000, payers: 200, arpu_minor: 16125 }, KRW: { mrr_minor: 712000, arr_minor: 8544000, payers: 80, arpu_minor: 8900 } },
      revenue: { THB: { gross_minor: 12000000, refunded_minor: 50000, net_minor: 11950000, gross_30d_minor: 3000000 }, KRW: { gross_minor: 2400000, refunded_minor: 0, net_minor: 2400000, gross_30d_minor: 700000 } },
      churn_30d: { churned: 14, base: 276, rate_pct: 5.07 }, failed_payments_30d: 6, webhooks_failed: 0 });
    if (fn === "admin_list_users") {
      var p = a.p || {}, rows = U.filter(function (u) {
        return (!p.q || (u.email + " " + u.username + " " + u.user_id).toLowerCase().indexOf(String(p.q).toLowerCase()) >= 0) && (!p.plan || u.plan === p.plan) && (!p.activity || u.activity === p.activity);
      });
      if (p.sort === "email") rows.sort(function (x, y) { return (x.email < y.email ? -1 : 1) * (p.dir === "asc" ? 1 : -1); });
      var size = Math.min(p.page_size || 25, 100), page = p.page || 1;
      return ok({ page: page, page_size: size, total: rows.length, rows: rows.slice((page - 1) * size, page * size) });
    }
    if (fn === "admin_user_detail") {
      var u = U.filter(function (x) { return x.user_id === a.p_user; })[0]; if (!u) return no("user_not_found", "P0002");
      var paid = u.plan !== "free" && u.plan_source.indexOf("subscription") === 0;
      return ok({ user: { user_id: u.user_id, email: u.email, username: u.username, nickname: u.username, country: u.country, registered_at: u.registered_at, verified_at: u.verified ? u.registered_at : null,
          legacy_email: false, last_login_at: u.last_login_at, last_active_at: u.last_active_at, last_page: u.last_page, suspended_at: u.suspended ? iso(-1) : null, activity: u.activity,
          admin_role: u.user_id === "u-real" ? role : (sessionStorage.getItem("__mock_role_" + u.user_id) || (u.is_admin ? "admin" : null)) },
        effective: { plan_id: u.suspended ? "free" : u.plan, source: u.suspended ? "suspended" : u.plan_source, status: paid ? "active" : "granted", valid_until: u.expires_at || (u.plan === "free" ? null : iso(20)) },
        customer: paid ? { provider: "stripe", customer_id: "cus_TEST" + u.user_id.slice(-3) } : null,
        subscriptions: paid ? [{ id: "s1", provider: "stripe", provider_subscription_id: "sub_TEST" + u.user_id.slice(-3), plan_id: u.plan, status: u.sub_status, billing_interval: "month", currency: "THB",
          unit_amount_minor: u.plan === "plus" ? 12900 : 19900, cancel_at_period_end: !!u.cancel_at_period_end, started_at: u.sub_started_at, current_period_start: iso(-5), current_period_end: iso(25) }] : [],
        entitlements: u.plan_source === "admin_grant" ? [{ id: "g1", plan_id: u.plan, reason: "admin_grant", note: "promo", starts_at: iso(-3), expires_at: iso(27), revoked_at: null, active: true, granted_by: "owner@mail.test" }] : [],
        payments: paid ? [{ id: "p1", provider_invoice_id: "in_TEST1", plan_id: u.plan, currency: "THB", amount_due_minor: 12900, amount_paid_minor: 12900, amount_refunded_minor: 5000, status: "partially_refunded",
          hosted_invoice_url: "https://invoice.stripe.com/i/1", invoice_pdf_url: "javascript:alert(1)", paid_at: iso(-5), created_at: iso(-5) }] : [],
        payments_total: paid ? 1 : 0, activity: [{ kind: "page", page: "gold.html", at: iso(-0.1) }],
        audit: [{ id: 9, action: "plan.grant", reason: "<b>bold?</b>", at: iso(-1), admin: "owner@mail.test" }], gold_lots: u.plan === "premium" ? 4 : null });
    }
    if (fn === "admin_set_role") {
      if (role !== "owner") return no();
      if (a.p_user === session.user.id) return no("cannot_act_on_self");
      if (!a.p_reason || a.p_reason.trim().length < 3) return no("reason_required", "22023");
      if (a.p_role === "none") sessionStorage.removeItem("__mock_role_" + a.p_user); else sessionStorage.setItem("__mock_role_" + a.p_user, a.p_role);
      window.__mockRoleCalls = (window.__mockRoleCalls || []).concat([a]);
      return ok({ role: a.p_role === "none" ? null : a.p_role });
    }
    if (["admin_set_plan", "admin_extend_access", "admin_revoke_access", "admin_set_suspended"].indexOf(fn) >= 0) {
      if (!canWrite) return no();
      if (a.p_user === session.user.id) return no("cannot_act_on_self");
      if (!a.p_reason || a.p_reason.trim().length < 3) return no("reason_required", "22023");
      if (fn === "admin_set_suspended") { var n = Number(String(a.p_user).slice(-12)); if (a.p_suspended) sessionStorage.setItem("__mock_susp_" + n, "1"); else sessionStorage.removeItem("__mock_susp_" + n); }
      return ok({ effective: { plan_id: a.p_plan || "premium" } });
    }
    if (fn === "admin_revenue") return ok({ tz: "Asia/Seoul",
      by_currency: { THB: { gross_minor: 12000000, refunded_minor: 50000, net_minor: 11950000, period_gross_minor: 9000000, period_net_minor: 8950000, mrr_minor: 3225000, arr_minor: 38700000, payers: 200 },
                     KRW: { gross_minor: 2400000, refunded_minor: 0, net_minor: 2400000, period_gross_minor: 2400000, period_net_minor: 2400000, mrr_minor: 712000, arr_minor: 8544000, payers: 80 } },
      by_plan: [{ plan_id: "plus", currency: "THB", subscribers: 120, mrr_minor: 1548000, gross_minor: 5000000, net_minor: 4950000 }, { plan_id: "premium", currency: "KRW", subscribers: 80, mrr_minor: 712000, gross_minor: 2400000, net_minor: 2400000 }],
      monthly: [{ month: "2026-10", currency: "THB", gross_minor: 3000000, refunded_minor: 0, net_minor: 3000000, payments: 200 }, { month: "2026-11", currency: "THB", gross_minor: 1500000, refunded_minor: 50000, net_minor: 1450000, payments: 100 },
                { month: "2026-11", currency: "KRW", gross_minor: 700000, refunded_minor: 0, net_minor: 700000, payments: 70 }],
      failed: { count_30d: 6, latest: [{ user_id: "00000000-0000-4000-8000-000000000007", email: "user7@mail.test", currency: "THB", amount_due_minor: 12900, status: "failed", failure_reason: "Card declined", created_at: iso(-1), hosted_invoice_url: "https://invoice.stripe.com/i/f" }] },
      refunds: { count: 1, latest: [{ email: "user1@mail.test", currency: "THB", amount_minor: 5000, status: "succeeded", reason: "requested_by_customer", created_at: iso(-2), invoice: "in_TEST1" }] } });
    if (fn === "admin_list_prices") return ok([
      { id: "pr1", plan_id: "plus", billing_interval: "month", currency: "THB", amount_minor: 14900, active: true, provider_price_id: "price_A", created_at: iso(-30) },
      { id: "pr0", plan_id: "plus", billing_interval: "month", currency: "THB", amount_minor: 12900, active: false, created_at: iso(-90), deactivated_at: iso(-30) },
      { id: "pr2", plan_id: "premium", billing_interval: "month", currency: "KRW", amount_minor: 9900, active: true, provider_price_id: null, created_at: iso(-30) }]);
    if (fn === "admin_activity_analytics") {
      var days = (a.p && a.p.days) || 30, ser = [];
      for (var k = days - 1; k >= 0; k--) { var dd = new Date(Date.now() - k * DAY).toISOString().slice(0, 10); ser.push({ day: dd, dau: 100 + (k * 37) % 90, signups: (k * 7) % 11 }); }
      return ok({ days: days, from: ser[0].day, to: ser[ser.length - 1].day, cached: !(a.p && a.p.refresh), computed_at: new Date().toISOString(),
        kpi: { dau: 140, wau: 520, mau: 900, avg_dau_30: 150.5, active_in_range: 900, signups_in_range: 120, avg_events_per_active_day: 6.2 },
        buckets: { active: 300, recent: 400, inactive: 200, dormant: 300, never: 34 },
        buckets_by_plan: [{ plan: "free", bucket: "active", users: 150 }, { plan: "free", bucket: "dormant", users: 280 }, { plan: "premium", bucket: "dormant", users: 9 }, { plan: "plus", bucket: "active", users: 90 }],
        series: ser, pages: [{ page: "index.html", views: 9000, users: 850 }, { page: "gold.html", views: 2500, users: 130 }, { page: "<b>x</b>.html", views: 3, users: 1 }],
        features: [{ feature: "expenses", uses: 3000, users: 600, adoption_pct: 66.7 }, { feature: "work_records", uses: 1200, users: 200, adoption_pct: 22.2 }, { feature: "gold_portfolio", uses: 300, users: 120, adoption_pct: 13.3 }],
        hours: Array.from({ length: 24 }, function (_, h) { return h > 7 && h < 23 ? 50 + h * 3 : 5; }), weekdays: [100, 110, 105, 120, 130, 160, 150],
        retention: [{ week: iso(-6), size: 30, w1: null, w2: null, w3: null, w4: null }, { week: iso(-13), size: 40, w1: 55.0, w2: null, w3: null, w4: null }, { week: iso(-34), size: 25, w1: 60, w2: 44, w3: 40, w4: 36 }],
        at_risk: [{ user_id: "00000000-0000-4000-8000-000000000004", email: "user4@mail.test", plan: "plus", currency: "THB", mrr_minor: 12900, last_active_at: iso(-20), days_inactive: 20 }],
        at_risk_total: 1 });
    }
    if (fn === "admin_user_activity") {
      var daily = []; for (var j = 29; j >= 0; j--) daily.push({ day: new Date(Date.now() - j * DAY).toISOString().slice(0, 10), events: j % 3 === 0 ? (j % 9) + 1 : 0 });
      return ok({ days: 30, daily: daily, active_days: 10, pages: { "index.html": 40, "gold.html": 12 }, features: { expenses: 3, export: 1 } });
    }
    if (fn === "admin_set_price" || fn === "admin_deactivate_price") return canWrite ? ok("new-id") : no();
    if (fn === "admin_audit_list") return ok({ page: (a.p && a.p.page) || 1, page_size: 30, total: 2, rows: [
      { id: 2, action: "user.suspend", reason: "<img src=x onerror=alert('xss')>", at: iso(-0.5), admin: "owner@mail.test", target_user_id: "00000000-0000-4000-8000-000000000001", target: "user1@mail.test",
        before: { suspended_at: null }, after: { suspended_at: "now", note: "</pre><script>alert(1)</script>" } },
      { id: 1, action: "price.set", reason: "new KRW yearly", at: iso(-3), admin: "owner@mail.test", target_user_id: null, before: null, after: { amount_minor: 59000 } }] });
    return no("unknown admin rpc " + fn, "PGRST202");
  };
})();
