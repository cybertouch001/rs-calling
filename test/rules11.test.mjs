// v1.1 unit tests: node --test test/rules11.test.mjs
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import vm from 'node:vm';
import * as R from '../server/rules.js';
const S = { ...R.DEFAULTS };
const sb = {}; sb.globalThis = sb; vm.createContext(sb); vm.runInContext(fs.readFileSync(new URL('../site/app/logic.js', import.meta.url), 'utf8'), sb);
// results from the sandbox realm are re-created here so deepStrictEqual compares plain data
const L = Object.fromEntries(Object.entries(sb.RSL).map(([k, f]) => [k, typeof f === 'function' ? (...a) => JSON.parse(JSON.stringify(f(...a)) ?? 'null') : f]));
const DAY = 86400000, T0 = Date.parse('2026-11-04T05:00:00Z');

// ---------- callback matching (uses the same phone normalisation as call counting) ----------
const called = new Map([['9876543210', { first: T0 - 2 * DAY, last: T0 - DAY }], ['9123456780', { first: T0, last: T0 }]]);
test('callback: incoming/missed from a called number match, any phone format', () => {
  const m = R.matchCallbacks([{ number: '+91 98765-43210', date: T0, duration: 40, type: 'incoming' }, { number: '09876543210', date: T0 + 1000, duration: 0, type: 'missed' }, { number: '919876543210', date: T0 + 2000, duration: 5, type: 'incoming' }], called, S);
  assert.equal(m.events.length, 3); assert.deepEqual(m.events.map(e => e.phone), ['9876543210', '9876543210', '9876543210']);
  assert.equal(m.events[1].kind, 'missed'); assert.equal(m.events[1].duration, 0); assert.equal(m.events[0].duration, 40);
});
test('callback: numbers never called from the app are ignored', () => {
  const m = R.matchCallbacks([{ number: '9000000000', date: T0, duration: 60, type: 'incoming' }, { number: '12345', date: T0, duration: 60, type: 'incoming' }], called, S);
  assert.equal(m.events.length, 0); assert.deepEqual(m.skipped.map(x => x.reason), ['not_called_from_app', 'bad_entry']);
});
test('callback: before the first app call or after the window does not match', () => {
  const m = R.matchCallbacks([{ number: '9876543210', date: T0 - 5 * DAY, duration: 60, type: 'incoming' }, { number: '9876543210', date: T0 + 40 * DAY, duration: 60, type: 'incoming' }, { number: '9876543210', date: T0 + 25 * DAY, duration: 60, type: 'incoming' }], called, S);
  assert.deepEqual(m.skipped.map(x => x.reason), ['before_first_app_call', 'outside_window']); assert.equal(m.events.length, 1);
  const wide = R.matchCallbacks([{ number: '9876543210', date: T0 + 40 * DAY, duration: 60, type: 'incoming' }], called, { ...S, callback_window_days: 90 }); assert.equal(wide.events.length, 1);
});
test('callback: outgoing calls are "returned" markers, app calls are not', () => {
  const m = R.matchCallbacks([{ number: '9876543210', date: T0 + 3600000, duration: 30, type: 'outgoing' }, { number: '9876543210', date: T0 + 7200000, duration: 30, type: 'outgoing' }], called, S, new Set([T0 + 7200000 + 3000]));
  assert.equal(m.returned.length, 1); assert.equal(m.returned[0].out_ts, T0 + 3600000); assert.equal(m.skipped[0].reason, 'app_call');
});
test('callback: counting is OFF by default — recorded but never paid, never a normal call', () => {
  const ev = [{ id: 'a', phone: '9876543210', start_ts: T0, duration: 90, kind: 'incoming' }];
  assert.equal(R.callbackCounting(ev, S).get('a').counted, false); assert.match(R.callbackCounting(ev, S).get('a').reason, /not paid/);
  const t = R.totals([], [], [{ counted: 0, rate: 2 }]); assert.equal(t.payout, 0); assert.equal(t.callbacks, 1); assert.equal(t.made, 0);
});
test('callback: when switched on only a long incoming callback pays, once per repeat window', () => {
  const on = { ...S, callback_counts: 1 };
  const ev = [{ id: 'a', phone: '1', start_ts: T0, duration: 90, kind: 'incoming' }, { id: 'b', phone: '1', start_ts: T0 + 3600000, duration: 90, kind: 'incoming' }, { id: 'c', phone: '1', start_ts: T0 + 2 * DAY, duration: 90, kind: 'incoming' },
    { id: 'd', phone: '2', start_ts: T0, duration: 10, kind: 'incoming' }, { id: 'e', phone: '2', start_ts: T0 + 5000, duration: 0, kind: 'missed' }];
  const r = R.callbackCounting(ev, on);
  assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map(k => r.get(k).counted), [true, false, true, false, false]);
  assert.match(r.get('d').reason, /minimum/); assert.match(r.get('e').reason, /Missed/); assert.match(r.get('b').reason, /repeat window/);
  const t = R.totals([], [], [{ counted: 1, rate: 2 }, { counted: 1, rate: 2 }, { counted: 0, rate: 2 }]); assert.equal(t.callback_amount, 4); assert.equal(t.payout, 4); assert.equal(t.callbacks_counted, 2);
});

// ---------- balance reservation + withdrawal states ----------
test('wallet: earned / approved / pending / reserved / withdrawn / available', () => {
  const w = R.walletCalc({ earned: 500, approved: 300, paidOffline: 50, withdrawals: [{ amount: 100, status: 'paid' }, { amount: 40, status: 'pending' }, { amount: 70, status: 'rejected' }] });
  assert.deepEqual([w.total_earned, w.approved, w.pending_approval, w.withdrawn, w.reserved, w.available], [500, 300, 200, 100, 40, 110]);
});
test('wallet: a pending request reserves the balance; rejection releases it; paid keeps it spent', () => {
  const base = { earned: 200, approved: 200, paidOffline: 0 };
  assert.equal(R.walletCalc({ ...base, withdrawals: [] }).available, 200);
  assert.equal(R.walletCalc({ ...base, withdrawals: [{ amount: 150, status: 'pending' }] }).available, 50);
  assert.equal(R.walletCalc({ ...base, withdrawals: [{ amount: 150, status: 'rejected' }] }).available, 200);
  assert.equal(R.walletCalc({ ...base, withdrawals: [{ amount: 150, status: 'paid' }] }).available, 50);
  assert.equal(R.walletCalc({ earned: 10, approved: 0, withdrawals: [] }).available, 0);
});
test('withdrawal validation: details, minimum, balance, decimals', () => {
  const w = { available: 150 }; const s = { ...S, min_withdrawal: 100 };
  assert.match(R.checkWithdraw(100, w, s, false), /UPI ID or bank/); assert.match(R.checkWithdraw(0, w, s, true), /Enter an amount/); assert.match(R.checkWithdraw('x', w, s, true), /Enter an amount/);
  assert.match(R.checkWithdraw(99, w, s, true), /Minimum withdrawal is ₹100/); assert.match(R.checkWithdraw(151, w, s, true), /at most ₹150/); assert.match(R.checkWithdraw(120.123, w, s, true), /2 decimals/);
  assert.equal(R.checkWithdraw(100, w, s, true), null); assert.equal(R.checkWithdraw(150, w, s, true), null); assert.equal(R.checkWithdraw(100.5, w, s, true), null);
});
test('withdrawal deadline: 16 hours, overdue only while pending', () => {
  const due = R.dueAt(T0, 16); assert.equal(due - T0, 16 * 3600000);
  assert.equal(R.isOverdue({ status: 'pending', due_at: due }, due - 1), false); assert.equal(R.isOverdue({ status: 'pending', due_at: due }, due + 1), true);
  assert.equal(R.isOverdue({ status: 'paid', due_at: due }, due + 99999), false); assert.equal(R.isOverdue({ status: 'rejected', due_at: due }, due + 1), false);
  assert.equal(R.DEFAULTS.withdraw_hours, 16);
  assert.deepEqual(L.countdown(due, due - 3 * 3600000 - 120000), { overdue: false, text: '3h 2m left' }); assert.deepEqual(L.countdown(due, due + 65 * 60000), { overdue: true, text: 'Overdue by 1h 5m' }); assert.equal(L.countdown(due, due - 5 * 60000).text, '5m left');
});

// ---------- payment details ----------
test('UPI / IFSC / account validation', () => {
  for (const u of ['ravi@okaxis', 'ravi.kumar-1@ybl', '9876543210@paytm', 'a_b@oksbi']) assert.equal(R.isUpi(u), true, u);
  for (const u of ['ravi', '@okaxis', 'ravi@', 'ravi okaxis@ybl', 'r@1x', 'ravi@@ybl', '']) assert.equal(R.isUpi(u), false, u);
  for (const i of ['SBIN0001234', 'hdfc0abc123', 'ICIC0000001']) assert.equal(R.isIfsc(i), true, i);
  for (const i of ['SBIN1001234', 'SBI0001234', 'SBIN000123', 'SBIN00012345', '1234567890A']) assert.equal(R.isIfsc(i), false, i);
  assert.equal(R.isAcct('123456789'), true); assert.equal(R.isAcct('1234 5678 9012 3456'), true); assert.equal(R.isAcct('12345678'), false); assert.equal(R.isAcct('1234567890123456789'), false); assert.equal(R.isAcct('12345abc9012'), false);
  for (const f of ['isUpi', 'isIfsc', 'isAcct']) for (const v of ['ravi@okaxis', 'SBIN0001234', '123456789012', 'x', '']) assert.equal(L[f](v), R[f](v), f + ' client/server agree on ' + v);
});
test('validatePayment merges, normalises and masks', () => {
  const a = R.validatePayment({ upi: ' Ravi@OkAxis ' }); assert.equal(a.value.upi, 'ravi@okaxis');
  const b = R.validatePayment({ holder: 'Ravi', account_no: '1234 5678 9012', ifsc: 'sbin0001234', bank: 'SBI' }, a.value); assert.equal(b.value.account_no, '123456789012'); assert.equal(b.value.ifsc, 'SBIN0001234'); assert.equal(b.value.upi, 'ravi@okaxis');
  assert.match(R.validatePayment({ holder: 'Ravi' }).error, /9 to 18|Account number/); assert.match(R.validatePayment({}).error, /UPI ID or your bank/);
  assert.equal(R.maskAcct('123456789012'), '********9012'); assert.equal(R.maskUpi('ravi.kumar@okaxis'), 'ra******@okaxis'); assert.ok(!R.maskUpi('ravi.kumar@okaxis').includes('kumar'));
});
test('UPI deep link', () => {
  const l = R.upiLink({ pa: 'ravi@okaxis', pn: 'Ravi Kumar & Co', am: 250, tn: 'R&S Calling payout' }); assert.ok(l.startsWith('upi://pay?pa=ravi@okaxis&')); const q = new URL(l.replace('upi://', 'http://')).searchParams;
  assert.equal(q.get('pn'), 'Ravi Kumar & Co'); assert.equal(q.get('am'), '250.00'); assert.equal(q.get('cu'), 'INR'); assert.equal(q.get('tn'), 'R&S Calling payout');
});

// ---------- streak ----------
const D = (n) => new Date(Date.parse('2026-11-04T00:00:00Z') - n * DAY).toISOString().slice(0, 10);
test('streak: consecutive days, today open until done, longest, reset on a missed day', () => {
  const c = { [D(0)]: 10, [D(1)]: 12, [D(2)]: 10, [D(3)]: 3, [D(4)]: 11, [D(5)]: 11, [D(6)]: 11, [D(7)]: 11 };
  let s = R.streakCalc(c, 10, D(0)); assert.deepEqual([s.current, s.longest, s.today_done, s.today_count], [3, 4, true, 10]);
  const c2 = { ...c, [D(0)]: 4 }; s = R.streakCalc(c2, 10, D(0)); assert.deepEqual([s.current, s.today_done], [2, false]);       // today still open: yesterday's streak survives
  const c3 = { ...c, [D(1)]: 9, [D(0)]: 0 }; s = R.streakCalc(c3, 10, D(0)); assert.equal(s.current, 0);                                 // yesterday missed and today not done: broken
  s = R.streakCalc({}, 10, D(0)); assert.deepEqual([s.current, s.longest], [0, 0]); assert.equal(s.days14.length, 14); assert.equal(s.days14[13].day, D(0)); assert.equal(s.days14[0].day, D(13));
  assert.equal(R.streakCalc(c, 10, D(0)).days14.filter(d => d.done).length, 7);
});
test('streak: month boundaries and target <= 0 are safe', () => {
  const c = { '2026-10-30': 5, '2026-10-31': 5, '2026-11-01': 5, '2026-11-02': 5 }; assert.equal(R.streakCalc(c, 5, '2026-11-02').current, 4); assert.equal(R.streakCalc(c, 5, '2026-11-02').longest, 4);
  assert.equal(R.streakCalc({ '2026-11-02': 1 }, 0, '2026-11-02').current, 1); assert.equal(R.streakCalc({ '2026-11-02': 0 }, 0, '2026-11-02').current, 0);
});
test('streak bonus milestones at 7 and 30, once per run', () => {
  const run = (n, from) => Object.fromEntries(Array.from({ length: n }, (_, i) => [new Date(Date.parse(from) + i * DAY).toISOString().slice(0, 10), 10]));
  let m = R.streakMilestones(run(6, '2026-09-01'), 10); assert.equal(m.length, 0);
  m = R.streakMilestones(run(7, '2026-09-01'), 10); assert.deepEqual(m.map(x => [x.milestone, x.day]), [[7, '2026-09-07']]);
  m = R.streakMilestones(run(31, '2026-09-01'), 10); assert.deepEqual(m.map(x => x.milestone), [7, 30]); assert.equal(m[1].day, '2026-09-30');
  m = R.streakMilestones({ ...run(7, '2026-09-01'), ...run(7, '2026-09-10') }, 10); assert.equal(m.length, 2); assert.notEqual(m[0].run_start, m[1].run_start);
});

// ---------- retention purge (the phone's own copies only) ----------
test('purge: only synced items older than the retention period are removed; unsynced never', () => {
  const now = T0; const ms = 7 * DAY;
  const q = [{ id: 1, synced: true, synced_at: now - ms - 1000 }, { id: 2, synced: true, synced_at: now - ms + 60000 }, { id: 3, synced: false }, { id: 4, synced: false, synced_at: now - 30 * DAY }, { id: 5, synced: true }];
  const r = L.purgeSynced(q, now, 7);
  assert.deepEqual(r.removed.map(x => x.id), [1]); assert.deepEqual(r.keep.map(x => x.id), [2, 3, 4, 5]);
  assert.equal(r.keep.find(x => x.id === 5).synced_at, now);               // synced before v1.1: retention clock starts at the upgrade
  assert.equal(L.purgeSynced(r.keep, now + 7 * DAY + 1, 7).removed.map(x => x.id).sort().join(), '2,5');
  assert.deepEqual(L.purgeSynced(q, now, 1).removed.map(x => x.id), [1, 2]); assert.equal(L.purgeSynced([], now, 7).keep.length, 0); assert.equal(L.purgeSynced(null, now, 7).keep.length, 0);
});
test('callback candidates sent from the phone: called numbers only, deduplicated, held back while a call is unsynced', () => {
  const log = [{ number: '+919876543210', date: 1, duration: 40, type: 'incoming' }, { number: '9876543210', date: 2, duration: 0, type: 'missed' }, { number: '9000000000', date: 3, duration: 60, type: 'incoming' }, { number: '9876543210', date: 4, duration: 30, type: 'other' }, { number: '9111111111', date: 5, duration: 10, type: 'incoming' }, { number: '9876543210', date: 6, duration: 99, type: 'outgoing' }];
  const out = L.callbackCandidates(log, new Set(['9876543210', '9111111111']), new Set(['9876543210|2']), new Set(['9111111111']));
  assert.deepEqual(out.map(x => x.date), [1, 6]); assert.equal(out[0].number, '9876543210');
});
test('the app never deletes the phone call log (source check)', () => {
  const java = fs.readFileSync(new URL('../android/app/src/main/java/bot/tab/sites/rscalling/MainActivity.java', import.meta.url), 'utf8');
  assert.ok(!/\.delete\s*\(\s*CallLog|CallLog\.Calls\.CONTENT_URI\s*,\s*null\s*,\s*null\)\s*;?\s*\/\/\s*del|WRITE_CALL_LOG/i.test(java)); assert.ok(!/getContentResolver\(\)\.delete/.test(java));
  const man = fs.readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8'); assert.ok(!/WRITE_CALL_LOG/.test(man)); assert.ok(/READ_CALL_LOG/.test(man));
});

// ---------- Terms & Conditions ----------
test('default Terms v1 contain every requested point, plus the additions', () => {
  const T = R.TERMS_V1; assert.match(T, /Version 1 · 4 November 2026/);
  for (const re of [/within 16 hours/, /proper, formal and respectful/, /no abuse, no anger/i, /completed every day/, /formal working relationship/, /No call, no money/, /No fake information/, /legal action/, /at least 30 seconds/, /Call audio is never recorded/, /confidential/, /One account per person/, /hold or reverse earnings/, /suspend or remove/, /update these Terms/, /Indian law/, /Do-Not-Disturb/, /governed by the laws of India/, /responsible for their correctness/]) assert.match(T, re);
  assert.ok(T.split('\n').filter(l => /^\d+\./.test(l)).length >= 16);
  assert.ok(!/\+91|@|\b\d{10}\b/.test(T), 'no phone number or email in the Terms'); assert.ok(!new RegExp(['Adi', 'tya|Path', 'ak|Vara', 'nasi'].join('')).test(T), 'no owner name or address in the Terms');
});
test('terms acceptance gate logic: accepted version must equal the current one', () => {
  const gate = (userV, cur) => (userV || 0) === cur;
  assert.equal(gate(0, 1), false); assert.equal(gate(1, 1), true); assert.equal(gate(1, 2), false); assert.equal(gate(null, 1), false); assert.equal(gate(2, 2), true);
});

// ---------- CSV ----------
test('CSV: quoting, BOM, formula protection, numbers untouched', () => {
  assert.equal(R.csvCell('a,b'), '"a,b"'); assert.equal(R.csvCell('say "hi"'), '"say ""hi"""'); assert.equal(R.csvCell('=1+1'), "'=1+1"); assert.equal(R.csvCell('@x'), "'@x"); assert.equal(R.csvCell('-5'), '-5'); assert.equal(R.csvCell('+919876543210'), '+919876543210'); assert.equal(R.csvCell(null), ''); assert.equal(R.csvCell('two\nlines'), '"two\nlines"');
  const c = R.toCsv(['A', 'B'], [[1, 'x,y']]); assert.ok(c.startsWith('\ufeffA,B\r\n1,"x,y"\r\n'));
  assert.equal(R.LOG_COLS.length, 16); for (const k of ['Caller', 'Client number', 'Time (IST)', 'Talk time (s)', 'Counted', 'Reason', 'Outcome', 'Notes', 'Callback event']) assert.ok(R.LOG_COLS.includes(k));
});
test('settings defaults for v1.1', () => {
  const d = R.DEFAULTS; assert.deepEqual([d.min_withdrawal, d.retention_days, d.daily_target, d.streak_bonus_7, d.streak_bonus_30, d.callback_counts, d.withdraw_hours], [100, 7, 10, 0, 0, 0, 16]);
  assert.equal(R.retentionCutoff(T0, 7), T0 - 7 * DAY);
});
