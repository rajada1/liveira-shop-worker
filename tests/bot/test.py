"""Local integration tests: bot UX + OxaPay security + token API + admin. Run against wrangler dev on :8799."""
import json, hmac, hashlib, subprocess, time, urllib.request, urllib.error, concurrent.futures as cf, itertools, re
BASE = 'http://127.0.0.1:8799'; KEY = b'local_test_merchant_key'; FAKE = 'http://127.0.0.1:9911'
RESULTS = []; qid = itertools.count(1)
def check(name, cond, info=''):
    RESULTS.append((name, bool(cond))); print(('PASS' if cond else 'FAIL'), name, '' if cond else str(info)[:600])
def req(method, path, body=None, headers=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    r = urllib.request.Request(BASE + path, data=data, method=method, headers={'Content-Type': 'application/json', **(headers or {})})
    try:
        with urllib.request.urlopen(r) as resp: return resp.status, resp.read().decode(), resp.headers
    except urllib.error.HTTPError as e: return e.code, e.read().decode(), e.headers
def sql(q):
    out = subprocess.run(['npx', 'wrangler', 'd1', 'execute', 'liveira-shop', '--local', '--persist-to', '/tmp/lvtest/state', '--json', '--command', q],
                         cwd='/workspace/liveira-shop-worker', capture_output=True, text=True, env={'PATH': '/usr/bin:/bin:/usr/local/bin', 'HOME': '/home/box'})
    try: return json.loads(out.stdout)[0]['results']
    except Exception: print(out.stdout[-500:], out.stderr[-500:]); raise
def logs(): return [json.loads(l) for l in open('/tmp/lvtest/fake.log') if l.strip()]
def mark(): return len(logs())
def since(m): return logs()[m:]
def tg(ev, method): return [e for e in ev if e.get('tg') == method]
def last_screen(ev):
    x = [e for e in ev if e.get('tg') in ('editMessageText', 'sendMessage') and not e.get('error')]
    return x[-1] if x else None
def buttons(entry):
    return [b for row in (entry['body'].get('reply_markup') or {}).get('inline_keyboard', []) for b in row] if entry else []
def cbdata(entry): return [b.get('callback_data') for b in buttons(entry)]
def sign(raw, key=KEY): return hmac.new(key, raw, hashlib.sha512).hexdigest()
def callback(payload, key=KEY, sig=None):
    raw = json.dumps(payload).encode()
    return req('POST', '/oxapay/callback', raw=raw, headers={'HMAC': sig if sig is not None else sign(raw, key)})

class User:
    def __init__(self, uid, first, username):
        self.uid, self.first, self.username = uid, first, username; self.mid = None
    def frm(self): return {'id': self.uid, 'is_bot': False, 'first_name': self.first, 'username': self.username}
    def upd(self, obj): return req('POST', '/telegram', obj, {'X-Telegram-Bot-Api-Secret-Token': 'whs_local'})
    def msg(self, text):
        m = mark(); self.upd({'update_id': 1, 'message': {'message_id': 5, 'from': self.frm(), 'chat': {'id': self.uid, 'type': 'private'}, 'text': text}}); return since(m)
    def cb(self, data, mid=None):
        q = str(next(qid)); m = mark()
        self.upd({'update_id': 2, 'callback_query': {'id': q, 'from': self.frm(), 'data': data, 'chat_instance': 'x',
                  'message': {'message_id': mid or self.mid, 'chat': {'id': self.uid, 'type': 'private'}, 'date': int(time.time())}}})
        ev = since(m)
        answers = [e for e in tg(ev, 'answerCallbackQuery') if e['body']['callback_query_id'] == q]
        return ev, answers
    def bal(self):
        r = sql(f'SELECT balance FROM users WHERE user_id={self.uid}'); return r[0]['balance'] if r else None

def nav(u, data, name, expect_text=None, expect_cb=(), must_home=True):
    ev, ans = u.cb(data)
    scr = last_screen(ev)
    ok = len(ans) == 1 and scr is not None and scr['tg'] == 'editMessageText' and scr['body']['message_id'] == u.mid and not tg(ev, 'sendMessage')
    if expect_text: ok = ok and all(t in scr['body']['text'] for t in ([expect_text] if isinstance(expect_text, str) else expect_text))
    cbs = cbdata(scr)
    ok = ok and all(c in cbs for c in expect_cb)
    if must_home: ok = ok and 'home' in cbs
    check(f'nav {name}: edits same message, answered once' + (', has 🏠 Home' if must_home else ''), ok, (ans, scr and scr['body'].get('text'), cbs, [e.get('tg') for e in ev]))
    return ev, ans, scr

# ───── setup: product with a file (cached tg file id so no R2 needed)
sql("UPDATE products SET file_key='products/liveira_access/x', file_name='liveira.zip', file_size=1048576, file_tg_id='CACHEDFILE' WHERE id='liveira_access'")
A = User(555001, 'Tester', 'tester')

# ───── home
ev = A.msg('/start'); home = last_screen(ev); A.mid = home['mid'] if home else None
t = home['body']['text'] if home else ''
check('/start sends home card (new message)', home and home['tg'] == 'sendMessage')
check('home: greeting with first name, bold balance, active licenses', 'Hi, <b>Tester</b>' in t and 'Balance: <b>$0.00</b>' in t and 'Active licenses: <b>0</b>' in t, t)
check('home: welcome text (new default) in blockquote', '<blockquote>Get your Liveira license in seconds.' in t and 'credited by the shop admin' not in t, t)
check('home: default welcome {coins} → "Top up with USDT", tip mentions USDT, no generic crypto', 'Top up with USDT — your balance is credited automatically.' in t and '{coins}' not in t and 'add funds with USDT' in t and 'crypto' not in t.lower(), t)
cbs = cbdata(home); rows = home['body']['reply_markup']['inline_keyboard']
check('home grid 3x2: Shop/Top up/Licenses/Downloads/Profile/Support', [len(r) for r in rows] == [2, 2, 2] and cbs == ['shop', 'topup', 'licenses', 'downloads', 'profile', 'support'], cbs)
check('home: button labels with emoji', [b['text'] for b in buttons(home)] == ['🛒 Shop', '💰 Top up', '🔑 My licenses', '📥 Downloads', '👤 Profile', '💬 Support'])
check('home: styled buttons (primary/success)', buttons(home)[0].get('style') == 'primary' and buttons(home)[1].get('style') == 'success')

# ───── navigation, every screen edits the same message
nav(A, 'shop', 'shop', ['🛒 <b>Shop</b>', 'Liveira Access'], ['buy:liveira_access'])
ev, _, scr = nav(A, 'buy:liveira_access', 'product', ['Choose a duration'], ['days:liveira_access:3', 'days:liveira_access:7', 'days:liveira_access:30', 'shop'])
check('product: duration buttons "3 days · $5.00"', '3 days · $5.00' in [b['text'] for b in buttons(scr)], [b['text'] for b in buttons(scr)])
check('product: ⬅️ Back + 🏠 Home row', buttons(scr)[-2]['text'] == '⬅️ Back' and buttons(scr)[-1]['text'] == '🏠 Home')
nav(A, 'licenses', 'licenses (empty)', ['No licenses yet', '🛒 Shop'], ['shop'])
nav(A, 'downloads', 'downloads (empty)', ['No downloads yet'])
nav(A, 'profile', 'profile', ['👤 <b>Profile</b>', 'No top-ups yet', 'No purchases yet'], ['topup'])
sql("INSERT OR REPLACE INTO settings (key,value) VALUES ('support_contact','@liveira_support')")
ev, _, scr = nav(A, 'support', 'support', ['💬 <b>Support</b>', '@liveira_support'])
check('support: URL button from support_contact', any(b.get('url') == 'https://t.me/liveira_support' for b in buttons(scr)))
ev, _, scr = nav(A, 'topup', 'top-up', ['💰 <b>Top up balance</b>', 'How it works', 'credited automatically'], ['tuc:5', 'tuc:10', 'tuc:25', 'tuc:50', 'kp:'])
tt = scr['body']['text']
check('top-up: USDT only ("We accept: USDT", How it works "pay with USDT", network hint), no other coins', '💳 We accept: <b>USDT</b>' in tt and 'pay with <b>USDT</b> — pick your network on the page (e.g. TRC20 or BEP20)' in tt and not re.search(r'BTC|ETH|LTC|any crypto', tt), tt)
check('top-up presets as 2x2 grid', [len(r) for r in scr['body']['reply_markup']['inline_keyboard'][:2]] == [2, 2])
nav(A, 'home', 'home', ['Hi, <b>Tester</b>'], must_home=False)
nav(A, 'balance', 'legacy "balance" → profile', ['👤 <b>Profile</b>'])
nav(A, 'menu', 'legacy "menu" → home', ['Hi, <b>Tester</b>'], must_home=False)
nav(A, 'buy:does_not_exist', 'unknown product → friendly', ['not available'])

# ───── keypad
ev, _, scr = nav(A, 'kp:', 'keypad open', ['✏️ <b>Other amount</b>', '$ 0', 'Min $1.00 · Max $1000.00'], ['kp:1', 'kp:9', 'kp:0', 'kp:', 'kpok:', 'topup'])
check('keypad layout 1-2-3/4-5-6/7-8-9/⌫-0-✅', [[b['text'] for b in r] for r in scr['body']['reply_markup']['inline_keyboard'][:4]] == [['1','2','3'],['4','5','6'],['7','8','9'],['⌫','0','✅']])
nav(A, 'kp:1', 'keypad 1', ['$ 1'], ['kp:12', 'kpok:1'])
ev, _, scr = nav(A, 'kp:12', 'keypad 12 (live edit)', ['$ 12'], ['kp:123', 'kp:1', 'kpok:12'])
check('keypad ✅ turns green when valid', [b for b in buttons(scr) if b['text'] == '✅'][0].get('style') == 'success')
ev, ans = A.cb('kp:12')
check('keypad same state → "not modified" handled (no new message)', len(ans) == 1 and not tg(ev, 'sendMessage') and any(e.get('error') == 'not modified' for e in tg(ev, 'editMessageText')), [e.get('tg') for e in ev])
ev, ans = A.cb('kp:10000')
check('keypad over max → toast, no edit', len(ans) == 1 and 'Maximum is $1000.00' in (ans[0]['body'].get('text') or '') and not tg(ev, 'editMessageText'), ans)
nav(A, 'kp:1', 'keypad ⌫ (12 → 1)', ['$ 1'])
ev, ans = A.cb('kpok:')
check('keypad ✅ empty → "Minimum" toast', len(ans) == 1 and 'Minimum is $1.00' in (ans[0]['body'].get('text') or ''), ans)
nav(A, 'kp:1000', 'keypad 1000 (max ok)', ['$ 1,000'])
ev, _, scr = nav(A, 'kpok:12', 'keypad ✅ → confirm top-up', ['💰 <b>Confirm top-up</b>', 'Amount: <b>$12.00</b>', 'Pay with: <b>USDT</b> via OxaPay (network of your choice)'], ['tun:12', 'topup'])
check('confirm top-up: no "any crypto"', 'any crypto' not in scr['body']['text'])

# ───── invoice card
ev, ans, scr = nav(A, 'tun:12', 'create invoice → invoice card', ['🧾 <b>Top-up invoice · $12.00</b>', 'Waiting for payment', 'Expires at <b>', 'BRT', '<tg-time unix="', 'How it works'])
inv = [e for e in ev if e.get('oxapay') == 'invoice']
check('invoice created once via OxaPay', len(inv) == 1 and inv[0]['body']['amount'] == 12 and inv[0]['body']['lifetime'] == 60 and inv[0]['body']['callback_url'].endswith('/oxapay/callback'))
T1 = inv[0]['track_id']; P1 = inv[0]['body']['order_id']
check('invoice card: How it works says USDT only', 'pay with <b>USDT</b>' in scr['body']['text'] and not re.search(r'BTC|ETH|any crypto', scr['body']['text']), scr['body']['text'])
check('invoice request: priced in USD, only documented OxaPay fields', inv[0]['body']['currency'] == 'USD' and set(inv[0]['body']) <= {'amount', 'currency', 'lifetime', 'callback_url', 'order_id', 'description', 'thanks_message', 'sandbox', 'return_url'}, sorted(inv[0]['body']))
b = buttons(scr)
check('invoice card: 💳 Pay now URL (success) / 🔄 Check status / ❌ Cancel (danger) / Home',
      b[0].get('url') == 'https://pay.oxapay.com/' + T1 and b[0]['text'] == '💳 Pay now' and b[0].get('style') == 'success'
      and b[1].get('callback_data') == f'tuchk:{P1}' and b[2].get('callback_data') == f'tux:{P1}' and b[2].get('style') == 'danger' and b[-1]['callback_data'] == 'home', b)
check('invoice toast "Invoice created"', 'Invoice created' in (ans[0]['body'].get('text') or ''))
row = sql(f"SELECT message_id, status, chat_id FROM payments WHERE id='{P1}'")[0]
check('payments.message_id = invoice card message', row['message_id'] == A.mid and row['status'] == 'pending', row)
ev, ans = A.cb(f'tun:12')
check('double tap "Create invoice" reuses the open invoice (no 2nd OxaPay call)', not [e for e in ev if e.get('oxapay') == 'invoice'] and 'open invoice' in (ans[0]['body'].get('text') or ''), ans)
ev, ans = A.cb(f'tuchk:{P1}')
check('🔄 Check status (unpaid) → toast "Not paid yet", card kept', len(ans) == 1 and 'Not paid yet' in (ans[0]['body'].get('text') or '') and [e for e in ev if e.get('oxapay') == 'GET'] and not tg(ev, 'sendMessage'), (ans, [e.get('tg') or e.get('oxapay') for e in ev]))

# paid callback edits the card
b0 = A.bal(); m = mark()
s_, body, _ = callback({'track_id': T1, 'status': 'Paid', 'type': 'invoice', 'amount': 12, 'currency': 'USDT', 'order_id': P1})
time.sleep(0.6); ev = since(m)
edits = [e for e in tg(ev, 'editMessageText') if e['body']['message_id'] == A.mid]
check('Paid callback → 200 "ok"', s_ == 200 and body == 'ok', (s_, body))
check('Paid callback edits the invoice card into ✅ paid state with new balance', edits and 'Payment received!' in edits[-1]['body']['text'] and 'New balance: <b>$12.00</b>' in edits[-1]['body']['text'], [e.get('body', {}).get('text') for e in edits])
notes = tg(ev, 'sendMessage')
check('…and sends "✅ Payment confirmed, +$12.00 added. New balance: $12.00" as reply to the card', notes and '✅ Payment confirmed, +$12.00 added. New balance: $12.00' == notes[-1]['body']['text'] and notes[-1]['body'].get('reply_parameters', {}).get('message_id') == A.mid, notes)
check('balance credited +12', abs(A.bal() - (b0 + 12)) < 1e-9)
m = mark(); callback({'track_id': T1, 'status': 'Paid', 'type': 'invoice', 'amount': 12, 'order_id': P1}); time.sleep(0.3)
check('duplicate Paid callback: no double credit, no new messages', abs(A.bal() - (b0 + 12)) < 1e-9 and not tg(since(m), 'sendMessage') and not tg(since(m), 'editMessageText'))

# ───── cancel + late payment still credited
ev, _, scr = nav(A, 'tuc:5', 'preset $5 → confirm top-up', ['Amount: <b>$5.00</b>'], ['tun:5'])
ev, _, scr = nav(A, 'tun:5', 'invoice $5')
T2 = [e for e in ev if e.get('oxapay') == 'invoice'][0]['track_id']; P2 = [e for e in ev if e.get('oxapay') == 'invoice'][0]['body']['order_id']
ev, ans, scr = nav(A, f'tux:{P2}', '❌ Cancel → canceled card', ['Canceled', 'still be credited'], ['topup'])
check('cancel toast + status canceled', 'canceled' in (ans[0]['body'].get('text') or '').lower() and sql(f"SELECT status FROM payments WHERE id='{P2}'")[0]['status'] == 'canceled')
b1 = A.bal(); callback({'track_id': T2, 'status': 'Paid', 'type': 'invoice', 'amount': 5, 'order_id': P2}); time.sleep(0.3)
check('late payment on a canceled invoice is still credited once', abs(A.bal() - (b1 + 5)) < 1e-9)

# ───── shortfall → top-up → continue purchase
B = User(555002, 'Bruna', 'bruna')
ev = B.msg('/start'); B.mid = last_screen(ev)['mid']
ev, _, scr = nav(B, 'days:liveira_access:7', 'confirm purchase with 0 balance → shortfall', ['Not enough balance', 'missing <b>$10.00</b>'], ['tuc:10:liveira_access:7', 'buy:liveira_access'])
check('shortfall button "💰 Top up $10.00" (success)', any(b['text'] == '💰 Top up $10.00' and b.get('style') == 'success' for b in buttons(scr)))
sql(f"UPDATE users SET balance=2.5 WHERE user_id={B.uid}")
ev, _, scr = nav(B, 'days:liveira_access:7', 'shortfall with $2.50 → missing $7.50', ['missing <b>$7.50</b>'], ['tuc:7.5:liveira_access:7'])
sql(f"UPDATE users SET balance=9.5 WHERE user_id={B.uid}")
ev, _, scr = nav(B, 'days:liveira_access:7', 'shortfall $0.50 → rounded up to minimum $1', ['missing <b>$0.50</b>'], ['tuc:1:liveira_access:7'])
sql(f"UPDATE users SET balance=2.5 WHERE user_id={B.uid}")
ev, _, scr = nav(B, 'tuc:7.5:liveira_access:7', 'shortfall top-up confirm', ['Amount: <b>$7.50</b>', 'continue your purchase'], ['tun:7.5:liveira_access:7'])
ev, _, scr = nav(B, 'tun:7.5:liveira_access:7', 'shortfall invoice card', ['$7.50'])
inv = [e for e in ev if e.get('oxapay') == 'invoice'][0]; T3, P3 = inv['track_id'], inv['body']['order_id']
check('invoice stores resume context', sql(f"SELECT resume FROM payments WHERE id='{P3}'")[0]['resume'] == 'liveira_access:7')
urllib.request.urlopen(urllib.request.Request(FAKE + f'/_status/{T3}/Paid', data=b'', method='POST'))
m = mark(); ev, ans = B.cb(f'tuchk:{P3}'); time.sleep(0.3); ev = since(m)
card = [e for e in tg(ev, 'editMessageText') if e['body']['message_id'] == B.mid]
check('"I\'ve paid" check → Paid → card edited with 🛒 Continue purchase', card and 'Payment received!' in card[-1]['body']['text'] and 'days:liveira_access:7' in cbdata(card[-1]) and '✅' in (ans[0]['body'].get('text') or ''), (ans, card and cbdata(card[-1])))
check('balance now $10.00', abs(B.bal() - 10) < 1e-9, B.bal())
ev, _, scr = nav(B, 'days:liveira_access:7', 'continue purchase → confirm', ['Confirm purchase', 'after purchase <b>$0.00</b>'], ['confirm:liveira_access:7'])
ev, ans, scr = nav(B, 'confirm:liveira_access:7', 'buy → success screen', ['✅ <b>Purchase successful!</b>', 'Expires: <b>', ' BRT</b>', '<code>'], ['dl:liveira_access', 'licenses'])
key = re.search(r'<code>([^<]+)</code>', scr['body']['text']).group(1)
check('success: 📋 copy_text button with the key', any(b.get('copy_text', {}).get('text') == key for b in buttons(scr)))
check('balance 0 after purchase', abs(B.bal()) < 1e-9)
ev, ans = B.cb('confirm:liveira_access:7'); scr = last_screen(ev)
check('second confirm with no balance → shortfall, not negative', 'Not enough balance' in scr['body']['text'] and abs(B.bal()) < 1e-9)
ev, _, scr = nav(B, 'licenses', 'licenses list', ['🟢 <b>Liveira Access</b>', '7 days left', f'<code>{key}</code>'])
check('licenses: copy button for active key', any(b.get('copy_text', {}).get('text') == key for b in buttons(scr)))
sql(f"INSERT INTO tokens (token,product_id,product_name,telegram_user_id,duration_days,created_at,expires_at,status) VALUES ('oldkey1','liveira_access','Liveira Access',{B.uid},3,'2026-01-01T00:00:00Z','2026-01-04T00:00:00Z','active')")
ev, _, scr = nav(B, 'licenses', 'licenses with expired', ['🔴 <b>Liveira Access</b>', 'expired'])
check('licenses: active listed before expired', scr['body']['text'].index('🟢') < scr['body']['text'].index('🔴'))
ev, _, scr = nav(B, 'downloads', 'downloads list', ['Tap a product'], ['dl:liveira_access'])
ev, ans = B.cb('dl:liveira_access')
check('download: toast + sendDocument', len(ans) == 1 and 'Sending file' in ans[0]['body'].get('text', '') and tg(ev, 'sendDocument'))
ev, _, scr = nav(B, 'profile', 'profile with history', ['OxaPay top-up', '+$7.50', 'Liveira Access · 7 days · $10.00'])
ev, _, scr = nav(B, 'home', 'home after purchase', ['Active licenses: <b>1</b>'], must_home=False)

# ───── typing & commands
ev = A.msg('15'); s = last_screen(ev)
check('typed "15" → confirm top-up $15 (new message)', s and s['tg'] == 'sendMessage' and 'Amount: <b>$15.00</b>' in s['body']['text'])
ev = A.msg('0.2'); s = last_screen(ev)
check('typed "0.2" → keypad with minimum warning', s and 'Minimum is $1.00' in s['body']['text'])
ev = A.msg('hello'); s = last_screen(ev)
check('typed text → home card', s and 'Hi, <b>Tester</b>' in s['body']['text'])
for cmd, want in [('/topup', 'Top up balance'), ('/topup 20', 'Amount: <b>$20.00</b>'), ('/start topup', 'Top up balance'), ('/start topup_25', 'Amount: <b>$25.00</b>'),
                  ('/start shop', '🛒 <b>Shop</b>'), ('/start licenses', 'My licenses'), ('/menu', 'Hi, <b>Tester</b>'), ('/shop', '🛒 <b>Shop</b>'), ('/profile', 'Profile'),
                  ('/support', 'Support'), ('/licenses', 'My licenses'), ('/whoami', 'Your Telegram ID: <code>555001</code>')]:
    s = last_screen(A.msg(cmd)); check(f'command {cmd}', s and want in s['body']['text'], s and s['body']['text'][:200])

# ───── admin commands unchanged
ADM = User(1, 'Owner', 'owner')
s = last_screen(ADM.msg('/addbal @tester 5')); check('/addbal (admin) unchanged text', s and s['body']['text'].startswith('Added $5.00 to @tester.\nNew balance: $'), s and s['body']['text'])
s = last_screen(ADM.msg('/bal @tester')); check('/bal (admin) unchanged', s and '@tester (<code>555001</code>)\nBalance: $' in s['body']['text'], s and s['body']['text'])
s = last_screen(ADM.msg('/subbal @tester 5')); check('/subbal (admin)', s and s['body']['text'].startswith('Removed $5.00 from @tester.'))
s = last_screen(ADM.msg('/setbal')); check('/setbal usage', s and s['body']['text'].startswith('Usage: /setbal'))
ev = A.msg('/addbal @tester 100'); check('/addbal by non-admin → silent', not tg(ev, 'sendMessage'))

# ───── maintenance
sql("UPDATE settings SET value='1' WHERE key='maintenance_mode'")
ev, ans = A.cb('shop'); check('maintenance: callback → alert toast, no edit', len(ans) == 1 and ans[0]['body'].get('show_alert') and 'maintenance' in ans[0]['body']['text'].lower() and not tg(ev, 'editMessageText'), ans)
s = last_screen(A.msg('/start')); check('maintenance: /start → 🛠 nice message', s and '🛠 <b>Maintenance</b>' in s['body']['text'])
s = last_screen(ADM.msg('/start')); check('maintenance: admin still gets home', s and 'Hi, <b>Owner</b>' in s['body']['text'])
sql("UPDATE settings SET value='0' WHERE key='maintenance_mode'")

# ───── toggle off
sql("UPDATE settings SET value='0' WHERE key='crypto_topup_enabled'")
ev, _, scr = nav(A, 'topup', 'top-up disabled → unavailable', ['unavailable'])
ev, ans = A.cb('tun:10'); check('disabled → no invoice', not [e for e in ev if e.get('oxapay')])
sql("UPDATE settings SET value='1' WHERE key='crypto_topup_enabled'")

# ───── OxaPay security (unchanged behaviour)
ev, _, _ = nav(A, 'tun:25', 'invoice $25'); inv = [e for e in ev if e.get('oxapay') == 'invoice'][0]; T4, P4 = inv['track_id'], inv['body']['order_id']
paid = {'track_id': T4, 'status': 'Paid', 'type': 'invoice', 'amount': 25, 'order_id': P4}
b2 = A.bal()
s_, body, _ = callback(paid, key=b'wrong'); check('invalid HMAC → 401', s_ == 401)
s_, body, _ = callback(paid, sig=''); check('missing HMAC → 401', s_ == 401)
raw = json.dumps(paid).encode(); s_, _, _ = req('POST', '/oxapay/callback', raw=json.dumps({**paid, 'amount': 999}).encode(), headers={'HMAC': sign(raw)}); check('tampered body → 401', s_ == 401)
check('no credit after bad signatures', A.bal() == b2)
with cf.ThreadPoolExecutor(12) as ex: res = list(ex.map(lambda _: callback(paid), range(12)))
time.sleep(0.5)
check('12 concurrent Paid → all 200, credited exactly once', all(r[0] == 200 for r in res) and abs(A.bal() - (b2 + 25)) < 1e-9, (A.bal(), [r[0] for r in res]))
check('one topups row for concurrent callbacks', len(sql(f"SELECT id FROM topups WHERE ref='{P4}'")) == 1)
b3 = A.bal()
s_, body, _ = callback({**paid, 'track_id': '424242', 'order_id': 'lv_x'}); check('unknown track_id → ok, ignored', s_ == 200 and A.bal() == b3)
ev, _, _ = nav(A, 'tun:10', 'invoice $10'); inv = [e for e in ev if e.get('oxapay') == 'invoice'][0]; T5, P5 = inv['track_id'], inv['body']['order_id']
callback({'track_id': T5, 'status': 'Paid', 'type': 'invoice', 'amount': 10, 'order_id': 'lv_other'}); check('order_id mismatch → ignored', A.bal() == b3)
callback({'track_id': T5, 'status': 'Paid', 'type': 'invoice', 'amount': 5000, 'order_id': P5}); time.sleep(0.3)
check('credits invoiced $10, not claimed $5000', abs(A.bal() - (b3 + 10)) < 1e-9, A.bal())
ev, _, _ = nav(A, 'tun:50', 'invoice $50'); inv = [e for e in ev if e.get('oxapay') == 'invoice'][0]; T6, P6 = inv['track_id'], inv['body']['order_id']
m = mark(); callback({'track_id': T6, 'status': 'Underpaid', 'type': 'invoice', 'amount': 50, 'order_id': P6}); time.sleep(0.5); ev = since(m)
check('Underpaid → marked, card edited to underpaid, user told', sql(f"SELECT status FROM payments WHERE id='{P6}'")[0]['status'] == 'underpaid' and any('Underpaid' in e['body']['text'] for e in tg(ev, 'editMessageText')) and tg(ev, 'sendMessage'))
callback({'track_id': T6, 'status': 'Expired', 'type': 'invoice', 'amount': 50, 'order_id': P6})
check('Expired → marked expired', sql(f"SELECT status FROM payments WHERE id='{P6}'")[0]['status'] == 'expired')
raw = b'not json'; s_, _, _ = req('POST', '/oxapay/callback', raw=raw, headers={'HMAC': sign(raw)}); check('valid sig + bad JSON → 400', s_ == 400)
s_, _, _ = req('GET', '/oxapay/callback'); check('GET callback → 405', s_ == 405)

# ───── token API (machine binding) unchanged
sql("INSERT OR IGNORE INTO tokens (token,product_id,product_name,telegram_user_id,duration_days,created_at,expires_at,status) VALUES ('tokA','liveira_access','Liveira Access',1,3,'2026-01-01T00:00:00Z','2099-01-01T00:00:00Z','active')")
sql("DELETE FROM token_machines WHERE token='tokA'")
s_, body, _ = req('POST', '/v1/validate', {'token': 'tokA', 'machine_id': 'a' * 64}, {'X-API-Key': 'tk_local'}); check('validate binds machine', s_ == 200 and json.loads(body)['valid'] is True)
s_, body, _ = req('POST', '/v1/validate', {'token': 'tokA', 'machine_id': 'b' * 64}, {'X-API-Key': 'tk_local'}); check('validate other machine → 403', s_ == 403 and 'machine_mismatch' in body)
s_, body, _ = req('POST', '/v1/validate', {'token': 'tokA'}, {'X-API-Key': 'tk_local'}); check('validate no machine → 400', s_ == 400)
s_, body, _ = req('GET', '/v1/token/tokA', None, {'X-API-Key': 'tk_local'}); check('GET token lookup', s_ == 200 and json.loads(body)['valid'] is True)
s_, body, _ = req('POST', '/v1/validate', {'token': 'tokA'}); check('validate without API key → 401', s_ == 401)

# ───── admin
s_, body, h = req('POST', '/admin/api/login', {'password': 'pw_local'}, {'X-Requested-With': 'liveira-admin'})
AH = {'Cookie': h.get('Set-Cookie').split(';')[0], 'X-Requested-With': 'liveira-admin'}
s_, body, _ = req('GET', '/admin/api/payments?status=canceled', None, AH); check('admin payments filter canceled', s_ == 200, body[:200])
s_, body, _ = req('GET', '/admin/api/payments', None, AH); check('admin payments list', s_ == 200 and json.loads(body)['total'] >= 6)
m = mark(); s_, body, _ = req('POST', '/admin/api/bot/setup', None, AH); ev = since(m); d = json.loads(body)
check('admin bot setup → ok', s_ == 200 and d['ok'] is True, body)
cmds = tg(ev, 'setMyCommands')
check('setMyCommands default + admin chat scope', any(c['body']['scope']['type'] == 'default' for c in cmds) and any(c['body']['scope'] == {'type': 'chat', 'chat_id': 1} for c in cmds) and
      [c['command'] for c in cmds[0]['body']['commands']] == ['start', 'shop', 'topup', 'licenses', 'downloads', 'profile', 'support'])
check('setChatMenuButton commands + descriptions', tg(ev, 'setChatMenuButton')[0]['body']['menu_button'] == {'type': 'commands'} and tg(ev, 'setMyDescription') and tg(ev, 'setMyShortDescription'))
desc = tg(ev, 'setMyDescription')[0]['body']['description']; short = tg(ev, 'setMyShortDescription')[0]['body']['short_description']
check('bot description/short description say USDT, no other coins', 'with USDT' in desc and 'Pay with USDT' in short and not re.search(r'BTC|ETH|TON|crypto', desc + short, re.I), (desc, short))
s_, body, _ = req('GET', '/admin', None); check('admin page loads', s_ == 200 and 'app.js' in body)
s_, body, _ = req('GET', '/admin/app.js', None); check('admin app.js: accepted-coins field + OxaPay check', 'Moedas aceitas' in body and '/oxapay/accepted' in body and 'cripto' not in body.lower())

# ───── accepted currencies setting (default USDT, admin-editable, texts adapt)
s_, body, _ = req('GET', '/admin/api/settings', None, AH); check('settings: accepted_currencies default USDT', s_ == 200 and json.loads(body)['settings']['accepted_currencies'] == 'USDT', body[:300])
s_, body, _ = req('GET', '/admin/api/oxapay/accepted', None, AH); d = json.loads(body)
check('admin OxaPay check: live list USDT, matches setting, networks listed', s_ == 200 and d['ok'] and d['oxapay'] == ['USDT'] and d['match'] is True and 'TRC20 (Tron Network)' in d['networks']['USDT'], body)
for bad in ['US$', '', ',,']:
    s_, body, _ = req('PUT', '/admin/api/settings', {'accepted_currencies': bad}, AH); check(f'accepted_currencies invalid {bad!r} → 400', s_ == 400, (s_, body))
s_, body, _ = req('PUT', '/admin/api/settings', {'accepted_currencies': ' usdt, btc usdt '}, AH)
check('accepted_currencies "usdt, btc usdt" → normalized USDT,BTC', s_ == 200 and sql("SELECT value FROM settings WHERE key='accepted_currencies'")[0]['value'] == 'USDT,BTC', body)
ev, _, scr = nav(A, 'topup', 'top-up with USDT,BTC setting', ['We accept: <b>USDT</b> or <b>BTC</b>', 'pay with <b>USDT</b> or <b>BTC</b>'])
s = last_screen(A.msg('/start')); check('home welcome adapts: "Top up with USDT or BTC"', s and 'Top up with USDT or BTC —' in s['body']['text'], s and s['body']['text'])
s_, body, _ = req('GET', '/admin/api/oxapay/accepted', None, AH); check('admin OxaPay check flags mismatch (setting USDT,BTC vs OxaPay USDT)', json.loads(body)['match'] is False, body)
m = mark(); req('POST', '/admin/api/bot/setup', None, AH); ev = since(m)
check('bot description adapts to "USDT or BTC"', 'with USDT or BTC' in tg(ev, 'setMyDescription')[0]['body']['description'])
sql("INSERT OR REPLACE INTO settings (key,value) VALUES ('welcome_text','Custom hello from the admin')")
s = last_screen(A.msg('/start')); check('admin-edited welcome text still shown as-is', s and '<blockquote>Custom hello from the admin</blockquote>' in s['body']['text'])
sql("DELETE FROM settings WHERE key='welcome_text'")
s_, body, _ = req('PUT', '/admin/api/settings', {'accepted_currencies': 'USDT'}, AH); check('accepted_currencies back to USDT', s_ == 200 and json.loads(body)['changed'] == ['accepted_currencies'])
ev, _, scr = nav(A, 'topup', 'top-up back to USDT only', ['We accept: <b>USDT</b>\n'])
check('no BTC after reset', 'BTC' not in scr['body']['text'])

# ───── global: Bot API validation
viol = [e for e in logs() if 'violation' in e]
check('no Bot API spec violations in any request (tags, callback_data ≤64, one action/button, styles, lengths, no deprecated params)', not viol, viol[:3])
print('\nSUMMARY', sum(1 for _, ok in RESULTS if ok), '/', len(RESULTS))
