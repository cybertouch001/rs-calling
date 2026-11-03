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
export function totals(calls, adjustments = []) {
  const t = { made: calls.length, connected: 0, counted: 0, leads: 0, interested: 0, talk_s: 0, call_amount: 0, lead_amount: 0, adjust: 0 };
  for (const c of calls) {
    if (c.duration > 0) { t.connected++; t.talk_s += c.duration; }
    if (c.outcome === 'interested') t.interested++;
    if (c.counted) { t.counted++; t.call_amount += Number(c.call_rate) || 0; }
    if (c.lead_counted) { t.leads++; t.lead_amount += Number(c.lead_rate) || 0; }
  }
  for (const a of adjustments) t.adjust += Number(a.amount) || 0;
  t.connect_rate = t.made ? r2(100 * t.connected / t.made) : 0;
  t.call_amount = r2(t.call_amount); t.lead_amount = r2(t.lead_amount); t.adjust = r2(t.adjust);
  t.payout = r2(t.call_amount + t.lead_amount + t.adjust);
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
