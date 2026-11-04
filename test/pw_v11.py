
import asyncio, json, os, sys, time, random, string, urllib.request, glob, sqlite3, csv, io
from playwright.async_api import async_playwright
import cv2, openpyxl
BASE = sys.argv[1]; ADMIN_PW = open(sys.argv[2]).read().strip(); SHOTS = sys.argv[3]; PERSIST = sys.argv[4]; os.makedirs(SHOTS, exist_ok=True)
P = 'pv' + ''.join(random.choice(string.ascii_lowercase) for _ in range(4)); results = []
def ok(name): results.append(name); print('ok', len(results), name, flush=True)
def api(m, body, tok=None):
    req = urllib.request.Request(BASE + '/api/' + m, data=json.dumps(body).encode(), headers={'content-type': 'application/json', 'x-rsc': '1', **({'authorization': 'Bearer ' + tok} if tok else {})})
    try: return json.loads(urllib.request.urlopen(req, timeout=30).read())
    except urllib.error.HTTPError as e: return json.loads(e.read())
FAKE = """
(() => { window.RSC = { server: () => '', version: () => '1.1.0', deviceName: () => 'Test Android (simulated bridge)', setLoggedIn: () => {},
  permissions: () => JSON.stringify({ call_log: true, call_phone: true, phone_state: true }), requestPermissions: () => {},
  readCallLog: (since) => JSON.stringify(JSON.parse(localStorage.getItem('fake_log') || '[]').filter(e => e.date >= Number(since))),
  call: (num) => { const d = window.__nextDur == null ? 60 : window.__nextDur; const l = JSON.parse(localStorage.getItem('fake_log') || '[]');
    const last = l.length ? l[l.length - 1] : null; const start = Math.max(Date.now() + 1200, last ? last.date + last.duration * 1000 + 4000 : 0);
    l.push({ number: '+91' + num, date: start, duration: d, type: 'outgoing' }); localStorage.setItem('fake_log', JSON.stringify(l));
    setTimeout(() => window.rscOnResume(), 300); },
  saveFile: (b64, name, mime) => { (window.__saved = window.__saved || []).push({ b64, name, mime }); } }; })();
"""
def db_exec(sql, args=()):
    f = glob.glob(PERSIST + '/v3/d1/miniflare-D1DatabaseObject/*.sqlite')[0]; con = sqlite3.connect(f, timeout=20); con.execute(sql, args); con.commit(); con.close()
async def main():
    adm = api('login', {'login': 'admin', 'password': ADMIN_PW, 'app': 'web'})['token']
    api('settings_save', {'call_rate': 10, 'lead_rate': 40, 'min_duration': 30, 'daily_target': 2, 'min_withdrawal': 30, 'retention_days': 7}, adm)
    ids = {}
    for u in ['rita', 'omar']: ids[u] = api('caller_save', {'name': u.title() + ' (test)', 'username': P + u, 'password': 'test1234'}, adm)['id']
    base = 100000000 + random.randint(0, 700000000)
    for u in ids: api('contacts_import', {'rows': [{'Name': f'{u.title()} Client {i}', 'Phone': '9' + str(base + i + (50 if u == 'omar' else 0)), 'Area': 'Sigra'} for i in range(8)], 'assign': 'user', 'user_id': ids[u], 'batch': 'pw11'}, adm)
    async with async_playwright() as p:
        b = await p.chromium.launch(); errs = []
        cc = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, accept_downloads=True)
        await cc.add_init_script(FAKE); c = await cc.new_page(); c.on('pageerror', lambda e: errs.append('caller: ' + str(e))); c.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        await c.goto(BASE + '/app/'); await c.fill('#lu', P + 'rita'); await c.fill('#lp', 'test1234'); await c.click('#lb')
        # ---- Terms gate
        await c.wait_for_selector('#tk', timeout=15000); txt = await c.text_content('main'); assert 'Withdrawals are processed within 16 hours' in txt and 'at least 30 seconds' in txt and 'Version 1' in txt
        assert await c.locator('#ta').is_disabled(); assert await c.locator('[data-t]').count() == 0; await c.screenshot(path=SHOTS + '/rscalling-v11-caller-terms.png', full_page=True); ok('caller must accept the Terms first: no app navigation, Accept button disabled until ticked')
        await c.check('#tk'); await c.click('#ta'); await c.wait_for_selector('.callb', timeout=15000); ok('after accepting, the app opens (list with call buttons)')
        await c.screenshot(path=SHOTS + '/rscalling-v11-caller-list.png')
        nav = await c.locator('.bottom button').all_text_contents(); assert [x.strip() for x in nav] == ['My list', 'My calls', 'Streak', 'Account', 'Help'], nav; ok('caller tabs: ' + ', '.join(x.strip() for x in nav))
        # ---- place 3 calls (2 counted), so there is money + a streak
        async def do_call(idx, dur, outcome):
            await c.evaluate(f'window.__nextDur = {dur}'); await c.locator('.callb').nth(idx).click(timeout=8000); await c.wait_for_selector('.sheet[data-oc]', timeout=10000); await c.wait_for_timeout(300)
            await c.click(f'.sheet [data-o={outcome}]'); await c.click('#os'); await c.wait_for_timeout(1300)
        await c.click('[data-f=all]')
        await do_call(0, 70, 'interested'); await do_call(1, 40, 'not_interested'); await do_call(2, 12, 'not_reachable')
        q = await c.evaluate("JSON.parse(localStorage.getItem('rsc_queue')).filter(x => x.synced).length"); assert q == 3; ok('3 calls placed and synced (2 will count)')
        # ---- Streak
        await c.click('[data-t=streak]'); await c.wait_for_selector('.streak .sn'); await c.wait_for_timeout(400)
        assert (await c.text_content('.streak .sn')).strip() == '1'; st = ' '.join((await c.text_content('main')).split()); assert '2 of 2 counted calls' in st and 'Daily task done' in st and 'Last 14 days' in st
        assert await c.locator('.sd').count() == 14 and await c.locator('.sd.ok').count() == 1; await c.screenshot(path=SHOTS + '/rscalling-v11-caller-streak.png', full_page=True); ok('streak tab: current 1, today 2/2 done, 14-day strip with 1 green day')
        # ---- Account / wallet / payment
        await c.click('[data-t=account]'); await c.wait_for_selector('.wallet'); await c.wait_for_timeout(400)
        a0 = ' '.join((await c.text_content('main')).split()); assert P + 'rita' in a0 and 'Total earned' in a0 and 'Available to withdraw' in a0 and 'Admin pays within 16 hours' in a0 and 'does not move money' in a0
        assert await c.locator('#wbtn').is_disabled(); await c.screenshot(path=SHOTS + '/rscalling-v11-caller-account.png', full_page=True); ok('account: username, wallet (earned/approved/pending/withdrawn/available), 16-hour note; withdraw disabled with no approved money')
        await c.click('#pbtn'); await c.wait_for_selector('#psv'); await c.fill('#pu', 'bad upi'); await c.click('#psv'); assert 'UPI ID looks wrong' in await c.text_content('#pe')
        await c.fill('#pu', 'rita.test' + P + '@okaxis'); await c.fill('#ph', 'Rita Test'); await c.fill('#pa', '12345'); await c.fill('#pi', 'SBIN0001234'); await c.fill('#pb', 'State Bank of India'); await c.click('#psv'); assert '9 to 18 digits' in await c.text_content('#pe')
        await c.fill('#pa', '123456789012'); await c.fill('#pi', 'SBIN1001234'); await c.click('#psv'); assert 'IFSC' in await c.text_content('#pe'); await c.screenshot(path=SHOTS + '/rscalling-v11-caller-payment-error.png'); ok('payment form validates UPI, account number and IFSC in the app')
        await c.fill('#pi', 'sbin0001234'); await c.click('#psv'); await c.wait_for_selector('.kv'); kv = ' '.join((await c.text_content('.kv')).split())
        assert '123456789012' not in kv and '9012' in kv and ('rita.test' + P) not in kv and '@okaxis' in kv; ok('saved: UPI and account number are shown masked')
        # ---- admin approves her pay, caller withdraws
        a_appr = api('payout_approve', {'user_id': ids['rita'], 'from': time.strftime('%Y-%m-%d', time.gmtime(time.time() + 19800)), 'to': time.strftime('%Y-%m-%d', time.gmtime(time.time() + 19800))}, adm); print('   approved', a_appr)
        await c.reload(); await c.wait_for_selector('.callb'); await c.click('[data-t=account]'); await c.wait_for_selector('.wallet'); await c.wait_for_timeout(400)
        av = await c.text_content('.avail b'); assert av.strip() == '₹60', av; assert not await c.locator('#wbtn').is_disabled()
        await c.click('#wbtn'); await c.wait_for_selector('#wgo'); await c.fill('#wa', '20'); await c.click('#wgo'); assert 'Minimum withdrawal' in await c.text_content('#we')
        await c.fill('#wa', '500'); await c.click('#wgo'); assert 'at most' in await c.text_content('#we'); await c.screenshot(path=SHOTS + '/rscalling-v11-caller-withdraw.png')
        await c.fill('#wa', '45'); await c.click('#wgo')
        await c.wait_for_selector('.wd'); await c.wait_for_timeout(500); wtxt = ' '.join((await c.text_content('.wd')).split()); assert '₹45' in wtxt and 'Pending' in wtxt and 'Admin pays within 16 hours' in wtxt and ('15h' in wtxt or '16h' in wtxt), wtxt
        assert (await c.text_content('.avail b')).strip() == '₹15'; await c.screenshot(path=SHOTS + '/rscalling-v11-caller-withdrawal-pending.png', full_page=True); ok('withdrawal ₹45 requested: shows Pending, "pays within 16 hours" + live countdown, balance reserved (available ₹15)')
        # ---- admin: queue, QR, mark paid
        ac = await b.new_context(viewport={'width': 1280, 'height': 860}, accept_downloads=True); a = await ac.new_page(); a.on('pageerror', lambda e: errs.append('admin: ' + str(e))); a.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        await a.goto(BASE + '/app/'); await a.fill('#lu', 'admin'); await a.fill('#lp', ADMIN_PW); await a.click('#lb'); await a.wait_for_selector('.stats')
        dt = ' '.join((await a.text_content('main')).split()); assert '1 withdrawal pending' in dt, dt[:300]; ok('admin dashboard shows "1 withdrawal pending"')
        await a.click('[data-t=withdrawals]'); await a.wait_for_selector('[data-pay]'); await a.wait_for_timeout(500); wt = ' '.join((await a.text_content('main')).split()); assert 'Rita (test)' in wt and '₹45' in wt and 'Pending' in wt and 'left' in wt
        await a.screenshot(path=SHOTS + '/rscalling-v11-admin-withdrawals.png', full_page=True); ok('admin withdrawal queue lists the request with its deadline timer')
        await a.click('[data-pay]'); await a.wait_for_selector('#qri'); await a.wait_for_timeout(500); await a.locator('#qri').screenshot(path=SHOTS + '/qr-withdrawal.png')
        img = cv2.imread(SHOTS + '/qr-withdrawal.png'); img = cv2.resize(img, None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST); dec, pts, _ = cv2.QRCodeDetector().detectAndDecode(img)
        assert dec.startswith('upi://pay?pa=rita.test' + P + '@okaxis') and 'am=45.00' in dec and 'cu=INR' in dec and 'pn=Rita%20Test' in dec, dec; ok('QR decodes to ' + dec[:60] + '… (payee, amount 45.00, INR)')
        sheet_t = ' '.join((await a.text_content('.sheet')).split()); assert 'does not move money' in sheet_t and 'Bank details' in sheet_t and '123456789012' in sheet_t and 'SBIN0001234' in sheet_t; await a.screenshot(path=SHOTS + '/rscalling-v11-admin-pay-qr.png', full_page=True); ok('pay sheet shows QR, UPI deep link, bank details to copy, and the "app does not move money" note')
        await a.fill('#utr', '4123 4567 8901'); await a.click('#paid'); await a.wait_for_timeout(1200); assert 'Paid' in await a.text_content('main'); ok('admin marks paid with a UTR')
        await c.click('[data-t=list]'); await c.click('[data-t=account]'); await c.wait_for_selector('.wd'); await c.wait_for_timeout(500); wt2 = ' '.join((await c.text_content('.wd')).split()); assert 'Paid' in wt2 and '412345678901' in wt2; assert (await c.text_content('.stats.w6')).count('₹45') >= 1; await c.screenshot(path=SHOTS + '/rscalling-v11-caller-withdrawal-paid.png', full_page=True); ok('caller sees Paid + reference; Withdrawn ₹45')
        # ---- overdue highlighting + bank-only (no QR)
        api('settings_save', {'min_withdrawal': 10}, adm)
        ct2 = api('login', {'login': P + 'omar', 'password': 'test1234', 'app': 'android'})['token']; api('terms_accept', {'version': 1}, ct2)
        lst = api('my_list', {}, ct2)['contacts']; nowm = int(time.time() * 1000)
        api('sync', {'calls': [{'id': P + 'omar00001', 'contact_id': lst[0]['id'], 'phone': lst[0]['phone'], 'log_phone': lst[0]['phone'], 'tapped_at': nowm - 7200000, 'start_ts': nowm - 7198000, 'duration': 80, 'log_found': 1, 'outcome': 'not_interested'}]}, ct2)
        today = time.strftime('%Y-%m-%d', time.gmtime(time.time() + 19800)); api('payout_approve', {'user_id': ids['omar'], 'from': today, 'to': today}, adm)
        print('   bank only:', api('my_payment_save', {'holder': 'Omar Test', 'account_no': '9988776655443322', 'ifsc': 'HDFC0001234', 'bank': 'HDFC Bank'}, ct2).get('ok'))
        wo = api('withdraw_request', {'amount': 10}, ct2); assert wo['ok']; db_exec("UPDATE withdrawals SET due_at = ? WHERE id = ?", (nowm - 3 * 3600000, wo['id']))
        await a.click('[data-t=dash]'); await a.wait_for_timeout(500); await a.click('[data-t=withdrawals]'); await a.wait_for_selector('tr.over'); ov = ' '.join((await a.locator('tr.over').first.text_content()).split()); assert 'OVERDUE' in ov and 'Overdue by 3h' in ov, ov
        await a.screenshot(path=SHOTS + '/rscalling-v11-admin-overdue.png', full_page=True); ok('overdue request is highlighted (red row, OVERDUE tag, "Overdue by 3h …")')
        await a.locator('tr.over').locator('[data-pay]').click(); await a.wait_for_selector('#paid'); assert await a.locator('#qri').count() == 0; bt = ' '.join((await a.text_content('.sheet')).split()); assert 'QR code works only for UPI IDs' in bt and '9988776655443322' in bt and 'HDFC0001234' in bt
        await a.screenshot(path=SHOTS + '/rscalling-v11-admin-bank-only.png', full_page=True); ok('bank-only caller: no QR, clear "QR works only for UPI IDs" + bank details to copy')
        await a.click('.sheet .btn.sec >> text=Close'); await a.locator('tr.over').locator('[data-rej]').click(); await a.fill('#rr', 'Test: IFSC could not be verified'); await a.click('#rs'); await a.wait_for_timeout(1000); ok('admin rejects with a reason')
        async with a.expect_download() as d: await a.click('#wx')
        xp = SHOTS + '/export-withdrawals.xlsx'; await (await d.value).save_as(xp); wb = openpyxl.load_workbook(xp); ws = wb.active; hdr = [x.value for x in ws[1]]; assert 'UTR / reference' in hdr and 'UPI ID' in hdr and ws.max_row >= 3; ok('withdrawals exported to Excel (' + str(ws.max_row - 1) + ' rows, with payment columns)')
        r = api('my_account', {}, ct2); assert r['withdrawals'][0]['status'] == 'rejected' and r['wallet']['available'] > 0; ok('rejected request returns the amount to the caller balance')
        # ---- callbacks
        await c.click('[data-t=list]'); await c.wait_for_selector('.callb'); await c.click('[data-f=all]')
        ph = await c.evaluate("JSON.parse(localStorage.getItem('rsc_queue'))[0].phone"); await c.evaluate("""(ph) => { const l = JSON.parse(localStorage.getItem('fake_log') || '[]'); l.push({ number: '+91' + ph, date: Date.now() - 1000, duration: 75, type: 'incoming' }); l.push({ number: '9000000000', date: Date.now() - 500, duration: 50, type: 'incoming' }); localStorage.setItem('fake_log', JSON.stringify(l)); }""", ph)
        await c.evaluate("window.rscDebug.syncNow(true)"); await c.wait_for_timeout(2500); print('   DEBUG cb', await c.evaluate("[localStorage.getItem('rsc_cbq'), localStorage.getItem('rsc_cb_since'), localStorage.getItem('rsc_called'), Date.now(), localStorage.getItem('fake_log')]")); await c.click('[data-t=my]') if False else None
        await c.click('[data-t=today]'); await c.click('[data-t=list]'); await c.wait_for_selector('.callb'); await c.click('[data-f=all]'); await c.wait_for_timeout(800)
        lt = ' '.join((await c.locator('.clist').text_content()).split()); assert 'Callback received' in lt, lt[:400]; cbq = await c.evaluate("JSON.parse(localStorage.getItem('rsc_cbq')).map(x => [x.number, x.synced])"); assert len(cbq) == 1 and cbq[0][1] is True, cbq
        await c.click('[data-f=back]'); await c.wait_for_timeout(300); assert await c.locator('.ci').count() == 1; await c.screenshot(path=SHOTS + '/rscalling-v11-caller-callback.png'); ok('callback from a called number is attached to that client ("Callback received"); a call from an unknown number is ignored; listed under "Called back"')
        await c.click('[data-t=today]'); await c.wait_for_selector('.stats'); await c.wait_for_timeout(500); assert 'Callbacks received' in await c.text_content('main'); ok('caller "My calls" lists the callback')
        await a.click('[data-t=calls]'); await a.wait_for_selector('#fgo'); await a.wait_for_timeout(600); ct_ = ' '.join((await a.text_content('main')).split()); assert 'callback' in ct_.lower() and 'Callback received' in ct_ and 'Recorded only' in ct_; await a.screenshot(path=SHOTS + '/rscalling-v11-admin-calls-callbacks.png', full_page=True); ok('admin Calls page lists the callback (recorded, not paid by default)')
        # ---- auto-delete on the phone
        before = await c.evaluate("[JSON.parse(localStorage.getItem('rsc_queue')).length, JSON.parse(localStorage.getItem('rsc_cbq')).length, JSON.parse(localStorage.getItem('fake_log')).length]")
        await c.evaluate("(() => { const q = JSON.parse(localStorage.getItem('rsc_queue')); q.forEach((x, i) => { if (i < 2) x.synced_at = Date.now() - 8 * 86400000; }); localStorage.setItem('rsc_queue', JSON.stringify(q)); const k = JSON.parse(localStorage.getItem('rsc_cbq')); k.forEach(x => x.synced_at = Date.now() - 9 * 86400000); localStorage.setItem('rsc_cbq', JSON.stringify(k)); })()")
        n = await c.evaluate("window.rscDebug.purgeLocal()"); after = await c.evaluate("[JSON.parse(localStorage.getItem('rsc_queue')).length, JSON.parse(localStorage.getItem('rsc_cbq')).length, JSON.parse(localStorage.getItem('fake_log')).length]")
        assert n == 3 and after[0] == before[0] - 2 and after[1] == 0 and after[2] == before[2], (n, before, after); ok(f'auto-delete: 2 synced calls + 1 callback older than 7 days removed from the app ({before} -> {after}); the phone\'s own call log (3rd number) untouched')
        unsynced = await c.evaluate("JSON.parse(localStorage.getItem('rsc_queue')).filter(x => !x.synced).length"); assert unsynced == 0
        await c.click('[data-t=today]'); await c.wait_for_selector('.stats'); await c.wait_for_timeout(500); assert 'removed automatically' in await c.text_content('main'); ok('My calls explains the retention period and how to get older logs')
        # ---- log request with purpose
        await c.click('[data-t=account]'); await c.wait_for_selector('#lrbtn'); await c.click('#lrbtn'); await c.wait_for_selector('#lrs'); await c.fill('#lpu', 'need it'); await c.click('#lrs'); assert '15 characters' in await c.text_content('#lre')
        await c.fill('#lpu', 'I want to check a call that was not counted yesterday'); await c.screenshot(path=SHOTS + '/rscalling-v11-caller-log-request.png'); await c.click('#lrs'); await c.wait_for_selector('.wd >> text=Waiting'); ok('log request needs a purpose (min 15 chars) and goes to the admin as "Waiting"')
        await a.click('[data-t=files]'); await a.wait_for_selector('[data-ap]'); await a.wait_for_timeout(500); await a.screenshot(path=SHOTS + '/rscalling-v11-admin-logs.png', full_page=True)
        assert 'I want to check a call' in await a.text_content('main'); await a.click('[data-ap]'); await a.fill('#dr', 'ok'); await a.click('#dg'); await a.wait_for_timeout(1000); ok('admin sees the request with its purpose and approves it')
        await c.click('[data-t=list]'); await c.click('[data-t=account]'); await c.wait_for_selector('[data-lv]'); await c.click('[data-lv]'); await c.wait_for_selector('#lvc'); await c.wait_for_timeout(300); lv = ' '.join((await c.text_content('.sheet')).split()); assert 'My call logs' in lv and 'Client' in lv
        await c.screenshot(path=SHOTS + '/rscalling-v11-caller-logs-view.png')
        import base64
        async def saved(sel, path):
            n0 = await c.evaluate("(window.__saved || []).length"); await c.click(sel); await c.wait_for_function(f"(window.__saved || []).length > {n0}"); s = await c.evaluate("window.__saved[window.__saved.length - 1]"); open(path, 'wb').write(base64.b64decode(s['b64'])); return s
        cp = SHOTS + '/export-my-logs.csv'; s1 = await saved('#lvc', cp); assert s1['name'].endswith('.csv') and s1['mime'] == 'text/csv'; rows = list(csv.reader(open(cp, encoding='utf-8-sig'))); assert rows[0][0] == 'Record' and 'Caller' not in rows[0] and len(rows) >= 4, rows[:2]
        xp2 = SHOTS + '/export-my-logs.xlsx'; s2 = await saved('#lvx', xp2); assert s2['name'].endswith('.xlsx') and openpyxl.load_workbook(xp2).active.max_row >= 4; ok(f'approved: caller views + downloads own logs through the Android save bridge (CSV {len(rows)-1} rows, Excel)')
        # ---- admin log files
        await a.click('[data-t=files]'); await a.wait_for_selector('#dx'); today_n = None
        async with a.expect_download() as d3: await a.click('#dx')
        p3 = SHOTS + '/export-day-logs.xlsx'; await (await d3.value).save_as(p3); ws = openpyxl.load_workbook(p3).active; hdr = [x.value for x in ws[1]]
        for k in ['Caller', 'Client number', 'Time (IST)', 'Talk time (s)', 'Counted', 'Reason', 'Outcome', 'Notes', 'Callback event']: assert k in hdr, k
        kinds = {r[0].value for r in ws.iter_rows(min_row=2)}; assert 'Call' in kinds and 'Callback' in kinds, kinds; ok(f'admin daily log file (Excel): {ws.max_row-1} rows incl. calls + callback events')
        async with a.expect_download() as d4: await a.click('#dc')
        p4 = SHOTS + '/export-day-logs.csv'; await (await d4.value).save_as(p4); r4 = list(csv.reader(open(p4, encoding='utf-8-sig'))); assert r4[0] == hdr and len(r4) == ws.max_row; ok('daily log file (CSV) matches the Excel file')
        async with a.expect_download() as d5: await a.click('#ax')
        p5 = SHOTS + '/export-all-logs.xlsx'; await (await d5.value).save_as(p5); ws5 = openpyxl.load_workbook(p5).active; assert ws5.max_row >= ws.max_row
        async with a.expect_download() as d6: await a.click('#ac')
        p6 = SHOTS + '/export-all-logs.csv'; await (await d6.value).save_as(p6); assert len(list(csv.reader(open(p6, encoding='utf-8-sig')))) == ws5.max_row; ok('all-time log file: Excel + CSV')
        # ---- admin: settings, terms editor, versioning
        await a.click('[data-t=settings]'); await a.wait_for_selector('#ssv'); await a.fill('#s8', '3'); await a.fill('#s9', '50'); await a.fill('#s6', '120'); await a.fill('#s7', '10'); await a.check('#s13'); await a.click('#ssv'); await a.wait_for_timeout(1000)
        sv = api('settings_get', {}, adm)['settings']; assert sv['daily_target'] == 3 and sv['streak_bonus_7'] == 50 and sv['min_withdrawal'] == 120 and sv['retention_days'] == 10 and sv['callback_counts'] == 1; await a.screenshot(path=SHOTS + '/rscalling-v11-admin-settings.png', full_page=True); ok('admin settings: daily target, streak bonus, min withdrawal, retention days, callback toggle saved')
        await a.click('[data-t=terms]'); await a.wait_for_selector('#tsv'); tt = await a.input_value('#tb'); assert 'Withdrawals are processed within 16 hours' in tt; await a.screenshot(path=SHOTS + '/rscalling-v11-admin-terms.png', full_page=True)
        rep = ' '.join((await a.text_content('main')).split()); assert 'Rita (test)' in rep and 'Omar (test)' in rep and rep.count('Up to date') >= 2 and 'current version 1' in rep; ok('admin Terms editor shows v1 and the acceptance report (both callers up to date)')
        await a.fill('#tb', tt + '\n17. Test clause added by the admin in version 2.'); await a.click('#tsv'); await a.wait_for_timeout(1200); assert 'version 2' in (await a.text_content('main')).lower(); ok('admin saves the edited Terms -> version 2')
        await c.reload(); await c.wait_for_selector('#tk', timeout=15000); tx2 = await c.text_content('main'); assert 'Test clause added by the admin' in tx2 and 'version 2' in tx2.lower() and 'updated' in tx2.lower(); await c.screenshot(path=SHOTS + '/rscalling-v11-caller-terms-v2.png', full_page=True); ok('caller is stopped again and must accept version 2')
        await c.check('#tk'); await c.click('#ta'); await c.wait_for_selector('.callb', timeout=15000)
        await a.reload(); await a.wait_for_selector('[data-t=terms]'); await a.click('[data-t=terms]'); await a.wait_for_selector('#tsv'); rep2 = ' '.join((await a.text_content('main')).split()); assert 'v2' in rep2 and 'Must accept v2' in rep2; await a.screenshot(path=SHOTS + '/rscalling-v11-admin-terms-report.png', full_page=True); ok('acceptance report: Rita on v2, Omar must accept v2')
        # ---- Help chat
        await c.click('[data-t=help]'); await c.wait_for_selector('#hq')
        async def ask(q):
            await c.fill('#hq', q); await c.press('#hq', 'Enter'); await c.wait_for_timeout(200); return (await c.locator('.hb.bot').last.text_content()).strip()
        a1 = await ask('how are my calls counted'); assert 'at least 30 seconds' in a1; a2 = await ask('paisa kaise nikalna hai'); assert 'Account → Withdraw' in a2 and '16 hours' in a2
        a3 = await ask('what is the weather in Delhi'); assert a3.startswith('I can only help with using this app'); a4 = await ask('call count nahi hui kyu'); assert 'My calls' in a4; a5 = await ask('streak bonus'); assert '₹50 when your streak reaches 7 days' in a5
        await c.screenshot(path=SHOTS + '/rscalling-v11-caller-help.png'); ok('Help chat answers counting / Hinglish withdraw / not-counted / streak bonus (live ₹50) and refuses off-topic with "I can only help with using this app"')
        await a.click('[data-t=log]'); await a.wait_for_timeout(700); at_ = await a.text_content('main'); assert 'payment_details_update' in at_ and 'withdrawal_paid' in at_ and 'terms_save' in at_ and 'log_request_approved' in at_; assert ('rita.test' + P) not in at_ and '123456789012' not in at_; ok('Activity log has all the new actions and no payment details')
        print('page errors:', errs); assert not errs; ok('no page errors (caller + admin)')
        await b.close()
    api('caller_delete', {'id': ids['rita']}, adm); api('caller_delete', {'id': ids['omar']}, adm)
asyncio.run(main())
json.dump(results, open(SHOTS + '/pw11-results.json', 'w'))
