
import asyncio, json, os, sys, time
from playwright.async_api import async_playwright
BASE = sys.argv[1]; ADMIN_PW = open(sys.argv[2]).read().strip(); SHOTS = sys.argv[3]
st = json.load(open(SHOTS + '/pw-state.json')); P = st['prefix']; results = st['results']
def ok(name): results.append(name); print('ok', len(results), name, flush=True)
FAKE = """
(() => { const log = JSON.parse(localStorage.getItem('fake_log') || '[]'); let next = [];
 window.RSC = { server: () => '', version: () => '1.0.0', deviceName: () => 'Test Android (simulated bridge)', setLoggedIn: () => {},
  permissions: () => JSON.stringify({ call_log: true, call_phone: true, phone_state: true }), requestPermissions: () => {},
  readCallLog: (since) => JSON.stringify(JSON.parse(localStorage.getItem('fake_log') || '[]').filter(e => e.date >= Number(since))),
  call: (num) => { const d = window.__nextDur == null ? 60 : window.__nextDur; const l = JSON.parse(localStorage.getItem('fake_log') || '[]');
    const last = l.length ? l[l.length - 1] : null; const start = Math.max(Date.now() + 1200, last ? last.date + last.duration * 1000 + 4000 : 0);
    l.push({ number: '+91' + num, date: start, duration: d, type: 'outgoing' }); localStorage.setItem('fake_log', JSON.stringify(l));
    setTimeout(() => window.rscOnResume(), 300); },
  saveFile: () => {} }; })();
"""
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        cc = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        await cc.add_init_script(FAKE); c = await cc.new_page(); errs = []; c.on('pageerror', lambda e: errs.append(str(e)))
        await c.goto(BASE + '/app/'); await c.fill('#lu', P + 'ravi'); await c.fill('#lp', 'test1234'); await c.click('#lb'); await c.wait_for_selector('#tk', timeout=15000); await c.screenshot(path=SHOTS + '/rscalling-v11-caller-terms-gate.png'); await c.check('#tk'); await c.click('#ta'); await c.wait_for_selector('.callb', timeout=15000)
        n = await c.locator('.callb').count(); ok(f'caller Ravi logs in (simulated Android bridge), sees {n} assigned numbers')
        await c.screenshot(path=SHOTS + '/rscalling-10-caller-list.png')
        async def do_call(idx, dur, outcome, note='', cb=None, shot=None):
            await c.evaluate(f'window.__nextDur = {dur}')
            try: await c.locator('.callb').nth(idx).click(timeout=8000)
            except Exception:
                await c.screenshot(path=SHOTS + '/debug-fail.png'); print('DEBUG', await c.evaluate("document.body.innerText.slice(0,600)")); raise
            await c.wait_for_selector('.sheet[data-oc]', timeout=10000); await c.wait_for_timeout(300)
            await c.click(f'.sheet [data-o={outcome}]')
            if cb: await c.fill('#cbt', cb)
            if note: await c.fill('#nt', note)
            if shot: await c.screenshot(path=shot)
            await c.click('#os'); await c.wait_for_timeout(1500)
        await do_call(0, 95, 'interested', 'Wants monthly GST filing, call with price', shot=SHOTS + '/rscalling-11-caller-after-call.png'); ok('call 1: 95 s, Interested + note')
        await c.click('[data-f=all]'); await c.wait_for_timeout(300)
        await do_call(1, 8, 'not_interested'); ok('call 2: 8 s (too short)')
        await do_call(2, 0, 'not_reachable'); ok('call 3: 0 s (not connected)')
        await do_call(3, 45, 'callback', cb='2026-11-05T11:30'); ok('call 4: 45 s, Callback tomorrow 11:30')
        await do_call(0, 50, 'interested'); ok('call 5: same number as call 1 again (repeat)')
        await c.wait_for_timeout(1500)
        q = await c.evaluate("JSON.parse(localStorage.getItem('rsc_queue')).map(x => [x.duration, x.synced, x.counted, x.reason_text])"); print('   queue', q)
        assert all(x[1] for x in q), 'not all synced'; ok('all 5 calls synced to the server')
        await c.click('[data-t=today]'); await c.wait_for_selector('.stats', timeout=10000); await c.wait_for_timeout(500); await c.screenshot(path=SHOTS + '/rscalling-12-caller-my-calls.png', full_page=True)
        txt = await c.text_content('main'); assert 'Counted' in txt; ok('caller sees counted / not counted + reason')
        # offline queue: go offline, make a call, come back online
        await c.click('[data-t=list]'); await c.wait_for_selector('.callb'); await c.click('[data-f=all]'); await cc.set_offline(True)
        await do_call(4, 70, 'not_interested'); q = await c.evaluate("JSON.parse(localStorage.getItem('rsc_queue')).filter(x => !x.synced).length"); assert q == 1; ok('offline: call saved on the phone, waiting to sync')
        await c.screenshot(path=SHOTS + '/rscalling-13-caller-offline.png')
        await cc.set_offline(False); await c.evaluate("window.dispatchEvent(new Event('online'))"); await c.wait_for_timeout(3000)
        q = await c.evaluate("JSON.parse(localStorage.getItem('rsc_queue')).filter(x => !x.synced).length"); assert q == 0; ok('back online: queued call synced')
        # admin
        ac = await b.new_context(viewport={'width': 1280, 'height': 860}, accept_downloads=True); a = await ac.new_page(); a.on('pageerror', lambda e: errs.append('admin: ' + str(e)))
        await a.goto(BASE + '/app/'); await a.fill('#lu', 'admin'); await a.fill('#lp', ADMIN_PW); await a.click('#lb'); await a.wait_for_selector('.stats')
        await a.wait_for_timeout(500); await a.screenshot(path=SHOTS + '/rscalling-06-dashboard.png', full_page=True)
        dash = await a.text_content('main'); print('   dash', ' '.join(dash.split())[:400])
        async with a.expect_download() as d1: await a.click('#dx')
        f1 = SHOTS + '/export-dashboard.xlsx'; await (await d1.value).save_as(f1)
        async with a.expect_download() as d2: await a.click('#dp')
        f2 = SHOTS + '/export-dashboard.pdf'; await (await d2.value).save_as(f2); ok('dashboard Excel + PDF downloaded')
        await a.click('[data-t=calls]'); await a.wait_for_selector('#fgo'); await a.wait_for_timeout(500); await a.screenshot(path=SHOTS + '/rscalling-07-calls.png', full_page=True)
        ct = ' '.join((await a.text_content('main')).split()); assert 'Repeat call' in ct and 'Same-time' not in ct and 'Shorter than the minimum' in ct and 'Not connected' in ct; ok('calls page shows reasons: repeat / too short / not connected')
        # override the short call with a reason
        await a.locator('tr', has_text='8s').locator('[data-ov]').first.click(); await a.select_option('#ovv', '1'); await a.fill('#ovr', 'Client said line dropped, verified'); await a.click('#ovs'); await a.wait_for_timeout(1200)
        assert 'Counted by admin' in await a.text_content('main'); ok('admin override with reason -> counted')
        async with a.expect_download() as d3: await a.click('#cx')
        await (await d3.value).save_as(SHOTS + '/export-calls.xlsx')
        # payouts: adjustment + approve
        await a.click('[data-t=payouts]'); await a.wait_for_selector('#pgo'); await a.locator('tr', has_text='Ravi').locator('[data-adj]').click()
        await a.fill('#aja', '-5'); await a.fill('#ajr', 'Late start (test)'); await a.click('#ajs'); await a.wait_for_timeout(1200)
        await a.screenshot(path=SHOTS + '/rscalling-08-payouts.png', full_page=True)
        pt = ' '.join((await a.text_content('main')).split()); print('   payouts', pt[:300])
        async with a.expect_download() as d4: await a.click('#ppd')
        await (await d4.value).save_as(SHOTS + '/export-payout.pdf')
        async with a.expect_download() as d5: await a.click('#px')
        await (await d5.value).save_as(SHOTS + '/export-payout.xlsx'); ok('payout PDF + Excel downloaded')
        await a.locator('tr', has_text='Ravi').locator('[data-ap]').click(); await a.wait_for_selector('#aps'); await a.click('#aps'); await a.wait_for_timeout(1200)
        assert 'Available to withdraw' in await a.text_content('main'); ok('payout approved (locked)')
        await a.screenshot(path=SHOTS + '/rscalling-08b-payouts-approved.png', full_page=True)
        # leads
        await a.click('[data-t=leads]'); await a.wait_for_selector('[data-l]'); await a.wait_for_timeout(400)
        await a.locator('[data-fu]').first.click(); await a.fill('#fua', '2026-11-04T10:00'); await a.fill('#fun', 'Send GST price list'); await a.click('#fuv'); await a.wait_for_timeout(1000)
        await a.screenshot(path=SHOTS + '/rscalling-14-leads.png', full_page=True); ok('lead follow-up reminder saved')
        await a.click('[data-l=callback]'); await a.wait_for_timeout(800); assert 'Caller callback' in await a.text_content('main'); ok('callback shows in callbacks list')
        # devices + force logout
        await a.click('[data-t=devices]'); await a.wait_for_selector('[data-so]'); await a.screenshot(path=SHOTS + '/rscalling-15-devices.png', full_page=True)
        await a.locator('tr', has_text='Ravi').locator('[data-so]').click(); await a.wait_for_timeout(800)
        t0 = time.time(); await c.wait_for_selector('#lu', timeout=30000); ok(f'admin logged out Ravi\'s phone -> it returned to login in {time.time()-t0:.0f}s')
        await c.screenshot(path=SHOTS + '/rscalling-16-caller-logged-out.png')
        await a.click('[data-t=log]'); await a.wait_for_timeout(800); await a.screenshot(path=SHOTS + '/rscalling-17-activity.png')
        print('page errors:', errs)
        assert not errs; ok('no page errors')
        await b.close()
asyncio.run(main())
json.dump({**st, 'results': results}, open(SHOTS + '/pw-state.json', 'w'))
