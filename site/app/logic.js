/* R&S Calling — shared helpers for the web/Android app (plain script: sets window.RSL). Pure functions, unit-tested in node with a vm sandbox. */
(function (g) {
  'use strict';
  const norm = raw => { let d = String(raw == null ? '' : raw).trim().replace(/\.0+$/, '').replace(/\D/g, ''); if (d.length === 12 && d.startsWith('91')) d = d.slice(2); else if (d.length === 13 && d.startsWith('091')) d = d.slice(3); else if (d.length === 11 && d.startsWith('0')) d = d.slice(1); return d.length === 10 ? d : ''; };
  const UPI_RE = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9]{1,31}$/, IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/, ACCT_RE = /^[0-9]{9,18}$/;
  const isUpi = v => UPI_RE.test(String(v || '').trim());
  const isIfsc = v => IFSC_RE.test(String(v || '').trim().toUpperCase());
  const isAcct = v => ACCT_RE.test(String(v || '').replace(/[\s-]/g, ''));

  /** Auto-delete on the phone: drop the app's own copies of items that are synced AND older than `days` since they were synced. Never touches unsynced items. */
  function purgeSynced(items, now, days) {
    const keep = [], removed = []; const ms = Math.max(1, Number(days) || 7) * 86400000;
    for (const it of items || []) {
      if (!it.synced) { keep.push(it); continue; }
      const at = it.synced_at || now;                                  // synced before v1.1 had no stamp: the retention clock starts now
      if (now - at >= ms) removed.push(it); else keep.push(it.synced_at ? it : { ...it, synced_at: now });
    }
    return { keep, removed };
  }
  /** Phone-log entries worth sending as possible callbacks: only numbers this caller called from the app, not already sent, and not while a call to that number is still unsynced. */
  function callbackCandidates(log, calledPhones, done, unsyncedPhones) {
    const out = [];
    for (const e of log || []) {
      if (e.type !== 'incoming' && e.type !== 'missed' && e.type !== 'outgoing') continue;
      const p = norm(e.number); if (!p || !calledPhones.has(p) || unsyncedPhones.has(p)) continue;
      if (done.has(p + '|' + e.date)) continue; out.push({ number: p, date: e.date, duration: e.duration || 0, type: e.type });
    }
    return out.slice(0, 300);
  }
  function countdown(dueAt, now) {
    const d = dueAt - now, a = Math.abs(d), h = Math.floor(a / 3600000), m = Math.floor((a % 3600000) / 60000);
    const t = h ? `${h}h ${m}m` : `${m}m`;
    return d >= 0 ? { overdue: false, text: t + ' left' } : { overdue: true, text: 'Overdue by ' + t };
  }

  // ---------------- Help (rule-based, offline, no external service) ----------------
  const LEV = (a, b) => { const m = a.length, n = b.length; if (Math.abs(m - n) > 2) return 9; const d = Array.from({ length: m + 1 }, (_, i) => [i]); for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[m][n]; };
  const tokMatch = (t, w) => t === w || (w.length >= 5 && t.length >= w.length && t.startsWith(w)) || (w.length >= 6 && t.length >= 6 && LEV(t, w) <= 1);
  const tokens = q => String(q || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9\u0900-\u097f\s]/g, ' ').split(/\s+/).filter(Boolean);
  const G = {   // word groups (English + Hinglish spellings)
    count: ['count', 'counted', 'counting', 'gina', 'gine', 'ginti', 'ginte', 'add', 'added', 'valid'],
    call: ['call', 'calls', 'calling', 'phone', 'dial', 'fone'],
    not: ['not', 'nahi', 'nahin', 'nhi', 'no', 'why', 'kyu', 'kyun', 'kyon', 'missing', 'reason', 'zero', 'failed', 'rejected', 'wrong', 'galat', 'show', 'dikh', 'dikha', 'dikhta', 'dikhai'],
    money: ['money', 'paisa', 'paise', 'paisay', 'rupay', 'rupaye', 'rupee', 'rupees', 'rs', 'inr', 'payment', 'pay', 'paid', 'salary', 'earn', 'earned', 'earning', 'earnings', 'kamai', 'kamaya', 'income', 'cash', 'amount'],
    withdraw: ['withdraw', 'withdrawal', 'withdrawals', 'withdrawn', 'nikalna', 'nikal', 'nikalo', 'nikalne', 'payout', 'cashout', 'redeem', 'transfer', 'bhejo'],
    how: ['how', 'kaise', 'kese', 'kaisey', 'steps', 'way', 'tarika', 'karu', 'karna', 'kare', 'karein'],
    when: ['when', 'kab', 'time', 'hours', 'hour', 'ghante', 'ghanta', 'deadline', 'late', 'delay', 'delayed', 'receive', 'milega', 'milenge', 'aayega', 'wait', 'timeline'],
    duration: ['duration', 'seconds', 'second', 'sec', 'secs', 'minimum', 'minute', 'minutes', 'long', 'length', 'der', 'baat', 'talk', 'talking', 'conversation', 'bolna'],
    rate: ['rate', 'rates', 'per', 'kitna', 'kitne', 'kitni', 'much', 'price', 'pay', 'earn', 'milta', 'milte', 'rupee', 'rupees'],
    lead: ['lead', 'leads', 'interested', 'customer'],
    minw: ['minimum', 'min', 'least', 'lowest', 'limit', 'kam'],
    pay_d: ['upi', 'bank', 'ifsc', 'account', 'acct', 'khata', 'khate', 'vpa', 'gpay', 'phonepe', 'paytm'],
    details: ['details', 'detail', 'save', 'add', 'fill', 'enter', 'edit', 'change', 'update', 'bharna', 'likhna', 'masked', 'hidden', 'star', 'stars'],
    balance: ['balance', 'wallet', 'available', 'pending', 'approved', 'approval', 'total', 'reserved', 'withdrawn'],
    streak: ['streak', 'streaks', 'consecutive', 'lagatar', 'continuous', 'daily', 'roz', 'rozana', 'target', 'task', 'tasks'],
    bonus: ['bonus', 'reward', 'rewards', 'extra', 'inaam'],
    logs: ['log', 'logs', 'history', 'deleted', 'delete', 'deletes', 'purged', 'removed', 'retention', 'disappear', 'disappeared', 'gayab', 'hat', 'hata', 'hataya', 'clear', 'cleared'],
    request: ['request', 'apply', 'purpose', 'mangna', 'chahiye', 'download', 'copy', 'approval'],
    old: ['old', 'older', 'previous', 'purane', 'purana', 'earlier', 'past'],
    gone: ['gone', 'go', 'went', 'lost', 'missing', 'gayab', 'where', 'kaha', 'kahan', 'disappeared', 'vanished'],
    callback: ['callback', 'callbacks', 'wapas', 'returned', 'return', 'returns', 'calledback', 'phir'],
    terms: ['terms', 'conditions', 'condition', 'tnc', 'policy', 'agreement', 'rules', 'niyam', 'sharte', 'shart'],
    offline: ['offline', 'internet', 'network', 'net', 'wifi', 'sync', 'syncing', 'synced', 'upload', 'uploaded', 'signal', 'connection'],
    perm: ['permission', 'permissions', 'allow', 'access', 'denied', 'ijazat'],
    rec: ['record', 'recording', 'recorded', 'recorder', 'audio', 'listen', 'voice', 'awaaz'],
    repeat: ['repeat', 'repeated', 'twice', 'dobara', 'duplicate', 'again', 'same', 'baar'],
    dialer: ['dialer', 'normal', 'regular', 'manually', 'whatsapp', 'sim', 'outside', 'other', 'bahar'],
    login: ['password', 'login', 'logout', 'username', 'forgot', 'reset', 'signin', 'locked', 'deactivated'],
    admin: ['admin', 'support', 'complaint', 'human', 'owner', 'contact', 'manager', 'boss'],
    result: ['result', 'outcome', 'outcomes', 'note', 'notes', 'interested', 'wrong', 'reachable', 'unreachable'],
    greet: ['hi', 'hello', 'hey', 'namaste', 'hii', 'help', 'madad', 'start', 'menu', 'options'],
    reject: ['rejected', 'reject', 'declined', 'cancelled', 'canceled', 'refused'],
    overdue: ['overdue', 'late', 'delayed', 'pending', 'stuck', 'not', 'nahi', 'received', 'mila', 'pahuncha'],
    app: ['app', 'application', 'version'],
  };
  const has = (toks, name) => toks.some(t => G[name].some(w => tokMatch(t, w)));
  const rs = n => '₹' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const FAQ = [
    { id: 'greet', score: t => has(t, 'greet') ? 2 : 0, a: () => 'Hi! I can answer questions about using this app: how calls are counted, why a call was not counted, withdrawing money, payment details, your streak, call logs, callbacks, offline use and the Terms. What would you like to know?' },
    { id: 'counting', score: t => (has(t, 'count') ? 2 : 0) + (has(t, 'call') ? 1 : 0) + (has(t, 'how') ? 1 : 0), a: s => `A call counts when: (1) you made it from this app by tapping the green call button, (2) the number is on your list, (3) it connected and the talk time was at least ${s.min_duration} seconds, (4) it does not overlap another call, and (5) you did not already call the same number inside ${s.repeat_hours} hours. You earn ${rs(s.call_rate)} per counted call and ${rs(s.lead_rate)} for an Interested lead (once per client). Final counting is done on the server.` },
    { id: 'notcounted', score: t => (has(t, 'count') ? 1 : 0) + (has(t, 'not') ? 2 : 0) + (has(t, 'call') ? 1 : 0), a: s => `Open My calls and look under the call: it shows the exact reason. The usual reasons are: talk time under ${s.min_duration} seconds, the call did not connect, the number is not on your list, you called the same number again inside ${s.repeat_hours} hours, the call overlapped another one, or it was not found in your phone's call history (call from this app, and allow the Phone and Call log permissions). If you think a call was wrongly rejected, tell your admin.` },
    { id: 'mindur', score: t => (has(t, 'duration') ? 2 : 0) + (has(t, 'call') ? 1 : 0), a: s => `A call must have a conversation of at least ${s.min_duration} seconds to count. Shorter calls are shown as "not counted" with the reason.` },
    { id: 'rates', score: t => (has(t, 'money') ? 2 : 0) + (has(t, 'rate') ? 1 : 0) + (has(t, 'call') || has(t, 'lead') ? 1 : 0), a: s => `You earn ${rs(s.call_rate)} per counted call and ${rs(s.lead_rate)} for each Interested lead (once per client).${s.streak_bonus_7 > 0 || s.streak_bonus_30 > 0 ? ` Streak bonus: ${s.streak_bonus_7 > 0 ? rs(s.streak_bonus_7) + ' at 7 days' : ''}${s.streak_bonus_7 > 0 && s.streak_bonus_30 > 0 ? ', ' : ''}${s.streak_bonus_30 > 0 ? rs(s.streak_bonus_30) + ' at 30 days' : ''}.` : ''} The admin approves payouts after checking.` },
    { id: 'withdraw', score: t => (has(t, 'withdraw') ? 3 : 0) + (has(t, 'how') ? 1 : 0) + (has(t, 'money') ? 1 : 0), a: s => `Go to Account → Withdraw. First save your UPI ID or bank details. Enter an amount (minimum ${rs(s.min_withdrawal)}, up to your Available balance). The admin pays within ${s.withdraw_hours} hours and marks it Paid. The money is held (reserved) while the request is pending. The app does not move money itself — the admin pays from their own UPI/bank app.` },
    { id: 'withdraw_time', score: t => (has(t, 'when') ? 3 : 0) + (has(t, 'withdraw') || has(t, 'money') ? 1 : 0) + (has(t, 'overdue') ? 1 : 0), a: s => `Withdrawals are processed within ${s.withdraw_hours} hours of your request. Account → Withdrawals shows the request time and a countdown. If the time is over and you have not been paid, contact your admin.` },
    { id: 'withdraw_min', score: t => (has(t, 'minw') ? 2 : 0) + (has(t, 'withdraw') ? 2 : 0), a: s => `The minimum withdrawal is ${rs(s.min_withdrawal)}. You can withdraw up to your Available balance (approved earnings that are not already withdrawn or reserved).` },
    { id: 'rejected', score: t => (has(t, 'reject') ? 3 : 0) + (has(t, 'withdraw') || has(t, 'money') ? 1 : 0), a: () => 'If a withdrawal is rejected, the admin gives a reason which you can see under Account → Withdrawals, and the amount returns to your Available balance. Fix the issue (for example wrong payment details) and request again.' },
    { id: 'paydetails', score: t => (has(t, 'pay_d') ? 3 : 0) + (has(t, 'details') ? 1 : 0), a: () => 'Account → Payment details: add a UPI ID (like name@okbank) and/or bank details (account holder name, account number of 9–18 digits, 11-character IFSC like SBIN0001234, bank name). Only masked values are shown in the app; the admin sees them to pay you. You are responsible for the correctness of these details.' },
    { id: 'balance', score: t => (has(t, 'balance') ? 2 : 0) + (has(t, 'money') ? 1 : 0), a: () => 'Total earned = everything counted so far. Pending approval = earned but not yet approved by the admin. Approved = approved by the admin. Withdrawn = already paid to you. Reserved = held for withdrawals waiting to be paid. Available to withdraw = approved − withdrawn − reserved.' },
    { id: 'streak', score: t => (has(t, 'streak') ? 3 : 0) + (has(t, 'bonus') ? 0 : 0), a: s => `Your streak counts consecutive days (India date) on which you completed the daily task: at least ${s.daily_target} counted calls. The Streak tab shows your current streak, longest streak, today's progress and the last 14 days. A day that is not completed resets the current streak to 0 (today stays open until midnight).` },
    { id: 'streak_bonus', score: t => (has(t, 'streak') ? 1 : 0) + (has(t, 'bonus') ? 3 : 0), a: s => s.streak_bonus_7 > 0 || s.streak_bonus_30 > 0 ? `Streak bonus: ${s.streak_bonus_7 > 0 ? rs(s.streak_bonus_7) + ' when your streak reaches 7 days' : ''}${s.streak_bonus_7 > 0 && s.streak_bonus_30 > 0 ? ' and ' : ''}${s.streak_bonus_30 > 0 ? rs(s.streak_bonus_30) + ' at 30 days' : ''}. It is added to your earnings automatically.` : 'There is no streak bonus right now. Your streak still shows your daily consistency. Ask your admin if a bonus will be added.' },
    { id: 'logs_delete', score: t => (has(t, 'logs') ? 2 : 0) + (has(t, 'not') || has(t, 'gone') ? 1 : 0) + (has(t, 'gone') ? 1 : 0) + (has(t, 'call') ? 1 : 0), a: s => `For privacy, the app automatically deletes its own copies of your call details from this phone ${s.retention_days} days after they are safely synced. Your phone's own call history is never touched, and the admin keeps the full records. My calls shows the last ${s.retention_days} days.` },
    { id: 'logs_request', score: t => (has(t, 'logs') ? 2 : 0) + (has(t, 'request') ? 2 : 0) + (has(t, 'old') ? 1 : 0), a: s => `To see older call details: Account → Request my call logs. Choose the dates and write the purpose (at least 15 characters). The admin approves or rejects it; if approved you can view and download that period's logs for a limited time (${s.log_access_hours || 48} hours).` },
    { id: 'callback', score: t => has(t, 'callback') ? 3 : 0, a: s => `If a client you called from this app calls you back from the same number, the app attaches it to that client as "Callback received" (time and duration), and it shows in your list and My calls.${s.callback_counts ? ' Callbacks of at least ' + s.min_duration + ' seconds also earn the per-call rate.' : ' Callbacks are recorded, but they are not paid as extra calls.'}` },
    { id: 'terms', score: t => has(t, 'terms') ? 3 : 0, a: () => 'Account → Terms & Conditions shows the current terms and the version you accepted. If the admin updates the terms, you must accept the new version before using the app again.' },
    { id: 'offline', score: t => (has(t, 'offline') ? 3 : 0) + (has(t, 'call') ? 1 : 0), a: () => 'No internet? Keep calling. Calls are saved on the phone and sync automatically when you are online again (or tap Sync now). Your balance and logs update after sync.' },
    { id: 'perm', score: t => (has(t, 'perm') ? 4 : 0), a: () => 'The app needs Phone (to place calls) and Call log (to check calls made from the app). Without them calls cannot be counted. If you denied them, open your phone Settings → Apps → R&S Calling → Permissions and allow them.' },
    { id: 'rec', score: t => (has(t, 'rec') ? 4 : 0), a: () => 'Calls are not recorded. The app only reads the call details (number, time, duration) of calls you make from it.' },
    { id: 'lead', score: t => (has(t, 'lead') ? 3 : 0) + (has(t, 'money') ? 1 : 0), a: s => `Choose "Interested" after a call when the client wants the service. An Interested lead earns ${rs(s.lead_rate)} once per client, if that call was a real connected call of at least ${s.min_duration} seconds. The admin can reject a fake lead.` },
    { id: 'repeat', score: t => (has(t, 'repeat') ? 2 : 0) + (has(t, 'call') ? 1 : 0), a: s => `Calling the same number again within ${s.repeat_hours} hours counts only once. After that window a new call can count again.` },
    { id: 'dialer', score: t => (has(t, 'dialer') ? 3 : 0) + (has(t, 'call') ? 1 : 0), a: () => 'Only calls made with the green call button in this app are counted. Calls from the normal dialer, WhatsApp or other apps are not counted.' },
    { id: 'login', score: t => has(t, 'login') ? 3 : 0, a: () => 'Change your password under Account → Change password. If you forgot it or your account is locked or deactivated, ask your admin to reset it. Do not share your login — one account per person.' },
    { id: 'result', score: t => (has(t, 'result') ? 2 : 0) + (has(t, 'call') ? 1 : 0), a: () => 'After every call choose the result: Interested, Not interested, Callback (pick a date and time), Wrong number or Not reachable, and add a note if you want. You must save a result so the call syncs.' },
    { id: 'admin', score: t => (has(t, 'admin') ? 2 : 0), a: () => 'For account problems, wrong counting, missing payments or any change, please contact your admin directly. I can only explain how the app works.' },
  ];
  const REFUSE = 'I can only help with using this app. You can ask me about: how calls are counted, why a call was not counted, withdrawing money, payment details, your streak, call logs, callbacks, offline use or the Terms.';
  const TOPICS = ['How are my calls counted?', 'Why was my call not counted?', 'How do I withdraw money?', 'How does the streak work?', 'Why are my old logs gone?', 'What is a callback?'];
  function helpAnswer(question, settings) {
    const s = { min_duration: 30, repeat_hours: 24, call_rate: 0, lead_rate: 0, retention_days: 7, min_withdrawal: 100, withdraw_hours: 16, daily_target: 10, streak_bonus_7: 0, streak_bonus_30: 0, callback_counts: 0, ...(settings || {}) };
    const t = tokens(question); if (!t.length) return { matched: false, topic: null, answer: REFUSE, suggestions: TOPICS };
    let best = null, bs = 0;
    for (const f of FAQ) { const sc = f.score(t); if (sc > bs) { bs = sc; best = f; } }
    if (!best || bs < 2) return { matched: false, topic: null, answer: REFUSE, suggestions: TOPICS };
    return { matched: true, topic: best.id, answer: best.a(s), suggestions: [] };
  }
  g.RSL = { norm, isUpi, isIfsc, isAcct, purgeSynced, callbackCandidates, countdown, helpAnswer, tokens, TOPICS, FAQ_IDS: FAQ.map(f => f.id) };
})(typeof window !== 'undefined' ? window : globalThis);
