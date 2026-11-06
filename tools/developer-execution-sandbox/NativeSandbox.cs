// Fixture-only, unprivileged Windows AppContainer feasibility runner.
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Diagnostics;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Web.Script.Serialization;
public static class NativeSandbox {
 [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr sd; public int inherit; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,uint share,ref SA sa,uint disposition,uint flags,IntPtr template);
 [StructLayout(LayoutKind.Sequential)] struct SI { public int cb; public IntPtr reserved, desktop, title; public int x,y,xs,ys,xc,yc,fill,flags; public short show,cbReserved; public IntPtr reserved2,stdin,stdout,stderr; }
 [StructLayout(LayoutKind.Sequential)] struct SIX { public SI si; public IntPtr attrs; }
 [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public uint pid,tid; }
 [StructLayout(LayoutKind.Sequential)] struct CAPS { public IntPtr sid,capabilities; public uint count,reserved; }
 [StructLayout(LayoutKind.Sequential)] struct BASIC { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC basic; public ulong r,w,o,rb,wb,ob; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
 [StructLayout(LayoutKind.Sequential)] struct CPU { public uint flags,rate; }
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr caps,uint count,out IntPtr sid);
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int GetAppContainerFolderPath(string sid,out IntPtr path);
 [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr sa,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int cls,IntPtr data,uint length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int cls,IntPtr data,uint length,IntPtr returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attr,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr psa,IntPtr tsa,bool inherit,uint flags,IntPtr env,string cwd,ref SIX startup,out PI process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long born,out long exit,out long kernel,out long user);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int cls,IntPtr info,uint length,out uint returned);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl,uint revision,out IntPtr sd,out uint length);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorSacl(IntPtr sd,out bool present,out IntPtr sacl,out bool defaulted);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern uint SetNamedSecurityInfo(string path,int type,uint info,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr ptr);
 static void Check(bool value,string operation) { if(!value) throw new Exception(operation+": Win32 "+Marshal.GetLastWin32Error()); }
 static IntPtr Pack(object data) { IntPtr p=Marshal.AllocHGlobal(Marshal.SizeOf(data)); Marshal.StructureToPtr(data,p,false); return p; }
 static void SetJob(IntPtr job,int cls,object data) { IntPtr p=Pack(data); try { Check(SetInformationJobObject(job,cls,p,(uint)Marshal.SizeOf(data)),"SetJob "+cls); } finally { Marshal.FreeHGlobal(p); } }
 static void Acl(string path,SecurityIdentifier sid,FileSystemRights rights,bool directory) {
  FileSystemSecurity acl=directory?(FileSystemSecurity)new DirectorySecurity():new FileSecurity();
  acl.SetAccessRuleProtection(true,false);
  var owner=WindowsIdentity.GetCurrent().User;
  acl.SetOwner(owner);
  var inheritance=directory?InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit:InheritanceFlags.None;
  acl.AddAccessRule(new FileSystemAccessRule(owner,FileSystemRights.FullControl,inheritance,PropagationFlags.None,AccessControlType.Allow));
  if(sid!=null) acl.AddAccessRule(new FileSystemAccessRule(sid,rights,inheritance,PropagationFlags.None,AccessControlType.Allow));
  if(directory) Directory.SetAccessControl(path,(DirectorySecurity)acl); else File.SetAccessControl(path,(FileSecurity)acl);
 }
 static void Low(string path) {
  IntPtr sd=IntPtr.Zero; uint n; bool present,def; IntPtr sacl;
  Check(ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;OICI;NW;;;LW)",1,out sd,out n),"Low descriptor");
  try { Check(GetSecurityDescriptorSacl(sd,out present,out sacl,out def),"Low SACL"); uint error=SetNamedSecurityInfo(path,1,0x10,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,sacl); if(error!=0) throw new Exception("Low label "+error); } finally { LocalFree(sd); }
 }
 static bool Inject(string point) { string selected=Environment.GetEnvironmentVariable("DEV_SANDBOX_FAULT"); return Environment.GetEnvironmentVariable("DEV_SANDBOX_FAULT_TEST")=="1" && (selected==point || selected=="terminate-wait-close" && (point=="terminate"||point=="wait"||point=="close-middle")); }
 static void Fault(string point) { if(Inject(point)) throw new Exception("Injected "+point); }
 static bool MappingExists(string path) { using(var hive=Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.CurrentUser,Microsoft.Win32.RegistryView.Registry64)) using(var key=hive.OpenSubKey(path,false)) return key!=null; }
 static bool Phase(List<string> errors,string name,Action action) { try { action(); return true; } catch(Exception e) { errors.Add(name+": "+e.Message); return false; } }
 static void Observe(IntPtr job,List<IntPtr> owned,List<IntPtr> members,List<object> identities,bool faults) {
  IntPtr list=Marshal.AllocHGlobal(4096);
  try {
   if(faults) { Fault("enumerate"); if(Inject("assignment-observer")) throw new Exception("Injected observer after assignment failure"); }
   Check(QueryInformationJobObject(job,3,list,4096,IntPtr.Zero),"Query owned process IDs"); int count=Marshal.ReadInt32(list,4);
   if(count<0 || count>(4096-8)/IntPtr.Size) throw new Exception("Invalid job PID count");
   for(int i=0;i<count;i++) {
    if(faults) { if(i==0) Fault("open-first"); if(i==1) Fault("open-later"); }
    uint pid=(uint)Marshal.ReadIntPtr(list,8+i*IntPtr.Size).ToInt64(); IntPtr handle=OpenProcess(0x101000,false,pid); Check(handle!=IntPtr.Zero,"Open owned identity");
    owned.Add(handle); // Ownership is immediate, even if membership/birth observation throws.
    bool member; Check(IsProcessInJob(handle,job,out member),"Observation membership"); if(!member) throw new Exception("Observation race: no longer owned member");
    members.Add(handle); // Only confirmed members may be awaited; every acquired handle is still closed.
    if(faults) Fault("birth"); long born,exit,k,u; Check(GetProcessTimes(handle,out born,out exit,out k,out u),"Owned birth identity");
    identities.Add(new {pid=pid,birthFileTime=born.ToString(System.Globalization.CultureInfo.InvariantCulture),inOwnedJob=member});
   }
  } finally { Marshal.FreeHGlobal(list); }
 }
 static bool Await(IntPtr handle) { return handle==IntPtr.Zero || WaitForSingleObject(handle,5000)==0; }
 static uint Active(IntPtr job) { IntPtr p=Marshal.AllocHGlobal(48); try { Check(QueryInformationJobObject(job,1,p,48,IntPtr.Zero),"Query accounting"); return (uint)Marshal.ReadInt32(p,40); } finally { Marshal.FreeHGlobal(p); } }
 static int TokenInt(IntPtr token,int cls) { IntPtr p=Marshal.AllocHGlobal(4096); uint n; try { Check(GetTokenInformation(token,cls,p,cls==20?4u:4096u,out n),"Token "+cls); return Marshal.ReadInt32(p); } finally { Marshal.FreeHGlobal(p); } }
 static string TokenSid(IntPtr token) { IntPtr p=Marshal.AllocHGlobal(4096); uint n; try { Check(GetTokenInformation(token,31,p,4096,out n),"Token SID"); return new SecurityIdentifier(Marshal.ReadIntPtr(p)).Value; } finally { Marshal.FreeHGlobal(p); } }
 static string Quote(string s) { return "\""+s.Replace("\"","\\\"")+"\""; }
 static void Validate(string root) {
  string prefix=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"hermes","cache","scratch","execution-sandbox")+Path.DirectorySeparatorChar;
  if(!String.Equals(Path.GetDirectoryName(root),prefix.TrimEnd(Path.DirectorySeparatorChar),StringComparison.OrdinalIgnoreCase)|| !System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(root),"^run-[a-f0-9]{32}$")) throw new Exception("Not an owned fixture root");
  for(var p=new DirectoryInfo(root);p!=null;p=p.Parent) if((p.Attributes&FileAttributes.ReparsePoint)!=0) throw new Exception("Reparse ancestor refused");
  if(File.ReadAllText(Path.Combine(root,"owned.marker"))!="sara-execution-fixture-v1") throw new Exception("Missing fixture identity");
 }
 public static int Main(string[] args) {
  var receipt=new Dictionary<string,object>(); IntPtr sid=IntPtr.Zero,job=IntPtr.Zero,attrs=IntPtr.Zero,capsPtr=IntPtr.Zero,env=IntPtr.Zero,token=IntPtr.Zero,log=IntPtr.Zero,handleList=IntPtr.Zero; PI pi=new PI(); bool created=false,assigned=false,attrsInitialized=false; string name=null,profilePath=null;
  var observed=new List<IntPtr>(); var members=new List<IntPtr>(); var identities=new List<object>(); bool cleanup=true; string mappingPath=null; long rootBorn=0;
  var errors=new List<string>();
  try {
   if(Environment.GetEnvironmentVariable("DEV_SANDBOX_QUALIFY")!="1" || args.Length!=3) throw new Exception("Explicit qualification only");
   string root=Path.GetFullPath(args[0]); Validate(root); string mode=args[1]; int port=int.Parse(args[2]);
   if(mode!="boundary"&&mode!="tree"&&mode!="timeout"&&mode!="memory") throw new Exception("Unknown fixed operation");
   Check(OpenProcessToken(GetCurrentProcess(),8,out token),"Open launcher token");
   receipt["launcherElevated"]=TokenInt(token,20)!=0;
   Check(CloseHandle(token),"Close launcher token"); token=IntPtr.Zero;
   if((bool)receipt["launcherElevated"]) throw new Exception("Elevated qualification refused");
   name="Sara.Fixture."+Guid.NewGuid().ToString("N"); int hr=CreateAppContainerProfile(name,name,"Disposable synthetic fixture",IntPtr.Zero,0,out sid);
   if(hr!=0) throw new Exception("CreateAppContainerProfile HRESULT "+hr); created=true;
   string sidText=new SecurityIdentifier(sid).Value; IntPtr folder;
   if(GetAppContainerFolderPath(sidText,out folder)!=0) throw new Exception("Cannot locate owned profile");
   try { profilePath=Marshal.PtrToStringUni(folder); } finally { Marshal.FreeCoTaskMem(folder); }
   receipt["profileFolderExisted"]=Directory.Exists(profilePath); receipt["profileName"]=name; receipt["sid"]=sidText;
   mappingPath="Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings\\"+sidText;
   receipt["profileFolderPath"]=profilePath; receipt["profileRegistryPath"]=mappingPath; receipt["profileRegistryView"]="Registry64";
   receipt["profileRegistry64Existed"]=MappingExists(mappingPath);
   if(!(bool)receipt["profileRegistry64Existed"] || !(bool)receipt["profileFolderExisted"]) throw new Exception("Positive exact profile identity controls missing");
   var securitySid=new SecurityIdentifier(sid);
   Acl(root,securitySid,FileSystemRights.ReadAndExecute,true);
   foreach(string dir in new[]{"bin","source"}) { string p=Path.Combine(root,dir); Acl(p,securitySid,FileSystemRights.ReadAndExecute,true); foreach(string f in Directory.GetFiles(p)) Acl(f,securitySid,FileSystemRights.ReadAndExecute,false); }
   Acl(Path.Combine(root,"outside"),null,0,true); foreach(string f in Directory.GetFiles(Path.Combine(root,"outside"))) Acl(f,null,0,false);
   Acl(Path.Combine(root,"output"),securitySid,FileSystemRights.Modify,true); Low(Path.Combine(root,"output"));
   receipt["sourceAcl"]=Directory.GetAccessControl(Path.Combine(root,"source")).GetSecurityDescriptorSddlForm(AccessControlSections.Access);
   job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"CreateJob");
   var limit=new EXT(); limit.basic.flags=0x2308; limit.basic.active=3; limit.processMemory=(UIntPtr)(512UL*1024*1024); limit.jobMemory=(UIntPtr)(768UL*1024*1024); SetJob(job,9,limit);
   SetJob(job,15,new CPU { flags=5,rate=2000 }); receipt["cpuHardCapPercent"]=20;
   IntPtr limitsReadback=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(EXT)));
   try { Check(QueryInformationJobObject(job,9,limitsReadback,(uint)Marshal.SizeOf(typeof(EXT)),IntPtr.Zero),"Read limits");
    var actual=(EXT)Marshal.PtrToStructure(limitsReadback,typeof(EXT));
    if(actual.basic.flags!=limit.basic.flags||actual.basic.active!=3||actual.processMemory!=limit.processMemory||actual.jobMemory!=limit.jobMemory) throw new Exception("Job limits readback mismatch");
    receipt["limitsReadback"]=new {flags=actual.basic.flags,activeProcessLimit=actual.basic.active,processMemoryBytes=actual.processMemory.ToUInt64(),jobMemoryBytes=actual.jobMemory.ToUInt64()};
    Check(QueryInformationJobObject(job,15,limitsReadback,8,IntPtr.Zero),"Read CPU limits");
    if(Marshal.ReadInt32(limitsReadback)!=5||Marshal.ReadInt32(limitsReadback,4)!=2000) throw new Exception("CPU cap readback mismatch");
   } finally { Marshal.FreeHGlobal(limitsReadback); }
   IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size); attrs=Marshal.AllocHGlobal(size);
   Check(InitializeProcThreadAttributeList(attrs,2,0,ref size),"Initialize attributes"); attrsInitialized=true;
   capsPtr=Pack(new CAPS {sid=sid,count=0}); Check(UpdateProcThreadAttribute(attrs,0,(IntPtr)0x20009,capsPtr,(IntPtr)Marshal.SizeOf(typeof(CAPS)),IntPtr.Zero,IntPtr.Zero),"Security capabilities");
   var si=new SIX(); si.si.cb=Marshal.SizeOf(typeof(SIX)); si.attrs=attrs;
   string output=Path.Combine(root,"output"); string fixture=Path.Combine(root,"source","probe.cjs"); string exe=Path.Combine(root,"bin","node.exe");
   var sa=new SA {length=Marshal.SizeOf(typeof(SA)),inherit=1};
   log=CreateFile(Path.Combine(output,"native-log.txt"),0xc0000000,3,ref sa,2,0x80,IntPtr.Zero); Check(log!=new IntPtr(-1),"Create owned log");
   handleList=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(handleList,log);
   Check(UpdateProcThreadAttribute(attrs,0,(IntPtr)0x20002,handleList,(IntPtr)IntPtr.Size,IntPtr.Zero,IntPtr.Zero),"Explicit handle allowlist");
   si.si.flags=0x100; si.si.stdin=log; si.si.stdout=log; si.si.stderr=log;
   // Empty, explicit environment; no inherited owner secrets, NODE_OPTIONS, PATH or handles.
   string envText="LOCALAPPDATA="+output+"\0SystemRoot="+Environment.GetEnvironmentVariable("SystemRoot")+"\0TEMP="+output+"\0TMP="+output+"\0\0"; env=Marshal.StringToHGlobalUni(envText);
   // Avoid Node's eager realpath lstat of ungranted drive ancestors; no grant is broadened.
   var cmd=new StringBuilder(Quote(exe)+" --preserve-symlinks --preserve-symlinks-main "+Quote(fixture)+" "+mode+" "+port);
   Check(CreateProcess(exe,cmd,IntPtr.Zero,IntPtr.Zero,true,0x08080404,env,output,ref si,out pi),"CreateProcess AppContainer suspended");
   long creationExit,creationKernel,creationUser; Check(GetProcessTimes(pi.process,out rootBorn,out creationExit,out creationKernel,out creationUser),"Original creation-handle identity"); receipt["rootIdentity"]=new {pid=pi.pid,birthFileTime=rootBorn.ToString(System.Globalization.CultureInfo.InvariantCulture),authority="original-creation-handle"};
   Fault("assignment-observer"); Check(AssignProcessToJobObject(job,pi.process),"Assign suspended process"); assigned=true;
   bool inJob; Check(IsProcessInJob(pi.process,job,out inJob),"IsProcessInJob"); if(!inJob) throw new Exception("Missing owned job"); receipt["inOwnedJob"]=inJob;
   bool parentJob; Check(IsProcessInJob(GetCurrentProcess(),IntPtr.Zero,out parentJob),"Parent job"); receipt["parentInJob"]=parentJob;
   Check(OpenProcessToken(pi.process,8,out token),"Open token"); receipt["isAppContainer"]=TokenInt(token,29)==1; receipt["capabilityCount"]=TokenInt(token,30); receipt["tokenSid"]=TokenSid(token);
   if(!(bool)receipt["isAppContainer"]||(int)receipt["capabilityCount"]!=0||(string)receipt["tokenSid"]!=sidText) throw new Exception("Unexpected sandbox identity");
   long born,exit,k,u; Check(GetProcessTimes(pi.process,out born,out exit,out k,out u),"Root identity"); if(born!=rootBorn) throw new Exception("Original root identity changed");
   Check(ResumeThread(pi.thread)!=0xffffffff,"Resume"); receipt["nativeStarted"]=true;
   int deadline=mode=="timeout"?1000:10000; var clock=Stopwatch.StartNew(); while(!File.Exists(Path.Combine(output,"done.json"))&&clock.ElapsedMilliseconds<deadline&&WaitForSingleObject(pi.process,0)!=0) Thread.Sleep(20);
   uint exitCode; Check(GetExitCodeProcess(pi.process,out exitCode),"Exit code"); receipt["exitBeforeCleanup"]=exitCode;
   receipt["wallElapsedMs"]=clock.ElapsedMilliseconds; receipt["timedOut"]=clock.ElapsedMilliseconds>=deadline;
   receipt["status"]=File.Exists(Path.Combine(output,"done.json"))?"executed":"blocked";
  } catch(Exception e) { receipt["status"]="blocked"; receipt["error"]=e.Message; }
  finally {
   // Every phase is independently guarded: observation never gates termination or root await.
   bool snapshotComplete=job==IntPtr.Zero,jobEmpty=job==IntPtr.Zero,jobClosed=job==IntPtr.Zero;
   bool rootExited=pi.process==IntPtr.Zero,allExited=true,handlesClosed=true;
   if(job!=IntPtr.Zero) {
    snapshotComplete=Phase(errors,"observe",()=>Observe(job,observed,members,identities,true));
    // Separate trusted snapshot for kill-on-close fallback, not a claim that injected observation succeeded.
    if(!snapshotComplete) snapshotComplete=Phase(errors,"recovery observation",()=>Observe(job,observed,members,identities,false));
    receipt["jobTerminateAttempted"]=true;
    receipt["jobTerminateSucceeded"]=Phase(errors,"terminate",()=>{ Fault("terminate"); Check(TerminateJobObject(job,137),"Terminate owned job"); });
    Phase(errors,"job accounting",()=>{ var clock=Stopwatch.StartNew(); uint active=Active(job); while(active!=0 && clock.ElapsedMilliseconds<5000) { Thread.Sleep(10); active=Active(job); } receipt["activeAfterCleanup"]=active; jobEmpty=active==0; });
   }
   // Always kill the original unassigned creation handle even when observation/accounting failed.
   if(pi.process!=IntPtr.Zero && !assigned) receipt["unassignedTerminateSucceeded"]=Phase(errors,"unassigned root terminate",()=>Check(TerminateProcess(pi.process,137),"Terminate suspended unassigned fixture"));
   if(pi.process!=IntPtr.Zero) Phase(errors,"root wait",()=>{ Fault("wait"); rootExited=Await(pi.process); Check(rootExited,"Root wait"); });
   // Actual kill-on-close is followed by independent real waits; closing is not quiescence proof.
   if(job!=IntPtr.Zero) { jobClosed=Phase(errors,"close job",()=>Check(CloseHandle(job),"Close owned job")); if(jobClosed) job=IntPtr.Zero; handlesClosed &= jobClosed; }
   if(pi.process!=IntPtr.Zero) Phase(errors,"fallback original-root await",()=>{ rootExited=Await(pi.process); Check(rootExited,"Fallback root wait"); });
   var waits=new List<bool>();
   foreach(IntPtr handle in members) { bool exited=false; Phase(errors,"observed await",()=>{ exited=Await(handle); Check(exited,"Observed wait"); }); waits.Add(exited); allExited &= exited; }
   bool quiescent=rootExited && allExited && (jobEmpty || (jobClosed && snapshotComplete));
   if(Inject("unknown")) { errors.Add("Injected unknown quiescence"); quiescent=false; }
   receipt["rootExited"]=rootExited; receipt["allObservedExited"]=allExited; receipt["observedWaits"]=waits;
   receipt["quiescenceVerified"]=quiescent; receipt["jobCloseSucceeded"]=jobClosed; receipt["snapshotComplete"]=snapshotComplete; receipt["profileRetained"]=created&&!quiescent;
   receipt["recoveryIdentity"]=new {profileName=name,sid=sid==IntPtr.Zero?null:new SecurityIdentifier(sid).Value,profileFolder=profilePath,fixtureRoot=args.Length>0?args[0]:null,rootPid=pi.pid,rootBirthFileTime=rootBorn.ToString(System.Globalization.CultureInfo.InvariantCulture)};
   // Test-only finally recovery uses the still-owned original/snapshot handles, never a reopened PID.
   bool recovered=false;
   if(Inject("unknown") && !quiescent) {
    Phase(errors,"retention readback",()=>{ receipt["retentionReadback"]=new {profileFolderExists=Directory.Exists(profilePath),mappingExists=MappingExists(mappingPath),fixtureExists=Directory.Exists(args[0])}; });
    Phase(errors,"test-only exact-handle recovery",()=>{
     bool exactAwait=Await(pi.process); foreach(IntPtr h in members) exactAwait &= Await(h);
     recovered=exactAwait && jobClosed && snapshotComplete;
     receipt["testRecovery"]=new {exactOwnedHandlesAwaited=exactAwait,quiescenceVerified=recovered,rootPid=pi.pid,rootBirthFileTime=rootBorn.ToString(System.Globalization.CultureInfo.InvariantCulture)};
    });
   }
   int closeIndex=0; var closeResults=new List<bool>();
   foreach(IntPtr handle in observed) {
    if(closeIndex++==1) Phase(errors,"close injection",()=>Fault("close-middle"));
    bool closed=Phase(errors,"close observed",()=>Check(CloseHandle(handle),"Close observed handle")); closeResults.Add(closed); handlesClosed &= closed;
   }
   foreach(IntPtr h in new[]{log,token,pi.thread,pi.process,job}) if(h!=IntPtr.Zero && h!=new IntPtr(-1)) { bool closed=Phase(errors,"close resource",()=>Check(CloseHandle(h),"Close resource")); handlesClosed &= closed; }
   receipt["observedHandlesAcquired"]=observed.Count; receipt["observedHandleCloseResults"]=closeResults; receipt["handlesClosed"]=handlesClosed;
   Phase(errors,"free attributes",()=>{ if(attrsInitialized) DeleteProcThreadAttributeList(attrs); });
   foreach(IntPtr p in new[]{handleList,attrs,capsPtr,env}) if(p!=IntPtr.Zero) Phase(errors,"free allocation",()=>Marshal.FreeHGlobal(p));
   bool deleted=!created;
   if(created && (quiescent||recovered)) Phase(errors,"delete exact profile",()=>{
    int hr=DeleteAppContainerProfile(name); receipt["profileDeleteHresult"]=hr; receipt["profileDeleted"]=hr==0;
    if(hr!=0) throw new Exception("Delete HRESULT "+hr);
    string path="Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings\\"+new SecurityIdentifier(sid).Value;
    bool absent=!MappingExists(path),folderAbsent=profilePath!=null&&!Directory.Exists(profilePath);
    receipt["profileAbsentAfterDelete"]=absent; receipt["profileFolderAbsentAfterDelete"]=folderAbsent; deleted=absent&&folderAbsent;
    Check(deleted,"Profile negative readback");
   });
   if(sid!=IntPtr.Zero) Phase(errors,"free SID",()=>FreeSid(sid));
   receipt["identities"]=identities; receipt["cleanupErrors"]=errors;
   receipt["resourcesReleased"]=deleted&&handlesClosed&&(quiescent||recovered);
   cleanup=deleted&&handlesClosed&&quiescent&&errors.Count==0; receipt["cleaned"]=cleanup;
  }
  Console.WriteLine(new JavaScriptSerializer().Serialize(receipt)); return (string)receipt["status"]=="executed"&&cleanup?0:2;
 }
}
