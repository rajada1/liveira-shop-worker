"""Fake OxaPay + fake Telegram Bot API (port 9911) with Bot API validation.
Telegram: stores messages per chat, returns real-looking message ids, and answers
'message is not modified' / 'message to edit not found' like the real API.
Every request is logged to /tmp/lvtest/fake.log; spec violations go to 'violation' entries."""
import json, time, itertools, re, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
LOG = open('/tmp/lvtest/fake.log', 'a'); LOCK = threading.Lock()
tid_counter = itertools.count(1000); mid_counter = itertools.count(100)
INVOICES, STATUS, MSGS = {}, {}, {}
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
    if method == 'answerCallbackQuery' and d.get('text') and len(d['text']) > 200: v.append('toast > 200')
    if method == 'setMyDescription' and len(d.get('description', '')) > 512: v.append('description > 512')
    if method == 'setMyShortDescription' and len(d.get('short_description', '')) > 120: v.append('short > 120')
    return v

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, obj, code=200):
        b = json.dumps(obj).encode(); self.send_response(code)
        self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
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
            log({'oxapay': 'invoice', 'key': self.headers.get('merchant_api_key'), 'body': d, 'track_id': tid})
            INVOICES[tid] = {'track_id': tid, 'amount': d['amount'], 'order_id': d.get('order_id'), 'type': 'invoice'}
            return self._send({'data': {'track_id': tid, 'payment_url': 'https://pay.oxapay.com/' + tid, 'expired_at': int(time.time()) + 3600, 'date': int(time.time())}, 'message': 'Operation completed successfully!', 'error': {}, 'status': 200, 'version': '1.0.0'})
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
                mid = next(mid_counter); MSGS[(str(d.get('chat_id')), mid)] = (d.get('text'), json.dumps(d.get('reply_markup'), sort_keys=True))
                entry['mid'] = mid; log(entry)
                return self._send({'ok': True, 'result': {'message_id': mid, 'chat': {'id': d.get('chat_id')}, 'text': d.get('text')}})
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
            return self._send({'ok': True, 'result': True if method != 'sendDocument' else {'message_id': next(mid_counter), 'document': {'file_id': 'FILEID'}}})
        self._send({'ok': False}, 404)

if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 9911), H).serve_forever()
