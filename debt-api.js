/* Smart Credit & Debt — data layer.
 * Reads:  get_my_debt_access() (mode, display only) + export_my_debt() (all of the member's own rows, any plan state)
 * Writes: debt_* RPCs only (the server checks Premium, ownership, versions, idempotency — never the browser).
 * Last good snapshot is cached on this device (namespaced per account by kfp-storage.js) for offline viewing. */
(function () {
  'use strict';
  if (window.kfpDebtApi) return;
  var CACHE = 'kfp_debt_cache_v1';
  var EMPTY = function () {
    return { credit_cards: [], installment_plans: [], installment_schedules: [], debt_transfers: [], debt_payments: [],
             debt_adjustments: [], debt_payoff_plans: [] };
  };

  var ERR = {
    premium_required: 'ต้องใช้ Finance Premium — ข้อมูลเดิมยังดูได้ แต่เพิ่ม/แก้ไขไม่ได้',
    not_authenticated: 'กรุณาเข้าสู่ระบบก่อน',
    rate_limited: 'ทำรายการถี่เกินไป กรุณารอสักครู่แล้วลองใหม่',
    conflict: 'ข้อมูลนี้ถูกแก้จากอุปกรณ์อื่น — โหลดข้อมูลล่าสุดแล้ว กรุณาลองอีกครั้ง',
    base_version_required: 'ข้อมูลไม่ครบ กรุณาโหลดหน้าใหม่',
    card_not_found: 'ไม่พบบัตรนี้', plan_not_found: 'ไม่พบแผนผ่อนนี้', transfer_not_found: 'ไม่พบรายการโอนนี้',
    payment_not_found: 'ไม่พบรายการชำระนี้', payoff_not_found: 'ไม่พบแผนนี้', row_not_found: 'ไม่พบงวดนี้',
    adjustment_not_found: 'ไม่พบรายการปรับยอดนี้',
    card_has_history: 'บัตรนี้มีประวัติแล้ว ลบไม่ได้ — ใช้ “เก็บเข้าคลัง” แทน',
    plan_has_payments: 'แผนนี้มีการชำระแล้ว ลบหรือย้ายบัตรไม่ได้ — ใช้ “ยกเลิก” แทน',
    plan_from_transfer: 'แผนนี้สร้างจากการโอนหนี้ — แก้ที่รายการโอนแทน',
    plan_closed: 'แผนนี้ปิด/ยกเลิกแล้ว แก้เงื่อนไขไม่ได้',
    plan_on_card: 'แผนผ่อนบนบัตรชำระผ่านการจ่ายบัตร (กัน “นับซ้ำ”) — เลือกจ่ายที่บัตรแทน',
    card_archived: 'บัตรนี้อยู่ในคลัง — นำออกจากคลังก่อน',
    currency_locked: 'บัตรนี้มีรายการแล้ว เปลี่ยนสกุลเงินไม่ได้',
    transfer_locked: 'รายการโอนที่ยืนยันแล้วแก้ไม่ได้ — ยกเลิกแล้วสร้างใหม่',
    invalid_transition: 'เปลี่ยนสถานะแบบนี้ไม่ได้',
    same_card: 'บัตรต้นทางและปลายทางต้องเป็นคนละใบ',
    fx_required: 'ต่างสกุลเงิน: กรุณากรอกเรตแลกเปลี่ยน วันที่ของเรต และยอดปลายทาง',
    from_card_required: 'กรุณาเลือกบัตรต้นทาง', to_card_required: 'กรุณาเลือกบัตรปลายทาง',
    target_required: 'กรุณาเลือกบัตรหรือแผนผ่อนที่ชำระ',
    statement_balance_required: 'กรุณากรอกยอดตาม statement',
    invalid_amount: 'จำนวนเงินไม่ถูกต้อง', invalid_custom: 'ตารางงวดกำหนดเองไม่ถูกต้อง (วันที่ต้องเรียงกัน ยอด > 0)',
    invalid_months: 'จำนวนงวดต้องอยู่ระหว่าง 1–120', invalid_currency: 'เลือกได้แค่ THB หรือ KRW',
    too_long_last4: 'เก็บได้แค่เลข 4 หลักท้ายของบัตร',
    too_many_cards: 'บัตรครบ 50 ใบแล้ว', too_many_plans: 'แผนผ่อนครบ 500 แผนแล้ว', too_many_payments: 'รายการชำระเต็มแล้ว',
    too_many_transfers: 'รายการโอนเต็มแล้ว', too_many_adjustments: 'รายการปรับยอดเต็มแล้ว', too_many_payoff_plans: 'แผนปลดหนี้ครบ 50 แผนแล้ว',
    network: 'เชื่อมต่อไม่ได้ — ตรวจอินเทอร์เน็ตแล้วลองใหม่ (ข้อมูลยังไม่ถูกบันทึก)'
  };
  function message(e) {
    var m = String((e && (e.message || e.msg)) || e || '');
    var key = Object.keys(ERR).find(function (k) { return m === k || m.indexOf(k) === 0; });
    if (key) return ERR[key];
    if (/^invalid_/.test(m)) return 'ข้อมูลไม่ถูกต้อง: ' + m.replace(/^invalid_/, '');
    if (/^too_long_/.test(m)) return 'ข้อความยาวเกินไป: ' + m.replace(/^too_long_/, '');
    if (/check constraint|violates/.test(m)) return 'ข้อมูลไม่ถูกต้อง กรุณาตรวจอีกครั้ง';
    if (/fetch|network|Failed/i.test(m) || !m) return ERR.network;
    return m;
  }
  function code(e) {
    var m = String((e && (e.message || e.msg)) || '');
    if (/premium_required/.test(m)) return 'locked';
    if (/^conflict/.test(m)) return 'conflict';
    if (/fetch|network|Failed/i.test(m) || (e && e.code === '' && !m)) return 'network';
    return 'error';
  }

  function client() { return window.kfpAuth && window.kfpAuth.client && window.kfpAuth.client(); }
  function user() { return window.kfpAuth && window.kfpAuth.user && window.kfpAuth.user(); }
  function isPreview() { var KS = window.kfpStorage; return KS ? KS.isPreview() : !user(); }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function rpc(fn, args) {
    var c = client();
    if (!c) return Promise.reject(new Error('network'));
    return c.rpc(fn, args || {}).then(function (r) {
      if (r.error) { var e = new Error(r.error.message || 'error'); e.code = r.error.code; throw e; }
      return r.data;
    }, function (e) { throw new Error((e && e.message) || 'network'); });
  }

  function normalize(x) {
    var d = EMPTY();
    if (x && typeof x === 'object') Object.keys(d).forEach(function (k) { if (Array.isArray(x[k])) d[k] = x[k]; });
    return d;
  }
  function readCache() { try { var c = JSON.parse(localStorage.getItem(CACHE) || 'null'); return c && c.data ? c : null; } catch (_) { return null; } }
  function writeCache(data, access) {
    try { localStorage.setItem(CACHE, JSON.stringify({ at: new Date().toISOString(), access: access, data: data })); } catch (_) {}
  }

  // → {access, data, offline, cachedAt}
  function load() {
    if (isPreview()) return Promise.resolve({ access: { mode: 'guest' }, data: EMPTY(), offline: false });
    if (!user() || !client()) return Promise.resolve({ pending: true });
    return Promise.all([rpc('get_my_debt_access'), rpc('export_my_debt')]).then(function (r) {
      var access = r[0] || { mode: 'locked' }, data = normalize(r[1]);
      writeCache(data, access);
      return { access: access, data: data, offline: false };
    }, function (e) {
      var c = readCache();
      if (c && code(e) === 'network') return { access: Object.assign({}, c.access, { mode: 'offline', was: c.access && c.access.mode }), data: normalize(c.data), offline: true, cachedAt: c.at };
      throw e;
    });
  }

  window.kfpDebtApi = {
    EMPTY: EMPTY, uuid: uuid, message: message, code: code, load: load, isPreview: isPreview,
    cached: function () { if (isPreview()) return null; var c = readCache(); return c ? { access: c.access, data: normalize(c.data), cachedAt: c.at } : null; },
    saveCard: function (p) { return rpc('debt_save_card', { p: p }); },
    setCardStatus: function (id, st, v) { return rpc('debt_set_card_status', { p_id: id, p_status: st, p_base_version: v }); },
    deleteCard: function (id) { return rpc('debt_delete_card', { p_id: id }); },
    saveInstallment: function (p) { return rpc('debt_save_installment', { p: p }); },
    setInstallmentStatus: function (id, st, v, d) { return rpc('debt_set_installment_status', { p_id: id, p_status: st, p_base_version: v, p_date: d || null }); },
    deleteInstallment: function (id) { return rpc('debt_delete_installment', { p_id: id }); },
    confirmRow: function (row, amount) { return rpc('debt_confirm_schedule', { p_row: row, p_amount: amount }); },
    recordPayment: function (p) { return rpc('debt_record_payment', { p: p }); },
    cancelPayment: function (id) { return rpc('debt_cancel_payment', { p_id: id }); },
    saveTransfer: function (p) { return rpc('debt_save_transfer', { p: p }); },
    setTransferStatus: function (id, st, v) { return rpc('debt_set_transfer_status', { p_id: id, p_status: st, p_base_version: v }); },
    deleteTransfer: function (id) { return rpc('debt_delete_transfer', { p_id: id }); },
    addAdjustment: function (p) { return rpc('debt_add_adjustment', { p: p }); },
    cancelAdjustment: function (id) { return rpc('debt_cancel_adjustment', { p_id: id }); },
    savePayoff: function (p) { return rpc('debt_save_payoff_plan', { p: p }); },
    deletePayoff: function (id) { return rpc('debt_delete_payoff_plan', { p_id: id }); }
  };
})();
