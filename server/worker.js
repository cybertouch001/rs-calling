// R&S Calling — hosted API (Cloudflare Worker + D1). Static files (landing page, web app, APK) come from ASSETS.
import * as R from './rules.js';
import { VERSION, ADMIN_BOOT, APK } from './config.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, role TEXT NOT NULL, username TEXT NOT NULL UNIQUE COLLATE NOCASE, phone TEXT, name TEXT, pw TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, app TEXT, device TEXT, ip TEXT, created_at INTEGER, last_seen INTEGER, revoked_at INTEGER, revoke_reason TEXT)`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, phone TEXT NOT NULL UNIQUE, name TEXT, area TEXT, notes TEXT, assigned_to TEXT, assigned_at INTEGER, status TEXT DEFAULT 'new', last_call_at INTEGER, last_note TEXT, callback_at INTEGER, lead_state TEXT, followup_at INTEGER, followup_note TEXT, batch TEXT, created_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS contacts_assigned ON contacts(assigned_to)`,
  `CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT, phone TEXT, log_phone TEXT, tapped_at INTEGER, start_ts INTEGER, duration INTEGER DEFAULT 0, log_found INTEGER DEFAULT 0, log_type TEXT, assigned_ok INTEGER DEFAULT 0, outcome TEXT, callback_at INTEGER, note TEXT, device TEXT, synced_at INTEGER, elig_reason TEXT, counted INTEGER DEFAULT 0, reason TEXT, lead_counted INTEGER DEFAULT 0, lead_reason TEXT, override INTEGER, override_reason TEXT, lead_override INTEGER, lead_override_reason TEXT, call_rate REAL, lead_rate REAL, approval_id TEXT)`,
  `CREATE INDEX IF NOT EXISTS calls_user_t ON calls(user_id, start_ts)`,
  `CREATE INDEX IF NOT EXISTS calls_phone ON calls(phone)`,
  `CREATE INDEX IF NOT EXISTS calls_t ON calls(tapped_at)`,
  `CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS adjustments (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, day TEXT NOT NULL, amount REAL NOT NULL, reason TEXT NOT NULL, created_by TEXT, created_at INTEGER, approval_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, from_day TEXT, to_day TEXT, made INTEGER, counted INTEGER, leads INTEGER, call_amount REAL, lead_amount REAL, adjust REAL, payout REAL, note TEXT, approved_by TEXT, approved_at INTEGER, paid INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, user_id TEXT, action TEXT, detail TEXT)`,
  `CREATE TABLE IF NOT EXISTS login_fail (k TEXT PRIMARY KEY, n INTEGER, first_at INTEGER)`,
  // ---- v1.1 ----
  `CREATE TABLE IF NOT EXISTS payment_details (user_id TEXT PRIMARY KEY, upi TEXT, holder TEXT, account_no TEXT, ifsc TEXT, bank TEXT, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS withdrawals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, amount REAL NOT NULL, status TEXT NOT NULL, requested_at INTEGER, due_at INTEGER, paid_at INTEGER, utr TEXT, reject_reason TEXT, decided_by TEXT, decided_at INTEGER, pay_upi TEXT, pay_holder TEXT, pay_account_no TEXT, pay_ifsc TEXT, pay_bank TEXT)`,
  `CREATE INDEX IF NOT EXISTS wd_user ON withdrawals(user_id, status)`,
  `CREATE TABLE IF NOT EXISTS callbacks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT, phone TEXT NOT NULL, start_ts INTEGER NOT NULL, duration INTEGER DEFAULT 0, kind TEXT, returned_at INTEGER, counted INTEGER DEFAULT 0, reason TEXT, rate REAL, approval_id TEXT, synced_at INTEGER)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cb_uniq ON callbacks(user_id, phone, start_ts, kind)`,
  `CREATE INDEX IF NOT EXISTS cb_t ON callbacks(start_ts)`,
  `CREATE TABLE IF NOT EXISTS log_requests (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, purpose TEXT NOT NULL, from_day TEXT, to_day TEXT, status TEXT NOT NULL, requested_at INTEGER, decided_by TEXT, decided_at INTEGER, decision_reason TEXT, expires_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS terms (version INTEGER PRIMARY KEY, body TEXT NOT NULL, created_at INTEGER, created_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS terms_accept (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, version INTEGER NOT NULL, accepted_at INTEGER, device TEXT)`,
  `CREATE TABLE IF NOT EXISTS snapshots (day TEXT PRIMARY KEY, csv TEXT, n INTEGER, created_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS upload_hits (id TEXT PRIMARY KEY, phone TEXT NOT NULL, import_id TEXT, file_name TEXT, result TEXT NOT NULL, at INTEGER, by TEXT)`,
  `CREATE INDEX IF NOT EXISTS upload_hits_phone ON upload_hits(phone)`,
  `CREATE TABLE IF NOT EXISTS import_batches (id TEXT PRIMARY KEY, file_name TEXT, status TEXT NOT NULL, created_at INTEGER, created_by TEXT, finished_at INTEGER, undone_at INTEGER, assign_mode TEXT, assign_user_id TEXT, assign_callers TEXT, sheet TEXT, mapping TEXT, rows_read INTEGER DEFAULT 0, numbers_found INTEGER DEFAULT 0, added INTEGER DEFAULT 0, dup_in_file INTEGER DEFAULT 0, dup_existing INTEGER DEFAULT 0, invalid INTEGER DEFAULT 0, assigned INTEGER DEFAULT 0)`,
];
// columns added after v1.0 (added only when missing, so an existing database upgrades in place and keeps its data)
const NEW_COLS = [['users', 'terms_version', 'INTEGER'], ['users', 'terms_at', 'INTEGER'], ['adjustments', 'akey', 'TEXT'],
  ['contacts', 'cb_count', 'INTEGER DEFAULT 0'], ['contacts', 'cb_last_at', 'INTEGER'], ['contacts', 'cb_last_dur', 'INTEGER'],
  ['contacts', 'import_id', 'TEXT'], ['contacts', 'source', 'TEXT'], ['calls', 'call_pay', 'INTEGER']];

let ready = null;
async function init(db) {
  if (!ready) ready = (async () => {
    await db.batch(SCHEMA.map(q => db.prepare(q)));
    for (const [t, c, d] of NEW_COLS) {
      const cols = (await db.prepare(`PRAGMA table_info(${t})`).all()).results;
      if (!cols.some(x => x.name === c)) await db.prepare(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`).run();
    }
    await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS adj_akey ON adjustments(akey) WHERE akey IS NOT NULL`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS contacts_import ON contacts(import_id)`).run();
    if (!(await db.prepare(`SELECT k FROM settings WHERE k='v13_migrated'`).first())) {
      // v1.3: switch-on moment for the new rules (nothing before it is re-paid or re-computed), callbacks paid from then on,
      // and one 'added' hit per existing number so the upload history starts from the data already here.
      const now = Date.now(); const prev = await db.prepare(`SELECT v FROM settings WHERE k='callback_counts'`).first();
      await db.batch([
        db.prepare(`INSERT OR IGNORE INTO settings (k, v) VALUES ('v13_since', ?)`).bind(String(now)),
        db.prepare(`INSERT OR IGNORE INTO settings (k, v) VALUES ('callback_since', ?)`).bind(String(now)),
        db.prepare(`INSERT INTO settings (k, v) VALUES ('callback_counts', '1') ON CONFLICT(k) DO UPDATE SET v='1'`),
        db.prepare(`INSERT OR IGNORE INTO upload_hits (id, phone, import_id, file_name, result, at, by) SELECT 'bf' || c.id, c.phone, c.import_id, COALESCE(c.batch, ''), 'added', COALESCE(c.created_at, 0), COALESCE((SELECT b.created_by FROM import_batches b WHERE b.id = c.import_id), '') FROM contacts c`),
        db.prepare(`INSERT OR IGNORE INTO settings (k, v) VALUES ('v13_migrated', ?)`).bind(String(now)),
        db.prepare(`INSERT INTO audit (at, user_id, action, detail) VALUES (?, NULL, 'v13_migrate', ?)`).bind(now, JSON.stringify({ callback_counts_before: prev ? prev.v : null, callback_counts_after: 1, v13_since: now }))
      ]);
    }
    await db.prepare(`INSERT OR IGNORE INTO terms (version, body, created_at, created_by) VALUES (1, ?, ?, 'system')`).bind(R.TERMS_V1, Date.UTC(2026, 10, 4, 0, 0, 0) - 330 * 60000).run();
    if (ADMIN_BOOT && ADMIN_BOOT.username) {
      const has = await db.prepare(`SELECT id FROM users WHERE role='admin' LIMIT 1`).first();
      if (!has) await db.prepare(`INSERT INTO users (id, role, username, name, pw, active, created_at) VALUES (?, 'admin', ?, 'Admin', ?, 1, ?)`)
        .bind(uid(), ADMIN_BOOT.username, ADMIN_BOOT.pw, Date.now()).run();
    }
  })().catch(e => { ready = null; throw e; });
  return ready;
}

// ---------- helpers ----------
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
function uid(n = 12) { const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a); }
async function sha256(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function pbkdf2(pw, saltHex, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}
export async function hashPw(pw) { const salt = uid(16); return `pbkdf2-sha256$100000$${salt}$${await pbkdf2(pw, salt, 100000)}`; }
async function checkPw(pw, stored) {
  const [alg, it, salt, h] = String(stored || '').split('$'); if (alg !== 'pbkdf2-sha256') return false;
  const got = await pbkdf2(String(pw), salt, Number(it)); let d = 0; for (let i = 0; i < h.length; i++) d |= h.charCodeAt(i) ^ got.charCodeAt(i);
  return d === 0 && got.length === h.length;
}
class ApiError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const bad = (m) => { throw new ApiError(400, m); };
const json = (o, status = 200, h = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...h } });
const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
const int = (v, d = null) => (v === null || v === undefined || v === '' || !isFinite(Number(v))) ? d : Math.round(Number(v));
async function audit(db, u, action, detail) {
  await db.prepare(`INSERT INTO audit (at, user_id, action, detail) VALUES (?,?,?,?)`).bind(Date.now(), u ? u.id : null, action, typeof detail === 'string' ? detail : JSON.stringify(detail)).run();
}
async function getSettings(db) {
  const rows = (await db.prepare(`SELECT k, v FROM settings`).all()).results; const s = { ...R.DEFAULTS };
  for (const r of rows) if (r.k in s) s[r.k] = Number(r.v);
  return s;
}
async function chunked(arr, n, fn) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(...(await fn(arr.slice(i, i + n)) || [])); return out; }

// ---------- auth ----------
async function authUser(db, req) {
  const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(req.headers.get('authorization') || ''); if (!m) throw new ApiError(401, 'Please log in');
  const th = await sha256(m[1]);
  const s = await db.prepare(`SELECT s.id sid, s.revoked_at, s.revoke_reason, s.last_seen, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).bind(th).first();
  if (!s) throw new ApiError(401, 'Session expired, please log in again');
  if (s.revoked_at) throw new ApiError(401, s.revoke_reason || 'You were logged out', { logged_out: true });
  if (!s.active) throw new ApiError(401, 'Your account is deactivated', { logged_out: true });
  const now = Date.now(); if (now - (s.last_seen || 0) > 60000) await db.prepare(`UPDATE sessions SET last_seen=? WHERE id=?`).bind(now, s.sid).run();
  return { id: s.id, role: s.role, username: s.username, name: s.name, phone: s.phone, sid: s.sid, terms_version: s.terms_version || 0, terms_at: s.terms_at || null };
}
async function revokeUser(db, userId, reason, exceptSid = null) {
  await db.prepare(`UPDATE sessions SET revoked_at=?, revoke_reason=? WHERE user_id=? AND revoked_at IS NULL AND id IS NOT ?`).bind(Date.now(), reason, userId, exceptSid).run();
}

async function login(db, b, req) {
  const login = str(b.login, 80), pw = String(b.password || ''); if (!login || !pw) bad('Enter username/phone and password');
  const k = 'l:' + login.toLowerCase(); const now = Date.now();
  const f = await db.prepare(`SELECT n, first_at FROM login_fail WHERE k=?`).bind(k).first();
  if (f && f.n >= 8 && now - f.first_at < 15 * 60000) throw new ApiError(429, 'Too many wrong attempts. Try again in 15 minutes.');
  const phone = R.normPhone(login);
  const u = await db.prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE OR (phone != '' AND phone = ?) LIMIT 1`).bind(login, phone || '#').first();
  if (!u || !(await checkPw(pw, u.pw))) {
    if (!f || now - f.first_at >= 15 * 60000) await db.prepare(`INSERT OR REPLACE INTO login_fail (k, n, first_at) VALUES (?, 1, ?)`).bind(k, now).run();
    else await db.prepare(`UPDATE login_fail SET n = n + 1 WHERE k=?`).bind(k).run();
    throw new ApiError(401, 'Wrong username/phone or password');
  }
  if (!u.active) throw new ApiError(403, 'Your account is deactivated. Contact the admin.');
  await db.prepare(`DELETE FROM login_fail WHERE k=?`).bind(k).run();
  const token = uid(32); const sid = uid(8);
  await db.prepare(`INSERT INTO sessions (id, token_hash, user_id, app, device, ip, created_at, last_seen) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(sid, await sha256(token), u.id, str(b.app, 20) || 'web', str(b.device, 120) || (req.headers.get('user-agent') || '').slice(0, 120), req.headers.get('cf-connecting-ip') || '', now, now).run();
  await audit(db, u, 'login', { app: str(b.app, 20) || 'web' });
  return { token, user: { id: u.id, role: u.role, username: u.username, name: u.name, phone: u.phone } };
}

// ---------- counting ----------
const CALL_COLS = `id, user_id, contact_id, phone, log_phone, tapped_at, start_ts, duration, log_found, assigned_ok, outcome, elig_reason, counted, reason, lead_counted, lead_reason, override, lead_override, approval_id, call_pay`;
async function recomputeFor(db, synced, s) {
  if (!synced.length) return;
  const updates = []; const phones = new Set(synced.map(c => c.phone).filter(Boolean));
  // stage 1+2: eligibility for each affected caller around the synced calls (same-time calls need neighbours)
  const byUser = new Map(); for (const c of synced) { const t = c.start_ts || c.tapped_at || Date.now(); const w = byUser.get(c.user_id) || [Infinity, -Infinity]; byUser.set(c.user_id, [Math.min(w[0], t), Math.max(w[1], t)]); }
  for (const [userId, [a, b]] of byUser) {
    const rows = (await db.prepare(`SELECT ${CALL_COLS} FROM calls WHERE user_id=? AND COALESCE(start_ts, tapped_at) BETWEEN ? AND ?`).bind(userId, a - 6 * 3600000, b + 6 * 3600000).all()).results;
    const ov = R.overlapIds(rows);
    for (const c of rows) {
      if (c.approval_id) continue;
      const er = R.baseReason(c, s) || (ov.has(c.id) ? 'overlap' : null);
      if (er !== c.elig_reason) { updates.push(db.prepare(`UPDATE calls SET elig_reason=? WHERE id=?`).bind(er, c.id)); phones.add(c.phone); }
    }
  }
  if (updates.length) await chunked(updates, 80, x => db.batch(x).then(() => []));
  await rechainPhones(db, [...phones], s);
}
async function rechainPhones(db, phones, s) {
  const updates = [];
  await chunked(phones.filter(Boolean), 40, async ps => {
    const rows = (await db.prepare(`SELECT ${CALL_COLS} FROM calls WHERE phone IN (${ps.map(() => '?').join(',')})`).bind(...ps).all()).results;
    const byP = new Map(); for (const c of rows) (byP.get(c.phone) || byP.set(c.phone, []).get(c.phone)).push(c);
    for (const list of byP.values()) {
      const input = list.map(c => c.approval_id ? { ...c, override: c.counted ? 1 : 0, lead_override: c.lead_counted ? c.lead_override : 0 } : c);
      const res = R.chainNumber(input, s);
      for (const c of list) {
        if (c.approval_id) continue; const r = res.get(c.id);
        const pay = r.call_pay ? 1 : 0;
        if ((r.counted ? 1 : 0) !== c.counted || r.reason !== c.reason || (r.lead_counted ? 1 : 0) !== c.lead_counted || r.lead_reason !== c.lead_reason || pay !== (c.call_pay == null ? (c.counted ? 1 : 0) : c.call_pay))
          updates.push(db.prepare(`UPDATE calls SET counted=?, reason=?, lead_counted=?, lead_reason=?, call_pay=? WHERE id=?`).bind(r.counted ? 1 : 0, r.reason, r.lead_counted ? 1 : 0, r.lead_reason, pay, c.id));
      }
    }
  });
  if (updates.length) await chunked(updates, 80, x => db.batch(x).then(() => []));
}
async function recalcAll(db) {
  const s = await getSettings(db);
  const rows = (await db.prepare(`SELECT ${CALL_COLS} FROM calls`).all()).results;
  const updates = [];
  const byUser = new Map(); for (const c of rows) (byUser.get(c.user_id) || byUser.set(c.user_id, []).get(c.user_id)).push(c);
  for (const list of byUser.values()) { const ov = R.overlapIds(list); for (const c of list) { if (c.approval_id) continue; const er = R.baseReason(c, s) || (ov.has(c.id) ? 'overlap' : null); if (er !== c.elig_reason) { c.elig_reason = er; updates.push(db.prepare(`UPDATE calls SET elig_reason=? WHERE id=?`).bind(er, c.id)); } } }
  if (updates.length) await chunked(updates, 80, x => db.batch(x).then(() => []));
  await rechainPhones(db, [...new Set(rows.map(c => c.phone))], s);
  return rows.length;
}

// ---------- reads ----------
function rangeFrom(b, s) {
  const today = R.dayKey(Date.now(), s.tz_offset_min);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(b.from || '') ? b.from : today; const to = /^\d{4}-\d{2}-\d{2}$/.test(b.to || '') ? b.to : from;
  return { from, to, a: R.dayStart(from, s.tz_offset_min), z: R.dayStart(to, s.tz_offset_min) + 86400000 };
}
async function callsIn(db, a, z, userId) {
  const q = `SELECT c.*, k.name contact_name, k.area contact_area FROM calls c LEFT JOIN contacts k ON k.id = c.contact_id WHERE COALESCE(c.start_ts, c.tapped_at) >= ? AND COALESCE(c.start_ts, c.tapped_at) < ?` + (userId ? ` AND c.user_id = ?` : '') + ` ORDER BY COALESCE(c.start_ts, c.tapped_at) DESC`;
  const st = db.prepare(q); return (await (userId ? st.bind(a, z, userId) : st.bind(a, z)).all()).results;
}
async function adjIn(db, from, to, userId) {
  const q = `SELECT * FROM adjustments WHERE day >= ? AND day <= ?` + (userId ? ` AND user_id=?` : '') + ` ORDER BY day`;
  const st = db.prepare(q); return (await (userId ? st.bind(from, to, userId) : st.bind(from, to)).all()).results;
}
function decorate(c) { return { ...c, reason_text: R.REASON_TEXT[c.reason] || c.reason || '', outcome_label: R.OUTCOME_LABEL[c.outcome] || '' }; }
async function cbIn(db, a, z, userId) {
  const q = `SELECT b.*, k.name contact_name FROM callbacks b LEFT JOIN contacts k ON k.id = b.contact_id WHERE b.start_ts >= ? AND b.start_ts < ?` + (userId ? ` AND b.user_id = ?` : '') + ` ORDER BY b.start_ts DESC`;
  const st = db.prepare(q); return (await (userId ? st.bind(a, z, userId) : st.bind(a, z)).all()).results;
}
async function perCaller(db, s, from, to, onlyUser, noFlags) {
  const a = R.dayStart(from, s.tz_offset_min), z = R.dayStart(to, s.tz_offset_min) + 86400000;
  const users = (await db.prepare(`SELECT id, name, username, phone, active FROM users WHERE role='caller' ORDER BY name`).all()).results.filter(u => !onlyUser || u.id === onlyUser);
  const calls = await callsIn(db, a, z, onlyUser); const adj = await adjIn(db, from, to, onlyUser); const cbs = await cbIn(db, a, z, onlyUser);
  return users.filter(u => u.active || calls.some(c => c.user_id === u.id) || adj.some(x => x.user_id === u.id)).map(u => {
    const mine = calls.filter(c => c.user_id === u.id); const t = R.totals(mine, adj.filter(x => x.user_id === u.id), cbs.filter(x => x.user_id === u.id));
    const flags = [];
    if (!noFlags) { const days = {}; for (const c of mine) (days[R.dayKey(c.start_ts || c.tapped_at, s.tz_offset_min)] ||= []).push(c); for (const [d, list] of Object.entries(days)) for (const f of R.dayFlags(list, s)) flags.push(`${d}: ${f}`); }
    return { user: u, ...t, flags };
  });
}

// ---------- v1.1 helpers ----------
const IST = { timeZone: 'Asia/Kolkata' };
const fmtDate = ts => ts ? new Date(Number(ts) + 330 * 60000).toISOString().slice(0, 10) : '';
const fmtTime = ts => ts ? new Date(Number(ts) + 330 * 60000).toISOString().slice(11, 16) : '';
const r2 = n => Math.round(n * 100) / 100;
async function currentTerms(db) { return await db.prepare(`SELECT version, body, created_at FROM terms ORDER BY version DESC LIMIT 1`).first(); }
async function payRow(db, userId) { return await db.prepare(`SELECT * FROM payment_details WHERE user_id=?`).bind(userId).first(); }
const hasDetails = p => !!(p && (p.upi || (p.holder && p.account_no && p.ifsc && p.bank)));
async function walletFor(db, s, userId, withEarned = true) {
  const ap = await db.prepare(`SELECT COALESCE(SUM(payout),0) a, COALESCE(SUM(CASE WHEN paid=1 THEN payout END),0) p FROM approvals WHERE user_id=?`).bind(userId).first();
  const wd = (await db.prepare(`SELECT status, COALESCE(SUM(amount),0) amount FROM withdrawals WHERE user_id=? GROUP BY status`).bind(userId).all()).results;
  let earned = ap.a;
  if (withEarned) { const today = R.dayKey(Date.now(), s.tz_offset_min); const [t] = await perCaller(db, s, '2000-01-01', today, userId, true); earned = t ? t.payout : 0; }
  return R.walletCalc({ earned, approved: ap.a, paidOffline: ap.p, withdrawals: wd });
}
async function dayCountsFor(db, s, userId) {
  const rows = (await db.prepare(`SELECT COALESCE(start_ts, tapped_at) t FROM calls WHERE user_id=? AND counted=1`).bind(userId).all()).results;
  const m = {}; for (const r of rows) { if (!r.t) continue; const d = R.dayKey(r.t, s.tz_offset_min); m[d] = (m[d] || 0) + 1; } return m;
}
/** Streak bonuses are ordinary adjustments (so the approve/payout flow stays one path); one per run + milestone, never twice, never back-dated. */
async function awardFor(db, s, userId, counts) {
  if (!(s.streak_bonus_7 > 0 || s.streak_bonus_30 > 0)) return 0;
  counts = counts || await dayCountsFor(db, s, userId); let n = 0;
  for (const m of R.streakMilestones(counts, s.daily_target)) {
    const amt = m.milestone === 7 ? s.streak_bonus_7 : s.streak_bonus_30; if (!(amt > 0)) continue;
    if (Number(m.day.replaceAll('-', '')) < (s.streak_bonus_since || 0)) continue;
    const r = await db.prepare(`INSERT OR IGNORE INTO adjustments (id, user_id, day, amount, reason, created_by, created_at, akey) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(uid(), userId, m.day, amt, `Streak bonus: ${m.milestone}-day streak`, 'system', Date.now(), `sb${m.milestone}:${userId}:${m.run_start}`).run();
    n += (r.meta && r.meta.changes) || 0;
  }
  return n;
}
async function streakFor(db, s, userId) {
  const counts = await dayCountsFor(db, s, userId); const today = R.dayKey(Date.now(), s.tz_offset_min);
  await awardFor(db, s, userId, counts);
  return { ...R.streakCalc(counts, s.daily_target, today), bonus_7: s.streak_bonus_7, bonus_30: s.streak_bonus_30 };
}
async function recountCallbacks(db, s, phones) {
  const q = `SELECT id, phone, start_ts, duration, kind, counted, reason, approval_id FROM callbacks` + (phones ? ` WHERE phone IN (${phones.map(() => '?').join(',')})` : '');
  if (phones && !phones.length) return;
  const rows = (await (phones ? db.prepare(q).bind(...phones) : db.prepare(q)).all()).results; const res = R.callbackCounting(rows, s); const ups = [];
  for (const b of rows) { if (b.approval_id) continue; const r = res.get(b.id); if (!r) continue; if ((r.counted ? 1 : 0) !== b.counted || r.reason !== b.reason) ups.push(db.prepare(`UPDATE callbacks SET counted=?, reason=? WHERE id=?`).bind(r.counted ? 1 : 0, r.reason, b.id)); }
  if (ups.length) await chunked(ups, 80, x => db.batch(x).then(() => []));
}
const callRow = (c, names) => ['Call', fmtDate(c.start_ts || c.tapped_at), fmtTime(c.start_ts || c.tapped_at), names[c.user_id] || '', c.contact_name || '', c.phone || '', c.log_found ? c.duration : '', c.log_found && c.duration > 0 ? 'Yes' : 'No', c.counted ? 'Yes' : 'No',
  (R.REASON_TEXT[c.reason] || c.reason || '') + (c.override_reason ? ' — ' + c.override_reason : ''), R.OUTCOME_LABEL[c.outcome] || '', c.outcome === 'interested' ? (c.lead_counted ? 'Yes' : 'No: ' + (c.lead_reason || '')) : '', c.callback_at ? fmtDate(c.callback_at) + ' ' + fmtTime(c.callback_at) : '', c.note || '', '', ''];
const cbRow = (b, names) => ['Callback', fmtDate(b.start_ts), fmtTime(b.start_ts), names[b.user_id] || '', b.contact_name || '', b.phone || '', b.duration, b.kind === 'incoming' ? 'Yes' : 'No', b.counted ? 'Yes' : 'No', b.reason || '', '', '', '', '',
  (b.kind === 'incoming' ? 'Callback received' : 'Callback missed') + (b.returned_at ? ' (returned by caller)' : ''), b.counted ? 'Yes' : 'No'];
/** Rows for the admin log files (all callers, or one caller): app calls + callback events. */
async function buildLogRows(db, s, from, to, userId, cap = 60000) {
  const a = R.dayStart(from, s.tz_offset_min), z = R.dayStart(to, s.tz_offset_min) + 86400000;
  const names = Object.fromEntries((await db.prepare(`SELECT id, name FROM users`).all()).results.map(x => [x.id, x.name]));
  const calls = await callsIn(db, a, z, userId || null); const cbs = await cbIn(db, a, z, userId || null);
  const all = [...calls.map(c => ({ t: c.start_ts || c.tapped_at || 0, r: callRow(c, names) })), ...cbs.map(b => ({ t: b.start_ts, r: cbRow(b, names) }))].sort((x, y) => x.t - y.t);
  return { rows: all.slice(0, cap).map(x => x.r), total: all.length, truncated: all.length > cap };
}
let snapChecked = null;
/** Daily file snapshot: there is no scheduler on this host, so the first request after midnight (IST) writes every missing past day. */
async function ensureSnapshots(db) {
  if (snapChecked === R.dayKey(Date.now(), R.DEFAULTS.tz_offset_min)) return;
  const s = await getSettings(db); const today = R.dayKey(Date.now(), s.tz_offset_min); snapChecked = today;
  const num = k => Number(k.replaceAll('-', '')); const key = n => `${String(n).slice(0, 4)}-${String(n).slice(4, 6)}-${String(n).slice(6, 8)}`;
  let from;
  if (s.snap_through > 0) from = R.dayKey(R.dayStart(key(s.snap_through), 0) + 86400000 + 3600000, 0);
  else { const m = await db.prepare(`SELECT MIN(COALESCE(start_ts, tapped_at)) t FROM calls`).first(); const m2 = await db.prepare(`SELECT MIN(start_ts) t FROM callbacks`).first(); const t = Math.min(m && m.t || Infinity, m2 && m2.t || Infinity); if (!isFinite(t)) return; from = R.dayKey(t, s.tz_offset_min); }
  const yesterday = R.dayKey(R.dayStart(today, s.tz_offset_min) - 3600000, s.tz_offset_min); let d = from, n = 0, last = null;
  while (num(d) <= num(yesterday) && n++ < 45) {
    const { rows } = await buildLogRows(db, s, d, d);
    if (rows.length) { let csv = R.toCsv(R.LOG_COLS, rows); if (csv.length > 1800000) csv = ''; await db.prepare(`INSERT OR REPLACE INTO snapshots (day, csv, n, created_at) VALUES (?,?,?,?)`).bind(d, csv, rows.length, Date.now()).run(); }
    last = d; d = R.dayKey(R.dayStart(d, 0) + 86400000 + 3600000, 0);
  }
  if (last) await db.prepare(`INSERT OR REPLACE INTO settings (k, v) VALUES ('snap_through', ?)`).bind(String(num(last))).run();
}

// ---------- API methods ----------
const M = {};
M.me = async (db, u) => { const t = await currentTerms(db); const { sid, terms_version, terms_at, ...user } = u; return { user, settings: await getSettings(db), version: VERSION, terms: { version: t.version, accepted: terms_version === t.version, accepted_version: terms_version, accepted_at: terms_at } }; };
M.logout = async (db, u) => { await db.prepare(`UPDATE sessions SET revoked_at=?, revoke_reason='Logged out' WHERE id=?`).bind(Date.now(), u.sid).run(); return {}; };
M.change_password = async (db, u, b) => {
  const row = await db.prepare(`SELECT pw FROM users WHERE id=?`).bind(u.id).first();
  if (!(await checkPw(String(b.old || ''), row.pw))) bad('Current password is wrong');
  if (String(b.new || '').length < 8) bad('New password must be at least 8 characters');
  await db.prepare(`UPDATE users SET pw=?, updated_at=? WHERE id=?`).bind(await hashPw(String(b.new)), Date.now(), u.id).run();
  await revokeUser(db, u.id, 'Password changed — please log in again', u.sid); await audit(db, u, 'change_password', ''); return {};
};

// caller
M.my_list = async (db, u) => {
  const s = await getSettings(db);
  const rows = (await db.prepare(`SELECT id, phone, name, area, notes, status, last_call_at, last_note, callback_at, cb_count, cb_last_at, cb_last_dur FROM contacts WHERE assigned_to=? ORDER BY CASE WHEN status='callback' THEN 0 WHEN status='new' THEN 1 ELSE 2 END, COALESCE(callback_at, 0), name LIMIT 5000`).bind(u.id).all()).results;
  return { contacts: rows, settings: { min_duration: s.min_duration, repeat_hours: s.repeat_hours, call_rate: s.call_rate, lead_rate: s.lead_rate, tz_offset_min: s.tz_offset_min, retention_days: s.retention_days, daily_target: s.daily_target, min_withdrawal: s.min_withdrawal, withdraw_hours: s.withdraw_hours, callback_counts: s.callback_counts, streak_bonus_7: s.streak_bonus_7, streak_bonus_30: s.streak_bonus_30 } };
};
M.sync = async (db, u, b) => {
  if (u.role !== 'caller') bad('Only caller accounts sync calls');
  const s = await getSettings(db); const list = Array.isArray(b.calls) ? b.calls.slice(0, 300) : []; const now = Date.now();
  const done = []; const synced = []; const stmts = [];
  for (const x of list) {
    const id = str(x.id, 40); if (!/^[A-Za-z0-9_-]{8,40}$/.test(id)) continue;
    const ex = await db.prepare(`SELECT id, user_id, approval_id, phone FROM calls WHERE id=?`).bind(id).first();
    if (ex && ex.user_id !== u.id) continue;
    const outcome = R.OUTCOMES.includes(x.outcome) ? x.outcome : null; const cb = outcome === 'callback' ? int(x.callback_at) : null; const note = str(x.note, 500);
    if (ex) {           // already have the call — only the outcome / note can change after the fact
      if (!ex.approval_id) stmts.push(db.prepare(`UPDATE calls SET outcome=COALESCE(?, outcome), callback_at=COALESCE(?, callback_at), note=CASE WHEN ?='' THEN note ELSE ? END, log_found=MAX(log_found, ?), start_ts=COALESCE(start_ts, ?), duration=MAX(duration, ?), log_phone=COALESCE(log_phone, ?) WHERE id=?`)
        .bind(outcome, cb, note, note, x.log_found ? 1 : 0, int(x.start_ts), Math.max(0, int(x.duration, 0)), str(x.log_phone, 20) || null, id));
    } else {
      const contact = x.contact_id ? await db.prepare(`SELECT id, phone, assigned_to FROM contacts WHERE id=?`).bind(str(x.contact_id, 40)).first() : null;
      const phone = contact ? contact.phone : R.normPhone(x.phone);
      const assigned = contact && contact.assigned_to === u.id ? 1 : 0;
      stmts.push(db.prepare(`INSERT INTO calls (id, user_id, contact_id, phone, log_phone, tapped_at, start_ts, duration, log_found, log_type, assigned_ok, outcome, callback_at, note, device, synced_at, call_rate, lead_rate) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, u.id, contact ? contact.id : null, phone, R.normPhone(x.log_phone) || null, int(x.tapped_at), int(x.start_ts), Math.max(0, int(x.duration, 0)), x.log_found ? 1 : 0, str(x.log_type, 20) || null, assigned, outcome, cb, note, str(x.device, 120), now, s.call_rate, s.lead_rate));
    }
    if (outcome && x.contact_id) stmts.push(db.prepare(`UPDATE contacts SET status=?, last_call_at=?, last_note=CASE WHEN ?='' THEN last_note ELSE ? END, callback_at=?, lead_state=CASE WHEN ?='interested' AND lead_state IS NULL THEN 'open' ELSE lead_state END WHERE id=? AND assigned_to=?`)
      .bind(outcome, int(x.start_ts) || int(x.tapped_at) || now, note, note, cb, outcome, str(x.contact_id, 40), u.id));
    synced.push({ id, user_id: u.id, phone: ex ? ex.phone : null, start_ts: int(x.start_ts), tapped_at: int(x.tapped_at) }); done.push(id);
  }
  if (stmts.length) await chunked(stmts, 60, z => db.batch(z).then(() => []));
  if (synced.length) {
    const rows = await chunked(done, 50, ids => db.prepare(`SELECT id, user_id, phone, start_ts, tapped_at FROM calls WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all().then(r => r.results));
    await recomputeFor(db, rows, s);
    await awardFor(db, s, u.id);
  }
  const res = done.length ? await chunked(done, 50, ids => db.prepare(`SELECT id, counted, reason, lead_counted, lead_reason FROM calls WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all().then(r => r.results)) : [];
  return { synced: done, results: res.map(decorate) };
};
M.my_stats = async (db, u, b) => {
  const s = await getSettings(db); const today = R.dayKey(Date.now(), s.tz_offset_min); const month = today.slice(0, 8) + '01';
  const [t] = await perCaller(db, s, today, today, u.id); const [m] = await perCaller(db, s, month, today, u.id);
  const a = R.retentionCutoff(Date.now(), s.retention_days); const recent = (await callsIn(db, a, Date.now() + 86400000, u.id)).slice(0, 100).map(decorate);   // older call details are only visible through an approved log request
  return { today: t, month: m, recent, retention_days: s.retention_days, settings: { min_duration: s.min_duration, call_rate: s.call_rate, lead_rate: s.lead_rate, repeat_hours: s.repeat_hours, retention_days: s.retention_days } };
};

// admin
const A = {};
A.settings_get = async (db) => ({ settings: await getSettings(db) });
A.settings_save = async (db, u, b) => {
  const old = await getSettings(db); const nw = { ...old };
  const lim = { call_rate: [0, 10000], lead_rate: [0, 100000], min_duration: [0, 3600], repeat_hours: [0, 24 * 30], min_withdrawal: [0, 1000000], retention_days: [1, 365], daily_target: [1, 1000], streak_bonus_7: [0, 100000], streak_bonus_30: [0, 100000], callback_counts: [0, 1], callback_window_days: [1, 365], withdraw_hours: [1, 168], log_access_hours: [1, 720] };
  const dec = k => k.endsWith('rate') || k === 'min_withdrawal' || k.startsWith('streak_bonus_');
  for (const k of Object.keys(lim)) if (b[k] !== undefined && b[k] !== '') { const v = Number(b[k]); if (!isFinite(v) || v < lim[k][0] || v > lim[k][1]) bad(`Invalid value for ${k}`); nw[k] = dec(k) ? Math.round(v * 100) / 100 : Math.round(v); }
  if ((nw.streak_bonus_7 > 0 || nw.streak_bonus_30 > 0) && (!old.streak_bonus_since || !(old.streak_bonus_7 > 0 || old.streak_bonus_30 > 0))) { nw.streak_bonus_since = Number(R.dayKey(Date.now(), old.tz_offset_min).replaceAll('-', '')); lim.streak_bonus_since = [0, 99999999]; }
  await db.batch(Object.keys(lim).map(k => db.prepare(`INSERT OR REPLACE INTO settings (k, v) VALUES (?, ?)`).bind(k, String(nw[k]))));
  let rated = 0;
  if (b.apply_rates_to_unapproved && (nw.call_rate !== old.call_rate || nw.lead_rate !== old.lead_rate || b.force_rates)) {
    const r = await db.prepare(`UPDATE calls SET call_rate=?, lead_rate=? WHERE approval_id IS NULL`).bind(nw.call_rate, nw.lead_rate).run(); rated = r.meta && r.meta.changes || 0;
    await db.prepare(`UPDATE callbacks SET rate=? WHERE approval_id IS NULL`).bind(nw.call_rate).run();
  }
  let recalculated = 0; if (nw.min_duration !== old.min_duration || nw.repeat_hours !== old.repeat_hours) recalculated = await recalcAll(db);
  if (['callback_counts', 'min_duration', 'repeat_hours'].some(k => nw[k] !== old[k])) await recountCallbacks(db, nw, null);
  await audit(db, u, 'settings_save', { old, new: nw, apply_rates_to_unapproved: !!b.apply_rates_to_unapproved });
  return { settings: nw, recalculated, rated };
};
A.callers_list = async (db) => {
  const users = (await db.prepare(`SELECT u.id, u.name, u.username, u.phone, u.active, u.created_at, (SELECT COUNT(*) FROM contacts c WHERE c.assigned_to=u.id) assigned, (SELECT COUNT(*) FROM sessions s WHERE s.user_id=u.id AND s.revoked_at IS NULL) sessions, u.terms_version, u.terms_at, (SELECT COUNT(*) FROM payment_details p WHERE p.user_id=u.id AND (p.upi != '' OR p.account_no != '')) has_payment FROM users u WHERE u.role='caller' ORDER BY u.name`).all()).results;
  return { callers: users };
};
A.caller_save = async (db, u, b) => {
  const name = str(b.name, 80), username = str(b.username, 40).toLowerCase(), phone = b.phone ? R.normPhone(b.phone) : '';
  if (!name) bad('Enter the caller\'s name'); if (!/^[a-z0-9._-]{3,40}$/.test(username)) bad('Username: 3–40 letters/digits (no spaces)');
  if (b.phone && !phone) bad('Phone must be a 10-digit mobile number');
  const dup = await db.prepare(`SELECT id FROM users WHERE (username=? COLLATE NOCASE OR (phone != '' AND phone=?)) AND id IS NOT ?`).bind(username, phone || '#', b.id || null).first();
  if (dup) bad('Another account already uses this username or phone');
  const now = Date.now();
  if (b.id) {
    const ex = await db.prepare(`SELECT * FROM users WHERE id=? AND role='caller'`).bind(b.id).first(); if (!ex) bad('Caller not found');
    const active = b.active === undefined ? ex.active : (b.active ? 1 : 0);
    await db.prepare(`UPDATE users SET name=?, username=?, phone=?, active=?, updated_at=? WHERE id=?`).bind(name, username, phone, active, now, b.id).run();
    if (b.password) { if (String(b.password).length < 6) bad('Password must be at least 6 characters'); await db.prepare(`UPDATE users SET pw=? WHERE id=?`).bind(await hashPw(String(b.password)), b.id).run(); await revokeUser(db, b.id, 'Your password was reset by the admin'); }
    if (!active && ex.active) await revokeUser(db, b.id, 'Your account was deactivated by the admin');
    await audit(db, u, 'caller_update', { id: b.id, username, active, password_reset: !!b.password }); return { id: b.id };
  }
  if (String(b.password || '').length < 6) bad('Password must be at least 6 characters');
  const id = uid(); await db.prepare(`INSERT INTO users (id, role, username, phone, name, pw, active, created_at) VALUES (?, 'caller', ?, ?, ?, ?, 1, ?)`).bind(id, username, phone, name, await hashPw(String(b.password)), now).run();
  await audit(db, u, 'caller_add', { id, username }); return { id };
};
A.caller_delete = async (db, u, b) => {
  const ex = await db.prepare(`SELECT id, username FROM users WHERE id=? AND role='caller'`).bind(str(b.id, 40)).first(); if (!ex) bad('Caller not found');
  const n = await db.prepare(`SELECT COUNT(*) n FROM calls WHERE user_id=?`).bind(ex.id).first();
  await revokeUser(db, ex.id, 'Your account was removed by the admin');
  await db.prepare(`DELETE FROM payment_details WHERE user_id=?`).bind(ex.id).run();
  await db.prepare(`UPDATE contacts SET assigned_to=NULL WHERE assigned_to=?`).bind(ex.id).run();
  if (n.n > 0) { await db.prepare(`UPDATE users SET active=0, username=username || '.removed.' || ?, name=name || ' (removed)', phone='' WHERE id=?`).bind(uid(3), ex.id).run(); }
  else { for (const t of ['terms_accept', 'log_requests', 'withdrawals', 'callbacks']) await db.prepare(`DELETE FROM ${t} WHERE user_id=?`).bind(ex.id).run(); await db.prepare(`DELETE FROM users WHERE id=?`).bind(ex.id).run(); }
  await audit(db, u, 'caller_remove', { id: ex.id, username: ex.username, kept_history: n.n > 0 }); return { removed: true, kept_history: n.n > 0 };
};
A.sessions_list = async (db, u, b) => {
  const q = `SELECT s.id, s.user_id, s.app, s.device, s.ip, s.created_at, s.last_seen, u.name, u.username, u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.revoked_at IS NULL` + (b.user_id ? ` AND s.user_id=?` : '') + ` ORDER BY s.last_seen DESC LIMIT 500`;
  const st = db.prepare(q); return { sessions: (await (b.user_id ? st.bind(b.user_id) : st).all()).results.map(x => ({ ...x, current: x.id === u.sid })) };
};
A.session_revoke = async (db, u, b) => {
  if (b.user_id) { await revokeUser(db, str(b.user_id, 40), 'You were logged out by the admin', u.sid); await audit(db, u, 'logout_all', { user_id: b.user_id }); return {}; }
  await db.prepare(`UPDATE sessions SET revoked_at=?, revoke_reason='You were logged out by the admin' WHERE id=? AND id != ?`).bind(Date.now(), str(b.id, 40), u.sid).run();
  await audit(db, u, 'logout_device', { id: b.id }); return {};
};
A.contacts_import = async (db, u, b) => {
  const rows = Array.isArray(b.rows) ? b.rows.slice(0, 20000) : []; if (!rows.length) bad('The file has no rows');
  const existing = new Set((await db.prepare(`SELECT phone FROM contacts`).all()).results.map(r => r.phone));
  const { contacts, report } = R.cleanRows(rows, existing); const now = Date.now(); const batch = str(b.batch, 80) || ('Upload ' + new Date(now).toISOString().slice(0, 16).replace('T', ' '));
  let callerIds = []; if (b.assign === 'rr') callerIds = (await db.prepare(`SELECT id FROM users WHERE role='caller' AND active=1 ORDER BY name`).all()).results.map(r => r.id).filter(id => !b.caller_ids || b.caller_ids.includes(id));
  if (b.assign === 'rr' && !callerIds.length) bad('No active callers to share the numbers between — add a caller first');
  if (b.assign === 'user' && !(await db.prepare(`SELECT id FROM users WHERE id=? AND role='caller'`).bind(str(b.user_id, 40)).first())) bad('Choose a caller');
  const ids = contacts.map(() => uid()); const owner = new Map();
  if (b.assign === 'rr') for (const [cid, list] of R.roundRobin(ids, callerIds)) for (const x of list) owner.set(x, cid);
  if (b.assign === 'user') for (const x of ids) owner.set(x, b.user_id);
  const st = contacts.map((c, i) => db.prepare(`INSERT OR IGNORE INTO contacts (id, phone, name, area, notes, assigned_to, assigned_at, status, batch, created_at) VALUES (?,?,?,?,?,?,?, 'new', ?, ?)`).bind(ids[i], c.phone, c.name, c.area, c.notes, owner.get(ids[i]) || null, owner.get(ids[i]) ? now : null, batch, now));
  await chunked(st, 80, x => db.batch(x).then(() => []));
  report.assigned = owner.size; await audit(db, u, 'contacts_import', { batch, ...report, invalid_rows: undefined }); return { report };
};
// ---- v1.2: upload preview, import batches and undo ----
const MOBILE_RE = /^[6-9]\d{9}$/;
const mobileOf = raw => { let d = String(raw == null ? '' : raw).replace(/\D/g, ''); if (d.length === 12 && d.startsWith('91')) d = d.slice(2); else if (d.length === 11 && d.startsWith('0')) d = d.slice(1); return MOBILE_RE.test(d) ? d : ''; };
async function importSummary(db, id) {
  const b = await db.prepare(`SELECT * FROM import_batches WHERE id=?`).bind(id).first(); if (!b) return null;
  const n = await db.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN c.status!='new' OR c.last_call_at IS NOT NULL OR c.lead_state IS NOT NULL OR c.followup_at IS NOT NULL OR c.callback_at IS NOT NULL OR COALESCE(c.cb_count,0)>0 OR EXISTS(SELECT 1 FROM calls x WHERE x.contact_id=c.id) OR EXISTS(SELECT 1 FROM callbacks y WHERE y.contact_id=c.id) THEN 1 ELSE 0 END) called FROM contacts c WHERE c.import_id=?`).bind(id).first();
  const called = n.called || 0;
  return { ...b, still_here: n.n || 0, called, can_undo: b.status !== 'undone' && called === 0 };
}
A.import_start = async (db, u, b) => {
  const assign = ['none', 'rr', 'user'].includes(b.assign) ? b.assign : 'none';
  let callerIds = [];
  if (assign === 'rr') {
    callerIds = (await db.prepare(`SELECT id FROM users WHERE role='caller' AND active=1 ORDER BY name`).all()).results.map(r => r.id)
      .filter(id => !Array.isArray(b.caller_ids) || !b.caller_ids.length || b.caller_ids.includes(id));
    if (!callerIds.length) bad('No active callers to share the numbers between — add a caller first');
  }
  if (assign === 'user' && !(await db.prepare(`SELECT id FROM users WHERE id=? AND role='caller'`).bind(str(b.user_id, 40)).first())) bad('Choose a caller');
  const id = uid(); const now = Date.now();
  await db.prepare(`INSERT INTO import_batches (id, file_name, status, created_at, created_by, assign_mode, assign_user_id, assign_callers, sheet, mapping, rows_read, numbers_found, invalid, dup_in_file, added, dup_existing, assigned) VALUES (?, ?, 'importing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`)
    .bind(id, str(b.file_name, 160) || 'upload', now, str(u.name || u.username, 80), assign, assign === 'user' ? str(b.user_id, 40) : null, assign === 'rr' ? JSON.stringify(callerIds) : null,
      str(b.sheet, 60), str(b.mapping, 400), int(b.rows_read, 0), int(b.numbers_found, 0), int(b.invalid, 0), int(b.dup_in_file, 0)).run();
  await audit(db, u, 'import_start', { import_id: id, file_name: str(b.file_name, 160), assign, callers: callerIds.length });
  return { import_id: id, callers: callerIds.length };
};
A.import_chunk = async (db, u, b) => {
  const batch = await db.prepare(`SELECT * FROM import_batches WHERE id=?`).bind(str(b.import_id, 40)).first();
  if (!batch) bad('Upload not found'); if (batch.status !== 'importing') bad('This upload is already finished');
  const rows = Array.isArray(b.rows) ? b.rows.slice(0, 2000) : [];
  const existing = new Set((await db.prepare(`SELECT phone FROM contacts`).all()).results.map(r => r.phone));
  const callerIds = batch.assign_mode === 'rr' ? JSON.parse(batch.assign_callers || '[]') : [];
  const now = Date.now(); let added = 0, dupEx = 0, inv = 0, assigned = 0; const st = []; let idx = batch.added || 0; const inThisFile = new Set();
  for (const x of rows) {
    const phone = mobileOf(x && x.phone);
    if (!phone) { inv++; continue; }
    if (existing.has(phone)) { dupEx++; st.push(db.prepare(`INSERT INTO upload_hits (id, phone, import_id, file_name, result, at, by) VALUES (?,?,?,?,?,?,?)`).bind(uid(), phone, batch.id, str(batch.file_name, 80), inThisFile.has(phone) ? 'dup_in_upload' : 'dup_existing', now, str(batch.created_by, 80))); continue; }
    existing.add(phone); inThisFile.add(phone);
    st.push(db.prepare(`INSERT INTO upload_hits (id, phone, import_id, file_name, result, at, by) VALUES (?,?,?,?,?,?,?)`).bind(uid(), phone, batch.id, str(batch.file_name, 80), 'added', now, str(batch.created_by, 80)));
    const owner = batch.assign_mode === 'rr' ? (callerIds[idx % callerIds.length] || null) : batch.assign_mode === 'user' ? batch.assign_user_id : null;
    idx++; added++; if (owner) assigned++;
    st.push(db.prepare(`INSERT OR IGNORE INTO contacts (id, phone, name, area, notes, source, assigned_to, assigned_at, status, batch, import_id, created_at) VALUES (?,?,?,?,?,?,?,?, 'new', ?, ?, ?)`)
      .bind(uid(), phone, str(x.name, 120), str(x.area, 120), str(x.notes, 500), str(x.source, 120), owner, owner ? now : null, str(batch.file_name, 80), batch.id, now));
  }
  await chunked(st, 80, x => db.batch(x).then(() => []));
  await db.prepare(`UPDATE import_batches SET added=added+?, dup_existing=dup_existing+?, invalid=invalid+?, assigned=assigned+? WHERE id=?`).bind(added, dupEx, inv, assigned, batch.id).run();
  return { added, dup_existing: dupEx, invalid: inv, assigned };
};
A.import_finish = async (db, u, b) => {
  const id = str(b.import_id, 40); const s = await importSummary(db, id); if (!s) bad('Upload not found');
  if (s.status === 'importing') await db.prepare(`UPDATE import_batches SET status='done', finished_at=? WHERE id=?`).bind(Date.now(), id).run();
  const f = await importSummary(db, id);
  await audit(db, u, 'import_done', { import_id: id, file_name: f.file_name, added: f.added, dup_existing: f.dup_existing, invalid: f.invalid, assigned: f.assigned, assign: f.assign_mode });
  return { batch: f };
};
A.uploads_list = async (db, u, b) => {
  const s = await getSettings(db); const where = []; const args = [];
  const q = String(b.q || '').replace(/\D/g, '').slice(-10); if (q) { where.push('h.phone LIKE ?'); args.push('%' + q + '%'); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(b.from || '')) { where.push('h.at >= ?'); args.push(R.dayStart(b.from, s.tz_offset_min)); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(b.to || '')) { where.push('h.at < ?'); args.push(R.dayStart(b.to, s.tz_offset_min) + 86400000); }
  const lim = Math.min(1000, Math.max(1, int(b.limit, 300)));
  const hits = (await db.prepare(`SELECT h.phone, h.at, h.file_name, h.result, h.by, k.name contact_name, k.area contact_area, k.status, k.lead_state, k.cb_count, k.assigned_to, u.name caller_name FROM upload_hits h LEFT JOIN contacts k ON k.phone = h.phone LEFT JOIN users u ON u.id = k.assigned_to ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY h.at DESC LIMIT ?`).bind(...args, lim).all()).results;
  const phones = [...new Set(hits.map(h => h.phone))]; const seen = {};
  await chunked(phones, 200, ps => db.prepare(`SELECT phone, COUNT(*) n, MIN(at) first_at, MAX(at) last_at FROM upload_hits WHERE phone IN (${ps.map(() => '?').join(',')}) GROUP BY phone`).bind(...ps).all().then(r => { for (const x of r.results) seen[x.phone] = x; return []; }));
  return { hits: hits.map(h => ({ ...h, times_uploaded: seen[h.phone] ? seen[h.phone].n : 1, first_upload: seen[h.phone] ? seen[h.phone].first_at : h.at, last_upload: seen[h.phone] ? seen[h.phone].last_at : h.at })), limit: lim };
};
A.import_check = async (db, u, b) => {
  const ph = [...new Set((Array.isArray(b.phones) ? b.phones.slice(0, 2000) : []).map(mobileOf).filter(Boolean))];
  const have = new Set((await db.prepare(`SELECT phone FROM contacts`).all()).results.map(r => r.phone));
  return { checked: ph.length, existing: ph.filter(p => have.has(p)).length };
};
A.import_list = async (db) => {
  const ids = (await db.prepare(`SELECT id FROM import_batches ORDER BY created_at DESC LIMIT 30`).all()).results.map(r => r.id);
  const out = []; for (const id of ids) out.push(await importSummary(db, id));
  return { batches: out };
};
A.import_undo = async (db, u, b) => {
  const id = str(b.import_id, 40); const s = await importSummary(db, id); if (!s) bad('Upload not found');
  if (s.status === 'undone') bad('This upload was already undone');
  if (s.called > 0) bad(`${s.called} of these numbers ${s.called === 1 ? 'has' : 'have'} already been called, so this upload cannot be undone. Only uploads with no calls can be undone.`);
  await db.prepare(`DELETE FROM contacts WHERE import_id=?`).bind(id).run();
  await db.prepare(`UPDATE import_batches SET status='undone', undone_at=? WHERE id=?`).bind(Date.now(), id).run();
  await audit(db, u, 'import_undo', { import_id: id, file_name: s.file_name, removed: s.still_here });
  return { removed: s.still_here };
};
A.contacts_list = async (db, u, b) => {
  const w = []; const p = [];
  if (b.q) { w.push(`(c.name LIKE ? OR c.phone LIKE ? OR c.area LIKE ?)`); const q = '%' + str(b.q, 60) + '%'; p.push(q, q, q); }
  if (b.assigned === 'none') w.push(`c.assigned_to IS NULL`); else if (b.assigned) { w.push(`c.assigned_to = ?`); p.push(b.assigned); }
  if (b.status) { w.push(`c.status = ?`); p.push(b.status); }
  if (b.import_id) { w.push(`c.import_id = ?`); p.push(str(b.import_id, 40)); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : ''; const lim = Math.min(500, int(b.limit, 200)); const off = Math.max(0, int(b.offset, 0));
  const total = (await db.prepare(`SELECT COUNT(*) n FROM contacts c ${where}`).bind(...p).first()).n;
  const rows = (await db.prepare(`SELECT c.*, u.name caller_name FROM contacts c LEFT JOIN users u ON u.id=c.assigned_to ${where} ORDER BY c.created_at DESC, c.name LIMIT ${lim} OFFSET ${off}`).bind(...p).all()).results;
  const counts = (await db.prepare(`SELECT COUNT(*) total, SUM(assigned_to IS NULL) unassigned FROM contacts`).first());
  return { total, contacts: rows, counts };
};
A.contacts_assign = async (db, u, b) => {
  let ids = Array.isArray(b.ids) ? b.ids.map(x => str(x, 40)) : [];
  if (b.all_unassigned) ids = (await db.prepare(`SELECT id FROM contacts WHERE assigned_to IS NULL ORDER BY created_at, name`).all()).results.map(r => r.id);
  if (!ids.length) bad('Select some numbers first'); const now = Date.now(); let st = [];
  if (b.mode === 'rr') {
    const callers = (await db.prepare(`SELECT id FROM users WHERE role='caller' AND active=1 ORDER BY name`).all()).results.map(r => r.id).filter(id => !b.caller_ids || !b.caller_ids.length || b.caller_ids.includes(id));
    if (!callers.length) bad('No active callers');
    for (const [cid, list] of R.roundRobin(ids, callers)) for (const x of list) st.push(db.prepare(`UPDATE contacts SET assigned_to=?, assigned_at=? WHERE id=?`).bind(cid, now, x));
  } else {
    const to = b.user_id ? str(b.user_id, 40) : null;
    if (to && !(await db.prepare(`SELECT id FROM users WHERE id=? AND role='caller'`).bind(to).first())) bad('Caller not found');
    st = ids.map(x => db.prepare(`UPDATE contacts SET assigned_to=?, assigned_at=? WHERE id=?`).bind(to, to ? now : null, x));
  }
  await chunked(st, 80, x => db.batch(x).then(() => [])); await audit(db, u, 'contacts_assign', { n: ids.length, mode: b.mode || 'user', user_id: b.user_id || null }); return { n: ids.length };
};
A.contacts_delete = async (db, u, b) => {
  const ids = Array.isArray(b.ids) ? b.ids.map(x => str(x, 40)) : []; if (!ids.length) bad('Select some numbers first');
  await chunked(ids.map(x => db.prepare(`DELETE FROM contacts WHERE id=?`).bind(x)), 80, x => db.batch(x).then(() => []));
  await audit(db, u, 'contacts_delete', { n: ids.length }); return { n: ids.length };
};
A.calls_list = async (db, u, b) => {
  const s = await getSettings(db); const r = rangeFrom(b, s); let rows = await callsIn(db, r.a, r.z, b.user_id || null);
  if (b.counted === '1') rows = rows.filter(c => c.counted); if (b.counted === '0') rows = rows.filter(c => !c.counted);
  const names = Object.fromEntries((await db.prepare(`SELECT id, name FROM users`).all()).results.map(x => [x.id, x.name]));
  return { from: r.from, to: r.to, calls: rows.slice(0, 3000).map(c => ({ ...decorate(c), caller_name: names[c.user_id] || '' })), total: rows.length };
};
A.call_override = async (db, u, b) => {
  const c = await db.prepare(`SELECT id, phone, approval_id FROM calls WHERE id=?`).bind(str(b.id, 40)).first(); if (!c) bad('Call not found');
  if (c.approval_id) bad('This call is inside an approved payout and cannot be changed');
  const reason = str(b.reason, 300); if (!reason) bad('Give a reason for the change');
  if (b.kind === 'lead') await db.prepare(`UPDATE calls SET lead_override=?, lead_override_reason=? WHERE id=?`).bind(b.value === 0 ? 0 : null, reason, c.id).run();
  else await db.prepare(`UPDATE calls SET override=?, override_reason=? WHERE id=?`).bind(b.value === 1 ? 1 : b.value === 0 ? 0 : null, reason, c.id).run();
  await rechainPhones(db, [c.phone], await getSettings(db)); await audit(db, u, 'call_override', { id: c.id, kind: b.kind || 'call', value: b.value, reason });
  return { call: decorate(await db.prepare(`SELECT * FROM calls WHERE id=?`).bind(c.id).first()) };
};
A.dashboard = async (db, u, b) => {
  const s = await getSettings(db); const today = R.dayKey(Date.now(), s.tz_offset_min);
  const wk = R.dayKey(R.dayStart(today, s.tz_offset_min) - 6 * 86400000 + 3600000, s.tz_offset_min); const mo = today.slice(0, 8) + '01';
  const [t, w, m] = await Promise.all([perCaller(db, s, today, today), perCaller(db, s, wk, today), perCaller(db, s, mo, today)]);
  const leadsOpen = (await db.prepare(`SELECT COUNT(*) n FROM contacts WHERE status='interested' AND COALESCE(lead_state,'open')='open'`).first()).n;
  const due = (await db.prepare(`SELECT COUNT(*) n FROM contacts WHERE (followup_at IS NOT NULL AND followup_at <= ? AND COALESCE(lead_state,'open')='open') OR (status='callback' AND callback_at <= ?)`).bind(Date.now() + 86400000, Date.now() + 86400000).first()).n;
  const counts = await db.prepare(`SELECT COUNT(*) total, SUM(assigned_to IS NULL) unassigned, SUM(status='new') fresh FROM contacts`).first();
  const wdp = (await db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(due_at < ?),0) o FROM withdrawals WHERE status='pending'`).bind(Date.now()).first());
  const lrp = (await db.prepare(`SELECT COUNT(*) n FROM log_requests WHERE status='pending'`).first()).n;
  return { today: t, week: w, month: m, ranges: { today: [today, today], week: [wk, today], month: [mo, today] }, leads_open: leadsOpen, due, contacts: counts, settings: s, withdrawals: { pending: wdp.n, overdue: wdp.o }, log_requests_pending: lrp };
};
A.payout_report = async (db, u, b) => {
  const s = await getSettings(db); const r = rangeFrom(b, s);
  if (s.streak_bonus_7 > 0 || s.streak_bonus_30 > 0) for (const c of (await db.prepare(`SELECT id FROM users WHERE role='caller' AND active=1`).all()).results) await awardFor(db, s, c.id); const rows = await perCaller(db, s, r.from, r.to, b.user_id || null);
  const adj = await adjIn(db, r.from, r.to, b.user_id || null);
  const appr = (await db.prepare(`SELECT a.*, u.name FROM approvals a JOIN users u ON u.id=a.user_id ORDER BY a.approved_at DESC LIMIT 200`).all()).results;
  const days = []; if (b.daily) { for (let d = R.dayStart(r.from, s.tz_offset_min); d < r.z; d += 86400000) { const k = R.dayKey(d + 3600000, s.tz_offset_min); days.push({ day: k, rows: await perCaller(db, s, k, k, b.user_id || null) }); } }
  return { from: r.from, to: r.to, rows, adjustments: adj, approvals: appr, days, settings: s };
};
A.adjustment_add = async (db, u, b) => {
  const amount = Number(b.amount); if (!isFinite(amount) || amount === 0 || Math.abs(amount) > 1e6) bad('Enter an amount (use minus for a deduction)');
  const reason = str(b.reason, 300); if (!reason) bad('Give a reason'); if (!/^\d{4}-\d{2}-\d{2}$/.test(b.day || '')) bad('Choose a date');
  if (!(await db.prepare(`SELECT id FROM users WHERE id=? AND role='caller'`).bind(str(b.user_id, 40)).first())) bad('Choose a caller');
  const id = uid(); await db.prepare(`INSERT INTO adjustments (id, user_id, day, amount, reason, created_by, created_at) VALUES (?,?,?,?,?,?,?)`).bind(id, b.user_id, b.day, Math.round(amount * 100) / 100, reason, u.id, Date.now()).run();
  await audit(db, u, 'adjustment_add', { id, user_id: b.user_id, day: b.day, amount, reason }); return { id };
};
A.adjustment_delete = async (db, u, b) => {
  const a = await db.prepare(`SELECT * FROM adjustments WHERE id=?`).bind(str(b.id, 40)).first(); if (!a) bad('Not found'); if (a.approval_id) bad('Inside an approved payout');
  if (a.akey) await db.prepare(`UPDATE adjustments SET amount=0, reason='Voided by admin — ' || reason WHERE id=?`).bind(a.id).run(); else await db.prepare(`DELETE FROM adjustments WHERE id=?`).bind(a.id).run();
  await audit(db, u, 'adjustment_delete', a); return {};
};
A.payout_approve = async (db, u, b) => {
  const s = await getSettings(db); const r = rangeFrom(b, s); const userId = str(b.user_id, 40); await awardFor(db, s, userId);
  const [row] = await perCaller(db, s, r.from, r.to, userId); if (!row) bad('Caller not found');
  const id = uid(); const now = Date.now();
  await db.prepare(`INSERT INTO approvals (id, user_id, from_day, to_day, made, counted, leads, call_amount, lead_amount, adjust, payout, note, approved_by, approved_at, paid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, userId, r.from, r.to, row.made, row.counted, row.leads, row.call_amount, row.lead_amount, row.adjust, row.payout, str(b.note, 300), u.id, now, b.paid ? 1 : 0).run();
  await db.prepare(`UPDATE calls SET approval_id=? WHERE user_id=? AND approval_id IS NULL AND COALESCE(start_ts, tapped_at) >= ? AND COALESCE(start_ts, tapped_at) < ?`).bind(id, userId, r.a, r.z).run();
  await db.prepare(`UPDATE adjustments SET approval_id=? WHERE user_id=? AND approval_id IS NULL AND day >= ? AND day <= ?`).bind(id, userId, r.from, r.to).run();
  await db.prepare(`UPDATE callbacks SET approval_id=? WHERE user_id=? AND approval_id IS NULL AND start_ts >= ? AND start_ts < ?`).bind(id, userId, r.a, r.z).run();
  await audit(db, u, 'payout_approve', { id, user_id: userId, from: r.from, to: r.to, payout: row.payout }); return { id, payout: row.payout };
};
A.payout_mark_paid = async (db, u, b) => { await db.prepare(`UPDATE approvals SET paid=? WHERE id=?`).bind(b.paid ? 1 : 0, str(b.id, 40)).run(); await audit(db, u, 'payout_paid', b); return {}; };
A.payout_unapprove = async (db, u, b) => {
  const id = str(b.id, 40); await db.prepare(`UPDATE calls SET approval_id=NULL WHERE approval_id=?`).bind(id).run(); await db.prepare(`UPDATE adjustments SET approval_id=NULL WHERE approval_id=?`).bind(id).run(); await db.prepare(`UPDATE callbacks SET approval_id=NULL WHERE approval_id=?`).bind(id).run();
  await db.prepare(`DELETE FROM approvals WHERE id=?`).bind(id).run(); await audit(db, u, 'payout_unapprove', { id, reason: str(b.reason, 300) }); return {};
};
A.leads_list = async (db, u, b) => {
  const st = b.state || 'open'; const w = [`c.status='interested' OR c.lead_state IS NOT NULL OR c.status='callback'`];
  const rows = (await db.prepare(`SELECT c.*, u.name caller_name, (SELECT MAX(COALESCE(start_ts, tapped_at)) FROM calls x WHERE x.contact_id=c.id AND x.outcome='interested') interested_at FROM contacts c LEFT JOIN users u ON u.id=c.assigned_to WHERE ${w[0]} ORDER BY COALESCE(c.followup_at, c.callback_at, 9e15), c.last_call_at DESC LIMIT 2000`).all()).results;
  const out = rows.filter(r => st === 'all' ? true : st === 'callback' ? r.status === 'callback' : (r.status === 'interested' || r.lead_state) && (r.lead_state || 'open') === st);
  return { leads: out };
};
A.lead_update = async (db, u, b) => {
  const id = str(b.id, 40); const c = await db.prepare(`SELECT id FROM contacts WHERE id=?`).bind(id).first(); if (!c) bad('Not found');
  const states = ['open', 'won', 'closed']; const ls = states.includes(b.lead_state) ? b.lead_state : null;
  await db.prepare(`UPDATE contacts SET lead_state=COALESCE(?, lead_state), followup_at=?, followup_note=? WHERE id=?`).bind(ls, int(b.followup_at), str(b.followup_note, 500), id).run();
  await audit(db, u, 'lead_update', { id, lead_state: ls, followup_at: int(b.followup_at) }); return {};
};
A.recalc_all = async (db, u) => { const n = await recalcAll(db); await audit(db, u, 'recalc_all', { n }); return { n }; };
A.audit_list = async (db) => ({ audit: (await db.prepare(`SELECT a.*, u.name FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 300`).all()).results });


// ================= v1.1: terms, account, payment details, withdrawals, callbacks, log requests =================
M.terms_current = async (db, u) => { const t = await currentTerms(db); return { terms: t, accepted_version: u.terms_version || 0, accepted: (u.terms_version || 0) === t.version }; };
M.terms_accept = async (db, u, b, req) => {
  const t = await currentTerms(db); if (Number(b.version) !== t.version) bad('The Terms were updated — please read the latest version');
  const now = Date.now(); await db.prepare(`UPDATE users SET terms_version=?, terms_at=? WHERE id=?`).bind(t.version, now, u.id).run();
  await db.prepare(`INSERT INTO terms_accept (user_id, version, accepted_at, device) VALUES (?,?,?,?)`).bind(u.id, t.version, now, str(b.device, 120) || (req.headers.get('user-agent') || '').slice(0, 120)).run();
  await audit(db, u, 'terms_accept', { version: t.version }); return { version: t.version, accepted_at: now };
};
const maskedPay = p => p ? { upi: R.maskUpi(p.upi), holder: p.holder || '', account_no: R.maskAcct(p.account_no), ifsc: p.ifsc || '', bank: p.bank || '', has_upi: !!p.upi, has_bank: !!(p.holder && p.account_no && p.ifsc && p.bank), updated_at: p.updated_at } : { has_upi: false, has_bank: false };
M.my_payment_get = async (db, u) => ({ payment: maskedPay(await payRow(db, u.id)) });
M.my_payment_save = async (db, u, b) => {
  if (u.role !== 'caller') bad('Only caller accounts have payment details');
  const cur = (await payRow(db, u.id)) || {}; const r = R.validatePayment(b, cur); if (r.error) bad(r.error); const v = r.value;
  await db.prepare(`INSERT OR REPLACE INTO payment_details (user_id, upi, holder, account_no, ifsc, bank, updated_at) VALUES (?,?,?,?,?,?,?)`).bind(u.id, v.upi, v.holder, v.account_no, v.ifsc, v.bank, Date.now()).run();
  await audit(db, u, 'payment_details_update', { upi: !!v.upi, bank: !!(v.holder && v.account_no) });   // never the values themselves
  return { payment: maskedPay(await payRow(db, u.id)) };
};
const wdOut = (w, now) => ({ id: w.id, amount: w.amount, status: w.status, requested_at: w.requested_at, due_at: w.due_at, paid_at: w.paid_at, utr: w.utr, reject_reason: w.reject_reason, overdue: w.status === 'pending' && now > w.due_at,
  to: w.pay_upi ? R.maskUpi(w.pay_upi) : (w.pay_account_no ? 'Bank ' + R.maskAcct(w.pay_account_no) : '') });
M.my_account = async (db, u) => {
  const s = await getSettings(db); if (u.role !== 'caller') bad('Caller accounts only'); const now = Date.now();
  const [wallet, streak, pay, wds, lrs, t] = await Promise.all([walletFor(db, s, u.id), streakFor(db, s, u.id), payRow(db, u.id),
    db.prepare(`SELECT * FROM withdrawals WHERE user_id=? ORDER BY requested_at DESC LIMIT 60`).bind(u.id).all(), db.prepare(`SELECT * FROM log_requests WHERE user_id=? ORDER BY requested_at DESC LIMIT 30`).bind(u.id).all(), currentTerms(db)]);
  return { user: { username: u.username, name: u.name }, wallet, streak, payment: maskedPay(pay), withdrawals: wds.results.map(w => wdOut(w, now)),
    log_requests: lrs.results.map(x => ({ id: x.id, purpose: x.purpose, from_day: x.from_day, to_day: x.to_day, status: x.status, requested_at: x.requested_at, decision_reason: x.decision_reason, expires_at: x.expires_at, viewable: x.status === 'approved' && x.expires_at > now })),
    terms: { version: t.version, accepted_version: u.terms_version || 0, accepted_at: u.terms_at }, now,
    settings: { min_withdrawal: s.min_withdrawal, withdraw_hours: s.withdraw_hours, retention_days: s.retention_days, daily_target: s.daily_target, streak_bonus_7: s.streak_bonus_7, streak_bonus_30: s.streak_bonus_30, callback_counts: s.callback_counts, min_duration: s.min_duration, call_rate: s.call_rate, lead_rate: s.lead_rate, repeat_hours: s.repeat_hours } };
};
M.my_streak = async (db, u) => { if (u.role !== 'caller') bad('Caller accounts only'); const s = await getSettings(db); return { streak: await streakFor(db, s, u.id), settings: { daily_target: s.daily_target, streak_bonus_7: s.streak_bonus_7, streak_bonus_30: s.streak_bonus_30 } }; };
M.withdraw_request = async (db, u, b) => {
  if (u.role !== 'caller') bad('Only caller accounts can withdraw'); const s = await getSettings(db); const pay = await payRow(db, u.id);
  const wallet = await walletFor(db, s, u.id, false); const err = R.checkWithdraw(b.amount, wallet, s, hasDetails(pay)); if (err) bad(err);
  const pend = (await db.prepare(`SELECT COUNT(*) n FROM withdrawals WHERE user_id=? AND status='pending'`).bind(u.id).first()).n; if (pend >= 5) bad('You already have 5 pending requests. Wait for the admin to pay them.');
  const amount = Math.round(Number(b.amount) * 100) / 100; const id = uid(); const now = Date.now();
  // one atomic statement: the row is only inserted if the balance still covers it (two requests at the same instant cannot both pass)
  const ins = await db.prepare(`INSERT INTO withdrawals (id, user_id, amount, status, requested_at, due_at, pay_upi, pay_holder, pay_account_no, pay_ifsc, pay_bank)
    SELECT ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ? WHERE ((SELECT COALESCE(SUM(payout),0) - COALESCE(SUM(CASE WHEN paid=1 THEN payout END),0) FROM approvals WHERE user_id=?) - (SELECT COALESCE(SUM(amount),0) FROM withdrawals WHERE user_id=? AND status IN ('pending','paid'))) >= ?`)
    .bind(id, u.id, amount, now, R.dueAt(now, s.withdraw_hours), pay.upi || '', pay.holder || '', pay.account_no || '', pay.ifsc || '', pay.bank || '', u.id, u.id, amount - 1e-9).run();
  if (!(ins.meta && ins.meta.changes)) bad('Your balance changed — please check it and try again');
  const after = await walletFor(db, s, u.id, false);
  await audit(db, u, 'withdraw_request', { id, amount }); return { id, wallet: after, due_at: R.dueAt(now, s.withdraw_hours) };
};
// ---- callbacks (caller phone sends incoming / missed entries for numbers it called from the app) ----
M.sync_callbacks = async (db, u, b) => {
  if (u.role !== 'caller') bad('Only caller accounts sync callbacks'); const s = await getSettings(db);
  const entries = (Array.isArray(b.entries) ? b.entries : []).slice(0, 300).filter(e => e && typeof e === 'object');
  const called = new Map((await db.prepare(`SELECT phone, MIN(COALESCE(tapped_at, start_ts)) first, MAX(COALESCE(tapped_at, start_ts)) last, MAX(contact_id) contact_id FROM calls WHERE user_id=? AND assigned_ok=1 AND phone IS NOT NULL GROUP BY phone`).bind(u.id).all()).results.map(r => [r.phone, r]));
  const dates = entries.map(e => Number(e.date)).filter(isFinite); let times = new Set();
  if (dates.length) times = new Set((await db.prepare(`SELECT start_ts FROM calls WHERE user_id=? AND start_ts BETWEEN ? AND ?`).bind(u.id, Math.min(...dates) - 3600000, Math.max(...dates) + 3600000).all()).results.map(r => r.start_ts));
  const m = R.matchCallbacks(entries, called, s, times); const now = Date.now(); const st = []; const phones = new Set();
  // v1.3: a callback already recorded (same number, same start) is never recorded twice, so it can never pay twice
  if (m.events.length) {
    const lo = Math.min(...m.events.map(e => e.start_ts)), hi = Math.max(...m.events.map(e => e.start_ts)); const seenCb = new Set();
    for (const r of (await db.prepare(`SELECT phone, start_ts FROM callbacks WHERE user_id=? AND start_ts BETWEEN ? AND ?`).bind(u.id, lo, hi).all()).results) seenCb.add(r.phone + '|' + r.start_ts);
    m.events = m.events.filter(e => { const k = e.phone + '|' + e.start_ts; if (seenCb.has(k)) return false; seenCb.add(k); return true; });
  }
  for (const e of m.events) { phones.add(e.phone); st.push(db.prepare(`INSERT OR IGNORE INTO callbacks (id, user_id, contact_id, phone, start_ts, duration, kind, synced_at, rate) VALUES (?,?,?,?,?,?,?,?,?)`).bind(uid(), u.id, called.get(e.phone).contact_id || null, e.phone, e.start_ts, e.duration, e.kind, now, s.call_rate)); }
  for (const r of m.returned) st.push(db.prepare(`UPDATE callbacks SET returned_at=? WHERE user_id=? AND phone=? AND kind='missed' AND start_ts < ? AND ? - start_ts <= 86400000 AND returned_at IS NULL`).bind(r.out_ts, u.id, r.phone, r.out_ts, r.out_ts));
  if (st.length) await chunked(st, 60, x => db.batch(x).then(() => []));
  for (const ph of phones) await db.prepare(`UPDATE contacts SET cb_count=(SELECT COUNT(*) FROM callbacks WHERE user_id=? AND phone=?), cb_last_at=(SELECT MAX(start_ts) FROM callbacks WHERE user_id=? AND phone=?), cb_last_dur=(SELECT duration FROM callbacks WHERE user_id=? AND phone=? ORDER BY start_ts DESC LIMIT 1) WHERE phone=? AND assigned_to=?`).bind(u.id, ph, u.id, ph, u.id, ph, ph, u.id).run();
  await recountCallbacks(db, s, [...phones]);
  return { recorded: m.events.length, returned: m.returned.length, skipped: m.skipped.length, done: entries.map(e => R.normPhone(e.number) + '|' + Number(e.date)) };
};
M.my_callbacks = async (db, u) => {
  const s = await getSettings(db); const a = R.retentionCutoff(Date.now(), s.retention_days);
  const rows = (await db.prepare(`SELECT b.id, b.phone, b.start_ts, b.duration, b.kind, b.returned_at, b.counted, k.name contact_name FROM callbacks b LEFT JOIN contacts k ON k.id=b.contact_id WHERE b.user_id=? AND b.start_ts >= ? ORDER BY b.start_ts DESC LIMIT 100`).bind(u.id, a).all()).results;
  return { callbacks: rows };
};
// ---- v1.3: one number's full history (every attempt and callback, in order, with what was paid) ----
async function numberHistory(db, u, phone) {
  const s = await getSettings(db); const adminView = u.role === 'admin';
  const names = Object.fromEntries((await db.prepare(`SELECT id, name, username FROM users`).all()).results.map(x => [x.id, x.name || x.username]));
  const cWhere = adminView ? '' : ' AND user_id=?', cArgs = adminView ? [phone] : [phone, u.id];
  const calls = (await db.prepare(`SELECT id, user_id, tapped_at, start_ts, duration, log_found, outcome, note, counted, reason, lead_counted, lead_reason, call_pay, call_rate, lead_rate, approval_id FROM calls WHERE phone=?${cWhere}`).bind(...cArgs).all()).results;
  const cbs = (await db.prepare(`SELECT id, user_id, start_ts, duration, kind, counted, reason, rate, returned_at FROM callbacks WHERE phone=?${cWhere}`).bind(...cArgs).all()).results;
  const events = [];
  for (const c of calls) {
    const at = c.start_ts || c.tapped_at || 0; const connected = c.duration > 0; const callPaid = !!(c.counted && (c.call_pay == null || c.call_pay)); const leadPaid = !!c.lead_counted;
    const result = !connected ? 'Not answered or cut' : c.outcome === 'interested' ? 'Interested' : (R.OUTCOME_LABEL[c.outcome] || 'Connected');
    events.push({ at, kind: 'call', caller: names[c.user_id] || '', connected, duration: c.duration || 0, result, note: c.note || '', counted: !!c.counted,
      reason: R.REASON_TEXT[c.reason] || c.reason || '', call_paid: callPaid, lead_paid: leadPaid, lead_note: c.outcome === 'interested' ? (c.lead_reason || '') : '',
      amount: r2((callPaid ? Number(c.call_rate) || 0 : 0) + (leadPaid ? Number(c.lead_rate) || 0 : 0)) });
  }
  for (const b of cbs) {
    const connected = b.kind === 'incoming' && b.duration > 0;
    events.push({ at: b.start_ts, kind: 'callback', caller: names[b.user_id] || '', connected, duration: b.duration || 0,
      result: b.kind === 'incoming' ? (connected ? 'Callback answered' : 'Callback not answered') : 'Missed callback (caller rang back, nobody answered)', note: '', counted: !!b.counted,
      reason: R.REASON_TEXT[b.reason] || b.reason || '', call_paid: false, lead_paid: false, callback_paid: !!b.counted, amount: b.counted ? r2(Number(b.rate) || 0) : 0 });
  }
  events.sort((x, y) => x.at - y.at || (x.kind < y.kind ? -1 : 1));
  const ct = await db.prepare(`SELECT name, area, status, lead_state, cb_count, assigned_to FROM contacts WHERE phone=?`).bind(phone).first();
  let uploads = [];
  if (adminView) uploads = (await db.prepare(`SELECT at, file_name, result, by FROM upload_hits WHERE phone=? ORDER BY at`).bind(phone).all()).results;
  const sum = { attempts: events.filter(e => e.kind === 'call').length, connected: events.filter(e => e.kind === 'call' && e.connected).length, paid_calls: events.filter(e => e.call_paid).length, leads: events.filter(e => e.lead_paid).length, callbacks_paid: events.filter(e => e.callback_paid).length };
  sum.amount = r2(events.reduce((a, e) => a + e.amount, 0));
  const contact = ct ? { name: ct.name || '', area: ct.area || '', status: ct.status || '', lead_state: ct.lead_state || '', callbacks: ct.cb_count || 0, assigned_to: adminView ? (names[ct.assigned_to] || '') : undefined } : null;
  return { phone, contact, uploads, events, summary: sum, rates: { call_rate: s.call_rate, lead_rate: s.lead_rate } };
}
M.number_history = async (db, u, b) => {
  const phone = R.normPhone(b.phone); if (!phone) bad('Enter a 10-digit mobile number');
  if (u.role === 'caller') {
    const mine = await db.prepare(`SELECT 1 FROM contacts WHERE phone=? AND assigned_to=? UNION SELECT 1 FROM calls WHERE phone=? AND user_id=? LIMIT 1`).bind(phone, u.id, phone, u.id).first();
    if (!mine) bad('This number is not on your list');
  }
  return numberHistory(db, u, phone);
};
// ---- log requests ----
M.log_request_create = async (db, u, b) => {
  if (u.role !== 'caller') bad('Only caller accounts can request logs'); const purpose = str(b.purpose, 500);
  if (purpose.length < 15) bad('Please explain the purpose in at least 15 characters');
  const re = /^\d{4}-\d{2}-\d{2}$/; if (!re.test(b.from || '') || !re.test(b.to || '')) bad('Choose the dates you need'); if (b.to < b.from) bad('The end date is before the start date');
  if ((Date.parse(b.to) - Date.parse(b.from)) / 86400000 > 92) bad('Choose a period of at most 92 days');
  const pend = (await db.prepare(`SELECT COUNT(*) n FROM log_requests WHERE user_id=? AND status='pending'`).bind(u.id).first()).n; if (pend >= 3) bad('You already have 3 requests waiting for the admin');
  const id = uid(); await db.prepare(`INSERT INTO log_requests (id, user_id, purpose, from_day, to_day, status, requested_at) VALUES (?,?,?,?,?, 'pending', ?)`).bind(id, u.id, purpose, b.from, b.to, Date.now()).run();
  await audit(db, u, 'log_request_create', { id, from: b.from, to: b.to, purpose }); return { id };
};
M.log_request_view = async (db, u, b) => {
  const r = await db.prepare(`SELECT * FROM log_requests WHERE id=? AND user_id=?`).bind(str(b.id, 40), u.id).first(); if (!r) bad('Request not found');
  if (r.status !== 'approved') bad('This request has not been approved'); if (r.expires_at <= Date.now()) bad('Access to these logs has expired. You can send a new request.');
  const s = await getSettings(db); const { rows } = await buildLogRows(db, s, r.from_day, r.to_day, u.id);
  await audit(db, u, 'log_request_view', { id: r.id, rows: rows.length }); return { from: r.from_day, to: r.to_day, expires_at: r.expires_at, columns: R.LOG_COLS.filter((c, i) => i !== 3), rows: rows.map(x => x.filter((c, i) => i !== 3)) };
};

// ---- admin ----
A.payment_get = async (db, u, b) => {
  const p = await payRow(db, str(b.user_id, 40)); await audit(db, u, 'payment_details_view', { user_id: b.user_id });
  return { payment: p ? { upi: p.upi, holder: p.holder, account_no: p.account_no, ifsc: p.ifsc, bank: p.bank, updated_at: p.updated_at } : null };
};
A.withdrawals_list = async (db, u, b) => {
  const now = Date.now(); const st = ['pending', 'paid', 'rejected'].includes(b.status) ? b.status : null;
  const rows = (await db.prepare(`SELECT w.*, u.name caller_name, u.username FROM withdrawals w JOIN users u ON u.id=w.user_id ${st ? 'WHERE w.status=?' : ''} ORDER BY CASE w.status WHEN 'pending' THEN 0 ELSE 1 END, CASE WHEN w.status='pending' THEN w.due_at ELSE -w.requested_at END LIMIT 1000`).bind(...(st ? [st] : [])).all()).results;
  const out = rows.map(w => ({ id: w.id, user_id: w.user_id, caller_name: w.caller_name, username: w.username, amount: w.amount, status: w.status, requested_at: w.requested_at, due_at: w.due_at, paid_at: w.paid_at, utr: w.utr, reject_reason: w.reject_reason,
    overdue: w.status === 'pending' && now > w.due_at, ms_left: w.status === 'pending' ? w.due_at - now : null, upi: w.pay_upi, holder: w.pay_holder, account_no: w.pay_account_no, ifsc: w.pay_ifsc, bank: w.pay_bank,
    upi_link: w.pay_upi ? R.upiLink({ pa: w.pay_upi, pn: w.pay_holder || w.caller_name, am: w.amount, tn: 'R&S Calling payout' }) : null }));
  const pend = out.filter(w => w.status === 'pending');
  return { withdrawals: out, summary: { pending: pend.length, pending_amount: r2(pend.reduce((a, w) => a + w.amount, 0)), overdue: pend.filter(w => w.overdue).length }, now };
};
A.withdrawal_pay = async (db, u, b) => {
  const utr = str(b.utr, 40); if (utr && !/^[A-Za-z0-9._\/-]+$/.test(utr)) bad('Reference can only have letters, digits, - _ . /');
  const r = await db.prepare(`UPDATE withdrawals SET status='paid', paid_at=?, utr=?, decided_by=?, decided_at=? WHERE id=? AND status='pending'`).bind(Date.now(), utr || null, u.id, Date.now(), str(b.id, 40)).run();
  if (!(r.meta && r.meta.changes)) bad('This request is not pending'); await audit(db, u, 'withdrawal_paid', { id: b.id, utr: utr || null }); return {};
};
A.withdrawal_reject = async (db, u, b) => {
  const reason = str(b.reason, 300); if (!reason) bad('Give a reason (the caller will see it)');
  const r = await db.prepare(`UPDATE withdrawals SET status='rejected', reject_reason=?, decided_by=?, decided_at=? WHERE id=? AND status='pending'`).bind(reason, u.id, Date.now(), str(b.id, 40)).run();
  if (!(r.meta && r.meta.changes)) bad('This request is not pending'); await audit(db, u, 'withdrawal_rejected', { id: b.id, reason }); return {};
};
A.callbacks_list = async (db, u, b) => {
  const s = await getSettings(db); const r = rangeFrom(b, s); const rows = await cbIn(db, r.a, r.z, b.user_id || null);
  const names = Object.fromEntries((await db.prepare(`SELECT id, name FROM users`).all()).results.map(x => [x.id, x.name]));
  return { from: r.from, to: r.to, callbacks: rows.slice(0, 3000).map(x => ({ ...x, caller_name: names[x.user_id] || '' })), total: rows.length };
};
A.log_requests_list = async (db, u, b) => {
  const st = ['pending', 'approved', 'rejected'].includes(b.status) ? b.status : null; const now = Date.now();
  const rows = (await db.prepare(`SELECT r.*, u.name caller_name, u.username FROM log_requests r JOIN users u ON u.id=r.user_id ${st ? 'WHERE r.status=?' : ''} ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.requested_at DESC LIMIT 500`).bind(...(st ? [st] : [])).all()).results;
  return { requests: rows.map(x => ({ ...x, expired: x.status === 'approved' && x.expires_at <= now })), now };
};
A.log_request_decide = async (db, u, b) => {
  const r = await db.prepare(`SELECT * FROM log_requests WHERE id=?`).bind(str(b.id, 40)).first(); if (!r) bad('Request not found'); if (r.status !== 'pending') bad('This request was already decided');
  const s = await getSettings(db); const now = Date.now(); const reason = str(b.reason, 300);
  if (b.approve) { await db.prepare(`UPDATE log_requests SET status='approved', decided_by=?, decided_at=?, decision_reason=?, expires_at=? WHERE id=?`).bind(u.id, now, reason || null, now + s.log_access_hours * 3600000, r.id).run(); }
  else { if (!reason) bad('Give a reason (the caller will see it)'); await db.prepare(`UPDATE log_requests SET status='rejected', decided_by=?, decided_at=?, decision_reason=? WHERE id=?`).bind(u.id, now, reason, r.id).run(); }
  await audit(db, u, b.approve ? 'log_request_approved' : 'log_request_rejected', { id: r.id, user_id: r.user_id, reason }); return {};
};
A.logs_export = async (db, u, b) => {
  const s = await getSettings(db); const today = R.dayKey(Date.now(), s.tz_offset_min); let from, to;
  if (b.all) { from = '2000-01-01'; to = today; } else { const r = rangeFrom(b, s); from = r.from; to = r.to; }
  const { rows, total, truncated } = await buildLogRows(db, s, from, to, b.user_id || null);
  await audit(db, u, 'logs_export', { from, to, rows: total, all: !!b.all });
  return { from, to, count: total, truncated, columns: R.LOG_COLS, rows, csv: R.toCsv(R.LOG_COLS, rows) };
};
A.snapshots_list = async (db) => ({ snapshots: (await db.prepare(`SELECT day, n, created_at, LENGTH(csv) bytes FROM snapshots ORDER BY day DESC LIMIT 400`).all()).results });
A.snapshot_get = async (db, u, b) => {
  const day = str(b.day, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) bad('Choose a date');
  const sn = await db.prepare(`SELECT csv, n, created_at FROM snapshots WHERE day=?`).bind(day).first(); if (!sn) bad('No saved file for this day (no calls that day, or the day is not over yet)');
  if (sn.csv) return { day, csv: sn.csv, n: sn.n, created_at: sn.created_at };
  const s = await getSettings(db); const { rows } = await buildLogRows(db, s, day, day); return { day, csv: R.toCsv(R.LOG_COLS, rows), n: rows.length, created_at: sn.created_at, rebuilt: true };
};
A.terms_get = async (db) => {
  const cur = await currentTerms(db);
  const versions = (await db.prepare(`SELECT t.version, t.created_at, u.name created_by_name FROM terms t LEFT JOIN users u ON u.id=t.created_by ORDER BY t.version DESC LIMIT 50`).all()).results;
  const callers = (await db.prepare(`SELECT id, name, username, active, terms_version, terms_at FROM users WHERE role='caller' ORDER BY name`).all()).results;
  return { current: cur, versions, report: callers.map(c => ({ ...c, status: !c.terms_version ? 'never' : c.terms_version === cur.version ? 'current' : 'outdated' })) };
};
A.terms_version_get = async (db, u, b) => { const t = await db.prepare(`SELECT version, body, created_at FROM terms WHERE version=?`).bind(int(b.version, 0)).first(); if (!t) bad('Version not found'); return { terms: t }; };
A.terms_save = async (db, u, b) => {
  const body = String(b.body || '').replace(/\r\n/g, '\n').trim(); if (body.length < 50) bad('The Terms are too short'); if (body.length > 20000) bad('The Terms are too long (20,000 characters at most)');
  const cur = await currentTerms(db); if (cur.body.trim() === body) bad('Nothing changed — edit the text first');
  const version = cur.version + 1; await db.prepare(`INSERT INTO terms (version, body, created_at, created_by) VALUES (?,?,?,?)`).bind(version, body, Date.now(), u.id).run();
  await audit(db, u, 'terms_save', { version }); return { version };
};

const TERMS_FREE = new Set(['me', 'logout', 'change_password', 'terms_current', 'terms_accept']);
async function api(req, env, method) {
  const db = env.DB; await init(db);
  if (method === 'health') return { ok: true, app: 'rs-calling', version: VERSION, time: Date.now() };
  if (req.method !== 'POST') throw new ApiError(405, 'POST only');
  if (req.headers.get('x-rsc') !== '1') throw new ApiError(400, 'Missing client header');
  let b = {}; try { b = await req.json(); } catch { b = {}; }
  if (method === 'login') return login(db, b, req);
  const u = await authUser(db, req);
  if (u.role === 'caller' && !TERMS_FREE.has(method)) {   // callers must have accepted the CURRENT version of the Terms
    const t = await currentTerms(db); if ((u.terms_version || 0) !== t.version) throw new ApiError(403, 'Please read and accept the Terms & Conditions to continue', { terms_required: true, terms_version: t.version });
  }
  await ensureSnapshots(db).catch(e => console.log('snapshot error', e && e.message));
  if (M[method]) return M[method](db, u, b, req);
  if (A[method]) { if (u.role !== 'admin') throw new ApiError(403, 'Admin only'); return A[method](db, u, b, req); }
  throw new ApiError(404, 'Unknown action');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      const method = url.pathname.slice(5).replace(/\/+$/, '');
      try { return json({ ok: true, ...(await api(req, env, method)) }); }
      catch (e) { const st = e instanceof ApiError ? e.status : 500; if (st === 500) console.log('api error', method, e && e.stack); return json({ ok: false, error: st === 500 ? 'Server error, please try again' : e.message, ...(e.extra || {}) }, st); }
    }
    if (url.pathname === '/admin' || url.pathname === '/admin/') return Response.redirect(url.origin + '/app/?admin=1', 302);
    if (APK && url.pathname === '/download/' + APK.name) {
      const r = await env.ASSETS.fetch(new Request(url.origin + '/files/' + APK.name, req));
      if (!r.ok) return r; const h = new Headers(r.headers); h.set('content-type', 'application/vnd.android.package-archive'); h.set('content-disposition', `attachment; filename="${APK.name}"`); h.set('cache-control', 'no-cache');
      return new Response(r.body, { status: 200, headers: h });
    }
    const r = await env.ASSETS.fetch(req);
    if (url.pathname.startsWith('/app/') || url.pathname === '/') { const h = new Headers(r.headers); h.set('cache-control', 'no-cache'); h.set('x-frame-options', 'DENY'); h.set('referrer-policy', 'no-referrer'); return new Response(r.body, { status: r.status, headers: h }); }
    return r;
  },
};
