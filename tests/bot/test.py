"""Local integration tests: bot UX + OxaPay security + Binance Pay + NOWPayments + Stripe + token API + admin. Run against wrangler dev on :8799
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

SEEDED = set()
def seed_lang(uid, lang='en', state='/tmp/lvtest/state'):
    """Users created by the existing tests already chose English (migration 0012: otherwise the first contact shows the
    language picker). Inserted before the user's first message, like the production backfill of existing users."""
    sql(f"INSERT INTO users (user_id, username, balance, created_at, lang, lang_chosen) VALUES ({uid}, NULL, 0, '2026-01-01T00:00:00Z', '{lang}', 1) "
        f"ON CONFLICT(user_id) DO UPDATE SET lang='{lang}', lang_chosen=1", state)
    SEEDED.add((state, uid))

class User:
    state = '/tmp/lvtest/state'
    def __init__(self, uid, first, username, lang='en'):
        """lang='en'/'pt': language already chosen (seeded); lang=None: brand-new user (first contact → language picker)."""
        self.uid, self.first, self.username = uid, first, username; self.mid = None
        if lang and (self.state, uid) not in SEEDED: seed_lang(uid, lang, self.state)
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
check('home grid: Shop/Top up, 🎁 free trial, Licenses/Downloads, Profile/Support, 🌐 Language', [len(r) for r in rows] == [2, 1, 2, 2, 1] and cbs == ['shop', 'topup', 'free', 'licenses', 'downloads', 'profile', 'support', 'lang'], cbs)
check('home: button labels with emoji', [b['text'] for b in buttons(home)] == ['🛒 Shop', '💰 Top up', '🎁 Free 1-day trial', '🔑 My licenses', '📥 Downloads', '👤 Profile', '💬 Support', '🌐 Language'], [b['text'] for b in buttons(home)])
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
sql("UPDATE settings SET value='0' WHERE key IN ('crypto_topup_enabled','nowpayments_enabled','stripe_enabled')")
ev, _, scr = nav(A, 'topup', 'top-up disabled → unavailable (menu not latest)', ['unavailable'], move=True)
ev, ans = A.cb('tun:10'); check('disabled → no invoice', not [e for e in ev if e.get('oxapay')])
sql("UPDATE settings SET value='1' WHERE key IN ('crypto_topup_enabled','nowpayments_enabled','stripe_enabled')")

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
      [c['command'] for c in cmds[0]['body']['commands']] == ['start', 'menu', 'shop', 'topup', 'free', 'licenses', 'downloads', 'profile', 'support', 'language'])
pt_cmds = [c for c in cmds if c['body'].get('language_code') == 'pt']
check('setMyCommands for Portuguese apps (language_code pt): /free + /idioma, pt descriptions', pt_cmds and pt_cmds[0]['body']['scope'] == {'type': 'default'} and
      [c['command'] for c in pt_cmds[0]['body']['commands']] == ['start', 'menu', 'shop', 'topup', 'free', 'licenses', 'downloads', 'profile', 'support', 'idioma']
      and any(c['description'] == '🎁 Teste grátis' for c in pt_cmds[0]['body']['commands']), pt_cmds and pt_cmds[0]['body'])
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
r = navrow(C); check('chat_nav stores menu, keyboard message, version, last id', r['menu_msg_id'] == H1 and r['kb_msg_id'] == KB1 and r['kb_version'] == 20 and r['last_msg_id'] == H1, r)
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

# ───── NOWPayments (fake API on :9911/np/v1, IPN secret np_test_ipn_secret_0123456789abcd)
NPS = b'np_test_ipn_secret_0123456789abcd'
def np_js(o):
    """Recursively key-sorted, JSON.stringify-compatible (integral floats print as ints)."""
    if isinstance(o, dict): return {k: np_js(o[k]) for k in sorted(o)}
    if isinstance(o, list): return [np_js(x) for x in o]
    if isinstance(o, float) and o.is_integer(): return int(o)
    return o
def np_canon(o): return json.dumps(np_js(o), separators=(',', ':'), ensure_ascii=False)
def np_sig(o, secret=NPS): return hmac.new(secret, np_canon(o).encode(), hashlib.sha512).hexdigest()
def np_legacy_canon(o):
    keys = sorted(o)  # JSON.stringify(params, Object.keys(params).sort()): the key list applies at every level
    def f(v):
        if isinstance(v, dict): return {k: f(v[k]) for k in keys if k in v}
        if isinstance(v, list): return [f(x) for x in v]
        if isinstance(v, float) and v.is_integer(): return int(v)
        return v
    return json.dumps(f(o), separators=(',', ':'), ensure_ascii=False)
def ipn(o, sig=None, raw=None, base=None):
    raw = raw if raw is not None else json.dumps(o, indent=1).encode()  # unsorted + pretty: the signature covers the sorted form
    return req('POST', '/nowpayments/ipn', raw=raw, headers={'x-nowpayments-sig': np_sig(o) if sig is None else sig}, base=base)
np_pid = itertools.count(6100000001)
def np_obj(pay, status, pid=None, actually=None, due=13.95, cur='usdttrc20', price=None, **kw):
    o = {'payment_id': pid or next(np_pid), 'parent_payment_id': None, 'invoice_id': int(pay['track_id'].split(':')[1]), 'payment_status': status,
         'pay_address': 'TXfakeAddress', 'payin_extra_id': None, 'price_amount': pay['amount_usd'] if price is None else price, 'price_currency': 'usd',
         'pay_amount': due, 'actually_paid': (due if status == 'finished' else 0) if actually is None else actually, 'actually_paid_at_fiat': 0,
         'pay_currency': cur, 'order_id': pay['id'], 'order_description': 'Liveira Shop balance top-up', 'purchase_id': '5312822613',
         'outcome_amount': 13.7, 'outcome_currency': cur, 'payment_extra_ids': None,
         'fee': {'currency': cur, 'withdrawalFee': 0, 'depositFee': 0.1, 'serviceFee': 0.07}}
    o.update(kw); return o
def np_set(o): fpost('/_np/pay', o)
def np_pay(pid): r = sql(f"SELECT * FROM payments WHERE id='{pid}'"); return r[0] if r else None
def np_rows(oid): return sql(f"SELECT * FROM np_payments WHERE order_id='{oid}' ORDER BY created_at")
def np_calls(ev, kind=None): return [x for x in ev if x.get('np') and (kind is None or x['np'] == kind)]
def np_topups(oid): return len(sql(f"SELECT id FROM topups WHERE ref='{oid}' AND method='nowpayments'"))
def user_msgs(ev, u): return [x for x in tg(ev, 'sendMessage') if x['body']['chat_id'] == u.uid]
def np_new_invoice(u, amount):
    ev, ans = u.cb(f'npn:{amount}'); c = [x for x in np_calls(ev, 'invoice')]
    p = sql(f"SELECT * FROM payments WHERE provider='nowpayments' AND telegram_user_id={u.uid} ORDER BY created_at DESC LIMIT 1")
    return ev, ans, c, (p[0] if p else None)

sql("UPDATE settings SET value='' WHERE key IN ('nowpayments_min_auto','nowpayments_min_auto_at')")
ev = cron()
check('cron refreshes the NOWPayments minimum: max(fiat_equivalent of usdttrc20/usdtbsc/ltc/trx) +10 %, rounded up → 14',
      sql("SELECT value FROM settings WHERE key='nowpayments_min_auto'")[0]['value'] == '14'
      and sorted(x['params'].get('currency_from') for x in np_calls(ev, 'GET') if x['path'] == '/np/v1/min-amount') == ['ltc', 'trx', 'usdtbsc', 'usdttrc20']
      and all(x['key_ok'] and x['params'].get('fiat_equivalent') == 'usd' and x['params'].get('currency_to') == 'usdttrc20' for x in np_calls(ev, 'GET') if x['path'] == '/np/v1/min-amount'), np_calls(ev))
ev = cron(); check('minimum is cached (no min-amount request on the next cron)', not [x for x in np_calls(ev, 'GET') if x['path'] == '/np/v1/min-amount'])
NA = User(555060, 'Nora', 'nora'); ev = NA.msg('/start'); NA.mid = last_screen(ev)['mid']
ev, _, scr = nav(NA, 'topup', 'top-up menu offers 🪙 NOWPayments', ['Pay with crypto (NOWPayments)', 'min $14.00'], ['np', 'kp:', 'bn'])
check('🪙 Pay with crypto (NOWPayments) is its own row', any([b.get('callback_data') for b in r] == ['np'] for r in scr['body']['reply_markup']['inline_keyboard']))
ev, _, scr = nav(NA, 'np', 'NOWPayments screen', ['🪙 <b>Pay with crypto (NOWPayments)</b>', '300+ cryptocurrencies', 'Minimum: <b>$14.00</b>', "can't process smaller payments"], ['npc:14', 'npc:25', 'npc:50', 'nk:', 'topup'])
check('NOWPayments presets: minimum first, OxaPay presets below the minimum dropped', [c for c in cbdata(scr) if c.startswith('npc:')] == ['npc:14', 'npc:25', 'npc:50'], cbdata(scr))
ev, _, scr = nav(NA, 'nk:', 'NOWPayments keypad', ['Other amount · NOWPayments', 'Min $14.00'], ['nk:1', 'nkok:', 'np'])
ev, ans = NA.cb('nkok:5')
check('keypad 5 → toast explains the NOWPayments minimum, no invoice', ans and 'Minimum for NOWPayments is $14.00' in ans[0]['body'].get('text', '') and not np_calls(ev, 'invoice'), ans)
ev, _, scr = nav(NA, 'nkok:20', 'keypad 20 → NOWPayments confirm', ['🪙 <b>Confirm top-up</b>', 'Amount: <b>$20.00</b>', 'via NOWPayments'], ['npn:20', 'np'])
ev, ans, calls, pa = np_new_invoice(NA, 20)
b = calls[0]['body'] if calls else {}
check('create → POST /v1/invoice with price_amount 20, usd, unique order_id, IPN URL, success/cancel back to the bot',
      len(calls) == 1 and calls[0]['key_ok'] and b.get('price_amount') == 20 and b.get('price_currency') == 'usd' and b.get('order_id') == (pa or {}).get('id')
      and b.get('ipn_callback_url') == 'https://liveira-shop.kelumayou.workers.dev/nowpayments/ipn'
      and b.get('success_url') == 'https://t.me/liveira_test_bot?start=np_paid' and b.get('cancel_url') == 'https://t.me/liveira_test_bot?start=topup'
      and b.get('is_fixed_rate') is False and 'pay_currency' not in b, b)
card = last_screen(ev)
check('invoice card: 💳 Pay now = invoice_url, NOWPayments how-it-works, check + cancel buttons',
      card and any(x.get('url') == 'https://nowpayments.io/payment/?iid=' + calls[0]['invoice_id'] for x in buttons(card)) and 'NOWPayments page' in card['body']['text']
      and f"tuchk:{pa['id']}" in cbdata(card) and f"tux:{pa['id']}" in cbdata(card), card and card['body'])
check('payments row: provider nowpayments, pending, track np:<invoice id>, 24 h, not credited',
      pa and pa['provider'] == 'nowpayments' and pa['status'] == 'pending' and pa['track_id'] == 'np:' + calls[0]['invoice_id'] and pa['credited'] == 0 and pa['id'].startswith('np_')
      and 23 * 3600000 < iso_ms(pa['expires_at']) - now_ms() <= 24 * 3600000, pa)
NA.mid = card['mid']
ev, ans = NA.cb('npn:20')
check('double tap on create → same open invoice reused, no second API call', not np_calls(ev, 'invoice') and len(sql(f"SELECT id FROM payments WHERE provider='nowpayments' AND telegram_user_id={NA.uid}")) == 1, ans)

# IPN signature
w = np_obj(pa, 'waiting')
s_, body, _ = ipn(w, sig='0' * 128); check('IPN with a wrong signature → 401, nothing stored', s_ == 401 and not np_rows(pa['id']), (s_, body))
s_, body, _ = ipn(w, sig=np_sig(w, b'another_secret_another_secret_xx')); check('IPN signed with another secret → 401', s_ == 401, s_)
s_, body, _ = req('POST', '/nowpayments/ipn', raw=json.dumps(w).encode()); check('IPN without x-nowpayments-sig → 401', s_ == 401, s_)
unsorted_sig = hmac.new(NPS, json.dumps(w, separators=(',', ':')).encode(), hashlib.sha512).hexdigest()
s_, body, _ = ipn(w, sig=unsorted_sig); check('signature over the UNSORTED body → 401 (keys must be sorted)', s_ == 401, s_)
tam = dict(w); tam['price_amount'] = 2000
s_, body, _ = ipn(tam, sig=np_sig(w)); check('tampered body with the original signature → 401', s_ == 401, s_)
m = mark(); s_, body, _ = ipn(w); ev = since(m); r = np_rows(pa['id']); p2 = np_pay(pa['id'])
check('correctly signed (recursively sorted keys, nested fee) "waiting" IPN → 200 ok, payment stored, NOT credited, no API call',
      s_ == 200 and body == 'ok' and len(r) == 1 and r[0]['status'] == 'waiting' and r[0]['payment_id'] == str(w['payment_id']) and p2['status'] == 'pending'
      and p2['credited'] == 0 and not NA.bal() and not np_calls(ev, 'GET'), (s_, body, r, p2))
s_, body, _ = ipn(w, sig=hmac.new(NPS, np_legacy_canon(w).encode(), hashlib.sha512).hexdigest())
check('legacy docs form JSON.stringify(params, Object.keys(params).sort()) also accepted', s_ == 200 and np_rows(pa['id'])[0]['ipn_count'] == 2, s_)
s_, body, _ = ipn(np_obj(pa, 'confirming', pid=w['payment_id']))
check('"confirming" → top-up status paying', s_ == 200 and np_pay(pa['id'])['status'] == 'paying' and np_pay(pa['id'])['last_status'] == 'confirming')
s_, body, _ = ipn(np_obj(pa, 'waiting', pid=w['payment_id'])); check('late "waiting" after "confirming" → no regression', np_rows(pa['id'])[0]['status'] == 'confirming' and np_pay(pa['id'])['status'] == 'paying')
# finished in the IPN, but GET /payment says confirming → not credited (defense in depth)
fin = np_obj(pa, 'finished', pid=w['payment_id']); np_set(np_obj(pa, 'confirming', pid=w['payment_id']))
m = mark(); s_, body, _ = ipn(fin); ev = since(m)
check('"finished" IPN but GET /v1/payment says confirming → NOT credited (API re-check with x-api-key)',
      s_ == 200 and not NA.bal() and np_pay(pa['id'])['credited'] == 0 and [x for x in np_calls(ev, 'GET') if x['path'] == f"/np/v1/payment/{w['payment_id']}" and x['key_ok']]
      and sql("SELECT COUNT(*) AS n FROM audit_log WHERE action='nowpayments_status_mismatch'")[0]['n'] == 1, (NA.bal(), np_calls(ev)))
fpost('/_np/mode/get/500'); m = mark(); s_, body, _ = ipn(fin); ev = since(m)
check('"finished" IPN while GET /v1/payment fails → 200 ok, NOT credited (cron re-checks later)', s_ == 200 and not NA.bal() and np_rows(pa['id'])[0]['status'] == 'finished', (s_, np_rows(pa['id'])))
fpost('/_np/mode/get/200'); np_set(fin)
m = mark(); s_, body, _ = ipn(fin); ev = since(m); p2 = np_pay(pa['id'])
check('"finished" IPN + GET confirms → credited the invoice amount $20.00 once (topups method nowpayments)',
      s_ == 200 and abs((NA.bal() or 0) - 20) < 1e-9 and p2['credited'] == 1 and p2['status'] == 'paid' and np_topups(pa['id']) == 1 and np_rows(pa['id'])[0]['credited'] == 1, (NA.bal(), p2))
um = user_msgs(ev, NA); am = admin_msgs(ev)
check('customer told: ✅ Payment confirmed, +$20.00, invoice card → paid card', any(x['body']['text'].startswith('✅ Payment confirmed, +$20.00 added. New balance: $20.00') for x in um)
      and any(x['body'].get('message_id') == NA.mid and 'Payment received' in x['body']['text'] for x in tg(ev, 'editMessageText')), [x['body']['text'][:80] for x in um])
check('admins told: NOWPayments top-up credited, coin + amount, new balance', am and 'NOWPayments top-up credited' in am[0]['body']['text'] and '13.95' in am[0]['body']['text'] and 'USDTTRC20' in am[0]['body']['text'] and 'New balance: $20.00' in am[0]['body']['text'], am and am[0]['body']['text'])
check('audit nowpayments_credit with payment id, coin, amounts', sql(f"SELECT COUNT(*) AS n FROM audit_log WHERE action='nowpayments_credit' AND json_extract(details_json,'$.payment_id')='{pa['id']}' AND json_extract(details_json,'$.np_payment_id')='{w['payment_id']}' AND json_extract(details_json,'$.pay_currency')='usdttrc20'")[0]['n'] == 1)
with cf.ThreadPoolExecutor(4) as ex: rs = list(ex.map(lambda _: ipn(fin), range(4)))
m = mark(); ipn(fin); ev = since(m)
check('repeated + concurrent "finished" IPNs → still credited exactly once, no new messages', all(r[0] == 200 for r in rs) and abs(NA.bal() - 20) < 1e-9 and np_topups(pa['id']) == 1 and not admin_msgs(ev) and not user_msgs(ev, NA), (NA.bal(), np_topups(pa['id'])))
ex2 = np_obj(pa, 'finished'); np_set(ex2)
m = mark(); ipn(ex2); ev = since(m); ipn(ex2)
check('second finished payment for an already credited top-up → NOT credited, admins told once ("extra payment")',
      abs(NA.bal() - 20) < 1e-9 and np_topups(pa['id']) == 1 and len([x for x in admin_msgs(ev) if 'extra payment' in x['body']['text']]) == 1
      and sql(f"SELECT flag FROM np_payments WHERE payment_id='{ex2['payment_id']}'")[0]['flag'] == 'extra', NA.bal())
s_, body, _ = ipn(np_obj(pa, 'waiting', order_id='np_unknown_order_123', invoice_id=999))
check('signed IPN for an unknown order → 200 ok, audited as unmatched, nothing credited', s_ == 200 and sql("SELECT COUNT(*) AS n FROM audit_log WHERE action='nowpayments_ipn_unmatched'")[0]['n'] >= 1)
NB = User(555061, 'Bia', 'bia'); NB.msg('/start'); ev, _, _, pb = np_new_invoice(NB, 25)
bad_inv = np_obj(pb, 'finished', invoice_id=12345); np_set(bad_inv)
s_, body, _ = ipn(bad_inv); check('IPN whose invoice_id differs from our invoice → mismatch, not credited', s_ == 200 and not NB.bal() and not np_rows(pb['id']), np_rows(pb['id']))
# partially paid
part = np_obj(pb, 'partially_paid', actually=7.5, due=24.9)
m = mark(); ipn(part); ev = since(m); ipn(part); ev2 = since(m)
check('partially_paid → not credited, status underpaid, customer + admins told once',
      not NB.bal() and np_pay(pb['id'])['status'] == 'underpaid' and any('arrived only partially (7.5 of 24.9 USDTTRC20)' in x['body']['text'] for x in user_msgs(ev, NB))
      and len([x for x in admin_msgs(ev2) if 'partially paid' in x['body']['text']]) == 1, (np_pay(pb['id']), [x['body']['text'][:90] for x in tg(ev2, 'sendMessage')]))
# finished but less than 98 % of the due amount arrived → review
short = np_obj(pb, 'finished', pid=part['payment_id'], actually=20.0, due=24.9); np_set(short)
m = mark(); ipn(short); ev = since(m)
check('finished but actually_paid < 98 % of pay_amount → review, not credited, admins told', not NB.bal() and np_pay(pb['id'])['status'] == 'review' and np_pay(pb['id'])['last_status'] == 'underpaid_finished'
      and any('needs review' in x['body']['text'] for x in admin_msgs(ev)), np_pay(pb['id']))
# price mismatch → review
NC = User(555062, 'Caio', 'caio'); NC.msg('/start'); _, _, _, pc = np_new_invoice(NC, 30)
pm = np_obj(pc, 'finished', price=3000); np_set(pm); ipn(pm)
check('finished with a different price_amount than our top-up → review, not credited', not NC.bal() and np_pay(pc['id'])['status'] == 'review' and np_pay(pc['id'])['last_status'] == 'price_mismatch', np_pay(pc['id']))
# missed IPN: cron fallback
ND = User(555063, 'Duda', 'duda'); ND.msg('/start'); _, _, _, pd = np_new_invoice(ND, 14)
wd = np_obj(pd, 'waiting'); ipn(wd); np_set(np_obj(pd, 'finished', pid=wd['payment_id']))
ev = cron(); check('cron: a payment updated < 3 min ago is not polled yet', not [x for x in np_calls(ev, 'GET') if x['path'].endswith(str(wd['payment_id']))] and not ND.bal())
sql(f"UPDATE np_payments SET updated_at='2026-01-01T00:00:00.000Z' WHERE payment_id='{wd['payment_id']}'")
m = mark(); ev = cron()
check('missed "finished" IPN → cron polls GET /v1/payment and credits $14.00, customer + admins told',
      abs((ND.bal() or 0) - 14) < 1e-9 and np_topups(pd['id']) == 1 and any(x['body']['text'].startswith('✅ Payment confirmed, +$14.00') for x in user_msgs(ev, ND)) and admin_msgs(ev), ND.bal())
sql(f"UPDATE np_payments SET updated_at='2026-01-01T00:00:00.000Z', checked_at=NULL WHERE payment_id='{wd['payment_id']}'")
ev = cron(); check('credited payments are not polled again, no double credit', not [x for x in np_calls(ev, 'GET') if x['path'].endswith(str(wd['payment_id']))] and np_topups(pd['id']) == 1)
# user "check status" button
NE = User(555064, 'Edu', 'edu'); NE.msg('/start'); ev, _, _, pe = np_new_invoice(NE, 15); NE.mid = last_screen(ev)['mid']
ev, ans = NE.cb(f"tuchk:{pe['id']}")
check('check status before any payment → "No payment seen yet" toast, no API call', ans and 'No payment seen yet' in ans[0]['body'].get('text', '') and not np_calls(ev, 'GET'), ans)
we = np_obj(pe, 'waiting'); ipn(we); np_set(np_obj(pe, 'finished', pid=we['payment_id']))
ev, ans = NE.cb(f"tuchk:{pe['id']}")
check('"I\'ve paid · Check status" → GET /v1/payment → credited $15.00', ans and 'Payment confirmed' in ans[0]['body'].get('text', '') and abs((NE.bal() or 0) - 15) < 1e-9 and np_topups(pe['id']) == 1, (ans, NE.bal()))
# failed
NF = User(555065, 'Fabi', 'fabi'); NF.msg('/start'); _, _, _, pf = np_new_invoice(NF, 16)
m = mark(); ipn(np_obj(pf, 'failed')); ev = since(m)
check('failed → status failed, not credited, customer + admins told', np_pay(pf['id'])['status'] == 'failed' and not NF.bal() and any('failed' in x['body']['text'] for x in user_msgs(ev, NF)) and any('payment failed' in x['body']['text'] for x in admin_msgs(ev)), np_pay(pf['id']))
# expiry of an invoice nobody paid
NG = User(555066, 'Gil', 'gil'); NG.msg('/start'); _, _, _, pg = np_new_invoice(NG, 17)
sql(f"UPDATE payments SET expires_at='2026-01-01T00:00:00.000Z' WHERE id='{pg['id']}'"); cron()
check('unpaid invoice past its 24 h → expired by the cron', np_pay(pg['id'])['status'] == 'expired')
late = np_obj(pg, 'finished'); np_set(late); ipn(late)
check('late finished payment on an expired invoice → still credited', abs((NG.bal() or 0) - 17) < 1e-9 and np_pay(pg['id'])['credited'] == 1, NG.bal())
# cancel
NH = User(555067, 'Hugo', 'hugo'); NH.msg('/start'); ev, _, _, ph = np_new_invoice(NH, 18); NH.mid = last_screen(ev)['mid']
ev, ans = NH.cb(f"tux:{ph['id']}"); check('❌ Cancel works on a NOWPayments invoice', np_pay(ph['id'])['status'] == 'canceled' and ans and 'canceled' in ans[0]['body'].get('text', '').lower(), ans)
# OxaPay confirm screen offers NOWPayments as an alternative (amount ≥ minimum only)
ev, _, scr = nav(NH, 'tuc:25', 'OxaPay confirm $25', ['Confirm top-up'], ['tun:25', 'npn:25'], move=True)
ev, _, scr = nav(NH, 'tuc:5', 'OxaPay confirm $5', ['Confirm top-up'], ['tun:5'])
check('below the NOWPayments minimum → no NOWPayments alternative', 'npn:5' not in cbdata(scr), cbdata(scr))
# OxaPay off → typed amounts and top-up menu use NOWPayments
sql("UPDATE settings SET value='0' WHERE key='crypto_topup_enabled'")
ev = NH.msg('22'); s_ = last_screen(ev)
check('OxaPay disabled: typed amount 22 → NOWPayments confirm', s_ and '🪙 <b>Confirm top-up</b>' in s_['body']['text'] and 'npn:22' in cbdata(s_), s_ and s_['body']['text'])
ev = NH.msg('9'); s_ = last_screen(ev)
check('OxaPay disabled: typed amount 9 → NOWPayments keypad with the minimum explained', s_ and 'Minimum for NOWPayments is $14.00' in s_['body']['text'] and 'nk:1' in cbdata(s_), s_ and s_['body']['text'])
ev = NH.msg('/topup'); s_ = last_screen(ev)
check('OxaPay disabled: top-up menu → NOWPayments + Binance only', s_ and 'np' in cbdata(s_) and 'bn' in cbdata(s_) and 'kp:' not in cbdata(s_), cbdata(s_))
sql("UPDATE settings SET value='1' WHERE key='crypto_topup_enabled'")
ev = NH.msg('/start np_paid'); s_ = last_screen(ev)
check('return from the NOWPayments page (start=np_paid) → latest NOWPayments invoice card', s_ and 'Top-up invoice · $18.00' in s_['body']['text'], s_ and s_['body']['text'])
s_, body, _ = req('PUT', '/admin/api/settings', {'nowpayments_enabled': '0'}, AH)
s_ = last_screen(NH.msg('/topup')); check('nowpayments_enabled=0 → no 🪙 NOWPayments in top-up', s_ and 'np' not in cbdata(s_) and 'NOWPayments' not in s_['body']['text'])
req('PUT', '/admin/api/settings', {'nowpayments_enabled': '1'}, AH)
# admin panel
s_, body, _ = req('GET', '/admin/api/nowpayments/status', None, AH); d = json.loads(body)
check('panel: NOWPayments status (available, min 14 auto, IPN URL, no secrets)', s_ == 200 and d['available'] and d['min'] == 14 and d['min_source'] == 'auto'
      and d['ipn_url'].endswith('/nowpayments/ipn') and 'np_test' not in body, d)
s_, body, _ = req('PUT', '/admin/api/settings', {'nowpayments_min': '0.5'}, AH); check('settings: NOWPayments minimum 0.5 → 400', s_ == 400, (s_, body))
req('PUT', '/admin/api/settings', {'nowpayments_min': '20'}, AH)
s_, body, _ = req('GET', '/admin/api/nowpayments/status', None, AH); d = json.loads(body); check('manual minimum 20 overrides the automatic one', d['min'] == 20 and d['min_source'] == 'manual', d)
req('PUT', '/admin/api/settings', {'nowpayments_min': ''}, AH)
s_, body, _ = req('POST', '/admin/api/nowpayments/test', None, AH); d = json.loads(body)
check('panel: "Testar conexão" → GET /status ok + fresh minimum', s_ == 200 and d['ok'] and d['min']['usd'] == 14 and d['min']['per_coin']['trx'] == 12.3, d)
s_, body, _ = req('POST', '/admin/api/nowpayments/test-invoice', None, AH); d = json.loads(body)
check('panel: test invoice at the minimum, owned by the first ADMIN_IDS account', s_ == 200 and d['amount'] == 14 and d['invoice_url'].startswith('https://nowpayments.io/payment/?iid=')
      and sql(f"SELECT telegram_user_id FROM payments WHERE id='{d['payment_id']}'")[0]['telegram_user_id'] == 1, d)
s_, body, _ = req('GET', '/admin/api/payments?q=' + str(w['payment_id']), None, AH); d = json.loads(body)
check('panel payments: search by NOWPayments payment id, provider + payment info shown', s_ == 200 and d['total'] == 1 and d['payments'][0]['provider'] == 'nowpayments' and d['payments'][0]['id'] == pa['id'] and 'finished' in (d['payments'][0]['np_info'] or ''), d)
we2 = np_obj(ph, 'waiting'); ipn(we2); np_set(np_obj(ph, 'finished', pid=we2['payment_id']))
s_, body, _ = req('POST', f"/admin/api/payments/{ph['id']}/sync", None, AH); d = json.loads(body)
check('panel "Sincronizar" on a NOWPayments row → GET /payment → credited', s_ == 200 and d['result'] == 'credited' and abs((NH.bal() or 0) - 18) < 1e-9, d)
s_, body, _ = req('GET', '/admin/api/payments?status=failed', None, AH); check('panel payments filter "failed"', s_ == 200 and json.loads(body)['total'] >= 1)
s_, body, _ = req('GET', '/admin/app.js', None); check('panel app.js: NOWPayments settings card + provider label', 'Recarga via NOWPayments' in body and 'NOWPayments: ' in body and 'Testar conexão com a NOWPayments' in body)
ev = NH.msg('/profile'); s_ = last_screen(ev); check('profile lists "NOWPayments top-up"', s_ and 'NOWPayments top-up' in s_['body']['text'], s_ and s_['body']['text'])

# ───── Stripe card top-ups (fake API on :9911/stripe/v1, webhook secret whsec_test_local_0123456789abcdef)
SPW = b'whsec_test_local_0123456789abcdef'
sp_evt_n = itertools.count(1)
def sp_sig(raw, t=None, secret=SPW):
    t = int(time.time()) if t is None else t
    return f"t={t},v1=" + hmac.new(secret, f"{t}.".encode() + raw, hashlib.sha256).hexdigest()
def sp_event(etype, obj, eid=None):
    return {'id': eid or 'evt_test%08dFakeEvt' % next(sp_evt_n), 'object': 'event', 'type': etype, 'livemode': False, 'created': int(time.time()),
            'api_version': '2024-06-20', 'data': {'object': obj}}
def sp_send(evt, sig=None, raw=None, base=None):
    raw = raw if raw is not None else json.dumps(evt).encode()
    return req('POST', '/stripe/webhook', raw=raw, headers={'Stripe-Signature': sp_sig(raw) if sig is None else sig}, base=base)
def sp_sid(pay): return pay['track_id'].split(':', 1)[1]
def sp_sess_obj(pay, status='complete', payment_status='paid', **kw):
    o = {'id': sp_sid(pay), 'object': 'checkout.session', 'client_reference_id': pay['id'], 'metadata': {'topup_id': pay['id']}, 'status': status,
         'payment_status': payment_status, 'amount_total': int(round(pay['amount_usd'] * 100)), 'currency': 'usd'}
    o.update(kw); return o
def sp_paid(pay, **kw): return json.loads(fpost(f"/_sp/pay/{sp_sid(pay)}", kw))
def sp_calls(ev, method=None, contains=''): return [x for x in ev if x.get('sp') and (method is None or x['sp'] == method) and contains in x['path']]
def sp_topups(pid, method='stripe'): return sql(f"SELECT amount FROM topups WHERE ref='{pid}' AND method='{method}' ORDER BY id")
def sp_row(pid): r = sql(f"SELECT * FROM stripe_sessions WHERE payment_id='{pid}'"); return r[0] if r else None
def sp_new(u, amount):
    ev, ans = u.cb(f'spn:{amount}')
    p = sql(f"SELECT * FROM payments WHERE provider='stripe' AND telegram_user_id={u.uid} ORDER BY created_at DESC LIMIT 1")
    return ev, ans, sp_calls(ev, 'POST', '/checkout/sessions'), (p[0] if p else None)

SA = User(555070, 'Sara', 'sara'); ev = SA.msg('/start'); SA.mid = last_screen(ev)['mid']
ev, _, scr = nav(SA, 'topup', 'top-up menu offers 💳 Pay by card (Stripe)', ['Pay by card (Stripe)', 'min $5.00'], ['sp', 'np', 'kp:', 'bn'])
check('💳 Pay by card (Stripe) is its own row', any([b.get('callback_data') for b in r] == ['sp'] for r in scr['body']['reply_markup']['inline_keyboard']))
ev, _, scr = nav(SA, 'sp', 'Stripe screen', ['💳 <b>Pay by card (Stripe)</b>', 'Min $5.00 · Max $500.00', 'secure Stripe page'], ['spc:5', 'spc:10', 'spc:25', 'spc:50', 'sk:', 'topup'])
ev, _, scr = nav(SA, 'sk:', 'Stripe keypad', ['Other amount · Card', 'Min $5.00'], ['sk:1', 'skok:', 'sp'])
ev, ans = SA.cb('skok:3'); check('card keypad 3 → toast "Minimum for card payments is $5.00", no session', ans and 'Minimum for card payments is $5.00' in ans[0]['body'].get('text', '') and not sp_calls(ev), ans)
ev, ans = SA.cb('sk:5001'); check('card keypad above the max → toast', ans and 'Maximum is $500.00' in ans[0]['body'].get('text', ''), ans)
ev, _, scr = nav(SA, 'skok:20', 'card keypad 20 → confirm', ['💳 <b>Confirm card top-up</b>', 'Amount: <b>$20.00</b> (charged in USD)'], ['spn:20', 'sp'])
ev, ans, calls, sa = sp_new(SA, 20)
f = calls[0]['form'] if calls else {}
check('create → POST /v1/checkout/sessions: payment mode, card only, USD 2000 cents, "Wallet top-up", ids in client_reference_id + metadata, t.me success/cancel, ~60 min expiry',
      len(calls) == 1 and calls[0]['key_ok'] and calls[0]['version'] == '2024-06-20' and calls[0]['idem'] == f"liveira-{(sa or {}).get('id')}"
      and calls[0]['ctype'] == 'application/x-www-form-urlencoded' and f.get('mode') == 'payment' and f.get('payment_method_types[0]') == 'card'
      and f.get('line_items[0][price_data][currency]') == 'usd' and f.get('line_items[0][price_data][unit_amount]') == '2000' and f.get('line_items[0][quantity]') == '1'
      and f.get('line_items[0][price_data][product_data][name]') == 'Wallet top-up' and f.get('client_reference_id') == sa['id'] and f.get('metadata[topup_id]') == sa['id']
      and f.get('metadata[telegram_user_id]') == str(SA.uid) and f.get('payment_intent_data[metadata][topup_id]') == sa['id']
      and f.get('success_url') == 'https://t.me/liveira_test_bot?start=sp_paid' and f.get('cancel_url') == 'https://t.me/liveira_test_bot?start=topup'
      and 3500 < int(f.get('expires_at', 0)) - time.time() <= 3600, (calls and calls[0], f))
card = last_screen(ev)
check('card: "💳 Pay by card" = session url, Card (Stripe) how-it-works, check + cancel', card and any(x.get('url', '').startswith('https://checkout.stripe.com/c/pay/' + sp_sid(sa)) for x in buttons(card))
      and 'Card (Stripe)' in card['body']['text'] and 'secure Stripe page' in card['body']['text'] and f"tuchk:{sa['id']}" in cbdata(card) and f"tux:{sa['id']}" in cbdata(card), card and card['body'])
check('payments row: provider stripe, pending, track stripe:<cs id>, expires in ~60 min; stripe_sessions row open/unpaid',
      sa and sa['provider'] == 'stripe' and sa['status'] == 'pending' and sa['track_id'].startswith('stripe:cs_test_') and sa['id'].startswith('sp_') and 55 * 60000 < iso_ms(sa['expires_at']) - now_ms() <= 60 * 60000
      and sp_row(sa['id'])['status'] == 'open' and sp_row(sa['id'])['amount_total'] == 2000, (sa, sp_row(sa['id']) if sa else None))
SA.mid = card['mid']
ev, ans = SA.cb('spn:20'); check('double tap → open session reused, no second create', not sp_calls(ev, 'POST') and len(sql(f"SELECT id FROM payments WHERE provider='stripe' AND telegram_user_id={SA.uid}")) == 1, ans)

# webhook signature
done = sp_event('checkout.session.completed', sp_sess_obj(sa))
raw = json.dumps(done).encode()
s_, body, _ = sp_send(done, sig='t=%d,v1=%s' % (int(time.time()), '0' * 64)); check('webhook with a wrong signature → 400, nothing stored', s_ == 400 and not sql(f"SELECT id FROM stripe_events WHERE id='{done['id']}'"), (s_, body))
s_, body, _ = req('POST', '/stripe/webhook', raw=raw); check('webhook without Stripe-Signature → 400', s_ == 400, s_)
s_, body, _ = sp_send(done, sig=sp_sig(raw, secret=b'whsec_other_secret_xxxxxxxxxxxxxx')); check('webhook signed with another secret → 400', s_ == 400, s_)
s_, body, _ = sp_send(done, sig=sp_sig(raw, t=int(time.time()) - 400)); check('correct signature but timestamp 400 s old → 400 (5 min tolerance)', s_ == 400, s_)
s_, body, _ = sp_send(done, sig=sp_sig(raw, t=int(time.time()) + 400)); check('timestamp 400 s in the future → 400', s_ == 400, s_)
s_, body, _ = sp_send(done, sig=sp_sig(raw), raw=raw.replace(b'"paid"', b'"unpaid"', 1)); check('tampered body with the original signature → 400', s_ == 400, s_)
s_, body, _ = sp_send(done, sig=sp_sig(raw).split(',')[0] + ',v1=' + 'f' * 64 + ',v0=abc'); check('only a wrong v1 → 400', s_ == 400, s_)
# signed "completed" event, but Stripe still says open/unpaid → not credited (session re-fetched with the secret key)
m = mark(); good = sp_sig(raw); t0 = good.split(',')[0]
s_, body, _ = sp_send(done, sig=good.replace(',v1=', ',v1=' + '0' * 64 + ',v1=')); ev = since(m)
check('signed checkout.session.completed (two v1, one valid) but GET session says open/unpaid → 200, NOT credited, re-fetched with the key',
      s_ == 200 and not SA.bal() and sql(f"SELECT credited FROM payments WHERE id='{sa['id']}'")[0]['credited'] == 0
      and [x for x in sp_calls(ev, 'GET', '/checkout/sessions/' + sp_sid(sa)) if x['key_ok'] and 'payment_intent' in urllib.parse.unquote(x['query'])], (s_, body, sp_calls(ev)))
pi = sp_paid(sa)
m = mark(); s_, body, _ = sp_send(sp_event('checkout.session.completed', sp_sess_obj(sa))); ev = since(m)
p2 = sql(f"SELECT * FROM payments WHERE id='{sa['id']}'")[0]
check('completed + GET says complete/paid → credited $20.00 once (topups method stripe), PaymentIntent/charge linked',
      s_ == 200 and abs((SA.bal() or 0) - 20) < 1e-9 and p2['credited'] == 1 and p2['status'] == 'paid' and [r['amount'] for r in sp_topups(sa['id'])] == [20]
      and sp_row(sa['id'])['payment_intent'] == pi['payment_intent'] and sp_row(sa['id'])['charge_id'] == pi['charge'] and sp_row(sa['id'])['credited'] == 1, (SA.bal(), p2, sp_row(sa['id'])))
um = user_msgs(ev, SA); am = admin_msgs(ev)
check('customer told ✅ Payment confirmed +$20.00; card → paid', any(x['body']['text'].startswith('✅ Payment confirmed, +$20.00 added. New balance: $20.00') for x in um)
      and any(x['body'].get('message_id') == SA.mid and 'Payment received' in x['body']['text'] for x in tg(ev, 'editMessageText')), [x['body']['text'][:80] for x in um])
check('admins told: Card top-up credited (Stripe), new balance', am and 'Card top-up credited (Stripe)' in am[0]['body']['text'] and 'New balance: $20.00' in am[0]['body']['text'], am and am[0]['body']['text'])
check('audit stripe_credit', sql(f"SELECT COUNT(*) AS n FROM audit_log WHERE action='stripe_credit' AND json_extract(details_json,'$.payment_id')='{sa['id']}'")[0]['n'] == 1)
dup = sp_event('checkout.session.completed', sp_sess_obj(sa))
s1 = sp_send(dup)[0]; m = mark(); s2, body2, _ = sp_send(dup); ev = since(m)
check('same event delivered twice → 200 "duplicate", not processed again (no API call, no message)', s1 == 200 and s2 == 200 and 'duplicate' in body2 and not sp_calls(ev) and not tg(ev, 'sendMessage'), (s1, s2, body2))
with cf.ThreadPoolExecutor(4) as ex: rs = list(ex.map(lambda k: sp_send(sp_event('checkout.session.completed' if k % 2 else 'checkout.session.async_payment_succeeded', sp_sess_obj(sa))), range(4)))
m = mark(); sp_send(sp_event('checkout.session.completed', sp_sess_obj(sa))); ev = since(m)
check('repeated + concurrent events (different ids) → still credited exactly once, no new messages', all(r[0] == 200 for r in rs) and abs(SA.bal() - 20) < 1e-9 and len(sp_topups(sa['id'])) == 1 and not tg(ev, 'sendMessage'), (rs, SA.bal()))
m = mark(); s_, body, _ = sp_send(sp_event('checkout.session.completed', {'id': 'cs_live_a1OtherIntegrationSession', 'object': 'checkout.session', 'status': 'complete', 'payment_status': 'paid', 'amount_total': 999, 'currency': 'usd', 'metadata': {}})); ev = since(m)
check('event for a session of another integration on the same account → 200, ignored quietly (no API call, no message), audited', s_ == 200 and not sp_calls(ev) and not tg(ev, 'sendMessage')
      and sql("SELECT COUNT(*) AS n FROM audit_log WHERE action='stripe_event_unmatched'")[0]['n'] >= 1, (s_, body))
SB = User(555071, 'Sol', 'sol'); SB.msg('/start'); _, _, _, sb = sp_new(SB, 25)
m = mark(); s_, body, _ = sp_send(sp_event('checkout.session.completed', sp_sess_obj(sb, id='cs_test_a1ForgedSessionIdXYZ123'))); ev = since(m)
check('our client_reference_id but a different session id → not credited', s_ == 200 and not SB.bal() and not sp_calls(ev, 'GET'), (s_, SB.bal()))
sp_paid(sb, amount_total=100)
m = mark(); sp_send(sp_event('checkout.session.completed', sp_sess_obj(sb))); sp_send(sp_event('checkout.session.completed', sp_sess_obj(sb))); ev = since(m)
check('paid session whose amount_total differs from the top-up → review, not credited, admins told once', not SB.bal() and sql(f"SELECT status, last_status FROM payments WHERE id='{sb['id']}'")[0] == {'status': 'review', 'last_status': 'amount_mismatch'}
      and len([x for x in admin_msgs(ev) if 'needs review' in x['body']['text']]) == 1, (SB.bal(), sql(f"SELECT status, last_status FROM payments WHERE id='{sb['id']}'")))
# GET fails → 500 (Stripe retries), event not marked processed; retry credits
SC = User(555072, 'Cris', 'cris'); SC.msg('/start'); _, _, _, sc = sp_new(SC, 10); sp_paid(sc)
fpost('/_sp/mode/get/500'); ec = sp_event('checkout.session.completed', sp_sess_obj(sc))
s_, body, _ = sp_send(ec); check('session re-fetch fails → 500 (Stripe retries), not credited, event not kept', s_ == 500 and not SC.bal() and not sql(f"SELECT id FROM stripe_events WHERE id='{ec['id']}'"), (s_, body))
fpost('/_sp/mode/get/200'); s_, body, _ = sp_send(ec)
check('Stripe retries the same event → credited $10.00', s_ == 200 and abs((SC.bal() or 0) - 10) < 1e-9 and len(sp_topups(sc['id'])) == 1, (s_, SC.bal()))
# missed webhook: cron fallback
SD = User(555073, 'Davi', 'davi'); SD.msg('/start'); _, _, _, sd = sp_new(SD, 15); sp_paid(sd)
ev = cron(); check('cron: a session created < 2 min ago is not polled yet', not sp_calls(ev, 'GET', sp_sid(sd)) and not SD.bal())
sql(f"UPDATE stripe_sessions SET updated_at='2026-01-01T00:00:00.000Z' WHERE payment_id='{sd['id']}'")
m = mark(); ev = cron()
check('missed webhook → cron re-fetches the session and credits $15.00, customer + admins told', abs((SD.bal() or 0) - 15) < 1e-9 and len(sp_topups(sd['id'])) == 1
      and any(x['body']['text'].startswith('✅ Payment confirmed, +$15.00') for x in user_msgs(ev, SD)) and admin_msgs(ev), (SD.bal(), sp_calls(ev)))
sql(f"UPDATE stripe_sessions SET updated_at='2026-01-01T00:00:00.000Z', checked_at=NULL WHERE payment_id='{sd['id']}'")
ev = cron(); check('credited sessions are not polled again', not sp_calls(ev, 'GET', sp_sid(sd)) and len(sp_topups(sd['id'])) == 1)
# expired
SE = User(555074, 'Enzo', 'enzo'); SE.msg('/start'); _, _, _, se = sp_new(SE, 12)
fpost(f"/_sp/session/{sp_sid(se)}", {'status': 'expired'})
s_, body, _ = sp_send(sp_event('checkout.session.expired', sp_sess_obj(se, status='expired', payment_status='unpaid')))
check('checkout.session.expired → top-up expired, not credited', s_ == 200 and sql(f"SELECT status FROM payments WHERE id='{se['id']}'")[0]['status'] == 'expired' and not SE.bal())
ev = cron(); check('expired sessions are not polled any more', not sp_calls(ev, 'GET', sp_sid(se)))
# check status button
SF = User(555075, 'Flor', 'flor'); SF.msg('/start'); ev, _, _, sf = sp_new(SF, 8); SF.mid = last_screen(ev)['mid']
ev, ans = SF.cb(f"tuchk:{sf['id']}")
check('check status before paying → GET session → "No card payment yet" toast', ans and 'No card payment yet' in ans[0]['body'].get('text', '') and sp_calls(ev, 'GET', sp_sid(sf)), ans)
sp_paid(sf); sql(f"UPDATE stripe_sessions SET checked_at=NULL WHERE payment_id='{sf['id']}'")
ev, ans = SF.cb(f"tuchk:{sf['id']}")
check('"I\'ve paid · Check status" after paying → credited $8.00', ans and 'Payment confirmed' in ans[0]['body'].get('text', '') and abs((SF.bal() or 0) - 8) < 1e-9, (ans, SF.bal()))
# cancel: session expired at Stripe first
SG = User(555076, 'Gabi', 'gabi'); SG.msg('/start'); ev, _, _, sg = sp_new(SG, 9); SG.mid = last_screen(ev)['mid']
ev, ans = SG.cb(f"tux:{sg['id']}"); c = last_screen(ev)
check('❌ Cancel → POST /checkout/sessions/{id}/expire, canceled, card says not charged, no Pay button',
      sp_calls(ev, 'POST', sp_sid(sg) + '/expire') and sql(f"SELECT status FROM payments WHERE id='{sg['id']}'")[0]['status'] == 'canceled' and ans and 'canceled' in ans[0]['body'].get('text', '').lower()
      and c and 'your card was not charged' in c['body']['text'] and not any(x.get('url') for x in buttons(c)), (ans, c and c['body']['text']))
SH = User(555077, 'Hana', 'hana'); SH.msg('/start'); ev, _, _, sh = sp_new(SH, 11); SH.mid = last_screen(ev)['mid']; sp_paid(sh)
ev, ans = SH.cb(f"tux:{sh['id']}")
check('cancel after paying (expire refused by Stripe) → session synced → credited, toast says already completed', ans and 'already completed' in ans[0]['body'].get('text', '') and abs((SH.bal() or 0) - 11) < 1e-9, (ans, SH.bal()))
# async payment failed
SI = User(555078, 'Ivo', 'ivo'); SI.msg('/start'); _, _, _, si = sp_new(SI, 13); sp_paid(si, payment_status='unpaid')
s_, body, _ = sp_send(sp_event('checkout.session.completed', sp_sess_obj(si, payment_status='unpaid')))
check('completed but payment_status unpaid (delayed method) → "paying", not credited', sql(f"SELECT status FROM payments WHERE id='{si['id']}'")[0]['status'] == 'paying' and not SI.bal())
m = mark(); s_, body, _ = sp_send(sp_event('checkout.session.async_payment_failed', sp_sess_obj(si, payment_status='unpaid'))); ev = since(m)
check('async_payment_failed → failed, customer + admins told', sql(f"SELECT status FROM payments WHERE id='{si['id']}'")[0]['status'] == 'failed' and not SI.bal()
      and any('card payment for the $13.00 top-up failed' in x['body']['text'] for x in user_msgs(ev, SI)) and any('Stripe card payment failed' in x['body']['text'] for x in admin_msgs(ev)), [x['body']['text'][:80] for x in tg(ev, 'sendMessage')])
# refunds
chA = sp_row(sa['id'])['charge_id']
fpost(f"/_sp/charge/{chA}", {'amount_refunded': 2000, 'refunded': True})
m = mark(); s_, body, _ = sp_send(sp_event('charge.refunded', {'id': chA, 'object': 'charge', 'payment_intent': sp_row(sa['id'])['payment_intent'], 'amount': 2000, 'amount_refunded': 2000, 'refunded': True, 'currency': 'usd'})); ev = since(m)
am = admin_msgs(ev)
check('charge.refunded (full) → charge re-read with the key, $20.00 deducted (balance covered it), topup −20 "stripe_refund"',
      s_ == 200 and abs(SA.bal() - 0) < 1e-9 and [r['amount'] for r in sp_topups(sa['id'], 'stripe_refund')] == [-20] and sp_calls(ev, 'GET', '/charges/' + chA)
      and sp_row(sa['id'])['debited_usd'] == 20 and sp_row(sa['id'])['refunded_cents'] == 2000, (SA.bal(), sp_row(sa['id'])))
check('admins get a prominent 🚨 STRIPE REFUND notice with the deduction; customer told', am and '🚨 <b>STRIPE REFUND</b>' in am[0]['body']['text'] and 'Deducted from the wallet: <b>$20.00</b>' in am[0]['body']['text']
      and any('was refunded, so $20.00 was deducted' in x['body']['text'] for x in user_msgs(ev, SA)), [x['body']['text'][:120] for x in tg(ev, 'sendMessage')])
m = mark(); sp_send(sp_event('charge.refunded', {'id': chA, 'object': 'charge', 'payment_intent': sp_row(sa['id'])['payment_intent'], 'amount': 2000, 'amount_refunded': 2000, 'refunded': True, 'currency': 'usd'})); ev = since(m)
check('another refund event for the same (already deducted) refund → nothing more deducted', abs(SA.bal() - 0) < 1e-9 and len(sp_topups(sa['id'], 'stripe_refund')) == 1, SA.bal())
chD = sp_row(sd['id'])['charge_id']
fpost(f"/_sp/charge/{chD}", {'amount_refunded': 500}); sp_send(sp_event('charge.refunded', {'id': chD, 'object': 'charge', 'payment_intent': None, 'amount_refunded': 500, 'currency': 'usd'}))
check('partial refund $5 → $5 deducted (found by charge id)', abs(SD.bal() - 10) < 1e-9 and [r['amount'] for r in sp_topups(sd['id'], 'stripe_refund')] == [-5], (SD.bal(), sp_topups(sd['id'], 'stripe_refund')))
fpost(f"/_sp/charge/{chD}", {'amount_refunded': 1500, 'refunded': True}); sp_send(sp_event('charge.refunded', {'id': chD, 'object': 'charge', 'amount_refunded': 1500, 'currency': 'usd'}))
check('second partial refund (total $15) → only the difference $10 deducted', abs(SD.bal() - 0) < 1e-9 and [r['amount'] for r in sp_topups(sd['id'], 'stripe_refund')] == [-5, -10], (SD.bal(), sp_topups(sd['id'], 'stripe_refund')))
# dispute while the customer already spent the balance
sql(f"UPDATE users SET balance=3 WHERE user_id={SC.uid}")
m = mark(); s_, body, _ = sp_send(sp_event('charge.dispute.created', {'id': 'dp_fakeDispute000001', 'object': 'dispute', 'charge': sp_row(sc['id'])['charge_id'], 'payment_intent': sp_row(sc['id'])['payment_intent'],
                                                                     'amount': 1000, 'currency': 'usd', 'reason': 'fraudulent', 'status': 'needs_response', 'evidence_details': {'due_by': int(time.time()) + 7 * 86400}})); ev = since(m)
am = admin_msgs(ev)
check('charge.dispute.created with balance $3 < $10 → NOT deducted, flagged unrecovered $10, prominent admin notice with reason + deadline, customer not messaged',
      s_ == 200 and abs(SC.bal() - 3) < 1e-9 and sp_row(sc['id'])['unrecovered_usd'] == 10 and sp_row(sc['id'])['dispute_id'] == 'dp_fakeDispute000001'
      and am and 'STRIPE DISPUTE (chargeback)' in am[0]['body']['text'] and 'NOT deducted' in am[0]['body']['text'] and 'fraudulent' in am[0]['body']['text'] and 'Evidence due by' in am[0]['body']['text']
      and not user_msgs(ev, SC), (SC.bal(), sp_row(sc['id']), am and am[0]['body']['text']))
SJ = User(555079, 'Jade', 'jade'); SJ.msg('/start'); ev, _, _, sj = sp_new(SJ, 30); sp_paid(sj); sp_send(sp_event('checkout.session.completed', sp_sess_obj(sj)))
m = mark(); sp_send(sp_event('charge.dispute.created', {'id': 'dp_fakeDispute000002', 'object': 'dispute', 'charge': sp_row(sj['id'])['charge_id'], 'amount': 3000, 'currency': 'usd', 'reason': 'product_not_received', 'status': 'needs_response'})); ev = since(m)
check('dispute with enough balance → $30.00 deducted, admins told', abs(SJ.bal() - 0) < 1e-9 and sp_row(sj['id'])['debited_usd'] == 30 and any('Deducted from the wallet: <b>$30.00</b>' in x['body']['text'] for x in admin_msgs(ev)), (SJ.bal(), sp_row(sj['id'])))
fpost('/_sp/pi/pi_otherIntegration01', {'metadata': {}})
m = mark(); s_, body, _ = sp_send(sp_event('charge.refunded', {'id': 'ch_otherIntegration01', 'object': 'charge', 'payment_intent': 'pi_otherIntegration01', 'amount_refunded': 500, 'currency': 'usd'})); ev = since(m)
check('refund of another integration\'s charge → 200, ignored (no message)', s_ == 200 and not tg(ev, 'sendMessage'), (s_, body))
s_, body, _ = sp_send(sp_event('customer.subscription.updated', {'id': 'sub_123', 'object': 'subscription'})); check('unsubscribed event type → 200 ignored', s_ == 200 and 'ignored' in body)
# shortfall offers card
ev, _, scr = nav(SG, 'days:liveira_access:7', 'shortfall offers 💳 card', ['Not enough balance'], ['tuc:10:liveira_access:7', 'spc:10:liveira_access:7'], move=True)
# OxaPay confirm screen offers card
ev, _, scr = nav(SG, 'tuc:25', 'OxaPay confirm offers 💳 card', ['Confirm top-up'], ['tun:25', 'spn:25'])
# OxaPay + NOWPayments off → typed amount goes to card
sql("UPDATE settings SET value='0' WHERE key IN ('crypto_topup_enabled','nowpayments_enabled')")
ev = SH.msg('40'); s_ = last_screen(ev); check('OxaPay + NOWPayments off: typed 40 → card confirm', s_ and 'Confirm card top-up' in s_['body']['text'] and 'spn:40' in cbdata(s_), s_ and s_['body']['text'])
ev = SH.msg('/topup'); s_ = last_screen(ev); check('OxaPay + NOWPayments off: top-up menu → card + Binance', s_ and 'sp' in cbdata(s_) and 'bn' in cbdata(s_) and 'kp:' not in cbdata(s_) and 'np' not in cbdata(s_), cbdata(s_))
sql("UPDATE settings SET value='1' WHERE key IN ('crypto_topup_enabled','nowpayments_enabled')")
ev = SF.msg('/start sp_paid'); s_ = last_screen(ev)
check('return from Stripe (start=sp_paid) → latest card top-up (paid card)', s_ and 'Payment received' in s_['body']['text'] and '$8.00' in s_['body']['text'], s_ and s_['body']['text'])
s_, body, _ = req('PUT', '/admin/api/settings', {'stripe_enabled': '0'}, AH)
s_ = last_screen(SH.msg('/topup')); check('stripe_enabled=0 → no 💳 card option', s_ and 'sp' not in cbdata(s_) and 'Stripe' not in s_['body']['text'])
req('PUT', '/admin/api/settings', {'stripe_enabled': '1'}, AH)
# admin panel
s_, body, _ = req('GET', '/admin/api/stripe/status', None, AH); d = json.loads(body)
check('panel: Stripe status (available, $5–$500, webhook URL, no secrets)', s_ == 200 and d['available'] and d['min'] == 5 and d['max'] == 500 and d['webhook_url'] == 'https://liveira-shop.kelumayou.workers.dev/stripe/webhook'
      and 'sk_test' not in body and 'whsec' not in body and d['refunds_disputes'] >= 3, d)
s_, body, _ = req('PUT', '/admin/api/settings', {'stripe_min': '0.5'}, AH); check('settings: card minimum 0.5 → 400', s_ == 400, (s_, body))
req('PUT', '/admin/api/settings', {'stripe_max': '100'}, AH)
s_, body, _ = req('GET', '/admin/api/stripe/status', None, AH); check('card max 100 applied', json.loads(body)['max'] == 100)
ev, ans = SH.cb('spc:150'); check('above the card max → keypad error', last_screen(ev) and 'Maximum for card payments is $100.00' in last_screen(ev)['body']['text'])
req('PUT', '/admin/api/settings', {'stripe_max': '500'}, AH)
sql("INSERT OR REPLACE INTO settings (key, value) VALUES ('stripe_webhook_id', 'we_fake123456')")
s_, body, _ = req('POST', '/admin/api/stripe/test', None, AH); d = json.loads(body)
check('panel: "Testar conexão" → account BR/brl/charges+payouts, webhook enabled with all events', s_ == 200 and d['ok'] and d['account']['country'] == 'BR' and d['account']['charges_enabled']
      and d['webhook']['status'] == 'enabled' and d['webhook']['url_ok'] and d['webhook']['missing_events'] == [], d)
m = mark(); s_, body, _ = req('POST', '/admin/api/stripe/test-session', None, AH); d = json.loads(body); ev = since(m)
check('panel: test checkout → real USD session at the minimum, expired right away, top-up canceled, no Telegram message', s_ == 200 and d['ok'] and d['amount'] == 5 and d['expired']
      and sp_calls(ev, 'POST', d['session_id'] + '/expire') and sql(f"SELECT status, telegram_user_id FROM payments WHERE id='{d['payment_id']}'")[0] == {'status': 'canceled', 'telegram_user_id': 1} and not tg(ev, 'sendMessage'), d)
s_, body, _ = req('GET', '/admin/api/payments?q=' + sp_sid(sc), None, AH); d = json.loads(body)
check('panel payments: search by session id → provider stripe + dispute info', s_ == 200 and d['total'] == 1 and d['payments'][0]['provider'] == 'stripe' and 'DISPUTA' in (d['payments'][0]['sp_info'] or '') and 'NÃO recuperado $10.00' in d['payments'][0]['sp_info'], d)
s_, body, _ = req('GET', '/admin/api/payments?q=' + sp_row(sa['id'])['payment_intent'], None, AH); d = json.loads(body)
check('panel payments: search by PaymentIntent id', s_ == 200 and d['total'] == 1 and d['payments'][0]['id'] == sa['id'] and 'reembolso $20.00' in (d['payments'][0]['sp_info'] or ''), d)
SK = User(555080, 'Kai', 'kai'); SK.msg('/start'); _, _, _, sk = sp_new(SK, 7); sp_paid(sk)
s_, body, _ = req('POST', f"/admin/api/payments/{sk['id']}/sync", None, AH); d = json.loads(body)
check('panel "Sincronizar" on a Stripe row → credited', s_ == 200 and d['result'] == 'credited' and abs((SK.bal() or 0) - 7) < 1e-9, d)
s_, body, _ = req('GET', '/admin/app.js', None); check('panel app.js: Stripe settings card + provider label', 'Recarga com cartão (Stripe)' in body and 'Testar conexão com a Stripe' in body and 'Cartão (Stripe)' in body)
ev = SA.msg('/profile'); s_ = last_screen(ev); check('profile lists "Card top-up (Stripe)" and the refund', s_ and 'Card top-up (Stripe)' in s_['body']['text'] and 'card refund / chargeback' in s_['body']['text'], s_ and s_['body']['text'])
check('no unexpected Stripe API params / auth failures in the whole run', all(x['key_ok'] for x in logs() if x.get('sp')) and all(x['version'] == '2024-06-20' for x in logs() if x.get('sp')))

# ───── community group: mandatory membership (gate) + "New purchase!" feed (like @LiveiraStore_bot)
GRP = -1001234567890; GRP2 = -1009876543210; INVITE = 'https://t.me/+FakeInvite123'
def gcm(ev): return tg(ev, 'getChatMember')
def gposts(ev, chat=GRP): return [x for x in tg(ev, 'sendMessage') if x['body']['chat_id'] == chat and not x.get('error')]
def member(uid, status, is_member=None, chat=GRP): fpost(f'/_tg/member/{chat}/{uid}/{status}' + ('' if is_member is None else '/' + ('1' if is_member else '0')))
def is_gate(scr): return bool(scr) and 'To use the shop, join our group' in scr['body']['text']
def buy(u, data='confirm:liveira_access:3'):
    ev, ans = u.cb(data)
    rec = [x for x in ev if x.get('tg') in ('sendMessage', 'editMessageText') and not x.get('error') and x['body']['chat_id'] == u.uid]
    rec = rec[-1] if rec else None
    if rec and rec['tg'] == 'sendMessage': u.mid = rec['mid']
    return ev, ans, rec
def gsetting(k): r = sql(f"SELECT value FROM settings WHERE key='{k}'"); return r[0]['value'] if r else None
s_, body, _ = req('GET', '/admin/api/settings', None, AH); d = json.loads(body)['settings']
check('group settings: defaults (no group = off, gate + purchase feed on)', d.get('group_chat_id') == '' and d.get('group_invite_link') == '' and d.get('group_gate') == '1' and d.get('feed_purchases') == '1', d)
GA = User(555090, 'Gabriel', 'gabriel_secret')
sql(f"INSERT OR REPLACE INTO users (user_id, username, balance, created_at, lang, lang_chosen) VALUES ({GA.uid}, 'gabriel_secret', 50, '2026-10-06T00:00:00Z', 'en', 1)")
ev = GA.msg('/start'); GA.mid = last_screen(ev)['mid']
ev, ans, scr = nav(GA, 'confirm:liveira_access:3', 'no group configured: purchase works', ['Purchase successful'], ['licenses'])
check('no group configured → no getChatMember, no group post', not gcm(ev) and not [x for x in tg(ev, 'sendMessage') if str(x['body']['chat_id']).startswith('-')], [e.get('tg') for e in ev])
for bad in ['abc', '12345', '-12', '-1001234567890x']:
    s_, body, _ = req('PUT', '/admin/api/settings', {'group_chat_id': bad}, AH); check(f'group_chat_id invalid {bad!r} → 400', s_ == 400, (s_, body))
for bad in ['http://t.me/+x123', 'https://evil.com/x', 'javascript:alert(1)', 'https://t.me/<b>']:
    s_, body, _ = req('PUT', '/admin/api/settings', {'group_invite_link': bad}, AH); check(f'group_invite_link invalid {bad!r} → 400', s_ == 400, (s_, body))
s_, body, _ = req('POST', '/admin/api/group/check', None, AH); check('panel "Verificar grupo" without a group → unset', s_ == 200 and json.loads(body)['reason'] == 'unset', body)
s_, body, _ = req('PUT', '/admin/api/settings', {'group_chat_id': str(GRP), 'group_invite_link': INVITE, 'group_gate': '1', 'feed_purchases': '1'}, AH)
check('panel saves group id + invite link', s_ == 200 and gsetting('group_chat_id') == str(GRP) and gsetting('group_invite_link') == INVITE, body)
m = mark(); s_, body, _ = req('POST', '/admin/api/group/check', None, AH); d = json.loads(body); ev = since(m)
check('panel "Verificar grupo": title, supergroup, bot is admin, can invite, title stored, no warnings', s_ == 200 and d['ok'] and d['title'] == 'Liveira Test Group' and d['type'] == 'supergroup'
      and d['is_admin'] and d['can_invite'] and d['can_send'] and d['warnings'] == [] and gsetting('group_title') == 'Liveira Test Group'
      and tg(ev, 'getChat') and gcm(ev)[0]['body']['user_id'] == 123, d)
s_, body, _ = req('GET', '/admin/api/settings', None, AH); check('settings API returns group_title (read-only)', json.loads(body)['settings']['group_title'] == 'Liveira Test Group')
# non-member
G1 = User(555091, 'Gina', 'gina')
ev = G1.msg('/start'); scr = last_screen(ev)
b = buttons(scr)
check('non-member /start → join-the-group screen (no home card)', is_gate(scr) and 'Hi, <b>' not in scr['body']['text'] and 'Tap <b>👥 Join the group</b> and then <b>✅ I\'ve joined</b>' in scr['body']['text'], scr and scr['body']['text'])
check('gate buttons: 👥 Join the group (invite URL, primary) + ✅ I\'ve joined (jg, success)', b and b[0].get('url') == INVITE and b[0]['text'] == '👥 Join the group' and b[0].get('style') == 'primary'
      and b[1].get('callback_data') == 'jg' and b[1]['text'] == "✅ I've joined" and b[1].get('style') == 'success', b)
check('gate: getChatMember(group, user) asked once', len(gcm(ev)) == 1 and gcm(ev)[0]['body'] == {'chat_id': GRP, 'user_id': G1.uid}, gcm(ev))
check('gate: non-member cached 30 s in D1', (r := sql(f"SELECT member, expires_at FROM group_members WHERE chat_id={GRP} AND user_id={G1.uid}")) and r[0]['member'] == 0 and 20000 < r[0]['expires_at'] - now_ms() <= 31000, r)
check('gate: user row still created (ensureUser)', sql(f'SELECT user_id FROM users WHERE user_id={G1.uid}'))
ev = G1.msg('/start shop'); scr = last_screen(ev)
check('non-member deep link /start shop → gate keeps the target (jg:shop), answered from cache (no getChatMember)', is_gate(scr) and 'jg:shop' in cbdata(scr) and not gcm(ev), (cbdata(scr), len(gcm(ev))))
ev = G1.msg('/start topup_25'); check('deep link topup_25 kept through the gate', 'jg:topup_25' in cbdata(last_screen(ev)))
ev = G1.msg('/start ../evil<>'); check('weird deep-link payload dropped (plain jg)', [c for c in cbdata(last_screen(ev)) if c] == ['jg'], cbdata(last_screen(ev)))
ev = G1.msg('🛒 Shop'); scr = last_screen(ev)
check('non-member reply-keyboard "🛒 Shop" → gate, button press deleted, no shop', is_gate(scr) and any(x['body']['message_id'] == G1.last_in for x in tg(ev, 'deleteMessage')) and 'Pick a product' not in json.dumps([x['body'] for x in tg(ev, 'sendMessage')]))
ev = G1.msg('25'); check('non-member typed amount → gate (no top-up confirm)', is_gate(last_screen(ev)) and 'Confirm top-up' not in json.dumps([x['body'] for x in tg(ev, 'sendMessage')]))
ev = G1.msg('/whoami'); check('/whoami still works for non-members', any('Your Telegram ID' in x['body']['text'] for x in tg(ev, 'sendMessage')))
ev, ans = G1.cb('shop'); scr = last_screen(ev)
check('non-member taps a menu button (shop) → gate instead, toast', is_gate(scr) and 'Pick a product' not in scr['body']['text'] and len(ans) == 1 and 'Join our group' in (ans[0]['body'].get('text') or ''), (ans, scr and scr['body']['text']))
ev, ans = G1.cb('confirm:liveira_access:3'); check('non-member cannot buy via callback (gate, no order)', is_gate(last_screen(ev)) and not sql(f'SELECT id FROM orders WHERE user_id={G1.uid}'))
ev, ans = G1.cb('tuchk:lv_doesnotexist'); check('payment-card actions (tuchk) stay available behind the gate', not is_gate(last_screen(ev)) and 'Payment not found' in (last_screen(ev) or {'body': {'text': ''}})['body']['text'], last_screen(ev))
G1.msg('/start shop'); gate_mid = G1.mid
ev, ans = G1.cb('jg:shop')
check('"✅ I\'ve joined" while still out → alert "We still don\'t see you", fresh getChatMember, screen unchanged', len(ans) == 1 and ans[0]['body'].get('show_alert') and "We still don't see you in the group" in ans[0]['body']['text']
      and len(gcm(ev)) == 1 and not tg(ev, 'editMessageText') and not [x for x in tg(ev, 'sendMessage') if x['body']['chat_id'] == G1.uid], (ans, [e.get('tg') for e in ev]))
member(G1.uid, 'member')
ev, ans = G1.cb('jg:shop'); scr = last_screen(ev)
check('"✅ I\'ve joined" after joining → toast "All set — welcome!" and the deep-link target (shop)', len(ans) == 1 and 'All set' in (ans[0]['body'].get('text') or '') and scr and '🛒 <b>Shop</b>' in scr['body']['text'], (ans, scr and scr['body']['text']))
check('…persistent reply keyboard attached on the way in', any('keyboard' in (x['body'].get('reply_markup') or {}) for x in tg(ev, 'sendMessage')))
check('…member cached 10 min', (r := sql(f"SELECT member, expires_at FROM group_members WHERE chat_id={GRP} AND user_id={G1.uid}")) and r[0]['member'] == 1 and 590000 < r[0]['expires_at'] - now_ms() <= 600500, r)
if scr and scr['tg'] == 'sendMessage': G1.mid = scr['mid']
ev = G1.msg('/menu'); check('member uses the bot normally, answered from the cache (no getChatMember)', last_screen(ev) and 'Hi, <b>Gina</b>' in last_screen(ev)['body']['text'] and not gcm(ev))
# statuses
for uid, st, im, ok in [(555092, 'restricted', True, True), (555093, 'restricted', False, False), (555094, 'kicked', None, False), (555095, 'administrator', None, True), (555096, 'creator', None, True), (555097, 'left', None, False)]:
    member(uid, st, im); u = User(uid, 'U', 'u%d' % uid); ev = u.msg('/start'); g = is_gate(last_screen(ev))
    check(f'status {st}' + ('' if im is None else f' (is_member={im})') + (' → allowed' if ok else ' → gate'), g != ok, last_screen(ev) and last_screen(ev)['body']['text'][:80])
fpost('/_tg/mode/member/notfound'); u = User(555098, 'NF', 'nf'); ev = u.msg('/start'); fpost('/_tg/mode/member/ok')
check('getChatMember 400 PARTICIPANT_ID_INVALID → treated as not in the group (gate)', is_gate(last_screen(ev)))
fpost('/_tg/mode/member/500'); u = User(555099, 'Err', 'err'); ev = u.msg('/start'); fpost('/_tg/mode/member/ok')
check('getChatMember 500 → fail-open (home), not cached', last_screen(ev) and 'Hi, <b>Err</b>' in last_screen(ev)['body']['text'] and not sql(f'SELECT 1 FROM group_members WHERE user_id=555099'))
ev = User(1, 'Admin', 'admin').msg('/start'); check('admin not in the group → never blocked, no getChatMember', last_screen(ev) and 'Hi, <b>Admin</b>' in last_screen(ev)['body']['text'] and not gcm(ev))
# chat_member updates
def chat_member(uid, old, new, chat=GRP):
    return req('POST', '/telegram', {'update_id': 9, 'chat_member': {'chat': {'id': chat, 'type': 'supergroup', 'title': 'Liveira Test Group'}, 'from': {'id': uid, 'is_bot': False, 'first_name': 'x'}, 'date': int(time.time()),
               'old_chat_member': {'user': {'id': uid, 'is_bot': False, 'first_name': 'x'}, 'status': old}, 'new_chat_member': {'user': {'id': uid, 'is_bot': False, 'first_name': 'x'}, 'status': new}}}, {'X-Telegram-Bot-Api-Secret-Token': 'whs_local'})
member(G1.uid, 'left'); m = mark(); chat_member(G1.uid, 'member', 'left'); ev = since(m)
check('chat_member "left" → cache dropped, no message sent', not sql(f'SELECT 1 FROM group_members WHERE chat_id={GRP} AND user_id={G1.uid}') and not tg(ev, 'sendMessage'))
ev = G1.msg('/menu'); check('…user who left is asked again and sees the gate', is_gate(last_screen(ev)) and len(gcm(ev)) == 1)
G2 = User(555100, 'Gus', 'gus'); chat_member(G2.uid, 'left', 'member')
ev = G2.msg('/start'); check('chat_member "member" (joined) → cached, bot opens without asking Telegram', last_screen(ev) and 'Hi, <b>Gus</b>' in last_screen(ev)['body']['text'] and not gcm(ev))
chat_member(555101, 'left', 'member', chat=-1005555555555); check('chat_member of another chat ignored', not sql('SELECT 1 FROM group_members WHERE user_id=555101'))
m = mark(); req('POST', '/telegram', {'update_id': 10, 'message': {'message_id': 5, 'from': GA.frm(), 'chat': {'id': GRP, 'type': 'supergroup', 'title': 'Liveira Test Group'}, 'date': int(time.time()), 'text': '/start@liveira_test_bot'}}, {'X-Telegram-Bot-Api-Secret-Token': 'whs_local'}); ev = since(m)
check('commands sent inside the group are ignored (no menu / balance posted in the group)', not tg(ev, 'sendMessage') and not tg(ev, 'editMessageText'), [e.get('tg') for e in ev])
# purchase feed
member(GA.uid, 'member'); ev = GA.msg('/start'); GA.mid = last_screen(ev)['mid']
ev, ans, scr = buy(GA, 'confirm:liveira_access:7')
check('member buys → receipt (edits the menu in place), answered once', scr and scr['tg'] == 'editMessageText' and 'Purchase successful' in scr['body']['text'] and len(ans) == 1, scr)
key = re.search(r'<code>([^<]+)</code>', scr['body']['text']).group(1)
posts = gposts(ev)
pt = posts[0]['body']['text'] if posts else ''
norders = sql('SELECT COUNT(*) AS n FROM orders')[0]['n']
check('purchase → one "🛍 New purchase!" post in the group', len(posts) == 1 and '<b>🛍 New purchase!</b>' in pt, [x['body'] for x in tg(ev, 'sendMessage')])
check('group post: product, plan, masked buyer id, total purchases', '🔑 <b>Product:</b> Liveira Access' in pt and '⏳ <b>Plan:</b> 7 days' in pt and '👤 <b>By:</b> <code>555***90</code>' in pt and f'📈 <b>Total purchases:</b> {norders}' in pt, pt)
check('group post: NO license key, price, balance, username, name or full id', key not in pt and '$' not in pt and 'gabriel' not in pt.lower() and str(GA.uid) not in pt and 'balance' not in pt.lower() and 'lv_' not in pt, pt)
check('group post: silent, "🛒 Open shop" deep link, no link preview', posts and posts[0]['body'].get('disable_notification') is True and buttons(posts[0]) == [{'text': '🛒 Open shop', 'url': 'https://t.me/liveira_test_bot?start=shop'}] and posts[0]['body'].get('link_preview_options', {}).get('is_disabled'), posts and posts[0]['body'])
order = [e.get('tg') for e in ev if e.get('tg') in ('answerCallbackQuery', 'sendMessage', 'editMessageText')]
check('group post goes out after the receipt and after the button is answered', posts and ev.index(posts[0]) > ev.index(tg(ev, 'answerCallbackQuery')[0]) and ev.index(posts[0]) > ev.index(scr), order)
print('EXAMPLE GROUP POST:', pt.replace('\n', ' | '))
req('PUT', '/admin/api/settings', {'feed_purchases': '0'}, AH)
ev, ans, scr = buy(GA)
check('feed_purchases=0 → purchase works, no group post', scr and 'Purchase successful' in scr['body']['text'] and not gposts(ev))
req('PUT', '/admin/api/settings', {'feed_purchases': '1'}, AH)
fpost('/_tg/mode/groupsend/403'); b0 = GA.bal(); nk = len(sql(f'SELECT token FROM tokens WHERE telegram_user_id={GA.uid}'))
ev, ans, scr = buy(GA)
fpost('/_tg/mode/groupsend/ok')
check('group post fails (bot kicked) → receipt with key, balance debited once, license created, button answered, failure audited', scr and 'Purchase successful' in scr['body']['text'] and '<code>' in scr['body']['text'] and abs(GA.bal() - (b0 - 5)) < 1e-9 and len(sql(f'SELECT token FROM tokens WHERE telegram_user_id={GA.uid}')) == nk + 1 and len(ans) == 1
      and sql("SELECT 1 FROM audit_log WHERE action='group_feed_failed'"), (GA.bal(), b0))
fpost(f'/_tg/migrate/{GRP}/{GRP2}'); member(GA.uid, 'member', chat=GRP2)
ev, ans, scr = buy(GA)
fpost(f'/_tg/migrate/{GRP}/0')
check('purchase fine + migrate_to_chat_id on the group post → id updated to the supergroup and the post re-sent there', gsetting('group_chat_id') == str(GRP2) and len(gposts(ev, GRP2)) == 1, (gsetting('group_chat_id'), [x['body']['chat_id'] for x in tg(ev, 'sendMessage')]))
req('POST', '/telegram', {'update_id': 11, 'message': {'message_id': 6, 'chat': {'id': GRP2, 'type': 'group', 'title': 'x'}, 'date': int(time.time()), 'migrate_to_chat_id': GRP}}, {'X-Telegram-Bot-Api-Secret-Token': 'whs_local'})
check('migrate_to_chat_id service message in the configured group → id switched', gsetting('group_chat_id') == str(GRP))
m = mark(); req('POST', '/telegram', {'update_id': 12, 'my_chat_member': {'chat': {'id': GRP, 'type': 'supergroup', 'title': 'Liveira Test Group'}, 'from': {'id': 1, 'is_bot': False, 'first_name': 'A'}, 'date': int(time.time()),
    'old_chat_member': {'user': {'id': 123, 'is_bot': True, 'first_name': 'b'}, 'status': 'administrator'}, 'new_chat_member': {'user': {'id': 123, 'is_bot': True, 'first_name': 'b'}, 'status': 'kicked'}}}, {'X-Telegram-Bot-Api-Secret-Token': 'whs_local'}); ev = since(m)
check('bot removed from the group (my_chat_member) → admins alerted', any('removed from the community group' in x['body']['text'] for x in admin_msgs(ev)), [x['body'] for x in tg(ev, 'sendMessage')])
# gate off, feed on
req('PUT', '/admin/api/settings', {'group_gate': '0'}, AH)
u = User(555102, 'Free', 'free'); ev = u.msg('/start'); check('group_gate=0 → non-members use the bot, no getChatMember', last_screen(ev) and 'Hi, <b>Free</b>' in last_screen(ev)['body']['text'] and not gcm(ev))
req('PUT', '/admin/api/settings', {'group_gate': '1'}, AH)
m = mark(); s_, body, _ = req('POST', '/admin/api/webhook/reset', None, AH); ev = since(m)
check('panel "Reconfigurar webhook" subscribes chat_member + my_chat_member', tg(ev, 'setWebhook') and set(tg(ev, 'setWebhook')[0]['body']['allowed_updates']) == {'message', 'callback_query', 'chat_member', 'my_chat_member'}, tg(ev, 'setWebhook'))
s_, body, _ = req('GET', '/admin/app.js', None); check('panel app.js: community group card', 'Grupo da comunidade (Telegram)' in body and '/group/check' in body and 'Verificar grupo' in body)
s_, body, _ = req('PUT', '/admin/api/settings', {'group_chat_id': ''}, AH)
u = User(555103, 'After', 'after'); ev = u.msg('/start'); check('group id cleared → nothing required any more', s_ == 200 and last_screen(ev) and 'Hi, <b>After</b>' in last_screen(ev)['body']['text'] and not gcm(ev))

# ───── language (pt / en): bilingual picker on first contact, switching, every screen in both languages
I18N = json.loads(subprocess.run(['node', '-e', 'import("./src/i18n.js").then(m => console.log(JSON.stringify(m.DICT)))'], cwd='/workspace/liveira-shop-worker', capture_output=True, text=True).stdout)
EN_D, PT_D = I18N['en'], I18N['pt']
def ph(v): return sorted(set(re.findall(r'\{(\w+)\}', v)))
check('i18n: en and pt have exactly the same keys (no missing translation)', set(EN_D) == set(PT_D) and len(EN_D) > 300, (sorted(set(EN_D) ^ set(PT_D)), len(EN_D)))
check('i18n: every key uses the same {placeholders} in both languages', not [k for k in EN_D if ph(EN_D[k]) != ph(PT_D.get(k, ''))], [k for k in EN_D if ph(EN_D[k]) != ph(PT_D.get(k, ''))][:5])
check('i18n: no empty strings', not [k for d in (EN_D, PT_D) for k, v in d.items() if not str(v).strip()])
DOTKEYS = [k for k in EN_D if '.' in k]
def leaks(entry):
    """Raw i18n artefacts in a rendered message: unreplaced {placeholders}, key names, 'undefined'/'null'."""
    if not entry: return ['<no screen>']
    parts = [entry['body'].get('text') or ''] + [b.get('text', '') for b in buttons(entry)]
    rm = entry['body'].get('reply_markup') or {}
    parts += [b.get('text', '') for row in rm.get('keyboard', []) for b in row]
    bad = []
    for p in parts:
        if re.search(r'\{\w+\}', p): bad.append('placeholder: ' + p[:80])
        if 'undefined' in p or 'NaN' in p or re.search(r'\bnull\b', p): bad.append('undefined/null: ' + p[:80])
        bad += ['key: ' + k for k in DOTKEYS if k in p]
    return bad

req('PUT', '/admin/api/settings', {'group_chat_id': str(GRP), 'group_invite_link': INVITE, 'group_gate': '1'}, AH)
LA = User(555110, 'Lara', 'lara', lang=None)
ev = LA.msg('/start topup_25'); scr = last_screen(ev)
check('first contact (/start topup_25) → bilingual language picker, nothing else', scr and scr['body']['text'] == PT_D['lang.first'] and 'Escolha o idioma / Choose your language' in scr['body']['text']
      and cbdata(scr) == ['lg:pt:topup_25', 'lg:en:topup_25'] and [b['text'] for b in buttons(scr)] == ['🇧🇷 Português', '🇺🇸 English'], scr and (scr['body']['text'], buttons(scr)))
check('picker comes BEFORE the group gate (no getChatMember, no join screen, no reply keyboard yet)', not gcm(ev) and not is_gate(scr) and not kbmsgs(ev), [e.get('tg') for e in ev])
check('new user stored with lang_chosen=0', (r := sql(f'SELECT lang, lang_chosen FROM users WHERE user_id={LA.uid}')) and r[0]['lang_chosen'] == 0, r)
ev = LA.msg('🛒 Shop'); scr = last_screen(ev)
check('first contact via a keyboard label → picker again, the press is deleted', scr and scr['body']['text'] == PT_D['lang.first'] and any(x['body']['message_id'] == LA.last_in for x in tg(ev, 'deleteMessage')))
ev, ans = LA.cb('shop'); scr = last_screen(ev)
check('first contact via an old button (shop) → picker (keeps the target), answered once', scr and scr['body']['text'] == PT_D['lang.first'] and cbdata(scr) == ['lg:pt:shop', 'lg:en:shop'] and len(ans) == 1, scr and cbdata(scr))
ev = LA.msg('/whoami'); check('/whoami works before choosing a language', any(str(LA.uid) in x['body']['text'] for x in tg(ev, 'sendMessage')))
ev, ans = LA.cb('lg:pt:topup_25'); scr = last_screen(ev)
check('picks 🇧🇷 Português while not in the group → join screen IN PORTUGUESE, deep link kept (jg:topup_25)', scr and 'Para usar a loja, entre no nosso grupo' in scr['body']['text'] and 'jg:topup_25' in cbdata(scr)
      and [b['text'] for b in buttons(scr)] == ['👥 Entrar no grupo', '✅ Já entrei'] and len(ans) == 1 and ans[0]['body'].get('text') == '✅ Idioma alterado para Português', (ans, scr and scr['body']['text']))
check('choice stored: lang=pt, lang_chosen=1', (r := sql(f'SELECT lang, lang_chosen FROM users WHERE user_id={LA.uid}')) and r[0]['lang'] == 'pt' and r[0]['lang_chosen'] == 1, r)
ev, ans = LA.cb('jg:topup_25'); check('"✅ Já entrei" while still out → alert in Portuguese', len(ans) == 1 and 'Ainda não vemos você no grupo' in ans[0]['body'].get('text', ''), ans)
member(LA.uid, 'member')
ev, ans = LA.cb('jg:topup_25'); scr = last_screen(ev); kbs = kbmsgs(ev)
check('joins → "Tudo certo" + the deep link target (top-up $25 confirm) in Portuguese', len(ans) == 1 and 'Tudo certo' in ans[0]['body'].get('text', '') and scr and '💰 <b>Confirmar recarga</b>' in scr['body']['text'] and 'Valor: <b>$25.00</b>' in scr['body']['text'], (ans, scr and scr['body']['text']))
check('Portuguese reply keyboard sent (🛒 Loja / 💰 Recarregar / 🔑 Minhas licenças / …), kb_version 21', kbs and [b['text'] for row in kbs[-1]['body']['reply_markup']['keyboard'] for b in row] == ['🛒 Loja', '💰 Recarregar', '🔑 Minhas licenças', '📥 Downloads', '👤 Perfil', '💬 Suporte']
      and kbs[-1]['body']['text'] == PT_D['kb.text'] and kbs[-1]['body']['reply_markup']['input_field_placeholder'] == PT_D['kb.placeholder'] and navrow(LA)['kb_version'] == 21, kbs and kbs[-1]['body'])
req('PUT', '/admin/api/settings', {'group_chat_id': ''}, AH)

LB = User(555111, 'Bruno', 'bruno', lang=None)
ev = LB.msg('/start'); scr = last_screen(ev); check('first /start without payload → picker with lg:pt / lg:en', scr and cbdata(scr) == ['lg:pt', 'lg:en'], scr and cbdata(scr))
ev, ans = LB.cb('lg:en'); scr = last_screen(ev); kbs = kbmsgs(ev)
check('picks 🇺🇸 English → toast, English keyboard (kb_version 20) and English home', len(ans) == 1 and ans[0]['body'].get('text') == '✅ Language set to English' and kbs and '🛒 Shop' in json.dumps(kbs[-1]['body'], ensure_ascii=False)
      and scr and scr['body']['text'].startswith('👋 Hi, <b>Bruno</b>') and navrow(LB)['kb_version'] == 20 and 'lang' in cbdata(scr), (ans, scr and scr['body']['text']))
if scr and scr['tg'] == 'sendMessage': LB.mid = scr['mid']
ev = LB.msg('/start'); check('second /start → no picker any more (home)', last_screen(ev) and last_screen(ev)['body']['text'].startswith('👋 Hi, <b>Bruno</b>'))
ev = LB.msg('/idioma'); scr = last_screen(ev)
check('/idioma → language screen (current English, ✅ on English, 🏠 Home)', scr and 'Current: <b>🇺🇸 English</b>' in scr['body']['text'] and cbdata(scr) == ['lgs:pt', 'lgs:en', 'home'] and buttons(scr)[1].get('style') == 'success', scr and (scr['body']['text'], cbdata(scr)))
ev = LB.msg('/language'); check('/language → same screen', last_screen(ev) and 'lgs:pt' in cbdata(last_screen(ev)))
ev, ans = LB.cb('lgs:pt'); scr = last_screen(ev); kbs = kbmsgs(ev)
check('switch to Português → toast, home in Portuguese', len(ans) == 1 and ans[0]['body'].get('text') == '✅ Idioma alterado para Português' and scr and scr['body']['text'].startswith('👋 Olá, <b>Bruno</b>! Bem-vindo(a) à'), (ans, scr and scr['body']['text']))
check('…reply keyboard re-sent with Portuguese labels (kb_version 21)', kbs and '🔑 Minhas licenças' in json.dumps(kbs[-1]['body'], ensure_ascii=False) and navrow(LB)['kb_version'] == 21, kbs and kbs[-1]['body'])
check('…home buttons in Portuguese', scr and [b['text'] for b in buttons(scr)] == ['🛒 Loja', '💰 Recarregar', '🎁 Teste grátis de 1 dia', '🔑 Minhas licenças', '📥 Downloads', '👤 Perfil', '💬 Suporte', '🌐 Idioma'], scr and [b['text'] for b in buttons(scr)])
if scr and scr['tg'] == 'sendMessage': LB.mid = scr['mid']
ev = LB.msg('🛒 Loja'); check('Portuguese keyboard label "🛒 Loja" → shop in Portuguese', last_screen(ev) and '🛒 <b>Loja</b>' in last_screen(ev)['body']['text'] and 'Escolha um produto' in last_screen(ev)['body']['text'])
ev = LB.msg('🛒 Shop'); check('old English label still routed after switching (stale keyboard) → shop in Portuguese', last_screen(ev) and '🛒 <b>Loja</b>' in last_screen(ev)['body']['text'])
ev = LB.msg('/whoami'); check('/whoami in Portuguese', any('Seu ID do Telegram' in x['body']['text'] for x in tg(ev, 'sendMessage')), [x['body']['text'] for x in tg(ev, 'sendMessage')])
check('every message to the Portuguese user so far: no raw keys / placeholders', not [l for x in tg(since(0), 'sendMessage') + tg(since(0), 'editMessageText') if (x.get('body') or {}).get('chat_id') in (LA.uid, LB.uid) for l in leaks(x)])

# every customer screen in both languages
def screens_for(u):
    out = {}
    ev = u.msg('/menu'); out['home'] = last_screen(ev)
    for d in ['shop', 'buy:liveira_access', 'days:liveira_access:3', 'licenses', 'downloads', 'profile', 'support', 'topup', 'kp:', 'kp:12', 'tuc:10', 'np', 'npc:20', 'sp', 'spc:10', 'bn', 'free', 'ft:liveira_access', 'lang']:
        ev, ans = u.cb(d); out[d] = last_screen(ev)
        if out[d] and out[d]['tg'] == 'sendMessage': u.mid = out[d]['mid']
    return out
EX = User(555112, 'Ellen', 'ellen'); EX.msg('/start')
SCR_EN = screens_for(EX); SCR_PT = screens_for(LB)
PT_EXPECT = {'home': '👋 Olá', 'shop': '🛒 <b>Loja</b>', 'buy:liveira_access': 'Escolha a duração', 'days:liveira_access:3': '🧾 <b>Confirmar compra</b>', 'licenses': '🔑 <b>Minhas licenças</b>',
             'downloads': '📥 <b>Downloads</b>', 'profile': '👤 <b>Perfil</b>', 'support': '💬 <b>Suporte</b>', 'topup': '💰 <b>Recarregar saldo</b>', 'kp:': '✏️ <b>Outro valor', 'kp:12': '✏️ <b>Outro valor',
             'tuc:10': '💰 <b>Confirmar recarga</b>', 'np': '🪙 <b>Pagar com cripto (NOWPayments)</b>', 'npc:20': '🪙 <b>Confirmar recarga</b>', 'sp': '💳 <b>Pagar no cartão (Stripe)</b>', 'spc:10': '💳 <b>Confirmar recarga no cartão</b>',
             'bn': '🟡 <b>Binance Pay</b>', 'free': '🎁 <b>Teste grátis · 1 dia</b>', 'ft:liveira_access': '🎁 <b>Confirmar teste grátis</b>', 'lang': '🌐 <b>Idioma / Language</b>'}
for k, want in PT_EXPECT.items():
    s_pt, s_en = SCR_PT.get(k), SCR_EN.get(k)
    check(f'screen {k}: Portuguese ({want[:28]}…) and English versions differ, no raw keys/placeholders in either',
          s_pt and want in s_pt['body']['text'] and s_en and s_en['body']['text'] != s_pt['body']['text'] and not leaks(s_pt) and not leaks(s_en), (k, s_pt and s_pt['body']['text'][:200], leaks(s_pt), leaks(s_en)))
check('Portuguese screens keep the same buttons/callbacks as English (only labels change)', all(cbdata(SCR_PT[k]) == cbdata(SCR_EN[k]) for k in PT_EXPECT if k not in ('home', 'licenses', 'downloads', 'profile')),
      [(k, cbdata(SCR_PT[k]), cbdata(SCR_EN[k])) for k in PT_EXPECT if cbdata(SCR_PT[k]) != cbdata(SCR_EN[k])][:3])
check('profile shows the language + 🌐 button', '🌐 Idioma: <b>🇧🇷 Português</b>' in SCR_PT['profile']['body']['text'] and 'lang' in cbdata(SCR_PT['profile']) and '🌐 Language: <b>🇺🇸 English</b>' in SCR_EN['profile']['body']['text'])
# invoice card + payment notice + purchase receipt in Portuguese
ev, ans = LB.cb('tun:10'); card = last_screen(ev)
pay = sql(f"SELECT * FROM payments WHERE telegram_user_id={LB.uid} AND provider='oxapay' ORDER BY created_at DESC LIMIT 1")
check('OxaPay invoice card in Portuguese (🧾 Fatura de recarga · $10.00, Status, Como funciona, 💳 Pagar agora)', card and '🧾 <b>Fatura de recarga · $10.00</b>' in card['body']['text'] and 'Como funciona' in card['body']['text'] and not leaks(card) and pay, card and card['body']['text'])
if pay:
    m = mark(); callback({'track_id': pay[0]['track_id'], 'status': 'Paid', 'type': 'invoice', 'amount': 10, 'currency': 'USDT', 'order_id': pay[0]['id']}); time.sleep(0.5); ev = since(m)
    um = [x for x in tg(ev, 'sendMessage') + tg(ev, 'editMessageText') if x['body'].get('chat_id') == LB.uid]
    check('payment confirmed → paid card + notice in Portuguese ("Pagamento recebido" / "Pagamento confirmado, +$10.00 adicionado")', any('✅ <b>Pagamento recebido!</b>' in x['body']['text'] for x in um) and any('Pagamento confirmado, +$10.00 adicionado' in x['body']['text'] for x in um) and not [l for x in um for l in leaks(x)], [x['body']['text'][:80] for x in um])
ev = LB.msg('/menu'); ev, ans = LB.cb('confirm:liveira_access:3'); rec = last_screen(ev)
check('purchase receipt in Portuguese (✅ Compra concluída!, Expira em, 📋 copy, 📥 download)', rec and '✅ <b>Compra concluída!</b>' in rec['body']['text'] and 'Expira em:' in rec['body']['text'] and len(ans) == 1 and ans[0]['body'].get('text') == '✅ Compra concluída!'
      and 'dl:liveira_access' in cbdata(rec) and not leaks(rec), rec and rec['body']['text'])
LB_KEY = re.search(r'<code>([^<]+)</code>', rec['body']['text']).group(1) if rec else ''
ev = LB.msg('/start'); h = last_screen(ev)
check('welcome text: Portuguese variant (welcome_text_pt) on the pt home, English on the en home', h and 'Pegue sua licença Liveira em segundos' in h['body']['text'] and 'Get your Liveira license in seconds' in SCR_EN['home']['body']['text'], h and h['body']['text'])
s_, body, _ = req('PUT', '/admin/api/settings', {'welcome_text_pt': 'Bem-vindo ao teste pt com {coins}'}, AH)
ev = LB.msg('/menu'); h = last_screen(ev); ev2 = EX.msg('/menu'); h2 = last_screen(ev2)
check('admin edits welcome_text_pt → only the Portuguese home changes ({coins} filled in pt)', s_ == 200 and h and 'Bem-vindo ao teste pt com USDT' in h['body']['text'] and '{coins}' not in h['body']['text'] and h2 and 'Bem-vindo' not in h2['body']['text'], (s_, h and h['body']['text']))
req('PUT', '/admin/api/settings', {'welcome_text_pt': ''}, AH)
ev = LB.msg('/menu'); h = last_screen(ev)
check('welcome_text_pt empty → Portuguese home falls back to welcome_text (en), still greets in Portuguese', h and h['body']['text'].startswith('👋 Olá, <b>Bruno</b>') and 'Get your Liveira license in seconds' in h['body']['text'], h and h['body']['text'])
# admin panel stays pt-BR; admin bot commands untouched
s_, body, _ = req('GET', '/admin/app.js', None)
check('panel app.js: welcome pt/en, free trial card, Grátis markers, language column', 'welcome_text_pt' in body and 'Teste grátis' in body and 'Grátis' in body and 'Idioma' in body and 'free_trial_days' in body)

# ───── free trial (one free license per Telegram account, forever)
sql("INSERT OR REPLACE INTO products (id, name, description, active, sort, file_key, file_name, file_size, file_tg_id, created_at, updated_at) VALUES ('cheat_fatal', 'Cheat Fatal Chase', 'x', 1, 5, 'products/cheat_fatal/x', 'fatal.zip', 1024, 'CACHEDFATAL', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')")
sql("INSERT OR REPLACE INTO product_prices (product_id, days, price) VALUES ('cheat_fatal', 3, 1.0), ('cheat_fatal', 7, 2.0), ('cheat_fatal', 30, 5.0)")
s_, body, _ = req('GET', '/admin/api/settings', None, AH); d = json.loads(body)['settings']
check('free trial settings: defaults enabled, 1 day, every product', d.get('free_trial_enabled') == '1' and d.get('free_trial_days') == '1' and d.get('free_trial_products') == '', d)
def uscreen(ev, u): return last_screen([x for x in ev if (x.get('body') or {}).get('chat_id') == u.uid])
def fclaims(uid): return sql(f'SELECT * FROM free_claims WHERE telegram_user_id={uid}')
def forders(uid): return sql(f"SELECT * FROM orders WHERE user_id={uid} AND kind='free_trial'")
def ftokens(uid): return sql(f'SELECT * FROM tokens WHERE telegram_user_id={uid}')
FA = User(555120, 'Felipe', 'felipe'); ev = FA.msg('/start'); h = last_screen(ev); FA.mid = h['mid']
check('home shows "🎁 Free 1-day trial" (free) before claiming', 'free' in cbdata(h) and '🎁 Free 1-day trial' in [b['text'] for b in buttons(h)])
ev, ans, scr = nav(FA, 'free', 'free trial screen', ['🎁 <b>Free trial · 1 day</b>', 'Only one free trial per account, ever'], ['ft:liveira_access', 'ft:cheat_fatal'])
ev, ans, scr = nav(FA, 'ft:cheat_fatal', 'free trial confirm', ['🎁 <b>Confirm free trial</b>', 'Cheat Fatal Chase', 'Price: <b>Free</b>'], ['ftok:cheat_fatal'], must_home=False)
b0 = FA.bal(); n_orders0 = sql('SELECT COUNT(*) AS n FROM orders')[0]['n']
ev, ans = FA.cb('ftok:cheat_fatal'); rec = last_screen(ev)
key = re.search(r'<code>([^<]+)</code>', rec['body']['text']).group(1) if rec and '<code>' in rec['body']['text'] else None
check('claim → receipt "🎁 Free trial activated!" with the key, 1 day, expiry, toast, answered once', rec and '🎁 <b>Free trial activated!</b>' in rec['body']['text'] and 'Duration: <b>1 day</b>' in rec['body']['text'] and key and len(ans) == 1 and ans[0]['body'].get('text') == '🎁 Free trial activated!', (ans, rec and rec['body']['text']))
check('receipt buttons: 📋 copy key, 📥 Download (dl:cheat_fatal), licenses, home', rec and buttons(rec)[0].get('copy_text', {}).get('text') == key and 'dl:cheat_fatal' in cbdata(rec) and 'licenses' in cbdata(rec) and 'home' in cbdata(rec), rec and buttons(rec))
c = fclaims(FA.uid); o = forders(FA.uid); tk = ftokens(FA.uid)
check('DB: one free_claims row (product, token, 1 day), one $0 order kind=free_trial, one active 1-day token', len(c) == 1 and c[0]['product_id'] == 'cheat_fatal' and c[0]['token'] == key and c[0]['days'] == 1 and c[0]['reminder_sent_at'] in (None, 'null')
      and len(o) == 1 and o[0]['price'] == 0 and o[0]['token'] == key and o[0]['duration_days'] == 1 and len(tk) == 1 and tk[0]['token'] == key and tk[0]['status'] == 'active'
      and 86000000 < iso_ms(tk[0]['expires_at']) - iso_ms(tk[0]['created_at']) <= 86400000, (c, o, tk))
check('no balance debit, no topup rows', FA.bal() == b0 and not sql(f'SELECT id FROM topups WHERE user_id={FA.uid}'), (FA.bal(), b0))
check('claim audited (free_trial_claimed)', sql(f"SELECT 1 FROM audit_log WHERE action='free_trial_claimed' AND actor='tg:{FA.uid}'"))
ev, ans = FA.cb('dl:cheat_fatal', mid=rec['mid'] if rec.get('mid') else None)
check('📥 download works with the trial license', tg(ev, 'sendDocument') and tg(ev, 'sendDocument')[0]['body'].get('document') == 'CACHEDFATAL', [e.get('tg') for e in ev])
ev = FA.msg('/menu'); h = last_screen(ev)
check('after claiming: 🎁 button hidden on home, licenses count 1', h and 'free' not in cbdata(h) and '🔑 Active licenses: <b>1</b>' in h['body']['text'], h and (cbdata(h), h['body']['text']))
ev, ans, scr = nav(FA, 'licenses', 'licenses list shows the trial key', [key[-4:]], [])
FA.msg('/menu')
for how_, act in [('/free', lambda: FA.msg('/free')), ('/start free', lambda: FA.msg('/start free')), ('callback free', lambda: FA.cb('free')[0])]:
    if how_ == 'callback free': FA.msg('/menu')
    ev = act(); scr = last_screen(ev)
    check(f'already claimed → {how_} shows "already used your free trial" (product, date), no second claim', scr and "You've already used your free trial: <b>Cheat Fatal Chase</b> (1 day)" in scr['body']['text'] and 'ft:' not in json.dumps(cbdata(scr)), scr and scr['body']['text'])
time.sleep(1)
ev, ans = FA.cb('ftok:liveira_access'); scr = last_screen(ev)
check('already claimed → trying ANOTHER product (ftok:liveira_access) refused: already-claimed screen + toast, nothing written', len(ans) == 1 and ans[0]['body'].get('text') == "You've already used your free trial"
      and len(fclaims(FA.uid)) == 1 and len(forders(FA.uid)) == 1 and len(ftokens(FA.uid)) == 1, (ans, scr and scr['body']['text']))
check('admins see a paid-license holder can still claim: profile lists the trial as "🎁 free trial"', '🎁 free trial' in (last_screen(FA.cb('profile')[0]) or {'body': {'text': ''}})['body']['text'])
# user with paid licenses can still claim (GA bought several earlier)
ev = GA.msg('/menu'); h = last_screen(ev)
check('user with paid licenses still sees the free trial button', h and 'free' in cbdata(h))
# double tap (concurrent): exactly one claim / order / token / receipt
FD = User(555121, 'Duda', 'duda'); FD.msg('/start'); FD.cb('free'); FD.cb('ft:liveira_access')
m = mark(); q0 = []
def tapc(data): return FD.cb(data)
with cf.ThreadPoolExecutor(4) as ex: res = list(ex.map(tapc, ['ftok:liveira_access', 'ftok:liveira_access', 'ftok:cheat_fatal', 'ftok:liveira_access']))
time.sleep(0.5); ev = since(m)
recs = [x for x in tg(ev, 'sendMessage') + tg(ev, 'editMessageText') if x['body'].get('chat_id') == FD.uid and '🎁 <b>Free trial activated!</b>' in (x['body'].get('text') or '')]
check('4 concurrent claim taps (2 products) → exactly 1 claim row, 1 free order, 1 token, 1 receipt; every tap answered once', len(fclaims(FD.uid)) == 1 and len(forders(FD.uid)) == 1 and len(ftokens(FD.uid)) == 1 and len(recs) == 1
      and all(len(a) == 1 for _, a in res) and fclaims(FD.uid)[0]['token'] == ftokens(FD.uid)[0]['token'] == forders(FD.uid)[0]['token'], (len(fclaims(FD.uid)), len(forders(FD.uid)), len(ftokens(FD.uid)), len(recs), [len(a) for _, a in res]))
# group configured: live membership check at claim time (with the gate OFF and ON), leave → rejoin → retry
req('PUT', '/admin/api/settings', {'group_chat_id': str(GRP), 'group_invite_link': INVITE, 'group_gate': '0', 'feed_purchases': '1'}, AH)
FC = User(555122, 'Caio', 'caio'); ev = FC.msg('/start'); FC.mid = last_screen(ev)['mid']
check('gate off + group set: non-member uses the bot (no getChatMember on /start)', last_screen(ev) and 'Hi, <b>Caio</b>' in last_screen(ev)['body']['text'] and not gcm(ev))
FC.cb('free'); FC.cb('ft:cheat_fatal')
ev, ans = FC.cb('ftok:cheat_fatal'); scr = last_screen(ev)
check('group required: non-member claim → "Join our group to get the free trial" (👥 Join + ✅ I\'ve joined retries ftok), toast, nothing written', scr and 'Join our group to get the free trial' in scr['body']['text']
      and buttons(scr)[0].get('url') == INVITE and 'ftok:cheat_fatal' in cbdata(scr) and len(ans) == 1 and ans[0]['body'].get('text') == '👥 Join our group first' and not fclaims(FC.uid) and not forders(FC.uid), (ans, scr and scr['body']['text']))
check('…membership asked live (one getChatMember)', len(gcm(ev)) == 1 and gcm(ev)[0]['body'] == {'chat_id': GRP, 'user_id': FC.uid}, gcm(ev))
member(FC.uid, 'member')
ev, ans = FC.cb('ftok:cheat_fatal'); rec = uscreen(ev, FC); posts = gposts(ev); pt = posts[0]['body']['text'] if posts else ''
norders = sql('SELECT COUNT(*) AS n FROM orders')[0]['n']
check('after joining, "✅ I\'ve joined" → claimed (receipt + 1 claim row)', rec and '🎁 <b>Free trial activated!</b>' in rec['body']['text'] and len(fclaims(FC.uid)) == 1, rec and rec['body']['text'])
check('feed: same "🛍 New purchase!" post as a purchase (product, ⏳ Plan: 1 day, masked id, total), silent, Open shop', len(posts) == 1 and '<b>🛍 New purchase!</b>' in pt and '🔑 <b>Product:</b> Cheat Fatal Chase' in pt and '⏳ <b>Plan:</b> 1 day' in pt
      and '👤 <b>By:</b> <code>555***22</code>' in pt and f'📈 <b>Total purchases:</b> {norders}' in pt and posts[0]['body'].get('disable_notification') is True and buttons(posts[0])[0]['text'] == '🛒 Open shop', pt)
check('feed post: no key, no price, no username; sent after the receipt and the answer', posts and fclaims(FC.uid)[0]['token'] not in pt and '$' not in pt and 'caio' not in pt.lower() and ev.index(posts[0]) > ev.index(rec) and ev.index(posts[0]) > ev.index(tg(ev, 'answerCallbackQuery')[0]), pt)
member(FC.uid, 'left'); chat_member(FC.uid, 'member', 'left'); time.sleep(0.3)
member(FC.uid, 'member'); chat_member(FC.uid, 'left', 'member'); time.sleep(0.3)
FC.username = 'caio_new'; FC.first = 'Caio2'
ev = FC.msg('/menu'); h = last_screen(ev)
ev, ans = FC.cb('ftok:liveira_access'); scr = last_screen(ev)
check('leave → rejoin → new username → retry another product: still refused (claim keyed by Telegram id), 1 claim / 1 free order / 1 token', len(fclaims(FC.uid)) == 1 and len(forders(FC.uid)) == 1 and len(ftokens(FC.uid)) == 1
      and fclaims(FC.uid)[0]['product_id'] == 'cheat_fatal' and h and 'free' not in cbdata(h) and len(ans) == 1 and ans[0]['body'].get('text') == "You've already used your free trial", (fclaims(FC.uid), ans))
req('PUT', '/admin/api/settings', {'group_gate': '1'}, AH)
FG = User(555123, 'Gui', 'gui'); member(FG.uid, 'member'); ev = FG.msg('/start'); FG.mid = last_screen(ev)['mid']
FG.cb('free'); FG.cb('ft:cheat_fatal')
member(FG.uid, 'left')  # left without a chat_member update: the gate cache still says "member"
ev, ans = FG.cb('ftok:cheat_fatal'); scr = uscreen(ev, FG)
check('gate on: cached "member" but actually left → claim blocked by the LIVE check (no stale cache), nothing written', scr and 'Join our group to get the free trial' in scr['body']['text'] and len(gcm(ev)) == 1 and not fclaims(FG.uid), (scr and scr['body']['text'], len(gcm(ev))))
member(FG.uid, 'member'); req('PUT', '/admin/api/settings', {'feed_purchases': '0'}, AH)
ev, ans = FG.cb('ftok:cheat_fatal'); rec = uscreen(ev, FG)
check('feed_purchases=0 → "✅ I\'ve joined" on the free-trial screen right after joining (gate cache still says out) → claimed, no group post', rec and '🎁 <b>Free trial activated!</b>' in rec['body']['text'] and not gposts(ev))
req('PUT', '/admin/api/settings', {'feed_purchases': '1'}, AH)
FH = User(555124, 'Heitor', 'heitor'); member(FH.uid, 'member'); ev = FH.msg('/start'); FH.mid = last_screen(ev)['mid']; FH.cb('free'); FH.cb('ft:liveira_access')
fpost('/_tg/mode/groupsend/403'); ev, ans = FH.cb('ftok:liveira_access'); fpost('/_tg/mode/groupsend/ok'); rec = uscreen(ev, FH)
check('group post fails (bot kicked) → claim still delivered (receipt, 1 claim, 1 token), answered once', rec and '🎁 <b>Free trial activated!</b>' in rec['body']['text'] and len(fclaims(FH.uid)) == 1 and len(ftokens(FH.uid)) == 1 and len(ans) == 1)
fpost('/_tg/mode/member/500'); FM = User(555125, 'Mel', 'mel'); member(FM.uid, 'member'); ev = FM.msg('/start'); FM.mid = last_screen(ev)['mid'] if last_screen(ev) else None
FM.cb('free'); FM.cb('ft:cheat_fatal'); ev, ans = FM.cb('ftok:cheat_fatal'); fpost('/_tg/mode/member/ok')
check('Telegram error on the live check → fail-open (claimed), like the gate', len(fclaims(FM.uid)) == 1, last_screen(ev) and last_screen(ev)['body']['text'][:80])
ev, ans = User(1, 'Admin', 'admin').cb('free'); check('admin (not in the group) → free trial screen, never blocked', last_screen(ev) and ('Free trial' in last_screen(ev)['body']['text']), last_screen(ev) and last_screen(ev)['body']['text'][:80])
req('PUT', '/admin/api/settings', {'group_chat_id': ''}, AH)
# no group configured: works without the membership check
FN = User(555126, 'Nina', 'nina'); ev = FN.msg('/start'); FN.mid = last_screen(ev)['mid']
FN.cb('free'); FN.cb('ft:liveira_access'); ev, ans = FN.cb('ftok:liveira_access'); check('no group configured → claim works, no getChatMember, no group post', last_screen(ev) and '🎁 <b>Free trial activated!</b>' in last_screen(ev)['body']['text'] and not gcm(ev) and not gposts(ev))
# Portuguese user: claim + already-claimed in Portuguese
ev = LB.msg('/start free'); scr = last_screen(ev)
check('/start free (pt) → free trial screen in Portuguese', scr and '🎁 <b>Teste grátis · 1 dia</b>' in scr['body']['text'] and 'Só um teste grátis por conta, para sempre' in scr['body']['text'] and not leaks(scr), scr and scr['body']['text'])
LB.cb('ft:cheat_fatal'); ev, ans = LB.cb('ftok:cheat_fatal'); rec_pt = last_screen(ev)
check('pt claim → "🎁 Teste grátis ativado!" receipt in Portuguese', rec_pt and '🎁 <b>Teste grátis ativado!</b>' in rec_pt['body']['text'] and 'Duração: <b>1 dia</b>' in rec_pt['body']['text'] and ans[0]['body'].get('text') == '🎁 Teste grátis ativado!' and not leaks(rec_pt), rec_pt and rec_pt['body']['text'])
ev = LB.msg('/free'); already_pt = last_screen(ev)
check('pt already claimed → "Você já usou o seu teste grátis"', already_pt and 'Você já usou o seu teste grátis: <b>Cheat Fatal Chase</b> (1 dia)' in already_pt['body']['text'] and not leaks(already_pt), already_pt and already_pt['body']['text'])
# expiry reminder (cron): once, in the user's language, with a button to the same product's 3-day plan
sql(f"UPDATE free_claims SET expires_at='2026-01-01T00:00:00.000Z' WHERE telegram_user_id IN ({FA.uid}, {LB.uid})")
ev = cron(); rem = [x for x in tg(ev, 'sendMessage') if x['body']['chat_id'] in (FA.uid, LB.uid)]
r_en = [x for x in rem if x['body']['chat_id'] == FA.uid]; r_pt = [x for x in rem if x['body']['chat_id'] == LB.uid]
check('cron: trial ended → one reminder to each expired user (nobody else)', len(r_en) == 1 and len(r_pt) == 1 and not [x for x in tg(ev, 'sendMessage') if 'free trial has ended' in x['body']['text'] and x['body']['chat_id'] not in (FA.uid, LB.uid)], [x['body']['chat_id'] for x in rem])
check('reminder (en): "Your free trial has ended", button "🛒 Buy 3 days · $1.00" → days:cheat_fatal:3', r_en and '⌛ <b>Your free trial has ended</b>' in r_en[0]['body']['text'] and buttons(r_en[0])[0] == {'text': '🛒 Buy 3 days · $1.00', 'callback_data': 'days:cheat_fatal:3', 'style': 'success'}, r_en and (r_en[0]['body']['text'], buttons(r_en[0])))
check('reminder (pt): "Seu teste grátis acabou", "🛒 Comprar 3 dias · $1.00"', r_pt and '⌛ <b>Seu teste grátis acabou</b>' in r_pt[0]['body']['text'] and buttons(r_pt[0])[0]['text'] == '🛒 Comprar 3 dias · $1.00' and not leaks(r_pt[0]), r_pt and r_pt[0]['body']['text'])
check('reminder_sent_at stored', all(fclaims(u)[0]['reminder_sent_at'] for u in (FA.uid, LB.uid)))
ev = cron(); check('second cron run → no second reminder', not [x for x in tg(ev, 'sendMessage') if x['body']['chat_id'] in (FA.uid, LB.uid)])
REM_PT = r_pt[0]['body']['text'] if r_pt else ''
LB.mid = r_pt[0]['mid'] if r_pt else LB.mid
ev, ans = LB.cb('days:cheat_fatal:3'); scr = last_screen(ev)
check('reminder button → purchase confirmation of the 3-day plan (pt)', scr and '🧾 <b>Confirmar compra</b>' in scr['body']['text'] and 'Cheat Fatal Chase' in scr['body']['text'] and 'confirm:cheat_fatal:3' in cbdata(scr), scr and scr['body']['text'])
ev = LB.msg('/start buy_cheat_fatal_7'); scr = last_screen(ev)
check('deep link start=buy_<pid>_<days> → purchase confirmation', scr and '🧾 <b>Confirmar compra</b>' in scr['body']['text'] and 'confirm:cheat_fatal:7' in cbdata(scr), scr and scr['body']['text'])
check('claims are never deleted (rows still there after expiry + reminder)', len(fclaims(FA.uid)) == 1 and len(fclaims(LB.uid)) == 1)
# settings: disabled / eligible products / days
s_, body, _ = req('PUT', '/admin/api/settings', {'free_trial_enabled': '0'}, AH)
FX = User(555127, 'Xavi', 'xavi'); ev = FX.msg('/start'); h = last_screen(ev); FX.mid = h['mid']
check('free_trial_enabled=0 → no 🎁 button on home', s_ == 200 and h and 'free' not in cbdata(h), cbdata(h))
ev, ans = FX.cb('ftok:cheat_fatal'); check('free_trial_enabled=0 → claim refused ("not available"), nothing written', last_screen(ev) and 'The free trial is not available right now' in last_screen(ev)['body']['text'] and not fclaims(FX.uid))
ev = FX.msg('/free'); check('free_trial_enabled=0 → /free says not available', last_screen(ev) and 'not available' in last_screen(ev)['body']['text'])
for bad in [{'free_trial_days': '0'}, {'free_trial_days': '31'}, {'free_trial_days': 'x'}, {'free_trial_products': 'nope_product'}]:
    s_, body, _ = req('PUT', '/admin/api/settings', bad, AH); check(f'settings validation {bad} → 400', s_ == 400, (s_, body))
s_, body, _ = req('PUT', '/admin/api/settings', {'free_trial_enabled': '1', 'free_trial_days': '2', 'free_trial_products': 'cheat_fatal'}, AH)
ev = FX.msg('/menu'); h = last_screen(ev); FX.mid = h['mid']
check('free_trial_days=2 → home button "🎁 Free 2-day trial"', s_ == 200 and h and '🎁 Free 2-day trial' in [b['text'] for b in buttons(h)], (s_, body, h and [b['text'] for b in buttons(h)]))
ev, ans = FX.cb('free'); scr = last_screen(ev)
check('free_trial_products=cheat_fatal → only that product offered', scr and 'ft:cheat_fatal' in cbdata(scr) and 'ft:liveira_access' not in cbdata(scr) and '2 days' in scr['body']['text'], scr and cbdata(scr))
ev, ans = FX.cb('ftok:liveira_access'); check('not-eligible product → refused, nothing written', last_screen(ev) and 'not part of the free trial' in last_screen(ev)['body']['text'] and not fclaims(FX.uid))
ev, ans = FX.cb('ftok:cheat_fatal'); tk = ftokens(FX.uid)
check('claim with free_trial_days=2 → 2-day license', len(tk) == 1 and tk[0]['duration_days'] == 2 and fclaims(FX.uid)[0]['days'] == 2 and 'Duration: <b>2 days</b>' in last_screen(ev)['body']['text'], tk)
req('PUT', '/admin/api/settings', {'free_trial_days': '1', 'free_trial_products': ''}, AH)
# admin panel: trials are not sales
s_, body, _ = req('GET', '/admin/api/dashboard', None, AH); st = json.loads(body)['stats']
paid_n = sql("SELECT COUNT(*) AS n, COALESCE(SUM(price),0) AS s FROM orders WHERE kind <> 'free_trial'")[0]; free_n = sql('SELECT COUNT(*) AS n FROM free_claims')[0]['n']
check('dashboard: orders_total / revenue count paid orders only; free trials reported apart', st['orders_total'] == paid_n['n'] and abs(st['revenue'] - paid_n['s']) < 1e-9 and st['free_total'] == free_n and free_n >= 8, (st, paid_n, free_n))
check('dashboard recent orders carry kind (Grátis marker)', any(o.get('kind') == 'free_trial' for o in json.loads(body)['recent']), json.loads(body)['recent'][:2])
s_, body, _ = req('GET', '/admin/api/orders?kind=free_trial', None, AH); d = json.loads(body)
check('orders filter kind=free_trial → only $0 trials', s_ == 200 and d['orders'] and all(o['kind'] == 'free_trial' and o['price'] == 0 for o in d['orders']) and d['total'] == free_n, (s_, d.get('total'), free_n))
s_, body, _ = req('GET', '/admin/api/orders?kind=paid', None, AH); d = json.loads(body)
check('orders filter kind=paid → no trials', s_ == 200 and d['total'] == paid_n['n'] and all(o['kind'] != 'free_trial' for o in d['orders']))
s_, body, _ = req('GET', f'/admin/api/users?q={FA.uid}', None, AH); us = json.loads(body)['users']
check('users list: free trial product + language columns', us and us[0]['free_product'] == 'Cheat Fatal Chase' and us[0]['lang'] == 'en' and us[0]['orders_count'] == 0, us)
s_, body, _ = req('GET', f'/admin/api/users/{FA.uid}', None, AH); ud = json.loads(body)
check('user detail: free_claim', ud.get('free_claim') and ud['free_claim']['product_id'] == 'cheat_fatal', ud.get('free_claim'))
print('SAMPLE PT LANGUAGE PICKER:', PT_D['lang.first'].replace('\n', ' | '))
print('SAMPLE PT FREE TRIAL SCREEN:', (SCR_PT['free']['body']['text'] if SCR_PT.get('free') else '').replace('\n', ' | '))
print('SAMPLE PT CLAIM RECEIPT:', (rec_pt['body']['text'] if rec_pt else '').replace('\n', ' | '))
print('SAMPLE PT ALREADY CLAIMED:', (already_pt['body']['text'] if already_pt else '').replace('\n', ' | '))
print('SAMPLE PT EXPIRY REMINDER:', REM_PT.replace('\n', ' | '), '| BUTTONS:', r_pt and [b['text'] for b in buttons(r_pt[0])])


# second Worker instance WITHOUT BINANCE_API_KEY / BINANCE_API_SECRET → option hidden, nothing happens
BASE2 = 'http://127.0.0.1:8798'
class User2(User):
    base = BASE2
    state = '/tmp/lvtest/state2'
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
check('no NOWPayments secrets → no 🪙 NOWPayments option', 'np' not in cbdata(scr) and 'NOWPayments' not in scr['body']['text'], scr['body']['text'])
s_, body, _ = req('POST', '/nowpayments/ipn', raw=b'{"payment_id":1}', headers={'x-nowpayments-sig': 'a' * 128}, base=BASE2)
check('no NOWPayments secrets → IPN route answers 503', s_ == 503, s_)
s_, body, _ = req('GET', '/admin/api/nowpayments/status', None, AH2, base=BASE2); check('panel (no secrets): NOWPayments not configured / hidden', json.loads(body)['configured'] is False and json.loads(body)['available'] is False)
check('no Stripe secrets → no 💳 card option', 'sp' not in cbdata(scr) and 'Stripe' not in scr['body']['text'], scr['body']['text'])
s_, body, _ = req('POST', '/stripe/webhook', raw=b'{"id":"evt_x"}', headers={'Stripe-Signature': 't=1,v1=' + 'a' * 64}, base=BASE2)
check('no Stripe secrets → webhook answers 503', s_ == 503, s_)
s_, body, _ = req('GET', '/admin/api/stripe/status', None, AH2, base=BASE2); check('panel (no secrets): Stripe not configured / hidden', json.loads(body)['configured'] is False and json.loads(body)['available'] is False)
ev = cron(BASE2); check('no Stripe secrets → cron makes no Stripe request', not [x for x in ev if x.get('sp')])

# group gate on a database WITHOUT migration 0011 (no group_members table): works, just uncached
sql('DROP TABLE IF EXISTS group_members', state='/tmp/lvtest/state2')
sql("INSERT OR REPLACE INTO settings (key, value) VALUES ('group_chat_id', '-1001234567890'), ('group_invite_link', 'https://t.me/+FakeInvite123')", state='/tmp/lvtest/state2')
P2 = User2(555041, 'Noa', 'noa'); ev = P2.msg('/start')
check('no migration 0011: non-member still gets the gate (no crash)', last_screen(ev) and 'To use the shop, join our group' in last_screen(ev)['body']['text'], last_screen(ev))
fpost('/_tg/member/-1001234567890/555041/member'); ev = P2.msg('/start')
check('no migration 0011: member gets in (asked every time, no cache)', last_screen(ev) and 'Hi, <b>Noa</b>' in last_screen(ev)['body']['text'] and len(tg(ev, 'getChatMember')) == 1)
sql("DELETE FROM settings WHERE key IN ('group_chat_id', 'group_invite_link')", state='/tmp/lvtest/state2')

ans_all = [e for e in logs() if e.get('tg') == 'answerCallbackQuery']
ids = [e['body']['callback_query_id'] for e in ans_all]
check('every callback query answered exactly once (whole run)', len(ids) == len(set(ids)) and len(ids) == next(qid) - 1, (len(ids), len(set(ids))))

# ───── global: Bot API validation
viol = [e for e in logs() if 'violation' in e]
check('no Bot API spec violations in any request (tags, callback_data ≤64, one action/button, styles, lengths, no deprecated params)', not viol, viol[:3])
print('\nSUMMARY', sum(1 for _, ok in RESULTS if ok), '/', len(RESULTS))
