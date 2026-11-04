/* R&S Calling — number-list importer (v1.2). Plain script: sets window.RSI (and module.exports in node tests).
   Reads the rows of an Excel/CSV sheet, finds the header row and the phone-number column(s) by header words AND by
   cell content, normalises Indian mobile numbers and returns candidates + the counts and skipped rows for the preview.
   Pure functions: no network, no DOM. Unit-tested in node: test/importer.test.mjs. */
(function (g) {
  'use strict';
  const MAX_ROWS = 20000, MAX_BYTES = 5 * 1024 * 1024, SCAN_HEADER_ROWS = 10;
  const PHONE_WORD = /(phone|mobile|mob\b|whatsapp|contact|cell|tel|number|\bph\b|\bno\b)/i;
  const NAME_WORD = /(business|company|firm|name|client|customer|shop|party|lead|organi[sz]ation|brand|owner|person|store|outlet)/i;
  const SOURCE_WORD = /(category|source|type|industry|segment|sector|tag|stream|class)/i;
  const AREA_WORD = /(area|address|location|locality|city|place|region|town|street|pin)/i;
  const NOTE_WORD = /(note|remark|comment|observation|description|detail|info)/i;
  const LABEL_PREFIX = /^(ph|phone|mob|mobile|tel|cell|contact|whatsapp|wa|no|number|call|m|mo)\b[\s.:#-]*/i;
  const SKIP_WORD = /(reviews?|rating|date|website|email|url|link|count|total|price|amount)/i;

  const letter = j => { let s = '', n = j + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  const clean = v => (v === null || v === undefined) ? '' : String(v).replace(/\s+/g, ' ').trim();

  /** Digits -> a valid Indian mobile, or the reason it is not one. */
  function fromDigits(raw) {
    let d = String(raw).replace(/\D/g, '');
    if (!d) return { reason: 'empty' };
    if (d.length > 10 && d.startsWith('00')) d = d.slice(2);
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
    else if (d.length === 13 && d.startsWith('091')) d = d.slice(3);
    else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    if (d.length !== 10) return { reason: d.length < 10 ? 'too_short' : 'too_long' };
    if (/^(\d)\1{9}$/.test(d)) return { reason: 'junk' };
    if (/^[6-9]/.test(d)) return { phone: d };
    if (/^[2-5]/.test(d)) return { reason: 'landline' };
    return { reason: 'not_mobile' };
  }

  /** One cell -> list of results, one per number written in it: [{phone}|{reason}]. Empty cell -> []. Text with letters -> [{reason:'text'}]. */
  function classify(v, embedded = false) {
    if (v === null || v === undefined) return [];
    if (typeof v === 'boolean') return [{ reason: 'text' }];
    if (typeof v === 'number') {
      if (!isFinite(v) || v < 0 || Math.abs(v - Math.round(v)) > 1e-6) return [{ reason: 'text' }];
      return [fromDigits(String(Math.round(v)))];
    }
    let s = String(v).trim();
    if (!s) return [];
    if (/^\+?\d+(\.\d+)?e\+?\d+$/i.test(s)) { const n = Number(s.replace(/^\+/, '')); if (isFinite(n) && n >= 0 && n < 1e15) return [fromDigits(String(Math.round(n)))]; }
    s = s.replace(/\.0+$/, '').replace(LABEL_PREFIX, '').trim();
    if (!s) return [];
    if (!/^[\d\s+().\-\/,;|&\n\r]*$/.test(s)) {
      // only the chosen phone column reads numbers written inside words ("Ph: 98765 43210 / Office"); other columns must hold the number alone
      if (!embedded) return [{ reason: 'text' }];
      const parts = s.split(/[\n\r\/,;|&]+| or /i).map(p => p.trim()).filter(Boolean);
      const out = [];
      for (const p of parts) for (const run of (p.match(/\+?\d[\d\s\-().]{7,}\d/g) || [])) if (run.replace(/\D/g, '').length >= 10) out.push(fromDigits(run));
      return out.length ? out : [{ reason: 'text' }];
    }
    return s.split(/[\n\r\/,;|&]+| or /i).map(p => p.trim()).filter(p => /\d/.test(p)).map(fromDigits);
  }

  const isTextCell = v => typeof v === 'string' && /[A-Za-z\u0900-\u097F]/.test(v);

  /** Find the header row among the first rows: the row whose short text cells look most like column names. */
  function findHeader(rows) {
    let best = -1, bestScore = 0;
    for (let r = 0; r < Math.min(rows.length, SCAN_HEADER_ROWS); r++) {
      let kw = 0, phoneHdr = false, hasNumber = false;
      for (const c of rows[r] || []) {
        if (classify(c).some(x => x.phone)) hasNumber = true;
        const t = clean(c); if (!t || t.length > 40 || typeof c === 'number') continue;
        if (PHONE_WORD.test(t)) { phoneHdr = true; kw++; } else if (NAME_WORD.test(t) || AREA_WORD.test(t) || SOURCE_WORD.test(t) || NOTE_WORD.test(t)) kw++;
      }
      if (hasNumber) continue;                       // a row with a number in it is data, not a header
      if (!(kw >= 2 || (kw >= 1 && phoneHdr))) continue;
      const score = kw * 2 + (phoneHdr ? 2 : 0);
      if (score > bestScore) { best = r; bestScore = score; }
    }
    return best;
  }

  /** Column labels for the dropdowns: the header text, or the column letter. */
  function labels(rows, header, width) {
    const out = [];
    for (let j = 0; j < width; j++) { const h = header >= 0 ? clean((rows[header] || [])[j]) : ''; out.push(h ? h.slice(0, 60) : 'Column ' + letter(j)); }
    return out;
  }

  /** Per-column statistics over the data rows. */
  function columnStats(rows, start, width, header) {
    const st = Array.from({ length: width }, (_, j) => ({ index: j, nonEmpty: 0, valid: 0, text: 0, phoneHdr: 0, nameHdr: 0, sourceHdr: 0, areaHdr: 0, noteHdr: 0, skipHdr: 0 }));
    for (let r = start; r < rows.length; r++) {
      const row = rows[r] || [];
      for (let j = 0; j < width; j++) {
        const v = row[j]; const c = st[j];
        if (v === null || v === undefined || clean(v) === '') continue;
        c.nonEmpty++;
        if (isTextCell(v)) c.text++;
        if (classify(v).some(x => x.phone)) c.valid++;
      }
    }
    if (header >= 0) for (let j = 0; j < width; j++) {
      const h = clean((rows[header] || [])[j]); const c = st[j];
      if (!h) continue;
      if (SKIP_WORD.test(h) && !PHONE_WORD.test(h)) c.skipHdr = 1;
      if (PHONE_WORD.test(h)) c.phoneHdr = 1;
      if (NAME_WORD.test(h) && !PHONE_WORD.test(h)) c.nameHdr = 1;
      if (SOURCE_WORD.test(h)) c.sourceHdr = 1;
      if (AREA_WORD.test(h) && !PHONE_WORD.test(h)) c.areaHdr = 1;
      if (NOTE_WORD.test(h)) c.noteHdr = 1;
    }
    return st;
  }

  const isPhoneCol = c => c.valid > 0 && c.valid >= Math.max(1, 0.3 * c.nonEmpty);

  /** Work out the sheet's layout: header row, phone columns (primary + others), and the automatic mapping for name/area/source/notes. */
  function layout(rows) {
    const width = Math.max(0, ...rows.slice(0, 2000).map(r => (r || []).length));
    const header = findHeader(rows);
    const start = header + 1;
    const stats = columnStats(rows, start, width, header);
    const cands = stats.filter(isPhoneCol).sort((a, b) => (b.phoneHdr - a.phoneHdr) || (b.valid - a.valid) || (a.index - b.index));
    const primary = cands.length ? cands[0].index : null;
    const others = cands.slice(1).map(c => c.index);
    const pick = (flag, exclude) => { const c = stats.filter(s => s[flag] && !exclude.includes(s.index) && s.index !== primary && !others.includes(s.index)).sort((a, b) => a.index - b.index)[0]; return c ? c.index : null; };
    const used = [primary, ...others];
    let name = pick('nameHdr', used);
    if (name === null) { // no name header: the first mostly-text column that is not a phone column
      const t = stats.filter(s => !used.includes(s.index) && s.nonEmpty > 0 && s.text >= 0.6 * s.nonEmpty && !s.skipHdr).sort((a, b) => a.index - b.index)[0];
      name = t ? t.index : null;
    }
    const area = pick('areaHdr', [...used, name]);
    const source = pick('sourceHdr', [...used, name, area]);
    const notes = pick('noteHdr', [...used, name, area, source]);
    return { header, start, width, stats, primary, others, mapping: { phone: primary, name, area, source, notes }, labels: labels(rows, header, width) };
  }

  const textOf = (row, j) => (j === null || j === undefined) ? '' : (() => { const v = (row || [])[j]; if (v === null || v === undefined) return ''; if (typeof v === 'number') return String(v); return clean(v); })();

  /** Full analysis of one sheet with optional mapping overrides: {phone, others: bool, name, area, source, notes} (null = none, undefined = automatic). */
  function analyseRows(rows, over = {}) {
    rows = rows || [];
    const L = layout(rows);
    const m = { ...L.mapping };
    for (const k of ['phone', 'name', 'area', 'source', 'notes']) if (over[k] !== undefined) m[k] = over[k];
    const useOthers = over.others === undefined ? true : !!over.others;
    const phoneCols = [m.phone, ...(useOthers ? L.others : [])].filter((x, i, a) => x !== null && x !== undefined && a.indexOf(x) === i);
    const res = { header: L.header, headerLabel: L.header >= 0 ? L.header + 1 : null, labels: L.labels, mapping: { ...m, others: useOthers ? L.others : [] }, phoneColumns: phoneCols,
      counts: { rows_read: 0, rows_with_number: 0, numbers_found: 0, unique_valid: 0, dup_in_file: 0, rows_no_number: 0, skipped_by_reason: {} },
      candidates: [], skipped: [], tooManyRows: false };
    const seen = new Map();
    const skip = (row, reason, value, name) => { res.counts.skipped_by_reason[reason] = (res.counts.skipped_by_reason[reason] || 0) + 1; if (res.skipped.length < 5000) res.skipped.push({ row, reason, value, name }); };
    for (let r = L.start; r < rows.length; r++) {
      const row = rows[r] || [];
      if (!row.some(v => v !== null && v !== undefined && clean(v) !== '')) continue;
      res.counts.rows_read++;
      if (res.counts.rows_read > MAX_ROWS) { res.tooManyRows = true; break; }
      const excelRow = r + 1;
      const nameV = textOf(row, m.name), area = textOf(row, m.area), source = textOf(row, m.source), notes = textOf(row, m.notes);
      const found = [], reasons = [];
      for (const j of phoneCols) for (const x of classify(row[j], j === m.phone)) { if (x.phone) found.push(x.phone); else reasons.push(x.reason); }
      const numbers = [...new Set(found)];
      if (!numbers.length) {
        res.counts.rows_no_number++;
        const why = reasons.length ? reasons[0] : 'no_number';
        const hasAny = phoneCols.some(j => clean(row[j]) !== '');
        skip(excelRow, hasAny ? why : 'no_number', phoneCols.map(j => clean(row[j])).filter(Boolean).join(' | ').slice(0, 80), nameV.slice(0, 80));
        continue;
      }
      res.counts.rows_with_number++;
      res.counts.numbers_found += numbers.length;
      for (const p of numbers) {
        if (seen.has(p)) { res.counts.dup_in_file++; skip(excelRow, 'duplicate_in_file', p, nameV.slice(0, 80)); continue; }
        seen.set(p, excelRow);
        res.candidates.push({ phone: p, name: nameV.slice(0, 120), area: area.slice(0, 120), source: source.slice(0, 120), notes: notes.slice(0, 500), row: excelRow });
      }
    }
    res.counts.unique_valid = res.candidates.length;
    return res;
  }

  /** Several sheets: the sheet with the most valid numbers (ties: the first). */
  function analyseBook(sheets, over = {}) {
    const all = sheets.map(s => ({ name: s.name, ...analyseRows(s.rows, over.sheet === s.name ? over : {}) }));
    const pick = over.sheet && all.find(s => s.name === over.sheet) ? all.find(s => s.name === over.sheet) : all.reduce((b, s) => (s.counts.unique_valid > b.counts.unique_valid ? s : b), all[0]);
    return { sheets: all.map(s => ({ name: s.name, unique_valid: s.counts.unique_valid, rows_read: s.counts.rows_read })), chosen: pick.name, result: pick };
  }

  /** Read an Excel/CSV file (ArrayBuffer) with the SheetJS library passed in. Returns [{name, rows}]. */
  function readSheets(XLSXlib, buf) {
    const wb = XLSXlib.read(new Uint8Array(buf), { type: 'array', raw: true, cellDates: false });
    return wb.SheetNames.map(n => ({ name: n, rows: XLSXlib.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '', blankrows: false }) }));
  }

  const csvCell = v => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) || /^[=+\-@]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const REASON = { landline: 'Landline (not a mobile)', not_mobile: 'Not an Indian mobile number', too_short: 'Too few digits', too_long: 'Too many digits', junk: 'Repeated digits', text: 'Text, no number', empty: 'Empty', no_number: 'No number in the row', duplicate_in_file: 'Same number appears earlier in the file' };
  const reasonText = r => REASON[r] || r;
  function skippedCsv(res) {
    const lines = [['Row', 'Reason', 'Value', 'Name'].map(csvCell).join(',')];
    for (const s of res.skipped) lines.push([s.row, reasonText(s.reason), s.value, s.name].map(csvCell).join(','));
    return '\ufeff' + lines.join('\r\n') + '\r\n';
  }

  const api = { MAX_ROWS, MAX_BYTES, fromDigits, classify, layout, analyseRows, analyseBook, readSheets, skippedCsv, reasonText, letter };
  g.RSI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
