
import json, sys, urllib.request, time, random
BASE = sys.argv[1]; PW = open(sys.argv[2]).read().strip()
def api(m, body, tok=None):
    req = urllib.request.Request(BASE + '/api/' + m, data=json.dumps(body).encode(), headers={'content-type': 'application/json', 'x-rsc': '1', 'user-agent': 'rsc-live-test', **({'authorization': 'Bearer ' + tok} if tok else {})})
    try: r = urllib.request.urlopen(req, timeout=30); j = json.loads(r.read()); j['_s'] = r.status; return j
    except urllib.error.HTTPError as e: j = json.loads(e.read()); j['_s'] = e.code; return j
n = 0
def ok(x): global n; n += 1; print('ok', n, x, flush=True)
assert api('login', {'login': 'admin', 'password': 'definitely-wrong'})['_s'] == 401; ok('wrong admin password -> 401')
a = api('login', {'login': 'admin', 'password': PW, 'app': 'web', 'device': 'live-test'}); assert a['ok'], a; at = a['token']; ok('admin login with the generated password')
s = api('settings_get', {}, at)['settings']; ok('settings: ' + json.dumps({k: s[k] for k in ['call_rate', 'lead_rate', 'min_duration', 'repeat_hours']}))
un = 'livetest' + str(random.randint(1000, 9999))
cid = api('caller_save', {'name': 'Live Test Caller', 'username': un, 'password': 'livetest123'}, at)['id']; ok('caller created')
ct = api('login', {'login': un, 'password': 'livetest123', 'app': 'android', 'device': 'live-test-phone'}); assert ct['ok']; ok('caller login'); assert api('my_list', {}, ct['token'])['_s'] == 403; assert api('terms_accept', {'version': 1}, ct['token'])['ok']; ok('v1.1: caller must accept the Terms before the list opens')
assert api('my_list', {}, ct['token'])['ok']; ok('caller list loads')
assert api('dashboard', {}, ct['token'])['_s'] == 403; ok('caller blocked from admin API')
ss = api('sessions_list', {'user_id': cid}, at)['sessions']; assert len(ss) == 1 and ss[0]['app'] == 'android'; ok('devices list shows the caller phone')
api('caller_save', {'id': cid, 'name': 'Live Test Caller', 'username': un, 'active': False}, at)
r = api('my_list', {}, ct['token']); assert r['_s'] == 401 and r.get('logged_out'); ok('deactivate -> caller logged out: ' + r['error'])
assert api('login', {'login': un, 'password': 'livetest123'})['_s'] == 403; ok('deactivated caller cannot log in')
d = api('caller_delete', {'id': cid}, at); assert d['removed'] and not d['kept_history']; ok('test caller fully removed (no history)')
assert api('dashboard', {}, at)['ok']; ok('dashboard loads')
api('logout', {}, at); assert api('dashboard', {}, at)['_s'] == 401; ok('admin logout revokes the session')
print('LIVE', n, 'checks passed')
