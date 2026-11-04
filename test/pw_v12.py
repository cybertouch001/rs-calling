
# v1.2 browser test: admin upload flow at phone width (390x844), real .xlsx files.
#  kernel-venv python test/pw_v12.py <BASE> <admin-pw-file> <shots-dir> <persist-dir> <messy-xlsx-out>
import asyncio, json, os, sys, random, string, urllib.request, glob, sqlite3, csv, io
from playwright.async_api import async_playwright
import openpyxl
BASE = sys.argv[1]; ADMIN_PW = open(sys.argv[2]).read().strip(); SHOTS = sys.argv[3]; PERSIST = sys.argv[4]; MESSY = sys.argv[5]
os.makedirs(SHOTS, exist_ok=True)
LEADS_DIR = os.environ.get('RSC_LEAD_FILES', '/home/user/tab/files')   # the real lead workbooks (not in the repo)
LEADS1 = LEADS_DIR + '/leads-2026-11-04.xlsx'
P = 'pw12' + ''.join(random.choice(string.ascii_lowercase) for _ in range(3)); results = []
def ok(name): results.append(name); print('ok', len(results), name, flush=True)
def api(m, body, tok=None):
    req = urllib.request.Request(BASE + '/api/' + m, data=json.dumps(body).encode(), headers={'content-type': 'application/json', 'x-rsc': '1', **({'authorization': 'Bearer ' + tok} if tok else {})})
    try: return json.loads(urllib.request.urlopen(req, timeout=60).read())
    except urllib.error.HTTPError as e: return json.loads(e.read())
def make_messy(path):
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Clients'
    ws.append(['Client list — November (keep private)']); ws.append([])
    ws.append(['Sr', 'Firm', 'City', 'Contact', 'Alt', 'Rating', 'Remarks'])
    ws.append([1, 'Ram Traders', 'Lanka', '+91 98765 43210', None, 4.5, 'hot'])
    ws.append([2, 'Shyam & Co', 'Sigra', 9123456789, None, 4, ''])
    ws.append([3, 'Dup of Ram', 'Lanka', '9876543210', None, 4, 'again'])
    ws.append([4, 'Landline shop', 'Cant', '0542 240 5214', None, 3, ''])
    ws.append([5, 'Two numbers', 'Y', '9988776655 / 9977665544', None, 5, ''])
    ws.append([6, 'Float cell', 'Z', 8.1234567e9, None, 5, 'float'])
    ws.append([7, 'Alt column only', 'W', None, '98001 12233', 2, 'alt'])
    ws.append([])
    ws.append([9, 'No number', 'Q', None, None, 1, ''])
    ws.append([10, 'Text in phone', 'R', 'call office', None, 1, ''])
    ws.append([11, 'Leading zero', 'T', '09811122233', None, 3, ''])
    ws.append([12, 'Repeated digits', 'U', '5555555555', None, 1, ''])
    wb.save(path)
MESSY_EXPECT = 7   # unique valid numbers in make_messy()
def db_exec(sql, args=()):
    f = glob.glob(PERSIST + '/v3/d1/miniflare-D1DatabaseObject/*.sqlite')[0]; con = sqlite3.connect(f, timeout=20); con.execute(sql, args); con.commit(); con.close()
async def main():
    make_messy(MESSY)
    adm = api('login', {'login': 'admin', 'password': ADMIN_PW, 'app': 'web'})['token']
    # a clean start on this (local) database: take back every upload that has no called numbers
    for bt in api('import_list', {}, adm).get('batches', []):
        if bt.get('can_undo') and bt.get('status') != 'undone': api('import_undo', {'import_id': bt['id']}, adm)
    rid = api('caller_save', {'name': 'Rita (test)', 'username': P + 'rita', 'password': 'test1234'}, adm)['id']
    async with async_playwright() as p:
        b = await p.chromium.launch(); errs = []
        ac = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, accept_downloads=True)
        a = await ac.new_page(); a.on('pageerror', lambda e: errs.append('admin: ' + str(e))); a.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        await a.goto(BASE + '/app/'); await a.fill('#lu', 'admin'); await a.fill('#lp', ADMIN_PW); await a.click('#lb'); await a.wait_for_selector('.stats')
        await a.click('[data-t=numbers]'); await a.wait_for_selector('#uf'); await a.wait_for_timeout(400)
        await a.screenshot(path=SHOTS + '/rscalling-v12-1-upload-empty.png'); ok('phone width: Numbers tab has the upload card and the recent-uploads card')
        # oversize file refused before anything is read
        big = '/tmp/rsc-big.csv'; open(big, 'wb').write(b'Phone\n' + b'9811122233\n' * 600000)
        await a.set_input_files('#uf', big); await a.wait_for_selector('#up .err'); t_ = ' '.join((await a.text_content('#up')).split()); assert '5 MB' in t_, t_; ok('file over 5 MB is refused with a plain message')
        # --- the lead sheet from the lead sourcing run
        await a.set_input_files('#uf', LEADS1); await a.wait_for_selector('#ugo'); await a.wait_for_function("document.querySelector('#cNew') && document.querySelector('#cNew').textContent !== '…'")
        assert (await a.text_content('#cNew')).strip() == '5', await a.text_content('#cNew'); assert (await a.text_content('#cEx')).strip() == '0'
        mp = await a.eval_on_selector('#mp', 'e => e.options[e.selectedIndex].text'); assert mp.strip() == 'Phone', mp
        assert 'Import 5 new numbers' in await a.text_content('#ugo')
        await a.screenshot(path=SHOTS + '/rscalling-v12-2-preview-leads.png', full_page=True); ok('lead sheet: Phone column chosen automatically, 5 valid numbers, 0 already listed, preview shown')
        # change the phone column to the Name column: counts change, then put it back
        await a.select_option('#mp', label='Business'); await a.wait_for_timeout(500)
        assert (await a.text_content('#cNew')).strip() == '0', await a.text_content('#cNew'); ok('changing the phone column to a text column updates the counts (0 numbers)')
        await a.select_option('#mp', label='Phone'); await a.wait_for_function("document.querySelector('#cNew').textContent.trim() === '5'"); ok('switching back to Phone gives 5 again')
        # download the skipped rows
        async with a.expect_download() as dl:
            await a.click('#skipcsv')
        d = await dl.value; path = await d.path(); body = open(path, encoding='utf-8-sig').read(); assert body.splitlines()[0] == 'Row,Reason,Value,Name', body[:80]
        assert 'No number in the row' in body; ok('skipped rows download as a CSV with row, reason, value and name')
        # import: keep unassigned
        await a.click('#ugo'); await a.wait_for_selector('.banner', timeout=20000); bt = ' '.join((await a.text_content('.banner')).split())
        assert 'Upload done' in bt and '5 new numbers added' in bt, bt; ok('import: 5 numbers added, banner says what was skipped')
        await a.wait_for_selector('[data-undo]'); await a.wait_for_timeout(400)
        await a.screenshot(path=SHOTS + '/rscalling-v12-3-imported-recent-uploads.png', full_page=True); ok('recent uploads lists the import with an Undo button')
        # re-upload the same sheet: all already in the list
        await a.set_input_files('#uf', LEADS1); await a.wait_for_function("document.querySelector('#cEx') && document.querySelector('#cEx').textContent.trim() === '5'")
        assert (await a.text_content('#cNew')).strip() == '0'; assert 'Import' in await a.text_content('#ugo') and (await a.is_disabled('#ugo')); ok('same sheet again: 5 already in the list, import button disabled')
        await a.click('#ucancel')
        # messy sheet, shared between callers
        await a.set_input_files('#uf', MESSY); await a.wait_for_function("document.querySelector('#cNew') && document.querySelector('#cNew').textContent !== '…'")
        mt = ' '.join((await a.text_content('#up')).split())
        assert (await a.text_content('#cNew')).strip() == str(MESSY_EXPECT), (await a.text_content('#cNew')); ok(f'messy sheet: {MESSY_EXPECT} valid numbers found (title row, float, two numbers in a cell, alt column, leading zero)')
        assert 'repeated in the file' in mt and 'skipped' in mt; await a.screenshot(path=SHOTS + '/rscalling-v12-4-preview-messy.png', full_page=True); ok('messy sheet preview names the counts')
        await a.select_option('#uas', value='rr'); await a.click('#ugo'); await a.wait_for_selector('.banner', timeout=20000)
        bt2 = ' '.join((await a.text_content('.banner')).split()); assert f'{MESSY_EXPECT} new numbers added' in bt2 and 'assigned' in bt2, bt2; ok('messy import shared between the active callers')
        # undo the lead upload (no calls on it)
        await a.wait_for_selector('[data-undo]'); rows_before = await a.locator('[data-undo]').count(); assert rows_before >= 2
        await a.locator('tr', has_text='leads-2026-11-04.xlsx').locator('[data-undo]').first.click(); await a.wait_for_timeout(1200)
        t3 = ' '.join((await a.text_content('main')).split()); assert 'Undone' in t3; ok('undo: the leads upload is removed and marked Undone')
        # caller view: a caller sees only the numbers assigned to them
        ct = api('login', {'login': P + 'rita', 'password': 'test1234', 'app': 'android'})['token']; api('terms_accept', {'version': api('terms_current', {}, ct)['terms']['version']}, ct)
        mine = api('my_list', {}, ct)['contacts']; theirs = api('contacts_list', {'assigned': rid, 'limit': 500}, adm)['total']; assert len(mine) == theirs and len(mine) <= MESSY_EXPECT, (len(mine), theirs); ok(f'caller Rita sees {len(mine)} of the shared numbers, not the whole list')
        await b.close()
    print('ERRORS', errs)
    assert not errs, errs
    print('ALL pw12 ok', len(results))
asyncio.run(main())
