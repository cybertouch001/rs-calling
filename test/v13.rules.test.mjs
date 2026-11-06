// v1.3 rules tests (pure functions, no server): node test/v13.rules.test.mjs
import assert from 'node:assert/strict';
import * as R from '../server/rules.js';
const SINCE = Date.UTC(2026, 10, 6, 18, 0, 0);       // switch-on moment used by the tests
const S = { ...R.DEFAULTS, v13_since: SINCE, callback_since: SINCE, callback_counts: 1, min_duration: 30, repeat_hours: 24, call_rate: 2, lead_rate: 20 };
const T0 = SINCE + 3600000;                           // an hour after switch-on
const call = (o) => ({ id: o.id, user_id: 'u1', phone: '9876543210', start_ts: o.t ?? T0, tapped_at: o.t ?? T0, duration: o.d ?? 60, log_found: 1, assigned_ok: 1, outcome: o.o ?? null, override: null, lead_override: null, approval_id: null, call_rate: 2, lead_rate: 20, ...o.extra });
const pay = (calls) => { const m = R.chainNumber(calls.map(c => ({ ...c, elig_reason: R.baseReason(c, S) })), S); return { m, t: R.totals(calls.map(c => ({ ...c, ...m.get(c.id) })), [], []) }; };
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok -', name); };

ok('answered call pays the call rate once', () => {
  const { t } = pay([call({ id: 'a1', o: 'not_interested' })]);
  assert.equal(t.call_amount, 2); assert.equal(t.lead_amount, 0); assert.equal(t.payout, 2);
});
ok('not answered (no pickup) pays nothing', () => {
  const { m, t } = pay([call({ id: 'a2', d: 0 })]);
  assert.equal(m.get('a2').counted, false); assert.equal(m.get('a2').call_pay, false); assert.equal(t.payout, 0);
});
ok('cut call (too short) pays nothing', () => {
  const { t } = pay([call({ id: 'a3', d: 12 })]); assert.equal(t.payout, 0);
});
ok('interested call pays the lead only, no call rate on top', () => {
  const { m, t } = pay([call({ id: 'i1', o: 'interested' })]);
  assert.equal(m.get('i1').counted, true); assert.equal(m.get('i1').lead_counted, true);
  assert.equal(t.call_amount, 0); assert.equal(t.lead_amount, 20); assert.equal(t.payout, 20);
});
ok('second interested call for the same number: no lead, no call rate', () => {
  const { t } = pay([call({ id: 'i2', o: 'interested', t: T0 }), call({ id: 'i3', o: 'interested', t: T0 + 3 * 86400000 })]);
  assert.equal(t.leads, 1); assert.equal(t.call_amount, 0); assert.equal(t.payout, 20);
});
ok('interested but too short: no lead and no call pay', () => {
  const { t } = pay([call({ id: 'i4', o: 'interested', d: 10 })]); assert.equal(t.payout, 0);
});
ok('legacy call before the switch-on keeps both payouts (no back-recompute)', () => {
  const old = call({ id: 'l1', o: 'interested', t: SINCE - 86400000 });
  const { m, t } = pay([old]); assert.equal(m.get('l1').call_pay, true); assert.equal(t.payout, 22);
});
ok('stored legacy row (call_pay null) still pays as before', () => {
  const t = R.totals([{ counted: 1, call_pay: null, call_rate: 2, outcome: 'interested', lead_counted: 1, lead_rate: 20, duration: 60 }]);
  assert.equal(t.payout, 22);
});
ok('repeat calls within 24h to the same number: one counted call', () => {
  const { t } = pay([call({ id: 'r1', o: 'not_interested', t: T0 }), call({ id: 'r2', o: 'not_interested', t: T0 + 3600000 })]);
  assert.equal(t.counted, 1); assert.equal(t.payout, 2);
});
ok('re-evaluation is idempotent (same result twice)', () => {
  const list = [call({ id: 'x1', o: 'interested' }), call({ id: 'x2', d: 0, t: T0 + 1000 }), call({ id: 'x3', t: T0 + 2 * 3600000 })];
  const a = pay(list).t; const b = pay(list).t; assert.deepEqual(a, b);
});
ok('callback answered after a not-answered call pays once', () => {
  const cb = [{ id: 'c1', phone: '9876543210', start_ts: T0 + 3600000, duration: 90, kind: 'incoming' }];
  const res = R.callbackCounting(cb, S); assert.equal(res.get('c1').counted, true);
  const t = R.totals([], [], [{ counted: 1, rate: 2 }]); assert.equal(t.callback_amount, 2);
});
ok('two callbacks from the same number inside 24h pay once', () => {
  const cb = [{ id: 'c2', phone: '9876543210', start_ts: T0 + 3600000, duration: 90, kind: 'incoming' }, { id: 'c3', phone: '9876543210', start_ts: T0 + 7200000, duration: 90, kind: 'incoming' }];
  const res = R.callbackCounting(cb, S); assert.equal(res.get('c2').counted, true); assert.equal(res.get('c3').counted, false);
});
ok('missed callback (caller rang, nobody answered) pays nothing', () => {
  const cb = [{ id: 'c4', phone: '9876543210', start_ts: T0, duration: 0, kind: 'missed' }];
  assert.equal(R.callbackCounting(cb, S).get('c4').counted, false);
});
ok('callback before the switch-on is never back-paid', () => {
  const cb = [{ id: 'c5', phone: '9876543210', start_ts: SINCE - 3600000, duration: 90, kind: 'incoming' }];
  assert.equal(R.callbackCounting(cb, S).get('c5').counted, false);
});
ok('callbacks off stay unpaid (old setting respected)', () => {
  const cb = [{ id: 'c6', phone: '9876543210', start_ts: T0, duration: 90, kind: 'incoming' }];
  assert.equal(R.callbackCounting(cb, { ...S, callback_counts: 0 }).get('c6').counted, false);
});
ok('callback that is shorter than the minimum pays nothing', () => {
  const cb = [{ id: 'c7', phone: '9876543210', start_ts: T0, duration: 5, kind: 'incoming' }];
  assert.equal(R.callbackCounting(cb, S).get('c7').counted, false);
});
ok('same number uploaded twice: the file-level dedupe still reports existing numbers', () => {
  const r = R.cleanRows([{ phone: '9876543210', name: 'A' }, { phone: '09876543210', name: 'B' }, { phone: '9123456789' }], new Set(['9123456789']));
  assert.equal(r.report.added, 1); assert.equal(r.report.dup_in_file, 1); assert.equal(r.report.dup_existing, 1);
});
console.log(`${n} v1.3 rules tests passed`);
