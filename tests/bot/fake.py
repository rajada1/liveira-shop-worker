"""Fake OxaPay + fake Binance Pay history API + fake NOWPayments (/np/v1) + fake Stripe (/stripe/v1) + fake Telegram Bot API (port 9911) with Bot API validation.
Telegram: stores messages per chat, returns real-looking message ids, and answers
'message is not modified' / 'message to edit not found' like the real API.
Every request is logged to /tmp/lvtest/fake.log; spec violations go to 'violation' entries."""
import json, time, itertools, re, threading, hmac, hashlib, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
LOG = open('/tmp/lvtest/fake.log', 'a'); LOCK = threading.Lock()
tid_counter = itertools.count(1000); mid_counter = itertools.count(100)
INVOICES, STATUS, MSGS = {}, {}, {}
FAIL_DELETE = set()  # (chat, mid) whose deleteMessage fails like a >48h-old message
SLOW_SEND = {}  # chat -> seconds to wait before answering sendMessage
ACCEPTED = ['USDT']
# Binance: GET /sapi/v1/pay/transactions (USER_DATA, HMAC-SHA256 over the query string, header X-MBX-APIKEY)
BN_KEY, BN_SECRET = 'bn_test_key', b'bn_test_secret'
BN_TXS = []; BN_MODE = {'status': 200, 'retry_after': None}
# NOWPayments: x-api-key; POST /np/v1/invoice, GET /np/v1/payment/{id}, /np/v1/min-amount, /np/v1/status
NP_KEY = 'np_test_key'; NP_INVOICES, NP_PAYS = {}, {}; NP_MODE = {'get': 200, 'invoice': 200}
NP_MIN = {'usdttrc20': 11.42, 'usdtbsc': 12.13, 'ltc': 12.0, 'trx': 12.3}
np_counter = itertools.count(5000000001)
NP_DOC = {'price_amount', 'price_currency', 'pay_currency', 'ipn_callback_url', 'order_id', 'order_description', 'success_url',
          'cancel_url', 'partially_paid_url', 'is_fixed_rate', 'is_fee_paid_by_user'}
# Stripe: Bearer key, form-encoded POSTs, Stripe-Version pinned; /stripe/v1/checkout/sessions, …/expire, /charges, /payment_intents
SP_KEY = 'sk_test_local_fake'; SP_SESS, SP_CHARGES, SP_PIS, SP_IDEM = {}, {}, {}, {}; SP_MODE = {'get': 200, 'create': 200}
sp_counter = itertools.count(1)
SP_DOC = {'mode', 'payment_method_types[0]', 'line_items[0][quantity]', 'line_items[0][price_data][currency]', 'line_items[0][price_data][unit_amount]',
          'line_items[0][price_data][product_data][name]', 'line_items[0][price_data][product_data][description]', 'client_reference_id',
          'metadata[topup_id]', 'metadata[telegram_user_id]', 'metadata[source]', 'payment_intent_data[metadata][topup_id]',
          'payment_intent_data[metadata][telegram_user_id]', 'payment_intent_data[metadata][source]', 'payment_intent_data[description]',
          'submit_type', 'success_url', 'cancel_url', 'expires_at'}
# Telegram groups: getChatMember / getChat; membership per (chat, user) — default 'left' (never joined)
GROUPS = {'-1001234567890': {'title': 'Liveira Test Group', 'type': 'supergroup'}, '-1009876543210': {'title': 'Liveira Test Group', 'type': 'supergroup'}}
MEMBERS = {}  # (chat, user) -> {'status': ..., 'is_member': ...}
TG_MODE = {'member': 'ok', 'groupsend': 'ok'}  # member: ok | 500 | notfound ; groupsend: ok | 403
MIGRATED = {}  # old chat id -> new chat id (basic group upgraded to supergroup)
ALLOWED_TAGS = {'b','strong','i','em','u','ins','s','strike','del','span','tg-spoiler','a','tg-emoji','tg-time','code','pre','blockquote'}
BTN_ACTIONS = {'url','callback_data','web_app','login_url','switch_inline_query','switch_inline_query_current_chat','switch_inline_query_chosen_chat','copy_text','callback_game','pay','disabled'}

def log(obj):
    with LOCK:
        LOG.write(json.dumps(obj) + '\n'); LOG.flush()

def validate(method, d):
    v = []
    text = d.get('text')
    if text is not None:
        if len(text) > 4096: v.append('text > 4096')
        if d.get('parse_mode') == 'HTML':
            stack = []
            for m in re.finditer(r'<(/?)([a-zA-Z-]+)([^>]*)>', text):
                close, tag = m.group(1), m.group(2).lower()
                if tag not in ALLOWED_TAGS: v.append('bad tag ' + tag); continue
                if close:
                    if not stack or stack[-1] != tag: v.append('unbalanced ' + tag)
                    else: stack.pop()
                else: stack.append(tag)
            if stack: v.append('unclosed ' + ','.join(stack))
            if re.search(r'&(?!(lt|gt|amp|quot|#\d+);)', text): v.append('raw &')
            plain = re.sub(r'<[^>]+>', '', text)
            if '<' in plain or '>' in plain: v.append('raw < or >')
    if 'disable_web_page_preview' in d: v.append('deprecated disable_web_page_preview')
    rm = d.get('reply_markup') or {}
    for row in rm.get('inline_keyboard', []):
        if len(row) > 8: v.append('row > 8 buttons')
        for b in row:
            acts = [k for k in b if k in BTN_ACTIONS]
            if len(acts) != 1: v.append('button actions %s' % acts)
            if 'callback_data' in b and not (1 <= len(b['callback_data'].encode()) <= 64): v.append('callback_data len ' + b['callback_data'])
            if 'style' in b and b['style'] not in ('danger', 'success', 'primary'): v.append('bad style ' + b['style'])
            if 'copy_text' in b and not (1 <= len(b['copy_text'].get('text', '')) <= 256): v.append('copy_text len')
            if not b.get('text'): v.append('empty button text')
    if 'keyboard' in rm:  # ReplyKeyboardMarkup (Bot API: keyboard, is_persistent, resize_keyboard, one_time_keyboard, input_field_placeholder, selective)
        if method != 'sendMessage': v.append('reply keyboard only allowed on send, not ' + method)
        for k in rm:
            if k not in ('keyboard', 'is_persistent', 'resize_keyboard', 'one_time_keyboard', 'input_field_placeholder', 'selective'): v.append('unknown ReplyKeyboardMarkup field ' + k)
        for k in ('is_persistent', 'resize_keyboard', 'one_time_keyboard', 'selective'):
            if k in rm and not isinstance(rm[k], bool): v.append(k + ' not bool')
        if 'input_field_placeholder' in rm and not (1 <= len(rm['input_field_placeholder']) <= 64): v.append('placeholder len')
        for row in rm['keyboard']:
            for b in row:
                if not isinstance(b, dict) or not b.get('text'): v.append('keyboard button without text')
                elif 'style' in b and b['style'] not in ('danger', 'success', 'primary'): v.append('bad keyboard style')
                elif set(b) - {'text', 'style', 'icon_custom_emoji_id'}: v.append('keyboard button not a plain text button')
    if method == 'editMessageText' and rm and 'inline_keyboard' not in rm: v.append('edit with non-inline markup')
    if method == 'deleteMessage' and not (d.get('chat_id') and isinstance(d.get('message_id'), int)): v.append('deleteMessage params')
    if method == 'answerCallbackQuery' and d.get('text') and len(d['text']) > 200: v.append('toast > 200')
    if method == 'setMyDescription' and len(d.get('description', '')) > 512: v.append('description > 512')
    if method == 'setMyShortDescription' and len(d.get('short_description', '')) > 120: v.append('short > 120')
    return v

class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'  # keep-alive like the real API (workerd pools connections)
    def log_message(self, *a): pass
    def _send(self, obj, code=200):
        b = json.dumps(obj).encode(); self.send_response(code)
        self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def binance(self):
        qs = self.path.split('?', 1)[1] if '?' in self.path else ''
        payload, _, sig = qs.rpartition('&signature=')
        params = dict(urllib.parse.parse_qsl(payload))
        want = hmac.new(BN_SECRET, payload.encode(), hashlib.sha256).hexdigest()
        ts = int(params.get('timestamp', '0') or 0)
        entry = {'binance': 'GET', 'params': params, 'sig': sig, 'sig_ok': bool(payload) and hmac.compare_digest(want, sig),
                 'sig_last': qs.rfind('signature=') > qs.rfind('timestamp='), 'key_ok': self.headers.get('X-MBX-APIKEY') == BN_KEY,
                 'ts_ok': abs(ts - time.time() * 1000) < 60000, 'mode': BN_MODE['status']}
        log(entry)
        st = BN_MODE['status']
        if st != 200:
            body = json.dumps({'code': -1003 if st in (418, 429) else 0, 'msg': 'fake error %d' % st}).encode()
            self.send_response(st); self.send_header('Content-Type', 'application/json')
            if BN_MODE.get('retry_after'): self.send_header('Retry-After', str(BN_MODE['retry_after']))
            self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body); return
        if not entry['key_ok']: return self._send({'code': -2015, 'msg': 'Invalid API-key, IP, or permissions for action.'}, 401)
        if not entry['sig_ok']: return self._send({'code': -1022, 'msg': 'Signature for this request is not valid.'}, 400)
        if not entry['ts_ok']: return self._send({'code': -1021, 'msg': 'Timestamp for this request is outside of the recvWindow.'}, 400)
        lo, hi = int(params.get('startTime', 0)), int(params.get('endTime', 10**15)); lim = min(int(params.get('limit', 100)), 100)
        data = sorted([t for t in BN_TXS if lo <= t['transactionTime'] <= hi], key=lambda t: -t['transactionTime'])[:lim]
        return self._send({'code': '000000', 'message': 'success', 'data': data, 'success': True})
    def np_get(self):
        path, _, q = self.path.partition('?'); params = dict(urllib.parse.parse_qsl(q))
        log({'np': 'GET', 'path': path, 'params': params, 'key_ok': self.headers.get('x-api-key') == NP_KEY})
        if self.headers.get('x-api-key') != NP_KEY: return self._send({'statusCode': 403, 'code': 'INVALID_API_KEY', 'message': 'Invalid api key'}, 403)
        if path == '/np/v1/status': return self._send({'message': 'OK'})
        if path == '/np/v1/min-amount':
            c = params.get('currency_from', '')
            return self._send({'currency_from': c, 'currency_to': 'false', 'min_amount': 1.0, 'fiat_equivalent': NP_MIN.get(c, 11.0)})
        if path.startswith('/np/v1/payment/'):
            if NP_MODE['get'] != 200: return self._send({'statusCode': NP_MODE['get'], 'message': 'fake error'}, NP_MODE['get'])
            pid = path.rsplit('/', 1)[1]
            if pid not in NP_PAYS: return self._send({'statusCode': 404, 'code': 'PAYMENT_NOT_FOUND', 'message': 'Payment not found'}, 404)
            return self._send(NP_PAYS[pid])
        return self._send({'statusCode': 404, 'message': 'not found'}, 404)
    def sp_err(self, code, typ, msg, ecode=None, param=None):
        return self._send({'error': {'type': typ, 'code': ecode, 'message': msg, 'param': param}}, code)
    def sp_auth(self, method, path, form=None):
        entry = {'sp': method, 'path': path.split('?')[0], 'query': path.partition('?')[2], 'key_ok': self.headers.get('Authorization') == 'Bearer ' + SP_KEY,
                 'version': self.headers.get('Stripe-Version'), 'idem': self.headers.get('Idempotency-Key'), 'form': form,
                 'ctype': self.headers.get('Content-Type')}
        log(entry); return entry['key_ok']
    def sp_get(self):
        path, _, q = self.path.partition('?')
        if not self.sp_auth('GET', self.path): return self.sp_err(401, 'invalid_request_error', 'Invalid API Key provided')
        if path == '/stripe/v1/account':
            return self._send({'id': 'acct_fake', 'object': 'account', 'country': 'BR', 'default_currency': 'brl', 'charges_enabled': True, 'payouts_enabled': True,
                               'capabilities': {'card_payments': 'active'}, 'settings': {'payments': {'statement_descriptor': 'LIVEIRA TEST'}}})
        if path.startswith('/stripe/v1/webhook_endpoints/'):
            wid = path.rsplit('/', 1)[1]
            if wid != 'we_fake123456': return self.sp_err(404, 'invalid_request_error', 'No such webhook endpoint', 'resource_missing')
            return self._send({'id': wid, 'object': 'webhook_endpoint', 'url': 'https://liveira-shop.kelumayou.workers.dev/stripe/webhook', 'status': 'enabled', 'api_version': '2024-06-20',
                               'enabled_events': ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
                                                  'checkout.session.expired', 'charge.refunded', 'charge.dispute.created']})
        if path.startswith('/stripe/v1/checkout/sessions/'):
            if SP_MODE['get'] != 200: return self.sp_err(SP_MODE['get'], 'api_error', 'fake error')
            sid = path.rsplit('/', 1)[1]; ss = SP_SESS.get(sid)
            if not ss: return self.sp_err(404, 'invalid_request_error', 'No such checkout.session', 'resource_missing')
            out = dict(ss)
            if 'expand[]=payment_intent' in urllib.parse.unquote(q) and ss.get('payment_intent'): out['payment_intent'] = SP_PIS.get(ss['payment_intent'])
            return self._send(out)
        if path.startswith('/stripe/v1/charges/'):
            ch = SP_CHARGES.get(path.rsplit('/', 1)[1])
            return self._send(ch) if ch else self.sp_err(404, 'invalid_request_error', 'No such charge', 'resource_missing')
        if path.startswith('/stripe/v1/payment_intents/'):
            pi = SP_PIS.get(path.rsplit('/', 1)[1])
            return self._send(pi) if pi else self.sp_err(404, 'invalid_request_error', 'No such payment_intent', 'resource_missing')
        return self.sp_err(404, 'invalid_request_error', 'Unrecognized request URL')
    def sp_post(self, body):
        form = dict(urllib.parse.parse_qsl(body, keep_blank_values=True))
        if not self.sp_auth('POST', self.path, form): return self.sp_err(401, 'invalid_request_error', 'Invalid API Key provided')
        if self.path == '/stripe/v1/checkout/sessions':
            for k in form:
                if k not in SP_DOC: log({'violation': ['unexpected Stripe checkout param ' + k], 'method': 'stripe session', 'body': form})
            if self.headers.get('Content-Type') != 'application/x-www-form-urlencoded': log({'violation': ['stripe content-type'], 'method': 'stripe session'})
            idem = self.headers.get('Idempotency-Key')
            if idem and idem in SP_IDEM: return self._send(SP_SESS[SP_IDEM[idem]])
            if SP_MODE['create'] != 200: return self.sp_err(SP_MODE['create'], 'invalid_request_error', 'fake create error', 'parameter_invalid', 'line_items[0][price_data][currency]')
            n = next(sp_counter); sid = 'cs_test_a1Fake%06dSessionXYZ' % n
            amt = int(form['line_items[0][price_data][unit_amount]']) * int(form.get('line_items[0][quantity]', 1))
            meta = {k[9:-1]: v for k, v in form.items() if k.startswith('metadata[')}
            ss = {'id': sid, 'object': 'checkout.session', 'url': 'https://checkout.stripe.com/c/pay/' + sid + '#fidkdWxOYHwnPyd1blpxYHZxWjA0', 'amount_total': amt,
                  'currency': form.get('line_items[0][price_data][currency]'), 'status': 'open', 'payment_status': 'unpaid', 'client_reference_id': form.get('client_reference_id'),
                  'metadata': meta, 'expires_at': int(form.get('expires_at', 0)), 'payment_intent': None, 'mode': form.get('mode'), 'livemode': False}
            SP_SESS[sid] = ss
            if idem: SP_IDEM[idem] = sid
            return self._send(ss)
        if self.path.startswith('/stripe/v1/checkout/sessions/') and self.path.endswith('/expire'):
            sid = self.path.split('/')[5]; ss = SP_SESS.get(sid)
            if not ss: return self.sp_err(404, 'invalid_request_error', 'No such checkout.session', 'resource_missing')
            if ss['status'] != 'open': return self.sp_err(400, 'invalid_request_error', 'Only Checkout Sessions with a status in ["open"] can be expired.')
            ss['status'] = 'expired'; return self._send(ss)
        return self.sp_err(404, 'invalid_request_error', 'Unrecognized request URL')
    def do_GET(self):
        if self.path.startswith('/stripe/v1/'): return self.sp_get()
        if self.path.startswith('/np/v1/'): return self.np_get()
        if self.path.startswith('/sapi/v1/pay/transactions'): return self.binance()
        if self.path == '/v1/payment/accepted-currencies':
            log({'oxapay': 'accepted', 'key': self.headers.get('merchant_api_key')})
            return self._send({'data': {'list': ACCEPTED}, 'message': 'Operation completed successfully!', 'error': {}, 'status': 200, 'version': '1.0.0'})
        if self.path == '/v1/common/currencies':
            nets = {'Tron': {'network': 'Tron', 'name': 'Tron Network', 'keys': ['Tron', 'TRC20', 'TRX']},
                    'BSC': {'network': 'BSC', 'name': 'Binance Smart Chain', 'keys': ['BSC', 'BEP20', 'BNB']},
                    'The Open Network': {'network': 'The Open Network', 'name': 'TON Network', 'keys': ['TON']}}
            return self._send({'data': {'USDT': {'symbol': 'USDT', 'name': 'Tether', 'status': True, 'networks': nets},
                                        'BTC': {'symbol': 'BTC', 'name': 'Bitcoin', 'status': True, 'networks': {'Bitcoin': {'network': 'Bitcoin', 'name': 'Bitcoin Network', 'keys': ['BTC']}}}},
                               'message': 'ok', 'error': {}, 'status': 200, 'version': '1.0.0'})
        if self.path.startswith('/v1/payment/'):
            tid = self.path.rsplit('/', 1)[1]; inv = INVOICES.get(tid)
            log({'oxapay': 'GET', 'track_id': tid, 'key': self.headers.get('merchant_api_key')})
            if not inv: return self._send({'data': {}, 'message': 'not found', 'status': 404}, 400)
            return self._send({'data': {**inv, 'status': STATUS.get(tid, 'Waiting')}, 'message': 'ok', 'status': 200, 'version': '1.0.0'})
        self._send({'ok': False}, 404)
    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0); body = self.rfile.read(n).decode(errors='replace') if n else ''
        if self.path.startswith('/stripe/v1/'): return self.sp_post(body)
        if self.path.startswith('/_sp/pay/'):  # mark a session paid: complete/paid + PaymentIntent + Charge
            sid = self.path.split('/')[3]; ss = SP_SESS[sid]; o = json.loads(body) if body else {}
            pi, ch = 'pi_fake' + sid[-14:], 'ch_fake' + sid[-14:]
            ss.update({'status': o.get('status', 'complete'), 'payment_status': o.get('payment_status', 'paid'), 'payment_intent': pi})
            for k in ('amount_total', 'currency'):
                if k in o: ss[k] = o[k]
            SP_PIS[pi] = {'id': pi, 'object': 'payment_intent', 'latest_charge': ch, 'metadata': ss.get('metadata', {}), 'amount': ss['amount_total'], 'currency': ss['currency']}
            SP_CHARGES.setdefault(ch, {'id': ch, 'object': 'charge', 'payment_intent': pi, 'amount': ss['amount_total'], 'amount_refunded': 0, 'refunded': False, 'currency': ss['currency']})
            return self._send({'ok': True, 'payment_intent': pi, 'charge': ch})
        if self.path.startswith('/_sp/session/'):
            sid = self.path.split('/')[3]; SP_SESS[sid].update(json.loads(body)); return self._send({'ok': True})
        if self.path.startswith('/_sp/charge/'):
            ch = self.path.split('/')[3]; SP_CHARGES.setdefault(ch, {'id': ch, 'object': 'charge'}).update(json.loads(body)); return self._send({'ok': True})
        if self.path.startswith('/_sp/pi/'):
            pi = self.path.split('/')[3]; SP_PIS.setdefault(pi, {'id': pi, 'object': 'payment_intent'}).update(json.loads(body)); return self._send({'ok': True})
        if self.path.startswith('/_sp/mode/'):
            _, _, _, k, st = self.path.split('/'); SP_MODE[k] = int(st); return self._send({'ok': True})
        if self.path == '/np/v1/invoice':
            d = json.loads(body); iid = str(next(np_counter))
            for k in d:
                if k not in NP_DOC: log({'violation': ['undocumented NOWPayments invoice field ' + k], 'method': 'np invoice', 'body': d})
            log({'np': 'invoice', 'key_ok': self.headers.get('x-api-key') == NP_KEY, 'body': d, 'invoice_id': iid})
            if self.headers.get('x-api-key') != NP_KEY: return self._send({'statusCode': 403, 'code': 'INVALID_API_KEY', 'message': 'Invalid api key'}, 403)
            if NP_MODE['invoice'] != 200: return self._send({'statusCode': NP_MODE['invoice'], 'message': 'fake error'}, NP_MODE['invoice'])
            if not isinstance(d.get('price_amount'), (int, float)) or d.get('price_currency') != 'usd':
                return self._send({'statusCode': 400, 'code': 'INVALID_REQUEST_PARAMS', 'message': 'bad price'}, 400)
            NP_INVOICES[iid] = d
            return self._send({'id': iid, 'token_id': 'tok' + iid, 'order_id': d.get('order_id'), 'order_description': d.get('order_description'),
                               'price_amount': str(d['price_amount']), 'price_currency': 'usd', 'pay_currency': None, 'ipn_callback_url': d.get('ipn_callback_url'),
                               'invoice_url': 'https://nowpayments.io/payment/?iid=' + iid, 'success_url': d.get('success_url'), 'cancel_url': d.get('cancel_url'),
                               'created_at': '2026-10-04T10:00:00.000Z', 'updated_at': '2026-10-04T10:00:00.000Z', 'is_fixed_rate': False, 'is_fee_paid_by_user': False})
        if self.path == '/_np/pay':
            o = json.loads(body); NP_PAYS[str(o['payment_id'])] = o; return self._send({'ok': True})
        if self.path.startswith('/_np/mode/'):
            _, _, _, k, st = self.path.split('/'); NP_MODE[k] = int(st); return self._send({'ok': True})
        if self.path == '/v1/payment/invoice':
            d = json.loads(body); tid = str(next(tid_counter))
            # Documented v1 generate-invoice fields only (docs.oxapay.com/api-reference/payment/generate-invoice)
            DOC = {'amount', 'currency', 'lifetime', 'fee_paid_by_payer', 'under_paid_coverage', 'to_currency', 'auto_withdrawal',
                   'mixed_payment', 'callback_url', 'return_url', 'email', 'order_id', 'thanks_message', 'description', 'sandbox'}
            for k in d:
                if k not in DOC: log({'violation': ['undocumented OxaPay invoice field ' + k], 'method': 'oxapay invoice', 'body': d})
            log({'oxapay': 'invoice', 'key': self.headers.get('merchant_api_key'), 'body': d, 'track_id': tid})
            INVOICES[tid] = {'track_id': tid, 'amount': d['amount'], 'order_id': d.get('order_id'), 'type': 'invoice'}
            return self._send({'data': {'track_id': tid, 'payment_url': 'https://pay.oxapay.com/' + tid, 'expired_at': int(time.time()) + 3600, 'date': int(time.time())}, 'message': 'Operation completed successfully!', 'error': {}, 'status': 200, 'version': '1.0.0'})
        if self.path == '/_nextid' or self.path.startswith('/_nextid/'):  # incoming user messages share the chat's id sequence
            mid = next(mid_counter)
            if self.path.startswith('/_nextid/'): MSGS[(self.path.split('/')[2], mid)] = ('<user message>', 'null')  # deletable by the bot
            return self._send({'mid': mid})
        if self.path.startswith('/_slowsend/'):  # delay sendMessage to a chat (ms; 0 = off) to force concurrent requests to overlap
            _, _, chat, ms = self.path.split('/'); SLOW_SEND[chat] = int(ms) / 1000; return self._send({'ok': True})
        if self.path.startswith('/_faildelete/'):
            _, _, chat, mid = self.path.split('/'); FAIL_DELETE.add((chat, int(mid))); return self._send({'ok': True})
        if self.path.startswith('/_accepted/'):
            ACCEPTED[:] = [x for x in self.path.split('/')[2].split(',') if x]; return self._send({'ok': True})
        if self.path == '/_bn/tx':
            BN_TXS.append(json.loads(body)); return self._send({'ok': True})
        if self.path.startswith('/_bn/mode/'):
            parts = self.path.split('/'); BN_MODE['status'] = int(parts[3]); BN_MODE['retry_after'] = int(parts[4]) if len(parts) > 4 else None
            return self._send({'ok': True})
        if self.path.startswith('/_tg/member/'):  # /_tg/member/<chat>/<user>/<status>[/<is_member 0|1>]
            parts = self.path.split('/'); m = {'status': parts[5]}
            if len(parts) > 6: m['is_member'] = parts[6] == '1'
            MEMBERS[(parts[3], parts[4])] = m; return self._send({'ok': True})
        if self.path.startswith('/_tg/mode/'):
            _, _, _, k, v = self.path.split('/'); TG_MODE[k] = v; return self._send({'ok': True})
        if self.path.startswith('/_tg/migrate/'):
            _, _, _, old, new = self.path.split('/')
            if new == '0': MIGRATED.pop(old, None)
            else: MIGRATED[old] = int(new)
            return self._send({'ok': True})
        if self.path.startswith('/_status/'):
            _, _, tid, st = self.path.split('/'); STATUS[tid] = st; return self._send({'ok': True})
        if self.path.startswith('/bot'):
            method = self.path.rsplit('/', 1)[1]
            try: d = json.loads(body)
            except Exception: d = {'raw': body[:200]}
            viol = validate(method, d)
            entry = {'tg': method, 'body': d}
            if viol: log({'violation': viol, 'method': method, 'body': d})
            if method == 'getMe':
                log(entry); return self._send({'ok': True, 'result': {'id': 1, 'is_bot': True, 'username': 'liveira_test_bot'}})
            cid = str(d.get('chat_id', ''))
            if cid in MIGRATED and method in ('sendMessage', 'getChatMember', 'getChat'):
                entry['error'] = 'migrated'; log(entry)
                return self._send({'ok': False, 'error_code': 400, 'description': 'Bad Request: group chat was upgraded to a supergroup chat', 'parameters': {'migrate_to_chat_id': MIGRATED[cid]}}, 400)
            if method == 'getChatMember':
                if not isinstance(d.get('user_id'), int): log({'violation': ['getChatMember user_id not int'], 'method': method, 'body': d})
                if TG_MODE['member'] == '500':
                    entry['error'] = '500'; log(entry); return self._send({'ok': False, 'error_code': 500, 'description': 'Internal Server Error'}, 500)
                if cid not in GROUPS:
                    entry['error'] = 'chat not found'; log(entry); return self._send({'ok': False, 'error_code': 400, 'description': 'Bad Request: chat not found'}, 400)
                if d.get('user_id') == 123:  # the bot itself (BOT_TOKEN=123:fake): admin
                    log(entry); return self._send({'ok': True, 'result': {'user': {'id': 123, 'is_bot': True}, 'status': 'administrator', 'can_invite_users': True, 'can_delete_messages': True}})
                if TG_MODE['member'] == 'notfound' and (cid, str(d.get('user_id'))) not in MEMBERS:
                    entry['error'] = 'not found'; log(entry); return self._send({'ok': False, 'error_code': 400, 'description': 'Bad Request: PARTICIPANT_ID_INVALID'}, 400)
                m = MEMBERS.get((cid, str(d.get('user_id'))), {'status': 'left'})
                log(entry); return self._send({'ok': True, 'result': {'user': {'id': d.get('user_id'), 'is_bot': False, 'first_name': 'x'}, **m}})
            if method == 'getChat':
                if cid not in GROUPS:
                    entry['error'] = 'chat not found'; log(entry); return self._send({'ok': False, 'error_code': 400, 'description': 'Bad Request: chat not found'}, 400)
                log(entry); return self._send({'ok': True, 'result': {'id': int(cid), **GROUPS[cid]}})
            if method == 'sendMessage' and cid.startswith('-'):
                if TG_MODE['groupsend'] == '403':
                    entry['error'] = 'kicked'; log(entry)
                    return self._send({'ok': False, 'error_code': 403, 'description': 'Forbidden: bot was kicked from the supergroup chat'}, 403)
                mid = next(mid_counter); entry['mid'] = mid; log(entry)
                return self._send({'ok': True, 'result': {'message_id': mid, 'chat': {'id': d.get('chat_id'), 'type': 'supergroup'}, 'text': d.get('text')}})
            if method == 'sendMessage':
                if SLOW_SEND.get(str(d.get('chat_id'))): time.sleep(SLOW_SEND[str(d.get('chat_id'))])
                mid = next(mid_counter); MSGS[(str(d.get('chat_id')), mid)] = (d.get('text'), json.dumps(d.get('reply_markup'), sort_keys=True))
                entry['mid'] = mid; log(entry)
                return self._send({'ok': True, 'result': {'message_id': mid, 'chat': {'id': d.get('chat_id'), 'type': 'private'}, 'text': d.get('text')}})
            if method == 'deleteMessage':
                key = (str(d.get('chat_id')), d.get('message_id'))
                if key in FAIL_DELETE:
                    entry['error'] = 'cant delete'; log(entry)
                    return self._send({'ok': False, 'error_code': 400, 'description': "Bad Request: message can't be deleted"}, 400)
                if key not in MSGS:
                    entry['error'] = 'not found'; log(entry)
                    return self._send({'ok': False, 'error_code': 400, 'description': 'Bad Request: message to delete not found'}, 400)
                del MSGS[key]; log(entry)
                return self._send({'ok': True, 'result': True})
            if method == 'editMessageText':
                key = (str(d.get('chat_id')), d.get('message_id'))
                new = (d.get('text'), json.dumps(d.get('reply_markup'), sort_keys=True))
                if key not in MSGS:
                    entry['error'] = 'not found'; log(entry)
                    return self._send({'ok': False, 'error_code': 400, 'description': 'Bad Request: message to edit not found'}, 400)
                if MSGS[key] == new:
                    entry['error'] = 'not modified'; log(entry)
                    return self._send({'ok': False, 'error_code': 400, 'description': 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message'}, 400)
                MSGS[key] = new; entry['mid'] = d.get('message_id'); log(entry)
                return self._send({'ok': True, 'result': {'message_id': d.get('message_id'), 'text': d.get('text')}})
            log(entry)
            if method == 'sendDocument':
                mid = next(mid_counter); entry['mid'] = mid; log(entry)
                return self._send({'ok': True, 'result': {'message_id': mid, 'chat': {'id': d.get('chat_id'), 'type': 'private'}, 'document': {'file_id': 'FILEID'}}})
            return self._send({'ok': True, 'result': True})
        self._send({'ok': False}, 404)

if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 9911), H).serve_forever()
