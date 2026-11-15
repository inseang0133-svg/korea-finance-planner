/* Smart Credit & Debt — page UI (credit-debt.html).
 * Calculations: debt-engine.js (KfpDebt) · data: debt-api.js (kfpDebtApi).
 * The mode from get_my_debt_access() only decides what is SHOWN; every write is re-checked by the server. */
(function () {
  'use strict';
  var D = window.KfpDebt, API = window.kfpDebtApi;
  if (!D || !API) return;
  var PREF = 'kfp_debt_ui_v1';
  var TABS = [
    ['cards', '💳', 'บัตร', 'Cards'], ['plans', '🧾', 'ผ่อน', 'Installments'], ['transfers', '🔁', 'โอนหนี้', 'Transfers'],
    ['payments', '✅', 'ชำระ', 'Payments'], ['calendar', '📅', 'ปฏิทิน', 'Calendar'], ['analytics', '📊', 'วิเคราะห์', 'Analytics'],
    ['planner', '🎯', 'แผนปลดหนี้', 'Payoff planner']
  ];
  var PLAN_STATUS = { active: 'กำลังผ่อน', paused: 'พักชำระ', settled: 'ปิดยอดแล้ว', cancelled: 'ยกเลิก' };
  var TR_STATUS = { draft: 'ร่าง', pending: 'รอดำเนินการ', confirmed: 'ยืนยันแล้ว', failed: 'ไม่สำเร็จ', cancelled: 'ยกเลิก' };
  var PAY_KIND = { full: 'จ่ายเต็มยอด', partial: 'จ่ายบางส่วน', minimum: 'จ่ายขั้นต่ำ', statement: 'จ่ายตาม statement', early: 'จ่ายล่วงหน้า',
                   extra_principal: 'โปะเงินต้น', settlement: 'ปิดยอดทั้งหมด' };
  var PAY_METHOD = { bank_transfer: 'โอนธนาคาร', cash: 'เงินสด', auto_debit: 'หักบัญชีอัตโนมัติ', card: 'บัตร', other: 'อื่นๆ' };
  var ADJ_KIND = { purchase: 'ยอดใช้จ่ายใหม่', interest: 'ดอกเบี้ย', fee: 'ค่าธรรมเนียม', refund: 'คืนเงิน/เครดิต', reconcile: 'กระทบยอดกับ statement', other: 'อื่นๆ (± ตามที่กรอก)' };
  var ROW_STATE = { paid: ['ชำระแล้ว', 'ok'], partial: ['ชำระบางส่วน', 'warn'], overdue: ['เลยกำหนด', 'bad'], partial_overdue: ['ค้างบางส่วน', 'bad'],
                    due_soon: ['ใกล้ครบกำหนด', 'warn'], upcoming: ['รอถึงกำหนด', 'muted'], billed: ['เรียกเก็บแล้ว', 'ok'],
                    settled: ['ปิดยอด', 'muted'], cancelled: ['ยกเลิก', 'muted'], paused: ['พัก', 'muted'] };

  var S = { access: { mode: 'loading' }, data: API.EMPTY(), ws: null, tab: 'cards', demo: false, month: D.monthKey(D.today()),
            planFilter: 'open', busy: false, error: null, offline: false, cachedAt: null, rate: null, planner: null, day: null };
  var root, modal, toastEl;

  /* ------------------------------------------------------------ utils */
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function prefs() { try { return JSON.parse(localStorage.getItem(PREF) || '{}') || {}; } catch (_) { return {}; } }
  function savePrefs() { try { localStorage.setItem(PREF, JSON.stringify({ ws: S.ws, tab: S.tab, rate: S.rate })); } catch (_) {} }
  function krwPerThb() {
    if (S.rate > 0) return S.rate;
    var r = Number(localStorage.getItem('rate'));
    return r > 0 && r < 1 ? Math.round(1 / r * 100) / 100 : 40;
  }
  function fmt(m, c) { return D.fmt(m, c); }
  function thDate(d, opt) {
    if (!d) return '-';
    try { return new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('th-TH', opt || { day: 'numeric', month: 'short', year: '2-digit' }); } catch (_) { return d; }
  }
  function monthName(ym) { try { return new Date(ym + '-01T00:00:00').toLocaleDateString('th-TH', { month: 'long', year: 'numeric' }); } catch (_) { return ym; } }
  function pct(x) { return x === null || x === undefined ? '-' : (Math.round(x * 1000) / 10) + '%'; }
  function bp(x) { return (Math.round(D.int(x)) / 100).toString().replace(/\.0+$/, '') + '%'; }
  function canWrite() { return S.access.mode === 'full' && !S.demo; }
  function viewData() { return S.demo ? demoData() : S.data; }
  function cards(cur) { return viewData().credit_cards.filter(function (c) { return !cur || c.currency === cur; }); }
  function plans(cur) { return viewData().installment_plans.filter(function (p) { return !cur || p.currency === cur; }); }
  function findCard(id) { return viewData().credit_cards.find(function (c) { return c.id === id; }); }
  function findPlan(id) { return viewData().installment_plans.find(function (p) { return p.id === id; }); }
  function hasData(d) { d = d || S.data; return d.credit_cards.length + d.installment_plans.length + d.debt_transfers.length + d.debt_payments.length > 0; }
  function curLabel(c) { return c === 'KRW' ? '₩ วอน (KRW)' : '฿ บาท (THB)'; }
  function badge(text, tone) { return '<span class="cd-badge cd-' + (tone || 'muted') + '">' + esc(text) + '</span>'; }
  function btn(act, label, extra) {
    extra = extra || {};
    var attrs = Object.keys(extra).filter(function (k) { return k !== 'cls' && extra[k] !== null && extra[k] !== undefined; }).map(function (k) { return k + '="' + esc(extra[k]) + '"'; }).join(' ');
    return '<button type="button" class="cd-btn ' + (extra.cls || '') + '" data-act="' + act + '" ' + attrs + '>' + label + '</button>';
  }
  function wbtn(act, label, extra) { return canWrite() ? btn(act, label, extra) : ''; }

  function toast(msg, tone) {
    if (!toastEl) return;
    toastEl.textContent = msg; toastEl.className = 'cd-toast show cd-t-' + (tone || 'ok');
    clearTimeout(toast._t); toast._t = setTimeout(function () { toastEl.className = 'cd-toast'; }, tone === 'bad' ? 5200 : 3000);
  }

  /* ------------------------------------------------------------ demo data (locked / guest) */
  var DEMO = null;
  function demoData() {
    if (DEMO) return DEMO;
    var t = D.today(), m = function (k) { return D.addMonths(t, k); };
    var d = API.EMPTY(), sid = 1;
    function card(id, name, bank, cur, limit, open, due, st, apr, mode, color) {
      d.credit_cards.push({ id: id, name: name, bank: bank, currency: cur, last4: String(1000 + sid * 731).slice(-4), credit_limit_minor: limit,
        opening_balance_minor: open, opening_date: m(-3), statement_day: st, due_day: due, apr_bp: apr, installment_mode: mode,
        color: color, icon: '💳', notes: '', status: 'active', version: 1 });
      sid++;
    }
    function plan(id, card, cur, product, cat, financed, method, rate, months, first) {
      d.installment_plans.push({ id: id, card_id: card, currency: cur, product: product, category: cat, merchant: '', purchase_date: D.addMonths(first, -1),
        original_minor: financed, down_minor: 0, financed_minor: financed, rate_bp: rate, method: method, months: months, first_due_date: first,
        status: 'active', revision: 1, version: 1 });
      D.buildSchedule(financed, rate, method, months, first).forEach(function (r) {
        d.installment_schedules.push({ id: sid++, plan_id: id, revision: 1, seq: r.seq, due_date: r.due_date, principal_minor: r.principal,
          interest_minor: r.interest, amount_minor: r.amount, actual_amount_minor: null, superseded_at: null });
      });
    }
    card('demo-kb', 'KB Kookmin', 'KB', 'KRW', 5000000, 420000, 14, 25, 1590, 'per_period', '#e8be46');
    card('demo-sh', 'Shinhan Deep', 'Shinhan', 'KRW', 3000000, 150000, 25, 10, 1890, 'full_hold', '#4aa3ff');
    card('demo-scb', 'SCB M', 'SCB', 'THB', 8000000, 1250000, 5, 20, 1600, 'per_period', '#7c5cff');
    card('demo-ktc', 'KTC', 'KTC', 'THB', 5000000, 380000, 12, 27, 1600, 'full_hold', '#3ddc97');
    plan('demo-p1', 'demo-kb', 'KRW', 'iPhone 17', 'มือถือ', 1500000, 'zero', 0, 10, m(-2).slice(0, 8) + '14');
    plan('demo-p2', 'demo-sh', 'KRW', 'ตู้เย็น', 'เครื่องใช้ไฟฟ้า', 900000, 'fixed', 690, 6, m(-1).slice(0, 8) + '25');
    plan('demo-p3', 'demo-scb', 'THB', 'MacBook Air', 'คอมพิวเตอร์', 3990000, 'zero', 0, 10, m(-4).slice(0, 8) + '05');
    plan('demo-p4', null, 'THB', 'มอเตอร์ไซค์', 'ยานพาหนะ', 4500000, 'reducing', 1500, 24, m(-5).slice(0, 8) + '01');
    d.debt_payments.push({ id: 'demo-pay1', card_id: 'demo-kb', currency: 'KRW', kind: 'statement', amount_minor: 300000, principal_minor: 0, interest_minor: 0, fee_minor: 0, paid_on: m(-1), method: 'auto_debit', status: 'confirmed' });
    d.debt_payments.push({ id: 'demo-pay2', card_id: 'demo-scb', currency: 'THB', kind: 'statement', amount_minor: 900000, principal_minor: 0, interest_minor: 12000, fee_minor: 0, paid_on: m(-1), method: 'bank_transfer', status: 'confirmed' });
    for (var k = 5; k >= 1; k--) d.debt_payments.push({ id: 'demo-mc' + k, plan_id: 'demo-p4', currency: 'THB', kind: 'partial', amount_minor: 218200, principal_minor: 0, interest_minor: 0, fee_minor: 0, paid_on: m(-k).slice(0, 8) + '01', method: 'bank_transfer', status: 'confirmed' });
    d.debt_transfers.push({ id: 'demo-t1', type: 'balance_transfer', from_card_id: 'demo-ktc', to_card_id: 'demo-scb', currency: 'THB', amount_minor: 1500000, fee_minor: 0, rate_bp: 0, installments: 0, transfer_date: m(-1), effective_date: m(-1), status: 'confirmed', dest_currency: 'THB', dest_amount_minor: 1500000, related_ref: '', version: 2 });
    DEMO = d; return d;
  }

  /* ------------------------------------------------------------ load */
  function load(quiet) {
    if (!quiet) { S.access = { mode: 'loading' }; render(); }
    return API.load().then(function (r) {
      if (r.pending) {                                   // signed in on this device, auth still starting → wait for kfp:auth-ready
        clearTimeout(load._w); load._w = setTimeout(function () { if (S.access.mode === 'loading') { S.error = 'เชื่อมต่อบัญชีไม่สำเร็จ'; S.access = { mode: 'error' }; render(); } }, 12000);
        return;
      }
      clearTimeout(load._w);
      S.access = r.access || { mode: 'locked' }; S.data = r.data; S.offline = !!r.offline; S.cachedAt = r.cachedAt || null; S.error = null;
      if (S.access.mode !== 'guest' && S.access.mode !== 'locked') S.demo = false;
      render();
    }, function (e) { S.error = API.message(e); S.access = { mode: 'error' }; render(); });
  }
  function runF(p, ok) { return run(p, ok, true); }
  function run(p, ok, rethrow) {
    if (S.busy) return Promise.resolve(false);
    S.busy = true; root.classList.add('cd-busy');
    return p.then(function (res) {
      if (ok) toast(ok, 'ok');
      return load(true).then(function () { return res || true; });
    }, function (e) {
      var c = API.code(e);
      toast(API.message(e), 'bad');
      if (c === 'locked' || c === 'conflict') load(true);
      if (rethrow) throw e;
      return false;
    }).finally(function () { S.busy = false; root.classList.remove('cd-busy'); });
  }

  /* ------------------------------------------------------------ render: frame */
  function render() {
    if (!root) return;
    var m = S.access.mode, html = '';
    html += banner();
    if (m === 'loading') html += skeleton();
    else if (m === 'error') html += '<div class="cd-state cd-error" role="alert"><div class="cd-state-ico">⚠️</div><h3>โหลดข้อมูลไม่สำเร็จ</h3><p>' + esc(S.error) +
      '</p>' + btn('reload', '↻ ลองใหม่', { cls: 'cd-primary' }) + '</div>';
    else if ((m === 'locked' || m === 'guest') && !S.demo) html += lockedIntro();
    else html += workspaceTabs() + '<div id="cdMain" class="cd-main">' + (S.ws === 'overview' ? overview() : workspace(S.ws)) + '</div>';
    root.innerHTML = html;
    root.setAttribute('data-mode', S.demo ? 'demo' : m);
    if (S.ws !== 'overview' && S.tab === 'analytics') drawCharts();
  }
  function skeleton() {
    return '<div class="cd-skel" aria-busy="true" aria-label="กำลังโหลด"><i></i><i></i><i></i><div><i></i><i></i></div></div>';
  }
  function banner() {
    var a = S.access, m = a.mode, out = '';
    if (S.demo) out = '<div class="cd-banner cd-demo-b" role="status"><b>DEMO</b> ข้อมูลตัวอย่าง — ไม่ใช่ข้อมูลของคุณ ' +
      btn('demo-off', 'ปิดตัวอย่าง') + '<a class="cd-btn cd-primary" href="pricing.html#premium">อัปเกรด Premium</a></div>';
    else if (m === 'read_only') out = '<div class="cd-banner cd-ro" role="status"><span class="cd-b-ico">🔒</span><div><b>โหมดอ่านอย่างเดียว (Read-only)</b>' +
      '<p>' + (a.suspended ? 'บัญชีถูกระงับชั่วคราว' : 'Finance Premium หมดอายุแล้ว') + ' — ข้อมูลทั้งหมดยังอยู่ครบ ดู ปฏิทิน กราฟ และส่งออกได้ แต่เพิ่ม/แก้ไข/ลบไม่ได้จนกว่าจะต่ออายุ</p></div>' +
      (a.suspended ? '' : '<a class="cd-btn cd-primary" href="pricing.html#premium">ต่ออายุ Premium</a>') + '</div>';
    else if (m === 'offline') out = '<div class="cd-banner cd-off" role="status"><span class="cd-b-ico">📴</span><div><b>ออฟไลน์</b><p>แสดงข้อมูลล่าสุดเมื่อ ' +
      esc(new Date(S.cachedAt).toLocaleString('th-TH')) + ' · แก้ไขไม่ได้จนกว่าจะออนไลน์</p></div>' + btn('reload', '↻ เชื่อมต่อใหม่') + '</div>';
    else if (m === 'full' && a.cancel_at_period_end && a.current_period_end) out = '<div class="cd-banner cd-info" role="status"><span class="cd-b-ico">ℹ️</span><div><b>ยกเลิกการต่ออายุแล้ว</b><p>ใช้งานเต็มรูปแบบได้ถึง ' +
      esc(thDate(a.current_period_end, { dateStyle: 'long' })) + ' หลังจากนั้นข้อมูลยังอยู่และดูได้แบบอ่านอย่างเดียว</p></div><a class="cd-btn" href="account.html">จัดการแพ็กเกจ</a></div>';
    return out;
  }
  function lockedIntro() {
    var guest = S.access.mode === 'guest';
    var f = [['💳', 'บัตรเครดิตทุกใบ', 'วงเงิน ยอดค้าง วันตัดรอบ/ครบกำหนด และ % การใช้วงเงิน'],
             ['🧾', 'แผนผ่อน 0% / ดอกคงที่ / ลดต้นลดดอก', 'ตารางงวดอัตโนมัติ ยืนยันยอดจริงตาม statement ได้'],
             ['🔁', 'โอนหนี้ & บัตรจ่ายบัตร (Balance transfer)', 'ยอดย้ายถูกต้อง ไม่นับซ้ำ รองรับข้ามสกุลเงิน'],
             ['📅', 'ปฏิทินครบกำหนด', 'เห็นทุกงวดที่ต้องจ่ายในเดือนเดียว'],
             ['🎯', 'แผนปลดหนี้ Snowball / Avalanche', 'รู้ว่าหมดหนี้เมื่อไร และประหยัดดอกเบี้ยได้เท่าไร'],
             ['฿₩', 'ใช้ได้ทั้งเงินบาทและวอน', 'แยกพื้นที่ THB / KRW พร้อมภาพรวมรวมสองสกุล']];
    return '<section class="cd-intro"><div class="cd-intro-head"><span class="cd-pill">FINANCE PREMIUM</span><h2>จัดการหนี้บัตรเครดิตให้อยู่หมัด</h2>' +
      '<p>Smart Credit & Debt รวมบัตร หนี้ผ่อน และแผนปลดหนี้ไว้ที่เดียว — สำหรับสมาชิก Finance Premium</p></div>' +
      '<div class="cd-feat">' + f.map(function (x) { return '<div class="cd-feat-i"><span>' + x[0] + '</span><b>' + esc(x[1]) + '</b><small>' + esc(x[2]) + '</small></div>'; }).join('') + '</div>' +
      '<div class="cd-intro-cta">' + btn('demo-on', '👀 ดูตัวอย่าง (Demo)', { cls: 'cd-ghost' }) +
      (guest ? btn('login', 'เข้าสู่ระบบ / สมัครสมาชิก', { cls: 'cd-primary' }) : '<a class="cd-btn cd-primary" href="pricing.html#premium" data-act="upgrade">อัปเกรดเป็น Premium</a>') +
      '</div><p class="cd-fine">ข้อมูลเก็บในบัญชีของคุณอย่างปลอดภัย · ไม่เก็บเลขบัตรเต็ม CVV หรือ PIN · ถ้าหมด Premium ข้อมูลยังดูและส่งออกได้</p></section>';
  }
  function workspaceTabs() {
    var t = [['overview', '🌐 ภาพรวม', 'Overview'], ['THB', '฿ บาท', 'THB'], ['KRW', '₩ วอน', 'KRW']];
    return '<nav class="cd-ws" role="tablist" aria-label="พื้นที่สกุลเงิน">' + t.map(function (x) {
      return '<button type="button" role="tab" aria-selected="' + (S.ws === x[0]) + '" class="cd-ws-t' + (S.ws === x[0] ? ' on' : '') + '" data-act="ws" data-ws="' + x[0] + '">' +
        esc(x[1]) + '<small>' + x[2] + '</small></button>';
    }).join('') + '</nav>';
  }

  /* ------------------------------------------------------------ overview */
  function kpi(label, value, sub, tone) {
    return '<div class="cd-kpi' + (tone ? ' cd-k-' + tone : '') + '"><span>' + label + '</span><b>' + value + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</div>';
  }
  function overview() {
    var d = viewData(), t = D.today(), rate = krwPerThb();
    var th = D.summary(d, 'THB', t), kr = D.summary(d, 'KRW', t);
    var disp = prefs().disp === 'KRW' ? 'KRW' : 'THB';
    var total = D.convert(th.totalDebt, 'THB', disp, rate) + D.convert(kr.totalDebt, 'KRW', disp, rate);
    var due30 = D.convert(th.dueNext30, 'THB', disp, rate) + D.convert(kr.dueNext30, 'KRW', disp, rate);
    var html = '<section class="cd-sec"><div class="cd-sec-h"><h2>ภาพรวมหนี้ทั้งหมด <small>Overview</small></h2>' + exportMenu() + '</div>' +
      '<div class="cd-kpis">' + kpi('หนี้รวมทั้งสองสกุล', fmt(total, disp), 'แปลงเป็น' + (disp === 'THB' ? 'บาท' : 'วอน') + 'เพื่อดูภาพรวมเท่านั้น', 'gold') +
      kpi('ต้องจ่ายใน 30 วัน (งวดผ่อน)', fmt(due30, disp)) + kpi('บัตรทั้งหมด', String(cards().filter(function (c) { return c.status === 'active'; }).length) + ' ใบ') +
      kpi('แผนผ่อนที่ยังเปิด', String(th.activePlans + kr.activePlans) + ' แผน') + '</div>' +
      '<div class="cd-rate"><label>เรตแสดงผล: 1 บาท ≈ <input id="cdRate" inputmode="decimal" value="' + esc(rate) + '" aria-label="วอนต่อ 1 บาท"> วอน</label>' +
      '<div class="cd-seg" role="group" aria-label="สกุลเงินที่ใช้แสดงภาพรวม">' + btn('disp', 'แสดงเป็น ฿', { 'data-cur': 'THB', cls: disp === 'THB' ? 'on' : '' }) +
      btn('disp', 'แสดงเป็น ₩', { 'data-cur': 'KRW', cls: disp === 'KRW' ? 'on' : '' }) + '</div><small>เรตนี้ใช้รวมยอดเพื่อดูภาพรวมเท่านั้น ยอดจริงแต่ละสกุลไม่ถูกแปลง</small></div></section>';
    html += '<div class="cd-two">' + [th, kr].map(function (s) {
      return '<section class="cd-sec cd-cur-card" data-cur="' + s.currency + '"><div class="cd-sec-h"><h3>' + curLabel(s.currency) + '</h3>' +
        btn('ws', 'เปิด →', { 'data-ws': s.currency }) + '</div><div class="cd-kpis cd-kpis-s">' +
        kpi('หนี้รวม', fmt(s.totalDebt, s.currency), 'บัตร ' + fmt(s.cardDebt, s.currency) + ' · ผ่อนร้าน ' + fmt(s.shopDebt, s.currency)) +
        kpi('ใช้วงเงิน', pct(s.utilization), s.limit ? 'จากวงเงิน ' + fmt(s.limit, s.currency) : 'ยังไม่ได้ตั้งวงเงิน', s.utilization > 0.7 ? 'bad' : s.utilization > 0.3 ? 'warn' : '') +
        kpi('ค่างวดเดือนนี้', fmt(s.monthlyInstallments, s.currency)) + kpi('ค้างชำระ', fmt(s.overdue, s.currency), '', s.overdue ? 'bad' : '') + '</div></section>';
    }).join('') + '</div>';
    var ev = [], end = D.addDays(t, 14);
    [D.monthKey(t), D.monthKey(D.addMonths(t, 1))].forEach(function (ym) { ev = ev.concat(D.calendar(d, ym)); });
    ev = ev.filter(function (e) { return e.date >= t && e.date <= end && e.type !== 'payment' && e.type !== 'statement'; });
    html += '<section class="cd-sec"><div class="cd-sec-h"><h3>ครบกำหนดใน 14 วัน <small>Upcoming</small></h3></div>' +
      (ev.length ? '<ul class="cd-list">' + ev.map(eventRow).join('') + '</ul>' : empty('🎉', 'ไม่มีรายการครบกำหนดใน 14 วันข้างหน้า')) + '</section>';
    return html;
  }
  function eventRow(e) {
    var ico = { card_due: '💳', statement: '🧾', installment: '🏪', installment_card: '🧾', transfer: '🔁', payment: '✅' }[e.type] || '•';
    return '<li class="cd-row"><span class="cd-ev-d">' + esc(thDate(e.date, { day: 'numeric', month: 'short' })) + '</span><span class="cd-ev-i">' + ico + '</span>' +
      '<span class="cd-grow">' + esc(e.title) + (e.estimate ? ' <small class="cd-est">ประมาณการ</small>' : '') + '</span>' +
      (e.amount !== null && e.amount !== undefined ? '<b>' + fmt(e.amount, e.currency) + '</b>' : '<small>' + (e.type === 'card_due' ? 'ยอดตาม statement' : '') + '</small>') + '</li>';
  }
  function empty(ico, text, cta) { return '<div class="cd-empty"><span>' + ico + '</span><p>' + esc(text) + '</p>' + (cta || '') + '</div>'; }
  function exportMenu() {
    if (S.demo || !hasData()) return '';
    return '<div class="cd-export">' + btn('export-json', '⬇ JSON') + btn('export-csv', '⬇ CSV') + '</div>';
  }

  /* ------------------------------------------------------------ workspace */
  function workspace(cur) {
    var s = D.summary(viewData(), cur, D.today());
    var html = '<section class="cd-sec cd-ws-head"><div class="cd-sec-h"><h2>' + curLabel(cur) + '</h2>' + exportMenu() + '</div><div class="cd-kpis">' +
      kpi('หนี้รวม', fmt(s.totalDebt, cur), 'บัตร ' + fmt(s.cardDebt, cur) + ' · ผ่อนนอกบัตร ' + fmt(s.shopDebt, cur), 'gold') +
      kpi('ต้องจ่ายใน 30 วัน', fmt(s.dueNext30, cur), 'เฉพาะงวดผ่อน') +
      kpi('ใช้วงเงิน (Utilization)', pct(s.utilization), s.limit ? 'ควรต่ำกว่า 30%' : 'ตั้งวงเงินในบัตรเพื่อดู %', s.utilization > 0.7 ? 'bad' : s.utilization > 0.3 ? 'warn' : 'ok') +
      kpi('ค้างชำระ (Overdue)', fmt(s.overdue, cur), s.overdue ? 'มีงวดเลยกำหนด' : 'ไม่มีค้าง', s.overdue ? 'bad' : 'ok') + '</div></section>';
    html += '<nav class="cd-tabs" role="tablist" aria-label="เมนูย่อย">' + TABS.map(function (t) {
      return '<button type="button" role="tab" aria-selected="' + (S.tab === t[0]) + '" class="cd-tab' + (S.tab === t[0] ? ' on' : '') + '" data-act="tab" data-tab="' + t[0] + '">' +
        '<span aria-hidden="true">' + t[1] + '</span>' + esc(t[2]) + '<small>' + t[3] + '</small></button>';
    }).join('') + '</nav>';
    var fn = { cards: tabCards, plans: tabPlans, transfers: tabTransfers, payments: tabPayments, calendar: tabCalendar, analytics: tabAnalytics, planner: tabPlanner }[S.tab] || tabCards;
    return html + '<div class="cd-panel" role="tabpanel">' + fn(cur) + '</div>';
  }

  /* ---- cards */
  function tabCards(cur) {
    var d = viewData(), list = cards(cur), act = list.filter(function (c) { return c.status === 'active'; }), arch = list.filter(function (c) { return c.status !== 'active'; });
    var head = '<div class="cd-sec-h"><h3>บัตรเครดิต <small>Credit cards</small></h3>' + wbtn('card-new', '+ เพิ่มบัตร', { cls: 'cd-primary' }) + '</div>';
    if (!list.length) return head + empty('💳', 'ยังไม่มีบัตรในสกุล ' + cur, wbtn('card-new', '+ เพิ่มบัตรใบแรก', { cls: 'cd-primary' }));
    var tile = function (c) {
      var st = D.cardStatus(d, c, D.today()), u = st.utilization;
      return '<article class="cd-card' + (c.status !== 'active' ? ' cd-archived' : '') + '" style="--cc:' + esc(c.color) + '" data-act="card-open" data-id="' + esc(c.id) + '" tabindex="0" role="button" aria-label="ดูบัตร ' + esc(c.name) + '">' +
        '<div class="cd-card-top"><span class="cd-card-ico">' + esc(c.icon || '💳') + '</span><div><b>' + esc(c.name) + '</b><small>' + esc(c.bank || '') + (c.last4 ? ' •••• ' + esc(c.last4) : '') + '</small></div>' +
        (c.status !== 'active' ? badge('คลัง', 'muted') : st.overLimit ? badge('เกินวงเงิน', 'bad') : '') + '</div>' +
        '<div class="cd-card-bal"><span>ยอดค้างบนบัตร</span><b>' + fmt(st.balance, cur) + '</b>' + (st.unbilled ? '<small>+ งวดผ่อนที่ยังไม่เรียกเก็บ ' + fmt(st.unbilled, cur) + '</small>' : '') + '</div>' +
        (st.limit ? '<div class="cd-bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round((u || 0) * 100) + '" aria-label="ใช้วงเงิน"><i style="width:' + Math.min(100, Math.round((u || 0) * 100)) + '%" class="' + (u > 0.7 ? 'bad' : u > 0.3 ? 'warn' : '') + '"></i></div>' +
          '<div class="cd-card-meta"><span>ใช้ ' + pct(u) + '</span><span>คงเหลือ ' + fmt(st.available, cur) + '</span></div>' : '<div class="cd-card-meta"><span>ยังไม่ได้ตั้งวงเงิน</span></div>') +
        '<div class="cd-card-meta"><span>' + (c.due_day ? 'ครบกำหนดทุกวันที่ ' + c.due_day : 'ยังไม่ตั้งวันครบกำหนด') + '</span><span>' + (c.installment_mode === 'full_hold' ? 'กันวงเงินเต็มยอดผ่อน' : 'กินวงเงินรายงวด') + '</span></div></article>';
    };
    return head + '<div class="cd-cards">' + act.map(tile).join('') + '</div>' +
      (arch.length ? '<details class="cd-more"><summary>บัตรในคลัง (' + arch.length + ')</summary><div class="cd-cards">' + arch.map(tile).join('') + '</div></details>' : '');
  }

  /* ---- installments */
  function tabPlans(cur) {
    var d = viewData(), all = plans(cur);
    var f = S.planFilter, list = all.filter(function (p) { return f === 'all' || (f === 'open' ? (p.status === 'active' || p.status === 'paused') : p.status === f); });
    var chips = [['open', 'กำลังผ่อน/พัก'], ['settled', 'ปิดแล้ว'], ['cancelled', 'ยกเลิก'], ['all', 'ทั้งหมด']].map(function (x) {
      return btn('plan-filter', x[1], { 'data-f': x[0], cls: 'cd-chip' + (f === x[0] ? ' on' : ''), 'aria-pressed': String(f === x[0]) });
    }).join('');
    var head = '<div class="cd-sec-h"><h3>แผนผ่อน <small>Installments</small></h3>' + wbtn('plan-new', '+ เพิ่มแผนผ่อน', { cls: 'cd-primary' }) + '</div><div class="cd-chips">' + chips + '</div>';
    if (!all.length) return head + empty('🧾', 'ยังไม่มีแผนผ่อนในสกุล ' + cur, wbtn('plan-new', '+ เพิ่มแผนผ่อน', { cls: 'cd-primary' }));
    if (!list.length) return head + empty('🔎', 'ไม่มีแผนในตัวกรองนี้');
    return head + '<ul class="cd-list">' + list.map(function (p) {
      var ps = D.planStatus(d, p), c = p.card_id ? findCard(p.card_id) : null;
      var done = p.card_id ? ps.billedCount : ps.paidCount, prog = Math.round(done / Math.max(ps.rows.length, 1) * 100);
      var next = ps.nextDue ? 'งวดถัดไป ' + thDate(ps.nextDue.due_date) + ' · ' + fmt(ps.nextDue.amount - (ps.nextDue.paid || 0), cur) : '';
      return '<li class="cd-plan" data-act="plan-open" data-id="' + esc(p.id) + '" tabindex="0" role="button">' +
        '<div class="cd-plan-l"><b>' + esc(p.product) + '</b><small>' + esc(c ? '💳 ' + c.name : '🏪 ผ่อนนอกบัตร' + (p.merchant ? ' · ' + p.merchant : '')) + ' · ' + esc(D.METHODS[p.method]) +
        (p.rate_bp ? ' ' + bp(p.rate_bp) : '') + '</small><div class="cd-bar cd-bar-s"><i style="width:' + prog + '%"></i></div><small>' + done + '/' + ps.rows.length + ' งวด' + (next ? ' · ' + esc(next) : '') + '</small></div>' +
        '<div class="cd-plan-r"><b>' + fmt(p.card_id ? ps.remaining : ps.remaining, cur) + '</b><small>คงเหลือ</small>' +
        badge(PLAN_STATUS[p.status], p.status === 'active' ? 'ok' : p.status === 'paused' ? 'warn' : 'muted') + (ps.overdue ? badge('ค้าง ' + fmt(ps.overdue, cur), 'bad') : '') + '</div></li>';
    }).join('') + '</ul>';
  }

  /* ---- transfers */
  function tabTransfers(cur) {
    var d = viewData(), list = d.debt_transfers.filter(function (t) { return t.currency === cur || t.dest_currency === cur; })
      .sort(function (a, b) { return a.transfer_date < b.transfer_date ? 1 : -1; });
    var head = '<div class="cd-sec-h"><h3>โอนหนี้ / บัตรจ่ายบัตร <small>Balance transfers</small></h3>' + wbtn('tr-new', '+ บันทึกการโอน', { cls: 'cd-primary' }) + '</div>' +
      '<p class="cd-help">ยอดบนบัตรจะเปลี่ยนเมื่อสถานะเป็น “ยืนยันแล้ว” เท่านั้น · ถ้ากำหนดผ่อนเป็นงวด ระบบสร้างแผนผ่อนบนบัตรปลายทางให้อัตโนมัติ (ไม่นับซ้ำ)</p>';
    if (cards().length < 1) return head + empty('🔁', 'เพิ่มบัตรก่อน แล้วจึงบันทึกการโอนหนี้ได้');
    if (!list.length) return head + empty('🔁', 'ยังไม่มีรายการโอนหนี้', wbtn('tr-new', '+ บันทึกการโอน', { cls: 'cd-primary' }));
    return head + '<ul class="cd-list">' + list.map(function (t) {
      var f = findCard(t.from_card_id), to = findCard(t.to_card_id), tone = { confirmed: 'ok', pending: 'warn', draft: 'muted', failed: 'bad', cancelled: 'muted' }[t.status];
      var acts = '';
      if (canWrite()) {
        if (t.status === 'draft' || t.status === 'pending') acts += btn('tr-status', 'ยืนยัน', { 'data-id': t.id, 'data-st': 'confirmed', cls: 'cd-mini cd-primary' }) + btn('tr-edit', 'แก้ไข', { 'data-id': t.id, cls: 'cd-mini' });
        if (t.status === 'pending') acts += btn('tr-status', 'ไม่สำเร็จ', { 'data-id': t.id, 'data-st': 'failed', cls: 'cd-mini' });
        if (t.status === 'draft') acts += btn('tr-del', 'ลบ', { 'data-id': t.id, cls: 'cd-mini cd-danger' });
        if (t.status === 'draft' || t.status === 'pending' || t.status === 'confirmed') acts += btn('tr-status', t.status === 'confirmed' ? 'ยกเลิก (ย้อนรายการ)' : 'ยกเลิก', { 'data-id': t.id, 'data-st': 'cancelled', cls: 'cd-mini cd-danger' });
      }
      return '<li class="cd-row cd-row-w"><div class="cd-grow"><b>' + esc(D.TRANSFER_TYPES[t.type]) + '</b><small>' + esc(f ? f.name : (t.type === 'cash_advance' ? 'เงินสด' : '-')) + ' → ' + esc(to ? to.name : '-') +
        ' · ' + esc(thDate(t.effective_date)) + (t.installments ? ' · ผ่อน ' + t.installments + ' งวด' : '') + (t.fee_minor ? ' · ค่าธรรมเนียม ' + fmt(t.fee_minor, t.dest_currency) : '') +
        (t.fx_rate ? ' · เรต ' + esc(t.fx_rate) + ' (' + esc(thDate(t.fx_date)) + ')' : '') + '</small></div><div class="cd-r"><b>' + fmt(t.amount_minor, t.currency) + '</b>' +
        (t.currency !== t.dest_currency ? '<small>→ ' + fmt(t.dest_amount_minor, t.dest_currency) + '</small>' : '') + badge(TR_STATUS[t.status], tone) + '</div>' +
        (acts ? '<div class="cd-acts">' + acts + '</div>' : '') + '</li>';
    }).join('') + '</ul>';
  }

  /* ---- payments + adjustments */
  function tabPayments(cur) {
    var d = viewData();
    var pays = d.debt_payments.filter(function (p) { return p.currency === cur; }).sort(function (a, b) { return a.paid_on < b.paid_on ? 1 : a.paid_on > b.paid_on ? -1 : 0; });
    var adj = d.debt_adjustments.filter(function (a) { return a.currency === cur; }).sort(function (a, b) { return a.effective_date < b.effective_date ? 1 : -1; });
    var head = '<div class="cd-sec-h"><h3>การชำระ <small>Payments</small></h3><div class="cd-acts">' + wbtn('adj-new', '± ปรับยอด/กระทบยอด') + wbtn('pay-new', '+ บันทึกการชำระ', { cls: 'cd-primary' }) + '</div></div>' +
      '<p class="cd-help">การชำระหนี้ไม่ถูกบันทึกเป็น “รายจ่าย” ซ้ำในหน้ารายจ่าย · แผนผ่อนบนบัตร ให้บันทึกเป็นการจ่ายบัตร</p>';
    var body = pays.length ? '<ul class="cd-list">' + pays.map(function (p) {
      var t = p.card_id ? findCard(p.card_id) : null, pl = p.plan_id ? findPlan(p.plan_id) : null, off = p.status === 'cancelled';
      return '<li class="cd-row' + (off ? ' cd-off-row' : '') + '"><span class="cd-ev-d">' + esc(thDate(p.paid_on, { day: 'numeric', month: 'short', year: '2-digit' })) + '</span><div class="cd-grow"><b>' +
        esc(t ? '💳 ' + t.name : pl ? '🏪 ' + pl.product : '-') + '</b><small>' + esc(PAY_KIND[p.kind] || p.kind) + ' · ' + esc(PAY_METHOD[p.method] || '') +
        (p.interest_minor ? ' · ดอกเบี้ย ' + fmt(p.interest_minor, cur) : '') + (p.notes ? ' · ' + esc(p.notes) : '') + '</small></div><b>' + fmt(p.amount_minor, cur) + '</b>' +
        (off ? badge('ยกเลิกแล้ว', 'muted') : wbtn('pay-cancel', 'ยกเลิก', { 'data-id': p.id, cls: 'cd-mini cd-danger', 'aria-label': 'ยกเลิกรายการชำระ' })) + '</li>';
    }).join('') + '</ul>' : empty('✅', 'ยังไม่มีการชำระในสกุล ' + cur, wbtn('pay-new', '+ บันทึกการชำระ', { cls: 'cd-primary' }));
    var adjHtml = adj.length ? '<details class="cd-more" open><summary>ปรับยอด / กระทบยอด statement (' + adj.length + ')</summary><ul class="cd-list">' + adj.map(function (a) {
      var c = findCard(a.card_id), off = a.status === 'cancelled';
      return '<li class="cd-row' + (off ? ' cd-off-row' : '') + '"><span class="cd-ev-d">' + esc(thDate(a.effective_date, { day: 'numeric', month: 'short' })) + '</span><div class="cd-grow"><b>' + esc(c ? c.name : '-') +
        '</b><small>' + esc(ADJ_KIND[a.kind]) + (a.statement_balance_minor !== null && a.statement_balance_minor !== undefined ? ' · statement ' + fmt(a.statement_balance_minor, cur) : '') + '</small></div><b>' +
        (a.amount_minor > 0 ? '+' : '') + fmt(a.amount_minor, cur) + '</b>' + (off ? badge('ยกเลิกแล้ว', 'muted') : wbtn('adj-cancel', 'ยกเลิก', { 'data-id': a.id, cls: 'cd-mini cd-danger' })) + '</li>';
    }).join('') + '</ul></details>' : '';
    return head + body + adjHtml;
  }

  /* ---- calendar */
  function tabCalendar(cur) {
    var ym = S.month, ev = D.calendar(viewData(), ym, cur), first = new Date(ym + '-01T00:00:00'), pad = first.getDay(), days = Number(D.dayInMonth(ym, 31).slice(8));
    var by = {}; ev.forEach(function (e) { (by[e.date] = by[e.date] || []).push(e); });
    var t = D.today(), cells = '';
    for (var i = 0; i < pad; i++) cells += '<div class="cd-day cd-day-x" aria-hidden="true"></div>';
    for (var dd = 1; dd <= days; dd++) {
      var ds = ym + '-' + (dd < 10 ? '0' : '') + dd, e = by[ds] || [], tot = 0;
      e.forEach(function (x) { if (x.type === 'installment' || x.type === 'installment_card') tot += x.amount || 0; });
      cells += '<button type="button" class="cd-day' + (ds === t ? ' today' : '') + (S.day === ds ? ' sel' : '') + (e.length ? ' has' : '') + '" data-act="day" data-day="' + ds + '" aria-label="' + esc(thDate(ds, { dateStyle: 'long' })) + ' ' + e.length + ' รายการ">' +
        '<span>' + dd + '</span><i>' + e.slice(0, 4).map(function (x) { return '<em class="cd-dot cd-dot-' + x.type + '"></em>'; }).join('') + '</i>' + (tot ? '<small>' + D.fmt(tot, cur, { compact: true, noSym: true }) + '</small>' : '') + '</button>';
    }
    var sel = S.day && S.day.slice(0, 7) === ym ? (by[S.day] || []) : ev;
    var total = 0; ev.forEach(function (x) { if (x.type === 'installment' || x.type === 'installment_card') total += x.amount || 0; });
    return '<div class="cd-sec-h"><h3>ปฏิทินครบกำหนด <small>Calendar</small></h3><div class="cd-acts">' + btn('month', '‹', { 'data-d': '-1', 'aria-label': 'เดือนก่อน' }) +
      '<b class="cd-month">' + esc(monthName(ym)) + '</b>' + btn('month', '›', { 'data-d': '1', 'aria-label': 'เดือนถัดไป' }) + btn('month', 'วันนี้', { 'data-d': '0' }) + '</div></div>' +
      '<p class="cd-help">งวดผ่อนเดือนนี้รวม <b>' + fmt(total, cur) + '</b> · <em class="cd-dot cd-dot-card_due"></em> ครบกำหนดบัตร <em class="cd-dot cd-dot-installment_card"></em> งวดผ่อนบนบัตร <em class="cd-dot cd-dot-installment"></em> ผ่อนนอกบัตร <em class="cd-dot cd-dot-payment"></em> ชำระแล้ว</p>' +
      '<div class="cd-cal"><div class="cd-cal-h">' + ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'].map(function (x) { return '<span>' + x + '</span>'; }).join('') + '</div><div class="cd-cal-g">' + cells + '</div></div>' +
      '<h4 class="cd-h4">' + (S.day && S.day.slice(0, 7) === ym ? esc(thDate(S.day, { dateStyle: 'full' })) : 'รายการทั้งเดือน') + '</h4>' +
      (sel.length ? '<ul class="cd-list">' + sel.map(eventRow).join('') + '</ul>' : empty('📅', 'ไม่มีรายการ'));
  }

  /* ---- analytics */
  function tabAnalytics(cur) {
    var d = viewData(), tr = D.trend(d, cur, 6, D.today()), cat = D.byCategory(d, cur), s = D.summary(d, cur, D.today());
    if (!hasData(d) || (!s.cards.length && !plans(cur).length)) return empty('📊', 'เพิ่มบัตรหรือแผนผ่อนก่อน แล้วกราฟจะแสดงที่นี่');
    var insights = [];
    if (s.utilization > 0.3) insights.push(['warn', 'ใช้วงเงินรวม ' + pct(s.utilization) + ' — ถ้าลดให้ต่ำกว่า 30% มักช่วยให้คะแนนเครดิตดีขึ้น']);
    s.cards.forEach(function (c) { if (c.overLimit) insights.push(['bad', 'บัตร ' + c.card.name + ' ใช้เกินวงเงิน']); });
    if (s.overdue) insights.push(['bad', 'มีงวดค้างชำระ ' + fmt(s.overdue, cur)]);
    if (tr.length > 1 && tr[tr.length - 1].debt < tr[0].debt) insights.push(['ok', 'หนี้ลดลง ' + fmt(tr[0].debt - tr[tr.length - 1].debt, cur) + ' ใน 6 เดือน']);
    if (!insights.length) insights.push(['ok', 'ภาพรวมอยู่ในเกณฑ์ดี — รักษาการจ่ายตรงเวลาไว้']);
    var maxCat = cat.length ? cat[0].amount : 1;
    return '<div class="cd-sec-h"><h3>วิเคราะห์หนี้ <small>Analytics</small></h3></div>' +
      '<ul class="cd-insights">' + insights.map(function (x) { return '<li class="cd-' + x[0] + '">' + esc(x[1]) + '</li>'; }).join('') + '</ul>' +
      '<div class="cd-chart-box"><h4 class="cd-h4">ยอดหนี้รวมสิ้นเดือน (6 เดือน)</h4><div id="cdTrend" class="cd-chart" data-cur="' + cur + '"></div></div>' +
      '<div class="cd-chart-box"><h4 class="cd-h4">จ่ายแล้ว vs ดอกเบี้ย/ค่าธรรมเนียมรายเดือน</h4><div id="cdPaid" class="cd-chart"></div></div>' +
      '<div class="cd-two"><div class="cd-chart-box"><h4 class="cd-h4">การใช้วงเงินรายบัตร</h4>' + (s.cards.filter(function (c) { return c.limit; }).map(function (c) {
        return '<div class="cd-hbar"><span>' + esc(c.card.name) + '</span><div class="cd-bar"><i style="width:' + Math.min(100, Math.round(c.utilization * 100)) + '%" class="' + (c.utilization > 0.7 ? 'bad' : c.utilization > 0.3 ? 'warn' : '') + '"></i></div><b>' + pct(c.utilization) + '</b></div>';
      }).join('') || '<p class="cd-help">ยังไม่มีบัตรที่ตั้งวงเงิน</p>') + '</div>' +
      '<div class="cd-chart-box"><h4 class="cd-h4">ยอดผ่อนตามหมวด</h4>' + (cat.map(function (c) {
        return '<div class="cd-hbar"><span>' + esc(c.category) + '</span><div class="cd-bar"><i style="width:' + Math.round(c.amount / maxCat * 100) + '%"></i></div><b>' + fmt(c.amount, cur) + '</b></div>';
      }).join('') || '<p class="cd-help">ยังไม่มีแผนผ่อน</p>') + '</div></div>';
  }
  function drawCharts() {
    var el = document.getElementById('cdTrend'); if (!el) return;
    var cur = el.getAttribute('data-cur'), tr = D.trend(viewData(), cur, 6, D.today());
    el.innerHTML = bars(tr.map(function (x) { return { label: monthName(x.month).split(' ')[0], a: x.debt }; }), cur);
    var p = document.getElementById('cdPaid');
    if (p) p.innerHTML = bars(tr.map(function (x) { return { label: monthName(x.month).split(' ')[0], a: x.paid, b: x.interest }; }), cur, true);
  }
  function bars(items, cur, two) {
    var W = 600, H = 200, pad = 28, max = Math.max.apply(null, items.map(function (x) { return Math.max(x.a, x.b || 0); }).concat([1]));
    var bw = (W - pad * 2) / items.length, out = '<svg viewBox="0 0 ' + W + ' ' + (H + 26) + '" role="img" aria-label="กราฟแท่ง">';
    [0.25, 0.5, 0.75, 1].forEach(function (g) { out += '<line x1="' + pad + '" x2="' + (W - pad) + '" y1="' + (H - g * (H - 20)) + '" y2="' + (H - g * (H - 20)) + '" class="cd-grid"/>'; });
    items.forEach(function (x, i) {
      var h = x.a / max * (H - 20), cx = pad + i * bw, w = two ? bw * 0.32 : bw * 0.56;
      out += '<rect x="' + (cx + (two ? bw * 0.16 : bw * 0.22)) + '" y="' + (H - h) + '" width="' + w + '" height="' + Math.max(h, 0) + '" rx="5" class="cd-bar-a"><title>' + esc(x.label + ' ' + D.fmt(x.a, cur)) + '</title></rect>';
      if (two) { var h2 = (x.b || 0) / max * (H - 20); out += '<rect x="' + (cx + bw * 0.52) + '" y="' + (H - h2) + '" width="' + w + '" height="' + Math.max(h2, 0) + '" rx="5" class="cd-bar-b"><title>' + esc(x.label + ' ดอกเบี้ย ' + D.fmt(x.b || 0, cur)) + '</title></rect>'; }
      out += '<text x="' + (cx + bw / 2) + '" y="' + (H + 18) + '" text-anchor="middle" class="cd-ax">' + esc(x.label) + '</text>';
      if (x.a && !two && items.length <= 8) out += '<text x="' + (cx + bw / 2) + '" y="' + (H - h - 6) + '" text-anchor="middle" class="cd-val">' + esc(D.fmt(x.a, cur, { compact: true })) + '</text>';
    });
    return out + '</svg>' + (two ? '<div class="cd-legend"><span><em class="cd-lg-a"></em>จ่ายแล้ว</span><span><em class="cd-lg-b"></em>ดอกเบี้ย/ค่าธรรมเนียม</span></div>' : '');
  }

  /* ---- payoff planner */
  function plannerDebts(cur) {
    var d = viewData(), t = D.today(), out = [];
    cards(cur).forEach(function (c) {
      var st = D.cardStatus(d, c, t); if (st.totalDebt <= 0) return;
      out.push({ id: 'card:' + c.id, name: '💳 ' + c.name, balance: st.totalDebt, aprBp: c.apr_bp || 0, minPayment: D.minimumPayment(st, c) + (st.unbilled ? 0 : 0) });
    });
    plans(cur).forEach(function (p) {
      if (p.card_id || (p.status !== 'active' && p.status !== 'paused')) return;
      var a = D.allocatePlan(d, p, t); if (a.remaining <= 0) return;
      out.push({ id: 'plan:' + p.id, name: '🏪 ' + p.product, balance: a.remaining, aprBp: p.method === 'zero' ? 0 : p.rate_bp, minPayment: a.nextDue ? a.nextDue.amount - a.nextDue.paid : 0 });
    });
    return out;
  }
  function tabPlanner(cur) {
    var P = S.planner && S.planner.cur === cur ? S.planner : (S.planner = { cur: cur, strategy: 'avalanche', budget: null, debts: plannerDebts(cur), order: null });
    if (!P.debts.length) return '<div class="cd-sec-h"><h3>แผนปลดหนี้ <small>Payoff planner</small></h3></div>' + empty('🎯', 'ยังไม่มียอดหนี้ในสกุล ' + cur + ' ให้วางแผน');
    var minSum = P.debts.reduce(function (s, x) { return s + Math.min(x.minPayment, x.balance); }, 0);
    if (P.budget === null) P.budget = Math.max(minSum, Math.round(minSum * 1.5));
    var order = P.strategy === 'custom' ? (P.order || P.debts.map(function (x) { return x.id; })) : null;
    var r = D.payoff(P.debts, P.budget, P.strategy, order);
    var other = D.payoff(P.debts, P.budget, P.strategy === 'snowball' ? 'avalanche' : 'snowball');
    var strat = [['avalanche', 'Avalanche', 'ปิดก้อนดอกเบี้ยสูงสุดก่อน — เสียดอกเบี้ยรวมน้อยที่สุด'],
                 ['snowball', 'Snowball', 'ปิดก้อนเล็กสุดก่อน — เห็นผลเร็ว มีกำลังใจ'], ['custom', 'Custom', 'เรียงลำดับเอง']];
    var html = '<div class="cd-sec-h"><h3>แผนปลดหนี้ <small>Payoff planner</small></h3></div>' +
      '<div class="cd-plan-form"><label class="cd-f"><span>งบจ่ายหนี้ต่อเดือน</span><input id="cdBudget" inputmode="decimal" value="' + esc(D.inputValue(P.budget, cur)) + '"><small>ขั้นต่ำรวม ' + fmt(minSum, cur) + '</small></label>' +
      '<div class="cd-strat" role="radiogroup" aria-label="วิธีปลดหนี้">' + strat.map(function (s) {
        return '<button type="button" role="radio" aria-checked="' + (P.strategy === s[0]) + '" class="cd-strat-i' + (P.strategy === s[0] ? ' on' : '') + '" data-act="strategy" data-s="' + s[0] + '"><b>' + s[1] + '</b><small>' + esc(s[2]) + '</small></button>';
      }).join('') + '</div></div>';
    html += '<div class="cd-table-wrap"><table class="cd-table"><thead><tr>' + (P.strategy === 'custom' ? '<th>ลำดับ</th>' : '') + '<th>หนี้</th><th>คงเหลือ</th><th>ดอกเบี้ย/ปี (APR %)</th><th>ขั้นต่ำ/เดือน</th></tr></thead><tbody>' +
      (order ? order.map(function (id) { return P.debts.find(function (x) { return x.id === id; }); }).filter(Boolean) : P.debts).map(function (x, i, arr) {
        return '<tr>' + (P.strategy === 'custom' ? '<td class="cd-nowrap">' + btn('prio', '↑', { 'data-id': x.id, 'data-d': '-1', cls: 'cd-mini', 'aria-label': 'เลื่อนขึ้น', disabled: i === 0 ? 'disabled' : null }) +
          btn('prio', '↓', { 'data-id': x.id, 'data-d': '1', cls: 'cd-mini', 'aria-label': 'เลื่อนลง' }) + '</td>' : '') +
          '<td>' + esc(x.name) + '</td><td>' + fmt(x.balance, cur) + '</td><td><input class="cd-in-s" data-pl="apr" data-id="' + esc(x.id) + '" inputmode="decimal" value="' + (x.aprBp / 100) + '" aria-label="APR ' + esc(x.name) + '"></td>' +
          '<td><input class="cd-in-s" data-pl="min" data-id="' + esc(x.id) + '" inputmode="decimal" value="' + esc(D.inputValue(x.minPayment, cur)) + '" aria-label="ขั้นต่ำ ' + esc(x.name) + '"></td></tr>';
      }).join('') + '</tbody></table></div>';
    if (!r.feasible) {
      html += '<div class="cd-state cd-warn-box" role="alert"><b>' + (r.reason === 'budget_below_minimum' ? 'งบต่ำกว่ายอดขั้นต่ำรวม (' + fmt(r.minimumNeeded, cur) + ')' : 'งบนี้ไม่พอชนะดอกเบี้ย — หนี้จะไม่หมด') + '</b><p>ลองเพิ่มงบต่อเดือน</p></div>';
    } else {
      var end = D.addMonths(D.today(), r.months), save = other.feasible ? other.totalInterest - r.totalInterest : 0;
      html += '<div class="cd-kpis">' + kpi('หมดหนี้ใน', r.months + ' เดือน', 'ประมาณ ' + thDate(end, { month: 'long', year: 'numeric' }), 'gold') +
        kpi('ดอกเบี้ยรวม', fmt(r.totalInterest, cur)) + kpi('จ่ายรวม', fmt(r.totalPaid, cur)) +
        (other.feasible ? kpi('เทียบ ' + (P.strategy === 'snowball' ? 'Avalanche' : 'Snowball'), (save >= 0 ? 'ประหยัด ' : 'แพงกว่า ') + fmt(Math.abs(save), cur), other.months + ' เดือน', save >= 0 ? 'ok' : 'warn') : '') + '</div>' +
        '<h4 class="cd-h4">ลำดับการปิดหนี้</h4><ol class="cd-order">' + r.order.map(function (o) { return '<li><b>' + esc(o.name) + '</b> — เดือนที่ ' + o.month + ' (' + esc(thDate(D.addMonths(D.today(), o.month), { month: 'short', year: '2-digit' })) + ')</li>'; }).join('') + '</ol>' +
        '<div class="cd-chart-box"><div class="cd-chart">' + bars([{ month: 0, remaining: P.debts.reduce(function (a, x) { return a + x.balance; }, 0) }].concat(r.timeline).filter(function (_, i, all) { return all.length <= 24 || i % Math.ceil(all.length / 24) === 0; })
          .map(function (x) { return { label: String(x.month), a: x.remaining }; }), cur) + '</div><small class="cd-help">ยอดคงเหลือรวม ตามเดือนที่ (0 = วันนี้)</small></div>';
    }
    html += '<details class="cd-more"><summary>สมมติฐานที่ใช้คำนวณ (Assumptions)</summary><ul>' + r.assumptions.map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') +
      '<li>ขั้นต่ำบัตรประมาณ 3% ของยอด (แก้ในตารางได้) · ผลเป็นการประมาณ ไม่ใช่ยอดจากธนาคาร</li></ul></details>';
    var saved = viewData().debt_payoff_plans.filter(function (x) { return x.currency === cur; });
    html += '<div class="cd-sec-h"><h4 class="cd-h4">แผนที่บันทึกไว้</h4>' + (r.feasible ? wbtn('payoff-save', '💾 บันทึกแผนนี้', { cls: 'cd-primary' }) : '') + '</div>' +
      (saved.length ? '<ul class="cd-list">' + saved.map(function (x) {
        return '<li class="cd-row"><div class="cd-grow"><b>' + esc(x.name) + '</b><small>' + esc(x.strategy) + ' · งบ ' + fmt(x.budget_minor, cur) + (x.result && x.result.months ? ' · ' + x.result.months + ' เดือน' : '') +
          ' · ' + esc(thDate(x.updated_at || x.created_at)) + '</small></div>' + btn('payoff-load', 'เปิด', { 'data-id': x.id, cls: 'cd-mini' }) + wbtn('payoff-del', 'ลบ', { 'data-id': x.id, cls: 'cd-mini cd-danger' }) + '</li>';
      }).join('') + '</ul>' : '<p class="cd-help">ยังไม่มีแผนที่บันทึกไว้</p>');
    return html;
  }

  /* ------------------------------------------------------------ modal + forms */
  function openModal(title, body, opts) {
    opts = opts || {};
    modal.innerHTML = '<div class="cd-modal-bg" data-act="modal-close"></div><div class="cd-modal" role="dialog" aria-modal="true" aria-labelledby="cdModalT">' +
      '<div class="cd-modal-h"><h3 id="cdModalT">' + esc(title) + '</h3><button type="button" class="cd-x" data-act="modal-close" aria-label="ปิด">✕</button></div>' +
      '<div class="cd-modal-b">' + body + '</div></div>';
    modal.hidden = false; document.documentElement.classList.add('cd-noscroll');
    modal._prev = document.activeElement;
    setTimeout(function () { var f = modal.querySelector(opts.focus || 'input,select,textarea,button:not(.cd-x)'); if (f) f.focus(); }, 30);
  }
  function closeModal() {
    if (!modal || modal.hidden) return;
    modal.hidden = true; modal.innerHTML = ''; document.documentElement.classList.remove('cd-noscroll');
    if (modal._prev && modal._prev.focus) try { modal._prev.focus(); } catch (_) {}
  }
  // fields: {name,label,type:text|money|percent|int|date|select|textarea|color|rows, value, options:[[v,l]], help, required, show(values)}
  function form(title, fields, submitLabel, onSubmit, opts) {
    opts = opts || {};
    var cur = opts.currency, init = {};
    fields.forEach(function (f) { init[f.name] = f.value === undefined || f.value === null ? '' : String(f.value); });
    var curFor = function (f) { return f.currencyOf ? f.currencyOf(init) : f.currency || (opts.currencyOf ? opts.currencyOf(init) : cur); };
    var html = '<form class="cd-form" novalidate>' + (opts.intro ? '<p class="cd-help">' + opts.intro + '</p>' : '') + fields.map(function (f) {
      var id = 'cdf_' + f.name, v = f.value === undefined || f.value === null ? '' : f.value, inp;
      if (f.type === 'select') inp = '<select id="' + id + '" name="' + f.name + '">' + f.options.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(v) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
      else if (f.type === 'textarea' || f.type === 'rows') inp = '<textarea id="' + id + '" name="' + f.name + '" rows="' + (f.type === 'rows' ? 5 : 2) + '" maxlength="' + (f.max || 500) + '"' + (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') + '>' + esc(v) + '</textarea>';
      else if (f.type === 'color') inp = '<input id="' + id + '" name="' + f.name + '" type="color" value="' + esc(v || '#e8be46') + '">';
      else if (f.type === 'date') inp = '<input id="' + id + '" name="' + f.name + '" type="date" value="' + esc(v) + '" min="2000-01-01" max="2100-12-31">';
      else inp = '<input id="' + id + '" name="' + f.name + '" type="text"' + (f.type === 'text' ? '' : ' inputmode="' + (f.type === 'int' ? 'numeric' : 'decimal') + '"') +
        (f.max ? ' maxlength="' + f.max + '"' : '') + ' value="' + esc(f.type === 'money' ? D.inputValue(v, curFor(f)) : v) + '"' + (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') + ' autocomplete="off">';
      return '<label class="cd-f' + (f.half ? ' cd-half' : '') + '" data-field="' + f.name + '"><span>' + esc(f.label) + (f.required ? ' <i aria-hidden="true">*</i>' : '') +
        (f.type === 'money' ? ' <small>(' + esc(curFor(f) || '') + ')</small>' : '') + '</span>' + inp + (f.help ? '<small>' + f.help + '</small>' : '') + '<em class="cd-err" role="alert"></em></label>';
    }).join('') + '<div class="cd-preview" aria-live="polite"></div><div class="cd-form-a"><button type="button" class="cd-btn" data-act="modal-close">ยกเลิก</button>' +
      '<button type="submit" class="cd-btn cd-primary">' + esc(submitLabel) + '</button></div></form>';
    openModal(title, html);
    var fe = modal.querySelector('form');
    function values() {
      var o = {};
      fields.forEach(function (f) { var el = fe.elements[f.name]; o[f.name] = el ? el.value : ''; });
      return o;
    }
    function sync() {
      var v = values();
      fields.forEach(function (f) { if (f.show) { var w = fe.querySelector('[data-field="' + f.name + '"]'); if (w) w.hidden = !f.show(v); } });
      if (opts.preview) { var p = fe.querySelector('.cd-preview'); try { p.innerHTML = opts.preview(v) || ''; } catch (e) { p.innerHTML = '<small class="cd-bad">' + esc(API.message(e)) + '</small>'; } }
      if (opts.onChange) opts.onChange(v, fe);
    }
    fe.addEventListener('input', sync); fe.addEventListener('change', sync); sync();
    fe.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var v = values(), out = {}, bad = false;
      fe.querySelectorAll('.cd-err').forEach(function (e) { e.textContent = ''; });
      fields.forEach(function (f) {
        var w = fe.querySelector('[data-field="' + f.name + '"]'), raw = String(v[f.name] || '').trim(), err = '';
        if (w && w.hidden) return;
        var c = f.currencyOf ? f.currencyOf(v) : f.currency || (opts.currencyOf ? opts.currencyOf(v) : cur);
        if (f.required && !raw) err = 'จำเป็นต้องกรอก';
        else if (raw && f.type === 'money') { out[f.name] = D.toMinor(raw, c); if (out[f.name] === null) err = c === 'KRW' ? 'ตัวเลขจำนวนเต็ม (วอนไม่มีทศนิยม)' : 'ตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง'; else if (!f.signed && out[f.name] < 0) err = 'ต้องไม่ติดลบ'; }
        else if (raw && f.type === 'percent') { var n = Number(raw.replace(/[,%\s]/g, '')); if (!(n >= 0 && n <= 100)) err = '0–100'; else out[f.name] = Math.round(n * 100); }
        else if (raw && f.type === 'int') { var k = Number(raw); if (!/^\d+$/.test(raw) || k < (f.min || 0) || k > (f.maxv || 1e9)) err = 'ตัวเลข ' + (f.min || 0) + '–' + f.maxv; else out[f.name] = k; }
        else if (f.type === 'text' && f.pattern && raw && !f.pattern.test(raw)) err = f.patternMsg || 'รูปแบบไม่ถูกต้อง';
        else out[f.name] = raw === '' ? null : raw;
        if (err) { bad = true; var e = w && w.querySelector('.cd-err'); if (e) e.textContent = err; }
      });
      if (bad) { var first = fe.querySelector('.cd-err:not(:empty)'); if (first) first.parentNode.querySelector('input,select,textarea').focus(); return; }
      var sb = fe.querySelector('[type=submit]'); sb.disabled = true; sb.textContent = 'กำลังบันทึก…';
      Promise.resolve().then(function () { return onSubmit(out, v); }).then(function () { closeModal(); }, function (e) {
        sb.disabled = false; sb.textContent = submitLabel;
        var p = fe.querySelector('.cd-preview'); if (p) p.insertAdjacentHTML('afterbegin', '<p class="cd-form-err" role="alert">' + esc(API.message(e)) + '</p>');
      });
    });
    return fe;
  }
  function confirmBox(title, text, okLabel, danger) {
    return new Promise(function (resolve) {
      openModal(title, '<p class="cd-confirm">' + text + '</p><div class="cd-form-a"><button type="button" class="cd-btn" data-act="modal-close">ไม่ใช่</button>' +
        '<button type="button" class="cd-btn ' + (danger ? 'cd-danger-s' : 'cd-primary') + '" id="cdOk">' + esc(okLabel) + '</button></div>', { focus: '#cdOk' });
      modal.querySelector('#cdOk').addEventListener('click', function () { closeModal(); resolve(true); });
      modal._resolve = function () { resolve(false); };
    });
  }

  /* ---- card form / detail */
  function cardForm(c) {
    c = c || {}; var cur = c.currency || (S.ws === 'KRW' ? 'KRW' : 'THB'), crid = API.uuid();
    var days = [['', '— ไม่ระบุ —']].concat(Array.from({ length: 31 }, function (_, i) { return [i + 1, 'วันที่ ' + (i + 1)]; }));
    form(c.id ? 'แก้ไขบัตร' : 'เพิ่มบัตรเครดิต', [
      { name: 'name', label: 'ชื่อบัตร', type: 'text', value: c.name, required: true, max: 60, placeholder: 'เช่น KB Kookmin, SCB M' },
      { name: 'bank', label: 'ธนาคาร/ผู้ออกบัตร', type: 'text', value: c.bank, max: 60, half: true },
      { name: 'currency', label: 'สกุลเงินของบัตร', type: 'select', value: cur, options: [['THB', '฿ บาท (THB)'], ['KRW', '₩ วอน (KRW)']], half: true },
      { name: 'last4', label: 'เลข 4 หลักท้าย (ไม่บังคับ)', type: 'text', value: c.last4, max: 4, pattern: /^\d{4}$/, patternMsg: 'ตัวเลข 4 หลักเท่านั้น', half: true, help: 'ห้ามกรอกเลขบัตรเต็ม CVV หรือ PIN' },
      { name: 'credit_limit_minor', label: 'วงเงิน (Credit limit)', type: 'money', value: c.credit_limit_minor, half: true },
      { name: 'opening_balance_minor', label: 'ยอดค้างตั้งต้น', type: 'money', value: c.opening_balance_minor, half: true, help: 'ยอดค้าง ณ วันที่เริ่มบันทึก (ไม่รวมงวดผ่อนที่จะเพิ่มแยก)' },
      { name: 'opening_date', label: 'ณ วันที่', type: 'date', value: c.opening_date || D.today(), half: true },
      { name: 'statement_day', label: 'วันตัดรอบ (Statement)', type: 'select', value: c.statement_day || '', options: days, half: true },
      { name: 'due_day', label: 'วันครบกำหนดชำระ (Due)', type: 'select', value: c.due_day || '', options: days, half: true },
      { name: 'apr_bp', label: 'ดอกเบี้ยต่อปี (APR %)', type: 'percent', value: c.apr_bp ? c.apr_bp / 100 : '', half: true, help: 'ใช้คำนวณแผนปลดหนี้' },
      { name: 'installment_mode', label: 'วิธีนับวงเงินของงวดผ่อน', type: 'select', value: c.installment_mode || 'per_period',
        options: [['per_period', 'กินวงเงินเฉพาะงวดที่เรียกเก็บ (Per period)'], ['full_hold', 'กันวงเงินเต็มยอดผ่อนที่เหลือ (Full hold)']], help: 'แต่ละธนาคารนับต่างกัน — เลือกให้ตรงกับบัตรใบนี้' },
      { name: 'color', label: 'สีบัตร', type: 'color', value: c.color || '#e8be46', half: true },
      { name: 'notes', label: 'โน้ต', type: 'textarea', value: c.notes, max: 500 }
    ], c.id ? 'บันทึก' : 'เพิ่มบัตร', function (o) {
      var p = Object.assign({}, o, { credit_limit_minor: o.credit_limit_minor || 0, opening_balance_minor: o.opening_balance_minor || 0, apr_bp: o.apr_bp || 0 });
      if (c.id) { p.id = c.id; p.base_version = c.version; p.icon = c.icon; } else p.client_request_id = crid;
      return runF(API.saveCard(p), c.id ? 'บันทึกบัตรแล้ว' : 'เพิ่มบัตรแล้ว').then(function () { if (!c.id && o.currency !== S.ws && S.ws !== 'overview') { S.ws = o.currency; savePrefs(); render(); } });
    }, { currency: cur, currencyOf: function (v) { return v.currency; } });
  }
  function cardOpen(id) {
    var c = findCard(id); if (!c) return;
    var d = viewData(), st = D.cardStatus(d, c, D.today()), cur = c.currency;
    var pl = d.installment_plans.filter(function (p) { return p.card_id === id; });
    var acts = canWrite() ? '<div class="cd-acts cd-acts-wrap">' + btn('pay-new', '💸 จ่ายบัตร', { 'data-card': id, cls: 'cd-primary' }) + btn('adj-new', '± ปรับยอด/กระทบยอด', { 'data-card': id }) +
      btn('plan-new', '+ แผนผ่อนบนบัตรนี้', { 'data-card': id }) + btn('card-edit', '✎ แก้ไข', { 'data-id': id }) +
      btn('card-status', c.status === 'active' ? '🗄 เก็บเข้าคลัง' : '↩ นำออกจากคลัง', { 'data-id': id }) + btn('card-del', '🗑 ลบ', { 'data-id': id, cls: 'cd-danger' }) + '</div>' : '';
    openModal(c.name + (c.last4 ? ' •••• ' + c.last4 : ''), '<div class="cd-kpis cd-kpis-s">' + kpi('ยอดค้างบนบัตร', fmt(st.balance, cur), 'ณ วันนี้') + kpi('งวดผ่อนยังไม่เรียกเก็บ', fmt(st.unbilled, cur)) +
      kpi('วงเงินที่ใช้', st.limit ? fmt(st.used, cur) + ' / ' + fmt(st.limit, cur) : '-', st.limit ? pct(st.utilization) + (c.installment_mode === 'full_hold' ? ' · กันวงเงินเต็มยอดผ่อน' : ' · นับเฉพาะงวดที่เรียกเก็บ') : '', st.overLimit ? 'bad' : '') +
      kpi('วงเงินคงเหลือ', st.available === null ? '-' : fmt(st.available, cur)) + '</div>' +
      '<p class="cd-help">ตัดรอบ ' + (c.statement_day ? 'วันที่ ' + c.statement_day : '-') + ' · ครบกำหนด ' + (c.due_day ? 'วันที่ ' + c.due_day : '-') + ' · APR ' + bp(c.apr_bp) + (c.notes ? ' · ' + esc(c.notes) : '') + '</p>' + acts +
      '<h4 class="cd-h4">แผนผ่อนบนบัตรนี้ (' + pl.length + ')</h4>' + (pl.length ? '<ul class="cd-list">' + pl.map(function (p) {
        var ps = D.cardPlanRows(d, p); return '<li class="cd-row" data-act="plan-open" data-id="' + esc(p.id) + '" role="button" tabindex="0"><div class="cd-grow"><b>' + esc(p.product) + '</b><small>' + ps.billedCount + '/' + ps.rows.length + ' งวด · ' + PLAN_STATUS[p.status] + '</small></div><b>' + fmt(ps.remaining, cur) + '</b></li>';
      }).join('') + '</ul>' : '<p class="cd-help">ไม่มี</p>'));
  }

  /* ---- installment form / detail */
  function planForm(p, presetCard) {
    p = p || {}; var cur = p.currency || (S.ws === 'KRW' ? 'KRW' : 'THB'), crid = API.uuid();
    var cs = cards(cur).filter(function (c) { return c.status === 'active' || c.id === p.card_id; });
    var custom = p.id && p.method === 'custom' ? D.liveRows(viewData(), p.id).map(function (r) { return r.due_date + ', ' + D.inputValue(D.rowAmount(r), cur); }).join('\n') : '';
    var cardOpts = [['', '🏪 ไม่ผ่านบัตร (ผ่อนร้าน / ไฟแนนซ์)']].concat(cs.map(function (c) { return [c.id, '💳 ' + c.name]; }));
    function parseCustom(text) {
      return String(text || '').split(/\n/).map(function (l) { return l.trim(); }).filter(Boolean).map(function (l) {
        var m = /^(\d{4}-\d{2}-\d{2})\s*[,;\s]\s*([\d.,]+)$/.exec(l); if (!m) throw new Error('invalid_custom');
        var a = D.toMinor(m[2], cur); if (!a || a <= 0) throw new Error('invalid_custom');
        return { due_date: m[1], amount: a };
      });
    }
    function sched(v) {
      var orig = D.toMinor(v.original_minor, cur), dn = D.toMinor(v.down_minor || '0', cur) || 0, rate = Math.round(Number(v.rate_bp || 0) * 100);
      if (!orig || dn >= orig) return null;
      if (v.method === 'custom') return D.buildSchedule(0, 0, 'custom', 0, null, parseCustom(v.custom));
      if (!v.first_due_date || !/^\d+$/.test(v.months)) return null;
      return D.buildSchedule(orig - dn, rate, v.method, Number(v.months), v.first_due_date);
    }
    form(p.id ? 'แก้ไขแผนผ่อน' : 'เพิ่มแผนผ่อน', [
      { name: 'card_id', label: 'ผ่อนผ่าน', type: 'select', value: p.id ? (p.card_id || '') : (presetCard || ''), options: cardOpts },
      { name: 'product', label: 'สินค้า/รายการ', type: 'text', value: p.product, required: true, max: 80 },
      { name: 'category', label: 'หมวด', type: 'text', value: p.category, max: 40, half: true, placeholder: 'เช่น มือถือ' },
      { name: 'merchant', label: 'ร้าน/ไฟแนนซ์', type: 'text', value: p.merchant, max: 60, half: true },
      { name: 'purchase_date', label: 'วันที่ซื้อ', type: 'date', value: p.purchase_date || D.today(), required: true, half: true },
      { name: 'original_minor', label: 'ราคาสินค้า', type: 'money', value: p.original_minor, required: true, half: true },
      { name: 'down_minor', label: 'เงินดาวน์', type: 'money', value: p.down_minor || '', half: true },
      { name: 'method', label: 'วิธีคิดดอกเบี้ย', type: 'select', value: p.method || 'zero', half: true, options: Object.keys(D.METHODS).map(function (k) { return [k, D.METHODS[k]]; }) },
      { name: 'rate_bp', label: 'ดอกเบี้ยต่อปี (%)', type: 'percent', value: p.rate_bp ? p.rate_bp / 100 : '', half: true, show: function (v) { return v.method === 'fixed' || v.method === 'reducing'; },
        help: 'Flat rate: ดอกคิดจากเงินต้นเต็มตลอดสัญญา · ลดต้นลดดอก: ดอกคิดจากยอดคงเหลือ' },
      { name: 'months', label: 'จำนวนงวด (เดือน)', type: 'int', value: p.months || 10, min: 1, maxv: 120, half: true, show: function (v) { return v.method !== 'custom'; } },
      { name: 'first_due_date', label: 'วันครบกำหนดงวดแรก', type: 'date', value: p.first_due_date || D.addMonths(D.today(), 1), half: true, show: function (v) { return v.method !== 'custom'; } },
      { name: 'custom', label: 'ตารางงวดกำหนดเอง (บรรทัดละ: วันที่, ยอด)', type: 'rows', value: custom, max: 6000, placeholder: '2026-12-05, 1500\n2027-01-05, 1500', show: function (v) { return v.method === 'custom'; } },
      { name: 'notes', label: 'โน้ต', type: 'textarea', value: p.notes, max: 500 }
    ], p.id ? 'บันทึก' : 'เพิ่มแผนผ่อน', function (o, raw) {
      var q = { card_id: o.card_id || null, currency: cur, product: o.product, category: o.category || '', merchant: o.merchant || '', purchase_date: o.purchase_date,
                original_minor: o.original_minor, down_minor: o.down_minor || 0, method: o.method, rate_bp: o.method === 'zero' || o.method === 'custom' ? 0 : (o.rate_bp || 0),
                months: o.months, first_due_date: o.first_due_date, notes: o.notes || '' };
      if (o.method === 'custom') q.custom = parseCustom(raw.custom);
      if (p.id) { q.id = p.id; q.base_version = p.version; } else q.client_request_id = crid;
      return runF(API.saveInstallment(q), p.id ? 'บันทึกแผนแล้ว' : 'เพิ่มแผนผ่อนแล้ว');
    }, {
      currency: cur,
      intro: p.id ? 'ถ้าแก้ราคา ดาวน์ ดอกเบี้ย วิธีคิด จำนวนงวด หรือวันเริ่ม ระบบจะสร้างตารางงวดใหม่ (ฉบับเดิมเก็บเป็นประวัติ)' : '',
      preview: function (v) {
        var rows = sched(v); if (!rows) return '';
        var t = D.scheduleTotals(rows);
        return '<div class="cd-prev"><div><span>ค่างวด/เดือน</span><b>' + fmt(t.monthly, cur) + '</b></div><div><span>ดอกเบี้ยรวม</span><b>' + fmt(t.interest, cur) + '</b></div>' +
          '<div><span>ยอดผ่อนรวม</span><b>' + fmt(t.amount, cur) + '</b></div><div><span>งวดสุดท้าย</span><b>' + esc(thDate(rows[rows.length - 1].due_date)) + '</b></div></div>';
      }
    });
  }
  function planOpen(id) {
    var p = findPlan(id); if (!p) return;
    var d = viewData(), cur = p.currency, ps = D.planStatus(d, p), c = p.card_id ? findCard(p.card_id) : null;
    var old = d.installment_schedules.filter(function (s) { return s.plan_id === id && s.superseded_at; });
    var acts = '';
    if (canWrite()) {
      if (p.status === 'active' || p.status === 'paused') {
        if (!p.card_id) acts += btn('pay-new', '💸 ชำระงวด', { 'data-plan': id, cls: 'cd-primary' });
        if (!p.transfer_id) acts += btn('plan-edit', '✎ แก้ไข', { 'data-id': id });
        acts += btn('plan-status', p.status === 'active' ? '⏸ พักชำระ' : '▶ ผ่อนต่อ', { 'data-id': id, 'data-st': p.status === 'active' ? 'paused' : 'active' });
        acts += btn('plan-status', '✔ ปิดยอดก่อนกำหนด', { 'data-id': id, 'data-st': 'settled' });
        acts += btn('plan-status', '✕ ยกเลิกแผน', { 'data-id': id, 'data-st': 'cancelled', cls: 'cd-danger' });
      } else if (!p.transfer_id) acts += btn('plan-edit', '✎ แก้ข้อความ', { 'data-id': id });
      if (!p.transfer_id) acts += btn('plan-del', '🗑 ลบ', { 'data-id': id, cls: 'cd-danger' });
    }
    var t = D.scheduleTotals(ps.rows.map(function (r) { return { principal: r.principal, interest: r.interest, amount: r.amount }; }));
    openModal(p.product, '<div class="cd-kpis cd-kpis-s">' + kpi('คงเหลือ', fmt(ps.remaining, cur), PLAN_STATUS[p.status]) + kpi('ค่างวด', fmt(p.monthly_minor || (ps.rows[0] && ps.rows[0].amount) || 0, cur), D.METHODS[p.method] + (p.rate_bp ? ' ' + bp(p.rate_bp) : '')) +
      kpi('ยอดผ่อนรวม', fmt(t.amount, cur), 'ดอกเบี้ย ' + fmt(t.interest, cur)) + kpi('ผ่อนผ่าน', esc(c ? '💳 ' + c.name : '🏪 นอกบัตร'), p.transfer_id ? 'สร้างจากการโอนหนี้' : esc(p.merchant || '')) + '</div>' +
      (acts ? '<div class="cd-acts cd-acts-wrap">' + acts + '</div>' : '') +
      (p.card_id ? '<p class="cd-help">งวดผ่อนบนบัตรถูกรวมในยอดบัตรเมื่อถึงกำหนด จ่ายผ่าน “จ่ายบัตร” · กด “ยืนยันยอด” เพื่อใส่ยอดจริงตาม statement</p>' : '<p class="cd-help">การชำระถูกตัดเข้างวดที่เก่าที่สุดก่อน (FIFO)</p>') +
      '<div class="cd-table-wrap"><table class="cd-table"><thead><tr><th>งวด</th><th>ครบกำหนด</th><th>ยอด</th><th>เงินต้น</th><th>ดอกเบี้ย</th><th>สถานะ</th>' + (canWrite() ? '<th></th>' : '') + '</tr></thead><tbody>' +
      ps.rows.map(function (r) {
        var s = ROW_STATE[r.state] || [r.state, 'muted'];
        return '<tr><td>' + r.seq + '</td><td class="cd-nowrap">' + esc(thDate(r.due_date)) + '</td><td class="cd-nowrap">' + fmt(r.amount, cur) + (r.estimate ? '' : ' <small class="cd-ok-t" title="ยืนยันยอดตาม statement แล้ว">✔</small>') +
          (r.paid && r.paid < r.amount ? '<br><small>จ่ายแล้ว ' + fmt(r.paid, cur) + '</small>' : '') + '</td><td>' + fmt(r.principal, cur) + '</td><td>' + fmt(r.interest, cur) + '</td><td>' + badge(s[0], s[1]) + '</td>' +
          (canWrite() ? '<td>' + (r.state !== 'cancelled' && r.state !== 'settled' ? btn('row-confirm', r.estimate ? 'ยืนยันยอด' : 'แก้ยอด', { 'data-id': r.id, 'data-plan': id, cls: 'cd-mini' }) : '') + '</td>' : '') + '</tr>';
      }).join('') + '</tbody></table></div>' +
      (old.length ? '<details class="cd-more"><summary>ประวัติการแก้ไข (' + (p.revision - 1) + ' ครั้ง)</summary><p class="cd-help">ตารางงวดฉบับเดิมที่ถูกแทนที่ เก็บไว้เพื่ออ้างอิง</p><ul class="cd-list">' +
        Object.keys(old.reduce(function (m, s) { (m[s.revision] = m[s.revision] || []).push(s); return m; }, {})).map(function (rev) {
          var rows = old.filter(function (s) { return String(s.revision) === rev; }), tot = rows.reduce(function (a, s) { return a + D.int(s.amount_minor); }, 0);
          return '<li class="cd-row"><div class="cd-grow"><b>ฉบับที่ ' + rev + '</b><small>' + rows.length + ' งวด · แทนที่เมื่อ ' + esc(thDate(rows[0].superseded_at)) + '</small></div><b>' + fmt(tot, cur) + '</b></li>';
        }).join('') + '</ul></details>' : ''));
  }
  function rowConfirm(rowId, planId) {
    var p = findPlan(planId), r = viewData().installment_schedules.find(function (s) { return String(s.id) === String(rowId); }); if (!p || !r) return;
    form('ยืนยันยอดงวดที่ ' + r.seq, [
      { name: 'amount', label: 'ยอดจริงตาม statement', type: 'money', value: D.rowAmount(r), required: true, help: 'ยอดประมาณการเดิม ' + fmt(r.amount_minor, p.currency) }
    ], 'ยืนยันยอด', function (o) { return runF(API.confirmRow(r.id, o.amount), 'ยืนยันยอดแล้ว').then(function () { planOpen(planId); }); },
    { currency: p.currency, intro: r.actual_amount_minor !== null && r.actual_amount_minor !== undefined ? 'งวดนี้ยืนยันแล้ว ' + fmt(r.actual_amount_minor, p.currency) + ' — แก้ไขได้' : '' });
  }

  /* ---- payment form */
  function payForm(preset) {
    preset = preset || {}; var crid = API.uuid(), d = viewData();
    var cur = preset.card ? findCard(preset.card).currency : preset.plan ? findPlan(preset.plan).currency : (S.ws === 'KRW' ? 'KRW' : 'THB');
    var targets = cards(cur).filter(function (c) { return c.status === 'active' || c.id === preset.card; }).map(function (c) { return ['card:' + c.id, '💳 ' + c.name]; })
      .concat(plans(cur).filter(function (p) { return !p.card_id && (p.status === 'active' || p.status === 'paused'); }).map(function (p) { return ['plan:' + p.id, '🏪 ' + p.product]; }));
    if (!targets.length) { toast('ยังไม่มีบัตรหรือแผนผ่อนนอกบัตรให้ชำระ', 'warn'); return; }
    var sel = preset.card ? 'card:' + preset.card : preset.plan ? 'plan:' + preset.plan : targets[0][0];
    function suggest(t) {
      var id = t.split(':')[1];
      if (t.indexOf('plan:') === 0) { var a = D.allocatePlan(d, findPlan(id)); return a.nextDue ? a.nextDue.amount - a.nextDue.paid : 0; }
      var st = D.cardStatus(d, findCard(id)); return Math.max(st.balance, 0);
    }
    form('บันทึกการชำระ', [
      { name: 'target', label: 'ชำระให้', type: 'select', value: sel, options: targets },
      { name: 'kind', label: 'ประเภทการชำระ', type: 'select', value: sel.indexOf('plan:') === 0 ? 'partial' : 'statement', options: Object.keys(PAY_KIND).map(function (k) { return [k, PAY_KIND[k]]; }), half: true },
      { name: 'method', label: 'ช่องทาง', type: 'select', value: 'bank_transfer', options: Object.keys(PAY_METHOD).map(function (k) { return [k, PAY_METHOD[k]]; }), half: true },
      { name: 'amount_minor', label: 'จำนวนเงิน', type: 'money', value: suggest(sel) || '', required: true, half: true },
      { name: 'paid_on', label: 'วันที่จ่าย', type: 'date', value: D.today(), required: true, half: true },
      { name: 'interest_minor', label: 'ในนี้เป็นดอกเบี้ย (ถ้ารู้)', type: 'money', half: true },
      { name: 'fee_minor', label: 'ในนี้เป็นค่าธรรมเนียม (ถ้ารู้)', type: 'money', half: true },
      { name: 'notes', label: 'โน้ต', type: 'textarea', max: 500 }
    ], 'บันทึกการชำระ', function (o, raw) {
      var t = raw.target.split(':');
      if ((o.interest_minor || 0) + (o.fee_minor || 0) > o.amount_minor) return Promise.reject(new Error('ดอกเบี้ย + ค่าธรรมเนียม ต้องไม่เกินยอดที่จ่าย'));
      var q = { client_request_id: crid, kind: o.kind, method: o.method, amount_minor: o.amount_minor, paid_on: o.paid_on, interest_minor: o.interest_minor || 0, fee_minor: o.fee_minor || 0, notes: o.notes || '' };
      q[t[0] === 'card' ? 'card_id' : 'plan_id'] = t[1];
      return runF(API.recordPayment(q), 'บันทึกการชำระแล้ว');
    }, { currency: cur, intro: 'บันทึกเฉพาะหนี้ ไม่ถูกนับเป็นรายจ่ายซ้ำ',
         preview: function (v) { return v.kind === 'settlement' && v.target.indexOf('plan:') === 0 ? '<p class="cd-help">ปิดยอดทั้งหมด: แผนนี้จะถูกเปลี่ยนเป็น “ปิดยอดแล้ว”</p>' : ''; } });
  }

  /* ---- adjustment / reconcile */
  function adjForm(cardId) {
    var crid = API.uuid(), cur = cardId ? findCard(cardId).currency : (S.ws === 'KRW' ? 'KRW' : 'THB');
    var cs = cards(cur).filter(function (c) { return c.status === 'active' || c.id === cardId; });
    if (!cs.length) { toast('เพิ่มบัตรก่อน', 'warn'); return; }
    form('ปรับยอด / กระทบยอดบัตร', [
      { name: 'card_id', label: 'บัตร', type: 'select', value: cardId || cs[0].id, options: cs.map(function (c) { return [c.id, c.name]; }) },
      { name: 'kind', label: 'ประเภท', type: 'select', value: 'reconcile', options: Object.keys(ADJ_KIND).map(function (k) { return [k, ADJ_KIND[k]]; }) },
      { name: 'statement_balance_minor', label: 'ยอดตาม statement', type: 'money', signed: true, required: true, show: function (v) { return v.kind === 'reconcile'; }, help: 'ระบบจะบันทึกส่วนต่างให้ยอดในแอปตรงกับธนาคาร' },
      { name: 'amount_minor', label: 'จำนวนเงิน', type: 'money', signed: true, required: true, show: function (v) { return v.kind !== 'reconcile'; }, help: 'คืนเงินจะถูกหักออกให้อัตโนมัติ · “อื่นๆ” ใส่ติดลบได้' },
      { name: 'effective_date', label: 'วันที่', type: 'date', value: D.today(), required: true },
      { name: 'notes', label: 'โน้ต', type: 'textarea', max: 500 }
    ], 'บันทึก', function (o, raw) {
      var q = { client_request_id: crid, card_id: raw.card_id, kind: o.kind, effective_date: o.effective_date, notes: o.notes || '' };
      if (o.kind === 'reconcile') {
        var st = D.cardStatus(viewData(), findCard(raw.card_id), o.effective_date), diff = o.statement_balance_minor - st.balance;
        if (!diff) return Promise.reject(new Error('ยอดตรงกับ statement อยู่แล้ว ไม่ต้องปรับ'));
        q.amount_minor = diff; q.statement_balance_minor = o.statement_balance_minor;
      } else q.amount_minor = o.amount_minor;
      return runF(API.addAdjustment(q), 'บันทึกแล้ว');
    }, { currency: cur, preview: function (v) {
      if (v.kind !== 'reconcile') return '';
      var st = D.cardStatus(viewData(), findCard(v.card_id), v.effective_date || D.today()), sb = D.toMinor(v.statement_balance_minor, cur);
      return '<div class="cd-prev"><div><span>ยอดในแอป ณ วันนั้น</span><b>' + fmt(st.balance, cur) + '</b></div>' + (sb !== null ? '<div><span>ส่วนต่างที่จะบันทึก</span><b>' + (sb - st.balance > 0 ? '+' : '') + fmt(sb - st.balance, cur) + '</b></div>' : '') + '</div>';
    } });
  }

  /* ---- transfer form */
  function trForm(t) {
    t = t || {}; var crid = API.uuid(), all = viewData().credit_cards.filter(function (c) { return c.status === 'active' || c.id === t.from_card_id || c.id === t.to_card_id; });
    if (!all.length) { toast('เพิ่มบัตรก่อน', 'warn'); return; }
    var opts = all.map(function (c) { return [c.id, c.name + ' (' + c.currency + ')']; });
    var cur0 = S.ws === 'KRW' ? 'KRW' : 'THB', def = all.filter(function (c) { return c.currency === cur0; });
    var curOf = function (id) { var c = findCard(id); return c ? c.currency : 'THB'; };
    var fields = [
      { name: 'type', label: 'ประเภท', type: 'select', value: t.type || 'balance_transfer', options: Object.keys(D.TRANSFER_TYPES).map(function (k) { return [k, D.TRANSFER_TYPES[k]]; }),
        help: 'โอนหนี้: ย้ายยอดจากบัตรหนึ่งไปอีกบัตร · บัตรจ่ายบัตร: ใช้วงเงินบัตรหนึ่งไปจ่ายอีกบัตร · กดเงินสด: เพิ่มหนี้บนบัตร · ปรับโครงสร้าง: เปลี่ยนเงื่อนไขหนี้เดิม' },
      { name: 'from_card_id', label: 'จากบัตร (หนี้ลดลง)', type: 'select', value: t.from_card_id || (def[0] || all[0]).id, options: opts, half: true, show: function (v) { return v.type !== 'cash_advance'; } },
      { name: 'to_card_id', label: 'ไปบัตร (หนี้เพิ่มขึ้น)', type: 'select', value: t.to_card_id || (def[1] || def[0] || all[0]).id, options: opts, half: true },
      { name: 'amount_minor', label: 'ยอดที่ย้าย', type: 'money', value: t.amount_minor, required: true, half: true },
      { name: 'fee_minor', label: 'ค่าธรรมเนียม (บนบัตรปลายทาง)', type: 'money', value: t.fee_minor || '', half: true, currencyOf: function (v) { return curOf(v.to_card_id); } },
      { name: 'dest_amount_minor', label: 'ยอดที่เข้าบัตรปลายทาง', type: 'money', value: t.dest_amount_minor, required: true, half: true, currencyOf: function (v) { return curOf(v.to_card_id); }, show: function (v) { return v.type !== 'cash_advance' && curOf(v.from_card_id) !== curOf(v.to_card_id); } },
      { name: 'fx_rate', label: 'เรตแลกเปลี่ยนที่ใช้', type: 'text', value: t.fx_rate || '', required: true, half: true, pattern: /^\d+(\.\d+)?$/, patternMsg: 'ตัวเลข', show: function (v) { return v.type !== 'cash_advance' && curOf(v.from_card_id) !== curOf(v.to_card_id); } },
      { name: 'fx_date', label: 'วันที่ของเรต', type: 'date', value: t.fx_date || D.today(), required: true, half: true, show: function (v) { return v.type !== 'cash_advance' && curOf(v.from_card_id) !== curOf(v.to_card_id); } },
      { name: 'installments', label: 'ผ่อนกี่งวด (0 = ไม่ผ่อน)', type: 'int', value: t.installments || 0, min: 0, maxv: 120, half: true },
      { name: 'rate_bp', label: 'ดอกเบี้ยต่อปี (%)', type: 'percent', value: t.rate_bp ? t.rate_bp / 100 : '', half: true },
      { name: 'transfer_date', label: 'วันที่ทำรายการ', type: 'date', value: t.transfer_date || D.today(), required: true, half: true },
      { name: 'effective_date', label: 'วันที่มีผล', type: 'date', value: t.effective_date || t.transfer_date || D.today(), half: true },
      { name: 'status', label: 'สถานะ', type: 'select', value: t.status || 'draft', options: [['draft', 'ร่าง (ยังไม่กระทบยอด)'], ['pending', 'รอธนาคารดำเนินการ'], ['confirmed', 'ยืนยันแล้ว (ยอดย้ายทันที)']] },
      { name: 'related_ref', label: 'เลขอ้างอิง', type: 'text', value: t.related_ref, max: 60, half: true },
      { name: 'notes', label: 'โน้ต', type: 'textarea', value: t.notes, max: 500 }
    ];
    form(t.id ? 'แก้ไขการโอนหนี้' : 'บันทึกการโอนหนี้', fields, 'บันทึก', function (o, raw) {
      var q = Object.assign({}, o, { fee_minor: o.fee_minor || 0, rate_bp: o.rate_bp || 0, installments: o.installments || 0, effective_date: o.effective_date || o.transfer_date });
      if (raw.type === 'cash_advance') q.from_card_id = null;
      if (t.id) { q.id = t.id; q.base_version = t.version; } else q.client_request_id = crid;
      return runF(API.saveTransfer(q), o.status === 'confirmed' ? 'ยืนยันการโอนแล้ว — ยอดบัตรอัปเดตแล้ว' : 'บันทึกแล้ว');
    }, { currency: cur0, currencyOf: function (v) { return curOf(v.type === 'cash_advance' ? v.to_card_id : v.from_card_id); },
      onChange: function (v, fe) {
        var c = curOf(v.type === 'cash_advance' ? v.to_card_id : v.from_card_id), dc = curOf(v.to_card_id);
        fe.querySelectorAll('[data-field] > span small').forEach(function (s) { var f = s.closest('[data-field]').getAttribute('data-field'); s.textContent = '(' + (f === 'dest_amount_minor' || f === 'fee_minor' ? dc : c) + ')'; });
      },
      preview: function (v) {
        var amt = D.toMinor(v.amount_minor, curOf(v.from_card_id)), n = Number(v.installments || 0);
        if (!amt) return '';
        return '<p class="cd-help">' + (v.status === 'confirmed' ? '✔ ยอดจะย้ายทันทีเมื่อบันทึก' : '⏳ ยอดบนบัตรยังไม่เปลี่ยน จนกว่าจะกด “ยืนยัน”') + (n > 0 ? ' · สร้างแผนผ่อน ' + n + ' งวดบนบัตรปลายทาง' : '') + '</p>';
      } });
  }

  /* ---- export */
  function download(name, text, type) {
    var a = document.createElement('a'), url = URL.createObjectURL(new Blob([text], { type: type }));
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 500);
  }
  function exportJSON() { download('smart-debt-' + D.today() + '.json', JSON.stringify(Object.assign({ exported_at: new Date().toISOString() }, S.data), null, 2), 'application/json'); toast('ส่งออก JSON แล้ว'); }
  function exportCSV() {
    var d = S.data, cn = function (id) { var c = findCard(id); return c ? c.name : ''; }, pn = function (id) { var p = findPlan(id); return p ? p.product : ''; };
    var rows = [];
    d.installment_plans.forEach(function (p) {
      D.liveRows(d, p.id).forEach(function (s) {
        rows.push({ type: 'installment', date: s.due_date, currency: p.currency, amount: D.toMajor(D.rowAmount(s), p.currency), card: cn(p.card_id), item: p.product + ' #' + s.seq, status: p.status, confirmed: s.actual_amount_minor === null || s.actual_amount_minor === undefined ? 'estimate' : 'confirmed' });
      });
    });
    d.debt_payments.forEach(function (p) { rows.push({ type: 'payment', date: p.paid_on, currency: p.currency, amount: D.toMajor(p.amount_minor, p.currency), card: cn(p.card_id), item: pn(p.plan_id) || PAY_KIND[p.kind], status: p.status, confirmed: '' }); });
    d.debt_transfers.forEach(function (t) { rows.push({ type: 'transfer:' + t.type, date: t.effective_date, currency: t.currency, amount: D.toMajor(t.amount_minor, t.currency), card: cn(t.from_card_id) + ' → ' + cn(t.to_card_id), item: t.related_ref || '', status: t.status, confirmed: '' }); });
    d.debt_adjustments.forEach(function (a) { rows.push({ type: 'adjustment:' + a.kind, date: a.effective_date, currency: a.currency, amount: D.toMajor(a.amount_minor, a.currency), card: cn(a.card_id), item: a.notes || '', status: a.status, confirmed: '' }); });
    rows.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    download('smart-debt-' + D.today() + '.csv', D.toCSV(rows, ['date', 'type', 'currency', 'amount', 'card', 'item', 'status', 'confirmed']), 'text/csv;charset=utf-8');
    toast('ส่งออก CSV แล้ว');
  }

  /* ------------------------------------------------------------ events */
  function onClick(ev) {
    var el = ev.target.closest('[data-act]'); if (!el || (root && !root.contains(el) && !modal.contains(el))) return;
    var a = el.getAttribute('data-act'), id = el.getAttribute('data-id');
    var writes = /^(card-new|card-edit|card-status|card-del|plan-new|plan-edit|plan-status|plan-del|row-confirm|pay-new|pay-cancel|adj-new|adj-cancel|tr-new|tr-edit|tr-status|tr-del|payoff-save|payoff-del)$/;
    if (writes.test(a) && !canWrite()) { toast(S.demo ? 'นี่คือข้อมูลตัวอย่าง — อัปเกรด Premium เพื่อใช้งานจริง' : 'โหมดอ่านอย่างเดียว — ต่ออายุ Premium เพื่อแก้ไข', 'warn'); return; }
    if (a !== 'modal-close' && el.closest('.cd-modal') && /^(pay-new|plan-new|adj-new|card-edit|plan-edit|tr-edit|row-confirm)$/.test(a)) closeModal();
    switch (a) {
      case 'reload': load(); break;
      case 'login': if (window.kfpAuth) window.kfpAuth.open('login'); break;
      case 'demo-on': S.demo = true; if (!S.ws || S.ws === 'overview') S.ws = 'overview'; render(); break;
      case 'demo-off': S.demo = false; render(); break;
      case 'ws': S.ws = el.getAttribute('data-ws'); S.planner = null; S.day = null; savePrefs(); render(); window.scrollTo({ top: 0, behavior: 'smooth' }); break;
      case 'tab': S.tab = el.getAttribute('data-tab'); savePrefs(); render(); break;
      case 'disp': var pr = prefs(); pr.disp = el.getAttribute('data-cur'); try { localStorage.setItem(PREF, JSON.stringify(Object.assign(pr, { ws: S.ws, tab: S.tab, rate: S.rate }))); } catch (_) {} render(); break;
      case 'plan-filter': S.planFilter = el.getAttribute('data-f'); render(); break;
      case 'month': var dd = Number(el.getAttribute('data-d')); S.month = dd ? D.monthKey(D.addMonths(S.month + '-01', dd)) : D.monthKey(D.today()); S.day = dd ? null : D.today(); render(); break;
      case 'day': S.day = el.getAttribute('data-day'); render(); break;
      case 'modal-close': closeModal(); if (modal._resolve) { var r = modal._resolve; modal._resolve = null; r(); } break;
      case 'card-new': cardForm(); break;
      case 'card-open': cardOpen(id); break;
      case 'card-edit': cardForm(findCard(id)); break;
      case 'card-status': var c = findCard(id); closeModal(); run(API.setCardStatus(id, c.status === 'active' ? 'archived' : 'active', c.version), c.status === 'active' ? 'เก็บบัตรเข้าคลังแล้ว' : 'นำบัตรออกจากคลังแล้ว'); break;
      case 'card-del': closeModal(); confirmBox('ลบบัตรนี้?', 'ลบได้เฉพาะบัตรที่ยังไม่มีรายการใดๆ — ถ้ามีประวัติแล้วให้ “เก็บเข้าคลัง” แทน', 'ลบบัตร', true).then(function (ok) { if (ok) run(API.deleteCard(id), 'ลบบัตรแล้ว'); }); break;
      case 'plan-new': planForm(null, el.getAttribute('data-card')); break;
      case 'plan-open': if (el.closest('.cd-modal')) closeModal(); planOpen(id); break;
      case 'plan-edit': planForm(findPlan(id)); break;
      case 'plan-status': var st = el.getAttribute('data-st'), p = findPlan(id);
        var msg = { paused: ['พักชำระแผนนี้?', 'งวดที่ครบกำหนดหลังวันนี้จะไม่ถูกนับจนกว่าจะกด “ผ่อนต่อ”'], active: ['ผ่อนต่อ?', 'งวดจะกลับมานับตามตารางเดิม'],
                    settled: ['ปิดยอดก่อนกำหนด?', p.card_id ? 'เงินต้นที่เหลือจะถูกเรียกเก็บบนบัตรทันที ดอกเบี้ยงวดที่เหลือไม่ถูกนับ' : 'แผนจะถูกปิด ยอดคงเหลือเป็น 0 (บันทึกการชำระปิดยอดแยกได้)'],
                    cancelled: ['ยกเลิกแผนผ่อน?', 'งวดทั้งหมดจะไม่ถูกนับอีก ประวัติยังเก็บไว้ (ย้อนกลับไม่ได้)'] }[st];
        closeModal(); confirmBox(msg[0], msg[1], 'ยืนยัน', st === 'cancelled').then(function (ok) { if (ok) run(API.setInstallmentStatus(id, st, p.version, D.today()), 'อัปเดตสถานะแล้ว'); }); break;
      case 'plan-del': closeModal(); confirmBox('ลบแผนผ่อนนี้?', 'ลบได้เฉพาะแผนที่ยังไม่มีการชำระ — ลบแล้วกู้คืนไม่ได้', 'ลบแผน', true).then(function (ok) { if (ok) run(API.deleteInstallment(id), 'ลบแผนแล้ว'); }); break;
      case 'row-confirm': rowConfirm(id, el.getAttribute('data-plan')); break;
      case 'pay-new': payForm({ card: el.getAttribute('data-card'), plan: el.getAttribute('data-plan') }); break;
      case 'pay-cancel': confirmBox('ยกเลิกรายการชำระ?', 'รายการจะยังอยู่ในประวัติแต่ไม่ถูกนับในยอด', 'ยกเลิกรายการ', true).then(function (ok) { if (ok) run(API.cancelPayment(id), 'ยกเลิกรายการแล้ว'); }); break;
      case 'adj-new': adjForm(el.getAttribute('data-card')); break;
      case 'adj-cancel': confirmBox('ยกเลิกการปรับยอด?', 'ยอดบัตรจะคำนวณใหม่โดยไม่รวมรายการนี้', 'ยกเลิกรายการ', true).then(function (ok) { if (ok) run(API.cancelAdjustment(id), 'ยกเลิกแล้ว'); }); break;
      case 'tr-new': trForm(); break;
      case 'tr-edit': trForm(viewData().debt_transfers.find(function (t) { return t.id === id; })); break;
      case 'tr-status': var t = viewData().debt_transfers.find(function (x) { return x.id === id; }), s2 = el.getAttribute('data-st');
        var m2 = { confirmed: ['ยืนยันการโอน?', 'ยอดบนบัตรต้นทาง/ปลายทางจะเปลี่ยนทันที' + (t.installments ? ' และสร้างแผนผ่อน ' + t.installments + ' งวด' : '')],
                   failed: ['ทำเครื่องหมายว่าไม่สำเร็จ?', 'ยอดบนบัตรจะไม่เปลี่ยน'],
                   cancelled: ['ยกเลิกรายการโอน?', t.status === 'confirmed' ? 'ระบบจะย้อนยอดกลับ และยกเลิกแผนผ่อนที่เกิดจากการโอนนี้' : 'รายการนี้จะไม่ถูกนับ'] }[s2];
        confirmBox(m2[0], m2[1], 'ยืนยัน', s2 !== 'confirmed').then(function (ok) { if (ok) run(API.setTransferStatus(id, s2, t.version), 'อัปเดตแล้ว'); }); break;
      case 'tr-del': confirmBox('ลบร่างนี้?', 'ลบได้เฉพาะรายการที่ยังเป็นร่าง', 'ลบ', true).then(function (ok) { if (ok) run(API.deleteTransfer(id), 'ลบแล้ว'); }); break;
      case 'strategy': S.planner.strategy = el.getAttribute('data-s'); render(); break;
      case 'prio': var P = S.planner, o = P.order || P.debts.map(function (x) { return x.id; }), i = o.indexOf(id), j = i + Number(el.getAttribute('data-d'));
        if (j >= 0 && j < o.length) { o.splice(j, 0, o.splice(i, 1)[0]); P.order = o; render(); } break;
      case 'payoff-save': var PP = S.planner, res = D.payoff(PP.debts, PP.budget, PP.strategy, PP.order), crid = API.uuid();
        form('บันทึกแผนปลดหนี้', [{ name: 'name', label: 'ชื่อแผน', type: 'text', required: true, max: 60, value: 'แผน ' + PP.strategy + ' ' + thDate(D.today()) }], 'บันทึก', function (fo) {
          return runF(API.savePayoff({ client_request_id: crid, name: fo.name, strategy: PP.strategy, currency: PP.cur, budget_minor: PP.budget, priorities: PP.order || [],
            assumptions: { debts: PP.debts, notes: res.assumptions }, result: { months: res.months, total_interest: res.totalInterest, total_paid: res.totalPaid, order: res.order } }), 'บันทึกแผนแล้ว');
        }); break;
      case 'payoff-load': var x = viewData().debt_payoff_plans.find(function (y) { return y.id === id; });
        if (x) { S.planner = { cur: x.currency, strategy: x.strategy, budget: D.int(x.budget_minor), debts: (x.assumptions && x.assumptions.debts) || plannerDebts(x.currency), order: x.priorities && x.priorities.length ? x.priorities : null }; render(); toast('เปิดแผน “' + x.name + '” แล้ว (ยอดตามวันที่บันทึก)'); } break;
      case 'payoff-del': confirmBox('ลบแผนนี้?', 'ลบแล้วกู้คืนไม่ได้', 'ลบ', true).then(function (ok) { if (ok) run(API.deletePayoff(id), 'ลบแผนแล้ว'); }); break;
      case 'export-json': exportJSON(); break;
      case 'export-csv': exportCSV(); break;
    }
  }
  function onChange(ev) {
    var t = ev.target;
    if (t.id === 'cdRate') { var r = Number(String(t.value).replace(/,/g, '')); if (r > 0 && r < 100000) { S.rate = r; savePrefs(); render(); } else toast('เรตไม่ถูกต้อง', 'warn'); }
    if (t.id === 'cdBudget' && S.planner) { var b = D.toMinor(t.value, S.planner.cur); if (b && b > 0) { S.planner.budget = b; render(); } else toast('งบไม่ถูกต้อง', 'warn'); }
    if (t.getAttribute('data-pl') && S.planner) {
      var dbt = S.planner.debts.find(function (x) { return x.id === t.getAttribute('data-id'); }); if (!dbt) return;
      if (t.getAttribute('data-pl') === 'apr') { var a = Number(t.value); if (a >= 0 && a <= 100) dbt.aprBp = Math.round(a * 100); }
      else { var m = D.toMinor(t.value, S.planner.cur); if (m !== null && m >= 0) dbt.minPayment = m; }
      render();
    }
  }
  function onKey(ev) {
    if (ev.key === 'Escape' && modal && !modal.hidden) { closeModal(); if (modal._resolve) { var r = modal._resolve; modal._resolve = null; r(); } }
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches && ev.target.matches('[role=button][data-act]')) { ev.preventDefault(); ev.target.click(); }
    if (ev.key === 'Tab' && modal && !modal.hidden) {
      var f = modal.querySelectorAll('button,input,select,textarea,[tabindex="0"]'); if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    }
  }

  /* ------------------------------------------------------------ boot */
  function defaultWs() {
    var pf = prefs(); if (pf.ws) return pf.ws;
    var prof = window.kfpAuth && window.kfpAuth.profile && window.kfpAuth.profile();
    var c = (prof && prof.country) || (window.kfpCountry && window.kfpCountry.get && window.kfpCountry.get());
    return c === 'KR' ? 'KRW' : c === 'TH' ? 'THB' : 'overview';
  }
  function boot() {
    root = document.getElementById('debtApp'); if (!root) return;
    modal = document.getElementById('cdModal'); toastEl = document.getElementById('cdToast');
    var pf = prefs(); S.tab = pf.tab || 'cards'; S.rate = pf.rate || null; S.ws = defaultWs();
    document.addEventListener('click', onClick); document.addEventListener('change', onChange); document.addEventListener('keydown', onKey);
    load();
    var t = null;
    var again = function () { clearTimeout(t); t = setTimeout(function () { if (!prefs().ws) S.ws = defaultWs(); load(true); }, 150); };
    window.addEventListener('kfp:auth-ready', again); window.addEventListener('kfp:plan', again);
    window.addEventListener('online', function () { if (S.offline) load(true); });
    window.__kfpDebt = { state: S, reload: load };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
