"""Operator-only adversarial store tests; no untrusted pickle is loaded."""
import unittest,runpy,pathlib,sys,tempfile,subprocess,json,hashlib,os
SERVER=pathlib.Path(__file__).resolve().parents[4]/'tools/developer-mcp-qdrant/server.py'
api=runpy.run_path(str(SERVER))
class Bounds(unittest.TestCase):
 def setUp(self):
  self.home=pathlib.Path(tempfile.mkdtemp(prefix='mcp-qdrant-'))
  r=subprocess.run([sys.executable,'-I',str(SERVER.with_name('seed.py')),str(self.home)],capture_output=True,text=True,check=True)
  self.seal=json.loads(r.stdout)['seal']
 def tearDown(self):
  import shutil;shutil.rmtree(self.home)
 def reseal(self):
  m=self.home/'fixture-seal.json';d=json.loads(m.read_text());d['files']={p.relative_to(self.home/'store').as_posix():api['digest'](p) for p in (self.home/'store').rglob('*') if p.is_file()};m.write_text(json.dumps(d));self.seal=api['digest'](m)
 def test_process_environment_and_network_guard(self):
  code="import runpy,sys,os,socket,json;api=runpy.run_path(sys.argv[1]);api['isolate'](api['Path'](sys.argv[2]));assert 'QDRANT_API_KEY' not in os.environ;assert 'HTTPS_PROXY' not in os.environ;assert os.environ['HOME']==sys.argv[2];s=socket.socket();s.connect(('192.0.2.1',9))"
  r=subprocess.run([sys.executable,'-I','-c',code,str(SERVER),str(self.home)],env={**os.environ,'QDRANT_API_KEY':'synthetic-canary','HTTPS_PROXY':'https://outside.invalid'},capture_output=True,text=True)
  self.assertNotEqual(r.returncode,0);self.assertIn('network refused',r.stderr);self.assertNotIn('synthetic-canary',r.stderr)
 def test_junction_store_refused_before_import(self):
  store=self.home/'store';actual=self.home/'actual-store';store.rename(actual)
  subprocess.run(['cmd.exe','/c','mklink','/J',str(store),str(actual)],check=True,capture_output=True)
  try:
   with self.assertRaises(ValueError):api['preflight'](self.home,self.seal)
  finally:os.rmdir(store);actual.rename(store)
 def test_seed_junction_home_refused_before_import(self):
  actual=self.home/'mcp-qdrant-target';actual.mkdir();alias=self.home/'mcp-qdrant-alias'
  subprocess.run(['cmd.exe','/c','mklink','/J',str(alias),str(actual)],check=True,capture_output=True)
  try:
   r=subprocess.run([sys.executable,'-I',str(SERVER.with_name('seed.py')),str(alias)],capture_output=True,text=True)
   self.assertNotEqual(r.returncode,0);self.assertEqual(list(actual.iterdir()),[])
  finally:os.rmdir(alias)
 def test_tamper_before_qdrant_import(self):
  (self.home/'store/collection/owned-vectors/storage.sqlite').write_bytes(b'not a trusted pickle')
  with self.assertRaises(ValueError):api['preflight'](self.home,self.seal)
  self.assertNotIn('qdrant_client',sys.modules)
 def test_unlisted_file_refused(self):
  (self.home/'store/extra').write_text('outside')
  with self.assertRaises(ValueError):api['preflight'](self.home,self.seal)
 def test_hardlink_refused_even_with_operator_hash(self):
  p=self.home/'store/meta.json';os.link(p,self.home/'linked-meta')
  try:
   with self.assertRaises(ValueError):api['preflight'](self.home,self.seal)
  finally:(self.home/'linked-meta').unlink()
 def test_unapproved_collection_before_engine_import(self):
  p=self.home/'store/meta.json';d=json.loads(p.read_text());d['collections']['../foreign']=d['collections']['owned-vectors'];p.write_text(json.dumps(d));self.reseal()
  with self.assertRaises(ValueError):api['preflight'](self.home,self.seal)
 def test_dimension_before_engine_import(self):
  p=self.home/'store/meta.json';d=json.loads(p.read_text());d['collections']['owned-vectors']['vectors']['size']=4;p.write_text(json.dumps(d));self.reseal()
  with self.assertRaises(ValueError):api['preflight'](self.home,self.seal)
 def test_point_count_before_engine_import(self):
  import sqlite3
  p=self.home/'store/collection/owned-vectors/storage.sqlite';c=sqlite3.connect(p)
  blob=c.execute('select point from points limit 1').fetchone()[0]
  c.executemany('insert into points values (?,?)',[(str(i),blob) for i in range(130)]);c.commit();c.close();self.reseal()
  with self.assertRaises(ValueError):api['preflight'](self.home,self.seal)
 def test_oversized_real_payload_refused(self):
  script="from qdrant_client.local.qdrant_local import QdrantLocal;from qdrant_client import models;import sys;c=QdrantLocal(sys.argv[1]);c.upsert('owned-vectors',[models.PointStruct(id=1,vector=[1.,0.,0.],payload={'label':'x'*4096})]);c.close()"
  subprocess.run([sys.executable,'-I','-c',script,str(self.home/'store')],check=True,capture_output=True);self.reseal()
  messages=[{'id':1,'method':'initialize'},{'method':'notifications/initialized'},{'id':2,'method':'tools/call','params':{'name':'qdrant-local-search','arguments':{'collection':'owned-vectors','vector':[1,0,0],'limit':1}}}]
  r=subprocess.run([sys.executable,'-I',str(SERVER),str(self.home),self.seal],input=''.join(json.dumps(m)+'\n' for m in messages),text=True,capture_output=True,check=True)
  response=json.loads(r.stdout.splitlines()[-1]);self.assertIn('error',response);self.assertNotIn('x'*100,r.stdout)
if __name__=='__main__':unittest.main()
