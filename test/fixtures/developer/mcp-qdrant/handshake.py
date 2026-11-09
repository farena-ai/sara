"""Bounded fixture handshake subset; no claim of complete MCP conformance."""
import unittest,json,subprocess,sys
import boundaries
SERVER,api=boundaries.SERVER,boundaries.api

class Handshake(unittest.TestCase):
 setUp=boundaries.Bounds.setUp
 tearDown=boundaries.Bounds.tearDown
 def rpc(self,messages):
  before={p.relative_to(self.home/'store').as_posix():api['digest'](p) for p in (self.home/'store').rglob('*') if p.is_file()}
  code="import runpy,sys; a=runpy.run_path(sys.argv[1]); a['serve'](a['Path'](sys.argv[2]),sys.argv[3]); assert not any(n=='qdrant_client' or n.startswith('qdrant_client.') for n in sys.modules), 'handshake imported engine'"
  r=subprocess.run([sys.executable,'-I','-B','-c',code,str(SERVER),str(self.home),self.seal],input=''.join(json.dumps(m)+'\n' for m in messages),text=True,capture_output=True,timeout=20)
  self.assertEqual(r.returncode,0,r.stderr)
  self.assertEqual(before,{p.relative_to(self.home/'store').as_posix():api['digest'](p) for p in (self.home/'store').rglob('*') if p.is_file()})
  return [json.loads(s) for s in r.stdout.splitlines()]
 def test_malformed_initialized_never_advances_state_and_valid_notification_recovers(self):
  bad=[[],None,True,1,'invalid',{'unexpected':True},{'_meta':[]},{'_meta':False}]
  messages=[{'method':'notifications/initialized','params':p} for p in bad]
  messages.extend([{'method':'notifications/initialized'},req(1,'tools/list'),req(2,'initialize')])
  for i,p in enumerate(bad):messages.extend([{'method':'notifications/initialized','params':p},req(10+i,'tools/list')])
  messages.extend([{'method':'notifications/unknown'},req(30,'tools/list'),{'method':'notifications/initialized','params':{'_meta':{'trace':'normal'}}},req(31,'tools/list')])
  for p in bad:messages.extend([{'method':'notifications/initialized','params':p},req(40+len(messages),'tools/list')])
  results={r['id']:r for r in self.rpc(messages) if r['id'] is not None}
  self.assertIn('error',results[1]);self.assertIn('result',results[2])
  for i in [*range(10,18),30]:self.assertIn('error',results[i])
  self.assertIn('result',results[31])
  for i,r in results.items():
   if i>=40:self.assertIn('result',r)

 def test_initialize_controls_refuse_before_handshake_and_normal_client_recovers(self):
  bad=[{'unexpected':'ignored-private-canary'},{'protocolVersion':1},{'protocolVersion':''},{'protocolVersion':'x'*65},{'capabilities':[]},{'capabilities':{'roots':True}},{'capabilities':{'roots':{'listChanged':'yes'}}},{'capabilities':{'roots':{'unexpected':True}}},{'capabilities':{'sampling':True}},{'capabilities':{'elicitation':[]}},{'capabilities':{'experimental':{'feature':True}}},{'capabilities':{'unexpected':{}}},{'clientInfo':[]},{'clientInfo':{'name':'normal'}},{'clientInfo':{'name':True,'version':'1'}},{'clientInfo':{'name':'n','version':1}},{'clientInfo':{'name':'n','version':'1','title':False}},{'clientInfo':{'name':'n'*129,'version':'1'}},{'_meta':[]},{'_meta':{'progressToken':True}},{'_meta':{'progressToken':[]}}]
  messages=[]
  for i,p in enumerate(bad):messages.extend([req(100+i,'initialize',p),{'method':'notifications/initialized'},req(200+i,'tools/list')])
  normal={'protocolVersion':'2025-06-18','capabilities':{'roots':{'listChanged':True},'sampling':{},'elicitation':{},'experimental':{'owned-feature':{}}},'clientInfo':{'name':'normal MCP client','version':'1.0','title':'Normal client'},'_meta':{'progressToken':'init-1','owned-trace':{'value':1}}}
  messages.extend([req(300,'initialize',normal),{'method':'notifications/initialized','params':{}},req(301,'tools/list'),req(302,'initialize',normal),req(303,'tools/list')])
  results={r['id']:r for r in self.rpc(messages) if r['id'] is not None}
  for i in range(len(bad)):
   self.assertIn('error',results[100+i],str(bad[i]));self.assertIn('error',results[200+i])
  for i in [300,301,303]:self.assertIn('result',results[i])
  self.assertIn('error',results[302])

def req(i,method,params=None):
 return {'jsonrpc':'2.0','id':i,'method':method,'params':{} if params is None else params}
if __name__=='__main__':unittest.main()
