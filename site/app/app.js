/* R&S Calling — one web app for callers (inside the Android app) and the admin (browser or Android). English UI. */
(function () {
  'use strict';
  const NATIVE = window.RSC || null;                 // Android bridge (null in a normal browser)
  const VERSION = '1.1.0';
  const RSL = window.RSL;
  const LS = { get: (k, d) => { try { const v = localStorage.getItem('rsc_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set: (k, v) => localStorage.setItem('rsc_' + k, JSON.stringify(v)), del: k => localStorage.removeItem('rsc_' + k) };
  const $ = (s, el = document) => el.querySelector(s); const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rs = n => '₹' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const TZ = 330; const dayKey = ts => new Date(Number(ts) + TZ * 60000).toISOString().slice(0, 10);
  const today = () => dayKey(Date.now());
  const fmtT = ts => ts ? new Date(Number(ts)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }) : '';
  const fmtD = s => { const m = Math.floor((s || 0) / 60), x = (s || 0) % 60; return m ? `${m}m ${x}s` : `${x}s`; };
  const norm = raw => { let d = String(raw || '').replace(/\D/g, ''); if (d.length === 12 && d.startsWith('91')) d = d.slice(2); else if (d.length === 11 && d.startsWith('0')) d = d.slice(1); return d.length === 10 ? d : ''; };
  const rid = () => { const a = new Uint8Array(12); crypto.getRandomValues(a); return [...a].map(x => x.toString(16).padStart(2, '0')).join(''); };
  const OUT = { interested: 'Interested', not_interested: 'Not interested', callback: 'Callback', wrong_number: 'Wrong number', not_reachable: 'Not reachable' };
  const SERVER = NATIVE && NATIVE.server ? NATIVE.server() : '';
  let termsGate = false, me = LS.get('me', null), token = LS.get('token', null), view = null, settings = LS.get('settings', { min_duration: 30, call_rate: 0, lead_rate: 0, repeat_hours: 24 });
  const app = () => document.getElementById('app');
  function toast(m, ms = 2600) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.body.appendChild(t); setTimeout(() => t.remove(), ms); }

  async function api(m, body = {}, opt = {}) {
    let r; try {
      r = await fetch(SERVER + '/api/' + m, { method: 'POST', headers: { 'content-type': 'application/json', 'x-rsc': '1', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
    } catch (e) { const er = new Error('No internet connection'); er.offline = true; throw er; }
    let j = {}; try { j = await r.json(); } catch { j = { ok: false, error: 'Server error (' + r.status + ')' }; }
    if (r.status === 403 && j.terms_required) { termsGate = true; const er = new Error(j.error); er.terms = true; if (me && me.role === 'caller') setTimeout(() => renderTerms(), 0); throw er; }
    if (r.status === 401 && m !== 'login') { logoutLocal(j.error || 'Please log in again'); throw new Error(j.error || 'Logged out'); }
    if (!j.ok) throw new Error(j.error || 'Something went wrong');
    return j;
  }
  function logoutLocal(msg) { token = null; me = null; LS.del('token'); LS.del('me'); if (NATIVE && NATIVE.setLoggedIn) NATIVE.setLoggedIn(false); renderLogin(msg); }

  // ---------------- login ----------------
  function renderLogin(msg) {
    app().innerHTML = `<div class="login"><div class="card"><div class="big">R&amp;S</div><h1>R&amp;S Calling</h1><p class="mut small">Telecaller tracking &amp; payouts</p>
      ${msg ? `<div class="banner">${esc(msg)}</div>` : ''}
      <form id="lf"><label class="f">Username or phone</label><input id="lu" autocomplete="username" autocapitalize="none" required>
      <label class="f">Password</label><input id="lp" type="password" autocomplete="current-password" required>
      <div id="le" class="err small" style="margin-top:8px"></div><button class="btn" style="width:100%;margin-top:12px" id="lb">Log in</button></form>
      <p class="mut small" style="margin-top:14px">Callers: use the Android app so your calls are counted. Ask the admin for your login.</p></div>
      <p class="mut small" style="text-align:center">Version ${VERSION}</p></div>`;
    $('#lf').onsubmit = async e => {
      e.preventDefault(); $('#lb').disabled = true; $('#le').textContent = '';
      try {
        const j = await api('login', { login: $('#lu').value.trim(), password: $('#lp').value, app: NATIVE ? 'android' : 'web', device: NATIVE && NATIVE.deviceName ? NATIVE.deviceName() : navigator.userAgent.slice(0, 110) });
        token = j.token; me = j.user; LS.set('token', token); LS.set('me', me); if (NATIVE && NATIVE.setLoggedIn) NATIVE.setLoggedIn(true); start();
      } catch (err) { $('#le').textContent = err.message; $('#lb').disabled = false; }
    };
  }

  function shell(title, tabs, cur, onTab, bottom) {
    app().innerHTML = `<div class="top"><div class="logo">R&amp;S</div><h1>${esc(title)}</h1><div class="who">${esc(me.name || me.username)}<br>${me.role === 'admin' ? 'Admin' : 'Caller'}</div><button id="mo" title="Menu">☰</button></div>
      ${!bottom && tabs ? `<div class="nav">${tabs.map(t => `<button data-t="${t[0]}" class="${t[0] === cur ? 'on' : ''}">${t[1]}</button>`).join('')}</div>` : ''}
      <main id="main"></main>${bottom && tabs ? `<div class="bottom">${tabs.map(t => `<button data-t="${t[0]}" class="${t[0] === cur ? 'on' : ''}"><b>${t[2] || ''}</b>${t[1]}</button>`).join('')}</div>` : ''}`;
    $$('[data-t]').forEach(b => b.onclick = () => onTab(b.dataset.t));
    $('#mo').onclick = () => menu();
    return $('#main');
  }
  function menu() {
    sheet(`<h2 style="margin-top:0">${esc(me.name || me.username)}</h2><p class="mut small">${esc(me.username)} · ${me.role === 'admin' ? 'Admin' : 'Caller'} · v${VERSION}</p>
      <button class="btn sec" id="m_pw" style="width:100%;margin:4px 0">Change password</button>
      <button class="btn red" id="m_out" style="width:100%;margin:4px 0">Log out</button><button class="btn sec" id="m_x" style="width:100%;margin:4px 0">Close</button>`, s => {
      $('#m_x', s).onclick = () => s.remove();
      $('#m_out', s).onclick = async () => { s.remove(); if (me.role === 'caller' && queue().filter(q => !q.synced).length && !confirm('Some calls are not synced yet. Log out anyway? They stay on this phone and sync after you log in again.')) return; try { await api('logout'); } catch { } logoutLocal(); };
      $('#m_pw', s).onclick = () => { s.remove(); changePw(); };
    });
  }
  function changePw() {
    sheet(`<h2 style="margin-top:0">Change password</h2><label class="f">Current password</label><input type="password" id="p0" style="width:100%"><label class="f">New password (8+ characters)</label><input type="password" id="p1" style="width:100%"><div class="err small" id="pe"></div>
      <div class="row" style="margin-top:12px"><button class="btn" id="ps">Save</button><button class="btn sec" id="pc">Cancel</button></div>`, s => {
      $('#pc', s).onclick = () => s.remove();
      $('#ps', s).onclick = async () => { try { await api('change_password', { old: $('#p0', s).value, new: $('#p1', s).value }); s.remove(); toast('Password changed'); } catch (e) { $('#pe', s).textContent = e.message; } };
    });
  }
  function sheet(html, bind) { const s = document.createElement('div'); s.className = 'sheet'; s.innerHTML = `<div class="in">${html}</div>`; s.onclick = e => { if (e.target === s && !s.dataset.lock) s.remove(); }; document.body.appendChild(s); bind && bind(s); return s; }

  // ================= CALLER =================
  const queue = () => LS.get('queue', []); const saveQ = q => LS.set('queue', q.slice(-2000));
  const cbq = () => LS.get('cbq', []); const saveCb = q => LS.set('cbq', q.slice(-2000));
  const retention = () => Math.max(1, Number(settings.retention_days) || 7);
  /** Auto-delete: only THIS app's own synced copies are removed after the retention period. The phone's call history is never touched. */
  function purgeLocal() {
    const now = Date.now(); const a = RSL.purgeSynced(queue(), now, retention()); saveQ(a.keep);
    const b = RSL.purgeSynced(cbq(), now, retention()); saveCb(b.keep); return a.removed.length + b.removed.length;
  }
  const calledSet = () => new Set([...Object.keys(LS.get('called', {})), ...LS.get('list', []).filter(c => c.status !== 'new' || c.last_call_at).map(c => c.phone)]);
  let syncing = false;
  function scanCallbacks() {   // incoming / missed calls from numbers this caller called from the app
    if (!NATIVE || !me || me.role !== 'caller') return; const p = perms(); if (!p || !p.call_log) return;
    const now = Date.now(); const since = LS.get('cb_since', now - retention() * 86400000);
    const queueNow = queue(); const appTimes = queueNow.flatMap(x => [x.log_date, x.start_ts]).filter(Boolean);
    const log = readLog(since - 60000).filter(e => !(e.type === 'outgoing' && appTimes.some(t => Math.abs(t - e.date) <= 15000)));
    const q = cbq(); const done = new Set(q.map(x => x.number + '|' + x.date)); const unsynced = new Set(queueNow.filter(x => !x.synced).map(x => x.phone));
    for (const e of RSL.callbackCandidates(log, calledSet(), done, unsynced)) q.push({ ...e, synced: false });
    saveCb(q); if (!unsynced.size) LS.set('cb_since', now);
  }
  async function syncCallbacks() {
    const todo = cbq().filter(x => !x.synced).slice(0, 300); if (!todo.length) return 0;
    const j = await api('sync_callbacks', { entries: todo.map(x => ({ number: x.number, date: x.date, duration: x.duration, type: x.type })) });
    const done = new Set(j.done); const q2 = cbq(); for (const x of q2) if (done.has(x.number + '|' + x.date)) { x.synced = true; x.synced_at = Date.now(); } saveCb(q2); return j.recorded || 0;
  }
  async function syncNow(quiet) {
    if (syncing || !token || me.role !== 'caller') return; syncing = true;
    try {
      const q = queue(); const todo = q.filter(x => !x.synced && x.ready);
      if (todo.length) {
        const j = await api('sync', { calls: todo.map(x => ({ id: x.id, contact_id: x.contact_id, phone: x.phone, log_phone: x.log_phone, tapped_at: x.tapped_at, start_ts: x.start_ts, duration: x.duration, log_found: x.log_found, log_type: x.log_type, outcome: x.outcome, callback_at: x.callback_at, note: x.note, device: x.device })) });
        const res = Object.fromEntries(j.results.map(r => [r.id, r])); const q2 = queue();
        for (const x of q2) if (j.synced.includes(x.id) && x.ver === (todo.find(t => t.id === x.id) || {}).ver) { x.synced = true; x.synced_at = Date.now(); if (res[x.id]) Object.assign(x, { counted: res[x.id].counted, reason_text: res[x.id].reason_text, lead_counted: res[x.id].lead_counted, lead_reason: res[x.id].lead_reason }); }
        saveQ(q2); if (!quiet) toast(`Synced ${j.synced.length} call${j.synced.length > 1 ? 's' : ''}`);
      }
      scanCallbacks(); const rec = await syncCallbacks(); purgeLocal();
      if (todo.length || rec) { if (view === 'list' && rec) loadList().then(() => view === 'list' && renderList()); else if (view === 'list' || view === 'today') renderCaller(view, true); }
    } catch (e) { if (!quiet && !e.offline) toast(e.message); }
    finally { syncing = false; }
  }
  function perms() { if (!NATIVE) return null; try { return JSON.parse(NATIVE.permissions()); } catch { return null; } }
  function readLog(since) { try { return JSON.parse(NATIVE.readCallLog(String(since))); } catch { return []; } }
  // find the phone's call-log entry for a call placed from the app
  function matchLog(item) {
    if (!NATIVE) return false; const log = readLog(item.tapped_at - 15000);
    const used = new Set(queue().filter(q => q.id !== item.id && q.log_date).map(q => q.log_date));
    const c = log.filter(e => (e.type === 'outgoing') && norm(e.number) === item.phone && e.date >= item.tapped_at - 10000 && e.date <= item.tapped_at + 10 * 60000 && !used.has(e.date)).sort((a, b) => a.date - b.date)[0];
    if (!c) return false; Object.assign(item, { log_found: 1, log_phone: c.number, start_ts: c.date, duration: c.duration, log_type: c.type, log_date: c.date }); return true;
  }
  function placeCall(c) {
    if (!NATIVE) { toast('Calls are counted only from the R&S Calling Android app'); return; }
    const p = perms(); if (!p || !p.call_log) { askPerms(); return; }
    const item = { id: rid(), ver: 1, contact_id: c.id, phone: c.phone, name: c.name, tapped_at: Date.now(), device: NATIVE.deviceName ? NATIVE.deviceName() : '', log_found: 0, duration: 0, ready: false };
    const q = queue(); q.push(item); saveQ(q); LS.set('active', item.id); const cd = LS.get('called', {}); cd[c.phone] = Date.now(); LS.set('called', cd);
    NATIVE.call(c.phone);
  }
  function askPerms() {
    sheet(`<h2 style="margin-top:0">Allow phone permissions</h2><p>R&amp;S Calling needs to <b>make calls</b> and <b>read your call history</b> so each call you make from this app can be checked and counted for your payment.</p>
      <p class="mut small">Only calls placed from this app to numbers on your list, and callbacks from those numbers, are read and sent. Calls are not recorded.</p><button class="btn" id="pa" style="width:100%">Allow</button>`, s => { $('#pa', s).onclick = () => { s.remove(); NATIVE.requestPermissions(); }; });
  }
  // called by Android when the app comes back to the front (after the call ends)
  window.rscOnResume = function () {
    if (!me || me.role !== 'caller') return; const id = LS.get('active', null); if (!id) { syncNow(true); return; }
    let tries = 0; const attempt = () => {
      const q = queue(); const it = q.find(x => x.id === id); if (!it) return; const ok = matchLog(it); saveQ(q);
      if (ok || ++tries >= 4) { if (!$('.sheet[data-oc]')) outcomeSheet(it.id); } else setTimeout(attempt, 1500);
    }; setTimeout(attempt, 700);
  };
  window.rscOnPermissions = function () { if (view) renderCaller(view, true); };
  function outcomeSheet(id) {
    const it = queue().find(x => x.id === id); if (!it) return; let pick = it.outcome || null;
    const st = it.log_found ? (it.duration > 0 ? (it.duration >= settings.min_duration ? `<span class="tag ok">Connected ${fmtD(it.duration)} — will count*</span>` : `<span class="tag warn">Connected ${fmtD(it.duration)} — under ${settings.min_duration}s, won't count</span>`) : `<span class="tag bad">Not connected</span>`) : `<span class="tag mut">Not found in call history yet</span>`;
    const s = sheet(`<h2 style="margin:0 0 4px">${esc(it.name || it.phone)}</h2><div class="mut small">${esc(it.phone)} · ${fmtT(it.tapped_at)}</div><div style="margin:10px 0">${st}</div>
      <b>Result of the call</b><div class="oc">${Object.entries(OUT).map(([k, v]) => `<button data-o="${k}" class="${pick === k ? 'on' : ''}">${v}</button>`).join('')}</div>
      <div id="cbw" style="display:${pick === 'callback' ? 'block' : 'none'}"><label class="f">Callback date &amp; time</label><input type="datetime-local" id="cbt" style="width:100%"></div>
      <label class="f">Note (optional)</label><textarea id="nt" placeholder="What did the client say?">${esc(it.note || '')}</textarea>
      <div class="err small" id="oe"></div><div class="row" style="margin-top:10px"><button class="btn grow" id="os">Save</button><button class="btn sec" id="orc">Re-check call log</button></div>
      <p class="mut small">* Final counting is done on the server (assigned list, repeat calls, same-time calls).</p>`, s => {
      s.dataset.oc = '1'; s.dataset.lock = '1';
      $$('[data-o]', s).forEach(b => b.onclick = () => { pick = b.dataset.o; $$('[data-o]', s).forEach(x => x.classList.toggle('on', x === b)); $('#cbw', s).style.display = pick === 'callback' ? 'block' : 'none'; });
      $('#orc', s).onclick = () => { const q = queue(); const x = q.find(y => y.id === id); matchLog(x); saveQ(q); s.remove(); outcomeSheet(id); };
      $('#os', s).onclick = () => {
        if (!pick) { $('#oe', s).textContent = 'Choose the result of the call'; return; }
        let cb = null; if (pick === 'callback') { const v = $('#cbt', s).value; if (!v) { $('#oe', s).textContent = 'Choose the callback date and time'; return; } cb = Date.parse(v + ':00+05:30'); }
        const q = queue(); const x = q.find(y => y.id === id); if (!x.log_found) matchLog(x);
        Object.assign(x, { outcome: pick, callback_at: cb, note: $('#nt', s).value.trim().slice(0, 500), ready: true, synced: false, ver: (x.ver || 1) + 1 }); saveQ(q); LS.del('active');
        const L = LS.get('list', []); const c = L.find(y => y.id === x.contact_id); if (c) { c.status = pick; c.last_call_at = x.start_ts || x.tapped_at; c.callback_at = cb; if (x.note) c.last_note = x.note; LS.set('list', L); }
        s.remove(); toast('Saved'); syncNow(true); renderCaller(view || 'list', true);
      };
    });
  }
  async function loadList() { try { const j = await api('my_list'); LS.set('list', j.contacts); settings = { ...settings, ...j.settings }; LS.set('settings', settings); LS.set('list_at', Date.now()); return true; } catch (e) { if (!e.offline && !e.terms) toast(e.message); return false; } }

  // ---- shared bits ----
  const ICON = {
    list: '<path d="M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/>',
    calls: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    streak: '<path d="M12 3c.5 3-1.5 4.5-3 6.5S7 13 8 15.5 11 20 12 20s4-1.5 4-5c0-2-1-3-2-4.5C12.5 9 12.5 5.5 12 3z"/>',
    account: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/>',
    wallet: '<path d="M3 7a2 2 0 0 1 2-2h13v4"/><path d="M3 7v11a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2z"/><circle cx="16.5" cy="14.5" r="1"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    inbox: '<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 3h6l1-3h5"/>',
    doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  };
  const ico = (n, sz = 22) => `<svg class="ic" width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n] || ''}</svg>`;
  const empty = (icon, title, text) => `<div class="empty">${ico(icon, 34)}<b>${esc(title)}</b><span>${esc(text)}</span></div>`;
  const skeleton = (n = 3) => `<div class="skel-wrap">${'<div class="skel"></div>'.repeat(n)}</div>`;
  const errCard = (msg, again) => `<div class="card errc"><b>Something went wrong</b><div class="small">${esc(msg)}</div>${again ? '<button class="btn sm" data-retry style="margin-top:8px">Try again</button>' : ''}</div>`;
  const termsHtml = body => { const L = String(body || '').split('\n'); let h = ''; L.forEach((l, i) => { l = l.trim(); if (!l) return; const m = /^(\d+)\.\s+(.*)$/.exec(l); h += m ? `<div class="tl"><span>${m[1]}</span><p>${esc(m[2])}</p></div>` : i === 0 ? `<h2 class="th">${esc(l)}</h2>` : `<p class="mut small">${esc(l)}</p>`; }); return `<div class="terms">${h}</div>`; };
  function saveText(name, text, mime) {
    if (NATIVE && NATIVE.saveFile) { NATIVE.saveFile(btoa(unescape(encodeURIComponent(text))), name, mime); return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const csvCell = v => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s) && !/^[-+]?\d+(\.\d+)?$/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const toCsv = (cols, rows) => '\ufeff' + [cols, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const xlsxBook = (name, sheets) => { const wb = XLSX.utils.book_new(); for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows), s.name.slice(0, 31)); if (NATIVE && NATIVE.saveFile) { NATIVE.saveFile(XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }), name + '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); return; } XLSX.writeFile(wb, name + '.xlsx'); };

  // ---- Terms & Conditions gate ----
  async function renderTerms(msg) {
    app().innerHTML = `<div class="top"><div class="logo">R&amp;S</div><h1>Terms &amp; Conditions</h1></div><main>${skeleton(4)}</main>`;
    let j; try { j = await api('terms_current'); } catch (e) { if (e.terms) return; app().querySelector('main').innerHTML = errCard(e.offline ? 'You need an internet connection to read and accept the Terms.' : e.message, true); app().querySelector('[data-retry]').onclick = () => renderTerms(); return; }
    app().innerHTML = `<div class="top"><div class="logo">R&amp;S</div><h1>Terms &amp; Conditions</h1></div><main><div class="banner">${msg || (j.accepted_version ? 'The Terms were updated. Please read and accept the new version to continue.' : 'Please read and accept the Terms to start using the app.')}</div>
      <div class="card">${termsHtml(j.terms.body)}</div>
      <div class="card"><label class="chk"><input type="checkbox" id="tk"> <span>I have read and agree to these Terms &amp; Conditions (version ${j.terms.version}).</span></label><div class="err small" id="te"></div>
      <button class="btn" id="ta" style="width:100%;margin-top:10px" disabled>Accept and continue</button><button class="btn sec" id="tl" style="width:100%;margin-top:8px">Log out</button></div></main>`;
    $('#tk').onchange = e => { $('#ta').disabled = !e.target.checked; };
    $('#tl').onclick = async () => { try { await api('logout'); } catch { } logoutLocal(); };
    $('#ta').onclick = async () => { $('#ta').disabled = true; try { await api('terms_accept', { version: j.terms.version, device: NATIVE && NATIVE.deviceName ? NATIVE.deviceName() : '' }); LS.set('terms_ok', j.terms.version); termsGate = false; toast('Thank you — terms accepted'); renderCaller('list'); syncNow(true); } catch (e) { $('#te').textContent = e.message; $('#ta').disabled = false; } };
  }

  let filt = 'todo', search = '';
  const CTABS = [['list', 'My list', ico('list')], ['today', 'My calls', ico('calls')], ['streak', 'Streak', ico('streak')], ['account', 'Account', ico('account')], ['help', 'Help', ico('help')]];
  async function renderCaller(t, noFetch) {
    if (termsGate) return renderTerms();
    view = t; const main = shell('R&S Calling', CTABS, t, x => renderCaller(x), true);
    const pend = queue().filter(x => !x.synced); const p = perms();
    let warn = '';
    if (!NATIVE) warn = `<div class="banner">You are in a web browser. Calls are counted only when made from the <b>R&amp;S Calling Android app</b>. <a href="/">Download it here</a>.</div>`;
    else if (p && (!p.call_log || !p.call_phone)) warn = `<div class="banner">Phone permissions are off — calls can't be counted. <button class="btn sm" id="gp">Allow</button></div>`;
    if (pend.length) warn += `<div class="banner">${pend.filter(x => x.ready).length} call(s) waiting to sync${pend.some(x => !x.ready) ? `, ${pend.filter(x => !x.ready).length} without a result` : ''}. <button class="btn sm" id="sy">Sync now</button></div>`;
    const retry = f => { const b = $('[data-retry]'); if (b) b.onclick = f; };
    if (t === 'list') {
      if (!noFetch || !LS.get('list_at', 0)) loadList().then(ok => ok && view === 'list' && renderList());
      main.innerHTML = warn + `<div class="card" style="padding:10px"><input id="sq" placeholder="Search name, number or area" style="width:100%" value="${esc(search)}"><div class="row" style="margin-top:8px"><div class="pill">${[['todo', 'To call'], ['callback', 'Callbacks'], ['back', 'Called back'], ['done', 'Done'], ['all', 'All']].map(f => `<button data-f="${f[0]}" class="${filt === f[0] ? 'on' : ''}">${f[1]}</button>`).join('')}</div></div></div><div class="card clist" id="cl"></div>`;
      $('#sq').oninput = e => { search = e.target.value; renderList(); }; $$('[data-f]').forEach(b => b.onclick = () => { filt = b.dataset.f; $$('[data-f]').forEach(x => x.classList.toggle('on', x === b)); renderList(); });
      renderList();
    } else if (t === 'today') {
      main.innerHTML = warn + skeleton(3);
      try {
        const [j, cbj] = await Promise.all([api('my_stats'), api('my_callbacks')]); const a = j.today, m = j.month; settings = { ...settings, ...j.settings }; LS.set('settings', settings);
        const local = pend.length ? `<div class="card"><h2>On this phone (not synced yet)</h2>${pend.map(x => `<div class="small">${esc(x.name || x.phone)} · ${fmtT(x.tapped_at)} · ${x.log_found ? fmtD(x.duration) : 'not in call log'} · ${esc(OUT[x.outcome] || 'no result yet')}</div>`).join('')}</div>` : '';
        const cbs = cbj.callbacks.length ? `<div class="card clist"><h2>Callbacks received</h2>${cbj.callbacks.map(b => `<div class="ci" style="display:block"><div class="row"><b class="grow">${esc(b.contact_name || b.phone)}</b><span class="small mut">${fmtT(b.start_ts)}</span></div><div class="small">${b.kind === 'incoming' ? 'Client called you back · ' + fmtD(b.duration) : 'Missed call from the client'}${b.returned_at ? ' · you called back' : ''}</div></div>`).join('')}</div>` : '';
        main.innerHTML = warn + `<div class="stats"><div class="stat"><b>${a.made}</b><span>Calls today</span></div><div class="stat"><b>${a.counted}</b><span>Counted today</span></div><div class="stat"><b>${a.leads}</b><span>Interested leads</span></div><div class="stat"><b>${rs(a.payout)}</b><span>Earned today</span></div></div>
          <div class="card" style="margin-top:12px"><h2>This month</h2><div class="small">Calls ${m.made} · Connected ${m.connected} · Counted ${m.counted} · Leads ${m.leads}</div><div class="big-n">${rs(m.payout)}</div>
          <div class="mut small">${rs(j.settings.call_rate)} per counted call (min ${j.settings.min_duration}s) + ${rs(j.settings.lead_rate)} per interested lead${m.adjust ? ` · adjustments ${rs(m.adjust)}` : ''}</div></div>${local}${cbs}
          <div class="card clist"><h2>Recent calls</h2><p class="mut small" style="margin:-4px 0 8px">Call details are kept on this phone for ${j.retention_days} days after syncing, then removed automatically. Need older details? Account → Request my call logs.</p>${j.recent.map(c => `<div class="ci" style="display:block"><div class="row"><b class="grow">${esc(c.contact_name || c.phone)}</b><span class="small mut">${fmtT(c.start_ts || c.tapped_at)}</span></div><div class="small">${c.log_found ? 'Talk ' + fmtD(c.duration) : 'Not in call log'} · ${esc(c.outcome_label || 'No result')}</div><div class="small" style="margin-top:3px">${c.counted ? '<span class="tag ok">Counted</span>' : `<span class="tag bad">Not counted</span> <span class="mut">${esc(c.reason_text)}</span>`}${c.lead_counted ? ' <span class="tag ok">Lead</span>' : ''}</div></div>`).join('') || empty('inbox', 'No calls in the last ' + j.retention_days + ' days', 'Calls you make from this app will show here.')}</div>`;
      } catch (e) { if (e.terms) return; main.innerHTML = warn + (e.offline ? empty('clock', 'You are offline', 'Connect to the internet to see your totals. Calls you make are saved and sync later.') : errCard(e.message, true)); retry(() => renderCaller('today')); }
    } else if (t === 'streak') {
      main.innerHTML = warn + skeleton(3);
      try {
        const j = await api('my_streak'); const st = j.streak; const pct = Math.min(100, Math.round(100 * st.today_count / st.target));
        main.innerHTML = warn + `<div class="card streak"><div class="flame">${ico('streak', 30)}</div><div class="sn">${st.current}</div><div class="sl">day streak</div><div class="mut small">Longest streak: <b>${st.longest}</b> day${st.longest === 1 ? '' : 's'}</div></div>
          <div class="card"><h2>Today</h2><div class="row"><b class="grow">${st.today_count} of ${st.target} counted calls</b><span class="tag ${st.today_done ? 'ok' : 'warn'}">${st.today_done ? 'Daily task done' : (st.target - st.today_count) + ' to go'}</span></div><div class="bar"><i style="width:${pct}%"></i></div></div>
          <div class="card"><h2>Last 14 days</h2><div class="strip">${st.days14.map(d => `<div class="sd ${d.done ? 'ok' : ''} ${d.day === today() ? 'now' : ''}" title="${d.day}: ${d.count} counted calls"><b>${d.day.slice(8)}</b><span>${d.count}</span></div>`).join('')}</div><p class="mut small" style="margin-bottom:0">A green day means ${st.target} or more counted calls that day (India date).</p></div>
          <div class="card"><h2>How the streak works</h2><ul class="small"><li>Complete your daily task — ${st.target} counted calls — to keep the streak.</li><li>Miss a day and the streak starts again from 0. Today stays open until midnight.</li>${j.settings.streak_bonus_7 > 0 || j.settings.streak_bonus_30 > 0 ? `<li>Bonus: ${j.settings.streak_bonus_7 > 0 ? rs(j.settings.streak_bonus_7) + ' at 7 days' : ''}${j.settings.streak_bonus_7 > 0 && j.settings.streak_bonus_30 > 0 ? ', ' : ''}${j.settings.streak_bonus_30 > 0 ? rs(j.settings.streak_bonus_30) + ' at 30 days' : ''}, added to your earnings automatically.</li>` : ''}</ul></div>`;
      } catch (e) { if (e.terms) return; main.innerHTML = warn + (e.offline ? empty('clock', 'You are offline', 'Connect to the internet to see your streak.') : errCard(e.message, true)); retry(() => renderCaller('streak')); }
    } else if (t === 'account') {
      main.innerHTML = warn + skeleton(4); await renderAccount(main, warn);
    } else {
      main.innerHTML = warn + helpView();
      bindHelp(main);
    }
    const sy = $('#sy'); if (sy) sy.onclick = async () => { const q = queue(); q.filter(x => !x.ready).forEach(x => { if (Date.now() - x.tapped_at > 120000) { matchLog(x); } }); saveQ(q); const nr = q.filter(x => !x.ready); if (nr.length) outcomeSheet(nr[0].id); else syncNow(); };
    const gp = $('#gp'); if (gp) gp.onclick = () => NATIVE.requestPermissions();
  }

  // ---- Account ----
  let accTick = null;
  async function renderAccount(main, warn) {
    let j; try { j = await api('my_account'); } catch (e) { if (e.terms) return; main.innerHTML = warn + (e.offline ? empty('clock', 'You are offline', 'Connect to the internet to see your account.') : errCard(e.message, true)); const b = $('[data-retry]'); if (b) b.onclick = () => renderCaller('account'); return; }
    settings = { ...settings, ...j.settings }; LS.set('settings', settings); const w = j.wallet, pay = j.payment, S = j.settings; const skew = j.now - Date.now();
    const wd = j.withdrawals;
    main.innerHTML = warn + `<div class="card acc-head"><div class="avatar">${esc((j.user.name || j.user.username || '?')[0].toUpperCase())}</div><div class="grow"><b style="font-size:17px">${esc(j.user.name || j.user.username)}</b><div class="mut small">Username: <b>${esc(j.user.username)}</b></div></div><span class="tag ok">Caller</span></div>
      <div class="card wallet"><div class="row"><h2 class="grow" style="margin:0">${ico('wallet', 20)} Wallet</h2></div>
        <div class="avail"><span>Available to withdraw</span><b>${rs(w.available)}</b></div>
        <div class="stats w6"><div class="stat"><b>${rs(w.total_earned)}</b><span>Total earned</span></div><div class="stat"><b>${rs(w.approved)}</b><span>Approved</span></div><div class="stat"><b>${rs(w.pending_approval)}</b><span>Pending approval</span></div><div class="stat"><b>${rs(w.reserved)}</b><span>Withdrawal pending</span></div><div class="stat"><b>${rs(w.withdrawn)}</b><span>Withdrawn</span></div></div>
        <button class="btn" id="wbtn" style="width:100%;margin-top:12px" ${w.available < S.min_withdrawal ? 'disabled' : ''}>Withdraw money</button>
        <p class="mut small" style="margin:8px 0 0">${w.available < S.min_withdrawal ? `Minimum withdrawal is ${rs(S.min_withdrawal)}. ` : ''}Admin pays within ${S.withdraw_hours} hours of your request. This app does not move money — the admin pays from their own UPI/bank app and marks it Paid.</p></div>
      <div class="card"><div class="row"><h2 class="grow" style="margin:0">${ico('lock', 18)} Payment details</h2><button class="btn sm sec" id="pbtn">${pay.has_upi || pay.has_bank ? 'Edit' : 'Add'}</button></div>
        ${pay.has_upi || pay.has_bank ? `<div class="kv">${pay.has_upi ? `<div><span>UPI ID</span><b>${esc(pay.upi)}</b></div>` : ''}${pay.has_bank ? `<div><span>Account holder</span><b>${esc(pay.holder)}</b></div><div><span>Account number</span><b>${esc(pay.account_no)}</b></div><div><span>IFSC</span><b>${esc(pay.ifsc)}</b></div><div><span>Bank</span><b>${esc(pay.bank)}</b></div>` : ''}</div><p class="mut small" style="margin:8px 0 0">Shown masked here. The admin sees the full details to pay you.</p>` : `<p class="mut">Add your UPI ID or bank details to withdraw.</p>`}</div>
      <div class="card"><h2>${ico('clock', 18)} Withdrawals</h2>${wd.length ? wd.map(x => `<div class="wd ${x.overdue ? 'over' : ''}"><div class="row"><b class="grow">${rs(x.amount)}</b><span class="tag ${x.status === 'paid' ? 'ok' : x.status === 'rejected' ? 'bad' : x.overdue ? 'bad' : 'warn'}">${x.status === 'paid' ? 'Paid' : x.status === 'rejected' ? 'Rejected' : x.overdue ? 'Overdue' : 'Pending'}</span></div>
        <div class="small mut">Requested ${fmtT(x.requested_at)}${x.to ? ' · to ' + esc(x.to) : ''}</div>
        ${x.status === 'pending' ? `<div class="small due-line" data-due="${x.due_at}">Admin pays within ${S.withdraw_hours} hours · <b></b></div>` : x.status === 'paid' ? `<div class="small okt">Paid ${fmtT(x.paid_at)}${x.utr ? ' · Ref ' + esc(x.utr) : ''}</div>` : `<div class="small err">Reason: ${esc(x.reject_reason || '')}</div>`}</div>`).join('') : empty('wallet', 'No withdrawals yet', 'Approved earnings can be withdrawn once you add payment details.')}</div>
      <div class="card"><h2>${ico('doc', 18)} Call logs</h2><p class="small mut">Call details are removed from this phone ${S.retention_days} days after syncing. To see older logs, send a request with a purpose; the admin approves or rejects it.</p><button class="btn sec" id="lrbtn" style="width:100%">Request my call logs</button>
        ${j.log_requests.map(x => `<div class="wd"><div class="row"><b class="grow small">${x.from_day} → ${x.to_day}</b><span class="tag ${x.status === 'approved' ? (x.viewable ? 'ok' : 'mut') : x.status === 'rejected' ? 'bad' : 'warn'}">${x.status === 'approved' ? (x.viewable ? 'Approved' : 'Expired') : x.status === 'rejected' ? 'Rejected' : 'Waiting'}</span></div><div class="small mut">${esc(x.purpose)}</div>${x.decision_reason ? `<div class="small">Admin: ${esc(x.decision_reason)}</div>` : ''}${x.viewable ? `<button class="btn sm" data-lv="${x.id}" style="margin-top:6px">View &amp; download</button><span class="small mut"> until ${fmtT(x.expires_at)}</span>` : ''}</div>`).join('')}</div>
      <div class="card"><h2>${ico('doc', 18)} Terms &amp; Conditions</h2><div class="small mut">Accepted version ${j.terms.accepted_version} · ${fmtT(j.terms.accepted_at)}</div><button class="btn sec" id="tbtn" style="width:100%;margin-top:8px">Read the Terms</button></div>
      <div class="card"><button class="btn sec" id="pwbtn" style="width:100%">Change password</button><button class="btn red" id="lobtn" style="width:100%;margin-top:8px">Log out</button><p class="mut small" style="text-align:center;margin:10px 0 0">R&amp;S Calling v${VERSION}</p></div>`;
    const tick = () => $$('[data-due]').forEach(el => { const c = RSL.countdown(Number(el.dataset.due), Date.now() + skew); el.querySelector('b').textContent = c.text; el.classList.toggle('due', c.overdue); }); tick(); clearInterval(accTick); accTick = setInterval(() => { if (view === 'account') tick(); else clearInterval(accTick); }, 30000);
    $('#wbtn').onclick = () => withdrawSheet(j); $('#pbtn').onclick = () => paymentSheet(j); $('#lrbtn').onclick = () => logRequestSheet(j);
    $('#tbtn').onclick = async () => { try { const t = await api('terms_current'); sheet(`<div class="row"><b class="grow">Terms &amp; Conditions · v${t.terms.version}</b><button class="btn sm sec" onclick="this.closest('.sheet').remove()">Close</button></div>${termsHtml(t.terms.body)}`); } catch (e) { toast(e.message); } };
    $('#pwbtn').onclick = changePw; $('#lobtn').onclick = menuLogout;
    $$('[data-lv]').forEach(b => b.onclick = () => logViewSheet(b.dataset.lv));
  }
  async function menuLogout() { if (queue().filter(q => !q.synced).length && !confirm('Some calls are not synced yet. Log out anyway? They stay on this phone and sync after you log in again.')) return; try { await api('logout'); } catch { } logoutLocal(); }
  function withdrawSheet(j) {
    const w = j.wallet, S = j.settings, pay = j.payment;
    if (!pay.has_upi && !pay.has_bank) { toast('Add your UPI ID or bank details first'); return paymentSheet(j); }
    sheet(`<h2 style="margin-top:0">Withdraw money</h2><div class="avail sm"><span>Available</span><b>${rs(w.available)}</b></div>
      <label class="f">Amount (₹)</label><input id="wa" inputmode="decimal" placeholder="Minimum ${S.min_withdrawal}" style="width:100%">
      <div class="small mut" style="margin-top:6px">Will be paid to: <b>${pay.has_upi ? esc(pay.upi) : 'Bank ' + esc(pay.account_no)}</b></div>
      <p class="banner" style="margin-top:12px">Admin pays within <b>${S.withdraw_hours} hours</b> of your request. The amount is held while the request is pending. This app does not move money itself — the admin pays from their own UPI/bank app and then marks it Paid.</p>
      <div class="err small" id="we"></div><div class="row" style="margin-top:8px"><button class="btn grow" id="wgo">Request withdrawal</button><button class="btn sec" id="wx">Cancel</button></div>`, s => {
      $('#wx', s).onclick = () => s.remove();
      $('#wgo', s).onclick = async () => {
        const v = Number($('#wa', s).value); const e = $('#we', s);
        if (!isFinite(v) || v <= 0) { e.textContent = 'Enter an amount'; return; } if (v < S.min_withdrawal) { e.textContent = `Minimum withdrawal is ${rs(S.min_withdrawal)}`; return; } if (v > w.available) { e.textContent = `You can withdraw at most ${rs(w.available)}`; return; }
        $('#wgo', s).disabled = true; try { await api('withdraw_request', { amount: v }); s.remove(); toast('Withdrawal requested'); renderCaller('account'); } catch (er) { e.textContent = er.message; $('#wgo', s).disabled = false; }
      };
    });
  }
  function paymentSheet(j) {
    const pay = j.payment;
    sheet(`<h2 style="margin-top:0">Payment details</h2><p class="mut small">Add a UPI ID, bank details, or both. ${pay.has_upi || pay.has_bank ? 'Leave a field empty to keep what is saved.' : ''} Only the admin can see the full details.</p>
      <label class="f">UPI ID</label><input id="pu" autocapitalize="none" autocomplete="off" placeholder="${pay.has_upi ? esc(pay.upi) : 'name@okbank'}" style="width:100%">
      <h3 style="margin-top:14px">Bank account (all four fields)</h3>
      <label class="f">Account holder name</label><input id="ph" autocomplete="off" placeholder="${esc(pay.holder || 'Name as on the bank account')}" style="width:100%">
      <label class="f">Account number</label><input id="pa" inputmode="numeric" autocomplete="off" placeholder="${esc(pay.account_no || '9 to 18 digits')}" style="width:100%">
      <label class="f">IFSC</label><input id="pi" autocapitalize="characters" autocomplete="off" placeholder="${esc(pay.ifsc || 'SBIN0001234')}" style="width:100%">
      <label class="f">Bank name</label><input id="pb" autocomplete="off" placeholder="${esc(pay.bank || 'State Bank of India')}" style="width:100%">
      <div class="err small" id="pe" style="margin-top:8px"></div><div class="row" style="margin-top:12px"><button class="btn grow" id="psv">Save</button><button class="btn sec" id="pcx">Cancel</button></div>`, s => {
      $('#pcx', s).onclick = () => s.remove();
      $('#psv', s).onclick = async () => {
        const body = {}; const f = (id, k) => { const v = $(id, s).value.trim(); if (v) body[k] = v; }; f('#pu', 'upi'); f('#ph', 'holder'); f('#pa', 'account_no'); f('#pi', 'ifsc'); f('#pb', 'bank'); const e = $('#pe', s);
        if (!Object.keys(body).length) { e.textContent = 'Fill in at least one field'; return; }
        if (body.upi && !RSL.isUpi(body.upi)) { e.textContent = 'UPI ID looks wrong. Example: name@okbank'; return; }
        if (body.account_no && !RSL.isAcct(body.account_no)) { e.textContent = 'Account number must be 9 to 18 digits'; return; }
        if (body.ifsc && !RSL.isIfsc(body.ifsc)) { e.textContent = 'IFSC must be 11 characters, e.g. SBIN0001234'; return; }
        $('#psv', s).disabled = true; try { await api('my_payment_save', body); s.remove(); toast('Payment details saved'); renderCaller('account'); } catch (er) { e.textContent = er.message; $('#psv', s).disabled = false; }
      };
    });
  }
  function logRequestSheet() {
    const t = today(); const from = dayKey(Date.now() - 29 * 86400000);
    sheet(`<h2 style="margin-top:0">Request my call logs</h2><p class="mut small">Tell the admin why you need them. If approved you can view and download that period for a limited time.</p>
      <div class="row"><div class="grow"><label class="f">From</label><input type="date" id="lf1" value="${from}" style="width:100%"></div><div class="grow"><label class="f">To</label><input type="date" id="lf2" value="${t}" style="width:100%"></div></div>
      <label class="f">Purpose (required, at least 15 characters)</label><textarea id="lpu" placeholder="e.g. I need to check a call that was not counted on 2 November"></textarea>
      <div class="err small" id="lre"></div><div class="row" style="margin-top:10px"><button class="btn grow" id="lrs">Send request</button><button class="btn sec" id="lrc">Cancel</button></div>`, s => {
      $('#lrc', s).onclick = () => s.remove();
      $('#lrs', s).onclick = async () => { const pu = $('#lpu', s).value.trim(); if (pu.length < 15) { $('#lre', s).textContent = 'Please explain the purpose in at least 15 characters'; return; } $('#lrs', s).disabled = true; try { await api('log_request_create', { from: $('#lf1', s).value, to: $('#lf2', s).value, purpose: pu }); s.remove(); toast('Request sent to the admin'); renderCaller('account'); } catch (e) { $('#lre', s).textContent = e.message; $('#lrs', s).disabled = false; } };
    });
  }
  async function logViewSheet(id) {
    try {
      const j = await api('log_request_view', { id }); const cols = j.columns;
      const s = sheet(`<div class="row"><b class="grow">My call logs · ${j.from} → ${j.to}</b><button class="btn sm sec" onclick="this.closest('.sheet').remove()">Close</button></div><p class="mut small">Available until ${fmtT(j.expires_at)}. ${j.rows.length} records.</p>
        <div class="row"><button class="btn sm" id="lvc">Download CSV</button><button class="btn sm sec" id="lvx">Download Excel</button></div>
        <div class="tw" style="margin-top:8px;max-height:50vh"><table><tr>${cols.slice(0, 9).map(c => `<th>${esc(c)}</th>`).join('')}</tr>${j.rows.slice(0, 300).map(r => `<tr>${r.slice(0, 9).map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="9" class="mut">No records in this period</td></tr>`}</table></div>`);
      $('#lvc', s).onclick = () => saveText(`my-call-logs-${j.from}_${j.to}.csv`, toCsv(cols, j.rows), 'text/csv');
      $('#lvx', s).onclick = () => xlsxBook(`my-call-logs-${j.from}_${j.to}`, [{ name: 'My call logs', rows: [cols, ...j.rows] }]);
    } catch (e) { toast(e.message); }
  }

  // ---- Help (rule-based helper, works offline) ----
  let helpMsgs = [];
  function helpView() {
    return `<div class="card help"><div class="row" style="margin-bottom:6px"><b class="grow">${ico('help', 20)} Help</b><span class="small mut">About using this app</span></div><div class="hmsgs" id="hm">${helpMsgs.length ? helpMsgs.map(m => `<div class="hb ${m.me ? 'me' : 'bot'}">${esc(m.t)}</div>`).join('') : `<div class="hb bot">Hi! Ask me anything about using R&amp;S Calling — counting, withdrawing, streak, call logs, callbacks.</div>`}</div>
      <div class="chips" id="hc">${RSL.TOPICS.map(t => `<button data-q="${esc(t)}">${esc(t)}</button>`).join('')}</div>
      <form id="hf" class="hform"><input id="hq" placeholder="Type your question…" autocomplete="off" maxlength="200"><button class="btn">Send</button></form></div>`;
  }
  function bindHelp(main) {
    const ask = q => {
      q = (q || '').trim(); if (!q) return; helpMsgs.push({ me: true, t: q }); const r = RSL.helpAnswer(q, settings); helpMsgs.push({ me: false, t: r.answer }); helpMsgs = helpMsgs.slice(-40);
      $('#hm').innerHTML = helpMsgs.map(m => `<div class="hb ${m.me ? 'me' : 'bot'}">${esc(m.t)}</div>`).join(''); $('#hm').scrollTop = 1e6; $('#hq').value = '';
    };
    $('#hf').onsubmit = e => { e.preventDefault(); ask($('#hq').value); }; $$('[data-q]', main).forEach(b => b.onclick = () => ask(b.dataset.q)); $('#hm').scrollTop = 1e6;
  }
  function renderList() {
    const el = $('#cl'); if (!el) return; const L = LS.get('list', []); const s = search.toLowerCase(); const now = Date.now();
    let xs = L.filter(c => !s || (c.name || '').toLowerCase().includes(s) || c.phone.includes(s) || (c.area || '').toLowerCase().includes(s));
    if (filt === 'todo') xs = xs.filter(c => c.status === 'new' || c.status === 'not_reachable' || (c.status === 'callback'));
    if (filt === 'callback') xs = xs.filter(c => c.status === 'callback').sort((a, b) => (a.callback_at || 0) - (b.callback_at || 0));
    if (filt === 'back') xs = xs.filter(c => c.cb_last_at).sort((a, b) => b.cb_last_at - a.cb_last_at);
    if (filt === 'done') xs = xs.filter(c => c.status !== 'new' && c.status !== 'callback');
    el.innerHTML = xs.slice(0, 400).map(c => `<div class="ci"><div class="grow"><div class="nm">${esc(c.name || 'Client')}</div><div class="ph">${esc(c.phone)}${c.area ? ' · ' + esc(c.area) : ''} · <a href="#" class="hlink" data-h="${esc(c.phone)}">History</a></div>
      ${c.status !== 'new' ? `<div class="small"><span class="tag ${c.status === 'interested' ? 'ok' : c.status === 'callback' ? 'warn' : 'mut'}">${esc(OUT[c.status] || c.status)}</span> ${c.status === 'callback' && c.callback_at ? `<span class="${c.callback_at < now ? 'due' : ''}">${c.callback_at < now ? 'Due ' : ''}${fmtT(c.callback_at)}</span>` : c.last_call_at ? '<span class="mut">' + fmtT(c.last_call_at) + '</span>' : ''}</div>` : ''}
      ${c.cb_last_at ? `<div class="small" style="margin-top:3px"><span class="tag ok">Callback received</span> <span class="mut">${fmtT(c.cb_last_at)}${c.cb_last_dur ? ' · ' + fmtD(c.cb_last_dur) : ' · missed'}${c.cb_count > 1 ? ' · ' + c.cb_count + ' times' : ''}</span></div>` : ''}
      ${c.notes ? `<div class="small mut">${esc(c.notes)}</div>` : ''}${c.last_note ? `<div class="small">“${esc(c.last_note)}”</div>` : ''}</div><button class="callb" data-c="${esc(c.id)}" aria-label="Call">${ico('list', 24)}</button></div>`).join('') || (L.length ? empty('inbox', 'Nothing here', 'Try another filter.') : empty('list', 'No numbers assigned yet', 'Ask your admin to assign client numbers to you.'));
    if (xs.length > 400) el.innerHTML += `<p class="mut small">Showing 400 of ${xs.length}. Use search.</p>`;
    $$('[data-c]', el).forEach(b => b.onclick = () => placeCall(L.find(c => c.id === b.dataset.c)));
    $$('[data-h]', el).forEach(b => b.onclick = e => { e.preventDefault(); e.stopPropagation(); numberSheet(b.dataset.h, false); });
  }

  // ---- v1.3: one number's history: every attempt and callback in order, with what was paid ----
  async function numberSheet(phone, admin) {
    const s = sheet(`<h2 style="margin:0 0 2px">${esc(phone)}</h2><div class="mut small" id="nhb">Loading…</div>`, () => {});
    try {
      const j = await api('number_history', { phone }); const b = s.querySelector('#nhb'); const sm = j.summary;
      const who = j.contact && j.contact.name ? esc(j.contact.name) + (j.contact.area ? ' · ' + esc(j.contact.area) : '') : 'No name on file';
      const ev = j.events.length ? j.events.map(e => `<div style="border-top:1px solid #e5e7eb;padding:8px 0"><div class="row"><b class="grow">${fmtT(e.at)} · ${e.kind === 'callback' ? 'Client called back' : (admin && e.caller ? esc(e.caller) : 'Your call')}</b><span class="tag ${e.amount ? 'ok' : 'mut'}">${e.amount ? '+' + rs(e.amount) : rs(0)}</span></div>
        <div class="small">${esc(e.result)}${e.connected ? ' · ' + fmtD(e.duration) : ''}${e.kind === 'call' ? (e.call_paid ? ' · call paid' : ' · no call pay') : ''}${e.lead_paid ? ' · interest lead paid' : ''}${e.callback_paid ? ' · callback paid' : ''}</div>
        ${e.reason ? `<div class="small mut">${esc(e.reason)}</div>` : ''}${e.note ? `<div class="small">“${esc(e.note)}”</div>` : ''}</div>`).join('') : '<p class="mut small">No calls or callbacks for this number yet.</p>';
      const up = admin && j.uploads && j.uploads.length ? `<div class="small" style="margin:10px 0 2px"><b>Uploaded ${j.uploads.length} time${j.uploads.length > 1 ? 's' : ''}</b></div>` + j.uploads.map(u => `<div class="small mut">${fmtT(u.at)} · ${esc(u.file_name || '')} · ${({ added: 'new', dup_existing: 'already in the list', dup_in_upload: 'repeated in the same file' })[u.result] || esc(u.result)}${u.by ? ' · by ' + esc(u.by) : ''}</div>`).join('') : '';
      b.innerHTML = `<div class="small">${who}${admin && j.contact && j.contact.assigned_to ? ' · with ' + esc(j.contact.assigned_to) : ''}</div>
        <div class="stats" style="margin:10px 0"><div class="stat"><b>${sm.attempts}</b><span>Attempts</span></div><div class="stat"><b>${sm.connected}</b><span>Answered</span></div><div class="stat"><b>${rs(sm.amount)}</b><span>Paid for this number</span></div></div>${ev}${up}`;
    } catch (e) { const b = s.querySelector('#nhb'); if (b) b.textContent = e.message; }
  }

  // ================= ADMIN =================
  const ATABS = [['dash', 'Dashboard'], ['numbers', 'Numbers'], ['callers', 'Callers'], ['calls', 'Calls'], ['payouts', 'Payouts'], ['withdrawals', 'Withdrawals'], ['leads', 'Leads'], ['files', 'Logs'], ['terms', 'Terms'], ['settings', 'Settings'], ['devices', 'Devices'], ['log', 'Activity']];
  let callersCache = [];
  async function callers() { const j = await api('callers_list'); callersCache = j.callers; return callersCache; }
  const callerOpts = (sel, all = 'All callers') => `<option value="">${all}</option>` + callersCache.map(c => `<option value="${c.id}" ${sel === c.id ? 'selected' : ''}>${esc(c.name)}${c.active ? '' : ' (inactive)'}</option>`).join('');
  async function renderAdmin(t) {
    view = t; location.hash = t; const main = shell('R&S Calling — Admin', ATABS, t, x => renderAdmin(x), false);
    main.innerHTML = '<p class="mut">Loading…</p>';
    try { await (ADMIN[t] || ADMIN.dash)(main); } catch (e) { main.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
  }
  function exportX(name, sheets) { // sheets: [{name, rows: [[...]]}]
    const wb = XLSX.utils.book_new(); const num = v => (typeof v === 'string' && /^₹-?[\d,]+(\.\d+)?$/.test(v)) ? Number(v.slice(1).replace(/,/g, '')) : v;
    for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows.map((r, i) => i === 0 ? r.map(h => /pay|Adjust|Payout/i.test(h) && !/Interested/.test(h) ? h + ' (₹)' : h) : r.map(num))), s.name.slice(0, 31));
    if (NATIVE && NATIVE.saveFile) { NATIVE.saveFile(XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }), name + '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); return; }
    XLSX.writeFile(wb, name + '.xlsx');
  }
  function exportP(name, title, sub, head, body) {
    const { jsPDF } = window.jspdf; const doc = new jsPDF({ orientation: head.length > 7 ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
    const fix = v => String(v == null ? '' : v).replace(/₹/g, 'Rs ');
    doc.setFontSize(15); doc.text(fix(title), 40, 42); doc.setFontSize(9); doc.setTextColor(90); doc.text(fix(sub), 40, 58);
    doc.autoTable({ startY: 70, head: [head.map(fix)], body: body.map(r => r.map(fix)), styles: { fontSize: 8.5, cellPadding: 4 }, headStyles: { fillColor: [11, 37, 69] }, margin: { left: 40, right: 40 } });
    doc.setFontSize(8); doc.text('R&S Calling · generated ' + new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), 40, doc.internal.pageSize.getHeight() - 20);
    if (NATIVE && NATIVE.saveFile) { NATIVE.saveFile(doc.output('datauristring').split(',')[1], name + '.pdf', 'application/pdf'); return; }
    doc.save(name + '.pdf');
  }
  const totRow = r => [r.user.name, r.made, r.connected, r.counted, r.connect_rate + '%', r.leads, rs(r.call_amount), rs(r.lead_amount), rs(r.adjust), rs(r.payout)];
  const TOT_HEAD = ['Caller', 'Calls made', 'Connected', 'Counted', 'Connect rate', 'Interested leads', 'Call pay', 'Lead pay', 'Adjust', 'Payout'];
  const sum = rows => rows.reduce((a, r) => { for (const k of ['made', 'connected', 'counted', 'leads', 'call_amount', 'lead_amount', 'callback_amount', 'adjust', 'payout']) a[k] = (a[k] || 0) + (r[k] || 0); return a; }, {});
  const ADMIN = {};
  let dashRange = 'today';
  ADMIN.dash = async (main) => {
    const j = await api('dashboard'); const rows = j[dashRange]; const t = sum(rows); const rg = j.ranges[dashRange];
    main.innerHTML = `<div class="row" style="margin-bottom:10px"><div class="pill">${[['today', 'Today'], ['week', 'Last 7 days'], ['month', 'This month']].map(r => `<button data-r="${r[0]}" class="${r[0] === dashRange ? 'on' : ''}">${r[1]}</button>`).join('')}</div><span class="mut small">${rg[0]}${rg[1] !== rg[0] ? ' → ' + rg[1] : ''}</span><span class="grow"></span><button class="btn sec sm" id="dx">Excel</button><button class="btn sec sm" id="dp">PDF</button></div>
      <div class="stats"><div class="stat"><b>${t.made || 0}</b><span>Calls made</span></div><div class="stat"><b>${t.connected || 0}</b><span>Connected</span></div><div class="stat"><b>${t.counted || 0}</b><span>Counted</span></div><div class="stat"><b>${t.made ? Math.round(100 * t.connected / t.made) : 0}%</b><span>Connect rate</span></div><div class="stat"><b>${t.leads || 0}</b><span>Interested leads</span></div><div class="stat"><b>${rs(t.payout || 0)}</b><span>Payout</span></div></div>
      <div class="row" style="margin:10px 0"><span class="tag ${j.due ? 'bad' : 'mut'}">${j.due} follow-up/callback due</span><span class="tag mut">${j.leads_open} open leads</span><span class="tag ${j.withdrawals.overdue ? 'bad' : j.withdrawals.pending ? 'warn' : 'mut'}">${j.withdrawals.pending} withdrawal${j.withdrawals.pending === 1 ? '' : 's'} pending${j.withdrawals.overdue ? ' · ' + j.withdrawals.overdue + ' overdue' : ''}</span><span class="tag ${j.log_requests_pending ? 'warn' : 'mut'}">${j.log_requests_pending} log request${j.log_requests_pending === 1 ? '' : 's'}</span><span class="tag mut">${j.contacts.total || 0} numbers · ${j.contacts.unassigned || 0} unassigned · ${j.contacts.fresh || 0} not called</span></div>
      <div class="card"><h2>Callers</h2><div class="tw"><table><tr>${TOT_HEAD.map((h, i) => `<th class="${i ? 'n' : ''}">${h}</th>`).join('')}</tr>${rows.map(r => `<tr><td><b>${esc(r.user.name)}</b>${r.user.active ? '' : ' <span class="tag mut">inactive</span>'}</td>${totRow(r).slice(1).map(v => `<td class="n">${v}</td>`).join('')}</tr>${r.flags.length ? `<tr><td colspan="10">${r.flags.map(f => `<div class="flag">⚠ ${esc(f)}</div>`).join('')}</td></tr>` : ''}`).join('') || '<tr><td colspan="10" class="mut">No callers yet — add one under Callers.</td></tr>'}</table></div>
      <p class="mut small">Rates: ${rs(j.settings.call_rate)} per counted call · ${rs(j.settings.lead_rate)} per interested lead · min ${j.settings.min_duration}s · repeat window ${j.settings.repeat_hours} h</p></div>`;
    $$('[data-r]').forEach(b => b.onclick = () => { dashRange = b.dataset.r; renderAdmin('dash'); });
    $('#dx').onclick = () => exportX(`rs-calling-dashboard-${rg[0]}_${rg[1]}`, [{ name: 'Callers', rows: [TOT_HEAD, ...rows.map(totRow), ['Total', t.made, t.connected, t.counted, '', t.leads, rs(t.call_amount), rs(t.lead_amount), rs(t.adjust), rs(t.payout)]] }, { name: 'Flags', rows: [['Caller', 'Flag'], ...rows.flatMap(r => r.flags.map(f => [r.user.name, f]))] }]);
    $('#dp').onclick = () => exportP(`rs-calling-dashboard-${rg[0]}_${rg[1]}`, 'R&S Calling — Caller report', `${rg[0]} to ${rg[1]}`, TOT_HEAD, [...rows.map(totRow), ['Total', t.made, t.connected, t.counted, '', t.leads, rs(t.call_amount), rs(t.lead_amount), rs(t.adjust), rs(t.payout)]]);
  };

  let numQ = { q: '', assigned: '', status: '', offset: 0 };
  ADMIN.numbers = async (main) => {
    await callers(); const j = await api('contacts_list', { ...numQ, limit: 200 });
    main.innerHTML = `<div class="card" id="upcard"><h2>Upload client numbers</h2><p class="mut small" style="margin:0 0 8px">Excel (.xlsx, .xls) or CSV, up to 5 MB and 20,000 rows. The app finds the phone-number column for you. You check the preview before anything is saved. Landlines, repeats and numbers that are not 10-digit Indian mobiles are skipped.</p><div class="drop"><input type="file" id="uf" accept=".xlsx,.xls,.csv"> <a href="#" id="tpl" class="small">Download a sample file</a></div><div id="up"></div></div>
      <div class="card"><h2>Recent uploads</h2><div id="blist" class="mut small">Loading…</div></div>
      <div class="card" id="uhist"></div>
      <div class="card"><h2>All numbers <span class="mut small">(${j.counts.total || 0} total · ${j.counts.unassigned || 0} unassigned)</span></h2>
      <div class="row"><input id="nq" placeholder="Search" value="${esc(numQ.q)}" class="grow" style="min-width:140px"><select id="na"><option value="">Everyone</option><option value="none" ${numQ.assigned === 'none' ? 'selected' : ''}>Unassigned</option>${callersCache.map(c => `<option value="${c.id}" ${numQ.assigned === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <select id="ns"><option value="">Any status</option>${['new', ...Object.keys(OUT)].map(s => `<option value="${s}" ${numQ.status === s ? 'selected' : ''}>${s === 'new' ? 'Not called' : OUT[s]}</option>`).join('')}</select><button class="btn sec" id="ngo">Filter</button></div>
      <div class="row" style="margin:10px 0"><span class="small mut" id="nsel">0 selected</span><select id="bto">${callerOpts('', 'Assign selected to…')}</select><button class="btn sm" id="bas">Assign</button><button class="btn sm sec" id="brr">Share equally (round-robin)</button><button class="btn sm sec" id="bun">Unassign</button><button class="btn sm red" id="bdel">Delete</button><button class="btn sm sec" id="brra" title="All unassigned numbers">Share all unassigned</button></div>
      <div class="tw"><table><tr><th><input type="checkbox" id="call"></th><th>Name</th><th>Phone</th><th>Area</th><th>Assigned to</th><th>Status</th><th>Last call</th><th>Notes</th></tr>${j.contacts.map(c => `<tr><td><input type="checkbox" class="cx" value="${c.id}"></td><td>${esc(c.name)}</td><td>${esc(c.phone)}</td><td>${esc(c.area)}</td><td>${esc(c.caller_name || '—')}</td><td>${c.status === 'new' ? '<span class="tag mut">Not called</span>' : esc(OUT[c.status] || c.status)}</td><td>${fmtT(c.last_call_at)}</td><td class="small">${esc(c.notes)}${c.last_note ? `<div>“${esc(c.last_note)}”</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="mut">No numbers yet — upload a file above.</td></tr>'}</table></div>
      <div class="row" style="margin-top:8px"><span class="mut small">Showing ${j.contacts.length ? numQ.offset + 1 : 0}–${numQ.offset + j.contacts.length} of ${j.total}</span>${numQ.offset ? '<button class="btn sm sec" id="npv">Previous</button>' : ''}${numQ.offset + j.contacts.length < j.total ? '<button class="btn sm sec" id="nnx">Next</button>' : ''}</div></div>`;
    const sel = () => $$('.cx').filter(x => x.checked).map(x => x.value); const upd = () => $('#nsel').textContent = sel().length + ' selected';
    $$('.cx').forEach(x => x.onchange = upd); $('#call').onchange = e => { $$('.cx').forEach(x => x.checked = e.target.checked); upd(); };
    $('#ngo').onclick = () => { numQ = { q: $('#nq').value.trim(), assigned: $('#na').value, status: $('#ns').value, offset: 0 }; renderAdmin('numbers'); };
    $('#nq').onkeydown = e => { if (e.key === 'Enter') $('#ngo').click(); };
    if ($('#npv')) $('#npv').onclick = () => { numQ.offset = Math.max(0, numQ.offset - 200); renderAdmin('numbers'); }; if ($('#nnx')) $('#nnx').onclick = () => { numQ.offset += 200; renderAdmin('numbers'); };
    const act = async (body, msg) => { try { const r = await api(body.del ? 'contacts_delete' : 'contacts_assign', body); toast(msg.replace('#', r.n)); renderAdmin('numbers'); } catch (e) { toast(e.message); } };
    $('#bas').onclick = () => { if (!$('#bto').value) return toast('Choose a caller'); act({ ids: sel(), user_id: $('#bto').value }, '# numbers assigned'); };
    $('#brr').onclick = () => act({ ids: sel(), mode: 'rr' }, '# numbers shared between active callers');
    $('#brra').onclick = () => { if (confirm('Share ALL unassigned numbers equally between all active callers?')) act({ all_unassigned: true, mode: 'rr' }, '# numbers shared'); };
    $('#bun').onclick = () => act({ ids: sel(), user_id: null }, '# numbers unassigned');
    $('#bdel').onclick = () => { const s = sel(); if (s.length && confirm(`Delete ${s.length} number(s)? Call history stays.`)) act({ ids: s, del: true }, '# numbers deleted'); };
    $('#tpl').onclick = e => { e.preventDefault(); exportX('rs-calling-sample-numbers', [{ name: 'Numbers', rows: [['Name', 'Phone', 'Area', 'Notes'], ['Sample Client One', '9876500001', 'Lanka', 'Shop owner'], ['Sample Client Two', '+91 98765 00002', 'Sigra', '']] }]); };
    wireUpload(); loadUploadHistory();
  };
  // v1.3: every time a number came in (new, already in the list, or repeated in the same file), with who uploaded it
  let uhQ = { q: '', from: '', to: '' };
  async function loadUploadHistory() {
    const el = $('#uhist'); if (!el) return;
    el.innerHTML = `<h2>Every upload, number by number</h2><p class="mut small" style="margin:0 0 8px">A number uploaded again shows again, with the file and who uploaded it. Tap a number for its calls and payouts.</p>
      <div class="row"><input id="uq" placeholder="Number" value="${esc(uhQ.q)}" class="grow" style="min-width:120px"><input type="date" id="ufr" value="${esc(uhQ.from)}"><input type="date" id="uto" value="${esc(uhQ.to)}"><button class="btn sec" id="ugo">Filter</button></div><div id="uhl" class="mut small" style="margin-top:8px">Loading…</div>`;
    $('#ugo').onclick = () => { uhQ = { q: $('#uq').value.trim(), from: $('#ufr').value, to: $('#uto').value }; loadUploadHistory(); };
    try {
      const j = await api('uploads_list', uhQ);
      const RES = { added: 'New', dup_existing: 'Already in the list', dup_in_upload: 'Repeated in same file' };
      $('#uhl').innerHTML = j.hits.length ? `<div class="tw"><table><tr><th>When (IST)</th><th>Number</th><th>File</th><th>Result</th><th class="n">Times uploaded</th><th>With</th><th>Status</th></tr>${j.hits.map(h => `<tr><td>${fmtT(h.at)}</td><td><a href="#" data-nh="${esc(h.phone)}">${esc(h.phone)}</a></td><td>${esc(h.file_name || '')}${h.by ? '<br><span class="mut">by ' + esc(h.by) + '</span>' : ''}</td><td>${RES[h.result] || esc(h.result)}</td><td class="n">${h.times_uploaded}</td><td>${esc(h.caller_name || 'Not assigned')}</td><td>${esc(OUT[h.status] || (h.status === 'new' ? 'Not called' : h.status || 'Not called'))}${h.lead_state === 'interested' || h.lead_state === 'open' ? ' · lead' : ''}</td></tr>`).join('')}</table></div>${j.hits.length >= j.limit ? `<p class="mut small">Showing the latest ${j.limit}. Narrow the filter to see more.</p>` : ''}` : '<p class="mut small">No uploads match.</p>';
      $$('[data-nh]', el).forEach(a => a.onclick = e => { e.preventDefault(); numberSheet(a.dataset.nh, true); });
    } catch (e) { $('#uhl').textContent = e.message; }
  }

  // ---- v1.2: Excel / CSV upload with a preview, import batches and undo ----
  let upBanner = null;
  async function wireUpload() {
    if (upBanner) { $('#up').innerHTML = upBanner; upBanner = null; }
    let st = null;
    const showBatches = async () => {
      const el = $('#blist'); if (!el) return;
      try {
        const j = await api('import_list');
        if (!j.batches.length) { el.innerHTML = 'No uploads yet.'; return; }
        el.innerHTML = `<div class="tw"><table><tr><th>When (IST)</th><th>File</th><th>Added</th><th>Assigned</th><th>Skipped</th><th>Status</th><th></th></tr>${j.batches.map(b => `<tr><td>${fmtT(b.created_at)}</td><td>${esc(b.file_name)}</td><td>${b.added}</td><td>${b.assigned}</td><td>${b.dup_existing + b.invalid}</td><td>${b.status === 'undone' ? '<span class="tag mut">Undone</span>' : b.status === 'importing' ? '<span class="tag">Unfinished</span>' : 'Imported'}</td><td>${b.status === 'undone' ? '' : b.can_undo ? `<button class="btn sm red" data-undo="${esc(b.id)}">Undo</button>` : `<span class="small mut">${b.called} called, can't undo</span>`}</td></tr>`).join('')}</table></div><p class="small mut">Undo removes only that upload's numbers, and only while none of them has been called.</p>`;
        $$('[data-undo]', el).forEach(btn => btn.onclick = async () => {
          const bt = j.batches.find(x => x.id === btn.dataset.undo); if (!bt) return;
          if (!confirm(`Undo the upload "${bt.file_name}"? Its ${bt.still_here} number(s) will be removed.`)) return;
          try { const r = await api('import_undo', { import_id: bt.id }); toast(`Upload undone: ${r.removed} numbers removed`); renderAdmin('numbers'); } catch (e) { toast(e.message); }
        });
      } catch (e) { el.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
    };
    const checkExisting = async () => {
      if (!st) return; const tok = ++st.token; st.existing = null; updCounts();
      const phones = st.res.candidates.map(c => c.phone); let ex = 0;
      try {
        for (let i = 0; i < phones.length; i += 2000) { const r = await api('import_check', { phones: phones.slice(i, i + 2000) }); if (!st || tok !== st.token) return; ex += r.existing; }
        if (st && tok === st.token) { st.existing = ex; updCounts(); }
      } catch (e) { if (st && tok === st.token) { $('#cEx').textContent = '?'; toast(e.message); } }
    };
    const updCounts = () => {
      if (!st || !$('#cNew')) return; const n = st.res.counts.unique_valid;
      $('#cEx').textContent = st.existing == null ? '…' : st.existing;
      const fresh = st.existing == null ? null : Math.max(0, n - st.existing);
      $('#cNew').textContent = fresh == null ? '…' : fresh;
      const g = $('#ugo'); if (g) { g.textContent = fresh == null ? 'Checking…' : `Import ${fresh} new number${fresh === 1 ? '' : 's'}`; g.disabled = fresh == null || fresh === 0; }
    };
    const onMap = () => {
      const sheetEl = $('#usheet'); const sh = sheetEl ? sheetEl.value : st.book.chosen;
      const v = id => { const x = $('#' + id).value; return x === '' ? null : Number(x); };
      st.over = sh !== st.book.chosen ? { sheet: sh } : { sheet: sh, phone: v('mp'), name: v('mn'), area: v('ma'), source: v('ms'), notes: v('mo'), others: $('#mx').checked };
      st.book = RSI.analyseBook(st.sheets, st.over); st.res = st.book.result;
      drawPreview(); checkExisting();
    };
    const drawPreview = () => {
      const r = st.res, c = r.counts, m = r.mapping, lb = r.labels;
      const skipped = Object.entries(c.skipped_by_reason).filter(([k]) => k !== 'duplicate_in_file').reduce((a, [, v]) => a + v, 0);
      const opt = cur => `<option value="">(none)</option>` + lb.map((l, i) => `<option value="${i}" ${cur === i ? 'selected' : ''}>${esc(l)}</option>`).join('');
      const sheetSel = st.sheets.length > 1 ? `<label class="f">Sheet</label><select id="usheet">${st.sheets.map(s => `<option value="${esc(s.name)}" ${s.name === st.book.chosen ? 'selected' : ''}>${esc(s.name)} (${st.book.sheets.find(x => x.name === s.name).unique_valid} numbers)</option>`).join('')}</select>` : '';
      const reasons = Object.entries(c.skipped_by_reason).map(([k, v]) => `${v} ${esc(RSI.reasonText(k).toLowerCase())}`).join(', ');
      $('#up').innerHTML = `
        <h3 style="margin:10px 0 2px">${esc(st.name)}</h3>
        <p class="small mut" style="margin:0 0 8px">${r.header >= 0 ? `Column names taken from row ${r.headerLabel}.` : 'No column names found: the columns are read by their letters.'} Change a column below if the app picked the wrong one.</p>
        ${sheetSel}
        <div class="mapgrid">
          <div><label class="f">Phone number column</label><select id="mp">${opt(m.phone)}</select></div>
          <div><label class="f">Name column</label><select id="mn">${opt(m.name)}</select></div>
          <div><label class="f">Address / area column</label><select id="ma">${opt(m.area)}</select></div>
          <div><label class="f">Source / category column</label><select id="ms">${opt(m.source)}</select></div>
          <div><label class="f">Notes column</label><select id="mo">${opt(m.notes)}</select></div>
        </div>
        <label class="small" style="display:block;margin:8px 0"><input type="checkbox" id="mx" ${m.others && m.others.length ? 'checked' : ''}> Also take numbers from the other phone-number columns</label>
        <div class="mapgrid" style="margin:8px 0">
          <div class="stat"><b>${c.rows_read}</b><span>rows read</span></div>
          <div class="stat"><b>${c.unique_valid}</b><span>valid numbers</span></div>
          <div class="stat"><b>${c.dup_in_file}</b><span>repeated in the file</span></div>
          <div class="stat"><b id="cEx">…</b><span>already in your list</span></div>
          <div class="stat"><b id="cNew">…</b><span>new to import</span></div>
          <div class="stat"><b>${skipped}</b><span>skipped</span></div>
        </div>
        ${skipped ? `<p class="small">${reasons}. <a href="#" id="skipcsv">Download the skipped rows</a>${r.skipped.length >= 5000 ? ' (first 5,000 shown)' : ''}</p>` : '<p class="small mut">Nothing skipped.</p>'}
        <div class="tw"><table><tr><th>Row</th><th>Name</th><th>Phone</th><th>Address</th><th>Source</th></tr>${r.candidates.slice(0, 20).map(x => `<tr><td>${x.row}</td><td>${esc(x.name)}</td><td>${esc(x.phone)}</td><td class="small">${esc(x.area)}</td><td class="small">${esc(x.source)}</td></tr>`).join('') || '<tr><td colspan="5" class="mut">No numbers to show</td></tr>'}</table></div>
        <p class="small mut">First ${Math.min(20, r.candidates.length)} of ${r.candidates.length} numbers.</p>
        <label class="f">After upload</label><select id="uas"><option value="none">Keep unassigned (assign later)</option><option value="rr">Share equally between all active callers</option>${callersCache.filter(x => x.active).map(x => `<option value="u:${x.id}">Give all to ${esc(x.name)}</option>`).join('')}</select>
        <div class="row" style="margin-top:10px"><button class="btn" id="ugo" disabled>Checking…</button><button class="btn sec" id="ucancel">Cancel</button></div><div id="ures"></div>`;
      ['mp', 'mn', 'ma', 'ms', 'mo', 'mx', 'usheet'].forEach(id => { const el = $('#' + id); if (el) el.onchange = onMap; });
      if (skipped) $('#skipcsv').onclick = e => { e.preventDefault(); saveText('upload-skipped-rows.csv', RSI.skippedCsv(r), 'text/csv'); };
      $('#ucancel').onclick = () => { st = null; $('#up').innerHTML = ''; $('#uf').value = ''; };
      updCounts();
      $('#ugo').onclick = async () => {
        const cur = st; if (!cur) return; const btn = $('#ugo'); btn.disabled = true;
        const v = $('#uas').value; const assign = v === 'none' ? 'none' : v === 'rr' ? 'rr' : 'user';
        const cands = cur.res.candidates; const rc = cur.res.counts; const skippedN = Object.entries(rc.skipped_by_reason).filter(([k]) => k !== 'duplicate_in_file').reduce((a, [, x]) => a + x, 0);
        let imp = null; const tot = { added: 0, dup_existing: 0, invalid: 0, assigned: 0 };
        try {
          imp = await api('import_start', { file_name: cur.name, assign, user_id: v.startsWith('u:') ? v.slice(2) : undefined, sheet: cur.book.chosen, mapping: JSON.stringify(cur.res.mapping), rows_read: rc.rows_read, numbers_found: rc.unique_valid, invalid: skippedN, dup_in_file: rc.dup_in_file });
          for (let i = 0; i < cands.length; i += 2000) {
            $('#ures').innerHTML = `<p class="mut">Importing ${Math.min(i + 2000, cands.length)} / ${cands.length}…</p>`;
            const rr = await api('import_chunk', { import_id: imp.import_id, rows: cands.slice(i, i + 2000) });
            for (const k of Object.keys(tot)) tot[k] += rr[k];
          }
          await api('import_finish', { import_id: imp.import_id });
        } catch (e) {
          $('#ures').innerHTML = `<p class="err">The upload stopped: ${esc(e.message)}. ${imp ? 'The numbers added so far are listed under Recent uploads, where you can undo them.' : 'Nothing was added.'}</p>`; btn.disabled = false; return;
        }
        upBanner = `<div class="banner" style="background:var(--okbg);color:var(--ok)"><b>Upload done:</b> ${tot.added} new numbers added${tot.assigned ? `, ${tot.assigned} assigned` : ''}. Skipped: ${rc.dup_in_file} repeated in the file, ${tot.dup_existing} already in your list, ${skippedN} landline, invalid or without a number. Undo is under Recent uploads.</div>`;
        st = null; renderAdmin('numbers');
      };
    };
    $('#uf').onchange = async e => {
      const f = e.target.files[0]; if (!f) return; const up = $('#up');
      if (!window.RSI || !window.XLSX) { up.innerHTML = '<p class="err">The file reader did not load. Reload the page and try again.</p>'; return; }
      if (f.size > RSI.MAX_BYTES) { up.innerHTML = `<p class="err">This file is ${(f.size / 1048576).toFixed(1)} MB. The limit is 5 MB. Save a smaller file with just the lead columns and try again.</p>`; return; }
      up.innerHTML = '<p class="mut">Reading file…</p>';
      try {
        await callers();
        const sheets = RSI.readSheets(XLSX, await f.arrayBuffer());
        if (!sheets.length) throw new Error('the file has no sheets');
        const book = RSI.analyseBook(sheets, {});
        if (book.result.tooManyRows) { up.innerHTML = `<p class="err">This file has more than ${RSI.MAX_ROWS.toLocaleString('en-IN')} rows. Split it into smaller files and upload them one by one.</p>`; return; }
        if (!book.result.candidates.length) { up.innerHTML = `<p class="err">No phone numbers found in ${esc(f.name)}. The app looks for 10-digit Indian mobile numbers, such as 98765 43210, +91 98765 43210 or 098765 43210. Check that the numbers are in a column and try again.</p>`; return; }
        st = { name: f.name, sheets, book, res: book.result, over: { sheet: book.chosen }, existing: null, token: 0 };
        drawPreview(); checkExisting();
      } catch (er) { up.innerHTML = `<p class="err">Could not read the file: ${esc(er.message)}</p>`; }
    };
    showBatches();
  }

  const genPw = () => { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; const b = new Uint8Array(8); crypto.getRandomValues(b); return [...b].map(x => a[x % a.length]).join(''); };
  ADMIN.callers = async (main) => {
    const cs = await callers();
    main.innerHTML = `<div class="card"><h2>Add a caller</h2><div class="row"><div class="grow"><label class="f">Name</label><input id="cn" style="width:100%"></div><div class="grow"><label class="f">Username</label><input id="cu" autocapitalize="none" style="width:100%"></div><div class="grow"><label class="f">Mobile (optional, can log in with it)</label><input id="cp" inputmode="tel" style="width:100%"></div><div class="grow"><label class="f">Password</label><input id="cw" value="${genPw()}" style="width:100%"></div></div>
      <div class="err small" id="ce"></div><button class="btn" id="cadd" style="margin-top:10px">Add caller</button><p class="mut small">Give the caller their username and password, and the app link from the home page. They log in on their Android phone.</p></div>
      <div class="card"><h2>Callers (${cs.length})</h2><div class="tw"><table><tr><th>Name</th><th>Username</th><th>Mobile</th><th class="n">Numbers</th><th class="n">Logged-in devices</th><th>Status</th><th>Terms</th><th>Payment</th><th></th></tr>${cs.map(c => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.username)}</td><td>${esc(c.phone || '')}</td><td class="n">${c.assigned}</td><td class="n">${c.sessions}</td><td>${c.active ? '<span class="tag ok">Active</span>' : '<span class="tag bad">Deactivated</span>'}</td><td>${c.terms_version ? `<span class="tag ok">v${c.terms_version}</span>` : '<span class="tag mut">Not accepted</span>'}</td><td>${c.has_payment ? '<span class="tag ok">Added</span>' : '<span class="tag mut">None</span>'}</td>
        <td><div class="row"><button class="btn sm sec" data-e="${c.id}">Edit</button><button class="btn sm sec" data-payv="${c.id}">Payment details</button><button class="btn sm sec" data-pw="${c.id}">Reset password</button>${c.active ? `<button class="btn sm sec" data-off="${c.id}">Deactivate</button>` : `<button class="btn sm green" data-on="${c.id}">Activate</button>`}<button class="btn sm sec" data-lo="${c.id}">Log out everywhere</button><button class="btn sm red" data-rm="${c.id}">Remove</button></div></td></tr>`).join('') || '<tr><td colspan="9" class="mut">No callers yet</td></tr>'}</table></div></div>`;
    $('#cadd').onclick = async () => {
      try { const pw = $('#cw').value; await api('caller_save', { name: $('#cn').value, username: $('#cu').value, phone: $('#cp').value, password: pw }); sheet(`<h2 style="margin-top:0">Caller added ✅</h2><p>Send these login details to <b>${esc($('#cn').value)}</b>:</p><div class="card">Username: <b>${esc($('#cu').value.toLowerCase())}</b><br>Password: <b>${esc(pw)}</b><br>App: <b>${esc(location.origin)}</b></div><button class="btn" style="width:100%" onclick="this.closest('.sheet').remove()">Done</button>`); renderAdmin('callers'); }
      catch (e) { $('#ce').textContent = e.message; }
    };
    const byId = id => cs.find(c => c.id === id);
    $$('[data-payv]').forEach(b => b.onclick = async () => { const c = byId(b.dataset.payv); try { const p = (await api('payment_get', { user_id: c.id })).payment; sheet(`<div class="row"><b class="grow">${esc(c.name)} — payment details</b><button class="btn sm sec" onclick="this.closest('.sheet').remove()">Close</button></div>${p ? `<div class="kv">${p.upi ? `<div><span>UPI ID</span><b>${esc(p.upi)}</b></div>` : ''}${p.account_no ? `<div><span>Account holder</span><b>${esc(p.holder)}</b></div><div><span>Account number</span><b>${esc(p.account_no)}</b></div><div><span>IFSC</span><b>${esc(p.ifsc)}</b></div><div><span>Bank</span><b>${esc(p.bank)}</b></div>` : ''}</div><p class="mut small">Viewing is recorded in the Activity log.</p>` : '<p class="mut">No payment details added yet.</p>'}`); } catch (e) { toast(e.message); } });
    $$('[data-e]').forEach(b => b.onclick = () => { const c = byId(b.dataset.e); sheet(`<h2 style="margin-top:0">Edit caller</h2><label class="f">Name</label><input id="en" value="${esc(c.name)}" style="width:100%"><label class="f">Username</label><input id="eu" value="${esc(c.username)}" style="width:100%"><label class="f">Mobile</label><input id="ep" value="${esc(c.phone || '')}" style="width:100%"><div class="err small" id="ee"></div><div class="row" style="margin-top:12px"><button class="btn" id="es">Save</button><button class="btn sec" id="ec">Cancel</button></div>`, s => { $('#ec', s).onclick = () => s.remove(); $('#es', s).onclick = async () => { try { await api('caller_save', { id: c.id, name: $('#en', s).value, username: $('#eu', s).value, phone: $('#ep', s).value }); s.remove(); renderAdmin('callers'); } catch (e) { $('#ee', s).textContent = e.message; } }; }); });
    $$('[data-pw]').forEach(b => b.onclick = async () => { const c = byId(b.dataset.pw); const pw = genPw(); if (!confirm(`Reset ${c.name}'s password? They will be logged out on all devices.`)) return; try { await api('caller_save', { id: c.id, name: c.name, username: c.username, phone: c.phone, password: pw }); sheet(`<h2 style="margin-top:0">New password</h2><p>${esc(c.name)} — username <b>${esc(c.username)}</b></p><div class="card" style="font-size:20px"><b>${esc(pw)}</b></div><button class="btn" style="width:100%" onclick="this.closest('.sheet').remove()">Done</button>`); } catch (e) { toast(e.message); } });
    const tog = (id, active) => api('caller_save', { ...byId(id), active }).then(() => { toast(active ? 'Activated' : 'Deactivated and logged out'); renderAdmin('callers'); }).catch(e => toast(e.message));
    $$('[data-off]').forEach(b => b.onclick = () => confirm('Deactivate this caller? They are logged out immediately and cannot log in.') && tog(b.dataset.off, false));
    $$('[data-on]').forEach(b => b.onclick = () => tog(b.dataset.on, true));
    $$('[data-lo]').forEach(b => b.onclick = () => api('session_revoke', { user_id: b.dataset.lo }).then(() => { toast('Logged out on all devices'); renderAdmin('callers'); }).catch(e => toast(e.message)));
    $$('[data-rm]').forEach(b => b.onclick = () => { const c = byId(b.dataset.rm); if (confirm(`Remove ${c.name}? Their numbers become unassigned. Past calls and payouts are kept.`)) api('caller_delete', { id: c.id }).then(() => { toast('Removed'); renderAdmin('callers'); }).catch(e => toast(e.message)); });
  };

  let callQ = { from: '', to: '', user_id: '', counted: '' };
  ADMIN.calls = async (main) => {
    await callers(); if (!callQ.from) { callQ.from = today(); callQ.to = today(); }
    const [j, cbj] = await Promise.all([api('calls_list', callQ), api('callbacks_list', { from: callQ.from, to: callQ.to, user_id: callQ.user_id })]);
    const head = ['Time', 'Caller', 'Client', 'Phone', 'Talk', 'Result', 'Counted', 'Reason', 'Lead', 'Note'];
    const rowOf = c => [fmtT(c.start_ts || c.tapped_at), c.caller_name, c.contact_name || '', c.phone, c.log_found ? fmtD(c.duration) : 'not in log', c.outcome_label, c.counted ? 'Yes' : 'No', c.reason_text + (c.override_reason ? ' — ' + c.override_reason : ''), c.lead_counted ? 'Yes' : (c.outcome === 'interested' ? 'No: ' + (c.lead_reason || '') : ''), c.note || ''];
    main.innerHTML = `<div class="card"><div class="row"><label>From <input type="date" id="f1" value="${callQ.from}"></label><label>To <input type="date" id="f2" value="${callQ.to}"></label><select id="fu">${callerOpts(callQ.user_id)}</select><select id="fc"><option value="">Counted + not counted</option><option value="1" ${callQ.counted === '1' ? 'selected' : ''}>Counted only</option><option value="0" ${callQ.counted === '0' ? 'selected' : ''}>Not counted only</option></select><button class="btn" id="fgo">Show</button><span class="grow"></span><button class="btn sec sm" id="cx">Excel</button><button class="btn sec sm" id="cpd">PDF</button></div></div>
      <div class="card"><h2>${j.total} calls</h2><div class="tw"><table><tr><th>Time</th><th>Caller</th><th>Client</th><th class="n">Talk</th><th>Result</th><th>Counted?</th><th>Lead</th><th></th></tr>${j.calls.map(c => `<tr><td>${fmtT(c.start_ts || c.tapped_at)}</td><td>${esc(c.caller_name)}</td><td>${esc(c.contact_name || '')}<div class="small mut">${esc(c.phone)}</div>${c.note ? `<div class="small">“${esc(c.note)}”</div>` : ''}</td><td class="n">${c.log_found ? fmtD(c.duration) : '<span class="mut">—</span>'}</td><td>${esc(c.outcome_label)}${c.callback_at ? `<div class="small mut">${fmtT(c.callback_at)}</div>` : ''}</td>
        <td>${c.counted ? '<span class="tag ok">Counted</span>' : '<span class="tag bad">Not counted</span>'}<div class="small mut">${esc(c.reason_text)}${c.override_reason ? ' — ' + esc(c.override_reason) : ''}</div></td><td>${c.lead_counted ? '<span class="tag ok">Lead</span>' : c.outcome === 'interested' ? `<span class="small mut">${esc(c.lead_reason || '')}</span>` : ''}</td>
        <td>${c.approval_id ? '<span class="tag mut">Approved</span>' : `<button class="btn sm sec" data-ov="${c.id}">Change</button>`}</td></tr>`).join('') || '<tr><td colspan="8" class="mut">No calls in this period</td></tr>'}</table></div></div>
      <div class="card"><h2>${cbj.total} callback${cbj.total === 1 ? '' : 's'} received</h2><p class="small mut" style="margin-top:-6px">Incoming or missed calls from a number the caller previously called from the app. ${cbj.callbacks.some(x => x.counted) ? '' : 'Recorded only — not paid (change under Settings).'}</p><div class="tw"><table><tr><th>Time</th><th>Caller</th><th>Client</th><th class="n">Talk</th><th>Type</th><th>Paid?</th></tr>${cbj.callbacks.map(b => `<tr><td>${fmtT(b.start_ts)}</td><td>${esc(b.caller_name)}</td><td>${esc(b.contact_name || '')}<div class="small mut">${esc(b.phone)}</div></td><td class="n">${b.duration ? fmtD(b.duration) : '—'}</td><td>${b.kind === 'incoming' ? '<span class="tag ok">Callback received</span>' : '<span class="tag warn">Missed</span>'}${b.returned_at ? '<div class="small mut">caller called back</div>' : ''}</td><td>${b.counted ? '<span class="tag ok">Counted</span>' : '<span class="mut small">' + esc(b.reason || '') + '</span>'}</td></tr>`).join('') || '<tr><td colspan="6" class="mut">No callbacks in this period</td></tr>'}</table></div></div>`;
    $('#fgo').onclick = () => { callQ = { from: $('#f1').value, to: $('#f2').value, user_id: $('#fu').value, counted: $('#fc').value }; renderAdmin('calls'); };
    $('#cx').onclick = () => exportX(`rs-calling-calls-${j.from}_${j.to}`, [{ name: 'Calls', rows: [head, ...j.calls.map(rowOf)] }]);
    $('#cpd').onclick = () => exportP(`rs-calling-calls-${j.from}_${j.to}`, 'R&S Calling — Calls', `${j.from} to ${j.to} · ${j.total} calls`, head.slice(0, 9), j.calls.map(c => rowOf(c).slice(0, 9)));
    $$('[data-ov]').forEach(b => b.onclick = () => { const c = j.calls.find(x => x.id === b.dataset.ov); sheet(`<h2 style="margin-top:0">Change counting</h2><p class="small">${esc(c.caller_name)} → ${esc(c.contact_name || c.phone)} · ${fmtT(c.start_ts || c.tapped_at)} · ${c.log_found ? fmtD(c.duration) : 'not in call log'}<br>Now: <b>${c.counted ? 'Counted' : 'Not counted'}</b> (${esc(c.reason_text)})</p>
      <label class="f">Call</label><select id="ovv" style="width:100%"><option value="auto" ${c.override == null ? 'selected' : ''}>Automatic (rules)</option><option value="1" ${c.override === 1 ? 'selected' : ''}>Count this call</option><option value="0" ${c.override === 0 ? 'selected' : ''}>Do not count this call</option></select>
      ${c.outcome === 'interested' ? `<label class="f">Interested lead</label><select id="ovl" style="width:100%"><option value="auto">Automatic</option><option value="0" ${c.lead_override === 0 ? 'selected' : ''}>Reject this lead</option></select>` : ''}
      <label class="f">Reason (required)</label><input id="ovr" style="width:100%" value="${esc(c.override_reason || '')}"><div class="err small" id="ove"></div><div class="row" style="margin-top:12px"><button class="btn" id="ovs">Save</button><button class="btn sec" id="ovc">Cancel</button></div>`, s => {
      $('#ovc', s).onclick = () => s.remove();
      $('#ovs', s).onclick = async () => { try { const v = $('#ovv', s).value; const reason = $('#ovr', s).value; await api('call_override', { id: c.id, value: v === 'auto' ? null : Number(v), reason }); if ($('#ovl', s)) await api('call_override', { id: c.id, kind: 'lead', value: $('#ovl', s).value === '0' ? 0 : null, reason }); s.remove(); toast('Saved'); renderAdmin('calls'); } catch (e) { $('#ove', s).textContent = e.message; } };
    }); });
  };

  let payQ = { from: '', to: '' };
  ADMIN.payouts = async (main) => {
    await callers(); if (!payQ.from) { payQ.from = today().slice(0, 8) + '01'; payQ.to = today(); }
    const j = await api('payout_report', { ...payQ, daily: true }); const t = sum(j.rows);
    main.innerHTML = `<div class="card"><div class="row"><label>From <input type="date" id="p1" value="${payQ.from}"></label><label>To <input type="date" id="p2" value="${payQ.to}"></label><button class="btn" id="pgo">Show</button><span class="grow"></span><button class="btn sec sm" id="px">Excel</button><button class="btn sec sm" id="ppd">PDF</button></div>
      <p class="mut small">${rs(j.settings.call_rate)} per counted call · ${rs(j.settings.lead_rate)} per interested lead · change under Settings. Each call keeps the rate that was set when it was made.</p></div>
      <div class="card"><h2>Payout ${j.from} → ${j.to}: ${rs(t.payout || 0)}</h2><div class="tw"><table><tr><th>Caller</th><th class="n">Counted calls</th><th class="n">Call pay</th><th class="n">Leads</th><th class="n">Lead pay</th><th class="n">Callbacks</th><th class="n">Adjustments</th><th class="n">Total</th><th></th></tr>${j.rows.map(r => `<tr><td><b>${esc(r.user.name)}</b><div class="small mut">${r.made} calls · ${r.connected} connected</div></td><td class="n">${r.counted}</td><td class="n">${rs(r.call_amount)}</td><td class="n">${r.leads}</td><td class="n">${rs(r.lead_amount)}</td><td class="n">${rs(r.callback_amount)}</td><td class="n">${rs(r.adjust)}</td><td class="n"><b>${rs(r.payout)}</b></td><td><div class="row"><button class="btn sm sec" data-adj="${r.user.id}">+ / − Adjust</button><button class="btn sm green" data-ap="${r.user.id}">Approve</button></div></td></tr>${r.flags.length ? `<tr><td colspan="9">${r.flags.map(f => `<div class="flag">⚠ ${esc(f)}</div>`).join('')}</td></tr>` : ''}`).join('')}</table></div></div>
      <div class="card"><h2>Adjustments in this period</h2><div class="tw"><table><tr><th>Date</th><th>Caller</th><th class="n">Amount</th><th>Reason</th><th></th></tr>${j.adjustments.map(a => `<tr><td>${a.day}</td><td>${esc((callersCache.find(c => c.id === a.user_id) || {}).name || '')}</td><td class="n">${rs(a.amount)}</td><td>${esc(a.reason)}</td><td>${a.approval_id ? '<span class="tag mut">Approved</span>' : `<button class="btn sm sec" data-ad="${a.id}">Delete</button>`}</td></tr>`).join('') || '<tr><td colspan="5" class="mut">None</td></tr>'}</table></div></div>
      <div class="card"><h2>Approved payouts</h2><p class="small mut" style="margin-top:-6px">Approved amounts become the caller's withdrawable balance. Callers withdraw from the app and you pay under Withdrawals. Tick “Already paid” only for amounts you paid outside the app — those are removed from the balance.</p><div class="tw"><table><tr><th>Caller</th><th>Period</th><th class="n">Counted</th><th class="n">Leads</th><th class="n">Adjust</th><th class="n">Amount</th><th>Approved</th><th>Paid?</th><th></th></tr>${j.approvals.map(a => `<tr><td>${esc(a.name)}</td><td>${a.from_day} → ${a.to_day}</td><td class="n">${a.counted}</td><td class="n">${a.leads}</td><td class="n">${rs(a.adjust)}</td><td class="n"><b>${rs(a.payout)}</b></td><td class="small">${fmtT(a.approved_at)}${a.note ? '<br>' + esc(a.note) : ''}</td><td>${a.paid ? '<span class="tag ok">Paid outside the app</span>' : '<span class="tag warn">Available to withdraw</span>'}</td><td><div class="row"><button class="btn sm sec" data-paid="${a.id}" data-v="${a.paid ? 0 : 1}">${a.paid ? 'Mark unpaid' : 'Mark paid'}</button><button class="btn sm sec" data-un="${a.id}">Undo</button></div></td></tr>`).join('') || '<tr><td colspan="9" class="mut">None yet</td></tr>'}</table></div></div>`;
    $('#pgo').onclick = () => { payQ = { from: $('#p1').value, to: $('#p2').value }; renderAdmin('payouts'); };
    const head = ['Caller', 'Calls made', 'Connected', 'Counted calls', 'Call pay', 'Interested leads', 'Lead pay', 'Callback pay', 'Adjustments', 'Total payout'];
    const row = r => [r.user.name, r.made, r.connected, r.counted, rs(r.call_amount), r.leads, rs(r.lead_amount), rs(r.callback_amount), rs(r.adjust), rs(r.payout)];
    const tr = ['Total', t.made, t.connected, t.counted, rs(t.call_amount), t.leads, rs(t.lead_amount), rs(t.callback_amount), rs(t.adjust), rs(t.payout)];
    $('#px').onclick = () => exportX(`rs-calling-payout-${j.from}_${j.to}`, [{ name: 'Payout', rows: [head, ...j.rows.map(row), tr] }, { name: 'Daily', rows: [['Date', ...head], ...j.days.flatMap(d => d.rows.filter(r => r.made || r.adjust).map(r => [d.day, ...row(r)]))] }, { name: 'Adjustments', rows: [['Date', 'Caller', 'Amount', 'Reason'], ...j.adjustments.map(a => [a.day, (callersCache.find(c => c.id === a.user_id) || {}).name || '', a.amount, a.reason])] }]);
    $('#ppd').onclick = () => exportP(`rs-calling-payout-${j.from}_${j.to}`, 'R&S Calling — Payout report', `${j.from} to ${j.to} · ${rs(j.settings.call_rate)} per counted call, ${rs(j.settings.lead_rate)} per lead`, head, [...j.rows.map(row), tr]);
    $$('[data-adj]').forEach(b => b.onclick = () => { const c = callersCache.find(x => x.id === b.dataset.adj); sheet(`<h2 style="margin-top:0">Adjust ${esc(c.name)}'s pay</h2><label class="f">Date</label><input type="date" id="ajd" value="${payQ.to}" style="width:100%"><label class="f">Amount in ₹ (use minus for a deduction, e.g. -50)</label><input id="aja" inputmode="decimal" style="width:100%"><label class="f">Reason (required)</label><input id="ajr" style="width:100%"><div class="err small" id="aje"></div><div class="row" style="margin-top:12px"><button class="btn" id="ajs">Add</button><button class="btn sec" id="ajc">Cancel</button></div>`, s => { $('#ajc', s).onclick = () => s.remove(); $('#ajs', s).onclick = async () => { try { await api('adjustment_add', { user_id: c.id, day: $('#ajd', s).value, amount: $('#aja', s).value, reason: $('#ajr', s).value }); s.remove(); renderAdmin('payouts'); } catch (e) { $('#aje', s).textContent = e.message; } }; }); });
    $$('[data-ap]').forEach(b => b.onclick = () => { const r = j.rows.find(x => x.user.id === b.dataset.ap); sheet(`<h2 style="margin-top:0">Approve payout</h2><p><b>${esc(r.user.name)}</b> · ${j.from} → ${j.to}</p><p>${r.counted} counted calls (${rs(r.call_amount)}) + ${r.leads} leads (${rs(r.lead_amount)}) + adjustments ${rs(r.adjust)} ${r.callback_amount ? ` + callbacks (${rs(r.callback_amount)})` : ''} = <b>${rs(r.payout)}</b></p><p class="mut small">After approval these calls are locked (rules and rate changes won't change them). You can undo it later.</p><label class="f">Note (optional)</label><input id="apn" style="width:100%"><label style="display:block;margin-top:8px"><input type="checkbox" id="app"> Already paid</label><div class="row" style="margin-top:12px"><button class="btn green" id="aps">Approve ${rs(r.payout)}</button><button class="btn sec" id="apc">Cancel</button></div>`, s => { $('#apc', s).onclick = () => s.remove(); $('#aps', s).onclick = async () => { try { await api('payout_approve', { user_id: r.user.id, from: j.from, to: j.to, note: $('#apn', s).value, paid: $('#app', s).checked }); s.remove(); toast('Approved'); renderAdmin('payouts'); } catch (e) { toast(e.message); } }; }); });
    $$('[data-ad]').forEach(b => b.onclick = () => confirm('Delete this adjustment?') && api('adjustment_delete', { id: b.dataset.ad }).then(() => renderAdmin('payouts')).catch(e => toast(e.message)));
    $$('[data-paid]').forEach(b => b.onclick = () => api('payout_mark_paid', { id: b.dataset.paid, paid: b.dataset.v === '1' }).then(() => renderAdmin('payouts')));
    $$('[data-un]').forEach(b => b.onclick = () => { const reason = prompt('Undo this approval? Reason:'); if (reason) api('payout_unapprove', { id: b.dataset.un, reason }).then(() => renderAdmin('payouts')).catch(e => toast(e.message)); });
  };

  let leadTab = 'open';
  ADMIN.leads = async (main) => {
    const j = await api('leads_list', { state: leadTab }); const now = Date.now();
    const head = ['Name', 'Phone', 'Area', 'Caller', 'Status', 'Interested on', 'Callback', 'Follow-up', 'Last note', 'Lead state', 'Callback received'];
    const row = c => [c.name, c.phone, c.area, c.caller_name || '', OUT[c.status] || c.status, fmtT(c.interested_at), fmtT(c.callback_at), fmtT(c.followup_at), c.last_note || '', c.lead_state || '', c.cb_last_at ? fmtT(c.cb_last_at) + (c.cb_last_dur ? ' · ' + fmtD(c.cb_last_dur) : ' · missed') : ''];
    main.innerHTML = `<div class="row" style="margin-bottom:10px"><div class="pill">${[['open', 'Open leads'], ['callback', 'Callbacks'], ['won', 'Won'], ['closed', 'Closed'], ['all', 'All']].map(r => `<button data-l="${r[0]}" class="${r[0] === leadTab ? 'on' : ''}">${r[1]}</button>`).join('')}</div><span class="grow"></span><button class="btn sec sm" id="lx">Excel</button><button class="btn sec sm" id="lp">PDF</button></div>
      <div class="card"><h2>${j.leads.length} ${leadTab === 'callback' ? 'callbacks' : 'leads'}</h2><div class="tw"><table><tr><th>Client</th><th>Caller</th><th>Status</th><th>Reminder</th><th>Last note</th><th></th></tr>${j.leads.map(c => { const due = c.followup_at || c.callback_at; return `<tr><td><b>${esc(c.name || 'Client')}</b><div class="small"><a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>${c.area ? ' · ' + esc(c.area) : ''}</div></td><td>${esc(c.caller_name || '—')}</td><td>${esc(OUT[c.status] || c.status)}${c.lead_state ? ` <span class="tag ${c.lead_state === 'won' ? 'ok' : c.lead_state === 'closed' ? 'mut' : 'warn'}">${c.lead_state}</span>` : ''}<div class="small mut">${c.interested_at ? 'Interested ' + fmtT(c.interested_at) : ''}</div>${c.cb_last_at ? `<div class="small"><span class="tag ok">Callback received</span> ${fmtT(c.cb_last_at)}${c.cb_last_dur ? ' · ' + fmtD(c.cb_last_dur) : ' · missed'}</div>` : ''}</td>
        <td>${due ? `<span class="${due < now ? 'due' : ''}">${due < now ? 'Overdue · ' : ''}${fmtT(due)}</span><div class="small mut">${c.followup_at ? 'Your follow-up' : 'Caller callback'}</div>` : '<span class="mut">—</span>'}${c.followup_note ? `<div class="small">${esc(c.followup_note)}</div>` : ''}</td><td class="small">${esc(c.last_note || '')}</td><td><button class="btn sm sec" data-fu="${c.id}">Follow-up</button></td></tr>`; }).join('') || '<tr><td colspan="6" class="mut">Nothing here</td></tr>'}</table></div></div>`;
    $$('[data-l]').forEach(b => b.onclick = () => { leadTab = b.dataset.l; renderAdmin('leads'); });
    $('#lx').onclick = () => exportX('rs-calling-leads-' + leadTab, [{ name: 'Leads', rows: [head, ...j.leads.map(row)] }]);
    $('#lp').onclick = () => exportP('rs-calling-leads-' + leadTab, 'R&S Calling — Leads', `${leadTab} · ${j.leads.length}`, head, j.leads.map(row));
    $$('[data-fu]').forEach(b => b.onclick = () => { const c = j.leads.find(x => x.id === b.dataset.fu); const v = c.followup_at ? new Date(c.followup_at + TZ * 60000).toISOString().slice(0, 16) : '';
      sheet(`<h2 style="margin-top:0">${esc(c.name || c.phone)}</h2><p class="small"><a href="tel:${esc(c.phone)}">${esc(c.phone)}</a> · ${esc(c.caller_name || '')}</p><label class="f">Follow-up reminder (date &amp; time)</label><input type="datetime-local" id="fua" value="${v}" style="width:100%"><label class="f">Follow-up note</label><input id="fun" value="${esc(c.followup_note || '')}" style="width:100%"><label class="f">Lead state</label><select id="fus" style="width:100%">${['open', 'won', 'closed'].map(x => `<option ${((c.lead_state || 'open') === x) ? 'selected' : ''}>${x}</option>`).join('')}</select><div class="row" style="margin-top:12px"><button class="btn" id="fuv">Save</button><button class="btn sec" id="fuc">Cancel</button></div>`, s => {
        $('#fuc', s).onclick = () => s.remove(); $('#fuv', s).onclick = async () => { const a = $('#fua', s).value; try { await api('lead_update', { id: c.id, followup_at: a ? Date.parse(a + ':00+05:30') : null, followup_note: $('#fun', s).value, lead_state: $('#fus', s).value }); s.remove(); renderAdmin('leads'); } catch (e) { toast(e.message); } }; }); });
  };

  ADMIN.settings = async (main) => {
    const s = (await api('settings_get')).settings; const N = (id, k, lab, hint) => `<div class="grow"><label class="f">${lab}</label><input id="${id}" inputmode="decimal" value="${s[k]}" style="width:100%">${hint ? `<div class="small mut">${hint}</div>` : ''}</div>`;
    main.innerHTML = `<div class="card"><h2>Payout &amp; counting rules</h2><div class="row">${N('s1', 'call_rate', '₹ per counted call')}${N('s2', 'lead_rate', '₹ per Interested lead')}</div>
      <div class="row">${N('s3', 'min_duration', 'Minimum call duration to count (seconds)')}${N('s4', 'repeat_hours', 'Repeat calls to the same number count once within (hours)')}</div>
      <label style="display:block;margin-top:10px"><input type="checkbox" id="s5"> Apply the new ₹ rates to all calls that are not yet approved (otherwise they apply to new calls only)</label></div>
      <div class="card"><h2>Daily task &amp; streak</h2><div class="row">${N('s8', 'daily_target', 'Daily task: counted calls per day', 'A day counts for the streak when the caller reaches this.')}${N('s9', 'streak_bonus_7', '₹ bonus at a 7-day streak', '0 = no bonus')}${N('s10', 'streak_bonus_30', '₹ bonus at a 30-day streak', '0 = no bonus')}</div></div>
      <div class="card"><h2>Withdrawals &amp; call logs</h2><div class="row">${N('s6', 'min_withdrawal', 'Minimum withdrawal (₹)')}${N('s11', 'withdraw_hours', 'Payment deadline (hours)', 'Shown to callers; overdue requests are highlighted.')}${N('s7', 'retention_days', 'Keep caller log copies on the phone for (days)', 'After they are synced. The server keeps everything.')}${N('s12', 'log_access_hours', 'Approved log requests stay open for (hours)')}</div></div>
      <div class="card"><h2>Callbacks</h2><label style="display:block"><input type="checkbox" id="s13" ${s.callback_counts ? 'checked' : ''}> Pay the per-call rate for a callback (incoming call of at least the minimum duration from a number the caller called from the app)</label><div class="row" style="margin-top:8px">${N('s14', 'callback_window_days', 'A call from that number counts as a callback for (days after the last app call)')}</div><p class="small mut">Off: callbacks are recorded and shown with the client but not paid. They are never counted as a normal call twice.</p></div>
      <div class="err small" id="se"></div><button class="btn" id="ssv">Save settings</button>
      <div class="card" style="margin-top:12px"><h2>How a call is counted</h2><ol class="small"><li>Placed from the R&amp;S Calling app, to a number on that caller's assigned list.</li><li>Found in the phone's call history with the same number and time.</li><li>Connected and lasted at least the minimum duration.</li><li>Not a same-time (overlapping) call.</li><li>Not a repeat call to the same number inside the repeat window (any caller).</li></ol>
      <p class="small">An <b>Interested</b> result earns the lead amount once per client, if that call connected for at least the minimum duration. You can override any call or reject a lead on the Calls page (a reason is required). Suspicious patterns are flagged on the Dashboard and Payouts pages.</p><button class="btn sec sm" id="rca">Re-check all calls now</button></div>`;
    $('#ssv').onclick = async () => { try { const r = await api('settings_save', { call_rate: $('#s1').value, lead_rate: $('#s2').value, min_duration: $('#s3').value, repeat_hours: $('#s4').value, min_withdrawal: $('#s6').value, retention_days: $('#s7').value, daily_target: $('#s8').value, streak_bonus_7: $('#s9').value, streak_bonus_30: $('#s10').value, withdraw_hours: $('#s11').value, log_access_hours: $('#s12').value, callback_counts: $('#s13').checked ? 1 : 0, callback_window_days: $('#s14').value, apply_rates_to_unapproved: $('#s5').checked }); toast('Saved' + (r.recalculated ? ` · ${r.recalculated} calls re-checked` : '') + (r.rated ? ` · new rates on ${r.rated} calls` : '')); renderAdmin('settings'); } catch (e) { $('#se').textContent = e.message; } };
    $('#rca').onclick = async () => { const r = await api('recalc_all'); toast(r.n + ' calls re-checked'); };
  };
  ADMIN.devices = async (main) => {
    const j = await api('sessions_list');
    main.innerHTML = `<div class="card"><h2>Logged-in devices (${j.sessions.length})</h2><div class="tw"><table><tr><th>User</th><th>App</th><th>Device</th><th>Logged in</th><th>Last active</th><th></th></tr>${j.sessions.map(x => `<tr><td><b>${esc(x.name)}</b><div class="small mut">${esc(x.username)} · ${x.role}</div></td><td>${x.app === 'android' ? 'Android app' : 'Web'}</td><td class="small">${esc(x.device)}</td><td>${fmtT(x.created_at)}</td><td>${fmtT(x.last_seen)}</td><td>${x.current ? '<span class="tag ok">This device</span>' : `<button class="btn sm sec" data-so="${x.id}">Log out</button>`}</td></tr>`).join('')}</table></div></div>`;
    $$('[data-so]').forEach(b => b.onclick = () => api('session_revoke', { id: b.dataset.so }).then(() => { toast('Logged out'); renderAdmin('devices'); }));
  };
  ADMIN.log = async (main) => {
    const j = await api('audit_list');
    main.innerHTML = `<div class="card"><h2>Activity</h2><div class="tw"><table><tr><th>Time</th><th>User</th><th>Action</th><th>Detail</th></tr>${j.audit.map(a => `<tr><td>${fmtT(a.at)}</td><td>${esc(a.name || '')}</td><td>${esc(a.action)}</td><td class="small" style="max-width:520px;word-break:break-word">${esc(String(a.detail || '').slice(0, 300))}</td></tr>`).join('')}</table></div></div>`;
  };


  // ---- v1.1 admin: withdrawals (QR / UPI link), log files + requests, Terms ----
  const qrImg = text => { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createDataURL(6, 3); };
  const copyBtn = (v, label = 'Copy') => `<button class="btn sm sec" data-copy="${esc(v)}">${label}</button>`;
  const bindCopy = (root = document) => $$('[data-copy]', root).forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); } catch { const t = document.createElement('textarea'); t.value = b.dataset.copy; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); toast('Copied'); } catch { toast('Copy not available'); } t.remove(); } });
  let wdTab = 'pending';
  ADMIN.withdrawals = async (main) => {
    const j = await api('withdrawals_list', { status: wdTab === 'all' ? '' : wdTab }); const skew = j.now - Date.now();
    const head = ['Caller', 'Amount (₹)', 'Status', 'Requested', 'Deadline', 'Paid on', 'UTR / reference', 'UPI ID', 'Account holder', 'Account number', 'IFSC', 'Bank', 'Reject reason'];
    const row = w => [w.caller_name, w.amount, w.status, fmtT(w.requested_at), fmtT(w.due_at), fmtT(w.paid_at), w.utr || '', w.upi || '', w.holder || '', w.account_no || '', w.ifsc || '', w.bank || '', w.reject_reason || ''];
    main.innerHTML = `<div class="row" style="margin-bottom:10px"><div class="pill">${[['pending', 'Pending'], ['paid', 'Paid'], ['rejected', 'Rejected'], ['all', 'All']].map(r => `<button data-w="${r[0]}" class="${r[0] === wdTab ? 'on' : ''}">${r[1]}</button>`).join('')}</div><span class="grow"></span><button class="btn sec sm" id="wx">Excel</button></div>
      <div class="stats" style="margin-bottom:10px"><div class="stat"><b>${j.summary.pending}</b><span>Pending requests</span></div><div class="stat ${j.summary.overdue ? 'stat-bad' : ''}"><b>${j.summary.overdue}</b><span>Overdue (past deadline)</span></div><div class="stat"><b>${rs(j.summary.pending_amount)}</b><span>Waiting to be paid</span></div></div>
      <div class="card"><h2>Withdrawal requests</h2><p class="small mut" style="margin-top:-6px">Callers are promised payment within the deadline. Pay from your own UPI / bank app (scan the QR or copy the details), then mark the request paid. This app does not move money.</p>
      <div class="tw"><table><tr><th>Caller</th><th class="n">Amount</th><th>Requested</th><th>Deadline</th><th>Pay to</th><th>Status</th><th></th></tr>${j.withdrawals.map(w => `<tr class="${w.overdue ? 'over' : ''}"><td><b>${esc(w.caller_name)}</b></td><td class="n"><b>${rs(w.amount)}</b></td><td>${fmtT(w.requested_at)}</td><td>${w.status === 'pending' ? `<span data-due="${w.due_at}" class="${w.overdue ? 'due' : ''}"></span>` : '<span class="mut">—</span>'}</td>
        <td class="small">${w.upi ? 'UPI: ' + esc(w.upi) : ''}${w.upi && w.account_no ? '<br>' : ''}${w.account_no ? 'Bank: ' + esc(w.bank) + ' · ' + esc(w.account_no) : ''}</td>
        <td>${w.status === 'paid' ? `<span class="tag ok">Paid</span><div class="small mut">${fmtT(w.paid_at)}${w.utr ? ' · ' + esc(w.utr) : ''}</div>` : w.status === 'rejected' ? `<span class="tag bad">Rejected</span><div class="small mut">${esc(w.reject_reason || '')}</div>` : w.overdue ? '<span class="tag bad">OVERDUE</span>' : '<span class="tag warn">Pending</span>'}</td>
        <td>${w.status === 'pending' ? `<div class="row"><button class="btn sm green" data-pay="${w.id}">Pay / QR</button><button class="btn sm sec" data-rej="${w.id}">Reject</button></div>` : ''}</td></tr>`).join('') || `<tr><td colspan="7" class="mut">${empty('wallet', 'No ' + (wdTab === 'all' ? '' : wdTab + ' ') + 'withdrawal requests', 'Requests from callers appear here.')}</td></tr>`}</table></div></div>`;
    const tick = () => $$('[data-due]').forEach(el => { const c = RSL.countdown(Number(el.dataset.due), Date.now() + skew); el.textContent = c.text; el.classList.toggle('due', c.overdue); const tr = el.closest('tr'); if (tr) tr.classList.toggle('over', c.overdue); }); tick(); const iv = setInterval(() => { if (view === 'withdrawals') tick(); else clearInterval(iv); }, 30000);
    $$('[data-w]').forEach(b => b.onclick = () => { wdTab = b.dataset.w; renderAdmin('withdrawals'); });
    $('#wx').onclick = async () => { const all = await api('withdrawals_list', {}); exportX('rs-calling-withdrawals', [{ name: 'Withdrawals', rows: [head, ...all.withdrawals.map(row)] }]); };
    $$('[data-pay]').forEach(b => b.onclick = () => paySheet(j.withdrawals.find(w => w.id === b.dataset.pay)));
    $$('[data-rej]').forEach(b => b.onclick = () => { const w = j.withdrawals.find(x => x.id === b.dataset.rej); sheet(`<h2 style="margin-top:0">Reject withdrawal</h2><p class="small">${esc(w.caller_name)} · ${rs(w.amount)}</p><label class="f">Reason (the caller will see it)</label><input id="rr" style="width:100%"><div class="err small" id="re"></div><div class="row" style="margin-top:12px"><button class="btn red" id="rs">Reject</button><button class="btn sec" id="rc">Cancel</button></div>`, s => { $('#rc', s).onclick = () => s.remove(); $('#rs', s).onclick = async () => { try { await api('withdrawal_reject', { id: w.id, reason: $('#rr', s).value }); s.remove(); toast('Rejected — amount returns to the caller\'s balance'); renderAdmin('withdrawals'); } catch (e) { $('#re', s).textContent = e.message; } }; }); });
  };
  function paySheet(w) {
    const hasU = !!w.upi, hasB = !!(w.account_no && w.ifsc);
    sheet(`<div class="row"><b class="grow" style="font-size:17px">Pay ${esc(w.caller_name)} · ${rs(w.amount)}</b><button class="btn sm sec" onclick="this.closest('.sheet').remove()">Close</button></div>
      ${w.overdue ? '<div class="banner" style="background:var(--badbg);color:var(--bad);margin-top:8px"><b>Overdue</b> — the 16-hour deadline has passed.</div>' : ''}
      ${hasU ? `<div class="qrbox"><img id="qri" alt="UPI QR code" src="${qrImg(w.upi_link)}"><div class="small mut" style="text-align:center">Scan with any UPI app. Amount ${rs(w.amount)} is filled in.</div></div>
        <div class="kv"><div><span>UPI ID</span><b>${esc(w.upi)}</b>${copyBtn(w.upi)}</div><div><span>Payee name</span><b>${esc(w.holder || w.caller_name)}</b></div><div><span>Amount</span><b>${w.amount.toFixed(2)}</b>${copyBtn(w.amount.toFixed(2))}</div></div>
        <div class="row" style="margin:8px 0"><a class="btn sm" href="${esc(w.upi_link)}" id="upil">Open in UPI app</a>${copyBtn(w.upi_link, 'Copy UPI link')}</div>` : '<div class="banner">This caller gave only bank details, so there is no UPI QR code. The QR code works only for UPI IDs — pay by bank transfer using the details below.</div>'}
      ${hasB ? `<h3>Bank details</h3><div class="kv"><div><span>Account holder</span><b>${esc(w.holder)}</b>${copyBtn(w.holder)}</div><div><span>Account number</span><b>${esc(w.account_no)}</b>${copyBtn(w.account_no)}</div><div><span>IFSC</span><b>${esc(w.ifsc)}</b>${copyBtn(w.ifsc)}</div><div><span>Bank</span><b>${esc(w.bank)}</b></div></div>` : ''}
      <p class="mut small">R&amp;S Calling does not move money. Pay in your own UPI / bank app, then enter the reference (UTR) below and mark it paid.</p>
      <label class="f">UTR / reference (optional)</label><input id="utr" style="width:100%" placeholder="e.g. 4123 4567 8901"><div class="err small" id="ue"></div>
      <div class="row" style="margin-top:10px"><button class="btn green grow" id="paid">Mark as paid</button></div>`, s => {
      bindCopy(s);
      $('#paid', s).onclick = async () => { if (!confirm(`Mark ${rs(w.amount)} as paid to ${w.caller_name}? Do this only after you have paid.`)) return; try { await api('withdrawal_pay', { id: w.id, utr: $('#utr', s).value.trim().replace(/\s+/g, '') }); s.remove(); toast('Marked as paid'); renderAdmin('withdrawals'); } catch (e) { $('#ue', s).textContent = e.message; } };
    });
  }

  let fileQ = { day: '', user_id: '', reqTab: 'pending' };
  ADMIN.files = async (main) => {
    await callers(); if (!fileQ.day) fileQ.day = today();
    const [sn, rq] = await Promise.all([api('snapshots_list'), api('log_requests_list', { status: fileQ.reqTab === 'all' ? '' : fileQ.reqTab })]);
    main.innerHTML = `<div class="card"><h2>Log files</h2><p class="small mut" style="margin-top:-6px">Every call made from the app and every callback: caller, client number, time, duration, connected, counted + reason, result, notes.</p>
      <div class="row"><label>Day <input type="date" id="fd" value="${fileQ.day}"></label><select id="fu">${callerOpts(fileQ.user_id)}</select></div>
      <div class="row" style="margin-top:10px"><button class="btn" id="dx">Day file · Excel</button><button class="btn sec" id="dc">Day file · CSV</button><span class="grow"></span><button class="btn" id="ax">All logs · Excel</button><button class="btn sec" id="ac">All logs · CSV</button></div><div id="fmsg" class="small mut" style="margin-top:8px"></div></div>
      <div class="card"><h2>Saved daily files</h2><p class="small mut" style="margin-top:-6px">A file for each past day is saved automatically by the server (written on the first visit after midnight, India time).</p>
      <div class="tw"><table><tr><th>Day</th><th class="n">Records</th><th>Saved</th><th></th></tr>${sn.snapshots.map(x => `<tr><td>${x.day}</td><td class="n">${x.n}</td><td class="small">${fmtT(x.created_at)}</td><td><button class="btn sm sec" data-sn="${x.day}">Download CSV</button></td></tr>`).join('') || `<tr><td colspan="4" class="mut">No saved files yet — the first one appears after a day with calls ends.</td></tr>`}</table></div></div>
      <div class="card"><div class="row"><h2 class="grow" style="margin:0">Caller log requests</h2><div class="pill">${[['pending', 'Waiting'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['all', 'All']].map(r => `<button data-rq="${r[0]}" class="${r[0] === fileQ.reqTab ? 'on' : ''}">${r[1]}</button>`).join('')}</div></div>
      <div class="tw" style="margin-top:8px"><table><tr><th>Caller</th><th>Period</th><th>Purpose</th><th>Requested</th><th>Status</th><th></th></tr>${rq.requests.map(x => `<tr><td><b>${esc(x.caller_name)}</b></td><td class="small">${x.from_day} → ${x.to_day}</td><td class="small" style="max-width:320px">${esc(x.purpose)}</td><td class="small">${fmtT(x.requested_at)}</td><td>${x.status === 'pending' ? '<span class="tag warn">Waiting</span>' : x.status === 'approved' ? `<span class="tag ${x.expired ? 'mut' : 'ok'}">${x.expired ? 'Expired' : 'Approved'}</span><div class="small mut">${x.expired ? '' : 'until ' + fmtT(x.expires_at)}</div>` : `<span class="tag bad">Rejected</span><div class="small mut">${esc(x.decision_reason || '')}</div>`}</td><td>${x.status === 'pending' ? `<div class="row"><button class="btn sm green" data-ap="${x.id}">Approve</button><button class="btn sm sec" data-rj="${x.id}">Reject</button></div>` : ''}</td></tr>`).join('') || `<tr><td colspan="6" class="mut">${empty('inbox', 'No requests', 'When a caller asks for older logs, it shows here.')}</td></tr>`}</table></div></div>`;
    const mk = async (all, fmt) => {
      const msg = $('#fmsg'); msg.textContent = 'Preparing…';
      try {
        const q = all ? { all: true } : { from: $('#fd').value, to: $('#fd').value }; if ($('#fu').value) q.user_id = $('#fu').value; fileQ.day = $('#fd').value; fileQ.user_id = $('#fu').value;
        const j = await api('logs_export', q); const nm = all ? `rs-calling-ALL-logs-${today()}` : `rs-calling-logs-${j.from}`;
        if (fmt === 'csv') saveText(nm + '.csv', j.csv, 'text/csv'); else xlsxBook(nm, [{ name: 'Logs', rows: [j.columns, ...j.rows] }]);
        msg.textContent = `${j.count} records${j.truncated ? ' (first 60,000 only)' : ''} · ${fmt.toUpperCase()} ready`;
      } catch (e) { msg.textContent = e.message; }
    };
    $('#dx').onclick = () => mk(false, 'xlsx'); $('#dc').onclick = () => mk(false, 'csv'); $('#ax').onclick = () => mk(true, 'xlsx'); $('#ac').onclick = () => mk(true, 'csv');
    $$('[data-sn]').forEach(b => b.onclick = async () => { try { const j = await api('snapshot_get', { day: b.dataset.sn }); saveText(`rs-calling-logs-${j.day}.csv`, j.csv, 'text/csv'); } catch (e) { toast(e.message); } });
    $$('[data-rq]').forEach(b => b.onclick = () => { fileQ.reqTab = b.dataset.rq; renderAdmin('files'); });
    const decide = (id, approve) => { const x = rq.requests.find(y => y.id === id);
      sheet(`<h2 style="margin-top:0">${approve ? 'Approve' : 'Reject'} log request</h2><p class="small"><b>${esc(x.caller_name)}</b> · ${x.from_day} → ${x.to_day}<br>“${esc(x.purpose)}”</p>${approve ? '<p class="mut small">The caller can view and download this period for 48 hours.</p>' : ''}<label class="f">${approve ? 'Note (optional)' : 'Reason (required — the caller will see it)'}</label><input id="dr" style="width:100%"><div class="err small" id="de"></div><div class="row" style="margin-top:12px"><button class="btn ${approve ? 'green' : 'red'}" id="dg">${approve ? 'Approve' : 'Reject'}</button><button class="btn sec" id="dc2">Cancel</button></div>`, s => { $('#dc2', s).onclick = () => s.remove(); $('#dg', s).onclick = async () => { try { await api('log_request_decide', { id, approve, reason: $('#dr', s).value }); s.remove(); toast(approve ? 'Approved' : 'Rejected'); renderAdmin('files'); } catch (e) { $('#de', s).textContent = e.message; } }; }); };
    $$('[data-ap]').forEach(b => b.onclick = () => decide(b.dataset.ap, true)); $$('[data-rj]').forEach(b => b.onclick = () => decide(b.dataset.rj, false));
  };

  ADMIN.terms = async (main) => {
    const j = await api('terms_get');
    main.innerHTML = `<div class="card"><div class="row"><h2 class="grow" style="margin:0">Terms &amp; Conditions · current version ${j.current.version}</h2><span class="small mut">Saved ${fmtT(j.current.created_at)}</span></div>
      <p class="small mut">Callers must accept the current version before they can use the app, and again every time you save a new version. Each save creates a new version.</p>
      <textarea id="tb" class="terms-edit" spellcheck="true">${esc(j.current.body)}</textarea><div class="err small" id="te"></div>
      <div class="row" style="margin-top:10px"><button class="btn" id="tsv">Save as version ${j.current.version + 1}</button><button class="btn sec" id="trs">Reset editor</button></div></div>
      <div class="card"><h2>Who accepted which version</h2><div class="row" style="margin-bottom:8px"><span class="tag ok">${j.report.filter(r => r.status === 'current').length} on current</span><span class="tag warn">${j.report.filter(r => r.status === 'outdated').length} on an older version</span><span class="tag mut">${j.report.filter(r => r.status === 'never').length} not accepted yet</span><span class="grow"></span><button class="btn sec sm" id="tx">Excel</button></div>
      <div class="tw"><table><tr><th>Caller</th><th>Accepted version</th><th>Accepted on</th><th>Status</th></tr>${j.report.map(r => `<tr><td><b>${esc(r.name)}</b><div class="small mut">${esc(r.username)}${r.active ? '' : ' · inactive'}</div></td><td>${r.terms_version ? 'v' + r.terms_version : '—'}</td><td>${fmtT(r.terms_at)}</td><td>${r.status === 'current' ? '<span class="tag ok">Up to date</span>' : r.status === 'outdated' ? '<span class="tag warn">Must accept v' + j.current.version + '</span>' : '<span class="tag mut">Not accepted</span>'}</td></tr>`).join('') || '<tr><td colspan="4" class="mut">No callers yet</td></tr>'}</table></div></div>
      <div class="card"><h2>Version history</h2><div class="tw"><table><tr><th>Version</th><th>Saved</th><th>By</th><th></th></tr>${j.versions.map(v => `<tr><td>v${v.version}${v.version === j.current.version ? ' <span class="tag ok">current</span>' : ''}</td><td>${fmtT(v.created_at)}</td><td>${esc(v.created_by_name || 'System')}</td><td><button class="btn sm sec" data-tv="${v.version}">View</button></td></tr>`).join('')}</table></div></div>`;
    $('#trs').onclick = () => { $('#tb').value = j.current.body; };
    $('#tsv').onclick = async () => { if (!confirm(`Save as version ${j.current.version + 1}? All callers must accept it again before they can use the app.`)) return; try { const r = await api('terms_save', { body: $('#tb').value }); toast('Saved as version ' + r.version); renderAdmin('terms'); } catch (e) { $('#te').textContent = e.message; } };
    $('#tx').onclick = () => exportX('rs-calling-terms-acceptance', [{ name: 'Acceptance', rows: [['Caller', 'Username', 'Accepted version', 'Accepted on', 'Status'], ...j.report.map(r => [r.name, r.username, r.terms_version || '', fmtT(r.terms_at), r.status])] }]);
    $$('[data-tv]').forEach(b => b.onclick = async () => { const t = (await api('terms_version_get', { version: Number(b.dataset.tv) })).terms; sheet(`<div class="row"><b class="grow">Version ${t.version} · ${fmtT(t.created_at)}</b><button class="btn sm sec" onclick="this.closest('.sheet').remove()">Close</button></div>${termsHtml(t.body)}`); });
  };

  // ---------------- start ----------------
  async function start() {
    if (!token || !me) return renderLogin();
    if (me.role === 'admin') { const h = location.hash.slice(1); return renderAdmin(ATABS.some(t => t[0] === h) ? h : 'dash'); }
    try { const j = await api('me'); me = j.user; LS.set('me', me); settings = { ...settings, ...j.settings }; LS.set('settings', settings); termsGate = !j.terms.accepted; }
    catch (e) { if (e.terms) termsGate = true; }          // offline: carry on; the server still checks the Terms on every request
    purgeLocal(); renderCaller('list'); syncNow(true);
  }
  // v1.3: pull down from the top of any screen to reload it (queued calls go first for callers)
  function installPullToRefresh() {
    let y0 = null, dy = 0, busy = false;
    const bar = document.createElement('div'); bar.id = 'ptr'; bar.innerHTML = '<span></span>';
    bar.style.cssText = 'position:fixed;left:0;right:0;top:0;height:0;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:13px;color:#fff;background:#0b2545;transition:height .15s;z-index:60';
    document.body.appendChild(bar);
    const pageTop = () => (window.scrollY || document.documentElement.scrollTop || 0) <= 0 && !document.querySelector('.sheet');
    const insideScrolled = t => { for (let n = t; n && n !== document.body; n = n.parentElement) if (n.scrollTop > 0) return true; return false; };
    document.addEventListener('touchstart', e => { if (busy || !pageTop() || insideScrolled(e.target)) { y0 = null; return; } y0 = e.touches[0].clientY; dy = 0; }, { passive: true });
    document.addEventListener('touchmove', e => { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); bar.style.height = Math.min(48, dy * 0.5) + 'px'; bar.firstChild.textContent = dy > 90 ? 'Release to refresh' : 'Pull to refresh'; }, { passive: true });
    document.addEventListener('touchend', async () => {
      if (y0 == null) return; const go = dy > 90 && pageTop(); y0 = null;
      if (!go) { bar.style.height = '0'; return; }
      busy = true; bar.style.height = '36px'; bar.firstChild.textContent = 'Refreshing…';
      try { await refreshCurrent(); } catch (err) { toast(err.message || 'Could not refresh'); }
      finally { busy = false; bar.style.height = '0'; }
    });
  }
  async function refreshCurrent() {
    if (!me || !token) return;
    if (me.role === 'admin') { await renderAdmin(view || 'dash'); return; }
    if (termsGate) return;
    await syncNow(true);                                     // queued calls go up first, then the list comes down
    await loadList().catch(() => {});
    renderCaller(view || 'list');
  }
  installPullToRefresh();
  window.addEventListener('online', () => syncNow(true));
  setInterval(() => syncNow(true), 30000);
  // a second session check every 20 s so a deactivated / logged-out user is sent to the login quickly
  setInterval(() => { if (token && document.visibilityState === 'visible') api('me').then(j => { if (me && me.role === 'caller' && j.terms && !j.terms.accepted && !termsGate) { termsGate = true; renderTerms(); } }).catch(() => { }); }, 20000);
  window.rscDebug = { queue, matchLog, syncNow, outcomeSheet, purgeLocal, scanCallbacks, cbq };
  start();
})();
