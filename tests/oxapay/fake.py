import json, sys, time, itertools
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
LOG=open('/tmp/lvtest/fake.log','a')
cnt=itertools.count(1000)
INVOICES={}
STATUS={}  # track_id -> status for GET
class H(BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def _send(self,obj,code=200):
        b=json.dumps(obj).encode(); self.send_response(code); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path.startswith('/v1/payment/'):
            tid=self.path.rsplit('/',1)[1]
            inv=INVOICES.get(tid)
            LOG.write(json.dumps({'oxapay':'GET','track_id':tid,'key':self.headers.get('merchant_api_key')})+'\n'); LOG.flush()
            if not inv: return self._send({'data':{},'message':'not found','status':404},400)
            return self._send({'data':{**inv,'status':STATUS.get(tid,'Waiting')},'message':'ok','status':200,'version':'1.0.0'})
        if self.path=='/_set':
            pass
        self._send({'ok':False},404)
    def do_POST(self):
        n=int(self.headers.get('Content-Length') or 0); body=self.rfile.read(n).decode() if n else ''
        if self.path=='/v1/payment/invoice':
            d=json.loads(body); tid=str(next(cnt))
            LOG.write(json.dumps({'oxapay':'invoice','key':self.headers.get('merchant_api_key'),'body':d,'track_id':tid})+'\n'); LOG.flush()
            INVOICES[tid]={'track_id':tid,'amount':d['amount'],'order_id':d.get('order_id'),'type':'invoice'}
            return self._send({'data':{'track_id':tid,'payment_url':'https://pay.oxapay.com/'+tid,'expired_at':int(time.time())+3600,'date':int(time.time())},'message':'Operation completed successfully!','error':{},'status':200,'version':'1.0.0'})
        if self.path.startswith('/_status/'):
            _,_,tid,st=self.path.split('/'); STATUS[tid]=st; return self._send({'ok':True})
        if self.path.startswith('/bot'):
            method=self.path.rsplit('/',1)[1]
            try: d=json.loads(body)
            except Exception: d={'raw':body[:200]}
            LOG.write(json.dumps({'tg':method,'body':d})+'\n'); LOG.flush()
            if method=='getMe': return self._send({'ok':True,'result':{'id':1,'is_bot':True,'username':'liveira_test_bot'}})
            return self._send({'ok':True,'result':{'message_id':1}})
        self._send({'ok':False},404)
ThreadingHTTPServer(('127.0.0.1',9911),H).serve_forever()
