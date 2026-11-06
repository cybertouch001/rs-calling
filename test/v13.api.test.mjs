// v1.3 API tests (payouts + per-number history + upload history) against a running server:
//   BASE=http://127.0.0.1:8813 ADMIN_PW=... node test/v13.api.test.mjs
import assert from 'node:assert/strict';
const BASE = process.env.BASE; const ADMIN_PW = process.env.ADMIN_PW; const P = 'v13' + Date.now().toString(36).slice(-6);
async function call(m, body = {}, tok) {
  const r = await fetch(BASE + '/api/' + m, { method: 'POST', headers: { 'content-type': 'application/json', 'x-rsc': '1', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) });
  const j = await r.json(); j._status = r.status; return j;
}
const ok = async (m, b, t) => { const j = await call(m, b, t); assert.equal(j.ok, true, m + ' failed: ' + JSON.stringify(j)); return j; };
let n = 0; const step = s => console.log('ok', ++n, s);
const admin = (await ok('login', { login: 'admin', password: ADMIN_PW, app: 'web', device: 'v13test' })).token; step('admin login');
const cid = (await ok('caller_save', { name: 'Test Caller ' + P, username: P + 'c', password: 'secret123' }, admin)).id;
const cal = (await ok('login', { login: P + 'c', password: 'secret123', app: 'caller', device: 'v13test' })).token;
await ok('terms_accept', { version: 1 }, cal); step('caller login, terms accepted');
const base = 6000000000 + Math.floor(Math.random() * 3000000000);
const N1 = String(base + 1), N2 = String(base + 2), N3 = String(base + 3);
// upload 1: N1, N2 to this caller
const u1 = await ok('import_start', { file_name: P + '-first.xlsx', assign: 'user', user_id: cid, rows_read: 2, numbers_found: 2 }, admin);
const c1 = await ok('import_chunk', { import_id: u1.import_id, rows: [{ phone: N1, name: 'One' }, { phone: N2, name: 'Two' }] }, admin);
assert.equal(c1.added, 2); await ok('import_finish', { import_id: u1.import_id }, admin); step('upload 1: two numbers assigned to the caller');
// upload 2 (same numbers again + one new, and a duplicate inside the file)
const u2 = await ok('import_start', { file_name: P + '-second.xlsx', assign: 'user', user_id: cid, rows_read: 4, numbers_found: 4 }, admin);
const c2 = await ok('import_chunk', { import_id: u2.import_id, rows: [{ phone: N1 }, { phone: N3 }, { phone: N3 }, { phone: N2 }] }, admin);
assert.equal(c2.added, 1); assert.equal(c2.dup_existing, 3); await ok('import_finish', { import_id: u2.import_id }, admin); step('upload 2: repeats are counted, not re-added');
const ul = await ok('uploads_list', { q: N1 }, admin);
const n1hits = ul.hits.filter(h => h.phone === N1);
assert.equal(n1hits.length, 2, 'N1 should show two uploads'); assert.equal(n1hits[0].times_uploaded, 2);
assert.ok(n1hits.some(h => h.result === 'added') && n1hits.some(h => h.result === 'dup_existing'));
const dupInFile = (await ok('uploads_list', { q: N3 }, admin)).hits;
assert.equal(dupInFile.filter(h => h.result === 'dup_in_upload').length, 1, 'duplicate inside one upload is recorded'); step('upload history shows every time a number came in, with times uploaded');
const byDay = await ok('uploads_list', { q: N2, from: '2000-01-01', to: '2000-01-02' }, admin); assert.equal(byDay.hits.length, 0); step('upload history filters by date');
// call sync: N1 not answered, N2 interested
const t0 = Date.now();
const contacts = (await ok('my_list', {}, cal)).contacts; const k1 = contacts.find(x => x.phone === N1), k2 = contacts.find(x => x.phone === N2);
assert.ok(k1 && k2, 'caller sees both numbers');
const sync = async (calls) => (await ok('sync', { calls }, cal));
await sync([{ id: 'a1-' + P, contact_id: k1.id, phone: N1, tapped_at: t0 - 600000, start_ts: t0 - 600000, duration: 0, log_found: true, log_phone: N1, outcome: 'callback', note: 'no pickup' }]);
const h1a = await ok('number_history', { phone: N1 }, cal);
assert.equal(h1a.summary.paid_calls, 0, 'not answered pays nothing'); assert.equal(h1a.summary.amount, 0); step('not answered call: nothing paid');
const cbDate = Date.now() - 1000;
const cb = await ok('sync_callbacks', { entries: [{ number: N1, date: cbDate, duration: 120, type: 'incoming' }] }, cal);
assert.equal(cb.recorded, 1); step('client called back and it was answered (callback recorded)');
const cbAgain = await ok('sync_callbacks', { entries: [{ number: N1, date: cbDate, duration: 120, type: 'incoming' }] }, cal);
assert.equal(cbAgain.recorded, 0, 'the same callback is never recorded twice'); step('re-sending the same callback records nothing new');
await sync([{ id: 'b1-' + P, contact_id: k2.id, phone: N2, tapped_at: t0 - 300000, start_ts: t0 - 300000, duration: 95, log_found: true, log_phone: N2, outcome: 'interested', note: 'wants a quote' }]);
const h2 = await ok('number_history', { phone: N2 }, cal);
assert.equal(h2.summary.leads, 1); assert.equal(h2.summary.paid_calls, 0, 'interested call pays no call rate'); assert.equal(h2.summary.amount, 20); step('interested call: lead only, no call rate on top');
// re-sync of the same interested call must not add anything
await sync([{ id: 'b1-' + P, contact_id: k2.id, phone: N2, tapped_at: t0 - 300000, start_ts: t0 - 300000, duration: 95, log_found: true, log_phone: N2, outcome: 'interested' }]);
const h2b = await ok('number_history', { phone: N2 }, cal); assert.equal(h2b.summary.amount, 20); step('re-sending the interested call changes nothing');
const h1 = await ok('number_history', { phone: N1 }, cal);
const cbEv = h1.events.find(e => e.kind === 'callback');
assert.equal(h1.summary.callbacks_paid, 1); assert.equal(cbEv.callback_paid, true); assert.equal(h1.summary.amount, 2);
const callEv = h1.events.find(e => e.kind === 'call'); assert.equal(callEv.amount, 0); assert.equal(callEv.connected, false);
step('not answered then callback answered: one call rate paid, on the callback only');
// history is ordered and complete
assert.deepEqual(h1.events.map(e => e.at), [...h1.events.map(e => e.at)].sort((a, b) => a - b)); step('history lists every event in time order');
const adminH = await ok('number_history', { phone: N1 }, admin); assert.equal(adminH.uploads.length, 2); assert.equal(adminH.contact.assigned_to, 'Test Caller ' + P); step('admin sees the same history plus upload dates');
// the caller must not see a number that is not theirs
const denied = await call('number_history', { phone: '9123456789' }, cal); assert.equal(denied.ok, false); assert.equal(denied._status, 400); step('caller cannot open a number that is not on their list');
// totals: earned = callback 2 + lead 20
const st = await ok('my_stats', {}, cal); assert.ok(st.month && st.month.payout >= 22, 'month payout includes the lead and the callback'); step('payout totals: lead 20 + callback 2');
console.log(n + ' v1.3 API checks passed');
