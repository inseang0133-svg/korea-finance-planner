/* kfp-country.js — the profile's country decides how index.html looks (index.html only).
 *   TH → Thai page: everything in baht (old "฿ บาท" mode)
 *   KR → Korean page: won + approximate baht (old "₩ วอน" mode)
 * Once a country is set the ₩/฿ switch is hidden. Guests and accounts that have not picked a
 * country yet keep the switch.
 *
 * kfpApplyCountry(country) also makes the saved data match the country (idempotent, so it is
 * safe to call on every load, on every device):
 *   to KR: amounts entered in baht become won at today's rate (baht ÷ rate)
 *   to TH: amounts entered in won keep the approximate baht they were shown with (won × saved rate)
 * Salary months that would then exist twice keep the one entered in the new currency.
 * The data from before the last conversion is kept in "kfp_currency_backup_v1".
 * Work records stay in won (Korean hourly wage) and are not converted. */
(function () {
  "use strict";
  var BACKUP_KEY = "kfp_currency_backup_v1";
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function load(k, d) { try { var v = JSON.parse(localStorage.getItem(k) || "null"); return v == null ? d : v; } catch (_) { return d; } }
  // the member's saved KRW→THB rate first (the input may still show its HTML default while the page loads)
  function todayRate() {
    var el = document.getElementById("rate");
    var r = num(localStorage.getItem("rate")) || num(el && el.value);
    return r > 0 ? r : 0.024;
  }
  var r2 = function (n) { return Math.round(n * 100) / 100; };

  function convertSalary(list, target, rate) {
    if (!Array.isArray(list)) return { list: list, changed: false };
    var native = {}, out = [], changed = false;
    list.forEach(function (r) { if (r && ((target === "THB") === (r.currency === "THB"))) native[r.month] = 1; });
    list.forEach(function (r) {
      if (!r) return;
      var isThb = r.currency === "THB";
      if ((target === "THB") === isThb) { out.push(r); return; }
      changed = true;
      if (native[r.month]) return;                     // that month already exists in the new currency
      if (target === "THB") {
        var thb = Math.round(num(r.salary) * (num(r.rate) || rate));
        out.push({ month: r.month, currency: "THB", thb: thb, salary: 0, rate: 0, from: "KRW" });
      } else {
        out.push({ month: r.month, salary: Math.round(num(r.thb) / rate), rate: rate, from: "THB" });
      }
    });
    return { list: out, changed: changed };
  }

  function convertExpenses(list, target, rate) {
    if (!Array.isArray(list)) return { list: list, changed: false };
    var changed = false;
    var out = list.map(function (e) {
      if (!e || e.cur === target) return e;
      changed = true;
      var c = {}; for (var k in e) c[k] = e[k];
      if (target === "THB") {
        var thb = num(e.thb) || num(e.krw || e.amt) * (num(e.rate) || rate);
        c.cur = "THB"; c.amt = r2(thb); c.thb = c.amt; c.krw = Math.round(num(e.krw || e.amt));
      } else {
        var t = num(e.thb) || num(e.amt);
        c.cur = "KRW"; c.rate = rate; c.krw = Math.round(t / rate); c.amt = c.krw; c.thb = r2(t);
      }
      c.from = e.cur;
      return c;
    });
    return { list: out, changed: changed };
  }

  // Make every saved amount match `target` ("THB" | "KRW"). Returns true when something changed.
  function normalize(target) {
    var rate = todayRate();
    var sal = load("salaryRecords", []), exp = load("kfp_expenses_v1", []);
    var a = convertSalary(sal, target, rate), b = convertExpenses(exp, target, rate);
    var changed = a.changed || b.changed;
    if (changed) {
      try { localStorage.setItem(BACKUP_KEY, JSON.stringify({ at: new Date().toISOString(), to: target, rate: rate, salaryRecords: sal, kfp_expenses_v1: exp })); } catch (_) {}
      if (a.changed) localStorage.setItem("salaryRecords", JSON.stringify(a.list));
      if (b.changed) localStorage.setItem("kfp_expenses_v1", JSON.stringify(b.list));
    }
    // the salary box on the calculator
    var krw = num(localStorage.getItem("salary")), thbIn = num(localStorage.getItem("salaryThb"));
    if (target === "THB" && !thbIn && krw > 0) { localStorage.setItem("salaryThb", String(Math.round(krw * rate))); changed = true; }
    if (target === "KRW" && !krw && thbIn > 0) { localStorage.setItem("salary", String(Math.round(thbIn / rate))); changed = true; }
    return changed;
  }

  window.kfpApplyCountry = function (country) {
    var html = document.documentElement;
    if (country !== "TH" && country !== "KR") { html.removeAttribute("data-country"); return false; }
    html.setAttribute("data-country", country);
    var target = country === "TH" ? "THB" : "KRW";
    var changed = normalize(target);
    var modeChanged = typeof kfpGetMode === "function" && kfpGetMode() !== target;
    if (modeChanged && typeof kfpSetMode === "function") kfpSetMode(target);
    if (!changed && !modeChanged) return false;
    try { if (typeof kfpClearDeleted === "function") { kfpClearDeleted("salaryRecords"); kfpClearDeleted("kfp_expenses_v1"); } } catch (_) {}
    try { if (typeof kfpPersistNow === "function") kfpPersistNow(); } catch (_) {}
    try {
      if (typeof window.kfpApplyMode === "function") window.kfpApplyMode();
      if (typeof window.__kfpRefreshFromCloud === "function") window.__kfpRefreshFromCloud();
      if (typeof window.kfpResetResults === "function" && modeChanged) window.kfpResetResults();
      if (typeof renderPieChart === "function") renderPieChart();
      window.dispatchEvent(new CustomEvent("kfp:country", { detail: { country: country, converted: changed } }));
    } catch (e) { console.warn("KFP country refresh:", e); }
    return true;
  };
  window.__kfpCountryTest = { convertSalary: convertSalary, convertExpenses: convertExpenses };
})();
