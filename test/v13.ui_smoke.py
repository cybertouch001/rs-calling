
import asyncio, json, sys, time, random, string, urllib.request
from playwright.async_api import async_playwright
BASE=sys.argv[1]; ADMIN_PW=open(sys.argv[2]).read().strip(); SHOT=sys.argv[3]
P='ui'+''.join(random.choice(string.ascii_lowercase) for _ in range(4))
def api(m, body, tok=None):
    req=urllib.request.Request(BASE+'/api/'+m, data=json.dumps(body).encode(), headers={'content-type':'application/json','x-rsc':'1',**({'authorization':'Bearer '+tok} if tok else {})})
    try: return json.loads(urllib.request.urlopen(req, timeout=60).read())
    except urllib.error.HTTPError as e: return json.loads(e.read())
adm=api('login',{'login':'admin','password':ADMIN_PW,'app':'web','device':'ui-smoke'})['token']
cid=api('caller_save',{'name':'UI '+P,'username':P,'password':'secret123'},adm)['id']
N=str(7100000000+random.randint(1,99999999))
api('import_start',{'file_name':P+'.xlsx','assign':'user','user_id':cid},adm)
imp=api('import_start',{'file_name':P+'.xlsx','assign':'user','user_id':cid},adm)
api('import_chunk',{'import_id':imp['import_id'],'rows':[{'phone':N,'name':'Smoke Client'}]},adm); api('import_finish',{'import_id':imp['import_id']},adm)
ctok=api('login',{'login':P,'password':'secret123','app':'web','device':'ui-smoke'})['token']; api('terms_accept',{'version':1},ctok)
lst=api('my_list',{},ctok)['contacts']; k=[x for x in lst if x['phone']==N][0]
t0=int(time.time()*1000)
api('sync',{'calls':[{'id':'ui'+P+'a1','contact_id':k['id'],'phone':N,'tapped_at':t0-600000,'start_ts':t0-600000,'duration':95,'log_found':True,'log_phone':N,'outcome':None,'note':'smoke'}]},ctok)
errs=[]
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(args=['--no-sandbox'])
        pg=await b.new_page(viewport={'width':390,'height':844}, has_touch=True, is_mobile=True)
        pg.on('pageerror', lambda e: errs.append('pageerror: '+str(e)))
        pg.on('console', lambda m: errs.append('console: '+m.text) if m.type=='error' else None)
        await pg.goto(BASE+'/app/'); await pg.wait_for_selector('#lu')
        await pg.fill('#lu',P); await pg.fill('#lp','secret123'); await pg.click('#lb')
        await pg.wait_for_selector('#cl', timeout=20000)
        await pg.wait_for_timeout(1500)
        # history sheet from the caller list
        await pg.click('a.hlink'); await pg.wait_for_selector('.sheet #nhb', timeout=10000)
        await pg.wait_for_function("document.querySelector('#nhb') && !document.querySelector('#nhb').textContent.includes('Loading')", timeout=10000)
        txt=await pg.inner_text('.sheet'); print('CALLER HISTORY SHEET:', txt[:400].replace('\n',' | '))
        assert 'Interest' in txt or 'Answered' in txt
        await pg.screenshot(path=SHOT+'-caller-history.png')
        await pg.evaluate("document.querySelector('.sheet') && document.querySelector('.sheet').remove()")
        # pull to refresh: synthetic touch drag from the top
        await pg.evaluate("""() => { const t=(x,y)=>new Touch({identifier:1,target:document.body,clientX:x,clientY:y});
          document.dispatchEvent(new TouchEvent('touchstart',{touches:[t(100,100)],bubbles:true}));
          document.dispatchEvent(new TouchEvent('touchmove',{touches:[t(100,260)],bubbles:true}));
          document.dispatchEvent(new TouchEvent('touchend',{changedTouches:[t(100,260)],bubbles:true})); }""")
        await pg.wait_for_timeout(1500)
        print('PULL BAR shown:', await pg.evaluate("document.querySelector('#ptr').textContent"), 'toast:', await pg.evaluate("[...document.querySelectorAll('.toast')].map(x=>x.textContent).join(',')"))
        # admin: upload history on Numbers
        ctx2=await b.new_context(viewport={'width':390,'height':844}, has_touch=True, is_mobile=True)
        pg2=await ctx2.new_page(); pg2.on('pageerror', lambda e: errs.append('admin pageerror: '+str(e)))
        await pg2.goto(BASE+'/app/'); await pg2.wait_for_selector('#lu')
        await pg2.fill('#lu','admin'); await pg2.fill('#lp',ADMIN_PW); await pg2.click('#lb')
        await pg2.wait_for_timeout(2000)
        await pg2.goto(BASE+'/app/#numbers'); await pg2.reload(); await pg2.wait_for_timeout(2500)
        btn=pg2.locator('.nav button, .bottom button', has_text='Numbers')
        if await btn.count(): await btn.first.click(); await pg2.wait_for_timeout(2500)
        has=await pg2.evaluate("!!document.querySelector('#uhist') && document.querySelector('#uhist').innerText.includes('Every upload')")
        print('ADMIN UPLOAD HISTORY CARD:', has)
        await pg2.screenshot(path=SHOT+'-admin-uploads.png')
        if await pg2.locator('#uhl a[data-nh]').count():
            await pg2.locator('#uhl a[data-nh]').first.click(); await pg2.wait_for_timeout(2000)
            print('ADMIN NUMBER SHEET:', (await pg2.inner_text('.sheet'))[:300].replace('\n',' | '))
        await b.close()
asyncio.run(main())
print('PAGE ERRORS:', errs[:10])
