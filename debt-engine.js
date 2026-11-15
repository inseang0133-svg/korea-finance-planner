/* Smart Credit & Debt — pure calculation engine (no DOM, no network).
 * Money = integer minor units (KRW won, THB satang). Dates = 'YYYY-MM-DD' strings.
 * buildSchedule() mirrors public.kfp_debt_build_schedule() in migration 1700 — keep them in step.
 * Works in the browser (window.KfpDebt) and in node (module.exports) for unit tests. */
(function (root) {
  'use strict';

  var CUR = {
    THB: { sym: '฿', exp: 2, locale: 'th-TH' },
    KRW: { sym: '₩', exp: 0, locale: 'ko-KR' }
  };

  // ---------- integers / money ----------
  function int(v) { var n = Number(v); return isFinite(n) ? Math.trunc(n) : 0; }
  // round(a / b) half away from zero, exact for |a| < 2^53
  function divRound(a, b) {
    var neg = (a < 0) !== (b < 0); a = Math.abs(a); b = Math.abs(b);
    var q = Math.floor(a / b), r = a - q * b;
    if (r * 2 >= b) q += 1;
    return neg ? -q : q;
  }
  function exp(cur) { return (CUR[cur] || CUR.THB).exp; }
  function toMinor(text, cur) {
    if (text === null || text === undefined) return null;
    var s = String(text).replace(/[,\s฿₩]/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    var e = exp(cur), neg = s[0] === '-'; if (neg) s = s.slice(1);
    var parts = s.split('.'), frac = (parts[1] || '');
    if (frac.length > e) return null;
    while (frac.length < e) frac += '0';
    var v = Number(parts[0] + frac);
    if (!isFinite(v) || v > 999999999999999) return null;
    return neg ? -v : v;
  }
  function toMajor(minor, cur) { return int(minor) / Math.pow(10, exp(cur)); }
  function fmt(minor, cur, opts) {
    opts = opts || {};
    var c = CUR[cur] || CUR.THB, e = c.exp, v = int(minor), neg = v < 0; v = Math.abs(v);
    var major = Math.floor(v / Math.pow(10, e)), frac = v - major * Math.pow(10, e);
    var s = String(major).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (e > 0 && (frac || !opts.compact)) s += '.' + String(frac).padStart(e, '0');
    return (neg ? '−' : '') + (opts.noSym ? '' : c.sym) + s;
  }
  function inputValue(minor, cur) {
    if (minor === null || minor === undefined || minor === '') return '';
    var e = exp(cur), v = int(minor), neg = v < 0; v = Math.abs(v);
    if (!e) return (neg ? '-' : '') + v;
    var p = Math.pow(10, e), m = Math.floor(v / p), f = v - m * p;
    return (neg ? '-' : '') + m + (f ? '.' + String(f).padStart(e, '0').replace(/0+$/, '') : '');
  }
  // KRW per 1 THB  →  convert between currencies (display only, never stored as truth)
  function convert(minor, from, to, krwPerThb) {
    minor = int(minor);
    if (from === to) return minor;
    var rate = Number(krwPerThb) || 0; if (rate <= 0) return 0;
    if (from === 'THB' && to === 'KRW') return Math.round(minor / 100 * rate);
    if (from === 'KRW' && to === 'THB') return Math.round(minor / rate * 100);
    return 0;
  }

  // ---------- dates ----------
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function parse(d) {
    if (!d) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d)); if (!m) return null;
    return { y: +m[1], m: +m[2], d: +m[3] };
  }
  function iso(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }
  function daysIn(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  // Postgres: date + interval 'n months' keeps the day, clamped to the month's last day
  function addMonths(d, n) {
    var p = parse(d); if (!p) return null;
    var t = p.y * 12 + (p.m - 1) + n, y = Math.floor(t / 12), m = t - y * 12 + 1;
    return iso(y, m, Math.min(p.d, daysIn(y, m)));
  }
  function addDays(d, n) {
    var p = parse(d), t = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
    return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  function today() { var t = new Date(); return iso(t.getFullYear(), t.getMonth() + 1, t.getDate()); }
  function monthKey(d) { return String(d).slice(0, 7); }
  function dayInMonth(ym, day) {
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7);
    return iso(y, m, Math.min(int(day) || 1, daysIn(y, m)));
  }
  function diffDays(a, b) {
    var x = parse(a), y = parse(b);
    return Math.round((Date.UTC(y.y, y.m - 1, y.d) - Date.UTC(x.y, x.m - 1, x.d)) / 86400000);
  }

  // ---------- installment schedule (mirror of SQL) ----------
  function buildSchedule(financed, rateBp, method, months, firstDue, custom) {
    financed = int(financed); rateBp = int(rateBp); months = int(months);
    var rows = [], i;
    if (method === 'custom') {
      if (!Array.isArray(custom) || custom.length < 1 || custom.length > 120) throw new Error('invalid_custom');
      var prev = null;
      custom.forEach(function (c, k) {
        var a = int(c.amount);
        if (!parse(c.due_date) || a <= 0 || (prev && c.due_date < prev)) throw new Error('invalid_custom');
        prev = c.due_date;
        rows.push({ seq: k + 1, due_date: String(c.due_date).slice(0, 10), principal: a, interest: 0, amount: a });
      });
      return rows;
    }
    if (!(months >= 1 && months <= 120)) throw new Error('invalid_months');
    if (!(financed > 0)) throw new Error('invalid_amount');
    if (!parse(firstDue)) throw new Error('invalid_first_due_date');
    var due = function (k) { return addMonths(firstDue, k - 1); };
    var base = Math.floor(financed / months), rem = financed - base * months;
    if (method === 'zero' || ((method === 'fixed' || method === 'reducing') && rateBp === 0)) {
      for (i = 1; i <= months; i++) {
        var p0 = base + (i === months ? rem : 0);
        rows.push({ seq: i, due_date: due(i), principal: p0, interest: 0, amount: p0 });
      }
      return rows;
    }
    if (method === 'fixed') {
      var ti = divRound(financed * rateBp * months, 120000);
      var ib = Math.floor(ti / months), ir = ti - ib * months;
      for (i = 1; i <= months; i++) {
        var pp = base + (i === months ? rem : 0), ii = ib + (i === months ? ir : 0);
        rows.push({ seq: i, due_date: due(i), principal: pp, interest: ii, amount: pp + ii });
      }
      return rows;
    }
    if (method === 'reducing') {
      var r = rateBp / 120000;
      var pay = Math.round(financed * r / (1 - Math.pow(1 + r, -months)));
      var bal = financed;
      for (i = 1; i <= months; i++) {
        var it = divRound(bal * rateBp, 120000);
        var pr = i === months ? bal : Math.max(Math.min(pay - it, bal), 0);
        bal -= pr;
        rows.push({ seq: i, due_date: due(i), principal: pr, interest: it, amount: pr + it });
      }
      return rows;
    }
    throw new Error('invalid_method');
  }
  function scheduleTotals(rows) {
    var t = { principal: 0, interest: 0, amount: 0, months: rows.length, monthly: rows.length ? rows[0].amount : 0 };
    rows.forEach(function (r) { t.principal += r.principal; t.interest += r.interest; t.amount += r.amount; });
    return t;
  }

  // ---------- data helpers ----------
  function liveRows(data, planId) {
    var plan = (data.installment_plans || []).find(function (p) { return p.id === planId; });
    if (!plan) return [];
    return (data.installment_schedules || []).filter(function (s) {
      return s.plan_id === planId && s.revision === plan.revision && !s.superseded_at;
    }).sort(function (a, b) { return a.seq - b.seq; });
  }
  function rowAmount(s) { return s.actual_amount_minor !== null && s.actual_amount_minor !== undefined ? int(s.actual_amount_minor) : int(s.amount_minor); }
  // rows of a plan that count as billed by asOf (respecting pause / settle / cancel)
  function planBilled(plan, rows, asOf) {
    var billed = 0, unbilledPrincipal = 0, unbilledAmount = 0, stop = plan.status_date || null;
    rows.forEach(function (s) {
      var amt = rowAmount(s);
      if (plan.status === 'cancelled') return;                      // nothing from a cancelled plan
      var cutoff = asOf;
      if ((plan.status === 'paused') && stop && stop < cutoff) cutoff = stop;
      if (plan.status === 'settled' && stop) {
        if (s.due_date <= stop && s.due_date <= asOf) billed += amt;
        else if (stop <= asOf) billed += int(s.principal_minor);    // early settlement: remaining principal at once, no future interest
        else { unbilledPrincipal += int(s.principal_minor); unbilledAmount += amt; }
        return;
      }
      if (s.due_date <= cutoff) billed += amt;
      else { unbilledPrincipal += int(s.principal_minor); unbilledAmount += amt; }
    });
    return { billed: billed, unbilledPrincipal: unbilledPrincipal, unbilledAmount: unbilledAmount };
  }

  // card balance (owed on the card) at asOf + credit used (depends on installment_mode)
  function cardStatus(data, card, asOf) {
    asOf = asOf || today();
    var bal = card.opening_date && card.opening_date > asOf ? 0 : int(card.opening_balance_minor);
    var unbilled = 0, unbilledPrincipal = 0, plans = [];
    (data.installment_plans || []).forEach(function (p) {
      if (p.card_id !== card.id || (p.purchase_date && p.purchase_date > asOf)) return;   // not bought yet at asOf
      var b = planBilled(p, liveRows(data, p.id), asOf);
      bal += b.billed; unbilled += b.unbilledAmount; unbilledPrincipal += b.unbilledPrincipal;
      plans.push(p);
    });
    (data.debt_transfers || []).forEach(function (t) {
      if (t.status !== 'confirmed' || t.effective_date > asOf) return;
      if (t.from_card_id === card.id) bal -= int(t.amount_minor);
      if (t.to_card_id === card.id) bal += int(t.fee_minor) + (int(t.installments) > 0 ? 0 : int(t.dest_amount_minor));
    });
    (data.debt_payments || []).forEach(function (pm) {
      if (pm.card_id === card.id && pm.status === 'confirmed' && pm.paid_on <= asOf) bal -= int(pm.amount_minor);
    });
    (data.debt_adjustments || []).forEach(function (a) {
      if (a.card_id === card.id && a.status === 'active' && a.effective_date <= asOf) bal += int(a.amount_minor);
    });
    var limit = int(card.credit_limit_minor);
    var used = card.installment_mode === 'full_hold' ? bal + unbilledPrincipal : bal;
    return {
      id: card.id, currency: card.currency, balance: bal, unbilled: unbilled, unbilledPrincipal: unbilledPrincipal,
      totalDebt: Math.max(bal, 0) + unbilled, limit: limit, used: Math.max(used, 0),
      available: limit ? limit - Math.max(used, 0) : null,
      utilization: limit ? Math.max(used, 0) / limit : null,
      overLimit: limit ? used > limit : false, plans: plans.length
    };
  }

  // FIFO allocation of a shop plan's confirmed payments onto its live rows
  function allocatePlan(data, plan, asOf) {
    asOf = asOf || today();
    var rows = liveRows(data, plan.id).map(function (s) {
      return { id: s.id, seq: s.seq, due_date: s.due_date, amount: rowAmount(s), principal: int(s.principal_minor),
               interest: int(s.interest_minor), estimate: s.actual_amount_minor === null || s.actual_amount_minor === undefined,
               paid: 0, state: 'upcoming' };
    });
    var pays = (data.debt_payments || []).filter(function (p) { return p.plan_id === plan.id && p.status === 'confirmed'; })
      .sort(function (a, b) { return a.paid_on < b.paid_on ? -1 : a.paid_on > b.paid_on ? 1 : String(a.created_at || '').localeCompare(String(b.created_at || '')); });
    var paid = 0, extra = 0;
    pays.forEach(function (p) {
      var left = int(p.amount_minor); paid += left;
      for (var i = 0; i < rows.length && left > 0; i++) {
        var need = rows[i].amount - rows[i].paid; if (need <= 0) continue;
        var take = Math.min(need, left); rows[i].paid += take; left -= take;
      }
      extra += left;
    });
    var total = rows.reduce(function (s, r) { return s + r.amount; }, 0), overdue = 0, nextDue = null;
    rows.forEach(function (r) {
      if (r.paid >= r.amount) r.state = 'paid';
      else if (plan.status === 'settled' || plan.status === 'cancelled') r.state = plan.status;
      else if (r.due_date < asOf) { r.state = r.paid > 0 ? 'partial_overdue' : 'overdue'; overdue += r.amount - r.paid; }
      else if (r.paid > 0) r.state = 'partial';
      else if (diffDays(asOf, r.due_date) <= 7) r.state = 'due_soon';
      if (!nextDue && r.paid < r.amount && plan.status !== 'settled' && plan.status !== 'cancelled') nextDue = r;
    });
    var remaining = plan.status === 'settled' || plan.status === 'cancelled' ? 0 : Math.max(total - paid, 0);
    return { rows: rows, total: total, paid: paid, extra: extra, remaining: remaining, overdue: overdue, nextDue: nextDue,
             paidCount: rows.filter(function (r) { return r.state === 'paid'; }).length };
  }

  // card-plan rows: billed / upcoming
  function cardPlanRows(data, plan, asOf) {
    asOf = asOf || today();
    var rows = liveRows(data, plan.id), billedN = 0, remaining = 0, nextDue = null;
    var out = rows.map(function (s) {
      var amt = rowAmount(s), st;
      if (plan.status === 'cancelled') st = 'cancelled';
      else if (plan.status === 'settled' && plan.status_date && s.due_date > plan.status_date) st = 'settled';
      else if (plan.status === 'paused' && plan.status_date && s.due_date > plan.status_date) st = 'paused';
      else if (s.due_date <= asOf) { st = 'billed'; billedN++; }
      else { st = 'upcoming'; remaining += amt; if (!nextDue) nextDue = { due_date: s.due_date, amount: amt, seq: s.seq }; }
      return { id: s.id, seq: s.seq, due_date: s.due_date, amount: amt, principal: int(s.principal_minor), interest: int(s.interest_minor),
               estimate: s.actual_amount_minor === null || s.actual_amount_minor === undefined, state: st };
    });
    return { rows: out, billedCount: billedN, remaining: remaining, nextDue: nextDue,
             total: out.reduce(function (s, r) { return s + r.amount; }, 0) };
  }

  function planStatus(data, plan, asOf) { return plan.card_id ? cardPlanRows(data, plan, asOf) : allocatePlan(data, plan, asOf); }

  // ---------- workspace summary (one currency) ----------
  function summary(data, cur, asOf) {
    asOf = asOf || today();
    var cards = (data.credit_cards || []).filter(function (c) { return c.currency === cur; });
    var s = { currency: cur, cards: [], cardDebt: 0, shopDebt: 0, totalDebt: 0, limit: 0, used: 0, overdue: 0,
              dueNext30: 0, interestPaid: 0, activePlans: 0, monthlyInstallments: 0 };
    cards.forEach(function (c) {
      var st = cardStatus(data, c, asOf); st.card = c; s.cards.push(st);
      if (c.status === 'archived' && st.totalDebt === 0) return;
      s.cardDebt += st.totalDebt; s.limit += st.limit; s.used += st.used;
    });
    var end = addDays(asOf, 30), ym = monthKey(asOf);
    (data.installment_plans || []).forEach(function (p) {
      if (p.currency !== cur || (p.purchase_date && p.purchase_date > asOf)) return;
      var ps = planStatus(data, p, asOf);
      if (p.status === 'active' || p.status === 'paused') s.activePlans++;
      if (!p.card_id) { s.shopDebt += ps.remaining; s.overdue += ps.overdue || 0; }
      ps.rows.forEach(function (r) {
        if (r.due_date > asOf && r.due_date <= end && (r.state === 'upcoming' || r.state === 'due_soon' || r.state === 'partial')) s.dueNext30 += r.amount - (r.paid || 0);
        if (monthKey(r.due_date) === ym && r.state !== 'cancelled' && r.state !== 'settled' && r.state !== 'paused') s.monthlyInstallments += r.amount;
      });
    });
    (data.debt_payments || []).forEach(function (pm) {
      if (pm.currency === cur && pm.status === 'confirmed') s.interestPaid += int(pm.interest_minor) + int(pm.fee_minor);
    });
    s.totalDebt = s.cardDebt + s.shopDebt;
    s.utilization = s.limit ? s.used / s.limit : null;
    return s;
  }

  // ---------- calendar ----------
  function calendar(data, ym, cur) {
    var ev = [], first = ym + '-01', last = dayInMonth(ym, 31);
    var inCur = function (c) { return !cur || c === cur; };
    (data.credit_cards || []).forEach(function (c) {
      if (c.status !== 'active' || !inCur(c.currency)) return;
      if (c.due_day) ev.push({ date: dayInMonth(ym, c.due_day), type: 'card_due', currency: c.currency, amount: null, title: 'ครบกำหนดชำระ ' + c.name, ref: c.id, color: c.color });
      if (c.statement_day) ev.push({ date: dayInMonth(ym, c.statement_day), type: 'statement', currency: c.currency, amount: null, title: 'วันตัดรอบ ' + c.name, ref: c.id, color: c.color });
    });
    (data.installment_plans || []).forEach(function (p) {
      if (!inCur(p.currency)) return;
      planStatus(data, p).rows.forEach(function (r) {
        if (r.due_date < first || r.due_date > last || r.state === 'cancelled' || r.state === 'settled' || r.state === 'paused') return;
        ev.push({ date: r.due_date, type: p.card_id ? 'installment_card' : 'installment', currency: p.currency, amount: r.amount,
                  title: p.product + ' งวด ' + r.seq + '/' + p.months, ref: p.id, state: r.state, estimate: r.estimate });
      });
    });
    (data.debt_transfers || []).forEach(function (t) {
      if (!inCur(t.currency) || t.status === 'cancelled' || t.status === 'failed') return;
      if (t.effective_date >= first && t.effective_date <= last)
        ev.push({ date: t.effective_date, type: 'transfer', currency: t.currency, amount: int(t.amount_minor), title: TRANSFER_TYPES[t.type] || t.type, ref: t.id, state: t.status });
    });
    (data.debt_payments || []).forEach(function (pm) {
      if (!inCur(pm.currency) || pm.status !== 'confirmed') return;
      if (pm.paid_on >= first && pm.paid_on <= last)
        ev.push({ date: pm.paid_on, type: 'payment', currency: pm.currency, amount: int(pm.amount_minor), title: 'ชำระแล้ว', ref: pm.id });
    });
    ev.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    return ev;
  }

  // ---------- analytics ----------
  function monthEnd(ym) { return dayInMonth(ym, 31); }
  function trend(data, cur, months, asOf) {
    asOf = asOf || today(); months = months || 6;
    var out = [], ym0 = monthKey(asOf);
    for (var k = months - 1; k >= 0; k--) {
      var ym = monthKey(addMonths(ym0 + '-01', -k)), end = k === 0 ? asOf : monthEnd(ym);
      var s = summary(data, cur, end), paid = 0, interest = 0;
      (data.debt_payments || []).forEach(function (pm) {
        if (pm.currency === cur && pm.status === 'confirmed' && monthKey(pm.paid_on) === ym) {
          paid += int(pm.amount_minor); interest += int(pm.interest_minor) + int(pm.fee_minor);
        }
      });
      out.push({ month: ym, debt: s.totalDebt, cardDebt: s.cardDebt, shopDebt: s.shopDebt, paid: paid, interest: interest });
    }
    return out;
  }
  function byCategory(data, cur) {
    var m = {};
    (data.installment_plans || []).forEach(function (p) {
      if (p.currency !== cur || p.status === 'cancelled') return;
      var k = p.category || 'อื่นๆ'; m[k] = (m[k] || 0) + int(p.financed_minor);
    });
    return Object.keys(m).map(function (k) { return { category: k, amount: m[k] }; }).sort(function (a, b) { return b.amount - a.amount; });
  }

  // ---------- payoff planner ----------
  // debts: [{id, name, balance, aprBp, minPayment}] (same currency) · budget: per month
  // assumptions stated in the result: interest monthly = balance × APR/12 on the opening balance; no new spending;
  // minimums paid first, everything left goes to the target; freed minimums roll over.
  function payoff(debts, budget, strategy, priorities) {
    budget = int(budget);
    var list = debts.filter(function (d) { return int(d.balance) > 0; }).map(function (d, i) {
      return { id: d.id, name: d.name, bal: int(d.balance), apr: int(d.aprBp), min: Math.max(int(d.minPayment), 0), order: i, paidOffMonth: null, interest: 0 };
    });
    var res = { strategy: strategy, budget: budget, feasible: true, months: 0, totalInterest: 0, totalPaid: 0, order: [], timeline: [],
                assumptions: ['ดอกเบี้ยรายเดือน = ยอดคงเหลือ × APR ÷ 12', 'ไม่มีการใช้จ่ายเพิ่มบนบัตรระหว่างแผน',
                              'จ่ายขั้นต่ำทุกก้อนก่อน ส่วนที่เหลือโปะก้อนเป้าหมาย', 'ก้อนที่ปิดแล้ว ยอดขั้นต่ำจะโยกไปก้อนถัดไป'] };
    if (!list.length) return res;
    var minSum = list.reduce(function (s, d) { return s + Math.min(d.min, d.bal); }, 0);
    if (budget < minSum) { res.feasible = false; res.reason = 'budget_below_minimum'; res.minimumNeeded = minSum; return res; }
    var rank;
    if (strategy === 'avalanche') rank = function (a, b) { return b.apr - a.apr || a.bal - b.bal || a.order - b.order; };
    else if (strategy === 'custom') {
      var pr = (priorities || []).map(String);
      rank = function (a, b) {
        var x = pr.indexOf(String(a.id)), y = pr.indexOf(String(b.id));
        return (x < 0 ? 999 : x) - (y < 0 ? 999 : y) || a.order - b.order;
      };
    } else rank = function (a, b) { return a.bal - b.bal || b.apr - a.apr || a.order - b.order; };
    var month = 0;
    while (list.some(function (d) { return d.bal > 0; })) {
      month++;
      if (month > 600) { res.feasible = false; res.reason = 'never_paid_off'; break; }
      var interestThis = 0;
      list.forEach(function (d) {
        if (d.bal <= 0) return;
        var i = divRound(d.bal * d.apr, 120000); d.bal += i; d.interest += i; interestThis += i;
      });
      var left = budget;
      list.forEach(function (d) { if (d.bal <= 0) return; var p = Math.min(d.min, d.bal, left); d.bal -= p; left -= p; });
      list.filter(function (d) { return d.bal > 0; }).sort(rank).forEach(function (d) {
        var p = Math.min(d.bal, left); d.bal -= p; left -= p;
      });
      var paidThis = budget - left;
      res.totalPaid += paidThis; res.totalInterest += interestThis;
      list.forEach(function (d) { if (d.bal <= 0 && d.paidOffMonth === null) { d.paidOffMonth = month; res.order.push({ id: d.id, name: d.name, month: month }); } });
      res.timeline.push({ month: month, remaining: list.reduce(function (s, d) { return s + Math.max(d.bal, 0); }, 0), interest: interestThis, paid: paidThis });
      if (interestThis >= paidThis && month > 1) { res.feasible = false; res.reason = 'interest_exceeds_payment'; break; }
    }
    res.months = month;
    res.perDebt = list.map(function (d) { return { id: d.id, name: d.name, interest: d.interest, paidOffMonth: d.paidOffMonth }; });
    return res;
  }
  function minimumPayment(cardSt, card) {
    // estimate only: max(3% of balance, 1,000 KRW / 300 THB … capped at balance) — user can override
    var bal = Math.max(int(cardSt.balance), 0); if (!bal) return 0;
    var floor = card.currency === 'KRW' ? 10000 : 30000;
    return Math.min(bal, Math.max(divRound(bal * 3, 100), floor));
  }

  var TRANSFER_TYPES = {
    balance_transfer: 'โอนหนี้ (Balance transfer)', card_payment: 'ใช้บัตรจ่ายบัตร (Card payment)',
    cash_advance: 'กดเงินสด (Cash advance)', restructure: 'ปรับโครงสร้างหนี้ (Restructure)'
  };
  var METHODS = {
    zero: 'ผ่อน 0% (ไม่มีดอกเบี้ย)', fixed: 'ดอกคงที่ (Flat rate)', reducing: 'ลดต้นลดดอก (Reducing balance)', custom: 'กำหนดเองรายงวด (Custom)'
  };

  // ---------- export ----------
  function csvCell(v) { v = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function toCSV(rows, cols) {
    return '﻿' + [cols.join(',')].concat(rows.map(function (r) { return cols.map(function (c) { return csvCell(r[c]); }).join(','); })).join('\n');
  }

  var api = {
    CUR: CUR, TRANSFER_TYPES: TRANSFER_TYPES, METHODS: METHODS,
    int: int, divRound: divRound, toMinor: toMinor, toMajor: toMajor, fmt: fmt, inputValue: inputValue, convert: convert,
    addMonths: addMonths, addDays: addDays, today: today, monthKey: monthKey, dayInMonth: dayInMonth, diffDays: diffDays,
    buildSchedule: buildSchedule, scheduleTotals: scheduleTotals, liveRows: liveRows, rowAmount: rowAmount,
    cardStatus: cardStatus, allocatePlan: allocatePlan, cardPlanRows: cardPlanRows, planStatus: planStatus,
    summary: summary, calendar: calendar, trend: trend, byCategory: byCategory, payoff: payoff, minimumPayment: minimumPayment,
    toCSV: toCSV
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KfpDebt = api;
})(typeof window !== 'undefined' ? window : this);
