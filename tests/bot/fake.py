"""Fake OxaPay + fake Binance Pay history API + fake Telegram Bot API (port 9911) with Bot API validation.
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
    def do_GET(self):
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
