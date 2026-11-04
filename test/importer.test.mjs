// v1.2 number-list importer: node --test test/importer.test.mjs  (pure functions, vm sandbox; real lead files included)
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import vm from 'node:vm';
const sb = {}; sb.globalThis = sb; vm.createContext(sb);
vm.runInContext(fs.readFileSync(new URL('../site/app/vendor/xlsx.full.min.js', import.meta.url), 'utf8'), sb);
vm.runInContext(fs.readFileSync(new URL('../site/app/importer.js', import.meta.url), 'utf8'), sb);
const R = sb.RSI, XLSX = sb.XLSX;
// values made inside the vm sandbox have another Array prototype: compare plain copies
const J = x => JSON.parse(JSON.stringify(x));
const dEq = (a, b, m) => assert.deepEqual(J(a), b, m);
const phones = (v, e) => R.classify(v, e).filter(x => x.phone).map(x => x.phone);
const reasons = v => R.classify(v).filter(x => !x.phone).map(x => x.reason);

test('normalises the common Indian mobile formats to 10 digits', () => {
  for (const v of ['9876543210', '+91 98765 43210', '+91-98765-43210', '91 98765 43210', '098765 43210', '0 98765-43210', '0091 9876543210', '(+91) 9876 543 210', ' 98765 43210 ', '9876543210.0', 9876543210, '9.87654321E+09', 9.87654321e9])
    dEq(phones(v), ['9876543210'], JSON.stringify(v));
});
test('landlines, short, long, junk and text are not mobiles', () => {
  dEq(reasons('+91 542 405 2114'), ['landline']);
  dEq(reasons('05422345678'), ['landline']);
  dEq(reasons('98765'), ['too_short']);
  dEq(reasons('987654321012345'), ['too_long']);
  dEq(reasons('5555555555'), ['junk']);
  dEq(reasons('1800 102 1234'), ['too_long']);
  dEq(reasons('Sunrise Office'), ['text']);
  dEq(reasons(true), ['text']);
  dEq(reasons(12.5), ['text']);
  dEq(R.classify(null), []);
});
test('several numbers in one cell are all read; labels are allowed', () => {
  dEq(phones('98765 43210 / 91234 56789'), ['9876543210', '9123456789']);
  dEq(phones('98765 43210 or 91234 56789', true), ['9876543210', '9123456789']);
  dEq(phones('Ph: 98765 43210, Mob: 91234 56789', true), ['9876543210', '9123456789']);
  dEq(phones('Office 98765 43210 / Shop', true), ['9876543210']);
  dEq(phones('Call 98765 43210 / 0542 2345678', true), ['9876543210']);
  dEq(phones('Ph: 98765 43210, Mob: 91234 56789'), []);
});
test('a messy sheet: title row, no-header-in-first-row, phone in an unusual column, duplicates, blanks', () => {
  const rows = [
    ['Client list for November — keep private'],
    [],
    ['S.No', 'Firm name', 'Town', 'Mobile no', 'Rating', 'Remarks'],
    [1, 'Ram Traders', 'Lanka', '+91 98765 43210', 4.5, 'hot'],
    [2, 'Shyam & Co', 'Sigra', 9123456789, 4, ''],
    [3, 'Dup of Ram', 'Lanka', '9876543210', 4, 'again'],
    [4, 'Landline shop', 'Cant', '0542 240 5214', 3, ''],
    [5, '', '', '', '', ''],
    [6, 'No number', 'x', '', 2, 'nothing'],
    [7, 'Two numbers', 'Y', '9988776655 / 9977665544', 5, 'both'],
    [8, 'Sci', 'Z', 8.1234567e9, 5, 'float'],
  ];
  const r = R.analyseRows(rows, {});
  assert.equal(r.header, 2); assert.equal(r.mapping.phone, 3); assert.equal(r.mapping.name, 1); assert.equal(r.mapping.area, 2); assert.equal(r.mapping.notes, 5);
  assert.equal(r.counts.rows_read, 8);
  dEq(r.candidates.map(c => c.phone), ['9876543210', '9123456789', '9988776655', '9977665544', '8123456700']);
  assert.equal(r.counts.dup_in_file, 1);
  assert.equal(r.counts.skipped_by_reason.landline, 1);
  assert.equal(r.counts.skipped_by_reason.no_number, 2);
  assert.equal(r.candidates[0].name, 'Ram Traders'); assert.equal(r.candidates[0].row, 4);
  assert.equal(r.candidates[1].notes, '');
  assert.match(R.skippedCsv(r), /Landline|landline/);
});
test('a sheet with no header row: columns read by letters; text columns guessed as name', () => {
  const rows = [['Ravi Stores', '9811122233', 'Pune'], ['Meera Foods', '+919811122244', 'Pune']];
  const r = R.analyseRows(rows, {});
  assert.equal(r.header, -1); assert.equal(r.mapping.phone, 1); assert.equal(r.mapping.name, 0);
  dEq(r.candidates.map(c => c.phone), ['9811122233', '9811122244']);
  assert.equal(r.labels[0], 'Column A');
});
test('mapping overrides win over the automatic choice and the others switch works', () => {
  const rows = [['Name', 'Phone', 'Alt'], ['A', '9811122233', '9800011122'], ['B', '', '9800011133']];
  const auto = R.analyseRows(rows, {});
  assert.equal(auto.counts.unique_valid, 3, 'other phone columns are read by default');
  const only = R.analyseRows(rows, { others: false });
  assert.equal(only.counts.unique_valid, 1);
  const alt = R.analyseRows(rows, { phone: 2, others: false });
  dEq(alt.candidates.map(c => c.phone), ['9800011122', '9800011133']);
  const noName = R.analyseRows(rows, { name: null });
  assert.equal(noName.candidates[0].name, '');
});
const LEADS = process.env.RSC_LEAD_FILES || '';   // a folder with the two real lead workbooks (not in the repo)
test('the two real lead files give the counts an independent read (openpyxl) gives', { skip: !LEADS }, () => {
  const load = f => { const buf = fs.readFileSync(f); return R.readSheets(XLSX, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)); };
  const a = R.analyseBook(load(LEADS + '/leads-2026-11-04.xlsx'), {}).result;
  assert.equal(a.counts.rows_read, 9); assert.equal(a.counts.unique_valid, 5); assert.equal(a.mapping.phone, 4); assert.equal(a.mapping.name, 1);
  assert.equal(a.candidates[0].phone, '8935017347');
  const b = R.analyseBook(load(LEADS + '/varanasi-accounting-leads-master.xlsx'), {}).result;
  assert.equal(b.counts.rows_read, 116); assert.equal(b.counts.unique_valid, 109); assert.equal(b.counts.skipped_by_reason.landline, 1);
  assert.equal(new Set(b.candidates.map(c => c.phone)).size, 109);
});
test('a workbook with two sheets picks the sheet that has the numbers', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Notes'], ['hello']]), 'Empty');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Name', 'Mobile'], ['X', '9811122233']]), 'Clients');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const sheets = R.readSheets(XLSX, buf instanceof ArrayBuffer ? buf : new Uint8Array(buf).buffer);
  const b = R.analyseBook(sheets, {});
  assert.equal(b.chosen, 'Clients'); assert.equal(b.result.counts.unique_valid, 1);
  assert.equal(R.analyseBook(sheets, { sheet: 'Empty' }).chosen, 'Empty');
});
test('a CSV file with text numbers and leading zeros', () => {
  const csv = 'Name,Phone,Area\r\nAsha,09811122233,Lanka\r\nBina,"+91 98111 22244",Sigra\r\nChan,,Ravindrapuri\r\n';
  const sheets = R.readSheets(XLSX, new TextEncoder().encode(csv).buffer);
  const r = R.analyseBook(sheets, {}).result;
  dEq(r.candidates.map(c => c.phone), ['9811122233', '9811122244']);
  assert.equal(r.candidates[0].area, 'Lanka');
});
test('limits: the file size and the row ceiling are constants the page checks', () => {
  assert.equal(R.MAX_BYTES, 5 * 1024 * 1024); assert.equal(R.MAX_ROWS, 20000);
  const rows = [['Phone']]; for (let i = 0; i < 20005; i++) rows.push(['98' + String(10000000 + i).padStart(8, '0')]);
  const r = R.analyseRows(rows, {}); assert.equal(r.tooManyRows, true);
});
