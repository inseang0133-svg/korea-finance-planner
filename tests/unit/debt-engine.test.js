// node --test tests/unit/debt-engine.test.js
// Pure engine tests + parity with the SQL schedule builder (when a local Postgres is reachable: PGHOST/PGPORT set).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const D = require('../../debt-engine.js');

test('money parsing and formatting', () => {
  assert.equal(D.toMinor('1,234.5', 'THB'), 123450);
  assert.equal(D.toMinor('1234', 'KRW'), 1234);
  assert.equal(D.toMinor('12.5', 'KRW'), null, 'won has no decimals');
  assert.equal(D.toMinor('1.234', 'THB'), null, 'baht has 2 decimals');
  assert.equal(D.toMinor('abc', 'THB'), null);
  assert.equal(D.fmt(123450, 'THB'), '฿1,234.50');
  assert.equal(D.fmt(1500000, 'KRW'), '₩1,500,000');
  assert.equal(D.fmt(-5000, 'KRW'), '−₩5,000');
  assert.equal(D.inputValue(123450, 'THB'), '1234.5');
  assert.equal(D.convert(10000, 'THB', 'KRW', 40), 4000, '฿100 → ₩4,000 at 40');
  assert.equal(D.convert(4000, 'KRW', 'THB', 40), 10000);
});

test('dates follow Postgres month arithmetic', () => {
  assert.equal(D.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(D.addMonths('2026-01-31', 2), '2026-03-31');
  assert.equal(D.addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(D.addMonths('2026-11-14', 14), '2028-01-14');
  assert.equal(D.addMonths('2026-03-15', -3), '2025-12-15');
  assert.equal(D.dayInMonth('2026-02', 31), '2026-02-28');
});

test('schedule: zero / fixed / reducing / custom', () => {
  let r = D.buildSchedule(1000000, 0, 'zero', 3, '2026-01-31');
  assert.deepEqual(r.map(x => x.principal), [333333, 333333, 333334]);
  assert.deepEqual(r.map(x => x.due_date), ['2026-01-31', '2026-02-28', '2026-03-31']);
  r = D.buildSchedule(1200000, 1200, 'fixed', 12, '2026-01-10');
  assert.equal(D.scheduleTotals(r).interest, 144000);
  assert.equal(D.scheduleTotals(r).principal, 1200000);
  r = D.buildSchedule(1000000, 1200, 'reducing', 12, '2026-01-10');
  assert.equal(r[0].amount, 88849);
  assert.equal(D.scheduleTotals(r).principal, 1000000);
  assert.equal(r[0].interest, 10000);
  r = D.buildSchedule(0, 0, 'custom', 0, null, [{ due_date: '2026-02-01', amount: 500 }, { due_date: '2026-03-01', amount: 700 }]);
  assert.equal(r.length, 2);
  assert.throws(() => D.buildSchedule(0, 0, 'custom', 0, null, [{ due_date: '2026-03-01', amount: 5 }, { due_date: '2026-02-01', amount: 5 }]));
  assert.throws(() => D.buildSchedule(100, 0, 'zero', 0, '2026-01-01'));
  assert.throws(() => D.buildSchedule(100, 0, 'weird', 2, '2026-01-01'));
  // rate 0 on fixed/reducing behaves like zero
  assert.deepEqual(D.buildSchedule(1000, 0, 'reducing', 3, '2026-01-01').map(x => x.amount), [333, 333, 334]);
});

function fixture() {
  const card = { id: 'c1', name: 'KB', currency: 'KRW', credit_limit_minor: 5000000, opening_balance_minor: 300000, opening_date: '2026-09-01',
                 installment_mode: 'per_period', status: 'active', due_day: 14, statement_day: 25, color: '#d4af37' };
  const card2 = { ...card, id: 'c2', name: 'Shinhan', opening_balance_minor: 0, installment_mode: 'full_hold', credit_limit_minor: 3000000 };
  const plan = { id: 'p1', card_id: 'c1', currency: 'KRW', product: 'iPhone', category: 'มือถือ', financed_minor: 1200000, months: 12,
                 method: 'zero', revision: 1, status: 'active', first_due_date: '2026-10-14' };
  const shop = { id: 'p2', card_id: null, currency: 'KRW', product: 'Bike', category: 'ยานพาหนะ', financed_minor: 300000, months: 3,
                 method: 'zero', revision: 1, status: 'active', first_due_date: '2026-10-01' };
  const sched = (p) => D.buildSchedule(p.financed_minor, 0, 'zero', p.months, p.first_due_date).map((r, i) => ({
    id: p.id + '-' + r.seq, plan_id: p.id, revision: 1, seq: r.seq, due_date: r.due_date, principal_minor: r.principal,
    interest_minor: 0, amount_minor: r.amount, actual_amount_minor: null, superseded_at: null }));
  return {
    credit_cards: [card, card2], installment_plans: [plan, shop],
    installment_schedules: [...sched(plan), ...sched(shop)],
    debt_transfers: [], debt_payments: [], debt_adjustments: []
  };
}

test('card balance: per_period vs full_hold, payments, transfers, adjustments', () => {
  const d = fixture();
  let s = D.cardStatus(d, d.credit_cards[0], '2026-11-20');
  assert.equal(s.balance, 300000 + 200000, 'opening + 2 billed rows');
  assert.equal(s.unbilled, 1000000);
  assert.equal(s.used, 500000, 'per_period uses billed only');
  assert.equal(s.totalDebt, 1500000);
  d.debt_payments.push({ id: 'pm1', card_id: 'c1', status: 'confirmed', paid_on: '2026-11-14', amount_minor: 250000, currency: 'KRW' });
  d.debt_adjustments.push({ id: 'a1', card_id: 'c1', status: 'active', effective_date: '2026-11-02', amount_minor: -5000 });
  s = D.cardStatus(d, d.credit_cards[0], '2026-11-20');
  assert.equal(s.balance, 245000);
  // balance transfer 6 installments → plan on c2 carries the money (no double count); fee hits c2 directly
  d.debt_transfers.push({ id: 't1', type: 'balance_transfer', from_card_id: 'c1', to_card_id: 'c2', status: 'confirmed', effective_date: '2026-11-03',
                          amount_minor: 200000, dest_amount_minor: 200000, fee_minor: 2000, installments: 2, currency: 'KRW' });
  const tp = { id: 'p3', card_id: 'c2', currency: 'KRW', product: 'BT', financed_minor: 200000, months: 2, method: 'zero', revision: 1,
               status: 'active', first_due_date: '2026-12-03', transfer_id: 't1' };
  d.installment_plans.push(tp);
  D.buildSchedule(200000, 0, 'zero', 2, '2026-12-03').forEach(r => d.installment_schedules.push({ id: 'p3-' + r.seq, plan_id: 'p3', revision: 1,
    seq: r.seq, due_date: r.due_date, principal_minor: r.principal, interest_minor: 0, amount_minor: r.amount, actual_amount_minor: null }));
  const a = D.cardStatus(d, d.credit_cards[0], '2026-11-20'), b = D.cardStatus(d, d.credit_cards[1], '2026-11-20');
  assert.equal(a.balance, 45000);
  assert.equal(b.balance, 2000, 'only the fee is billed now');
  assert.equal(b.used, 202000, 'full_hold holds the whole unbilled principal');
  assert.equal(a.totalDebt + b.totalDebt, 45000 + 1000000 + 202000, 'no double counting');
  // reversal
  d.debt_transfers[0].status = 'cancelled'; tp.status = 'cancelled';
  assert.equal(D.cardStatus(d, d.credit_cards[1], '2026-11-20').totalDebt, 0);
  // confirmed statement amount overrides the estimate
  d.installment_schedules.find(x => x.id === 'p1-1').actual_amount_minor = 101000;
  assert.equal(D.cardStatus(d, d.credit_cards[0], '2026-11-20').balance, 246000, 'transfer reversed (+200,000) and row 1 confirmed at 101,000 (+1,000)');
});

test('shop plan: FIFO allocation, overdue, settlement', () => {
  const d = fixture(), shop = d.installment_plans[1];
  d.debt_payments.push({ id: 'x1', plan_id: 'p2', status: 'confirmed', paid_on: '2026-10-01', amount_minor: 150000 });
  let a = D.allocatePlan(d, shop, '2026-11-05');
  assert.deepEqual(a.rows.map(r => r.paid), [100000, 50000, 0]);
  assert.equal(a.rows[1].state, 'partial_overdue');
  assert.equal(a.overdue, 50000);
  assert.equal(a.remaining, 150000);
  d.debt_payments.push({ id: 'x2', plan_id: 'p2', status: 'cancelled', paid_on: '2026-10-02', amount_minor: 999999 });
  assert.equal(D.allocatePlan(d, shop, '2026-11-05').remaining, 150000, 'cancelled payments ignored');
  shop.status = 'settled'; shop.status_date = '2026-11-06';
  assert.equal(D.allocatePlan(d, shop, '2026-11-07').remaining, 0);
});

test('summary, calendar, trend', () => {
  const d = fixture();
  const s = D.summary(d, 'KRW', '2026-11-20');
  assert.equal(s.cardDebt, 1500000);
  assert.equal(s.shopDebt, 300000);
  assert.equal(s.totalDebt, 1800000);
  assert.equal(D.summary(d, 'THB', '2026-11-20').totalDebt, 0, 'workspaces are separate');
  const ev = D.calendar(d, '2026-11', 'KRW');
  assert.ok(ev.some(e => e.type === 'card_due' && e.date === '2026-11-14'));
  assert.ok(ev.some(e => e.type === 'installment' && e.date === '2026-11-01'));
  assert.ok(ev.some(e => e.type === 'installment_card' && e.date === '2026-11-14'));
  const t = D.trend(d, 'KRW', 3, '2026-11-20');
  assert.deepEqual(t.map(x => x.month), ['2026-09', '2026-10', '2026-11']);
});

test('payoff planner: snowball vs avalanche, infeasible budgets', () => {
  const debts = [{ id: 'a', name: 'A', balance: 100000, aprBp: 2400, minPayment: 5000 },
                 { id: 'b', name: 'B', balance: 300000, aprBp: 1200, minPayment: 10000 }];
  const sb = D.payoff(debts, 50000, 'snowball'), av = D.payoff(debts, 50000, 'avalanche');
  assert.ok(sb.feasible && av.feasible);
  assert.equal(sb.order[0].id, 'a');
  assert.ok(av.totalInterest <= sb.totalInterest, 'avalanche never pays more interest');
  assert.equal(sb.totalPaid, 400000 + sb.totalInterest);
  const cu = D.payoff(debts, 50000, 'custom', ['b', 'a']);
  assert.equal(cu.order[0].id, 'b');
  assert.equal(D.payoff(debts, 1000, 'snowball').reason, 'budget_below_minimum');
  assert.ok(D.payoff([{ id: 'x', balance: 1000000, aprBp: 10000, minPayment: 1 }], 1, 'snowball').feasible === false);
});

test('CSV export', () => {
  const csv = D.toCSV([{ a: 'x,y', b: 'he said "hi"' }], ['a', 'b']);
  assert.equal(csv, '﻿a,b\n"x,y","he said ""hi"""');
});

test('parity with SQL kfp_debt_build_schedule', { skip: !process.env.PGHOST }, () => {
  const cases = [];
  let seed = 7; const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 120; i++) {
    const m = ['zero', 'fixed', 'reducing'][i % 3];
    cases.push([1 + rnd(99999999), m === 'zero' ? 0 : rnd(3000), m, 1 + rnd(120), ['2026-01-31', '2026-02-28', '2024-01-29', '2026-05-15', '2026-08-31', '2026-12-30', '2027-03-01'][rnd(7)]]);
  }
  const values = cases.map((c, i) => `(${i},${c[0]},${c[1]},'${c[2]}',${c[3]},'${c[4]}'::date)`).join(',');
  const sql = `select i, s.seq, s.due_date, s.principal, s.interest from (values ${values}) v(i,f,r,m,n,d),
               lateral public.kfp_debt_build_schedule(v.f::bigint, v.r::int, v.m, v.n::int, v.d) s order by i, s.seq`;
  const out = execFileSync('psql', ['-X', '-At', '-F', '|', '-d', process.env.PGDATABASE || 'kfp_test', '-c', sql], { encoding: 'utf8' });
  const got = {};
  out.trim().split('\n').forEach(l => { const [i, seq, due, p, it] = l.split('|'); (got[i] = got[i] || []).push([+seq, due, +p, +it]); });
  cases.forEach((c, i) => {
    const js = D.buildSchedule(c[0], c[1], c[2], c[3], c[4]).map(r => [r.seq, r.due_date, r.principal, r.interest]);
    assert.deepEqual(js, got[i], 'case ' + i + ' ' + JSON.stringify(c));
  });
});
