# SPDX-License-Identifier: MIT
"""Owned fixture adapter, NOT the official mcp-server-qdrant implementation."""
import sys,json,math,hashlib,os
from pathlib import Path

TOOL={"name":"qdrant-local-search","description":"Search operator-seeded synthetic local vectors only. Numeric vectors; no embeddings or remote service.","inputSchema":{"type":"object","additionalProperties":False,"required":["collection","vector","limit"],"properties":{"collection":{"type":"string","enum":["owned-vectors"]},"vector":{"type":"array","minItems":3,"maxItems":3,"items":{"type":"number","minimum":-1000,"maximum":1000}},"limit":{"type":"integer","minimum":1,"maximum":5}}},"annotations":{"readOnlyHint":True,"destructiveHint":False}}
def encoded(x):return json.dumps(x,ensure_ascii=True,allow_nan=False,separators=(',',':'))
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def checked(p):
    s=p.lstat()
    if p.is_symlink() or getattr(s,'st_file_attributes',0)&0x400 or (p.is_file() and s.st_nlink!=1):raise ValueError('linked path refused')
    return s

def strict_json(text):
    def pairs(values):
        d={}
        for k,v in values:
            if k in d:raise ValueError('duplicate member refused')
            d[k]=v
        return d
    return json.loads(text,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('nonfinite JSON refused')))

def preflight(home,seal):
    import sqlite3,re
    if not home.is_absolute() or '..' in home.parts or not home.name.startswith('mcp-qdrant-'):raise ValueError('dedicated absolute home required')
    for p in [*reversed(home.parents),home]:checked(p)
    if not re.fullmatch('[0-9a-f]{64}',seal):raise ValueError('seal format refused')
    manifest=home/'fixture-seal.json'
    if checked(manifest).st_size>16384 or digest(manifest)!=seal:raise ValueError('fixture seal refused')
    data=strict_json(manifest.read_text())
    if set(data)!={'version','collection','dimension','points','sourceSha256','files'} or data['version']!=1 or data['collection']!='owned-vectors' or data['dimension']!=3 or type(data['points']) is not int or not 1<=data['points']<=128:raise ValueError('manifest bounds refused')
    expected={'meta.json','.lock','collection/owned-vectors/storage.sqlite'}
    if type(data['files']) is not dict or set(data['files'])!=expected:raise ValueError('manifest paths refused')
    store=home/'store';checked(store)
    dirs={'collection','collection/owned-vectors'};seen=set();total=0
    def walk(path):
        nonlocal total
        for p in path.iterdir():
            s=checked(p);name=p.relative_to(store).as_posix()
            if p.is_dir():
                if name not in dirs:raise ValueError('directory refused')
                walk(p)
            elif p.is_file():
                if name not in expected or s.st_size>1048576:raise ValueError('file bounds refused')
                total+=s.st_size;seen.add(name)
                if digest(p)!=data['files'][name]:raise ValueError('store integrity refused')
            else:raise ValueError('special file refused')
    walk(store)
    if seen!=expected or total>2097152:raise ValueError('store bounds refused')
    meta=strict_json((store/'meta.json').read_text())
    if set(meta)!={'collections','aliases','text_indexes'} or meta['aliases'] or meta['text_indexes'] or set(meta['collections'])!={'owned-vectors'}:raise ValueError('collection bounds refused')
    config=meta['collections']['owned-vectors'];v=config.get('vectors')
    if type(v) is not dict or v.get('size')!=3 or v.get('distance')!='Cosine' or any(value is not None for key,value in v.items() if key not in ('size','distance')) or any(value is not None for key,value in config.items() if key!='vectors'):raise ValueError('collection configuration refused')
    from contextlib import closing
    with closing(sqlite3.connect((store/'collection/owned-vectors/storage.sqlite').as_uri()+'?mode=ro&immutable=1',uri=True)) as db:
        count,maxblob=db.execute('SELECT count(*),max(length(point)) FROM points').fetchone()
        if count!=data['points'] or count>128 or maxblob>8192:raise ValueError('point bounds refused')
    return data

def validate(a):
    if type(a) is not dict or set(a)!={'collection','vector','limit'}:raise ValueError('closed shape required')
    if a['collection']!='owned-vectors':raise ValueError('collection refused')
    v=a['vector']
    if type(v) is not list or len(v)!=3:raise ValueError('dimension refused')
    if not all(type(n) in (int,float) and math.isfinite(n) and abs(n)<=1000 for n in v) or not any(v):raise ValueError('numeric vector refused')
    if type(a['limit']) is not int or not 1<=a['limit']<=5:raise ValueError('limit refused')
    return a

def isolate(home):
    systemroot=os.environ.get('SYSTEMROOT',r'C:\Windows')
    os.environ.clear()
    os.environ.update({'SYSTEMROOT':systemroot,'HOME':str(home),'USERPROFILE':str(home),'APPDATA':str(home),'LOCALAPPDATA':str(home),'TEMP':str(home),'TMP':str(home),'TMPDIR':str(home),'OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1','HF_HUB_OFFLINE':'1','HF_HUB_DISABLE_TELEMETRY':'1','DO_NOT_TRACK':'1'})
    def guard(event,args):
        if event.startswith('socket.') or event in ('subprocess.Popen','os.system'):raise PermissionError('network refused; no subprocesses')
    sys.addaudithook(guard)

def bounded_json(line):
    text=line.decode('utf-8');depth=0;quoted=False;escape=False
    for c in text:
        if quoted:
            if escape:escape=False
            elif c=='\\':escape=True
            elif c=='"':quoted=False
        elif c=='"':quoted=True
        elif c in '[{':
            depth+=1
            if depth>8:raise ValueError('depth refused')
        elif c in ']}':depth-=1
    return strict_json(text)

def initialize_params(p):
    # Deliberately bounded 2025-06-18 fixture subset; omitted fields remain
    # compatible with the historical minimal operator fixtures, not full MCP.
    if set(p)-{'protocolVersion','capabilities','clientInfo','_meta'}:raise ValueError('initialize fields refused')
    if 'protocolVersion' in p and (type(p['protocolVersion']) is not str or not 1<=len(p['protocolVersion'])<=64):raise ValueError('protocol version refused')
    if 'clientInfo' in p:
        info=p['clientInfo']
        if type(info) is not dict or not {'name','version'}<=set(info) or set(info)-{'name','version','title'}:raise ValueError('client info refused')
        if any(type(v) is not str or not 1<=len(v)<=128 for v in info.values()):raise ValueError('client strings refused')
    if '_meta' in p:
        meta=p['_meta']
        if type(meta) is not dict:raise ValueError('metadata refused')
        if 'progressToken' in meta:
            token=meta['progressToken']
            if not ((type(token) is str and len(token)<=256) or (type(token) in (int,float) and math.isfinite(token))):raise ValueError('progress token refused')
    if 'capabilities' in p:
        caps=p['capabilities']
        if type(caps) is not dict or set(caps)-{'roots','sampling','elicitation','experimental'}:raise ValueError('capabilities refused')
        for name,value in caps.items():
            if type(value) is not dict:raise ValueError('capability object refused')
            if name=='roots':
                if set(value)-{'listChanged'} or ('listChanged' in value and type(value['listChanged']) is not bool):raise ValueError('roots refused')
            elif name=='experimental':
                if any(type(v) is not dict for v in value.values()):raise ValueError('experimental refused')
            elif value:raise ValueError('unsupported capability fields')

def process_identity(pid):
    import ctypes
    from ctypes import wintypes
    if os.name!='nt':raise ValueError('Windows fixture qualification only')
    k=ctypes.WinDLL('kernel32',use_last_error=True)
    k.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD];k.OpenProcess.restype=wintypes.HANDLE
    k.GetProcessTimes.argtypes=[wintypes.HANDLE,*([ctypes.POINTER(wintypes.FILETIME)]*4)];k.GetProcessTimes.restype=wintypes.BOOL
    k.CloseHandle.argtypes=[wintypes.HANDLE]
    handle=k.OpenProcess(0x1000,False,pid)
    if not handle:return None
    try:
        times=[wintypes.FILETIME() for _ in range(4)]
        if not k.GetProcessTimes(handle,*[ctypes.byref(t) for t in times]):raise OSError('process identity unavailable')
        if times[1].dwLowDateTime or times[1].dwHighDateTime:return None
        return {'pid':pid,'created':(times[0].dwHighDateTime<<32)|times[0].dwLowDateTime}
    finally:k.CloseHandle(handle)

def serve(home,seal):
    isolate(home)
    preflight(home,seal)
    runtime=home/'runtime.json'
    if runtime.exists():checked(runtime)
    identity=process_identity(os.getpid())
    if identity is None:raise ValueError('own process identity unavailable')
    runtime.write_text(encoded({**identity,'pythonVersion':sys.version,'executable':sys.executable,'environmentKeys':sorted(os.environ),'engineImported':'qdrant_client' in sys.modules}))
    client=None
    initialized=False;handshake=False
    try:
        while True:
            line=sys.stdin.buffer.readline(8193)
            if not line:break
            ident=None
            try:
                if len(line)>8192:raise ValueError('request byte bound refused')
                msg=bounded_json(line)
                if type(msg) is not dict or set(msg)-{'jsonrpc','id','method','params'} or msg.get('jsonrpc','2.0')!='2.0':raise ValueError('envelope refused')
                if 'id' not in msg:
                    params=msg.get('params',{})
                    if msg.get('method')!='notifications/initialized' or type(params) is not dict or set(params)-{'_meta'} or ('_meta' in params and type(params['_meta']) is not dict):raise ValueError('notification refused')
                    if handshake:initialized=True
                    continue
                ident=msg['id']
                if type(ident) is not int or not 0<=ident<=2147483647:ident=None;raise ValueError('identifier refused')
                method=msg['method'];params=msg.get('params',{})
                if type(params) is not dict:raise ValueError('params refused')
                if method=='initialize':
                    if handshake:raise ValueError('reinitialization refused')
                    initialize_params(params)
                    handshake=True
                    result={'protocolVersion':'2025-06-18','capabilities':{'tools':{}},'serverInfo':{'name':'sara-owned-qdrant-local-fixture','version':'0.1.0'}}
                elif method=='tools/list':
                    if not initialized or params:raise ValueError('list refused')
                    result={'tools':[TOOL]}
                elif method=='tools/call':
                    if not initialized:raise ValueError('initialize first')
                    if set(params)!={'name','arguments'} or params['name']!=TOOL['name']:raise ValueError('unknown tool refused')
                    a=validate(params['arguments'])
                    if client is None:
                        preflight(home,seal)
                        from qdrant_client.local.qdrant_local import QdrantLocal
                        client=QdrantLocal(str(home/'store'))
                    points=client.query_points(collection_name=a['collection'],query=a['vector'],limit=a['limit'],with_payload=True,with_vectors=False).points
                    for p in points:
                        if type(p.id) is not int or not math.isfinite(p.score) or type(p.payload) is not dict or set(p.payload)!={'label'} or type(p.payload['label']) is not str or len(p.payload['label'])>128 or len(encoded(p.payload))>1024:raise ValueError('payload bounds refused')
                    result={'content':[{'type':'text','text':encoded({'engine':'QdrantLocal','points':[{'id':p.id,'score':p.score,'payload':p.payload} for p in points]})}]}
                    if len(encoded(result).encode())>8192:raise ValueError('result byte bounds refused')
                else:raise ValueError('method refused')
                response={'jsonrpc':'2.0','id':ident,'result':result}
            except Exception:
                response={'jsonrpc':'2.0','id':ident,'error':{'code':-32602,'message':'bounded local fixture request refused'}}
            print(encoded(response),flush=True)
            if len(line)>8192:break
    finally:
        if client is not None:client.close()
if __name__=='__main__':serve(Path(sys.argv[1]),sys.argv[2])
