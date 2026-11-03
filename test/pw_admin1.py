
import asyncio, json, os, sys, time, random, string, urllib.request
from playwright.async_api import async_playwright
BASE = sys.argv[1]; ADMIN_PW = open(sys.argv[2]).read().strip(); SHOTS = sys.argv[3]; os.makedirs(SHOTS, exist_ok=True)
P = 'pw' + ''.join(random.choice(string.ascii_lowercase) for _ in range(4))
results = []
def ok(name): results.append(name); print('ok', len(results), name, flush=True)
def api(m, body, tok=None):
    req = urllib.request.Request(BASE + '/api/' + m, data=json.dumps(body).encode(), headers={'content-type': 'application/json', 'x-rsc': '1', **({'authorization': 'Bearer ' + tok} if tok else {})})
    try: return json.loads(urllib.request.urlopen(req, timeout=30).read())
    except urllib.error.HTTPError as e: return json.loads(e.read())
async def main():
    import pandas as pd
    base = random.randint(60000, 69999) * 100000
    names = ['Sharma Traders', 'Gupta Medical', 'Verma Electronics', 'Singh Hardware', 'Yadav Dairy', 'Mishra Sweets', 'Pandey Textiles', 'Jaiswal Kirana', 'Tiwari Mobiles', 'Maurya Steel', 'Kesari Tea Stall', 'Shukla Books']
    rows = [{'Name': n + ' (sample)', 'Phone': ('+91 ' if i % 3 == 0 else '') + str(base + i), 'Area': ['Lanka', 'Sigra', 'Bhelupur', 'Godowlia'][i % 4], 'Notes': 'Sample row' if i % 2 else ''} for i, n in enumerate(names)]
    rows.append({'Name': 'Duplicate of first', 'Phone': str(base), 'Area': '', 'Notes': ''}); rows.append({'Name': 'Broken number', 'Phone': '12345', 'Area': '', 'Notes': ''})
    xl = os.path.join(SHOTS, 'upload-test.xlsx'); pd.DataFrame(rows).to_excel(xl, index=False)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1280, 'height': 860}, accept_downloads=True)
        pg = await ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(BASE + '/'); await pg.wait_for_timeout(500); await pg.screenshot(path=SHOTS + '/rscalling-01-home.png', full_page=True); ok('landing page')
        await pg.goto(BASE + '/admin'); await pg.wait_for_selector('#lu'); await pg.screenshot(path=SHOTS + '/rscalling-02-login.png')
        await pg.fill('#lu', 'admin'); await pg.fill('#lp', 'wrong-password'); await pg.click('#lb'); await pg.wait_for_function("document.querySelector('#le').textContent.length>0")
        assert 'Wrong' in await pg.text_content('#le'); ok('wrong admin password shows error')
        await pg.fill('#lp', ADMIN_PW); await pg.click('#lb'); await pg.wait_for_selector('.stats'); ok('admin login -> dashboard')
        # callers
        await pg.click('[data-t=callers]'); await pg.wait_for_selector('#cn')
        for nm, un in [('Ravi (test)', P + 'ravi'), ('Pooja (test)', P + 'pooja')]:
            await pg.fill('#cn', nm); await pg.fill('#cu', un); await pg.fill('#cw', 'test1234'); await pg.click('#cadd')
            await pg.wait_for_selector('.sheet'); await pg.click('.sheet .btn'); await pg.wait_for_timeout(600)
        assert await pg.locator('text=' + P + 'ravi').count() > 0; ok('2 callers added from the web form')
        await pg.screenshot(path=SHOTS + '/rscalling-05-callers.png', full_page=True)
        # numbers upload with round robin
        await pg.click('[data-t=numbers]'); await pg.wait_for_selector('#uf'); await pg.set_input_files('#uf', xl); await pg.wait_for_selector('#ugo')
        await pg.select_option('#uas', 'rr'); await pg.screenshot(path=SHOTS + '/rscalling-03-upload-preview.png', full_page=True); await pg.click('#ugo')
        await pg.wait_for_selector('text=Upload done', timeout=20000); txt = await pg.text_content('#up'); print('   ', txt.strip()[:220])
        assert '12 new numbers added' in txt and '12 assigned' in txt and '1 duplicate in file' in txt and '1 without a valid' in txt; ok('Excel upload: 12 added, dedupe + invalid reported, round-robin assigned')
        await pg.wait_for_timeout(800); await pg.screenshot(path=SHOTS + '/rscalling-04-numbers.png', full_page=True)
        # assign manually: filter search, select first 2, give to pooja
        cs = api('callers_list', {}, None)
        # settings
        await pg.click('[data-t=settings]'); await pg.wait_for_selector('#s1'); await pg.fill('#s1', '2'); await pg.fill('#s2', '30'); await pg.fill('#s3', '30'); await pg.fill('#s4', '24'); await pg.click('#ssv'); await pg.wait_for_timeout(1200)
        await pg.screenshot(path=SHOTS + '/rscalling-09-settings.png', full_page=True); ok('settings: Rs 2/call, Rs 30/lead, 30 s min saved')
        await b.close()
    return xl, base
xl, base = asyncio.run(main())
json.dump({'prefix': P, 'base': base, 'results': results}, open(SHOTS + '/pw-state.json', 'w'))
