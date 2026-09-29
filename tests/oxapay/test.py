import json, hmac, hashlib, subprocess, time, urllib.request, urllib.error, concurrent.futures as cf, sys
BASE='http://127.0.0.1:8799'; KEY=b'local_test_merchant_key'; FAKE='http://127.0.0.1:9911'
RESULTS=[]
def check(name, cond, info=''):
    RESULTS.append((name, bool(cond))); print(('PASS' if cond else 'FAIL'), name, info if not cond else '')
def req(method, path, body=None, headers=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    r = urllib.request.Request(BASE+path, data=data, method=method, headers={'Content-Type':'application/json', **(headers or {})})
    try:
        with urllib.request.urlopen(r) as resp: return resp.status, resp.read().decode(), resp.headers
    except urllib.error.HTTPError as e: return e.code, e.read().decode(), e.headers
def sql(q):
    out = subprocess.run(['npx','wrangler','d1','execute','liveira-shop','--local','--persist-to','/tmp/lvtest/state','--json','--command',q], cwd='/workspace/liveira-shop-worker', capture_output=True, text=True, env={'PATH':'/usr/bin:/bin:/usr/local/bin','HOME':'/home/box'})
    try: return json.loads(out.stdout)[0]['results']
    except Exception: print(out.stdout[-500:], out.stderr[-500:]); raise
def tglog():
    return [json.loads(l) for l in open('/tmp/lvtest/fake.log') if l.strip()]
def mark(): return len(tglog())
def since(m): return tglog()[m:]
UID=555001
def upd(obj): return req('POST','/telegram', obj, {'X-Telegram-Bot-Api-Secret-Token':'whs_local'})
def cbq(data): return upd({'update_id':1,'callback_query':{'id':'q1','from':{'id':UID,'username':'tester'},'data':data,'message':{'message_id':10,'chat':{'id':UID,'type':'private'}}}})
def msg(text, reply_to=None):
    m={'message_id':20,'from':{'id':UID,'username':'tester','is_bot':False},'chat':{'id':UID,'type':'private'},'text':text}
    if reply_to: m['reply_to_message']={'message_id':19,'from':{'id':1,'is_bot':True},'text':reply_to}
    return upd({'update_id':2,'message':m})
def sign(raw, key=KEY): return hmac.new(key, raw, hashlib.sha512).hexdigest()
def callback(payload, key=KEY, sig=None):
    raw=json.dumps(payload).encode()
    h={'HMAC': sig if sig is not None else sign(raw,key)}
    return req('POST','/oxapay/callback', raw=raw, headers=h)
def bal(): r=sql(f'SELECT balance FROM users WHERE user_id={UID}'); return r[0]['balance'] if r else None

# 1. start + menu
m=mark(); s,_,_=msg('/start'); ev=since(m)
kb=json.dumps(ev[-1]['body'].get('reply_markup'))
check('start shows Top up balance button', s==200 and 'Top up balance' in kb and '"topup"' in kb)
# 2. balance screen
m=mark(); cbq('balance'); ev=[e for e in since(m) if e.get('tg')=='editMessageText']
check('balance screen has Top up button', ev and 'topup' in json.dumps(ev[-1]['body']['reply_markup']))
# 3. topup menu
m=mark(); cbq('topup'); ev=[e for e in since(m) if e.get('tg')=='editMessageText']
kbs=json.dumps(ev[-1]['body']['reply_markup']) if ev else ''
check('topup menu presets 5/10/25/50 + custom', all(f'"tu:{a}"' in kbs for a in ['5','10','25','50']) and 'tu:custom' in kbs, kbs)
# 4. create invoice $10
m=mark(); cbq('tu:10'); ev=since(m)
inv=[e for e in ev if e.get('oxapay')=='invoice']
check('invoice request sent once', len(inv)==1)
b=inv[0]['body']; T1=inv[0]['track_id']
check('invoice uses merchant_api_key header', inv[0]['key']=='local_test_merchant_key')
check('invoice body fields', b['amount']==10 and b['currency']=='USD' and b['lifetime']==60 and b['callback_url']=='https://liveira-shop.kelumayou.workers.dev/oxapay/callback' and b['order_id'].startswith('lv_') and b.get('description') and b.get('thanks_message') and b.get('return_url')=='https://t.me/liveira_test_bot', b)
edits=[e for e in ev if e.get('tg')=='editMessageText']
kb=edits[-1]['body']['reply_markup']['inline_keyboard'] if edits else []
check('pay link sent as URL button', kb and kb[0][0].get('url')=='https://pay.oxapay.com/'+T1, kb)
P1=b['order_id']
row=sql(f"SELECT * FROM payments WHERE id='{P1}'")[0]
check('payments row pending with track id + link', row['status']=='pending' and row['track_id']==T1 and row['pay_link'].endswith(T1) and row['amount_usd']==10 and row['telegram_user_id']==UID and row['credited']==0, row)
b0=bal()
# 5. invalid HMAC
paid={'track_id':T1,'status':'Paid','type':'invoice','module_name':'OxaPay','amount':10,'value':10,'currency':'USDT','order_id':P1,'date':int(time.time()),'txs':[]}
s,body,_=callback(paid, key=b'wrong_key'); check('invalid HMAC rejected (401)', s==401, (s,body))
s,body,_=callback(paid, sig=''); check('missing HMAC rejected (401)', s==401, (s,body))
raw=json.dumps(paid).encode(); tampered=json.dumps({**paid,'amount':999}).encode()
s,body,_=req('POST','/oxapay/callback', raw=tampered, headers={'HMAC':sign(raw)}); check('tampered body rejected (401)', s==401)
check('balance unchanged after bad signatures', bal()==b0)
# 6. paying
s,body,_=callback({**paid,'status':'Paying'}); check('Paying callback -> 200 ok', s==200 and body=='ok', (s,body))
r=sql(f"SELECT status,credited FROM payments WHERE id='{P1}'")[0]; check('Paying marks paying, no credit', r['status']=='paying' and r['credited']==0 and bal()==b0, r)
# 7. paid
m=mark(); s,body,_=callback(paid); check('Paid callback -> 200 "ok"', s==200 and body=='ok', (s,body))
time.sleep(0.5)
check('balance credited +10 once', abs(bal()-(b0+10))<1e-9, bal())
notes=[e for e in since(m) if e.get('tg')=='sendMessage']
check('user notified "Payment confirmed, +$10.00 added. New balance: $10.00"', notes and 'Payment confirmed, +$10.00 added. New balance: $10.00' in notes[-1]['body']['text'] and notes[-1]['body']['chat_id']==UID, notes)
tp=sql(f"SELECT * FROM topups WHERE ref='{P1}'"); check('topups row recorded', len(tp)==1 and tp[0]['amount']==10 and tp[0]['method']=='oxapay')
au=sql(f"SELECT * FROM audit_log WHERE action='oxapay_credit' AND details_json LIKE '%{P1}%'"); check('audit_log oxapay_credit recorded', len(au)==1, au)
# 8. duplicate
m=mark()
for _ in range(3): s,body,_=callback(paid)
time.sleep(0.3)
check('duplicate callbacks return ok', s==200 and body=='ok')
check('duplicate callbacks do not double-credit', abs(bal()-(b0+10))<1e-9, bal())
check('no second notification', not [e for e in since(m) if e.get('tg')=='sendMessage'])
check('still exactly one topup row', len(sql(f"SELECT id FROM topups WHERE ref='{P1}'"))==1)
# 9. concurrency: new invoice 25, 12 parallel paid callbacks
m=mark(); cbq('tu:25'); inv=[e for e in since(m) if e.get('oxapay')=='invoice'][0]; T2=inv['track_id']; P2=inv['body']['order_id']
p2={**paid,'track_id':T2,'order_id':P2,'amount':25}
b1=bal()
with cf.ThreadPoolExecutor(12) as ex: res=list(ex.map(lambda _: callback(p2), range(12)))
time.sleep(0.5)
check('12 concurrent Paid callbacks all 200', all(x[0]==200 for x in res), [x[0] for x in res])
check('concurrent callbacks credit exactly once (+25)', abs(bal()-(b1+25))<1e-9, bal())
check('concurrent: one topup row', len(sql(f"SELECT id FROM topups WHERE ref='{P2}'"))==1)
# 10. unknown track id
b2=bal()
s,body,_=callback({**paid,'track_id':'99999999','order_id':'lv_nope'}); check('unknown track_id -> 200 ok (ignored)', s==200 and body=='ok')
check('unknown track_id no credit', bal()==b2)
check('unknown track_id audited', len(sql("SELECT id FROM audit_log WHERE action='oxapay_callback_unmatched' AND details_json LIKE '%99999999%'"))==1)
# 11. wrong order id with known track
m=mark(); cbq('tu:5'); inv=[e for e in since(m) if e.get('oxapay')=='invoice'][0]; T3=inv['track_id']; P3=inv['body']['order_id']
s,body,_=callback({**paid,'track_id':T3,'order_id':'lv_someone_else','amount':5}); check('track_id/order_id mismatch ignored', s==200 and bal()==b2 and sql(f"SELECT credited FROM payments WHERE id='{P3}'")[0]['credited']==0)
# 12. callback claims bigger amount -> credit invoiced amount only
s,body,_=callback({**paid,'track_id':T3,'order_id':P3,'amount':5000,'value':5000}); time.sleep(0.3)
check('credits invoiced amount_usd (5), not callback amount (5000)', abs(bal()-(b2+5))<1e-9, bal())
# 13. expired
m=mark(); cbq('tu:50'); inv=[e for e in since(m) if e.get('oxapay')=='invoice'][0]; T4=inv['track_id']; P4=inv['body']['order_id']
b3=bal(); s,body,_=callback({**paid,'track_id':T4,'order_id':P4,'status':'Expired','amount':50})
r=sql(f"SELECT status,credited FROM payments WHERE id='{P4}'")[0]; check('Expired marks expired, no credit', s==200 and r['status']=='expired' and r['credited']==0 and bal()==b3, r)
s,body,_=callback({**paid,'track_id':T4,'order_id':P4,'status':'Underpaid','amount':50})
r=sql(f"SELECT status FROM payments WHERE id='{P4}'")[0]; check('Underpaid marks underpaid', r['status']=='underpaid', r)
# invalid JSON with valid sig
raw=b'not json'; s,body,_=req('POST','/oxapay/callback', raw=raw, headers={'HMAC':sign(raw)}); check('valid sig + invalid JSON -> 400', s==400)
s,body,_=req('GET','/oxapay/callback'); check('GET callback -> 405', s==405)
# 14. custom amount
m=mark(); cbq('tu:custom'); ev=[e for e in since(m) if e.get('tg')=='sendMessage']
prompt=ev[-1]['body']['text'] if ev else ''
check('custom amount prompt with force_reply', ev and ev[-1]['body']['reply_markup'].get('force_reply') is True, ev)
m=mark(); msg('12.5', reply_to=prompt); inv=[e for e in since(m) if e.get('oxapay')=='invoice']
check('custom 12.5 creates invoice', len(inv)==1 and inv[0]['body']['amount']==12.5, inv)
T5=inv[0]['track_id']; P5=inv[0]['body']['order_id']
m=mark(); msg('0.5', reply_to=prompt); ev=since(m)
check('custom below minimum rejected', not [e for e in ev if e.get('oxapay')] and 'Invalid amount' in ev[-1]['body']['text'])
m=mark(); msg('5000', reply_to=prompt); ev=since(m)
check('custom above maximum rejected', not [e for e in ev if e.get('oxapay')] and 'Invalid amount' in ev[-1]['body']['text'])
# 15. check-status button -> GET payment info -> Paid -> credit
urllib.request.urlopen(urllib.request.Request(FAKE+f'/_status/{T5}/Paid', data=b'', method='POST'))
b4=bal(); m=mark(); cbq(f'tuchk:{P5}'); time.sleep(0.3); ev=since(m)
check('check-status uses GET /payment/{track_id}', [e for e in ev if e.get('oxapay')=='GET' and e['track_id']==T5])
check('check-status credits once when Paid', abs(bal()-(b4+12.5))<1e-9, bal())
s,body,_=callback({**paid,'track_id':T5,'order_id':P5,'amount':12.5}); check('later Paid callback does not double credit', abs(bal()-(b4+12.5))<1e-9)
# 16. toggle off
subprocess.run(['true'])
sql("UPDATE settings SET value='0' WHERE key='crypto_topup_enabled'")
m=mark(); cbq('topup'); ev=since(m); t=[e for e in ev if e.get('tg') in ('editMessageText','sendMessage')][-1]['body']['text']
check('toggle off -> unavailable message', 'unavailable' in t, t)
m=mark(); cbq('tu:10'); check('toggle off -> no invoice', not [e for e in since(m) if e.get('oxapay')])
sql("UPDATE settings SET value='1' WHERE key='crypto_topup_enabled'")
# 17. rate limit (max 5 open/hour): currently open pending: none? create until blocked
opened=0
for i in range(7):
    m=mark(); cbq('tu:5'); opened+= len([e for e in since(m) if e.get('oxapay')=='invoice'])
check('open invoice limit (5/hour) enforced', opened==5, opened)
# 18. token API unchanged (machine binding)
sql("INSERT INTO tokens (token,product_id,product_name,telegram_user_id,duration_days,created_at,expires_at,status) VALUES ('tokA','liveira_access','Liveira Access',1,3,'2026-01-01T00:00:00Z','2099-01-01T00:00:00Z','active')")
mid='a'*64
s,body,_=req('POST','/v1/validate',{'token':'tokA','machine_id':mid},{'X-API-Key':'tk_local'}); check('validate binds machine', s==200 and json.loads(body)['valid'] is True)
s,body,_=req('POST','/v1/validate',{'token':'tokA','machine_id':'b'*64},{'X-API-Key':'tk_local'}); check('validate other machine -> 403 machine_mismatch', s==403 and 'machine_mismatch' in body)
s,body,_=req('POST','/v1/validate',{'token':'tokA'},{'X-API-Key':'tk_local'}); check('validate no machine -> 400 machine_required', s==400)
s,body,_=req('GET','/v1/token/tokA',None,{'X-API-Key':'tk_local'}); check('GET token lookup works', s==200 and json.loads(body)['valid'] is True)
# 19. admin
s,body,h=req('POST','/admin/api/login',{'password':'pw_local'},{'X-Requested-With':'liveira-admin'})
cookie=h.get('Set-Cookie').split(';')[0]
A={'Cookie':cookie,'X-Requested-With':'liveira-admin'}
s,body,_=req('GET','/admin/api/payments',None,A); d=json.loads(body)
check('admin payments list', s==200 and d['total']>=10 and any(p['track_id']==T1 and p['status']=='paid' for p in d['payments']), (s, body[:300]))
s,body,_=req('GET','/admin/api/payments?status=paid',None,A); check('admin payments filter paid', s==200 and all(p['status']=='paid' for p in json.loads(body)['payments']))
s,body,_=req('GET','/admin/api/settings',None,A); d=json.loads(body)
check('admin settings include topup keys + oxapay info', d['settings']['topup_presets']=='5,10,25,50' and d['info']['oxapay_configured'] is True and d['info']['oxapay_callback_url'].endswith('/oxapay/callback'), d)
s,body,_=req('PUT','/admin/api/settings',{'topup_presets':'3, 7, 20','topup_min':'2','topup_max':'500','crypto_topup_enabled':'1'},A); check('admin save presets/min/max', s==200, body)
s,body,_=req('PUT','/admin/api/settings',{'topup_presets':'1, 7','topup_min':'2','topup_max':'500'},A); check('admin rejects preset below min', s==400, body)
s,body,_=req('PUT','/admin/api/settings',{'topup_min':'600','topup_max':'500'},A); check('admin rejects min>max', s==400, body)
m=mark(); cbq('topup'); kbs=json.dumps([e for e in since(m) if e.get('tg')=='editMessageText'][-1]['body']['reply_markup'])
check('bot uses edited presets', all(f'"tu:{a}"' in kbs for a in ['3','7','20']) and '"tu:5"' not in kbs, kbs)
s,body,_=req('POST',f'/admin/api/payments/{P4}/sync',None,A); check('admin sync endpoint works', s==200 and json.loads(body)['ok'], body)
s,body,_=req('GET','/admin/api/dashboard',None,A); check('dashboard crypto stat', s==200 and json.loads(body)['stats']['crypto_30d_sum']>=52.5, body[:400])
s,body,_=req('GET','/admin',None); check('admin page loads', s==200 and 'app.js' in body)
print('\nSUMMARY', sum(1 for _,ok in RESULTS if ok), '/', len(RESULTS))
