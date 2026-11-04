// v1.2 API tests (upload preview/import/undo) against a running server:
//   BASE=http://127.0.0.1:8802 ADMIN_PW=... node test/api12.test.mjs
import assert from 'node:assert/strict';
const BASE = process.env.BASE; const ADMIN_PW = process.env.ADMIN_PW; const P = process.env.PREFIX || 'v' + Date.now().toString(36).slice(-5);
async function call(m, body = {}, tok) {
  const r = await fetch(BASE + '/api/' + m, { method: 'POST', headers: { 'content-type': 'application/json', 'x-rsc': '1', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) });
  const j = await r.json(); j._status = r.status; return j;
}
const ok = async (m, b, t) => { const j = await call(m, b, t); assert.equal(j.ok, true, m + ' failed: ' + JSON.stringify(j)); return j; };
const fails = async (m, b, t, status, re) => { const j = await call(m, b, t); assert.equal(j.ok, false, m + ' should fail'); if (status) assert.equal(j._status, status, m + ' status ' + j._status + ' ' + j.error); if (re) assert.match(j.error, re); return j; };
let n = 0; const step = s => console.log('ok', ++n, s);
const admin = (await ok('login', { login: 'admin', password: ADMIN_PW, app: 'web', device: 'api12' })).token; step('admin login');
const mk = async (u, name) => (await ok('caller_save', { name, username: P + u, password: 'secret123' }, admin)).id;
const c1 = await mk('one', 'Caller One'), c2 = await mk('two', 'Caller Two');
// unique 10-digit mobiles for this run (start with 7 so they never clash with the lead files)
const base = 7000000000 + Math.floor(Math.random() * 2000000000);
const num = i => String(base + i);
const rowsA = [
  { phone: num(1), name: 'Alpha Traders', area: 'Lanka', source: 'Retail', notes: 'n1' },
  { phone: num(2), name: 'Beta Foods', area: 'Sigra', source: 'Food', notes: '' },
  { phone: num(3), name: 'Gamma Tech', area: 'Pune', source: 'Tech', notes: '' },
  { phone: num(4), name: 'Delta Studio', area: 'Lanka', source: '', notes: '' },
  { phone: num(5), name: 'Epsilon', area: '', source: '', notes: '' },
  { phone: 'abc', name: 'Bad one', area: '', source: '', notes: '' },
  { phone: '0542 240 5214', name: 'Landline', area: '', source: '', notes: '' },
  { phone: '+91 ' + num(6).slice(0, 5) + ' ' + num(6).slice(5), name: 'Formatted', area: '', source: '', notes: '' },
];
// 1) start an upload that shares the callers round-robin
const s1 = await ok('import_start', { file_name: P + '-a.xlsx', assign: 'rr', caller_ids: [c1, c2], sheet: 'Leads', mapping: '{"phone":3}', rows_read: 8, numbers_found: 6, invalid: 2, dup_in_file: 0 }, admin);
assert.match(s1.import_id, /^[0-9a-f]{24}$/); assert.equal(s1.callers, 2); step('import_start: a round-robin upload between two callers');
const ch1 = await ok('import_chunk', { import_id: s1.import_id, rows: rowsA }, admin);
assert.equal(ch1.added, 6);
// 'abc' and the 0542 landline are both invalid server-side
assert.equal(ch1.invalid, 2); assert.equal(ch1.assigned, 6); step('import_chunk: 6 new numbers, invalid rows refused by the server, all 6 assigned');
const fin1 = await ok('import_finish', { import_id: s1.import_id }, admin); assert.equal(fin1.batch.status, 'done'); assert.equal(fin1.batch.added, 6); step('import_finish: batch done with counts');
// 2) check that the numbers are spread between the two callers, alternating
const mine1 = (await ok('contacts_list', { import_id: s1.import_id, limit: 200 }, admin)).contacts;
assert.equal(mine1.length, 6); const byCaller = {}; for (const c of mine1) byCaller[c.assigned_to] = (byCaller[c.assigned_to] || 0) + 1;
assert.equal(byCaller[c1], 3); assert.equal(byCaller[c2], 3); step('round-robin: 3 numbers each to the two callers');
const alpha = mine1.find(c => c.phone === num(1)); assert.equal(alpha.name, 'Alpha Traders'); assert.equal(alpha.area, 'Lanka'); assert.equal(alpha.source, 'Retail'); assert.equal(alpha.notes, 'n1'); assert.equal(alpha.import_id, s1.import_id); step('name, address, source and notes kept with the number');
// 3) a second upload: overlaps with the first and adds one new number, unassigned
const s2 = (await ok('import_start', { file_name: P + '-b.csv', assign: 'none', rows_read: 3, numbers_found: 3 }, admin)).import_id;
const pre = await ok('import_check', { phones: [num(1), num(2), num(99), num(7)] }, admin); assert.equal(pre.existing, 2); assert.equal(pre.checked, 4); step('import_check: 2 of 4 numbers already in the list');
const ch2 = await ok('import_chunk', { import_id: s2, rows: [{ phone: num(1) }, { phone: num(2) }, { phone: num(8) }] }, admin);
assert.equal(ch2.added, 1); assert.equal(ch2.dup_existing, 2); assert.equal(ch2.assigned, 0); step('second upload: 1 new, 2 already in the list (not duplicated, not reassigned)');
await ok('import_finish', { import_id: s2 }, admin);
const still = await ok('contacts_list', { phone: num(1), limit: 20 }, admin); assert.equal((await ok('contacts_list', { q: num(1), limit: 20 }, admin)).contacts.filter(c => c.phone === num(1)).length, 1); step('no duplicate row for a number that is already in the list');
// 4) a called number blocks the undo of its upload
const t1 = (await ok('login', { login: P + 'one', password: 'secret123', app: 'android', device: 'Phone 1' })).token;
const tcur = await ok('terms_current', {}, t1); await ok('terms_accept', { version: tcur.terms.version }, t1);
const mine = (await ok('my_list', {}, t1)).contacts; const called = mine.find(c => c.phone === num(1));
assert.ok(called, 'caller one sees the number assigned to them');
const T = Date.now() - 3 * 3600000;
await ok('sync', { calls: [{ id: 'v12-' + P + '-1', contact_id: called.id, phone: called.phone, log_phone: '+91' + called.phone, tapped_at: T, start_ts: T + 1500, duration: 60, log_found: 1, log_type: 'outgoing', device: 'Test Phone', outcome: 'not_reachable' }] }, t1);
const lst = (await ok('import_list', {}, admin)).batches; const bA = lst.find(b => b.id === s1.import_id);
assert.equal(bA.can_undo, false); assert.ok(bA.called >= 1); step('a number that was called makes its upload non-undoable');
const refused = await fails('import_undo', { import_id: s1.import_id }, admin, 400, /already been called/); step('undo refused for an upload with a called number: ' + refused.error.slice(0, 60));
// 5) undo the clean upload
const bB = lst.find(b => b.id === s2); assert.equal(bB.can_undo, true);
const und = await ok('import_undo', { import_id: s2 }, admin); assert.equal(und.removed, 1); step('undo of a clean upload removes exactly its numbers');
assert.equal((await ok('contacts_list', { q: num(8), limit: 20 }, admin)).contacts.length, 0, 'removed');
await fails('import_undo', { import_id: s2 }, admin, 400, /already undone/); step('a second undo is refused');
assert.equal((await ok('contacts_list', { q: num(1), limit: 20 }, admin)).contacts.length >= 1, true, 'the number from the first upload is still there'); step('the other uploads are untouched');
// 6) chunks cannot be added to a finished or undone upload; callers cannot use the import API
await fails('import_chunk', { import_id: s2, rows: [{ phone: num(9) }] }, admin, 400, /already finished/);
await fails('import_start', { file_name: 'x', assign: 'none' }, t1, 403, /Admin/); await fails('import_list', {}, t1, 403); step('import is admin-only and finished uploads are closed');
// 7) an unfinished upload (stopped mid-way) can still be undone
const s3 = (await ok('import_start', { file_name: P + '-c.xlsx', assign: 'user', user_id: c2 }, admin)).import_id;
await ok('import_chunk', { import_id: s3, rows: [{ phone: num(20), name: 'Unfinished' }] }, admin);
const bC = (await ok('import_list', {}, admin)).batches.find(b => b.id === s3); assert.equal(bC.status, 'importing'); assert.equal(bC.can_undo, true);
assert.equal((await ok('import_undo', { import_id: s3 }, admin)).removed, 1); step('an unfinished upload can be undone');
// 8) bad input
await fails('import_start', { file_name: 'x', assign: 'user', user_id: 'nobody' }, admin, 400, /Choose a caller/); step('a non-caller target is refused');
await fails('import_undo', { import_id: 'nope' }, admin, 400, /not found/); step('unknown upload refused');
console.log('ALL api12 ok:', n);
