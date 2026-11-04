// R&S Calling — counting, anti-fraud and payout rules. Pure functions (no I/O) so they can be unit-tested.
// Times are epoch milliseconds (UTC). Day keys use the configured timezone offset (India = +330 minutes).

export const DEFAULTS = {
  call_rate: 2,          // ₹ per counted call
  lead_rate: 20,         // ₹ per Interested lead
  min_duration: 30,      // seconds a call must last to count
  repeat_hours: 24,      // repeat calls to the same number within this window count once
  tz_offset_min: 330,    // India (IST)
  tap_tolerance_s: 10,   // call-log start may be this much before the tap (phone clock jitter)
  short_flag_count: 5,   // flag a caller-day with at least this many connected-but-too-short calls...
  short_flag_share: 0.4, // ...making up at least this share of connected calls
  offlist_flag_count: 3, // flag a caller-day with this many calls to numbers not on their list
  repeat_flag_count: 3,  // flag a caller-day where one number was called this many times
};

export const OUTCOMES = ['interested', 'not_interested', 'callback', 'wrong_number', 'not_reachable'];
export const OUTCOME_LABEL = {
  interested: 'Interested', not_interested: 'Not interested', callback: 'Callback',
  wrong_number: 'Wrong number', not_reachable: 'Not reachable',
};

export const REASON_TEXT = {
  counted: 'Counted',
  not_on_list: 'Number is not on this caller\'s assigned list',
  number_mismatch: 'Number in phone call log does not match the client number',
  not_in_log: 'Call not found in the phone call log',
  time_mismatch: 'Call log time does not match the tap in the app',
  not_connected: 'Not connected (0 seconds talk time)',
  too_short: 'Shorter than the minimum duration',
  overlap: 'Same-time call (overlaps another call by this caller)',
  repeat: 'Repeat call to the same number inside the repeat window',
  admin_no: 'Not counted by admin',
  admin_yes: 'Counted by admin',
};

/** Normalise an Indian phone number to its last 10 digits (strips +91, 0, spaces, dashes). Returns '' if invalid. */
export function normPhone(raw) {
  let d = String(raw == null ? '' : raw).trim().replace(/\.0+$/, '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 13 && d.startsWith('091')) d = d.slice(3);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d.length === 10 ? d : '';
}

export function dayKey(ts, tzMin = DEFAULTS.tz_offset_min) {
  return new Date(Number(ts) + tzMin * 60000).toISOString().slice(0, 10);
}
export function dayStart(key, tzMin = DEFAULTS.tz_offset_min) {
  return Date.parse(key + 'T00:00:00Z') - tzMin * 60000;
}

/** Stage 1 — reasons that depend only on the call itself. Returns null when the call is eligible so far. */
export function baseReason(c, s) {
  if (!c.assigned_ok) return 'not_on_list';
  if (!c.log_found) return 'not_in_log';
  if (c.log_phone && c.phone && normPhone(c.log_phone) !== normPhone(c.phone)) return 'number_mismatch';
  if (c.tapped_at && c.start_ts && c.start_ts < c.tapped_at - (s.tap_tolerance_s || 0) * 1000) return 'time_mismatch';
  if (!(c.duration > 0)) return 'not_connected';
  if (c.duration < s.min_duration) return 'too_short';
  return null;
}

/** Stage 2 — same-time calls by one caller. Input: one caller's calls. Returns Set of ids that overlap an EARLIER call. */
export function overlapIds(userCalls) {
  const xs = userCalls.filter(c => c.log_found && c.start_ts && c.duration > 0).sort((a, b) => a.start_ts - b.start_ts || String(a.id).localeCompare(String(b.id)));
  const out = new Set(); let endMax = -Infinity;
  for (const c of xs) {
    if (c.start_ts < endMax - 1000) out.add(c.id);            // starts more than 1 s before the previous call ended
    endMax = Math.max(endMax, c.start_ts + c.duration * 1000);
  }
  return out;
}

/** Stage 3 — per number: repeat window chain + first Interested lead. Input: every call to ONE number (any caller),
 *  each with .elig_reason (null | reason from stages 1–2). Returns Map id -> {counted, reason, lead_counted, lead_reason}. */
export function chainNumber(phoneCalls, s) {
  const xs = phoneCalls.slice().sort((a, b) => (a.start_ts || a.tapped_at || 0) - (b.start_ts || b.tapped_at || 0) || String(a.id).localeCompare(String(b.id)));
  const win = s.repeat_hours * 3600000; let lastCounted = -Infinity; let leadTaken = false; const res = new Map();
  for (const c of xs) {
    const t = c.start_ts || c.tapped_at || 0; let counted, reason;
    if (c.override === 0) { counted = false; reason = 'admin_no'; }
    else if (c.override === 1) { counted = true; reason = 'admin_yes'; }
    else if (c.elig_reason) { counted = false; reason = c.elig_reason; }
    else if (t - lastCounted < win) { counted = false; reason = 'repeat'; }
    else { counted = true; reason = 'counted'; }
    if (counted) lastCounted = t;
    // lead: Interested on a real connected call of at least the minimum duration, first one for this number
    let lead_counted = false, lead_reason = null;
    if (c.outcome === 'interested') {
      const real = c.override === 1 || (!c.elig_reason && c.override !== 0);   // repeat does not block a lead
      if (c.lead_override === 0) lead_reason = 'Lead rejected by admin';
      else if (!real) lead_reason = 'Call did not qualify: ' + (REASON_TEXT[reason] || reason);
      else if (leadTaken) lead_reason = 'Lead for this number already paid';
      else { lead_counted = true; leadTaken = true; lead_reason = 'Lead counted'; }
    }
    res.set(c.id, { counted, reason, lead_counted, lead_reason });
  }
  return res;
}

/** Full evaluation of a complete set of calls (used by tests and by "recalculate all"). Mutates nothing; returns Map. */
export function evaluateAll(calls, settings) {
  const s = { ...DEFAULTS, ...settings };
  const byUser = new Map(), byPhone = new Map();
  for (const c of calls) { (byUser.get(c.user_id) || byUser.set(c.user_id, []).get(c.user_id)).push(c); }
  const ov = new Set(); for (const list of byUser.values()) for (const id of overlapIds(list)) ov.add(id);
  const staged = calls.map(c => ({ ...c, elig_reason: baseReason(c, s) || (ov.has(c.id) ? 'overlap' : null) }));
  for (const c of staged) { const k = normPhone(c.phone) || ('?' + c.id); (byPhone.get(k) || byPhone.set(k, []).get(k)).push(c); }
  const out = new Map();
  for (const list of byPhone.values()) for (const [id, r] of chainNumber(list, s)) out.set(id, { ...r, elig_reason: staged.find(x => x.id === id).elig_reason });
  return out;
}

/** Suspicious-pattern flags for one caller's calls on one day. */
export function dayFlags(dayCalls, settings) {
  const s = { ...DEFAULTS, ...settings }; const flags = [];
  const connected = dayCalls.filter(c => c.duration > 0);
  const short = connected.filter(c => c.duration < s.min_duration);
  if (short.length >= s.short_flag_count && short.length / Math.max(1, connected.length) >= s.short_flag_share)
    flags.push(`Many very short calls: ${short.length} of ${connected.length} connected calls were under ${s.min_duration}s`);
  const ov = overlapIds(dayCalls).size; if (ov) flags.push(`${ov} same-time (overlapping) call${ov > 1 ? 's' : ''}`);
  const off = dayCalls.filter(c => !c.assigned_ok).length; if (off >= s.offlist_flag_count) flags.push(`${off} calls to numbers not on the assigned list`);
  const per = {}; for (const c of dayCalls) { const k = normPhone(c.phone); per[k] = (per[k] || 0) + 1; }
  const rep = Object.entries(per).filter(([, n]) => n >= s.repeat_flag_count);
  if (rep.length) flags.push(`Same number called ${Math.max(...rep.map(r => r[1]))} times in a day (${rep.length} number${rep.length > 1 ? 's' : ''})`);
  const mism = dayCalls.filter(c => c.reason === 'time_mismatch' || c.reason === 'number_mismatch').length;
  if (mism) flags.push(`${mism} call${mism > 1 ? 's' : ''} where the phone call log did not match the app`);
  return flags;
}

const r2 = n => Math.round(n * 100) / 100;

/** Totals for one caller over a set of (already evaluated) calls + adjustments. Calls carry call_rate/lead_rate snapshots. */
export function totals(calls, adjustments = [], callbacks = []) {
  const t = { made: calls.length, connected: 0, counted: 0, leads: 0, interested: 0, talk_s: 0, call_amount: 0, lead_amount: 0, adjust: 0, callbacks: callbacks.length, callbacks_counted: 0, callback_amount: 0 };
  for (const c of calls) {
    if (c.duration > 0) { t.connected++; t.talk_s += c.duration; }
    if (c.outcome === 'interested') t.interested++;
    if (c.counted) { t.counted++; t.call_amount += Number(c.call_rate) || 0; }
    if (c.lead_counted) { t.leads++; t.lead_amount += Number(c.lead_rate) || 0; }
  }
  for (const a of adjustments) t.adjust += Number(a.amount) || 0;
  for (const b of callbacks) if (b.counted) { t.callbacks_counted++; t.callback_amount += Number(b.rate) || 0; }
  t.connect_rate = t.made ? r2(100 * t.connected / t.made) : 0;
  t.call_amount = r2(t.call_amount); t.lead_amount = r2(t.lead_amount); t.adjust = r2(t.adjust); t.callback_amount = r2(t.callback_amount);
  t.payout = r2(t.call_amount + t.lead_amount + t.callback_amount + t.adjust);
  return t;
}

/** Round-robin split of contact ids across caller ids. Returns Map callerId -> [contactIds]. */
export function roundRobin(contactIds, callerIds, start = 0) {
  const m = new Map(callerIds.map(id => [id, []])); if (!callerIds.length) return m;
  contactIds.forEach((cid, i) => m.get(callerIds[(i + start) % callerIds.length]).push(cid));
  return m;
}

/** Parse uploaded rows (array of objects with any header case) into clean contacts + a report. */
export function cleanRows(rows, existingPhones = new Set()) {
  const pick = (r, names) => { for (const k of Object.keys(r)) { const n = k.toLowerCase().replace(/[^a-z]/g, ''); if (names.includes(n)) return r[k]; } return ''; };
  const seen = new Set(); const good = []; const rep = { total: rows.length, added: 0, dup_in_file: 0, dup_existing: 0, invalid: 0, invalid_rows: [] };
  rows.forEach((r, i) => {
    const phone = normPhone(pick(r, ['phone', 'mobile', 'number', 'phonenumber', 'mobilenumber', 'contact', 'contactnumber', 'mobileno', 'phoneno']));
    if (phone.length !== 10) { rep.invalid++; if (rep.invalid_rows.length < 20) rep.invalid_rows.push(i + 2); return; }
    if (seen.has(phone)) { rep.dup_in_file++; return; }
    seen.add(phone);
    if (existingPhones.has(phone)) { rep.dup_existing++; return; }
    good.push({ phone, name: String(pick(r, ['name', 'clientname', 'customername', 'fullname', 'client', 'customer']) || '').trim().slice(0, 120),
      area: String(pick(r, ['area', 'city', 'location', 'locality', 'address']) || '').trim().slice(0, 120),
      notes: String(pick(r, ['notes', 'note', 'remarks', 'remark', 'comments', 'comment']) || '').trim().slice(0, 500) });
  });
  rep.added = good.length; return { contacts: good, report: rep };
}


// ================= v1.1 additions =================
export const DEFAULTS11 = {
  min_withdrawal: 100,      // ₹ smallest withdrawal a caller can request
  retention_days: 7,        // days a caller's own call/log copies stay in the app after they are safely synced
  daily_target: 10,         // counted calls per India day = "daily task done" (streak)
  streak_bonus_7: 0,        // ₹ bonus when a streak reaches 7 days (0 = off)
  streak_bonus_30: 0,       // ₹ bonus when a streak reaches 30 days (0 = off)
  callback_counts: 0,       // 1 = a long enough callback from a called number also earns the per-call rate
  callback_window_days: 30, // an incoming call from a number counts as a callback for this long after the last app call to it
  withdraw_hours: 16,       // admin pays within this many hours of the request
  log_access_hours: 48,     // an approved log request stays viewable this long
  streak_bonus_since: 0,    // yyyymmdd the bonus was switched on (internal: no back-dated bonuses)
};
Object.assign(DEFAULTS, DEFAULTS11);

// ---- payment details validation ----
export const UPI_RE = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9]{1,31}$/;
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const ACCT_RE = /^[0-9]{9,18}$/;
export const isUpi = v => UPI_RE.test(String(v || '').trim());
export const isIfsc = v => IFSC_RE.test(String(v || '').trim().toUpperCase());
export const isAcct = v => ACCT_RE.test(String(v || '').replace(/[\s-]/g, ''));
/** Validate the fields a caller typed. `cur` = what is stored now. Returns {error} or {value}. A field that is undefined keeps its stored value. */
export function validatePayment(b, cur = {}) {
  const v = { upi: cur.upi || '', holder: cur.holder || '', account_no: cur.account_no || '', ifsc: cur.ifsc || '', bank: cur.bank || '' };
  const t = x => String(x == null ? '' : x).trim();
  if (b.upi !== undefined) { v.upi = t(b.upi).toLowerCase(); if (v.upi && !isUpi(v.upi)) return { error: 'UPI ID looks wrong. Example: name@okbank' }; }
  const bankKeys = ['holder', 'account_no', 'ifsc', 'bank'];
  if (bankKeys.some(k => b[k] !== undefined)) {
    for (const k of bankKeys) if (b[k] !== undefined) v[k] = t(b[k]);
    v.account_no = v.account_no.replace(/[\s-]/g, ''); v.ifsc = v.ifsc.toUpperCase();
    const any = bankKeys.some(k => v[k]);
    if (any) {
      if (!v.holder || v.holder.length < 2 || v.holder.length > 80) return { error: 'Enter the account holder name as it is on the bank account' };
      if (!ACCT_RE.test(v.account_no)) return { error: 'Account number must be 9 to 18 digits' };
      if (!IFSC_RE.test(v.ifsc)) return { error: 'IFSC must be 11 characters, e.g. SBIN0001234 (4 letters, 0, then 6 letters/digits)' };
      if (!v.bank || v.bank.length < 2 || v.bank.length > 80) return { error: 'Enter the bank name' };
    }
  }
  const hasUpi = !!v.upi, hasBank = !!(v.holder && v.account_no && v.ifsc && v.bank);
  if (!hasUpi && !hasBank) return { error: 'Add a UPI ID or your bank details (or both)' };
  return { value: v };
}
export const maskUpi = u => { u = String(u || ''); const i = u.indexOf('@'); if (i < 0) return ''; const a = u.slice(0, i); return (a.length <= 2 ? a[0] + '*' : a.slice(0, 2) + '*'.repeat(Math.min(6, a.length - 2))) + u.slice(i); };
export const maskAcct = a => { a = String(a || ''); return a.length < 5 ? '' : '*'.repeat(a.length - 4) + a.slice(-4); };
/** UPI deep link: payee = caller's UPI id. Amount to 2 decimals. */
export function upiLink({ pa, pn, am, tn }) {
  const q = [['pa', pa], ['pn', pn], ['am', Number(am).toFixed(2)], ['cu', 'INR'], ['tn', tn]].filter(x => x[1]).map(([k, v]) => k + '=' + encodeURIComponent(String(v)).replace(/%40/g, '@'));
  return 'upi://pay?' + q.join('&');
}

// ---- wallet / withdrawals ----
/** Wallet numbers (₹) from stored totals. earned = all-time payout; approved = sum of approved payouts; paidOffline = approved payouts marked paid outside the app. */
export function walletCalc({ earned = 0, approved = 0, paidOffline = 0, withdrawals = [] }) {
  let withdrawn = 0, reserved = 0;
  for (const w of withdrawals) { if (w.status === 'paid') withdrawn += Number(w.amount) || 0; else if (w.status === 'pending') reserved += Number(w.amount) || 0; }
  const approvedFree = r2(approved - paidOffline);
  return { raw_available: r2(approvedFree - withdrawn - reserved), total_earned: r2(earned), approved: r2(approved), pending_approval: r2(Math.max(0, earned - approved)), withdrawn: r2(withdrawn), reserved: r2(reserved), available: r2(Math.max(0, approvedFree - withdrawn - reserved)) };
}
export function checkWithdraw(amount, wallet, s, hasDetails) {
  const a = Number(amount);
  if (!hasDetails) return 'Add your UPI ID or bank details first';
  if (!isFinite(a) || a <= 0) return 'Enter an amount';
  if (Math.round(a * 100) !== a * 100 && Math.abs(Math.round(a * 100) - a * 100) > 1e-6) return 'Amount can have at most 2 decimals';
  if (a < s.min_withdrawal) return `Minimum withdrawal is ₹${s.min_withdrawal}`;
  if (a > wallet.available + 1e-9) return `You can withdraw at most ₹${wallet.available}`;
  return null;
}
export const dueAt = (requestedAt, hours) => Number(requestedAt) + Number(hours) * 3600000;
export const isOverdue = (w, now) => w.status === 'pending' && now > w.due_at;

// ---- callbacks ----
/** Which phone-log entries are callbacks. entries: [{number,date,duration,type}] (type incoming|missed|outgoing). called: Map phone -> {first, last}.
 *  appCallTimes: Set of start times of calls already recorded from the app (so an outgoing app call is not read as anything else).
 *  Returns {events:[{phone,start_ts,duration,kind}], returned:[{phone,out_ts}], skipped:[{phone,date,reason}]} */
export function matchCallbacks(entries, called, s, appCallTimes = new Set()) {
  const events = [], returned = [], skipped = []; const win = (s.callback_window_days || 30) * 86400000;
  for (const e of entries) {
    const phone = normPhone(e.number); const date = Number(e.date); const type = String(e.type || '');
    if (!phone || !isFinite(date)) { skipped.push({ phone, date, reason: 'bad_entry' }); continue; }
    const c = called.get(phone);
    if (!c) { skipped.push({ phone, date, reason: 'not_called_from_app' }); continue; }
    if (type === 'incoming' || type === 'missed') {
      if (date < c.first) { skipped.push({ phone, date, reason: 'before_first_app_call' }); continue; }
      if (date > c.last + win) { skipped.push({ phone, date, reason: 'outside_window' }); continue; }
      events.push({ phone, start_ts: date, duration: type === 'missed' ? 0 : Math.max(0, Math.round(Number(e.duration) || 0)), kind: type });
    } else if (type === 'outgoing') {
      if ([...appCallTimes].some(t => Math.abs(t - date) <= 15000)) { skipped.push({ phone, date, reason: 'app_call' }); continue; }
      if (date >= c.first) returned.push({ phone, out_ts: date }); else skipped.push({ phone, date, reason: 'before_first_app_call' });
    } else skipped.push({ phone, date, reason: 'other_type' });
  }
  return { events, returned, skipped };
}
/** Which callback events earn pay. events for ONE or many numbers; returns Map id -> {counted, reason}. Default: nothing counts (callback_counts = 0). */
export function callbackCounting(events, s) {
  const res = new Map(); const byP = new Map();
  for (const e of events) (byP.get(e.phone) || byP.set(e.phone, []).get(e.phone)).push(e);
  for (const list of byP.values()) {
    list.sort((a, b) => a.start_ts - b.start_ts); let last = -Infinity;
    for (const e of list) {
      let counted = false, reason;
      if (!s.callback_counts) reason = 'Callbacks are recorded but not paid';
      else if (e.kind !== 'incoming' || !(e.duration > 0)) reason = 'Missed callback';
      else if (e.duration < s.min_duration) reason = 'Callback shorter than the minimum duration';
      else if (e.start_ts - last < s.repeat_hours * 3600000) reason = 'Another counted callback from this number inside the repeat window';
      else { counted = true; reason = 'Counted callback'; last = e.start_ts; }
      res.set(e.id, { counted, reason });
    }
  }
  return res;
}

// ---- streak ----
/** dayCounts: {dayKey: counted calls}. Returns current / longest streak, today's progress, last-14-days strip. */
export function streakCalc(dayCounts, target, today) {
  const T = Math.max(1, Math.round(Number(target) || 1)); const done = d => (dayCounts[d] || 0) >= T;
  const prev = d => dayKey(dayStart(d, 0) - 3600000, 0);   // previous calendar day key (dayStart with tz 0 = UTC midnight of the key)
  const next = d => dayKey(dayStart(d, 0) + 86400000 + 3600000, 0);
  let cur = 0, d = done(today) ? today : prev(today);
  while (done(d)) { cur++; d = prev(d); }
  const keys = Object.keys(dayCounts).filter(done).sort(); let longest = 0, run = 0, last = null;
  for (const k of keys) { run = last && next(last) === k ? run + 1 : 1; longest = Math.max(longest, run); last = k; }
  const days14 = []; let x = today; for (let i = 0; i < 14; i++) { days14.unshift({ day: x, count: dayCounts[x] || 0, done: done(x) }); x = prev(x); }
  return { current: cur, longest, target: T, today_count: dayCounts[today] || 0, today_done: done(today), days14 };
}
/** Days on which a run of consecutive done-days reached 7 and 30 days. Returns [{milestone, day, run_start}] */
export function streakMilestones(dayCounts, target) {
  const T = Math.max(1, Math.round(Number(target) || 1)); const keys = Object.keys(dayCounts).filter(k => (dayCounts[k] || 0) >= T).sort();
  const next = d => dayKey(dayStart(d, 0) + 86400000 + 3600000, 0); const out = []; let run = 0, last = null, start = null;
  for (const k of keys) {
    if (last && next(last) === k) run++; else { run = 1; start = k; }
    if (run === 7 || run === 30) out.push({ milestone: run, day: k, run_start: start });
    last = k;
  }
  return out;
}

// ---- retention (server view of a caller's own logs) ----
export const retentionCutoff = (now, days) => now - Math.max(1, Number(days) || 7) * 86400000;

// ---- CSV ----
/** CSV with spreadsheet-formula protection. */
export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^[-+]?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export const toCsv = (cols, rows) => '\ufeff' + [cols.map(csvCell).join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
export const LOG_COLS = ['Record', 'Date', 'Time (IST)', 'Caller', 'Client name', 'Client number', 'Talk time (s)', 'Connected', 'Counted', 'Reason', 'Outcome', 'Lead counted', 'Callback date', 'Notes', 'Callback event', 'Callback counted'];

// ---- Terms & Conditions ----
export const TERMS_V1_DATE = '4 November 2026';
export const TERMS_V1 = `R&S Calling — Terms & Conditions
Version 1 · ${TERMS_V1_DATE}

By using R&S Calling you agree to these Terms.

1. Withdrawals are processed within 16 hours of the request. The admin pays the amount to the UPI ID or bank account you saved. Withdrawals need valid payment details, and you are responsible for their correctness.
2. Speak to every client in a proper, formal and respectful manner. No abuse, no anger and no aggressive language, ever.
3. The tasks given to you must be completed every day.
4. You have a formal working relationship with the company and must behave professionally at all times.
5. No call, no money. Only verified, counted calls and approved leads are paid.
6. No fake information. Fake leads, wrong data, fake calls and manipulating call records are strictly prohibited.
7. Any breach of these Terms may lead to legal action.
8. Every counted call must include a conversation of at least 30 seconds (or the minimum the admin has set in the app).
9. Call-log and activity tracking: you agree that the app records the calls you make from it for work purposes: the client number, time, duration, result and your notes. Call audio is never recorded. The app reads your phone's call history only to check the calls you made from the app and any callbacks from clients you called.
10. Client data is confidential. Do not share, copy, or use client names or numbers for any other purpose, during or after your work.
11. One account per person. Do not share your login with anyone.
12. Payouts are subject to admin verification. Fraud, duplicate calls and calls that do not meet the rules are excluded, and the company may hold or reverse earnings that are found to be fraudulent.
13. The admin may suspend or remove an account for any breach of these Terms.
14. The company may update these Terms. When they change you must accept the new version before you can continue using the app.
15. You must follow Indian law, including telecom and Do-Not-Disturb (DND) rules, whenever you call a client.
16. These Terms are governed by the laws of India.`;
