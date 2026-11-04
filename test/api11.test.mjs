// v1.1 API tests against a running server: BASE=http://127.0.0.1:8791 ADMIN_PW=... node test/api11.test.mjs
import assert from 'node:assert/strict';
const BASE = process.env.BASE; const ADMIN_PW = process.env.ADMIN_PW; const P = process.env.PREFIX || 'z' + Date.now().toString(36).slice(-5);
async function call(m, body = {}, tok) {
  const r = await fetch(BASE + '/api/' + m, { method: 'POST', headers: { 'content-type': 'application/json', 'x-rsc': '1', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) });
  const j = await r.json(); j._status = r.status; return j;
}
const ok = async (m, b, t) => { const j = await call(m, b, t); assert.equal(j.ok, true, m + ' failed: ' + JSON.stringify(j)); return j; };
const fails = async (m, b, t, status, re) => { const j = await call(m, b, t); assert.equal(j.ok, false, m + ' should fail'); if (status) assert.equal(j._status, status, m + ' status ' + j._status + ' ' + j.error); if (re) assert.match(j.error, re); return j; };
let n = 0; const step = s => console.log('ok', ++n, s);
const DAY = 86400000; const now = Date.now();
const istDay = ts => new Date(ts + 330 * 60000).toISOString().slice(0, 10);
const today = istDay(now);
const admin = (await ok('login', { login: 'admin', password: ADMIN_PW, app: 'web', device: 'api11' })).token; step('admin login');
await ok('settings_save', { call_rate: 20, lead_rate: 50, min_duration: 30, repeat_hours: 24, min_withdrawal: 100, retention_days: 7, daily_target: 2, withdraw_hours: 16, streak_bonus_7: 0, streak_bonus_30: 0, callback_counts: 0 }, admin); step('settings: rates + new v1.1 settings saved');
// ---- callers + numbers ----
const mk = async (u, name) => (await ok('caller_save', { name, username: P + u, password: 'secret123' }, admin)).id;
const id1 = await mk('one', 'Caller One'), id2 = await mk('two', 'Caller Two');
const base = 100000000 + Math.floor(Math.random() * 800000000);
await ok('contacts_import', { rows: Array.from({ length: 40 }, (_, i) => ({ Name: 'C' + i, Phone: '9' + (base + i), Area: 'A' })), assign: 'user', user_id: id1, batch: 'v11' }, admin);
const t1 = (await ok('login', { login: P + 'one', password: 'secret123', app: 'android', device: 'Phone 1' })).token;
const t2 = (await ok('login', { login: P + 'two', password: 'secret123', app: 'android', device: 'Phone 2' })).token; step('callers created and logged in');
// ---- Terms & Conditions gate + versioning ----
let r = await fails('my_list', {}, t1, 403, /Terms/); assert.equal(r.terms_required, true); step('caller blocked until the Terms are accepted (403 terms_required)');
await fails('sync', { calls: [] }, t1, 403); await fails('my_account', {}, t1, 403); step('every caller API is gated, not just the list');
const me0 = await ok('me', {}, t1); assert.equal(me0.terms.accepted, false); assert.equal(me0.terms.version, 1); step('me is allowed and reports terms.accepted=false');
const tc = await ok('terms_current', {}, t1); assert.match(tc.terms.body, /Withdrawals are processed within 16 hours/); assert.match(tc.terms.body, /at least 30 seconds/); assert.match(tc.terms.body, /Version 1/); step('default Terms v1 is preloaded (16 hours, 30 seconds, Version 1)');
await fails('terms_accept', { version: 5 }, t1, 400); await ok('terms_accept', { version: 1 }, t1); await ok('my_list', {}, t1); step('accepting the current version opens the app; a wrong version is refused');
await fails('terms_get', {}, t1, 403, /Admin/); step('caller cannot read the admin Terms report');
await fails('terms_save', { body: 'too short' }, admin, 400); await fails('terms_save', { body: tc.terms.body }, admin, 400, /Nothing changed/); step('terms_save refuses short or unchanged text');
const v2 = await ok('terms_save', { body: tc.terms.body + '\n17. Extra rule added in version 2 for this test.' }, admin); assert.equal(v2.version, 2);
r = await fails('my_list', {}, t1, 403); assert.equal(r.terms_version, 2); step('saving a new version (v2) blocks callers again until they accept it');
let tg = await ok('terms_get', {}, admin); assert.equal(tg.current.version, 2); const row = tg.report.find(x => x.username === P + 'one'); assert.equal(row.status, 'outdated'); assert.equal(row.terms_version, 1); assert.ok(row.terms_at);
assert.equal(tg.report.find(x => x.username === P + 'two').status, 'never'); step('acceptance report: caller one = accepted v1 (outdated), caller two = never');
await ok('terms_accept', { version: 2 }, t1); await ok('terms_accept', { version: 2 }, t2); tg = await ok('terms_get', {}, admin); assert.ok(tg.report.filter(x => [P + 'one', P + 'two'].includes(x.username)).every(x => x.status === 'current' && x.terms_version === 2)); step('both callers accept v2 -> report shows current');
assert.ok(tg.versions.length >= 2); step('version history keeps v1 and v2');
// ---- payment details ----
await fails('my_payment_save', { upi: 'not an upi' }, t1, 400, /UPI/); await fails('my_payment_save', { upi: 'a@b' }, t1, 400); await fails('my_payment_save', {}, t1, 400, /UPI ID or your bank/);
await fails('my_payment_save', { holder: 'Ravi Kumar', account_no: '12345', ifsc: 'SBIN0001234', bank: 'SBI' }, t1, 400, /9 to 18 digits/);
await fails('my_payment_save', { holder: 'Ravi Kumar', account_no: '123456789012', ifsc: 'SBIN1001234', bank: 'SBI' }, t1, 400, /IFSC/);
await fails('my_payment_save', { holder: 'Ravi Kumar', account_no: '123456789012', ifsc: 'sbin0001234' }, t1, 400, /bank name/); step('payment validation: UPI pattern, account digits, IFSC pattern, all bank fields required');
const UPI = 'ravi.kumar' + P + '@okaxis', ACCT = '123456789012', HOLD = 'Ravi Kumar';
let pay = await ok('my_payment_save', { upi: UPI }, t1); assert.equal(pay.payment.has_upi, true); assert.notEqual(pay.payment.upi, UPI); assert.match(pay.payment.upi, /\*/); assert.ok(pay.payment.upi.endsWith('@okaxis')); step('UPI saved; the caller only gets it masked back');
pay = await ok('my_payment_save', { holder: HOLD, account_no: ACCT, ifsc: 'sbin0001234', bank: 'State Bank of India' }, t1); assert.equal(pay.payment.has_bank, true); assert.equal(pay.payment.account_no, '********9012'); assert.equal(pay.payment.ifsc, 'SBIN0001234'); assert.equal(pay.payment.has_upi, true); step('bank details saved (IFSC uppercased); UPI kept; account number masked to last 4');
const acc0 = await ok('my_account', {}, t1); assert.ok(!JSON.stringify(acc0).includes(ACCT) && !JSON.stringify(acc0).includes(UPI)); step('no full payment value appears in the caller account response');
const pg = await ok('payment_get', { user_id: id1 }, admin); assert.equal(pg.payment.upi, UPI); assert.equal(pg.payment.account_no, ACCT); await fails('payment_get', { user_id: id1 }, t2, 403); step('admin sees full details; another caller cannot');
// ---- calls -> wallet ----
const list = (await ok('my_list', {}, t1)).contacts; assert.ok(list.length >= 20);
const mkCall = (c, k, dayOffset, dur, outcome) => { const t = now - dayOffset * DAY - (k + 2) * 3600000; return { id: `${P}c${dayOffset}${k}`.padEnd(12, 'x').slice(0, 30), contact_id: c.id, phone: c.phone, log_phone: c.phone, tapped_at: t, start_ts: t + 2000, duration: dur, log_found: 1, log_type: 'outgoing', outcome, note: k === 0 && dayOffset === 0 ? '=HYPERLINK("http://x")' : '' }; };
let s0 = await ok('sync', { calls: [mkCall(list[0], 0, 0, 45, 'interested'), mkCall(list[1], 1, 0, 50, 'not_interested'), mkCall(list[2], 2, 0, 10, 'not_reachable'), mkCall(list[3], 3, 0, 61, 'interested')] }, t1);
assert.equal(s0.results.filter(x => x.counted).length, 3); step('4 calls synced: 3 counted (one is under 30 s)');
const w0 = (await ok('my_account', {}, t1)).wallet; assert.equal(w0.total_earned, 3 * 20 + 2 * 50); assert.equal(w0.approved, 0); assert.equal(w0.pending_approval, 160); assert.equal(w0.available, 0); step('wallet: earned ₹160, nothing approved yet, available ₹0');
await fails('withdraw_request', { amount: 100 }, t1, 400, /at most/); step('cannot withdraw before approval');
const ap = await ok('payout_approve', { user_id: id1, from: today, to: today, note: 'v11' }, admin); assert.equal(ap.payout, 160);
let w1 = (await ok('my_account', {}, t1)).wallet; assert.deepEqual([w1.approved, w1.pending_approval, w1.available, w1.reserved, w1.withdrawn], [160, 0, 160, 0, 0]); step('admin approves ₹160 -> available ₹160');
// ---- withdraw ----
await fails('withdraw_request', { amount: 50 }, t1, 400, /Minimum withdrawal is ₹100/); await fails('withdraw_request', { amount: 'abc' }, t1, 400); await fails('withdraw_request', { amount: 161 }, t1, 400, /at most ₹160/); await fails('withdraw_request', { amount: 100 }, t2, 400, /UPI ID or bank details/); step('withdraw validation: minimum, number, above balance, no payment details');
const wr = await ok('withdraw_request', { amount: 100 }, t1); assert.ok(wr.due_at - Date.now() > 15.9 * 3600000 && wr.due_at - Date.now() <= 16 * 3600000 + 5000); step('withdrawal ₹100 requested; deadline is 16 hours out');
const w2 = (await ok('my_account', {}, t1)).wallet; assert.deepEqual([w2.available, w2.reserved], [60, 100]); await fails('withdraw_request', { amount: 100 }, t1, 400, /at most ₹60/); step('balance reserved while pending: available ₹60, second ₹100 refused');
// parallel requests must not overspend
await ok('settings_save', { min_withdrawal: 50 }, admin);
const [pa, pb] = await Promise.all([call('withdraw_request', { amount: 60 }, t1), call('withdraw_request', { amount: 60 }, t1)]);
await ok('settings_save', { min_withdrawal: 100 }, admin);
const w3 = (await ok('my_account', {}, t1)).wallet; assert.ok(w3.reserved <= 160 + 1e-9, 'overspent: ' + JSON.stringify(w3)); assert.equal([pa, pb].filter(x => x.ok).length, 1, 'exactly one of two simultaneous requests may succeed: ' + JSON.stringify([pa, pb])); assert.equal(w3.available, 0); step('two simultaneous ₹60 requests with ₹60 available: exactly one succeeds (reserved ₹' + w3.reserved + ')');
const adm0 = await ok('withdrawals_list', { status: 'pending' }, admin); const wmine = adm0.withdrawals.find(x => x.id === wr.id); assert.equal(wmine.upi, UPI); assert.equal(wmine.account_no, ACCT); assert.equal(wmine.overdue, false); assert.ok(wmine.ms_left > 0);
assert.match(wmine.upi_link, /^upi:\/\/pay\?/); const q = new URL(wmine.upi_link.replace('upi://', 'http://')).searchParams; assert.equal(q.get('pa'), UPI); assert.equal(q.get('am'), '100.00'); assert.equal(q.get('cu'), 'INR'); assert.equal(q.get('pn'), HOLD); step('admin queue shows full details + UPI deep link (payee, amount 100.00, INR)');
// payment details change after the request: the request keeps what was saved at request time
await ok('my_payment_save', { upi: 'new.upi' + P + '@okicici' }, t1); const adm1 = await ok('withdrawals_list', { status: 'pending' }, admin); assert.equal(adm1.withdrawals.find(x => x.id === wr.id).upi, UPI); step('a pending request keeps the payment details it was made with');
await fails('withdrawal_pay', { id: wr.id, utr: 'bad utr!!' }, admin, 400); await fails('withdrawals_list', {}, t1, 403); await fails('withdrawal_pay', { id: wr.id }, t1, 403);
await ok('withdrawal_pay', { id: wr.id, utr: 'UTR123456789' }, admin); await fails('withdrawal_pay', { id: wr.id }, admin, 400, /not pending/); step('mark paid (with reference) works once; callers cannot use admin APIs');
const w4 = (await ok('my_account', {}, t1)); const paidRow = w4.withdrawals.find(x => x.id === wr.id); assert.equal(paidRow.status, 'paid'); assert.equal(paidRow.utr, 'UTR123456789'); assert.equal(w4.wallet.withdrawn, 100); step('caller sees Paid + reference; wallet withdrawn = ₹100');
const pend = w4.withdrawals.find(x => x.status === 'pending');
const pend2 = w4.withdrawals.find(x => x.status === 'pending'); assert.ok(pend2); { await fails('withdrawal_reject', { id: pend.id }, admin, 400, /reason/); await ok('withdrawal_reject', { id: pend.id, reason: 'Bank details unclear' }, admin); const w5 = await ok('my_account', {}, t1); assert.equal(w5.withdrawals.find(x => x.id === pend.id).reject_reason, 'Bank details unclear'); assert.equal(w5.wallet.reserved, 0); assert.equal(w5.wallet.available, 60); step('reject needs a reason; reserved amount returns to available'); }
// ---- callbacks ----
const called = list[0]; const t0 = now - 2 * 3600000 - 2000;
const cbEntries = [{ number: '+91' + called.phone, date: now - 3600000, duration: 45, type: 'incoming' }, { number: called.phone, date: now - 1800000, duration: 0, type: 'missed' },
  { number: '9000000001', date: now - 3000000, duration: 60, type: 'incoming' }, { number: called.phone, date: t0 - 5 * DAY, duration: 50, type: 'incoming' }, { number: '0' + list[1].phone, date: now - 900000, duration: 20, type: 'incoming' }, { number: called.phone, date: now - 600000, duration: 30, type: 'outgoing' }];
const cs = await ok('sync_callbacks', { entries: cbEntries }, t1); assert.equal(cs.recorded, 3); assert.equal(cs.returned, 1); assert.equal(cs.skipped, 2); step('callbacks: incoming (+91 form), missed and a 0-prefixed number matched; unknown number and pre-first-call entry skipped; outgoing marks "returned"');
const cs2 = await ok('sync_callbacks', { entries: cbEntries }, t1); const cl = await ok('callbacks_list', { from: today, to: today }, admin); assert.equal(cl.callbacks.filter(x => x.user_id === id1).length, 3); step('re-sending the same entries creates no duplicates');
const ml = (await ok('my_list', {}, t1)).contacts; const cc = ml.find(x => x.id === called.id); assert.equal(cc.cb_count, 2); assert.ok(cc.cb_last_at); step('client record shows "callback received" (count 2, last time)');
assert.ok(cl.callbacks.find(x => x.phone === called.phone && x.kind === 'missed').returned_at); const incoming = cl.callbacks.find(x => x.phone === called.phone && x.kind === 'incoming'); assert.equal(incoming.counted, 0); assert.match(incoming.reason, /not paid/); step('admin sees the callbacks; missed one marked returned; callbacks do not count for pay by default');
const calls0 = (await ok('calls_list', { from: today, to: today, user_id: id1 }, admin)).calls; assert.equal(calls0.length, 4); step('callbacks are not added as calls (still 4 calls)');
await fails('sync_callbacks', { entries: [] }, admin, 400); const cm2 = await ok('sync_callbacks', { entries: [{ number: called.phone, date: now - 100000, duration: 40, type: 'incoming' }] }, t2); assert.equal(cm2.recorded, 0); step('a different caller cannot attach callbacks to numbers they never called');
// toggle on
await ok('settings_save', { callback_counts: 1 }, admin); const cl2 = await ok('callbacks_list', { from: today, to: today }, admin); const inc2 = cl2.callbacks.filter(x => x.user_id === id1 && x.kind === 'incoming'); assert.equal(inc2.filter(x => x.counted).length, 1); step('toggle on: one qualifying callback (≥30 s) is paid');
await ok('sync_callbacks', { entries: [{ number: called.phone, date: now - 500000, duration: 70, type: 'incoming' }] }, t1); const cl3 = await ok('callbacks_list', { from: today, to: today }, admin); assert.equal(cl3.callbacks.filter(x => x.user_id === id1 && x.counted).length, 1); step('a second callback from the same number inside the repeat window is not paid again');
const pr = await ok('payout_report', { from: today, to: today }, admin); const rr = pr.rows.find(x => x.user.id === id1); assert.equal(rr.callback_amount, 20); assert.equal(rr.callbacks_counted, 1); step('payout report: callback pay ₹20 listed separately');
await ok('settings_save', { callback_counts: 0 }, admin);
// ---- streak ----
const old = [1, 2, 3].flatMap(d => [0, 1].map(k => mkCall(list[10 + d * 2 + k], k, d, 40, 'not_interested')));
await ok('sync', { calls: old }, t1);
let st = (await ok('my_streak', {}, t1)).streak; assert.equal(st.target, 2); assert.equal(st.current, 4); assert.equal(st.longest, 4); assert.equal(st.today_done, true); assert.equal(st.days14.length, 14); assert.equal(st.days14[13].day, today); step('streak: today + 3 previous days all with ≥2 counted calls -> current 4, longest 4');
await ok('settings_save', { daily_target: 3 }, admin); st = (await ok('my_streak', {}, t1)).streak; assert.equal(st.current, 1); assert.equal(st.longest, 1); assert.equal(st.today_count, 3); step('raising the daily target to 3 recomputes on the server: only today (3 counted calls) still qualifies');
await ok('settings_save', { daily_target: 2 }, admin);
// 7-day streak bonus
await ok('settings_save', { streak_bonus_7: 75 }, admin);
await ok('sync', { calls: [4, 5, 6].flatMap(d => [0, 1].map(k => mkCall(list[20 + d * 2 + k], k, d, 40, 'not_interested'))) }, t1);
st = (await ok('my_streak', {}, t1)).streak; assert.equal(st.current, 7); const pr2 = await ok('payout_report', { from: istDay(now - 7 * DAY), to: today }, admin); assert.ok(pr2.adjustments.some(a => a.user_id === id1 && a.amount === 75 && /Streak bonus: 7-day/.test(a.reason))); step('7-day streak -> ₹75 bonus added as an adjustment');
await ok('my_streak', {}, t1); await ok('my_streak', {}, t1); const pr3 = await ok('payout_report', { from: istDay(now - 7 * DAY), to: today }, admin); assert.equal(pr3.adjustments.filter(a => a.user_id === id1 && /Streak bonus/.test(a.reason)).length, 1); step('bonus is awarded once, not on every refresh');
const bon = pr3.adjustments.find(a => /Streak bonus/.test(a.reason)); await ok('adjustment_delete', { id: bon.id }, admin); await ok('my_streak', {}, t1); const pr4 = await ok('payout_report', { from: istDay(now - 7 * DAY), to: today }, admin); assert.equal(pr4.adjustments.filter(a => a.user_id === id1 && a.amount > 0 && /Streak bonus/.test(a.reason)).length, 0); step('a bonus the admin deletes is voided and not re-awarded');
await ok('settings_save', { streak_bonus_7: 0 }, admin);
// ---- retention: old call details hidden in the caller view; totals stay ----
await ok('settings_save', { retention_days: 2 }, admin); const stt = await ok('my_stats', {}, t1); assert.ok(stt.recent.every(c => (c.start_ts || c.tapped_at) >= now - 2 * DAY - 1000)); assert.ok(stt.recent.length >= 4); assert.equal(stt.retention_days, 2);
const acc2 = await ok('my_account', {}, t1); assert.ok(acc2.wallet.total_earned > 160); step('retention 2 days: caller view hides older call details, but earnings still count them');
await ok('settings_save', { retention_days: 7 }, admin);
// ---- log requests ----
await fails('log_request_create', { from: istDay(now - 5 * DAY), to: today, purpose: 'short' }, t1, 400, /15 characters/); await fails('log_request_create', { from: today, to: istDay(now - 5 * DAY), purpose: 'I need to check my calls for payment' }, t1, 400); await fails('log_request_create', { from: '2020-01-01', to: today, purpose: 'I need to check my calls for payment' }, t1, 400, /92 days/); step('log request validation: purpose min length, date order, 92-day limit');
const lr1 = await ok('log_request_create', { from: istDay(now - 5 * DAY), to: today, purpose: 'I need to check a call that was not counted' }, t1); const lr2 = await ok('log_request_create', { from: today, to: today, purpose: 'Customer asked me what time I called' }, t1);
await fails('log_request_view', { id: lr1.id }, t1, 400, /not been approved/); await fails('log_requests_list', {}, t1, 403); step('requests are queued; viewing needs approval; caller cannot see the admin queue');
const rl = await ok('log_requests_list', { status: 'pending' }, admin); assert.ok(rl.requests.find(x => x.id === lr1.id && x.purpose.includes('not counted'))); await fails('log_request_decide', { id: lr2.id, approve: false }, admin, 400, /reason/);
await ok('log_request_decide', { id: lr2.id, approve: false, reason: 'Please ask me in person' }, admin); await ok('log_request_decide', { id: lr1.id, approve: true }, admin); await fails('log_request_decide', { id: lr1.id, approve: true }, admin, 400, /already/); step('admin rejects (reason required) and approves; a request cannot be decided twice');
const lv = await ok('log_request_view', { id: lr1.id }, t1); assert.ok(lv.rows.length >= 10); assert.ok(!lv.columns.includes('Caller')); assert.ok(lv.rows.every(r => r.length === lv.columns.length)); assert.ok(lv.expires_at > Date.now()); await fails('log_request_view', { id: lr1.id }, t2, 400, /not found/); step('approved: caller sees ONLY their own logs for the period (until expiry); another caller cannot open it');
const mine = await ok('my_account', {}, t1); assert.equal(mine.log_requests.find(x => x.id === lr2.id).decision_reason, 'Please ask me in person'); assert.equal(mine.log_requests.find(x => x.id === lr1.id).viewable, true); step('caller sees decisions and reasons');
// ---- admin log files ----
const ex = await ok('logs_export', { from: today, to: today }, admin); assert.ok(ex.count >= 8); assert.equal(ex.columns[0], 'Record'); for (const c of ['Caller', 'Client number', 'Time (IST)', 'Talk time (s)', 'Counted', 'Reason', 'Outcome', 'Notes', 'Callback event']) assert.ok(ex.columns.includes(c), c); assert.ok(ex.rows.some(r => r[0] === 'Callback')); assert.ok(ex.rows.some(r => r[0] === 'Call')); step('day log file has caller, number, time, duration, counted + reason, outcome, notes and callback rows');
assert.ok(ex.csv.startsWith('\ufeffRecord,Date')); assert.ok(ex.csv.includes("'=HYPERLINK")); assert.ok(!ex.csv.includes(',=HYPERLINK')); step('CSV protects against spreadsheet-formula injection in notes');
const all = await ok('logs_export', { all: true }, admin); assert.ok(all.count >= ex.count); assert.equal(all.from, '2000-01-01'); const one = await ok('logs_export', { all: true, user_id: id2 }, admin); assert.equal(one.count, 0); step('all-time file includes every day; per-caller filter works');
await fails('logs_export', { all: true }, t1, 403); await ok('snapshots_list', {}, admin); await fails('snapshot_get', { day: '2000-01-01' }, admin, 400); step('log files are admin-only; snapshots list available');
// ---- audit never contains payment values ----
const au = JSON.stringify((await ok('audit_list', {}, admin)).audit); assert.ok(!au.includes(UPI) && !au.includes(ACCT) && !au.includes('Ravi Kumar')); for (const a of ['payment_details_update', 'withdraw_request', 'withdrawal_paid', 'log_request_create', 'log_request_approved', 'log_request_rejected', 'terms_save', 'terms_accept', 'payment_details_view', 'log_request_view']) assert.ok(au.includes(a), 'audit missing ' + a); step('audit log has every action and no payment values');
// ---- v1.0 behaviour intact ----
const dash = await ok('dashboard', {}, admin); assert.ok(dash.today && dash.withdrawals && typeof dash.log_requests_pending === 'number'); step('dashboard still works (+ withdrawal and log-request counts)');
const old2 = await ok('callers_list', {}, admin); const c1 = old2.callers.find(x => x.id === id1); assert.equal(c1.terms_version, 2); assert.equal(c1.has_payment, 1); step('callers list shows terms version + payment-details flag');
// ---- cleanup ----
await ok('caller_delete', { id: id1 }, admin); await ok('caller_delete', { id: id2 }, admin);
const pg2 = await ok('payment_get', { user_id: id1 }, admin); assert.equal(pg2.payment, null); step('removed caller: payment details wiped');
console.log('API11', n, 'checks passed');
