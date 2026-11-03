/* R&S Calling — one web app for callers (inside the Android app) and the admin (browser or Android). English UI. */
(function () {
  'use strict';
  const NATIVE = window.RSC || null;                 // Android bridge (null in a normal browser)
  const VERSION = '1.0.0';
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
  let me = LS.get('me', null), token = LS.get('token', null), view = null, settings = LS.get('settings', { min_duration: 30, call_rate: 0, lead_rate: 0, repeat_hours: 24 });
  const app = () => document.getElementById('app');
  function toast(m, ms = 2600) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.body.appendChild(t); setTimeout(() => t.remove(), ms); }

  async function api(m, body = {}, opt = {}) {
    let r; try {
      r = await fetch(SERVER + '/api/' + m, { method: 'POST', headers: { 'content-type': 'application/json', 'x-rsc': '1', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
    } catch (e) { const er = new Error('No internet connection'); er.offline = true; throw er; }
    let j = {}; try { j = await r.json(); } catch { j = { ok: false, error: 'Server error (' + r.status + ')' }; }
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
  let syncing = false;
  async function syncNow(quiet) {
    if (syncing || !token || me.role !== 'caller') return; const q = queue(); const todo = q.filter(x => !x.synced && x.ready);
    if (!todo.length) return; syncing = true;
    try {
      const j = await api('sync', { calls: todo.map(x => ({ id: x.id, contact_id: x.contact_id, phone: x.phone, log_phone: x.log_phone, tapped_at: x.tapped_at, start_ts: x.start_ts, duration: x.duration, log_found: x.log_found, log_type: x.log_type, outcome: x.outcome, callback_at: x.callback_at, note: x.note, device: x.device })) });
      const res = Object.fromEntries(j.results.map(r => [r.id, r])); const q2 = queue();
      for (const x of q2) if (j.synced.includes(x.id) && x.ver === (todo.find(t => t.id === x.id) || {}).ver) { x.synced = true; if (res[x.id]) Object.assign(x, { counted: res[x.id].counted, reason_text: res[x.id].reason_text, lead_counted: res[x.id].lead_counted, lead_reason: res[x.id].lead_reason }); }
      saveQ(q2); if (!quiet) toast(`Synced ${j.synced.length} call${j.synced.length > 1 ? 's' : ''}`);
      if (view === 'list' || view === 'today') renderCaller(view, true);
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
    const q = queue(); q.push(item); saveQ(q); LS.set('active', item.id);
    NATIVE.call(c.phone);
  }
  function askPerms() {
    sheet(`<h2 style="margin-top:0">Allow phone permissions</h2><p>R&amp;S Calling needs to <b>make calls</b> and <b>read your call history</b> so each call you make from this app can be checked and counted for your payment.</p>
      <p class="mut small">Only calls placed from this app to numbers on your list are read and sent. Calls are not recorded.</p><button class="btn" id="pa" style="width:100%">Allow</button>`, s => { $('#pa', s).onclick = () => { s.remove(); NATIVE.requestPermissions(); }; });
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
        let cb = null; if (pick === 'callback') { const v = $('#cbt', s).value; if (!v) { $('#oe', s).textContent = 'Choose the callback date and time'; return; } cb = new Date(v).getTime(); }
        const q = queue(); const x = q.find(y => y.id === id); if (!x.log_found) matchLog(x);
        Object.assign(x, { outcome: pick, callback_at: cb, note: $('#nt', s).value.trim().slice(0, 500), ready: true, synced: false, ver: (x.ver || 1) + 1 }); saveQ(q); LS.del('active');
        const L = LS.get('list', []); const c = L.find(y => y.id === x.contact_id); if (c) { c.status = pick; c.last_call_at = x.start_ts || x.tapped_at; c.callback_at = cb; if (x.note) c.last_note = x.note; LS.set('list', L); }
        s.remove(); toast('Saved'); syncNow(true); renderCaller(view || 'list', true);
      };
    });
  }
  async function loadList() { try { const j = await api('my_list'); LS.set('list', j.contacts); settings = { ...settings, ...j.settings }; LS.set('settings', settings); LS.set('list_at', Date.now()); return true; } catch (e) { if (!e.offline) toast(e.message); return false; } }
  let filt = 'todo', search = '';
  async function renderCaller(t, noFetch) {
    view = t; const main = shell('R&S Calling', [['list', 'My list', '☎'], ['today', 'My calls', '📊'], ['help', 'Help', '?']], t, x => renderCaller(x), true);
    const pend = queue().filter(x => !x.synced); const p = perms();
    let warn = '';
    if (!NATIVE) warn = `<div class="banner">You are in a web browser. Calls are counted only when made from the <b>R&amp;S Calling Android app</b>. <a href="/">Download it here</a>.</div>`;
    else if (p && (!p.call_log || !p.call_phone)) warn = `<div class="banner">Phone permissions are off — calls can't be counted. <button class="btn sm" id="gp">Allow</button></div>`;
    if (pend.length) warn += `<div class="banner">${pend.filter(x => x.ready).length} call(s) waiting to sync${pend.some(x => !x.ready) ? `, ${pend.filter(x => !x.ready).length} without a result` : ''}. <button class="btn sm" id="sy">Sync now</button></div>`;
    if (t === 'list') {
      if (!noFetch || !LS.get('list_at', 0)) loadList().then(ok => ok && view === 'list' && renderList());
      main.innerHTML = warn + `<div class="card" style="padding:10px"><input id="sq" placeholder="Search name, number or area" style="width:100%" value="${esc(search)}"><div class="row" style="margin-top:8px"><div class="pill">${[['todo', 'To call'], ['callback', 'Callbacks'], ['done', 'Done'], ['all', 'All']].map(f => `<button data-f="${f[0]}" class="${filt === f[0] ? 'on' : ''}">${f[1]}</button>`).join('')}</div></div></div><div class="card clist" id="cl"></div>`;
      $('#sq').oninput = e => { search = e.target.value; renderList(); }; $$('[data-f]').forEach(b => b.onclick = () => { filt = b.dataset.f; $$('[data-f]').forEach(x => x.classList.toggle('on', x === b)); renderList(); });
      renderList();
    } else if (t === 'today') {
      main.innerHTML = warn + `<div id="ms" class="mut">Loading…</div>`;
      try {
        const j = await api('my_stats'); const a = j.today, m = j.month;
        const local = pend.length ? `<div class="card"><h2>On this phone (not synced yet)</h2>${pend.map(x => `<div class="small">${esc(x.name || x.phone)} · ${fmtT(x.tapped_at)} · ${x.log_found ? fmtD(x.duration) : 'not in call log'} · ${esc(OUT[x.outcome] || 'no result yet')}</div>`).join('')}</div>` : '';
        $('#ms').outerHTML = `<div class="stats"><div class="stat"><b>${a.made}</b><span>Calls today</span></div><div class="stat"><b>${a.counted}</b><span>Counted today</span></div><div class="stat"><b>${a.leads}</b><span>Interested leads</span></div><div class="stat"><b>${rs(a.payout)}</b><span>Earned today</span></div></div>
          <div class="card" style="margin-top:12px"><h2>This month</h2><div class="small">Calls ${m.made} · Connected ${m.connected} · Counted ${m.counted} · Leads ${m.leads}</div><div style="font-size:20px;font-weight:700;margin-top:4px">${rs(m.payout)}</div>
          <div class="mut small">${rs(j.settings.call_rate)} per counted call (min ${j.settings.min_duration}s) + ${rs(j.settings.lead_rate)} per interested lead${m.adjust ? ` · adjustments ${rs(m.adjust)}` : ''}</div></div>${local}
          <div class="card"><h2>Recent calls</h2><div class="tw"><table><tr><th>Time</th><th>Client</th><th class="n">Talk</th><th>Result</th><th>Counted?</th></tr>${j.recent.map(c => `<tr><td>${fmtT(c.start_ts || c.tapped_at)}</td><td>${esc(c.contact_name || c.phone)}</td><td class="n">${fmtD(c.duration)}</td><td>${esc(c.outcome_label)}</td><td>${c.counted ? '<span class="tag ok">Counted</span>' : `<span class="tag bad">No</span> <span class="small mut">${esc(c.reason_text)}</span>`}${c.lead_counted ? ' <span class="tag ok">Lead</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="mut">No calls yet</td></tr>'}</table></div></div>`;
      } catch (e) { $('#ms').textContent = e.offline ? 'Offline — connect to the internet to see your totals.' : e.message; }
    } else {
      main.innerHTML = warn + `<div class="card"><h2>How your calls are counted</h2><ul class="small">
        <li>Call only from this app (tap the green button). Calls from the normal dialer are not counted.</li>
        <li>A call counts when it connects and lasts at least <b>${settings.min_duration} seconds</b>.</li>
        <li>Only numbers on your list count. Calling the same number again within ${settings.repeat_hours} hours counts once.</li>
        <li>After every call choose the result. "Interested" earns the lead amount once per client.</li>
        <li>No internet? Keep calling — calls are saved on the phone and sync later.</li></ul>
        <p class="small mut">This app reads your phone's call history only to check calls made from this app. Calls are not recorded.</p></div>`;
    }
    const sy = $('#sy'); if (sy) sy.onclick = async () => { const q = queue(); q.filter(x => !x.ready).forEach(x => { if (Date.now() - x.tapped_at > 120000) { matchLog(x); } }); saveQ(q); const nr = q.filter(x => !x.ready); if (nr.length) outcomeSheet(nr[0].id); else syncNow(); };
    const gp = $('#gp'); if (gp) gp.onclick = () => NATIVE.requestPermissions();
  }
  function renderList() {
    const el = $('#cl'); if (!el) return; const L = LS.get('list', []); const s = search.toLowerCase(); const now = Date.now();
    let xs = L.filter(c => !s || (c.name || '').toLowerCase().includes(s) || c.phone.includes(s) || (c.area || '').toLowerCase().includes(s));
    if (filt === 'todo') xs = xs.filter(c => c.status === 'new' || c.status === 'not_reachable' || (c.status === 'callback'));
    if (filt === 'callback') xs = xs.filter(c => c.status === 'callback').sort((a, b) => (a.callback_at || 0) - (b.callback_at || 0));
    if (filt === 'done') xs = xs.filter(c => c.status !== 'new' && c.status !== 'callback');
    el.innerHTML = xs.slice(0, 400).map(c => `<div class="ci"><div class="grow"><div class="nm">${esc(c.name || 'Client')}</div><div class="ph">${esc(c.phone)}${c.area ? ' · ' + esc(c.area) : ''}</div>
      ${c.status !== 'new' ? `<div class="small"><span class="tag ${c.status === 'interested' ? 'ok' : c.status === 'callback' ? 'warn' : 'mut'}">${esc(OUT[c.status] || c.status)}</span> ${c.status === 'callback' && c.callback_at ? `<span class="${c.callback_at < now ? 'due' : ''}">${c.callback_at < now ? 'Due ' : ''}${fmtT(c.callback_at)}</span>` : c.last_call_at ? '<span class="mut">' + fmtT(c.last_call_at) + '</span>' : ''}</div>` : ''}
      ${c.notes ? `<div class="small mut">${esc(c.notes)}</div>` : ''}${c.last_note ? `<div class="small">“${esc(c.last_note)}”</div>` : ''}</div><button class="callb" data-c="${esc(c.id)}" aria-label="Call">📞</button></div>`).join('') || `<p class="mut">${L.length ? 'Nothing here.' : 'No numbers assigned to you yet. Ask the admin.'}</p>`;
    if (xs.length > 400) el.innerHTML += `<p class="mut small">Showing 400 of ${xs.length}. Use search.</p>`;
    $$('[data-c]', el).forEach(b => b.onclick = () => placeCall(L.find(c => c.id === b.dataset.c)));
  }

  // ================= ADMIN =================
  const ATABS = [['dash', 'Dashboard'], ['numbers', 'Numbers'], ['callers', 'Callers'], ['calls', 'Calls'], ['payouts', 'Payouts'], ['leads', 'Leads'], ['settings', 'Settings'], ['devices', 'Devices'], ['log', 'Activity']];
  let callersCache = [];
  async function callers() { const j = await api('callers_list'); callersCache = j.callers; return callersCache; }
  const callerOpts = (sel, all = 'All callers') => `<option value="">${all}</option>` + callersCache.map(c => `<option value="${c.id}" ${sel === c.id ? 'selected' : ''}>${esc(c.name)}${c.active ? '' : ' (inactive)'}</option>`).join('');
  async function renderAdmin(t) {
    view = t; location.hash = t; const main = shell('R&S Calling — Admin', ATABS, t, x => renderAdmin(x), false);
    main.innerHTML = '<p class="mut">Loading…</p>';
    try { await (ADMIN[t] || ADMIN.dash)(main); } catch (e) { main.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
  }
  function exportX(name, sheets) { // sheets: [{name, rows: [[...]]}]
    const wb = XLSX.utils.book_new(); for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows), s.name.slice(0, 31));
    if (NATIVE && NATIVE.saveFile) { NATIVE.saveFile(XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }), name + '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); return; }
    XLSX.writeFile(wb, name + '.xlsx');
  }
  function exportP(name, title, sub, head, body) {
    const { jsPDF } = window.jspdf; const doc = new jsPDF({ orientation: head.length > 7 ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
    doc.setFontSize(15); doc.text(title, 40, 42); doc.setFontSize(9); doc.setTextColor(90); doc.text(sub, 40, 58);
    const fix = v => String(v == null ? '' : v).replace(/₹/g, 'Rs ');
    doc.autoTable({ startY: 70, head: [head.map(fix)], body: body.map(r => r.map(fix)), styles: { fontSize: 8.5, cellPadding: 4 }, headStyles: { fillColor: [11, 37, 69] }, margin: { left: 40, right: 40 } });
    doc.setFontSize(8); doc.text('R&S Calling · generated ' + new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), 40, doc.internal.pageSize.getHeight() - 20);
    if (NATIVE && NATIVE.saveFile) { NATIVE.saveFile(doc.output('datauristring').split(',')[1], name + '.pdf', 'application/pdf'); return; }
    doc.save(name + '.pdf');
  }
  const totRow = r => [r.user.name, r.made, r.connected, r.counted, r.connect_rate + '%', r.leads, rs(r.call_amount), rs(r.lead_amount), rs(r.adjust), rs(r.payout)];
  const TOT_HEAD = ['Caller', 'Calls made', 'Connected', 'Counted', 'Connect rate', 'Interested leads', 'Call pay', 'Lead pay', 'Adjust', 'Payout'];
  const sum = rows => rows.reduce((a, r) => { for (const k of ['made', 'connected', 'counted', 'leads', 'call_amount', 'lead_amount', 'adjust', 'payout']) a[k] = (a[k] || 0) + r[k]; return a; }, {});
  const ADMIN = {};
  let dashRange = 'today';
  ADMIN.dash = async (main) => {
    const j = await api('dashboard'); const rows = j[dashRange]; const t = sum(rows); const rg = j.ranges[dashRange];
    main.innerHTML = `<div class="row" style="margin-bottom:10px"><div class="pill">${[['today', 'Today'], ['week', 'Last 7 days'], ['month', 'This month']].map(r => `<button data-r="${r[0]}" class="${r[0] === dashRange ? 'on' : ''}">${r[1]}</button>`).join('')}</div><span class="mut small">${rg[0]}${rg[1] !== rg[0] ? ' → ' + rg[1] : ''}</span><span class="grow"></span><button class="btn sec sm" id="dx">Excel</button><button class="btn sec sm" id="dp">PDF</button></div>
      <div class="stats"><div class="stat"><b>${t.made || 0}</b><span>Calls made</span></div><div class="stat"><b>${t.connected || 0}</b><span>Connected</span></div><div class="stat"><b>${t.counted || 0}</b><span>Counted</span></div><div class="stat"><b>${t.made ? Math.round(100 * t.connected / t.made) : 0}%</b><span>Connect rate</span></div><div class="stat"><b>${t.leads || 0}</b><span>Interested leads</span></div><div class="stat"><b>${rs(t.payout || 0)}</b><span>Payout</span></div></div>
      <div class="row" style="margin:10px 0"><span class="tag ${j.due ? 'bad' : 'mut'}">${j.due} follow-up/callback due</span><span class="tag mut">${j.leads_open} open leads</span><span class="tag mut">${j.contacts.total || 0} numbers · ${j.contacts.unassigned || 0} unassigned · ${j.contacts.fresh || 0} not called</span></div>
      <div class="card"><h2>Callers</h2><div class="tw"><table><tr>${TOT_HEAD.map((h, i) => `<th class="${i ? 'n' : ''}">${h}</th>`).join('')}</tr>${rows.map(r => `<tr><td><b>${esc(r.user.name)}</b>${r.user.active ? '' : ' <span class="tag mut">inactive</span>'}</td>${totRow(r).slice(1).map(v => `<td class="n">${v}</td>`).join('')}</tr>${r.flags.length ? `<tr><td colspan="10">${r.flags.map(f => `<div class="flag">⚠ ${esc(f)}</div>`).join('')}</td></tr>` : ''}`).join('') || '<tr><td colspan="10" class="mut">No callers yet — add one under Callers.</td></tr>'}</table></div>
      <p class="mut small">Rates: ${rs(j.settings.call_rate)} per counted call · ${rs(j.settings.lead_rate)} per interested lead · min ${j.settings.min_duration}s · repeat window ${j.settings.repeat_hours} h</p></div>`;
    $$('[data-r]').forEach(b => b.onclick = () => { dashRange = b.dataset.r; renderAdmin('dash'); });
    $('#dx').onclick = () => exportX(`rs-calling-dashboard-${rg[0]}_${rg[1]}`, [{ name: 'Callers', rows: [TOT_HEAD, ...rows.map(totRow), ['Total', t.made, t.connected, t.counted, '', t.leads, rs(t.call_amount), rs(t.lead_amount), rs(t.adjust), rs(t.payout)]] }, { name: 'Flags', rows: [['Caller', 'Flag'], ...rows.flatMap(r => r.flags.map(f => [r.user.name, f]))] }]);
    $('#dp').onclick = () => exportP(`rs-calling-dashboard-${rg[0]}_${rg[1]}`, 'R&S Calling — Caller report', `${rg[0]} to ${rg[1]}`, TOT_HEAD, [...rows.map(totRow), ['Total', t.made, t.connected, t.counted, '', t.leads, rs(t.call_amount), rs(t.lead_amount), rs(t.adjust), rs(t.payout)]]);
  };

  let numQ = { q: '', assigned: '', status: '', offset: 0 };
  ADMIN.numbers = async (main) => {
    await callers(); const j = await api('contacts_list', { ...numQ, limit: 200 });
    main.innerHTML = `<div class="card"><h2>Upload client numbers</h2><div class="drop"><p style="margin:0 0 8px">Excel (.xlsx / .xls) or CSV with columns <b>Name, Phone, Area, Notes</b></p><input type="file" id="uf" accept=".xlsx,.xls,.csv"> <a href="#" id="tpl" class="small">Download a sample file</a></div><div id="up"></div></div>
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
    $('#uf').onchange = async e => {
      const f = e.target.files[0]; if (!f) return; const up = $('#up'); up.innerHTML = '<p class="mut">Reading file…</p>';
      try {
        const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', raw: false }); const ws = wb.Sheets[wb.SheetNames[0]]; const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
        if (!rows.length) throw new Error('The first sheet is empty'); const cols = Object.keys(rows[0]);
        up.innerHTML = `<h3>${esc(f.name)} — ${rows.length} rows · columns: ${cols.map(esc).join(', ')}</h3><div class="tw"><table><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr>${rows.slice(0, 5).map(r => `<tr>${cols.map(c => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('')}</table></div>
          <label class="f">After upload</label><select id="uas"><option value="none">Keep unassigned (assign later)</option><option value="rr">Share equally between all active callers</option>${callersCache.filter(c => c.active).map(c => `<option value="u:${c.id}">Give all to ${esc(c.name)}</option>`).join('')}</select>
          <div class="row" style="margin-top:10px"><button class="btn" id="ugo">Upload ${rows.length} rows</button></div><div id="ures"></div>`;
        $('#ugo').onclick = async () => {
          $('#ugo').disabled = true; const v = $('#uas').value; const tot = { total: 0, added: 0, dup_in_file: 0, dup_existing: 0, invalid: 0, assigned: 0, invalid_rows: [] }; const batch = f.name + ' ' + new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
          try {
            for (let i = 0; i < rows.length; i += 2000) {
              $('#ures').innerHTML = `<p class="mut">Uploading ${Math.min(i + 2000, rows.length)} / ${rows.length}…</p>`;
              const r = await api('contacts_import', { rows: rows.slice(i, i + 2000), batch, assign: v === 'none' ? 'none' : v === 'rr' ? 'rr' : 'user', user_id: v.startsWith('u:') ? v.slice(2) : undefined });
              for (const k of ['total', 'added', 'dup_existing', 'invalid', 'assigned']) tot[k] += r.report[k]; tot.dup_in_file += r.report.dup_in_file; tot.invalid_rows.push(...r.report.invalid_rows.map(x => x + i));
            }
            up.innerHTML = `<div class="banner" style="background:var(--okbg);color:var(--ok)"><b>Upload done:</b> ${tot.added} new numbers added${tot.assigned ? `, ${tot.assigned} assigned` : ''}. Skipped: ${tot.dup_in_file} duplicate in file, ${tot.dup_existing} already in the list, ${tot.invalid} without a valid 10-digit phone${tot.invalid_rows.length ? ` (rows ${tot.invalid_rows.slice(0, 15).join(', ')}${tot.invalid > 15 ? '…' : ''})` : ''}.</div>`;
            setTimeout(() => { if (view === 'numbers') { const keep = up.innerHTML; renderAdmin('numbers').then(() => { const u = $('#up'); if (u) u.innerHTML = keep; }); } }, 200);
          } catch (er) { $('#ures').innerHTML = `<p class="err">${esc(er.message)}</p>`; $('#ugo').disabled = false; }
        };
      } catch (er) { up.innerHTML = `<p class="err">Could not read the file: ${esc(er.message)}</p>`; }
    };
  };

  const genPw = () => { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; const b = new Uint8Array(8); crypto.getRandomValues(b); return [...b].map(x => a[x % a.length]).join(''); };
  ADMIN.callers = async (main) => {
    const cs = await callers();
    main.innerHTML = `<div class="card"><h2>Add a caller</h2><div class="row"><div class="grow"><label class="f">Name</label><input id="cn" style="width:100%"></div><div class="grow"><label class="f">Username</label><input id="cu" autocapitalize="none" style="width:100%"></div><div class="grow"><label class="f">Mobile (optional, can log in with it)</label><input id="cp" inputmode="tel" style="width:100%"></div><div class="grow"><label class="f">Password</label><input id="cw" value="${genPw()}" style="width:100%"></div></div>
      <div class="err small" id="ce"></div><button class="btn" id="cadd" style="margin-top:10px">Add caller</button><p class="mut small">Give the caller their username and password, and the app link from the home page. They log in on their Android phone.</p></div>
      <div class="card"><h2>Callers (${cs.length})</h2><div class="tw"><table><tr><th>Name</th><th>Username</th><th>Mobile</th><th class="n">Numbers</th><th class="n">Logged-in devices</th><th>Status</th><th></th></tr>${cs.map(c => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.username)}</td><td>${esc(c.phone || '')}</td><td class="n">${c.assigned}</td><td class="n">${c.sessions}</td><td>${c.active ? '<span class="tag ok">Active</span>' : '<span class="tag bad">Deactivated</span>'}</td>
        <td><div class="row"><button class="btn sm sec" data-e="${c.id}">Edit</button><button class="btn sm sec" data-pw="${c.id}">Reset password</button>${c.active ? `<button class="btn sm sec" data-off="${c.id}">Deactivate</button>` : `<button class="btn sm green" data-on="${c.id}">Activate</button>`}<button class="btn sm sec" data-lo="${c.id}">Log out everywhere</button><button class="btn sm red" data-rm="${c.id}">Remove</button></div></td></tr>`).join('') || '<tr><td colspan="7" class="mut">No callers yet</td></tr>'}</table></div></div>`;
    $('#cadd').onclick = async () => {
      try { const pw = $('#cw').value; await api('caller_save', { name: $('#cn').value, username: $('#cu').value, phone: $('#cp').value, password: pw }); sheet(`<h2 style="margin-top:0">Caller added ✅</h2><p>Send these login details to <b>${esc($('#cn').value)}</b>:</p><div class="card">Username: <b>${esc($('#cu').value.toLowerCase())}</b><br>Password: <b>${esc(pw)}</b><br>App: <b>${esc(location.origin)}</b></div><button class="btn" style="width:100%" onclick="this.closest('.sheet').remove()">Done</button>`); renderAdmin('callers'); }
      catch (e) { $('#ce').textContent = e.message; }
    };
    const byId = id => cs.find(c => c.id === id);
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
    const j = await api('calls_list', callQ);
    const head = ['Time', 'Caller', 'Client', 'Phone', 'Talk', 'Result', 'Counted', 'Reason', 'Lead', 'Note'];
    const rowOf = c => [fmtT(c.start_ts || c.tapped_at), c.caller_name, c.contact_name || '', c.phone, c.log_found ? fmtD(c.duration) : 'not in log', c.outcome_label, c.counted ? 'Yes' : 'No', c.reason_text + (c.override_reason ? ' — ' + c.override_reason : ''), c.lead_counted ? 'Yes' : (c.outcome === 'interested' ? 'No: ' + (c.lead_reason || '') : ''), c.note || ''];
    main.innerHTML = `<div class="card"><div class="row"><label>From <input type="date" id="f1" value="${callQ.from}"></label><label>To <input type="date" id="f2" value="${callQ.to}"></label><select id="fu">${callerOpts(callQ.user_id)}</select><select id="fc"><option value="">Counted + not counted</option><option value="1" ${callQ.counted === '1' ? 'selected' : ''}>Counted only</option><option value="0" ${callQ.counted === '0' ? 'selected' : ''}>Not counted only</option></select><button class="btn" id="fgo">Show</button><span class="grow"></span><button class="btn sec sm" id="cx">Excel</button><button class="btn sec sm" id="cpd">PDF</button></div></div>
      <div class="card"><h2>${j.total} calls</h2><div class="tw"><table><tr><th>Time</th><th>Caller</th><th>Client</th><th class="n">Talk</th><th>Result</th><th>Counted?</th><th>Lead</th><th></th></tr>${j.calls.map(c => `<tr><td>${fmtT(c.start_ts || c.tapped_at)}</td><td>${esc(c.caller_name)}</td><td>${esc(c.contact_name || '')}<div class="small mut">${esc(c.phone)}</div>${c.note ? `<div class="small">“${esc(c.note)}”</div>` : ''}</td><td class="n">${c.log_found ? fmtD(c.duration) : '<span class="mut">—</span>'}</td><td>${esc(c.outcome_label)}${c.callback_at ? `<div class="small mut">${fmtT(c.callback_at)}</div>` : ''}</td>
        <td>${c.counted ? '<span class="tag ok">Counted</span>' : '<span class="tag bad">Not counted</span>'}<div class="small mut">${esc(c.reason_text)}${c.override_reason ? ' — ' + esc(c.override_reason) : ''}</div></td><td>${c.lead_counted ? '<span class="tag ok">Lead</span>' : c.outcome === 'interested' ? `<span class="small mut">${esc(c.lead_reason || '')}</span>` : ''}</td>
        <td>${c.approval_id ? '<span class="tag mut">Approved</span>' : `<button class="btn sm sec" data-ov="${c.id}">Change</button>`}</td></tr>`).join('') || '<tr><td colspan="8" class="mut">No calls in this period</td></tr>'}</table></div></div>`;
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
      <div class="card"><h2>Payout ${j.from} → ${j.to}: ${rs(t.payout || 0)}</h2><div class="tw"><table><tr><th>Caller</th><th class="n">Counted calls</th><th class="n">Call pay</th><th class="n">Leads</th><th class="n">Lead pay</th><th class="n">Adjustments</th><th class="n">Total</th><th></th></tr>${j.rows.map(r => `<tr><td><b>${esc(r.user.name)}</b><div class="small mut">${r.made} calls · ${r.connected} connected</div></td><td class="n">${r.counted}</td><td class="n">${rs(r.call_amount)}</td><td class="n">${r.leads}</td><td class="n">${rs(r.lead_amount)}</td><td class="n">${rs(r.adjust)}</td><td class="n"><b>${rs(r.payout)}</b></td><td><div class="row"><button class="btn sm sec" data-adj="${r.user.id}">+ / − Adjust</button><button class="btn sm green" data-ap="${r.user.id}">Approve</button></div></td></tr>${r.flags.length ? `<tr><td colspan="8">${r.flags.map(f => `<div class="flag">⚠ ${esc(f)}</div>`).join('')}</td></tr>` : ''}`).join('')}</table></div></div>
      <div class="card"><h2>Adjustments in this period</h2><div class="tw"><table><tr><th>Date</th><th>Caller</th><th class="n">Amount</th><th>Reason</th><th></th></tr>${j.adjustments.map(a => `<tr><td>${a.day}</td><td>${esc((callersCache.find(c => c.id === a.user_id) || {}).name || '')}</td><td class="n">${rs(a.amount)}</td><td>${esc(a.reason)}</td><td>${a.approval_id ? '<span class="tag mut">Approved</span>' : `<button class="btn sm sec" data-ad="${a.id}">Delete</button>`}</td></tr>`).join('') || '<tr><td colspan="5" class="mut">None</td></tr>'}</table></div></div>
      <div class="card"><h2>Approved payouts</h2><div class="tw"><table><tr><th>Caller</th><th>Period</th><th class="n">Counted</th><th class="n">Leads</th><th class="n">Adjust</th><th class="n">Amount</th><th>Approved</th><th>Paid?</th><th></th></tr>${j.approvals.map(a => `<tr><td>${esc(a.name)}</td><td>${a.from_day} → ${a.to_day}</td><td class="n">${a.counted}</td><td class="n">${a.leads}</td><td class="n">${rs(a.adjust)}</td><td class="n"><b>${rs(a.payout)}</b></td><td class="small">${fmtT(a.approved_at)}${a.note ? '<br>' + esc(a.note) : ''}</td><td>${a.paid ? '<span class="tag ok">Paid</span>' : '<span class="tag warn">Not paid</span>'}</td><td><div class="row"><button class="btn sm sec" data-paid="${a.id}" data-v="${a.paid ? 0 : 1}">${a.paid ? 'Mark unpaid' : 'Mark paid'}</button><button class="btn sm sec" data-un="${a.id}">Undo</button></div></td></tr>`).join('') || '<tr><td colspan="9" class="mut">None yet</td></tr>'}</table></div></div>`;
    $('#pgo').onclick = () => { payQ = { from: $('#p1').value, to: $('#p2').value }; renderAdmin('payouts'); };
    const head = ['Caller', 'Calls made', 'Connected', 'Counted calls', 'Call pay', 'Interested leads', 'Lead pay', 'Adjustments', 'Total payout'];
    const row = r => [r.user.name, r.made, r.connected, r.counted, rs(r.call_amount), r.leads, rs(r.lead_amount), rs(r.adjust), rs(r.payout)];
    const tr = ['Total', t.made, t.connected, t.counted, rs(t.call_amount), t.leads, rs(t.lead_amount), rs(t.adjust), rs(t.payout)];
    $('#px').onclick = () => exportX(`rs-calling-payout-${j.from}_${j.to}`, [{ name: 'Payout', rows: [head, ...j.rows.map(row), tr] }, { name: 'Daily', rows: [['Date', ...head], ...j.days.flatMap(d => d.rows.filter(r => r.made || r.adjust).map(r => [d.day, ...row(r)]))] }, { name: 'Adjustments', rows: [['Date', 'Caller', 'Amount', 'Reason'], ...j.adjustments.map(a => [a.day, (callersCache.find(c => c.id === a.user_id) || {}).name || '', a.amount, a.reason])] }]);
    $('#ppd').onclick = () => exportP(`rs-calling-payout-${j.from}_${j.to}`, 'R&S Calling — Payout report', `${j.from} to ${j.to} · ${rs(j.settings.call_rate)} per counted call, ${rs(j.settings.lead_rate)} per lead`, head, [...j.rows.map(row), tr]);
    $$('[data-adj]').forEach(b => b.onclick = () => { const c = callersCache.find(x => x.id === b.dataset.adj); sheet(`<h2 style="margin-top:0">Adjust ${esc(c.name)}'s pay</h2><label class="f">Date</label><input type="date" id="ajd" value="${payQ.to}" style="width:100%"><label class="f">Amount in ₹ (use minus for a deduction, e.g. -50)</label><input id="aja" inputmode="decimal" style="width:100%"><label class="f">Reason (required)</label><input id="ajr" style="width:100%"><div class="err small" id="aje"></div><div class="row" style="margin-top:12px"><button class="btn" id="ajs">Add</button><button class="btn sec" id="ajc">Cancel</button></div>`, s => { $('#ajc', s).onclick = () => s.remove(); $('#ajs', s).onclick = async () => { try { await api('adjustment_add', { user_id: c.id, day: $('#ajd', s).value, amount: $('#aja', s).value, reason: $('#ajr', s).value }); s.remove(); renderAdmin('payouts'); } catch (e) { $('#aje', s).textContent = e.message; } }; }); });
    $$('[data-ap]').forEach(b => b.onclick = () => { const r = j.rows.find(x => x.user.id === b.dataset.ap); sheet(`<h2 style="margin-top:0">Approve payout</h2><p><b>${esc(r.user.name)}</b> · ${j.from} → ${j.to}</p><p>${r.counted} counted calls (${rs(r.call_amount)}) + ${r.leads} leads (${rs(r.lead_amount)}) + adjustments ${rs(r.adjust)} = <b>${rs(r.payout)}</b></p><p class="mut small">After approval these calls are locked (rules and rate changes won't change them). You can undo it later.</p><label class="f">Note (optional)</label><input id="apn" style="width:100%"><label style="display:block;margin-top:8px"><input type="checkbox" id="app"> Already paid</label><div class="row" style="margin-top:12px"><button class="btn green" id="aps">Approve ${rs(r.payout)}</button><button class="btn sec" id="apc">Cancel</button></div>`, s => { $('#apc', s).onclick = () => s.remove(); $('#aps', s).onclick = async () => { try { await api('payout_approve', { user_id: r.user.id, from: j.from, to: j.to, note: $('#apn', s).value, paid: $('#app', s).checked }); s.remove(); toast('Approved'); renderAdmin('payouts'); } catch (e) { toast(e.message); } }; }); });
    $$('[data-ad]').forEach(b => b.onclick = () => confirm('Delete this adjustment?') && api('adjustment_delete', { id: b.dataset.ad }).then(() => renderAdmin('payouts')).catch(e => toast(e.message)));
    $$('[data-paid]').forEach(b => b.onclick = () => api('payout_mark_paid', { id: b.dataset.paid, paid: b.dataset.v === '1' }).then(() => renderAdmin('payouts')));
    $$('[data-un]').forEach(b => b.onclick = () => { const reason = prompt('Undo this approval? Reason:'); if (reason) api('payout_unapprove', { id: b.dataset.un, reason }).then(() => renderAdmin('payouts')).catch(e => toast(e.message)); });
  };

  let leadTab = 'open';
  ADMIN.leads = async (main) => {
    const j = await api('leads_list', { state: leadTab }); const now = Date.now();
    const head = ['Name', 'Phone', 'Area', 'Caller', 'Status', 'Interested on', 'Callback', 'Follow-up', 'Last note', 'Lead state'];
    const row = c => [c.name, c.phone, c.area, c.caller_name || '', OUT[c.status] || c.status, fmtT(c.interested_at), fmtT(c.callback_at), fmtT(c.followup_at), c.last_note || '', c.lead_state || ''];
    main.innerHTML = `<div class="row" style="margin-bottom:10px"><div class="pill">${[['open', 'Open leads'], ['callback', 'Callbacks'], ['won', 'Won'], ['closed', 'Closed'], ['all', 'All']].map(r => `<button data-l="${r[0]}" class="${r[0] === leadTab ? 'on' : ''}">${r[1]}</button>`).join('')}</div><span class="grow"></span><button class="btn sec sm" id="lx">Excel</button><button class="btn sec sm" id="lp">PDF</button></div>
      <div class="card"><h2>${j.leads.length} ${leadTab === 'callback' ? 'callbacks' : 'leads'}</h2><div class="tw"><table><tr><th>Client</th><th>Caller</th><th>Status</th><th>Reminder</th><th>Last note</th><th></th></tr>${j.leads.map(c => { const due = c.followup_at || c.callback_at; return `<tr><td><b>${esc(c.name || 'Client')}</b><div class="small"><a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>${c.area ? ' · ' + esc(c.area) : ''}</div></td><td>${esc(c.caller_name || '—')}</td><td>${esc(OUT[c.status] || c.status)}${c.lead_state ? ` <span class="tag ${c.lead_state === 'won' ? 'ok' : c.lead_state === 'closed' ? 'mut' : 'warn'}">${c.lead_state}</span>` : ''}<div class="small mut">${c.interested_at ? 'Interested ' + fmtT(c.interested_at) : ''}</div></td>
        <td>${due ? `<span class="${due < now ? 'due' : ''}">${due < now ? 'Overdue · ' : ''}${fmtT(due)}</span><div class="small mut">${c.followup_at ? 'Your follow-up' : 'Caller callback'}</div>` : '<span class="mut">—</span>'}${c.followup_note ? `<div class="small">${esc(c.followup_note)}</div>` : ''}</td><td class="small">${esc(c.last_note || '')}</td><td><button class="btn sm sec" data-fu="${c.id}">Follow-up</button></td></tr>`; }).join('') || '<tr><td colspan="6" class="mut">Nothing here</td></tr>'}</table></div></div>`;
    $$('[data-l]').forEach(b => b.onclick = () => { leadTab = b.dataset.l; renderAdmin('leads'); });
    $('#lx').onclick = () => exportX('rs-calling-leads-' + leadTab, [{ name: 'Leads', rows: [head, ...j.leads.map(row)] }]);
    $('#lp').onclick = () => exportP('rs-calling-leads-' + leadTab, 'R&S Calling — Leads', `${leadTab} · ${j.leads.length}`, head, j.leads.map(row));
    $$('[data-fu]').forEach(b => b.onclick = () => { const c = j.leads.find(x => x.id === b.dataset.fu); const v = c.followup_at ? new Date(c.followup_at + TZ * 60000).toISOString().slice(0, 16) : '';
      sheet(`<h2 style="margin-top:0">${esc(c.name || c.phone)}</h2><p class="small"><a href="tel:${esc(c.phone)}">${esc(c.phone)}</a> · ${esc(c.caller_name || '')}</p><label class="f">Follow-up reminder (date &amp; time)</label><input type="datetime-local" id="fua" value="${v}" style="width:100%"><label class="f">Follow-up note</label><input id="fun" value="${esc(c.followup_note || '')}" style="width:100%"><label class="f">Lead state</label><select id="fus" style="width:100%">${['open', 'won', 'closed'].map(x => `<option ${((c.lead_state || 'open') === x) ? 'selected' : ''}>${x}</option>`).join('')}</select><div class="row" style="margin-top:12px"><button class="btn" id="fuv">Save</button><button class="btn sec" id="fuc">Cancel</button></div>`, s => {
        $('#fuc', s).onclick = () => s.remove(); $('#fuv', s).onclick = async () => { const a = $('#fua', s).value; try { await api('lead_update', { id: c.id, followup_at: a ? Date.parse(a + ':00+05:30') : null, followup_note: $('#fun', s).value, lead_state: $('#fus', s).value }); s.remove(); renderAdmin('leads'); } catch (e) { toast(e.message); } }; }); });
  };

  ADMIN.settings = async (main) => {
    const s = (await api('settings_get')).settings;
    main.innerHTML = `<div class="card"><h2>Payout &amp; counting rules</h2><div class="row"><div class="grow"><label class="f">₹ per counted call</label><input id="s1" inputmode="decimal" value="${s.call_rate}" style="width:100%"></div><div class="grow"><label class="f">₹ per Interested lead</label><input id="s2" inputmode="decimal" value="${s.lead_rate}" style="width:100%"></div></div>
      <div class="row"><div class="grow"><label class="f">Minimum call duration to count (seconds)</label><input id="s3" inputmode="numeric" value="${s.min_duration}" style="width:100%"></div><div class="grow"><label class="f">Repeat calls to the same number count once within (hours)</label><input id="s4" inputmode="numeric" value="${s.repeat_hours}" style="width:100%"></div></div>
      <label style="display:block;margin-top:10px"><input type="checkbox" id="s5"> Apply the new ₹ rates to all calls that are not yet approved (otherwise they apply to new calls only)</label>
      <div class="err small" id="se"></div><button class="btn" id="ssv" style="margin-top:12px">Save</button></div>
      <div class="card"><h2>How a call is counted</h2><ol class="small"><li>Placed from the R&amp;S Calling app, to a number on that caller's assigned list.</li><li>Found in the phone's call history with the same number and time.</li><li>Connected and lasted at least the minimum duration.</li><li>Not a same-time (overlapping) call.</li><li>Not a repeat call to the same number inside the repeat window (any caller).</li></ol>
      <p class="small">An <b>Interested</b> result earns the lead amount once per client, if that call connected for at least the minimum duration. You can override any call or reject a lead on the Calls page (a reason is required). Suspicious patterns are flagged on the Dashboard and Payouts pages.</p><button class="btn sec sm" id="rca">Re-check all calls now</button></div>`;
    $('#ssv').onclick = async () => { try { const r = await api('settings_save', { call_rate: $('#s1').value, lead_rate: $('#s2').value, min_duration: $('#s3').value, repeat_hours: $('#s4').value, apply_rates_to_unapproved: $('#s5').checked }); toast('Saved' + (r.recalculated ? ` · ${r.recalculated} calls re-checked` : '') + (r.rated ? ` · new rates on ${r.rated} calls` : '')); renderAdmin('settings'); } catch (e) { $('#se').textContent = e.message; } };
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

  // ---------------- start ----------------
  function start() {
    if (!token || !me) return renderLogin();
    if (me.role === 'admin') { const h = location.hash.slice(1); return renderAdmin(ATABS.some(t => t[0] === h) ? h : 'dash'); }
    renderCaller('list');
    api('me').then(j => { me = j.user; LS.set('me', me); settings = { ...settings, ...j.settings }; LS.set('settings', settings); }).catch(() => { });
    syncNow(true);
  }
  window.addEventListener('online', () => syncNow(true));
  setInterval(() => syncNow(true), 30000);
  // a second session check every 20 s so a deactivated / logged-out user is sent to the login quickly
  setInterval(() => { if (token && document.visibilityState === 'visible') api('me').catch(() => { }); }, 20000);
  window.rscDebug = { queue, matchLog, syncNow, outcomeSheet };
  start();
})();
