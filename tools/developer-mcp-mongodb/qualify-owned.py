"""Opt-in Windows trusted-fixture supervisor; owned job/creation handles, not a sandbox."""
import ctypes as C
from ctypes import wintypes as W
import json, os, shutil, socket, subprocess, tempfile, time
from pathlib import Path
assert os.environ.get('MONGODB_LOCAL_QUALIFY') == '1', 'Explicit opt-in required'
assert os.name == 'nt', 'Windows qualification only'
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT/'outputs/developer-addons/mcp-mongodb'
RESULT = OUT/'local-resume-result.json'
# Preserve all earlier failed/passing runtime receipts.
if RESULT.exists():
    shutil.copyfile(RESULT, OUT/('local-resume-result-history-'+str(time.time_ns())+'.json'))
BASE = Path.home()/'AppData/Local/hermes/cache/scratch/mcp-mongodb'
BASE.mkdir(parents=True, exist_ok=True)
home = Path(tempfile.mkdtemp(prefix='owned-runtime-', dir=BASE))
k = C.WinDLL('kernel32', use_last_error=True)
class BASIC(C.Structure):
    _fields_=[('PerProcessUserTimeLimit',C.c_int64),('PerJobUserTimeLimit',C.c_int64),('LimitFlags',W.DWORD),('MinimumWorkingSetSize',C.c_size_t),('MaximumWorkingSetSize',C.c_size_t),('ActiveProcessLimit',W.DWORD),('Affinity',C.c_size_t),('PriorityClass',W.DWORD),('SchedulingClass',W.DWORD)]
class IO(C.Structure):
    _fields_=[(n,C.c_uint64) for n in ['ReadOperationCount','WriteOperationCount','OtherOperationCount','ReadTransferCount','WriteTransferCount','OtherTransferCount']]
class EXT(C.Structure):
    _fields_=[('BasicLimitInformation',BASIC),('IoInfo',IO),('ProcessMemoryLimit',C.c_size_t),('JobMemoryLimit',C.c_size_t),('PeakProcessMemoryUsed',C.c_size_t),('PeakJobMemoryUsed',C.c_size_t)]
for name, args, restype in [
 ('CreateJobObjectW',[C.c_void_p,W.LPCWSTR],W.HANDLE),('SetInformationJobObject',[W.HANDLE,C.c_int,C.c_void_p,W.DWORD],W.BOOL),
 ('AssignProcessToJobObject',[W.HANDLE,W.HANDLE],W.BOOL),('QueryInformationJobObject',[W.HANDLE,C.c_int,C.c_void_p,W.DWORD,C.c_void_p],W.BOOL),
 ('OpenProcess',[W.DWORD,W.BOOL,W.DWORD],W.HANDLE),('IsProcessInJob',[W.HANDLE,W.HANDLE,C.POINTER(W.BOOL)],W.BOOL),
 ('GetProcessTimes',[W.HANDLE,C.c_void_p,C.c_void_p,C.c_void_p,C.c_void_p],W.BOOL),('TerminateJobObject',[W.HANDLE,W.UINT],W.BOOL),
 ('WaitForSingleObject',[W.HANDLE,W.DWORD],W.DWORD),('CloseHandle',[W.HANDLE],W.BOOL)]:
    f=getattr(k,name); f.argtypes=args; f.restype=restype

def check(v):
    if not v: raise C.WinError(C.get_last_error())
    return v

def birth(h):
    values=[C.c_uint64() for _ in range(4)]
    check(k.GetProcessTimes(h,*(C.byref(v) for v in values)))
    return values[0].value

job=check(k.CreateJobObjectW(None,None))
limits=EXT(); limits.BasicLimitInformation.LimitFlags=0x2000
check(k.SetInformationJobObject(job,9,C.byref(limits),C.sizeof(limits)))
handles={}; identities=[]; cleanup_errors=[]; proc=None; active=-1

def members():
    buf=C.create_string_buffer(65536)
    check(k.QueryInformationJobObject(job,3,buf,len(buf),None))
    assigned, count = C.cast(buf,C.POINTER(W.DWORD))[:2]
    if assigned != count: raise RuntimeError('Job member enumeration truncated')
    return list((C.c_size_t*count).from_buffer(buf,8))

def observe():
    for pid in members():
        if pid in handles: continue
        h=k.OpenProcess(0x100000|0x1000,False,pid)
        if not h:
            if pid not in members(): continue
            raise C.WinError(C.get_last_error())
        try:
            inside=W.BOOL(); check(k.IsProcessInJob(h,job,C.byref(inside)))
            if not inside.value: raise RuntimeError('PID lost owned job identity')
            born=birth(h)
            handles[pid]=h
            identities.append({'pid':pid,'creationFiletime':born,'jobMembershipRechecked':True})
        except:
            k.CloseHandle(h); raise

try:
    env={n:os.environ[n] for n in ['SYSTEMROOT','WINDIR'] if n in os.environ}
    env.update(PATH=str(Path(os.environ['ProgramFiles'])/'nodejs'),HOME=str(home),USERPROFILE=str(home),APPDATA=str(home),LOCALAPPDATA=str(home),TEMP=str(BASE),TMP=str(BASE),TMPDIR=str(BASE),MDB_OWNED_HOME=str(home),MONGODB_LOCAL_QUALIFY='1')
    node=Path(os.environ['ProgramFiles'])/'nodejs/node.exe'
    proc=subprocess.Popen([str(node),str(ROOT/'tools/developer-mcp-mongodb/qualify-local.mjs')],cwd=home,env=env,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    # The actual original process creation handle remains owned through wait.
    check(k.AssignProcessToJobObject(job,int(proc._handle)))
    root_birth=birth(int(proc._handle))
    observe()
    proc.stdin.write(b'owned-job-admitted\n');proc.stdin.flush();proc.stdin.close()
    deadline=time.monotonic()+175
    while proc.poll() is None:
        observe()
        if time.monotonic()>deadline: raise TimeoutError('Qualification wall-time cap')
        time.sleep(.1)
    observe()
finally:
    # Each cleanup phase is independent; an observation failure cannot skip termination.
    try: observe()
    except Exception as e: cleanup_errors.append('enumeration:'+type(e).__name__)
    try: check(k.TerminateJobObject(job,1))
    except Exception as e: cleanup_errors.append('job-termination:'+type(e).__name__)
    if proc is not None:
        try:
            if proc.poll() is None: proc.kill()
            proc.wait(timeout=15)
        except Exception as e: cleanup_errors.append('creation-handle-wait:'+type(e).__name__)
    for pid,h in handles.items():
        try:
            if k.WaitForSingleObject(h,15000)!=0: raise RuntimeError('Owned handle not signalled')
        except Exception as e: cleanup_errors.append('handle-wait:'+type(e).__name__)
        finally:
            if not k.CloseHandle(h): cleanup_errors.append('handle-close')
    try: active=len(members())
    except Exception as e: cleanup_errors.append('post-kill-query:'+type(e).__name__)
    if not k.CloseHandle(job): cleanup_errors.append('job-close')
    data=json.loads(RESULT.read_text()) if RESULT.exists() else {'status':'fail','passed':[],'failure':{'stage':'runner-before-receipt'}}
    listener_closed=False
    if data.get('port'):
        with socket.socket() as s:
            s.settimeout(1);listener_closed=s.connect_ex(('127.0.0.1',data['port']))!=0
    if active==0 and not cleanup_errors and listener_closed:
        assert home.parent==BASE and home.name.startswith('owned-runtime-') and not home.is_symlink() and not home.is_junction()
        shutil.rmtree(home)
    data['cleanup']={'activeProcesses':active,'fixtureRemoved':not home.exists(),'listenerClosed':listener_closed,'errors':cleanup_errors,'identities':identities,'rootCreationFiletime':locals().get('root_birth'),'ownedCreationHandleWaited':proc is not None and proc.poll() is not None}
    if data['cleanup']['fixtureRemoved'] and not cleanup_errors:
        data['passed'].append('MDB-CLEANUP')
    if data['status']=='feature-pass-cleanup-pending' and 'MDB-CLEANUP' in data['passed']:data['status']='pass'
    elif data['status']!='fail':data['status']='fail'
    RESULT.write_text(json.dumps(data,indent=2)+'\n')
    print(json.dumps({'status':data['status'],'passed':data['passed'],'failure':data.get('failure'),'cleanup':data['cleanup']}))
raise SystemExit(0 if data['status']=='pass' else 1)
