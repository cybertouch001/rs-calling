import test from 'node:test'; import assert from 'node:assert/strict';
import * as R from '../server/rules.js';
const S = { ...R.DEFAULTS };
const T0 = Date.parse('2026-11-04T05:00:00Z'); // 10:30 IST
let n = 0; const call = (o) => ({ id: 'c' + (++n), user_id: 'u1', phone: '9876543210', log_phone: '+91 98765 43210', tapped_at: T0, start_ts: T0 + 2000, duration: 60, log_found: 1, assigned_ok: 1, ...o });
const ev = (calls, s = {}) => R.evaluateAll(calls, { ...S, ...s });

test('phone normalisation', () => {
  assert.equal(R.normPhone('+91 98765-43210'), '9876543210'); assert.equal(R.normPhone('09876543210'), '9876543210');
  assert.equal(R.normPhone('919876543210'), '9876543210'); assert.equal(R.normPhone(9876543210), '9876543210');
  assert.equal(R.normPhone('9876543210.0'), '9876543210'); assert.equal(R.normPhone('12345'), ''); assert.equal(R.normPhone(''), '');
});
test('a normal connected call of 60 s counts', () => { const c = call(); assert.deepEqual(ev([c]).get(c.id).reason, 'counted'); assert.equal(ev([c]).get(c.id).counted, true); });
test('not on list / not in log / not connected / too short', () => {
  const a = call({ assigned_ok: 0 }), b = call({ log_found: 0, duration: 0, start_ts: null }), c = call({ phone: '9000000001', log_phone: '9000000001', duration: 0 }), d = call({ phone: '9000000002', log_phone: '9000000002', duration: 29 });
  const r = ev([a, b, c, d]); assert.equal(r.get(a.id).reason, 'not_on_list'); assert.equal(r.get(b.id).reason, 'not_in_log'); assert.equal(r.get(c.id).reason, 'not_connected'); assert.equal(r.get(d.id).reason, 'too_short');
  for (const x of [a, b, c, d]) assert.equal(r.get(x.id).counted, false);
});
test('min duration boundary is inclusive and configurable', () => {
  const c = call({ duration: 30 }); assert.equal(ev([c]).get(c.id).counted, true);
  assert.equal(ev([c], { min_duration: 45 }).get(c.id).reason, 'too_short'); assert.equal(ev([call({ duration: 1 })], { min_duration: 0 }).values().next().value.counted, true);
});
test('number in call log must match the client number', () => { const c = call({ log_phone: '9111111111' }); assert.equal(ev([c]).get(c.id).reason, 'number_mismatch'); });
test('call log time before the tap is rejected', () => { const c = call({ start_ts: T0 - 60000 }); assert.equal(ev([c]).get(c.id).reason, 'time_mismatch'); const ok = call({ start_ts: T0 - 5000 }); assert.equal(ev([ok]).get(ok.id).counted, true); });
test('repeat calls to the same number within 24 h count once (any caller)', () => {
  const a = call({ start_ts: T0 }), b = call({ start_ts: T0 + 3600000, tapped_at: T0 + 3600000 }), c = call({ user_id: 'u2', start_ts: T0 + 7200000, tapped_at: T0 + 7200000 }), d = call({ start_ts: T0 + 25 * 3600000, tapped_at: T0 + 25 * 3600000 });
  const r = ev([d, c, b, a]); assert.equal(r.get(a.id).counted, true); assert.equal(r.get(b.id).reason, 'repeat'); assert.equal(r.get(c.id).reason, 'repeat'); assert.equal(r.get(d.id).counted, true);
});
test('a short first call does not block a later good call (chain anchors on counted calls only)', () => {
  const a = call({ duration: 5 }), b = call({ start_ts: T0 + 600000, tapped_at: T0 + 600000 }); const r = ev([a, b]); assert.equal(r.get(a.id).reason, 'too_short'); assert.equal(r.get(b.id).counted, true);
});
test('repeat window configurable (0 = every call counts)', () => {
  const a = call(), b = call({ start_ts: T0 + 600000, tapped_at: T0 + 600000 }); assert.equal(ev([a, b], { repeat_hours: 0 }).get(b.id).counted, true); assert.equal(ev([a, b], { repeat_hours: 1 / 12 }).get(b.id).counted, true);
});
test('overlapping (same-time) calls by one caller: later one not counted', () => {
  const a = call({ phone: '9000000011', log_phone: '9000000011', start_ts: T0, duration: 120 }), b = call({ phone: '9000000012', log_phone: '9000000012', start_ts: T0 + 30000, tapped_at: T0 + 29000, duration: 60 });
  const c = call({ user_id: 'u2', phone: '9000000013', log_phone: '9000000013', start_ts: T0 + 30000, tapped_at: T0 + 29000 });
  const r = ev([a, b, c]); assert.equal(r.get(a.id).counted, true); assert.equal(r.get(b.id).reason, 'overlap'); assert.equal(r.get(c.id).counted, true);
});
test('back-to-back calls do not overlap', () => { const a = call({ phone: '9000000021', log_phone: '9000000021', duration: 60 }), b = call({ phone: '9000000022', log_phone: '9000000022', start_ts: T0 + 2000 + 60000, tapped_at: T0 + 61000 }); assert.equal(ev([a, b]).get(b.id).counted, true); });
test('admin override beats the rules both ways', () => {
  const a = call({ duration: 5, override: 1 }), b = call({ phone: '9000000031', log_phone: '9000000031', override: 0 }); const r = ev([a, b]);
  assert.equal(r.get(a.id).counted, true); assert.equal(r.get(a.id).reason, 'admin_yes'); assert.equal(r.get(b.id).reason, 'admin_no');
});
test('interested lead: counted once per number, needs a real call, repeat does not block it', () => {
  const a = call({ outcome: 'callback' }), b = call({ start_ts: T0 + 3600000, tapped_at: T0 + 3600000, outcome: 'interested' }), c = call({ start_ts: T0 + 7200000, tapped_at: T0 + 7200000, outcome: 'interested' });
  const r = ev([a, b, c]); assert.equal(r.get(b.id).reason, 'repeat'); assert.equal(r.get(b.id).lead_counted, true); assert.equal(r.get(c.id).lead_counted, false); assert.match(r.get(c.id).lead_reason, /already paid/);
  const short = call({ phone: '9000000041', log_phone: '9000000041', duration: 10, outcome: 'interested' }); assert.equal(ev([short]).get(short.id).lead_counted, false);
  const rej = call({ phone: '9000000042', log_phone: '9000000042', outcome: 'interested', lead_override: 0 }); assert.equal(ev([rej]).get(rej.id).lead_counted, false);
});
test('totals: separate per-call and per-lead rates, adjustments, connect rate', () => {
  const calls = [{ duration: 60, counted: 1, call_rate: 2, lead_counted: 1, lead_rate: 25, outcome: 'interested' }, { duration: 40, counted: 1, call_rate: 2 }, { duration: 0 }, { duration: 10 }];
  const t = R.totals(calls, [{ amount: -1.5 }, { amount: 10 }]);
  assert.equal(t.made, 4); assert.equal(t.connected, 3); assert.equal(t.counted, 2); assert.equal(t.leads, 1); assert.equal(t.call_amount, 4); assert.equal(t.lead_amount, 25); assert.equal(t.adjust, 8.5); assert.equal(t.payout, 37.5); assert.equal(t.connect_rate, 75);
});
test('suspicious flags: many very short calls, overlaps, off-list, same number', () => {
  const xs = []; for (let i = 0; i < 6; i++) xs.push(call({ phone: '90000001' + (10 + i), log_phone: '90000001' + (10 + i), start_ts: T0 + i * 60000, tapped_at: T0 + i * 60000, duration: 3 }));
  xs.push(call({ phone: '9000000200', log_phone: '9000000200', start_ts: T0 + 10 * 60000, tapped_at: T0 + 10 * 60000, duration: 60 }));
  for (let i = 0; i < 3; i++) xs.push(call({ phone: '9000000300', log_phone: '9000000300', assigned_ok: 0, start_ts: T0 + (20 + i) * 60000, tapped_at: T0 + (20 + i) * 60000, duration: 0 }));
  const f = R.dayFlags(xs, S).join(' | '); assert.match(f, /Many very short calls: 6 of 7/); assert.match(f, /3 calls to numbers not on/); assert.match(f, /Same number called 3 times/);
  assert.deepEqual(R.dayFlags([call()], S), []);
});
test('IST day keys', () => { assert.equal(R.dayKey(Date.parse('2026-11-03T19:00:00Z')), '2026-11-04'); assert.equal(R.dayKey(Date.parse('2026-11-03T18:00:00Z')), '2026-11-03'); assert.equal(R.dayStart('2026-11-04'), Date.parse('2026-11-03T18:30:00Z')); });
test('round robin', () => { const m = R.roundRobin(['a', 'b', 'c', 'd', 'e'], ['x', 'y']); assert.deepEqual(m.get('x'), ['a', 'c', 'e']); assert.deepEqual(m.get('y'), ['b', 'd']); });
test('upload cleaning: header variants, dedupe in file and against existing, invalid rows', () => {
  const rows = [{ Name: 'A', 'Mobile Number': '+91 98765 43210', Area: 'Lanka' }, { name: 'B', phone: '09876543210' }, { NAME: 'C', Phone: '9123456789', Remarks: 'x' }, { Name: 'D', Phone: '123' }, { Name: 'E', Phone: '9000000001' }];
  const { contacts, report } = R.cleanRows(rows, new Set(['9000000001']));
  assert.deepEqual(contacts.map(c => c.phone), ['9876543210', '9123456789']); assert.equal(contacts[0].area, 'Lanka'); assert.equal(contacts[1].notes, 'x');
  assert.equal(report.dup_in_file, 1); assert.equal(report.dup_existing, 1); assert.equal(report.invalid, 1); assert.deepEqual(report.invalid_rows, [5]);
});
