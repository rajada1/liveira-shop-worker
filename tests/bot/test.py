"""Local integration tests: bot UX + OxaPay security + Binance Pay + token API + admin. Run against wrangler dev on :8799
(and :8798 = same Worker without the Binance secrets)."""
import json, hmac, hashlib, subprocess, time, urllib.request, urllib.error, concurrent.futures as cf, itertools, re
BASE = 'http://127.0.0.1:8799'; KEY = b'local_test_merchant_key'; FAKE = 'http://127.0.0.1:9911'
RESULTS = []; qid = itertools.count(1)
def check(name, cond, info=''):
    RESULTS.append((name, bool(cond))); print(('PASS' if cond else 'FAIL'), name, '' if cond else str(info)[:600])
def req(method, path, body=None, headers=None, raw=None, base=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    r = urllib.request.Request((base or BASE) + path, data=data, method=method, headers={'Content-Type': 'application/json', **(headers or {})})
    try:
        with urllib.request.urlopen(r) as resp: return resp.status, resp.read().decode(), resp.headers
    except urllib.error.HTTPError as e: return e.code, e.read().decode(), e.headers
def sql(q, state='/tmp/lvtest/state'):
    out = subprocess.run(['npx', 'wrangler', 'd1', 'execute', 'liveira-shop', '--local', '--persist-to', state, '--json', '--command', q],
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
    base = None
    def upd(self, obj): return req('POST', '/telegram', obj, {'X-Telegram-Bot-Api-Secret-Token': 'whs_local'}, base=self.base)
    def msg(self, text, extra=None):
        # Incoming messages take the next id of the chat's shared sequence, like the real API.
        mid = json.loads(urllib.request.urlopen(urllib.request.Request(FAKE + f'/_nextid/{self.uid}', data=b'', method='POST')).read())['mid']
        self.last_in = mid
        body = {'message_id': mid, 'from': self.frm(), 'chat': {'id': self.uid, 'type': 'private'}, 'date': int(time.time())}
        body.update({'text': text} if extra is None else extra)
        m = mark(); self.upd({'update_id': 1, 'message': body}); ev = since(m)
        menus = [e for e in tg(ev, 'sendMessage') if 'inline_keyboard' in (e['body'].get('reply_markup') or {}) and str(e['body']['chat_id']) == str(self.uid)]
        if menus: self.mid = menus[-1]['mid']  # the newest navigation screen is at the bottom
        return ev
    def cb(self, data, mid=None):
        q = str(next(qid)); m = mark()
        self.upd({'update_id': 2, 'callback_query': {'id': q, 'from': self.frm(), 'data': data, 'chat_instance': 'x',
                  'message': {'message_id': mid or self.mid, 'chat': {'id': self.uid, 'type': 'private'}, 'date': int(time.time())}}})
        ev = since(m)
        answers = [e for e in tg(ev, 'answerCallbackQuery') if e['body']['callback_query_id'] == q]
        return ev, answers
    def bal(self):
        r = sql(f'SELECT balance FROM users WHERE user_id={self.uid}'); return r[0]['balance'] if r else None

def nav(u, data, name, expect_text=None, expect_cb=(), must_home=True, move=False):
    """move=False: the tapped message is the latest menu → edited in place.
    move=True: tapped message is older / a record → screen sent fresh at the bottom (tapped message not edited)."""
    ev, ans = u.cb(data)
    scr = last_screen(ev)
    if move:
        ok = len(ans) == 1 and scr is not None and scr['tg'] == 'sendMessage' and not [e for e in tg(ev, 'editMessageText') if e['body']['message_id'] == u.mid]
    else:
        ok = len(ans) == 1 and scr is not None and scr['tg'] == 'editMessageText' and scr['body']['message_id'] == u.mid and not tg(ev, 'sendMessage')
    if expect_text: ok = ok and all(t in scr['body']['text'] for t in ([expect_text] if isinstance(expect_text, str) else expect_text))
    cbs = cbdata(scr)
    ok = ok and all(c in cbs for c in expect_cb)
    if must_home: ok = ok and 'home' in cbs
    check(f'nav {name}: ' + ('sent fresh at the bottom' if move else 'edits same message') + ', answered once' + (', has 🏠 Home' if must_home else ''), ok, (ans, scr and scr['body'].get('text'), cbs, [e.get('tg') for e in ev]))
    if move and scr and scr['tg'] == 'sendMessage': u.mid = scr['mid']
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
ev, _, scr = nav(A, 'tuc:5', 'preset $5 tapped on the invoice card (a record) → confirm top-up', ['Amount: <b>$5.00</b>'], ['tun:5'], move=True)
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
ev, _, scr = nav(B, 'days:liveira_access:7', 'continue purchase (tapped on paid card) → confirm', ['Confirm purchase', 'after purchase <b>$0.00</b>'], ['confirm:liveira_access:7'], move=True)
ev, ans, scr = nav(B, 'confirm:liveira_access:7', 'buy → success screen', ['✅ <b>Purchase successful!</b>', 'Expires: <b>', ' BRT</b>', '<code>'], ['dl:liveira_access', 'licenses'])
key = re.search(r'<code>([^<]+)</code>', scr['body']['text']).group(1)
check('success: 📋 copy_text button with the key', any(b.get('copy_text', {}).get('text') == key for b in buttons(scr)))
check('balance 0 after purchase', abs(B.bal()) < 1e-9)
ev, ans = B.cb('confirm:liveira_access:7'); scr = last_screen(ev)
check('second confirm with no balance → shortfall, not negative', 'Not enough balance' in scr['body']['text'] and abs(B.bal()) < 1e-9)
ev, _, scr = nav(B, 'licenses', 'licenses list (tapped on purchase receipt)', ['🟢 <b>Liveira Access</b>', '7 days left', f'<code>{key}</code>'], move=True)
check('licenses: copy button for active key', any(b.get('copy_text', {}).get('text') == key for b in buttons(scr)))
sql(f"INSERT INTO tokens (token,product_id,product_name,telegram_user_id,duration_days,created_at,expires_at,status) VALUES ('oldkey1','liveira_access','Liveira Access',{B.uid},3,'2026-01-01T00:00:00Z','2026-01-04T00:00:00Z','active')")
ev, _, scr = nav(B, 'licenses', 'licenses with expired', ['🔴 <b>Liveira Access</b>', 'expired'])
check('licenses: active listed before expired', scr['body']['text'].index('🟢') < scr['body']['text'].index('🔴'))
ev, _, scr = nav(B, 'downloads', 'downloads list', ['Tap a product'], ['dl:liveira_access'])
ev, ans = B.cb('dl:liveira_access')
check('download: toast + sendDocument', len(ans) == 1 and 'Sending file' in ans[0]['body'].get('text', '') and tg(ev, 'sendDocument'))
ev, _, scr = nav(B, 'profile', 'profile with history (menu no longer latest after the file)', ['OxaPay top-up', '+$7.50', 'Liveira Access · 7 days · $10.00'], move=True)
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
ev, _, scr = nav(A, 'topup', 'top-up disabled → unavailable (menu not latest)', ['unavailable'], move=True)
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
ev, _, _ = nav(A, 'tun:10', 'invoice $10 (tapped on previous card)', move=True); inv = [e for e in ev if e.get('oxapay') == 'invoice'][0]; T5, P5 = inv['track_id'], inv['body']['order_id']
callback({'track_id': T5, 'status': 'Paid', 'type': 'invoice', 'amount': 10, 'order_id': 'lv_other'}); check('order_id mismatch → ignored', A.bal() == b3)
callback({'track_id': T5, 'status': 'Paid', 'type': 'invoice', 'amount': 5000, 'order_id': P5}); time.sleep(0.3)
check('credits invoiced $10, not claimed $5000', abs(A.bal() - (b3 + 10)) < 1e-9, A.bal())
ev, _, _ = nav(A, 'tun:50', 'invoice $50 (tapped on previous card)', move=True); inv = [e for e in ev if e.get('oxapay') == 'invoice'][0]; T6, P6 = inv['track_id'], inv['body']['order_id']
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
      [c['command'] for c in cmds[0]['body']['commands']] == ['start', 'menu', 'shop', 'topup', 'licenses', 'downloads', 'profile', 'support'])
check('/menu in the command list with a short description', [c for c in cmds[0]['body']['commands'] if c['command'] == 'menu' and 0 < len(c['description']) <= 256])
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
ev, _, scr = nav(A, 'topup', 'top-up with USDT,BTC setting (tapped on card)', ['We accept: <b>USDT</b> or <b>BTC</b>', 'pay with <b>USDT</b> or <b>BTC</b>'], move=True)
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

# ───── persistent reply keyboard + "active screen follows the user"
def kbmsgs(ev): return [e for e in tg(ev, 'sendMessage') if 'keyboard' in (e['body'].get('reply_markup') or {})]
def navrow(u): return sql(f"SELECT * FROM chat_nav WHERE chat_id={u.uid}")[0]
def deleted(ev, mid): return [e for e in tg(ev, 'deleteMessage') if e['body']['message_id'] == mid]
C = User(555003, 'Carla', 'carla')
ev = C.msg('/start'); sends = tg(ev, 'sendMessage'); k = kbmsgs(ev)
rm = k[0]['body']['reply_markup'] if k else {}
check('/start: persistent reply keyboard sent (is_persistent, resize_keyboard, placeholder ≤64)',
      len(k) == 1 and rm.get('is_persistent') is True and rm.get('resize_keyboard') is True and 1 <= len(rm.get('input_field_placeholder', '')) <= 64 and 'one_time_keyboard' not in rm, rm)
check('reply keyboard: 6 sections with emoji, 2 columns', [[b['text'] for b in r] for r in rm.get('keyboard', [])] == [['🛒 Shop', '💰 Top up'], ['🔑 My licenses', '📥 Downloads'], ['👤 Profile', '💬 Support']], rm)
check('/start: keyboard message first, home card (inline) last at the bottom', k and sends[-1]['body']['text'].startswith('👋 Hi, <b>Carla</b>') and sends.index(k[0]) == 0 and 'inline_keyboard' in sends[-1]['body']['reply_markup'], [x['body']['text'][:30] for x in sends])
KB1, H1 = k[0]['mid'], sends[-1]['mid']
r = navrow(C); check('chat_nav stores menu, keyboard message, version, last id', r['menu_msg_id'] == H1 and r['kb_msg_id'] == KB1 and r['kb_version'] == 1 and r['last_msg_id'] == H1, r)
nav(C, 'shop', 'latest message tapped → edited in place', ['🛒 <b>Shop</b>'])
ev, ans = C.cb('shop'); check('latest tap, same screen → "not modified" tolerated, no new message', len(ans) == 1 and not tg(ev, 'sendMessage') and not tg(ev, 'deleteMessage'))
for label, want in [('🛒 Shop', '🛒 <b>Shop</b>'), ('💰 Top up', '💰 <b>Top up balance</b>'), ('🔑 My licenses', 'No licenses yet'), ('📥 Downloads', 'No downloads yet'), ('👤 Profile', '👤 <b>Profile</b>'), ('💬 Support', '💬 <b>Support</b>'), ('shop', '🛒 <b>Shop</b>')]:
    old = C.mid; ev = C.msg(label); scr = last_screen(ev)
    check(f'keyboard text {label!r} → its screen sent at the bottom, old menu deleted, no edit',
          scr and scr['tg'] == 'sendMessage' and want in scr['body']['text'] and deleted(ev, old) and not tg(ev, 'editMessageText') and not kbmsgs(ev)
          and navrow(C)['menu_msg_id'] == scr['mid'], (scr and scr['body']['text'][:60], [(e.get('tg'), e['body'].get('message_id')) for e in ev]))
def deleted_ok(ev, mid): return [e for e in deleted(ev, mid) if not e.get('error')]
old = C.mid; ev = C.msg('👤 Profile'); press = C.last_in
check('keyboard button press ("👤 Profile") deleted after its screen is sent (user message removed)',
      deleted_ok(ev, press) and ev.index(deleted(ev, press)[0]) > ev.index(last_screen(ev)), [(e.get('tg'), e['body'].get('message_id')) for e in ev])
# next incoming id = press + 2 (the screen took press + 1): make its deletion fail like a >48h-old message
urllib.request.urlopen(urllib.request.Request(FAKE + f'/_faildelete/{C.uid}/{press + 2}', data=b'', method='POST'))
ev = C.msg('🛒 Shop'); check('button press delete failure (e.g. >48h) ignored: screen still sent', C.last_in == press + 2 and last_screen(ev) and '🛒 <b>Shop</b>' in last_screen(ev)['body']['text'] and [e for e in deleted(ev, C.last_in) if e.get('error')], [(e.get('tg'), e.get('error')) for e in ev])
ev = C.msg('/whoami'); check('commands are not deleted (only reply-keyboard presses)', not deleted(ev, C.last_in))
M = C.mid; C.msg('/whoami')
ev, ans = C.cb('profile', M); scr = last_screen(ev)
check('tap on a menu that is no longer the latest (bot/user messages after it) → deleteMessage(old) + new at the bottom',
      len(ans) == 1 and scr['tg'] == 'sendMessage' and deleted(ev, M) and not tg(ev, 'editMessageText') and navrow(C)['menu_msg_id'] == scr['mid'], [e.get('tg') for e in ev])
C.mid = scr['mid']; M = C.mid
C.msg(None, {'sticker': {'file_id': 'STK', 'file_unique_id': 'u', 'type': 'regular', 'width': 512, 'height': 512, 'is_animated': False, 'is_video': False}})
ev, ans = C.cb('shop', M); scr = last_screen(ev)
check('any incoming user message (sticker) makes the menu "not latest" → moved', len(ans) == 1 and scr['tg'] == 'sendMessage' and deleted(ev, M), [e.get('tg') for e in ev])
C.mid = scr['mid']; M = C.mid
urllib.request.urlopen(urllib.request.Request(FAKE + f'/_faildelete/{C.uid}/{M}', data=b'', method='POST'))
C.msg('/whoami'); ev, ans = C.cb('support', M); scr = last_screen(ev)
check('deleteMessage failure (e.g. >48h) tolerated: new screen still sent, answered once, state updated',
      len(ans) == 1 and 'text' not in ans[0]['body'] and [e for e in deleted(ev, M) if e.get('error')] and scr['tg'] == 'sendMessage' and '💬 <b>Support</b>' in scr['body']['text'] and navrow(C)['menu_msg_id'] == scr['mid'], (ans, [e.get('tg') for e in ev]))
C.mid = scr['mid']
ev = C.msg('💰 Top up'); check('keyboard text after a failed delete still works', last_screen(ev) and 'Top up balance' in last_screen(ev)['body']['text'])
# keypad + custom amount are not confused with keyboard texts
nav(C, 'kp:', 'keypad from the keyboard-opened top-up', ['✏️ <b>Other amount</b>'])
nav(C, 'kp:2', 'keypad digit 2', ['$ 2'])
ev, _, scr = nav(C, 'kp:25', 'keypad digits 25 (live edit in place)', ['$ 25'], ['kpok:25'])
nav(C, 'kpok:25', 'keypad ✅ → confirm $25', ['Amount: <b>$25.00</b>'], ['tun:25'])
old = C.mid; ev = C.msg('30'); scr = last_screen(ev)
check('typed amount "30" on the keypad flow → confirm $30 at the bottom, old screen deleted', scr and 'Amount: <b>$30.00</b>' in scr['body']['text'] and deleted(ev, old))
check('typed amount message is kept (not a keyboard press)', not deleted(ev, C.last_in))
ev = C.msg('💰 Top up'); scr = last_screen(ev)
check('"💰 Top up" keyboard text opens the top-up menu (not parsed as an amount)', scr and '💰 <b>Top up balance</b>' in scr['body']['text'] and 'Confirm top-up' not in scr['body']['text'])
ev = C.msg('/topup 12'); check('/topup 12 still works', last_screen(ev) and 'Amount: <b>$12.00</b>' in last_screen(ev)['body']['text'])
ev = C.msg('/start topup_7'); check('deep link /start topup_7 → keyboard + confirm $7 at the bottom', kbmsgs(ev) and 'Amount: <b>$7.00</b>' in last_screen(ev)['body']['text'])
# records are kept: invoice card and purchase receipt never deleted
ev, _, scr = nav(C, 'tun:7', 'invoice from deep-link confirm (edited into the card)', ['🧾 <b>Top-up invoice · $7.00</b>'])
CARD = C.mid; check('invoice card is a record (menu cleared)', sql(f"SELECT (menu_msg_id IS NULL) AS n FROM chat_nav WHERE chat_id={C.uid}")[0]['n'] == 1, navrow(C))
ev = C.msg('🛒 Shop'); check('keyboard after invoice card: new screen, invoice card NOT deleted', last_screen(ev)['tg'] == 'sendMessage' and not deleted(ev, CARD))
ev, ans = C.cb('home', CARD); check('"Home" on the invoice card → home sent at the bottom, card kept (not edited/deleted)', len(ans) == 1 and last_screen(ev)['tg'] == 'sendMessage' and not deleted(ev, CARD) and not [e for e in tg(ev, 'editMessageText') if e['body']['message_id'] == CARD])
C.mid = last_screen(ev)['mid']
ev, ans = C.cb(f'tuchk:{[x for x in sql(f"SELECT id FROM payments WHERE telegram_user_id={C.uid} ORDER BY created_at DESC LIMIT 1")][0]["id"]}', CARD)
check('"Check status" on the card updates the card itself (record action in place)', len(ans) == 1 and not tg(ev, 'sendMessage') and not tg(ev, 'deleteMessage'))
sql(f"UPDATE users SET balance=20 WHERE user_id={C.uid}")
nav(C, 'days:liveira_access:3', 'confirm purchase', ['Confirm purchase'])
ev, _, scr = nav(C, 'confirm:liveira_access:3', 'purchase success (receipt)', ['✅ <b>Purchase successful!</b>'])
RCPT = C.mid; check('purchase receipt is a record (menu cleared)', sql(f"SELECT (menu_msg_id IS NULL) AS n FROM chat_nav WHERE chat_id={C.uid}")[0]['n'] == 1, navrow(C))
ev = C.msg('👤 Profile'); check('keyboard after purchase: receipt NOT deleted', last_screen(ev)['tg'] == 'sendMessage' and not deleted(ev, RCPT))
ev, ans = C.cb('licenses', RCPT); check('"My licenses" on the receipt → list at the bottom, receipt kept, previous menu deleted', len(ans) == 1 and last_screen(ev)['tg'] == 'sendMessage' and not deleted(ev, RCPT) and deleted(ev, C.mid))
C.mid = last_screen(ev)['mid']
# keyboard re-attach
sql(f"UPDATE chat_nav SET kb_msg_id=NULL WHERE chat_id={C.uid}")
ev = C.msg('🔑 My licenses'); check('keyboard missing in state → re-attached on the next message', len(kbmsgs(ev)) == 1 and 'My licenses' in last_screen(ev)['body']['text'])
KB2 = kbmsgs(ev)[0]['mid']
sql(f"UPDATE chat_nav SET kb_version=0 WHERE chat_id={C.uid}")
ev = C.msg('/shop'); check('older keyboard version → new keyboard sent, previous keyboard message deleted', len(kbmsgs(ev)) == 1 and deleted(ev, KB2))
ev = C.msg('/shop'); check('up-to-date keyboard → not re-sent on /shop', not kbmsgs(ev))
KB3 = navrow(C)['kb_msg_id']
ev = C.msg('hi there'); check('unrecognised text → keyboard re-attached + home at the bottom, old keyboard message deleted', len(kbmsgs(ev)) == 1 and deleted(ev, KB3) and last_screen(ev)['body']['text'].startswith('👋 Hi, <b>Carla</b>'))
ev = C.msg('/menu'); check('/menu sends the keyboard and the home card', len(kbmsgs(ev)) == 1 and last_screen(ev)['body']['text'].startswith('👋 Hi'))
# rapid double taps on an older menu: both requests overlap (slow sendMessage) → exactly one menu survives
M = C.mid; C.msg('/whoami')
def menu_survivors(ev):
    sent = [e['mid'] for e in tg(ev, 'sendMessage') if 'inline_keyboard' in (e['body'].get('reply_markup') or {}) and e['body']['chat_id'] == C.uid]
    gone = {e['body']['message_id'] for e in tg(ev, 'deleteMessage') if not e.get('error')}
    return sent, [x for x in sent if x not in gone], gone
def tap(data, qid_):
    return C.upd({'update_id': 3, 'callback_query': {'id': qid_, 'from': C.frm(), 'data': data, 'chat_instance': 'x',
                  'message': {'message_id': M, 'chat': {'id': C.uid, 'type': 'private'}, 'date': int(time.time())}}})
urllib.request.urlopen(urllib.request.Request(FAKE + f'/_slowsend/{C.uid}/1500', data=b'', method='POST'))
m = mark()
with cf.ThreadPoolExecutor(2) as ex: list(ex.map(lambda a: tap(*a), [('shop', str(next(qid))), ('profile', str(next(qid)))]))
ev = since(m); urllib.request.urlopen(urllib.request.Request(FAKE + f'/_slowsend/{C.uid}/0', data=b'', method='POST'))
sent, alive, gone = menu_survivors(ev)
check('rapid double tap on an older menu → two screens sent concurrently, only one menu left (duplicate deleted), state points to it',
      len(sent) == 2 and len(alive) == 1 and M in gone and navrow(C)['menu_msg_id'] == alive[0], (sent, alive, gone, navrow(C)))
C.mid = alive[0] if alive else C.mid
ev = C.msg('🔑 My licenses'); check('after the double tap: next keyboard press deletes the surviving menu (no orphan left)', deleted_ok(ev, alive[0] if alive else -1))
# maintenance + admin unchanged
sql("UPDATE settings SET value='1' WHERE key='maintenance_mode'")
ev = C.msg('🛒 Shop'); check('maintenance: keyboard text → 🛠 message, no screen', last_screen(ev) and '🛠 <b>Maintenance</b>' in last_screen(ev)['body']['text'] and not deleted(ev, C.mid))
sql("UPDATE settings SET value='0' WHERE key='maintenance_mode'")
s2 = last_screen(ADM.msg('/bal @carla')); check('/bal (admin) unchanged with keyboard feature', s2 and '@carla (<code>555003</code>)\nBalance: $' in s2['body']['text'] and 'keyboard' not in (s2['body'].get('reply_markup') or {}))
# graceful fallback while migration 0006 is not applied
sql("ALTER TABLE chat_nav RENAME TO chat_nav_off")
ev = C.msg('/start'); check('without chat_nav table: /start still sends keyboard + home', kbmsgs(ev) and last_screen(ev)['body']['text'].startswith('👋 Hi'))
nav(C, 'shop', 'without chat_nav table: edit in place (previous behaviour)', ['🛒 <b>Shop</b>'])
ev = C.msg('📥 Downloads'); check('without chat_nav table: keyboard text still opens its screen', last_screen(ev) and 'Downloads' in last_screen(ev)['body']['text'])
sql("ALTER TABLE chat_nav_off RENAME TO chat_nav")
C.msg('🛒 Shop'); M = C.mid
check('menu at the bottom before the broadcast', navrow(C)['menu_msg_id'] == M and navrow(C)['last_msg_id'] == M, navrow(C))
m = mark(); s_, body, _ = req('POST', '/admin/api/broadcast', {'text': 'Local test broadcast'}, AH); ev = since(m)
bc = [e for e in tg(ev, 'sendMessage') if e['body']['chat_id'] == C.uid]
check('admin broadcast still works; last_msg_id updated with one batched write', s_ == 200 and json.loads(body)['sent'] >= 3 and bc and navrow(C)['last_msg_id'] == bc[-1]['mid'], (s_, body[:200], navrow(C)))
ev, ans = C.cb('profile', M); scr = last_screen(ev)
check('tap on the menu after a broadcast → moved below the broadcast (old menu deleted, not edited)',
      len(ans) == 1 and scr['tg'] == 'sendMessage' and deleted(ev, M) and not tg(ev, 'editMessageText'), [e.get('tg') for e in ev])
C.mid = scr['mid']
# ───── Binance Pay top-ups (fake Binance on :9911, cache TTL 1 s)
from datetime import datetime
def fpost(path, body=None):
    return urllib.request.urlopen(urllib.request.Request(FAKE + path, data=json.dumps(body).encode() if body is not None else b'', method='POST')).read()
def now_ms(): return int(time.time() * 1000)
def bn_tx(txid, amount='12.5', currency='USDT', otype='C2C', pay_id='290455535', payer=70001, ago_s=30):
    return {'orderType': otype, 'transactionId': txid, 'transactionTime': now_ms() - ago_s * 1000, 'amount': amount, 'currency': currency,
            'walletType': 1, 'walletTypes': [1], 'fundsDetail': [{'currency': currency, 'amount': amount.lstrip('-')}],
            'payerInfo': {'name': 'Payer', 'type': 'USER', 'binanceId': payer, 'accountId': payer + 1},
            'receiverInfo': {'name': 'Liveira', 'type': 'USER', 'binanceId': 39990001, 'accountId': int(pay_id)}}
def bn_calls(ev): return [x for x in ev if x.get('binance') == 'GET']
def cron(base=BASE):
    m = mark(); urllib.request.urlopen(base + '/__scheduled?cron=*+*+*+*+*').read(); time.sleep(0.5); return since(m)
def bn_card(ev):
    x = [e for e in ev if e.get('tg') in ('sendMessage', 'editMessageText') and not e.get('error') and 'Transaction ID: <code>' in (e['body'].get('text') or '')]
    return x[-1] if x else None
def ctext(c): return c['body']['text'] if c else ''
PROMPT = '🟡 Paste your Binance Pay transaction ID below:'
def ask_prompt(u):
    ev, ans = u.cb('bnp'); pr = [e for e in tg(ev, 'sendMessage') if (e['body'].get('reply_markup') or {}).get('force_reply')]
    u.prompt_mid = pr[0]['mid'] if pr else 0
    return ev, ans, pr
def prompt_reply(u, text):
    return u.msg(None, {'text': text, 'reply_to_message': {'message_id': u.prompt_mid, 'from': {'id': 1, 'is_bot': True, 'first_name': 'Liveira'},
                                                         'chat': {'id': u.uid, 'type': 'private'}, 'date': int(time.time()), 'text': PROMPT}})
def claim(txid): r = sql(f"SELECT * FROM payments WHERE track_id='binance:{txid}'"); return r[0] if r else None
def admin_msgs(ev): return [e for e in tg(ev, 'sendMessage') if e['body']['chat_id'] == 1]
def iso_ms(s): return int(datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000)
TX = {k: '3812345678901230%02d' % i for i, k in enumerate(['ok', 'late', 'btc', 'out', 'big', 'race', 'err', 'foreign', 'box'], 1)}

fpost('/_bn/tx', bn_tx(TX['ok'], '12.5'))
D = User(555020, 'Diego', 'diego')
ev = D.msg('/start'); D.mid = last_screen(ev)['mid']
ev, _, scr = nav(D, 'topup', 'top-up menu offers 🟡 Binance Pay', ['💰 <b>Top up balance</b>', '<b>Binance Pay</b>'], ['bn', 'kp:', 'tuc:5'])
brow = [r for r in scr['body']['reply_markup']['inline_keyboard'] if any(b.get('callback_data') == 'bn' for b in r)]
check('🟡 Binance Pay button next to ✏️ Other amount (OxaPay)', brow and [b['text'] for b in brow[0]] == ['✏️ Other amount', '🟡 Binance Pay'], brow)
ev, _, scr = nav(D, 'bn', 'Binance Pay screen', ['🟡 <b>Binance Pay</b>', 'Send any amount of <b>USDT</b> via Binance Pay to this Pay ID, then paste the transaction ID here.', 'Pay ID: <code>290455535</code>'], ['bnp', 'topup'])
check('Binance screen: 📋 Copy Pay ID (copy_text 290455535)', any(b.get('copy_text', {}).get('text') == '290455535' for b in buttons(scr)))
ev, ans, pr = ask_prompt(D)
check('✏️ Enter transaction ID → ForceReply prompt (placeholder), answered once', len(ans) == 1 and pr and pr[0]['body']['text'] == PROMPT and pr[0]['body']['reply_markup'].get('input_field_placeholder') == 'Transaction ID', [e.get('tg') for e in ev])
b0 = D.bal(); time.sleep(1.1)
ev = prompt_reply(D, TX['ok']); card = bn_card(ev); calls = bn_calls(ev)
check('reply with a real transaction ID → ✅ credited with the amount received (12.5 USDT → $12.50)',
      '✅ <b>Binance Pay top-up received!</b>' in ctext(card) and '+<b>$12.50</b>' in ctext(card) and '(12.5 USDT)' in ctext(card) and 'New balance: <b>$12.50</b>' in ctext(card), ctext(card))
check('balance +12.50', abs(D.bal() - (b0 + 12.5)) < 1e-9, D.bal())
check('Binance request signed: X-MBX-APIKEY, HMAC-SHA256 hex (64) as last param, timestamp+recvWindow, startTime/endTime/limit=100',
      len(calls) == 1 and all(c['sig_ok'] and c['key_ok'] and c['sig_last'] and c['ts_ok'] and re.fullmatch(r'[0-9a-f]{64}', c['sig'])
                              and {'timestamp', 'recvWindow', 'startTime', 'endTime', 'limit'} <= set(c['params']) and c['params']['limit'] == '100' for c in calls), calls)
check('ForceReply prompt deleted after the reply', [e for e in tg(ev, 'deleteMessage') if e['body']['message_id'] == D.prompt_mid and not e.get('error')])
c = claim(TX['ok'])
check("payments: provider=binance, track_id=binance:<txid>, paid, credited, amount 12.5, payer Binance id stored",
      c and c['provider'] == 'binance' and c['status'] == 'paid' and c['credited'] == 1 and abs(c['amount_usd'] - 12.5) < 1e-9 and json.loads(c['last_payload'])['payer_binance_id'] == '70001', c)
check('payments.message_id = claim card', c and card and c['message_id'] == card['mid'])
tp = sql(f"SELECT * FROM topups WHERE ref='{c['id']}'")
check("topups: one row method='binance' +12.5", len(tp) == 1 and tp[0]['method'] == 'binance' and abs(tp[0]['amount'] - 12.5) < 1e-9, tp)
au = sql("SELECT details_json FROM audit_log WHERE action='binance_credit'")
check('audit_log binance_credit with txid + payer', au and json.loads(au[-1]['details_json'])['txid'] == TX['ok'] and json.loads(au[-1]['details_json'])['payer_binance_id'] == '70001', au)
an = admin_msgs(ev)
check('admin notice (ADMIN_IDS) with user, amount and txid', an and '@diego' in an[-1]['body']['text'] and '+$12.50' in an[-1]['body']['text'] and TX['ok'] in an[-1]['body']['text'], an)
s_ = last_screen(D.msg('/profile')); check('profile lists "Binance Pay top-up"', s_ and 'Binance Pay top-up' in s_['body']['text'] and '+$12.50' in s_['body']['text'], s_ and s_['body']['text'])

time.sleep(1.1)
ev = D.msg(TX['ok']); card = bn_card(ev)
check('same user pastes the same ID again (plain digits) → shows it was credited, no double credit, no Binance request',
      'Binance Pay top-up received' in ctext(card) and abs(D.bal() - (b0 + 12.5)) < 1e-9 and not bn_calls(ev), ctext(card))
E = User(555021, 'Eva', 'eva'); E.msg('/start')
ev = E.msg(f"/binance {TX['ok']}"); s_ = last_screen(ev)
check('another user claims the same ID (/binance <id>) → refused, no credit', s_ and 'already submitted from another account' in s_['body']['text'] and not E.bal(), s_ and s_['body']['text'])
check('transaction credited exactly once overall', len(sql(f"SELECT id FROM topups WHERE method='binance'")) == 1 and sql("SELECT COUNT(*) AS n FROM payments WHERE track_id='binance:%s'" % TX['ok'])[0]['n'] == 1)

# not found yet → pending → found later by the cron
F = User(555022, 'Fabio', 'fabio'); ev = F.msg('/start'); F.mid = last_screen(ev)['mid']
time.sleep(1.1)
ev = F.msg(f"/binance {TX['late']}"); card = bn_card(ev)
check('ID not in the history yet → pending card (may take a minute) + 🔄 Check again, no credit',
      'Not found yet' in ctext(card) and 'take a minute' in ctext(card) and any(x and x.startswith('bnchk:') for x in cbdata(card)) and not F.bal() and bn_calls(ev), ctext(card))
c = claim(TX['late'])
check('claim stored pending with a 30-min window', c and c['status'] == 'pending' and c['credited'] == 0 and 29 * 60000 < iso_ms(c['expires_at']) - iso_ms(c['created_at']) <= 30 * 60000, c)
F.mid = card['mid'] if card else F.mid
ev, ans = F.cb(f"bnchk:{c['id']}")
check('🔄 Check again right away → rate-limit toast (1 check / 20 s), no Binance request, card kept', len(ans) == 1 and 'wait' in (ans[0]['body'].get('text') or '').lower() and not bn_calls(ev) and not tg(ev, 'sendMessage'), ans)
fpost('/_bn/tx', bn_tx(TX['late'], '7'))
time.sleep(1.1)
ev = cron()
ed = [e for e in tg(ev, 'editMessageText') if card and e['body']['message_id'] == card['mid'] and not e.get('error')]
nt = [e for e in tg(ev, 'sendMessage') if e['body']['chat_id'] == F.uid]
check('cron (every minute) finds it later → card edited to ✅, user told "+$7.00 added"',
      ed and 'Binance Pay top-up received' in ed[-1]['body']['text'] and nt and nt[-1]['body']['text'].startswith('✅ Binance Pay top-up confirmed, +$7.00 added. New balance: $7.00'), ([e['body'].get('text') for e in ed], [e['body'].get('text') for e in nt]))
check('balance $7.00 after the cron', abs(F.bal() - 7) < 1e-9, F.bal())
ev = cron(); check('cron with nothing pending → no Binance request', not bn_calls(ev), bn_calls(ev))

# rules: wrong currency, outgoing, unsupported type, receiver mismatch, above max
for key, amt, cur, otype, payid in [('btc', '0.001', 'BTC', 'C2C', '290455535'), ('out', '-5', 'USDT', 'C2C', '290455535'), ('box', '3', 'USDT', 'CRYPTO_BOX', '290455535')]:
    fpost('/_bn/tx', bn_tx(TX[key], amt, cur, otype, payid))
for i, (key, want) in enumerate([('btc', 'This transfer was made in <b>BTC</b>. Only <b>USDT</b> can be credited'), ('out', 'not an incoming payment'), ('box', "can't be used for top-ups")]):
    u = User(555023 + i, 'U%d' % i, 'u%d' % i); u.msg('/start'); time.sleep(1.1)
    ev = u.msg(TX[key]); card = bn_card(ev); c = claim(TX[key])
    check(f'{key} transaction → ❌ not credited ({want[:30]}…), status rejected, balance 0', '❌ <b>Binance Pay · not credited</b>' in ctext(card) and want in ctext(card) and c and c['status'] == 'rejected' and not u.bal(), ctext(card))
fpost('/_bn/tx', bn_tx(TX['big'], '1500'))
I = User(555030, 'Ines', 'ines'); I.msg('/start'); time.sleep(1.1)
ev = I.msg(TX['big']); card = bn_card(ev); c = claim(TX['big'])
check('1500 USDT > max $1000 → 🟠 under review, not credited, admin notified', 'under review' in ctext(card) and '1500 USDT' in ctext(card) and c['status'] == 'review' and not I.bal()
      and any('needs review' in x['body']['text'] and TX['big'] in x['body']['text'] for x in admin_msgs(ev)), ctext(card))
m = mark(); s_, body, _ = req('POST', f"/admin/api/payments/{c['id']}/approve", None, AH); ev = since(m)
check('admin "Aprovar e creditar" → credits 1500, user notified', s_ == 200 and abs(I.bal() - 1500) < 1e-9 and any('+$1500.00 added' in e['body']['text'] for e in tg(ev, 'sendMessage') if e['body']['chat_id'] == I.uid), (s_, body[:200]))
s_, body, _ = req('POST', f"/admin/api/payments/{c['id']}/approve", None, AH); check('second approve → 409, no double credit', s_ == 409 and abs(I.bal() - 1500) < 1e-9, (s_, body))
fpost('/_bn/tx', bn_tx(TX['foreign'], '3', pay_id='123456789'))
U = User(555031, 'Ugo', 'ugo'); U.msg('/start'); time.sleep(1.1)
ev = U.msg(TX['foreign']); c = claim(TX['foreign'])
check('receiver ≠ configured Pay ID → review (not auto-credited)', c and c['status'] == 'review' and c['last_status'] == 'receiver' and not U.bal(), c)

# race: two accounts paste the same new ID at the same time
fpost('/_bn/tx', bn_tx(TX['race'], '4'))
J, K = User(555032, 'Joao', 'joao'), User(555033, 'Kati', 'kati'); J.msg('/start'); K.msg('/start'); time.sleep(1.1)
with cf.ThreadPoolExecutor(2) as ex: list(ex.map(lambda u: u.msg(TX['race']), [J, K]))
bals = sorted([J.bal() or 0, K.bal() or 0])
check('same new ID pasted concurrently by two accounts → one claim, credited once', bals == [0, 4] and sql(f"SELECT COUNT(*) AS n FROM payments WHERE track_id='binance:{TX['race']}'")[0]['n'] == 1
      and len(sql(f"SELECT t.id FROM topups t JOIN payments p ON p.id=t.ref WHERE p.track_id='binance:{TX['race']}'")) == 1, bals)

# Order ID vs transactionId (live shape 2026-10-04: transactionId = 18 chars like "A_A99…", orderId = other 18 digits;
# the shop's Pay ID is the receiver's binanceId). Either form is accepted; one transfer is credited once.
def bn_tx2(txid, oid, amount):
    t = bn_tx(txid, amount); t['orderId'] = oid
    t['receiverInfo'] = {'name': 'Liveira', 'type': 'USER', 'binanceId': 290455535, 'accountId': 48120001}; return t
def topups_for(txid): return len(sql(f"SELECT t.id FROM topups t JOIN payments p ON p.id=t.ref WHERE p.track_id='binance:{txid}'"))
fpost('/_bn/tx', bn_tx2('P_A1b2C3d4E5f6G7h8', '381234567890124001', '6'))
O1, O2 = User(555040, 'Otto', 'otto'), User(555041, 'Olga', 'olga'); O1.msg('/start'); O2.msg('/start'); time.sleep(1.1)
ev = O1.msg('381234567890124001'); c = claim('P_A1b2C3d4E5f6G7h8')
check('Order ID pasted → found by orderId, claim keyed by canonical transactionId, credited $6 (Pay ID = receiverInfo.binanceId)',
      c and c['credited'] == 1 and abs(O1.bal() - 6) < 1e-9 and not claim('381234567890124001'), (c, O1.bal()))
time.sleep(1.1); ask_prompt(O2); ev = prompt_reply(O2, 'P_A1b2C3d4E5f6G7h8')
check('same transfer by its transactionId from another account → refused, credited once', not O2.bal() and topups_for('P_A1b2C3d4E5f6G7h8') == 1, O2.bal())
Q1, Q2 = User(555042, 'Quim', 'quim'), User(555043, 'Quel', 'quel'); Q1.msg('/start'); Q2.msg('/start'); time.sleep(1.1)
ev = Q1.msg('381234567890124002'); c1 = claim('381234567890124002')
check('Order ID not in history yet → pending claim under the Order ID', c1 and c1['status'] == 'pending' and not Q1.bal(), c1)
fpost('/_bn/tx', bn_tx2('M_P7x8Y9z0A1b2C3d4', '381234567890124002', '9')); time.sleep(1.1)
ask_prompt(Q2); ev = prompt_reply(Q2, 'M_P7x8Y9z0A1b2C3d4')
check('other account pastes the transactionId → credited $9', abs((Q2.bal() or 0) - 9) < 1e-9, Q2.bal())
time.sleep(1.1); ev = cron(); r1 = sql(f"SELECT * FROM payments WHERE id='{c1['id']}'")[0]
check('the Order-ID claim for the same transfer → rejected "duplicate" (re-key hits UNIQUE), no second credit',
      r1['status'] == 'rejected' and r1['last_status'] == 'duplicate' and not Q1.bal() and topups_for('M_P7x8Y9z0A1b2C3d4') == 1, r1)

# invalid ID, hourly limit
N = User(555034, 'Nina', 'nina'); N.msg('/start'); ask_prompt(N)
ev = prompt_reply(N, 'hello world!'); s_ = last_screen(ev)
check('reply that is not a transaction ID → friendly "doesn\'t look like" screen, nothing stored', s_ and "doesn't look like a Binance Pay transaction ID" in s_['body']['text'] and not bn_calls(ev))
L = User(555035, 'Lia', 'lia'); L.msg('/start'); t0 = now_ms()
sql("INSERT INTO binance_checks (user_id, at) VALUES " + ",".join(f"({L.uid},{t0 - 60000 * (i + 1)})" for i in range(10)))
ev = L.msg('/binance 381234567890123099'); s_ = last_screen(ev)
check('11th check within an hour → "Too many checks", no claim, no Binance request', s_ and 'Too many checks' in s_['body']['text'] and not bn_calls(ev) and not claim('381234567890123099'), s_ and s_['body']['text'])

# Binance errors: 451 (restricted region), 429 + Retry-After, 5xx → backoff, claim stays pending, retried later
fpost('/_bn/mode/451'); fpost('/_bn/tx', bn_tx(TX['err'], '2'))
Mm = User(555036, 'Mara', 'mara'); Mm.msg('/start'); time.sleep(1.1)
ev = Mm.msg(TX['err']); card = bn_card(ev)
check('Binance 451 → claim pending with "not reachable" note, no credit', 'Not found yet' in ctext(card) and 'not reachable' in ctext(card) and not Mm.bal() and [x for x in bn_calls(ev) if x['mode'] == 451], ctext(card))
s_, body, _ = req('GET', '/admin/api/binance/status', None, AH); st = json.loads(body)
check('451 → last_error region, backoff ~10 min (panel status)', st['last_error'] == 'region' and st['backoff_until'] and iso_ms(st['backoff_until']) - now_ms() > 8 * 60000, st)
ev = cron(); check('during backoff → cron makes no Binance request', not bn_calls(ev))
sql("DELETE FROM binance_state"); fpost('/_bn/mode/429/7')
s_, body, _ = req('POST', '/admin/api/binance/test', None, AH); d = json.loads(body)
check('429 with Retry-After: 7 → reason rate, backoff ≈ 7 s', d['ok'] is False and d['reason'] == 'rate' and 0 < iso_ms(d['status']['backoff_until']) - now_ms() <= 7000, d)
sql("DELETE FROM binance_state"); fpost('/_bn/mode/503')
s_, body, _ = req('POST', '/admin/api/binance/test', None, AH); d = json.loads(body)
check('503 → reason unavailable, short backoff (≤ 30 s)', d['ok'] is False and d['reason'] == 'unavailable' and 0 < iso_ms(d['status']['backoff_until']) - now_ms() <= 30000, d)
sql("DELETE FROM binance_state"); fpost('/_bn/mode/200')
ev = cron()
check('Binance back → cron credits the pending claim ($2.00) and tells the user', abs(Mm.bal() - 2) < 1e-9 and any(e['body']['text'].startswith('✅ Binance Pay top-up confirmed, +$2.00') for e in tg(ev, 'sendMessage') if e['body']['chat_id'] == Mm.uid), Mm.bal())
time.sleep(1.1)
with cf.ThreadPoolExecutor(4) as ex: rs = list(ex.map(lambda _: req('POST', '/admin/api/binance/test', None, AH), range(4)))
check('concurrent refreshes → at most one Binance request per cache TTL', sum(1 for r in rs if json.loads(r[1]).get('fresh')) == 1, [json.loads(r[1]).get('fresh') for r in rs])

# admin settings + panel
for bad in [{'binance_pay_id': '12ab'}, {'binance_max': '0'}, {'binance_currencies': 'US$'}]:
    s_, body, _ = req('PUT', '/admin/api/settings', bad, AH); check(f'settings invalid {bad} → 400', s_ == 400, (s_, body))
s_, body, _ = req('PUT', '/admin/api/settings', {'binance_currencies': ' usdt, usdc '}, AH)
check('binance_currencies normalized → USDT,USDC', s_ == 200 and sql("SELECT value FROM settings WHERE key='binance_currencies'")[0]['value'] == 'USDT,USDC', body)
req('PUT', '/admin/api/settings', {'binance_currencies': 'USDT'}, AH)
s_, body, _ = req('GET', '/admin/api/settings', None, AH); d = json.loads(body)
check('settings API: Binance keys editable, secrets reported only as configured=true', d['settings']['binance_pay_id'] == '290455535' and d['settings']['binance_enabled'] == '1' and d['settings']['binance_max'] == '1000' and d['info']['binance_configured'] is True and 'bn_test' not in body, d['settings'])
s_, body, _ = req('PUT', '/admin/api/settings', {'binance_enabled': '0'}, AH)
s_ = last_screen(D.msg('/topup')); check('binance_enabled=0 → no 🟡 Binance Pay in top-up', s_ and 'bn' not in cbdata(s_) and 'Binance' not in s_['body']['text'])
s_ = last_screen(D.msg('/binance')); check('binance_enabled=0 → /binance says unavailable', s_ and 'currently unavailable' in s_['body']['text'])
req('PUT', '/admin/api/settings', {'binance_enabled': '1'}, AH)
s_, body, _ = req('GET', '/admin/api/payments?q=' + TX['ok'], None, AH); d = json.loads(body)
check('admin payments: search by Binance ID, provider shown', s_ == 200 and d['total'] == 1 and d['payments'][0]['provider'] == 'binance', body[:300])
s_, body, _ = req('GET', '/admin/api/payments?status=review', None, AH); check('admin payments filter "review"', s_ == 200 and json.loads(body)['total'] >= 1)
s_, body, _ = req('GET', '/admin/app.js', None); check('admin app.js: Binance Pay settings card + approve button', 'Recarga via Binance Pay' in body and 'Aprovar e creditar' in body and 'cripto' not in body.lower())

# second Worker instance WITHOUT BINANCE_API_KEY / BINANCE_API_SECRET → option hidden, nothing happens
BASE2 = 'http://127.0.0.1:8798'
class User2(User):
    base = BASE2
    def bal(self):
        r = sql(f'SELECT balance FROM users WHERE user_id={self.uid}', state='/tmp/lvtest/state2'); return r[0]['balance'] if r else None
P = User2(555040, 'Pia', 'pia')
ev = P.msg('/start'); P.mid = last_screen(ev)['mid'] if last_screen(ev) else None
ev, _, scr = nav(P, 'topup', 'no Binance secrets: top-up menu', ['💰 <b>Top up balance</b>'], ['kp:'])
check('no Binance secrets → no 🟡 Binance Pay button or text', 'bn' not in cbdata(scr) and 'Binance' not in scr['body']['text'], scr['body']['text'])
ev = P.msg(f"/binance {TX['ok']}"); s_ = last_screen(ev)
check('no Binance secrets → /binance <id> "currently unavailable", no Binance request', s_ and 'Binance Pay top-ups are currently unavailable' in s_['body']['text'] and not bn_calls(ev), s_ and s_['body']['text'])
ev = P.msg(TX['ok']); s_ = last_screen(ev)
check('no Binance secrets → a pasted long number is not a claim (home card)', s_ and s_['body']['text'].startswith('👋 Hi') and not bn_calls(ev))
check('no Binance secrets → no binance rows stored', not sql("SELECT id FROM payments WHERE provider='binance'", state='/tmp/lvtest/state2'))
ev = cron(BASE2); check('no Binance secrets → cron does nothing', not bn_calls(ev))
s_, body, h = req('POST', '/admin/api/login', {'password': 'pw_local'}, {'X-Requested-With': 'liveira-admin'}, base=BASE2)
AH2 = {'Cookie': h.get('Set-Cookie').split(';')[0], 'X-Requested-With': 'liveira-admin'}
s_, body, _ = req('GET', '/admin/api/settings', None, AH2, base=BASE2); check('panel (no secrets): binance_configured=false', json.loads(body)['info']['binance_configured'] is False)
s_, body, _ = req('POST', '/admin/api/binance/test', None, AH2, base=BASE2); check('panel (no secrets): test → unconfigured, no request', json.loads(body)['reason'] == 'unconfigured')

ans_all = [e for e in logs() if e.get('tg') == 'answerCallbackQuery']
ids = [e['body']['callback_query_id'] for e in ans_all]
check('every callback query answered exactly once (whole run)', len(ids) == len(set(ids)) and len(ids) == next(qid) - 1, (len(ids), len(set(ids))))

# ───── global: Bot API validation
viol = [e for e in logs() if 'violation' in e]
check('no Bot API spec violations in any request (tags, callback_data ≤64, one action/button, styles, lengths, no deprecated params)', not viol, viol[:3])
print('\nSUMMARY', sum(1 for _, ok in RESULTS if ok), '/', len(RESULTS))
