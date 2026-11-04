// Integration test against a running server: BASE=http://127.0.0.1:8791 ADMIN_PW=... node test/api.test.mjs
import assert from 'node:assert/strict';
const BASE = process.env.BASE; const ADMIN_PW = process.env.ADMIN_PW; const P = process.env.PREFIX || 't' + Date.now().toString(36).slice(-5);
async function call(m, body = {}, tok) {
  const r = await fetch(BASE + '/api/' + m, { method: 'POST', headers: { 'content-type': 'application/json', 'x-rsc': '1', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) });
  const j = await r.json(); j._status = r.status; return j;
}
const ok = async (m, b, t) => { const j = await call(m, b, t); if (!j.ok) throw new Error(m + ': ' + j.error); return j; };
let pass = 0; const step = (name) => { pass++; console.log('ok', pass, name); };
const rid = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
const admin = (await ok('login', { login: 'admin', password: ADMIN_PW, app: 'web', device: 'api-test' })).token; step('admin login');
assert.equal((await call('login', { login: 'admin', password: 'wrong' }))._status, 401); step('wrong password refused');
assert.equal((await call('callers_list', {}))._status, 401); step('no token refused');
await ok('settings_save', { call_rate: 3, lead_rate: 25, min_duration: 30, repeat_hours: 24 }, admin); step('settings saved');
const u1 = (await ok('caller_save', { name: P + ' Caller One', username: P + 'one', phone: '', password: 'secret123' }, admin)).id;
const u2 = (await ok('caller_save', { name: P + ' Caller Two', username: P + 'two', password: 'secret456' }, admin)).id; step('2 callers added');
assert.equal((await call('caller_save', { name: 'Dup', username: P + 'one', password: 'secret123' }, admin))._status, 400); step('duplicate username refused');
const base = 7000000000 + Math.floor(Math.random() * 99999) * 10000;
const ph = i => String(base + i);
const rows = [{ Name: 'C1', Phone: ph(1), Area: 'A' }, { Name: 'C2', 'Mobile No': '+91 ' + ph(2) }, { Name: 'C3', Phone: '0' + ph(3) }, { Name: 'C4', Phone: ph(4) }, { Name: 'C1 again', Phone: ph(1) }, { Name: 'Bad', Phone: '12345' }];
const imp = await ok('contacts_import', { rows, assign: 'rr', caller_ids: [u1, u2] }, admin);
assert.equal(imp.report.added, 4); assert.equal(imp.report.dup_in_file, 1); assert.equal(imp.report.invalid, 1); assert.equal(imp.report.assigned, 4); step('import: 4 added, 1 dup, 1 invalid, round-robin assigned');
const imp2 = await ok('contacts_import', { rows: [{ Name: 'C2b', Phone: ph(2) }, { Name: 'C5', Phone: ph(5) }], assign: 'user', user_id: u1 }, admin);
assert.equal(imp2.report.dup_existing, 1); assert.equal(imp2.report.added, 1); step('import: dedupe against existing');
const t1 = (await ok('login', { login: P + 'one', password: 'secret123', app: 'android', device: 'Test Phone 1' })).token;
const t2 = (await ok('login', { login: P + 'two', password: 'secret456', app: 'android', device: 'Test Phone 2' })).token; for (const tk of [t1, t2]) await ok('terms_accept', { version: (await ok('terms_current', {}, tk)).terms.version }, tk); step('callers log in and accept the Terms');
assert.equal((await call('callers_list', {}, t1))._status, 403); step('caller cannot use admin API');
const L1 = (await ok('my_list', {}, t1)).contacts; const L2 = (await ok('my_list', {}, t2)).contacts;
assert.equal(L1.length + L2.length, 5); assert.ok(L1.length >= 2 && L2.length >= 2); step(`lists: caller1 ${L1.length}, caller2 ${L2.length}`);
const T = Date.now() - 3 * 3600000; const mk = (c, o) => ({ id: rid(), contact_id: c.id, phone: c.phone, log_phone: '+91' + c.phone, tapped_at: T + o.at, start_ts: T + o.at + 1500, duration: 60, log_found: 1, log_type: 'outgoing', device: 'Test Phone', ...o, at: undefined });
const a = L1[0], b = L1[1], c2 = L2[0];
const s1 = [mk(a, { at: 0, duration: 75, outcome: 'interested', note: 'wants GST help' }), mk(a, { at: 600000, duration: 40, outcome: 'interested' }), mk(b, { at: 1200000, duration: 12, outcome: 'not_interested' }), mk(b, { at: 1300000, duration: 0, outcome: 'not_reachable' }),
  mk(c2, { at: 1400000, duration: 90, outcome: 'callback', callback_at: Date.now() + 86400000 })];  // c2 is NOT on caller1's list
const r1 = await ok('sync', { calls: s1 }, t1); const R = Object.fromEntries(r1.results.map(x => [x.id, x]));
assert.equal(R[s1[0].id].counted, 1); assert.equal(R[s1[0].id].lead_counted, 1);
assert.equal(R[s1[1].id].reason, 'repeat'); assert.equal(R[s1[1].id].lead_counted, 0);
assert.equal(R[s1[2].id].reason, 'too_short'); assert.equal(R[s1[3].id].reason, 'not_connected'); assert.equal(R[s1[4].id].reason, 'not_on_list'); step('caller1 sync: counted / repeat / too short / not connected / not on list');
const again = await ok('sync', { calls: [s1[0]] }, t1); assert.equal(again.results[0].counted, 1);
const cnt = (await ok('calls_list', { from: new Date(T + 19800000).toISOString().slice(0, 10), to: new Date(Date.now() + 19800000).toISOString().slice(0, 10), user_id: u1 }, admin)).calls.length; assert.equal(cnt, 5); step('re-sync is idempotent (no duplicate call)');
// caller2: same number as caller1's counted call within 24h -> repeat (any caller); overlap
const s2 = [mk(c2, { at: 0, duration: 120, outcome: 'interested' }), mk(L2[1], { at: 30000, duration: 60, outcome: 'not_interested' })];
const r2 = Object.fromEntries((await ok('sync', { calls: s2 }, t2)).results.map(x => [x.id, x]));
assert.equal(r2[s2[0].id].counted, 1); assert.equal(r2[s2[1].id].reason, 'overlap'); step('caller2: same-time call not counted');
const mism = mk(L2[1], { at: 900000, log_phone: '9999999999', outcome: 'not_interested' }); const r3 = (await ok('sync', { calls: [mism] }, t2)).results[0]; assert.equal(r3.reason, 'number_mismatch'); step('call-log number mismatch not counted');
// outcome added later (log first, result later)
const late = mk(L2[1], { at: 2000000, duration: 50, outcome: undefined }); await ok('sync', { calls: [late] }, t2);
const late2 = (await ok('sync', { calls: [{ ...late, outcome: 'interested', note: 'later' }] }, t2)).results[0]; assert.equal(late2.counted, 1); assert.equal(late2.lead_counted, 1); step('result saved after the call log -> lead counted');
// totals
const st1 = await ok('my_stats', {}, t1); const today = st1.today;
const d = await ok('dashboard', {}, admin); const row1 = d.today.find(r => r.user.id === u1) || d.week.find(r => r.user.id === u1);
console.log('   caller1 totals', JSON.stringify({ made: row1.made, connected: row1.connected, counted: row1.counted, leads: row1.leads, payout: row1.payout }));
assert.equal(row1.counted, 1); assert.equal(row1.leads, 1); assert.equal(row1.payout, 3 + 25); assert.equal(row1.made, 5); assert.equal(row1.connected, 4); step('dashboard: caller1 1 counted x 3 + 1 lead x 25 = 28');
// override with reason
assert.equal((await call('call_override', { id: s1[2].id, value: 1, reason: '' }, admin))._status, 400);
const ov = await ok('call_override', { id: s1[2].id, value: 1, reason: 'Client confirmed the call' }, admin); assert.equal(ov.call.counted, 1); assert.equal(ov.call.reason, 'admin_yes'); step('admin override needs a reason and counts the call');
const lr = await ok('call_override', { id: s1[0].id, kind: 'lead', value: 0, reason: 'Duplicate lead' }, admin); assert.equal(lr.call.lead_counted, 0); step('admin can reject a lead');
await ok('call_override', { id: s1[0].id, kind: 'lead', value: null, reason: 'Undo' }, admin);
// adjustment + approve
const dayk = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
await ok('adjustment_add', { user_id: u1, day: dayk, amount: -5, reason: 'Late start' }, admin);
const pr = await ok('payout_report', { from: dayk.slice(0, 8) + '01', to: dayk, user_id: u1 }, admin); const p1 = pr.rows[0];
assert.equal(p1.payout, 3 + 3 + 25 - 5); step('payout report with adjustment: ' + p1.payout);
const ap = await ok('payout_approve', { user_id: u1, from: dayk.slice(0, 8) + '01', to: dayk, note: 'test' }, admin); assert.equal(ap.payout, 26);
assert.equal((await call('call_override', { id: s1[3].id, value: 1, reason: 'x' }, admin))._status, 400); step('approved payout locks its calls');
await ok('settings_save', { call_rate: 10, apply_rates_to_unapproved: true }, admin);
const pr2 = (await ok('payout_report', { from: dayk.slice(0, 8) + '01', to: dayk, user_id: u1 }, admin)).rows[0]; assert.equal(pr2.payout, 26); step('rate change does not touch approved calls');
await ok('settings_save', { call_rate: 3 }, admin);
// leads
const leads = (await ok('leads_list', { state: 'open' }, admin)).leads; assert.ok(leads.some(l => l.phone === a.phone)); step('interested client appears in leads');
await ok('lead_update', { id: a.id, followup_at: Date.now() + 3600000, followup_note: 'Call back with prices', lead_state: 'open' }, admin); step('follow-up reminder set');
// sessions + deactivate
const ss = (await ok('sessions_list', { user_id: u2 }, admin)).sessions; assert.equal(ss.length, 1); assert.equal(ss[0].app, 'android'); step('devices list shows caller2 android session');
await ok('caller_save', { id: u2, name: P + ' Caller Two', username: P + 'two', active: false }, admin);
const dead = await call('my_list', {}, t2); assert.equal(dead._status, 401); assert.equal(dead.logged_out, true); console.log('   ->', dead.error); step('deactivated caller is logged out at once');
assert.equal((await call('login', { login: P + 'two', password: 'secret456' }))._status, 403); step('deactivated caller cannot log in');
await ok('session_revoke', { user_id: u1 }, admin); assert.equal((await call('my_list', {}, t1))._status, 401); step('force logout all devices');
// cleanup for live runs
if (process.env.CLEANUP) {
  const all = (await ok('contacts_list', { q: String(base).slice(0, 6), limit: 500 }, admin)).contacts.filter(c => c.phone.startsWith(String(base).slice(0, 6)));
  await ok('payout_unapprove', { id: ap.id, reason: 'test cleanup' }, admin);
  if (all.length) await ok('contacts_delete', { ids: all.map(c => c.id) }, admin);
  console.log('   cleanup: contacts removed', all.length, '(test calls stay hidden under removed test callers)');
}
await ok('caller_delete', { id: u1 }, admin); await ok('caller_delete', { id: u2 }, admin); step('callers removed (history kept)');
await ok('logout', {}, admin);
console.log('ALL', pass, 'API CHECKS PASSED');
