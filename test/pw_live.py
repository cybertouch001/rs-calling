
import asyncio, sys
from playwright.async_api import async_playwright
BASE = sys.argv[1]; PW = open(sys.argv[2]).read().strip(); OUT = sys.argv[3]
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); errs = []
        m = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True)
        pg = await m.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(BASE + '/'); await pg.wait_for_timeout(800); await pg.screenshot(path=OUT + '/rscalling-L1-live-home-phone.png', full_page=True)
        d = await b.new_context(viewport={'width': 1280, 'height': 800}); a = await d.new_page(); a.on('pageerror', lambda e: errs.append(str(e)))
        await a.goto(BASE + '/admin'); await a.wait_for_selector('#lu'); await a.screenshot(path=OUT + '/rscalling-L2-live-admin-login.png')
        await a.fill('#lu', 'admin'); await a.fill('#lp', PW); await a.click('#lb'); await a.wait_for_selector('.stats', timeout=20000); await a.wait_for_timeout(600)
        await a.screenshot(path=OUT + '/rscalling-L3-live-admin-dashboard.png', full_page=True)
        await a.click('[data-t=settings]'); await a.wait_for_selector('#s1'); await a.screenshot(path=OUT + '/rscalling-L4-live-settings.png', full_page=True)
        await a.click('#mo'); await a.click('#m_out'); await a.wait_for_selector('#lu')
        print('errors', errs); await b.close()
asyncio.run(main())
