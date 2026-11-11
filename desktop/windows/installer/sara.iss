; Sara-Setup.exe (Phase 46c, Phase 55): installs Sara's server AND the Sara desktop app together, or
; only the app to connect to a Sara somewhere else.
; Built by desktop/windows/build-installer.sh (which stages the files and passes AppVersion/Stage).
;
; Questions (plain words, defaults pre-selected):
;   1. How do you want to use Sara?  "Run Sara on this computer" (her server and the app) or
;      "Connect to a Sara somewhere else" (the app only: Sara.exe, its shortcut and uninstall entry,
;      per-user, no administrator; no Node, no server files, no service, no PATH entry, no data
;      folder, no firewall rule). Remote mode then asks for the address (page "Where is your Sara?")
;      and writes it to %LOCALAPPDATA%\Sara\desktop.ini, which Sara.exe reads, so the first start
;      goes straight to pairing with a code.
;   2. (on this computer) How should Sara run?  As a Windows service from boot (default, needs an
;      administrator) or only while I'm signed in (no administrator).
;      Privileges: Setup starts per-user (PrivilegesRequired=lowest), so the first question comes
;      before any administrator prompt. Choosing the service starts Setup again elevated
;      ("runas" with /ALLUSERS /MODE=service), which skips the first two questions.
;   3. How will you reach her?  Tailscale (default when it's installed and signed in), just this
;      computer, your home network (plain HTTP), or your own web address (HTTPS set up by you).
;   4. Port (default 7860; checked free).
; Updates keep the mode: the first page pre-selects what is installed (a remote install stays remote
; unless the person picks otherwise; remote → this computer works by running Setup again).
; Silent installs: Sara-Setup.exe /VERYSILENT /ALLUSERS|/CURRENTUSER [/MODE=service|user]
;   [/ACCESS=local|tailscale|lan|domain] [/DOMAIN=sara.example.com] [/PORT=N] [/DATA=<folder>]
;   or the app only: Sara-Setup.exe /VERYSILENT /MODE=remote /SERVER=sara.example.com
; Uninstall: unins000.exe [/VERYSILENT] [/DELETEDATA=1] (a remote install removes only the app and
;   its settings on this computer; no server's data is ever touched).

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef Stage
  #define Stage "..\..\..\outputs\windows\stage"
#endif
; The app's update test (docs/desktop.md → How the app updates; build-installer.sh with SARA_TEST_INSTALL=1):
; an installer of its own (another AppId, folder, Start-menu name and app data folder), so testing an
; app-only update on a PC never touches a real Sara there. Release builds never define TestInstall.
#ifdef TestInstall
  #define AppGuid "8C1D7E52-3F0A-4B6E-9D21-5A7B3C9E0F64"
  #define AppTitle "Sara update test"
  #define AppFolder "SaraUpdTest"
  #define AppData "{localappdata}\SaraUpdTest\data"
  #define AppAumid "BackstageCoding.Sara.Test"
  #define AppToastClsid "06518AB6-E425-4C52-A92F-FB52BE7867E6"
  #define AppSendTo "Sara (test).lnk"
#else
  #define AppGuid "6F0B2C1E-7A51-4C8B-9E2D-3B5A0C9D4E17"
  #define AppTitle "Sara"
  #define AppFolder "Sara"
  #define AppData "{localappdata}\Sara"
  #define AppAumid "BackstageCoding.Sara"
  #define AppToastClsid "57448757-B168-47CE-9852-892129855C82"
  #define AppSendTo "Sara.lnk"
#endif

[Setup]
#ifdef TestInstall
AppId={{8C1D7E52-3F0A-4B6E-9D21-5A7B3C9E0F64}
#else
AppId={{6F0B2C1E-7A51-4C8B-9E2D-3B5A0C9D4E17}
#endif
AppName={#AppTitle}
AppVersion={#AppVersion}
AppVerName=Sara {#AppVersion}
AppPublisher=Backstage Coding
AppPublisherURL=https://github.com/farena-ai/sara
AppSupportURL=https://github.com/farena-ai/sara
AppUpdatesURL=https://github.com/farena-ai/sara/releases/latest
VersionInfoVersion={#AppVersion}
VersionInfoDescription=Sara setup (server and desktop app)
DefaultDirName={autopf}\{#AppFolder}
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableWelcomePage=yes
; Per-user first: the first question (this computer, or a Sara somewhere else) comes before any
; administrator prompt. The service install starts Setup again with /ALLUSERS (see RelaunchAsService).
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=commandline
UsePreviousPrivileges=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputBaseFilename=Sara-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\src\sara.ico
UninstallDisplayIcon={app}\Sara.exe
UninstallDisplayName={#AppTitle}
ChangesEnvironment=yes
CloseApplications=yes
RestartApplications=no
SetupLogging=yes

[Messages]
FinishedHeadingLabel=Sara is installed
FinishedLabelNoIcons=Sara is installed.
FinishedLabel=Sara is installed. Open her from the Start menu any time.

[InstallDelete]
; A clean copy of the server files on every update (her data lives elsewhere and is never touched).
Type: filesandordirs; Name: "{app}\server"

[Files]
; The app: in both modes. Everything else only when her server runs on this computer.
Source: "{#Stage}\Sara.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Stage}\SaraService.exe"; DestDir: "{app}"; Flags: ignoreversion; Check: not IsRemote
Source: "{#Stage}\SaraService.exe"; Flags: dontcopy
Source: "{#Stage}\node\node.exe"; DestDir: "{app}\node"; Flags: ignoreversion; Check: not IsRemote
Source: "{#Stage}\bin\sara.cmd"; DestDir: "{app}\bin"; Flags: ignoreversion; Check: not IsRemote
Source: "{#Stage}\server\*"; DestDir: "{app}\server"; Flags: ignoreversion recursesubdirs createallsubdirs; Check: not IsRemote

[Icons]
; Phase 75 stage 3: the shortcut says it is Sara (the AUMID the app sets for itself) and names the
; COM class that takes clicks on her notifications (desktop/windows/src/main.cpp, kToastClsid).
Name: "{autoprograms}\{#AppTitle}"; Filename: "{app}\Sara.exe"; Comment: "Sara, your companion"; AppUserModelID: "{#AppAumid}"; AppUserModelToastActivatorCLSID: "{#AppToastClsid}"

[Registry]
; "Only while I'm signed in": her server starts when this user signs in.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Sara server"; ValueData: """{app}\SaraService.exe"" --run"; Flags: uninsdeletevalue; Check: (not IsAdminInstallMode) and (not IsRemote)
; Phase 75 stage 3: what the app registers for its notifications (per user, when it runs) goes on uninstall.
Root: HKCU; Subkey: "Software\Classes\AppUserModelId\{#AppAumid}"; Flags: uninsdeletekey dontcreatekey
Root: HKCU; Subkey: "Software\Classes\CLSID\{{{#AppToastClsid}}"; Flags: uninsdeletekey dontcreatekey

[Run]
Filename: "{app}\Sara.exe"; Parameters: "{code:OpenParams}"; Description: "Open Sara"; Flags: postinstall nowait skipifsilent runasoriginaluser

[UninstallDelete]
; Phase 75 stage 3: the app's "Send to → Sara" entry in Explorer.
Type: files; Name: "{usersendto}\{#AppSendTo}"
Type: files; Name: "{app}\sara.env"
Type: filesandordirs; Name: "{app}\server"
Type: filesandordirs; Name: "{app}\updater"
Type: dirifempty; Name: "{app}\bin"
Type: dirifempty; Name: "{app}\node"
Type: dirifempty; Name: "{app}"

[Code]
const
  WM_COMMAND = $0111;
  WM_COPY = $0301;
  EM_SETSEL = $00B1;
  ID_QUIT = 102;
  GUIDE_URL = 'https://github.com/farena-ai/sara/blob/main/docs/INSTALL.md#2-reach-her-securely-https';
  APP_KEY = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{{#AppGuid}}_is1';
  RUN_KEY = 'Software\Microsoft\Windows\CurrentVersion\Run';

function SetEnvironmentVariable(lpName, lpValue: String): BOOL;
  external 'SetEnvironmentVariableW@kernel32.dll stdcall';

var
  UsePage: TWizardPage;
  UseLocal, UseRemote: TNewRadioButton;
  RunPage: TInputOptionWizardPage;
  RemotePage: TInputQueryWizardPage;
  InstMode: String;    // 'service' | 'user' | 'remote' when fixed by /MODE, /ALLUSERS or a silent run; '' = the pages decide
  Relaunching: Boolean;
  OldServer: String;   // the app's server address before this install (remote mode)
  AccessPage: TInputOptionWizardPage;
  DomainPage: TInputQueryWizardPage;
  PortPage: TInputQueryWizardPage;
  PrivacyPage: TInputOptionWizardPage;
  DonePage: TWizardPage;
  TsLabel: TNewStaticText;
  DoneIntro, DoneAddress, DoneTokenLabel, DoneKeep, DoneAsks: TNewStaticText;
  TokenEdit: TNewEdit;
  CopyButton: TNewButton;
  IsUpgrade: Boolean;
  TsState: Integer;   // 0 not installed, 1 not signed in / off, 2 HTTPS off, 3 ready
  TsName: String;
  FinalUrl, Token, SetupNote: String;
  DeleteData: Boolean;
  StartedOk: Boolean;
  KeptData: Boolean;  // a first install onto data left by an earlier one (uninstalled, data kept)
  WasRemote: Boolean; // this computer had the app only (connected elsewhere) until this install

// ---------- small helpers ----------
function Q(S: String): String;
begin
  Result := '"' + S + '"';
end;

function JoinLines(const A: TArrayOfString): String;
var I: Integer;
begin
  Result := '';
  for I := 0 to GetArrayLength(A) - 1 do Result := Result + A[I] + #10;
end;

function Run(const Exe, Params, Dir: String; var Output: String): Integer;
var O: TExecOutput; Code: Integer;
begin
  Output := '';
  Code := -1;
  try
    if ExecAndCaptureOutput(Exe, Params, Dir, SW_HIDE, ewWaitUntilTerminated, Code, O) then
      Output := JoinLines(O.StdOut) + JoinLines(O.StdErr)
    else
      Output := SysErrorMessage(Code);
  except
    Output := GetExceptionMessage;
  end;
  Log(Exe + ' ' + Params + ' -> ' + IntToStr(Code) + ': ' + Output);
  Result := Code;
end;

function HelperExe: String;
begin
  Result := ExpandConstant('{tmp}\SaraService.exe');
  if not FileExists(Result) then ExtractTemporaryFile('SaraService.exe');
end;

function PortFree(Port: Integer): Boolean;
var O: String;
begin
  Result := Run(HelperExe, '--port-free ' + IntToStr(Port), '', O) = 0;
end;

function EnvValue(const FileName, Key: String): String;
var Lines: TArrayOfString; I, P: Integer; L: String;
begin
  Result := '';
  if not LoadStringsFromFile(FileName, Lines) then exit;
  for I := 0 to GetArrayLength(Lines) - 1 do begin
    L := Trim(Lines[I]);
    P := Pos('=', L);
    if (P > 1) and (Copy(L, 1, 1) <> '#') and (Trim(Copy(L, 1, P - 1)) = Key) then Result := Trim(Copy(L, P + 1, Length(L)));
  end;
end;

/// Puts every KEY=VALUE of sara.env into this process's environment (inherited by Node).
procedure LoadEnvFile(const FileName: String);
var Lines: TArrayOfString; I, P: Integer; L: String;
begin
  if not LoadStringsFromFile(FileName, Lines) then exit;
  for I := 0 to GetArrayLength(Lines) - 1 do begin
    L := Trim(Lines[I]);
    P := Pos('=', L);
    if (P > 1) and (Copy(L, 1, 1) <> '#') then SetEnvironmentVariable(Trim(Copy(L, 1, P - 1)), Trim(Copy(L, P + 1, Length(L))));
  end;
  SetEnvironmentVariable('SARA_INSTALLED', '1');
end;

/// node src/main.ts <Args> with her settings (the installed copy in AppDir).
function RunServerFlag(const AppDir, Args: String; var Output: String): Integer;
begin
  LoadEnvFile(AppDir + '\sara.env');
  Result := Run(AppDir + '\node\node.exe', '--disable-warning=ExperimentalWarning ' + Q(AppDir + '\server\src\main.ts') + ' ' + Args, AppDir + '\server', Output);
end;

function HttpOk(const Url: String): Boolean;
var Req: Variant;
begin
  Result := False;
  try
    Req := CreateOleObject('WinHttp.WinHttpRequest.5.1');
    Req.SetTimeouts(2000, 2000, 2000, 2000);
    Req.Open('GET', Url, False);
    Req.Send('');
    Result := Req.Status = 200;
  except
    Result := False;
  end;
end;

procedure CloseDesktopApp;
var H: HWND; I: Integer;
begin
#ifdef TestInstall
  // The update test: its watcher has closed the test app already. Never close another window here
  // (a real Sara, or another test run's app, can be open on this PC).
  exit;
#endif
  H := FindWindowByClassName('SaraDesktopWindow');
  if H = 0 then exit;
  PostMessage(H, WM_COMMAND, ID_QUIT, 0);
  for I := 1 to 40 do begin
    Sleep(250);
    if FindWindowByClassName('SaraDesktopWindow') = 0 then break;
  end;
  Sleep(1500);  // its web view lets go of its files
end;

function PathRoot: Integer;
begin
  if IsAdminInstallMode then Result := HKLM else Result := HKCU;
end;
function PathKey: String;
begin
  if IsAdminInstallMode then Result := 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment' else Result := 'Environment';
end;

/// Keeps the value's kind: an expandable string only when it uses %VARIABLES%.
procedure WritePath(const Value: String);
begin
  if Pos('%', Value) > 0 then RegWriteExpandStringValue(PathRoot, PathKey, 'Path', Value)
  else begin
    // RegWriteStringValue keeps an existing REG_EXPAND_SZ, so write it fresh as a plain string.
    RegDeleteValue(PathRoot, PathKey, 'Path');
    RegWriteStringValue(PathRoot, PathKey, 'Path', Value);
  end;
end;

procedure AddToPath(const Dir: String);
var Paths: String;
begin
  if not RegQueryStringValue(PathRoot, PathKey, 'Path', Paths) then Paths := '';
  if Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(Paths) + ';') > 0 then exit;
  if (Paths <> '') and (Copy(Paths, Length(Paths), 1) <> ';') then Paths := Paths + ';';
  WritePath(Paths + Dir);
end;

procedure RemoveFromPath(const Dir: String);
var Paths, Up, Item: String; P: Integer; Rest, Kept: String;
begin
  if not RegQueryStringValue(PathRoot, PathKey, 'Path', Paths) then exit;
  Up := Uppercase(Dir);
  Rest := Paths;
  Kept := '';
  while Rest <> '' do begin
    P := Pos(';', Rest);
    if P = 0 then begin Item := Rest; Rest := ''; end
    else begin Item := Copy(Rest, 1, P - 1); Rest := Copy(Rest, P + 1, Length(Rest)); end;
    if (Item <> '') and (Uppercase(Item) <> Up) then begin
      if Kept <> '' then Kept := Kept + ';';
      Kept := Kept + Item;
    end;
  end;
  if Kept <> Paths then WritePath(Kept);
end;

// ---------- the server address (remote mode) ----------
function IsIPv4(const H: String): Boolean;
var I, Parts: Integer; Cur: String; C: Char;
begin
  Result := False;
  Parts := 0;
  Cur := '';
  for I := 1 to Length(H) + 1 do begin
    if I <= Length(H) then C := H[I] else C := '.';
    if C = '.' then begin
      if (Cur = '') or (Length(Cur) > 3) or (StrToIntDef(Cur, 999) > 255) then exit;
      Parts := Parts + 1;
      Cur := '';
    end else if (C >= '0') and (C <= '9') then Cur := Cur + C
    else exit;
  end;
  Result := Parts = 4;
end;

/// "sara.example.com", "https://sara.example.com/pair", "192.168.1.20:7860" → the origin the app
/// opens ('' when it isn't an address). Without a scheme: https, except for localhost, *.local
/// and IP addresses (a home network or Tailscale's 100.x addresses), which get http. The same rule
/// as Sara.exe's originOf.
function NormalizeServer(S: String): String;
var P, I: Integer; Sch, Rest, Host, Name, Port: String; C: Char;
begin
  Result := '';
  S := Trim(S);
  P := Pos('://', S);
  if P > 0 then begin
    Sch := Lowercase(Copy(S, 1, P - 1));
    Rest := Copy(S, P + 3, Length(S));
  end else begin
    Sch := '';
    Rest := S;
  end;
  if (Sch <> '') and (Sch <> 'http') and (Sch <> 'https') then exit;
  Host := Rest;
  for I := 1 to Length(Rest) do
    if (Rest[I] = '/') or (Rest[I] = '?') or (Rest[I] = '#') then begin
      Host := Copy(Rest, 1, I - 1);
      break;
    end;
  Host := Lowercase(Host);
  P := Pos(':', Host);
  if P > 0 then begin
    Name := Copy(Host, 1, P - 1);
    Port := Copy(Host, P + 1, Length(Host));
    if (StrToIntDef(Port, 0) < 1) or (StrToIntDef(Port, 0) > 65535) or (IntToStr(StrToIntDef(Port, 0)) <> Port) then exit;
  end else Name := Host;
  if (Name = '') or (Copy(Name, 1, 1) = '.') or (Copy(Name, Length(Name), 1) = '.') then exit;
  for I := 1 to Length(Name) do begin
    C := Name[I];
    if not (((C >= 'a') and (C <= 'z')) or ((C >= '0') and (C <= '9')) or (C = '-') or (C = '.')) then exit;
  end;
  if Sch = '' then begin
    if (Name = 'localhost') or IsIPv4(Name) or ((Length(Name) > 6) and (Copy(Name, Length(Name) - 5, 6) = '.local')) then Sch := 'http'
    else Sch := 'https';
  end;
  Result := Sch + '://' + Host;
end;

function AppIni: String;
begin
  Result := ExpandConstant('{#AppData}\desktop.ini');
end;

function AppServer: String;
begin
  Result := GetIniString('sara', 'server', '', AppIni);
end;

// ---------- how Sara is installed (from the wizard, the command line, or the existing install) ----------
function HasSwitch(const S: String): Boolean;
var I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), S) = 0 then Result := True;
end;

/// What is installed already: 'remote', 'user', 'service' or ''.
function PrevMode: String;
var V: String;
begin
  Result := '';
  if RegQueryStringValue(HKCU, APP_KEY, 'Inno Setup CodeFile: Mode', V) and ((V = 'remote') or (V = 'user')) then Result := V
  else if RegKeyExists(HKCU, APP_KEY) then begin
    // Installed before Phase 55 (always with her server).
    Result := 'user';
    if RegQueryStringValue(HKCU, APP_KEY, 'InstallLocation', V) and not FileExists(AddBackslash(V) + 'sara.env') and not FileExists(AddBackslash(V) + 'SaraService.exe') then Result := 'remote';
  end;
  if (Result = '') and RegKeyExists(HKLM, APP_KEY) then Result := 'service';
end;

/// 'service', 'user' or 'remote'.
function ChosenMode: String;
begin
  if IsAdminInstallMode then Result := 'service'
  else if InstMode <> '' then Result := InstMode
  else if (UseRemote <> nil) and UseRemote.Checked then Result := 'remote'
  else Result := 'user';
end;

function IsRemote: Boolean;
begin
  Result := ChosenMode = 'remote';
end;

function ChosenServer: String;
begin
  if (RemotePage <> nil) and not WizardSilent then Result := NormalizeServer(RemotePage.Values[0])
  else begin
    Result := NormalizeServer(ExpandConstant('{param:SERVER|}'));
    if Result = '' then Result := NormalizeServer(AppServer);
  end;
end;

/// Setup's own command line again (without its internal switches), for the elevated restart.
function PassThroughParams: String;
var I: Integer; P, U: String;
begin
  Result := '';
  for I := 1 to ParamCount do begin
    P := ParamStr(I);
    U := Uppercase(P);
    if (Pos('/SL5=', U) = 1) or (Pos('/SPAWNWND=', U) = 1) or (Pos('/NOTIFYWND=', U) = 1) or (Pos('/DEBUGWND=', U) = 1) or
       (Pos('/MODE=', U) = 1) or (U = '/ALLUSERS') or (U = '/CURRENTUSER') then continue;
    if Pos(' ', P) > 0 then P := '"' + P + '"';
    Result := Result + ' ' + P;
  end;
end;

/// The service needs an administrator: start Setup again elevated, as the service install.
function RelaunchAsService: Boolean;
var Err: Integer;
begin
  Result := ShellExec('runas', ExpandConstant('{srcexe}'), '/ALLUSERS /MODE=service' + PassThroughParams, '', SW_SHOWNORMAL, ewNoWait, Err);
  Log('Starting Setup again as administrator (service): ' + IntToStr(Ord(Result)) + ' ' + IntToStr(Err));
end;

// ---------- choices (from the wizard, the command line, or the existing install) ----------
function ChosenAccess: String;
begin
  if WizardSilent then begin
    Result := Lowercase(ExpandConstant('{param:ACCESS|}'));
    if Result = '' then begin
      if TsState = 3 then Result := 'tailscale' else Result := 'local';
    end;
    exit;
  end;
  case AccessPage.SelectedValueIndex of
    0: Result := 'tailscale';
    2: Result := 'lan';
    3: Result := 'domain';
  else
    Result := 'local';
  end;
end;

function ChosenPort: Integer;
begin
  if WizardSilent then Result := StrToIntDef(ExpandConstant('{param:PORT|7860}'), 0)
  else Result := StrToIntDef(Trim(PortPage.Values[0]), 0);
end;

function PortStr(Param: String): String;
var P: String;
begin
  P := EnvValue(ExpandConstant('{app}\sara.env'), 'SARA_PORT');
  if P = '' then P := IntToStr(ChosenPort);
  Result := P;
end;

function OpenParams(Param: String): String;
begin
  if IsRemote then Result := '' else Result := '--server http://127.0.0.1:' + PortStr('');
end;

/// Phase 67: 'start' (private: nothing leaves this computer) or 'off'. Silent: /PRIVATE=1.
function ChosenPrivate: String;
begin
  if WizardSilent then begin
    if ExpandConstant('{param:PRIVATE|0}') = '1' then Result := 'start' else Result := 'off';
  end else if PrivacyPage.SelectedValueIndex = 0 then Result := 'start'
  else Result := 'off';
end;

function ChosenDomain: String;
begin
  if WizardSilent then Result := ExpandConstant('{param:DOMAIN|}') else Result := Trim(DomainPage.Values[0]);
end;

function ModeWord: String;
begin
  if IsAdminInstallMode then Result := 'service' else Result := 'user';
end;

function DataDir: String;
begin
  Result := ExpandConstant('{param:DATA|}');
  if Result <> '' then exit;
  if IsAdminInstallMode then Result := ExpandConstant('{commonappdata}\Sara')
  else Result := ExpandConstant('{localappdata}\Sara\data');
end;

// ---------- Tailscale ----------
procedure DetectTailscale;
var Cli, O, S2: String; P, E: Integer;
begin
  TsState := 0;
  TsName := '';
  Cli := ExpandConstant('{commonpf64}\Tailscale\tailscale.exe');
  if not FileExists(Cli) then exit;
  TsState := 1;
  Run(Cli, 'status --json', '', O);
  if Pos('"BackendState": "Running"', O) = 0 then exit;
  TsState := 2;
  P := Pos('"Self": {', O);
  if P > 0 then begin
    S2 := Copy(O, P, Length(O));
    P := Pos('"DNSName": "', S2);
    if P > 0 then begin
      S2 := Copy(S2, P + 12, Length(S2));
      E := Pos('"', S2);
      TsName := Copy(S2, 1, E - 1);
      if Copy(TsName, Length(TsName), 1) = '.' then TsName := Copy(TsName, 1, Length(TsName) - 1);
    end;
  end;
  if (Pos('"CertDomains": [', O) > 0) and (TsName <> '') then TsState := 3;
end;

function TsMessage: String;
begin
  case TsState of
    0: Result := 'Tailscale isn''t installed. It''s free (tailscale.com/download) and the easy way to reach her from your phone anywhere; you can switch to it later with: sara access tailscale';
    1: Result := 'Tailscale is installed but not signed in or switched off. Open Tailscale and sign in, then choose it here.';
    2: Result := 'Tailscale needs HTTPS turned on once: login.tailscale.com/admin/dns → Enable HTTPS. Then choose it here.';
  else
    Result := 'Tailscale is ready: she''ll be at https://' + TsName + ' on your devices that use Tailscale.';
  end;
end;

// ---------- wizard ----------
function InitializeSetup: Boolean;
var M, P: String;
begin
  Result := True;
  M := Lowercase(ExpandConstant('{param:MODE|}'));
  if (M <> '') and (M <> 'service') and (M <> 'user') and (M <> 'remote') then begin
    SuppressibleMsgBox('/MODE must be service, user or remote.', mbError, MB_OK, IDOK);
    Result := False;
    exit;
  end;
  if IsAdminInstallMode then begin
    if (M = 'user') or (M = 'remote') then begin
      if M = 'user' then
        SuppressibleMsgBox('/MODE=user needs /CURRENTUSER too (only while you''re signed in, no administrator).', mbError, MB_OK, IDOK)
      else
        SuppressibleMsgBox('/MODE=remote installs only the app for you: leave out /ALLUSERS (no administrator needed).', mbError, MB_OK, IDOK);
      Result := False;
      exit;
    end;
    InstMode := 'service';
    exit;
  end;
  if M = 'service' then begin
    SuppressibleMsgBox('/MODE=service needs /ALLUSERS too (a Windows service, needs an administrator).', mbError, MB_OK, IDOK);
    Result := False;
    exit;
  end;
  P := PrevMode;
  if (M = '') and WizardSilent then begin
    if (P = 'remote') or (P = 'user') then M := P
    else if HasSwitch('/CURRENTUSER') then M := 'user'
    else begin
      // As before Phase 55: a silent install without a choice is the service (asks for administrator).
      if not RelaunchAsService then SuppressibleMsgBox('Sara''s service needs an administrator. Run this again as administrator, or add /CURRENTUSER (only while you''re signed in) or /MODE=remote /SERVER=<address> (the app only).', mbError, MB_OK, IDOK);
      Result := False;
      exit;
    end;
  end;
  if M = 'remote' then begin
    if (P = 'user') or (P = 'service') then begin
      SuppressibleMsgBox('Sara''s server is installed on this computer. Uninstall it first (her data stays), then install the app only.', mbError, MB_OK, IDOK);
      Result := False;
      exit;
    end;
    if (ExpandConstant('{param:SERVER|}') <> '') and (NormalizeServer(ExpandConstant('{param:SERVER|}')) = '') then begin
      SuppressibleMsgBox('/SERVER must be an address like sara.example.com or https://sara.example.com.', mbError, MB_OK, IDOK);
      Result := False;
      exit;
    end;
    if WizardSilent and (NormalizeServer(ExpandConstant('{param:SERVER|}')) = '') and (NormalizeServer(AppServer) = '') then begin
      SuppressibleMsgBox('/MODE=remote needs /SERVER=<address>, for example /SERVER=sara.example.com.', mbError, MB_OK, IDOK);
      Result := False;
      exit;
    end;
  end;
  InstMode := M;
end;

function UseLabel(Page: TWizardPage; const Text: String; Top: Integer): TNewStaticText;
begin
  Result := TNewStaticText.Create(Page);
  Result.Parent := Page.Surface;
  Result.AutoSize := False;
  Result.WordWrap := True;
  Result.Left := ScaleX(22);
  Result.Width := Page.SurfaceWidth - ScaleX(22);
  Result.Top := Top;
  Result.Height := ScaleY(44);
  Result.Caption := Text;
end;

function UseRadio(Page: TWizardPage; const Text: String; Top: Integer): TNewRadioButton;
begin
  Result := TNewRadioButton.Create(Page);
  Result.Parent := Page.Surface;
  Result.Top := Top;
  Result.Width := Page.SurfaceWidth;
  Result.Height := ScaleY(22);
  Result.Font.Style := [fsBold];
  Result.Font.Size := 10;
  Result.Caption := Text;
end;

procedure InitializeWizard;
var Free: Integer; Prev, Addr: String; L: TNewStaticText;
begin
  IsUpgrade := FileExists(WizardDirValue + '\sara.env');
  Prev := PrevMode;
  DetectTailscale;

  // 1. How do you want to use Sara?
  UsePage := CreateCustomPage(wpWelcome, 'How do you want to use Sara?',
    'Pick one. You can change it later by running this installer again.');
  UseLocal := UseRadio(UsePage, 'Run Sara on this computer', ScaleY(8));
  L := UseLabel(UsePage, 'Installs her server (where her memories and settings live) and the Sara app. Your phone and other devices connect to this computer.', ScaleY(32));
  UseRemote := UseRadio(UsePage, 'Connect to a Sara somewhere else', ScaleY(96));
  L := UseLabel(UsePage, 'Installs only the Sara app, for a Sara that already runs on another computer or server. Nothing else is installed and no administrator is needed.', ScaleY(120));
  if Prev = 'remote' then UseRemote.Checked := True else UseLocal.Checked := True;
  if (Prev = 'user') or (Prev = 'service') then
    L := UseLabel(UsePage, 'Sara''s server is installed on this computer now: choosing "Run Sara on this computer" updates it.', ScaleY(184))
  else if Prev = 'remote' then
    L := UseLabel(UsePage, 'The Sara app is installed now (connected to ' + AppServer + '): choosing it again updates the app.', ScaleY(184));

  // 2. How should Sara run? (on this computer, a first install)
  RunPage := CreateInputOptionPage(UsePage.ID, 'How should Sara run?',
    'She can be there for your phone from when the computer starts, or only while you''re signed in.',
    'The service starts before anyone signs in, so your phone reaches her even after a restart. Windows asks for an administrator for it.', True, False);
  RunPage.Add('From when the computer starts, as a Windows service (recommended; needs an administrator)');
  RunPage.Add('Only while I''m signed in (no administrator needed)');
  RunPage.SelectedValueIndex := 0;

  // Remote: where is your Sara?
  RemotePage := CreateInputQueryPage(RunPage.ID, 'Where is your Sara?',
    'Type the address you open her at in a web browser.',
    'For example sara.example.com or https://sara.example.com. An address at home like 192.168.1.20:7860 works too.' + #13#10#13#10 +
    'After installing, you sign in with a code: on a phone or computer where you''re already signed in, open Settings → Connections → Devices and sign-in → Add a phone or computer.');
  RemotePage.Add('Address:', False);
  Addr := ExpandConstant('{param:SERVER|}');
  if Addr = '' then Addr := AppServer;
  RemotePage.Values[0] := Addr;

  AccessPage := CreateInputOptionPage(RemotePage.ID, 'How will you reach her?',
    'Pick how you''ll open Sara on your phone and other devices.',
    'You can change this later with the sara access command.', True, False);
  AccessPage.Add('Tailscale: private, from your own devices anywhere (HTTPS)');
  AccessPage.Add('Just this computer');
  AccessPage.Add('My home network (plain HTTP: only on a network you trust)');
  AccessPage.Add('My own web address (you set up HTTPS yourself)');
  if TsState = 3 then AccessPage.SelectedValueIndex := 0 else AccessPage.SelectedValueIndex := 1;
  TsLabel := TNewStaticText.Create(AccessPage);
  TsLabel.Parent := AccessPage.Surface;
  TsLabel.AutoSize := False;
  TsLabel.WordWrap := True;
  TsLabel.Width := AccessPage.SurfaceWidth;
  TsLabel.Height := ScaleY(48);
  TsLabel.Top := AccessPage.CheckListBox.Top + AccessPage.CheckListBox.Height + ScaleY(8);
  TsLabel.Caption := TsMessage;

  DomainPage := CreateInputQueryPage(AccessPage.ID, 'Your web address',
    'Which address will you use for her?',
    'For example sara.example.com. Windows doesn''t come with a web server, so you set up HTTPS yourself: ' +
    'point your web server (or tunnel) at Sara on this computer. The guide: ' + GUIDE_URL);
  DomainPage.Add('Web address:', False);

  PortPage := CreateInputQueryPage(DomainPage.ID, 'Port',
    'Which port should she use on this computer?',
    'Most people keep the number shown. Pick another only if something else on this computer needs it.');
  PortPage.Add('Port:', False);
  Free := 7860;
  while (Free < 7900) and not PortFree(Free) do Free := Free + 1;
  PortPage.Values[0] := IntToStr(Free);

  // Phase 67: may her AI use the internet? Private passes SARA_PRIVATE_LOCAL=start to sara.env:
  // "Nothing leaves this computer" is on from the first start until the owner turns it off.
  PrivacyPage := CreateInputOptionPage(PortPage.ID, 'Where may Sara''s AI run?',
    'Choose whether Sara may use the internet.',
    'You can change this later in Settings → Models → On this computer.', True, False);
  PrivacyPage.Add('Private: everything on this computer (an AI model runs here, nothing goes to the internet)');
  PrivacyPage.Add('Use cloud models too (for example OpenAI, Anthropic or Ollama Cloud, and web search)');
  PrivacyPage.SelectedValueIndex := 1;

  DonePage := CreateCustomPage(wpInfoAfter, 'Sara is ready', 'Two things to keep, then open her.');
  DoneIntro := TNewStaticText.Create(DonePage);
  DoneIntro.Parent := DonePage.Surface;
  DoneIntro.AutoSize := False;
  DoneIntro.WordWrap := True;
  DoneIntro.Width := DonePage.SurfaceWidth;
  DoneIntro.Height := ScaleY(30);
  DoneAddress := TNewStaticText.Create(DonePage);
  DoneAddress.Parent := DonePage.Surface;
  DoneAddress.AutoSize := False;
  DoneAddress.WordWrap := True;
  DoneAddress.Width := DonePage.SurfaceWidth;
  DoneAddress.Top := ScaleY(32);
  DoneAddress.Height := ScaleY(44);
  DoneTokenLabel := TNewStaticText.Create(DonePage);
  DoneTokenLabel.Parent := DonePage.Surface;
  DoneTokenLabel.Top := ScaleY(82);
  DoneTokenLabel.Caption := 'Your owner token (you sign in with it once):';
  TokenEdit := TNewEdit.Create(DonePage);
  TokenEdit.Parent := DonePage.Surface;
  TokenEdit.Top := ScaleY(100);
  TokenEdit.Width := DonePage.SurfaceWidth - ScaleX(90);
  TokenEdit.ReadOnly := True;
  CopyButton := TNewButton.Create(DonePage);
  CopyButton.Parent := DonePage.Surface;
  CopyButton.Caption := 'Copy';
  CopyButton.Top := TokenEdit.Top - ScaleY(1);
  CopyButton.Left := DonePage.SurfaceWidth - ScaleX(80);
  CopyButton.Width := ScaleX(80);
  CopyButton.Height := TokenEdit.Height + ScaleY(2);
  DoneKeep := TNewStaticText.Create(DonePage);
  DoneKeep.Parent := DonePage.Surface;
  DoneKeep.AutoSize := False;
  DoneKeep.WordWrap := True;
  DoneKeep.Width := DonePage.SurfaceWidth;
  DoneKeep.Top := ScaleY(132);
  DoneKeep.Height := ScaleY(46);
  DoneAsks := TNewStaticText.Create(DonePage);
  DoneAsks.Parent := DonePage.Surface;
  DoneAsks.AutoSize := False;
  DoneAsks.WordWrap := True;
  DoneAsks.Width := DonePage.SurfaceWidth;
  DoneAsks.Top := ScaleY(184);
  DoneAsks.Height := ScaleY(46);
  DoneAsks.Caption := 'Windows has no sandbox for her commands, so she asks you before every command she runs on this computer.';
end;

procedure CopyTokenClick(Sender: TObject);
begin
  SendMessage(TokenEdit.Handle, EM_SETSEL, 0, -1);
  SendMessage(TokenEdit.Handle, WM_COPY, 0, 0);
  CopyButton.Caption := 'Copied';
end;

function ShouldSkipPage(PageID: Integer): Boolean;
var Prev: String;
begin
  Result := False;
  Prev := PrevMode;
  // Fixed by /MODE or /ALLUSERS (also the elevated restart for the service): no first questions.
  if (PageID = UsePage.ID) and (IsAdminInstallMode or (InstMode <> '')) then Result := True;
  if (PageID = RunPage.ID) and (IsAdminInstallMode or (InstMode <> '') or IsRemote or (Prev = 'user') or (Prev = 'service')) then Result := True;
  if (PageID = RemotePage.ID) and not IsRemote then Result := True;
  if IsRemote and ((PageID = AccessPage.ID) or (PageID = DomainPage.ID) or (PageID = PortPage.ID) or (PageID = DonePage.ID)) then Result := True;
  if IsUpgrade and ((PageID = AccessPage.ID) or (PageID = DomainPage.ID) or (PageID = PortPage.ID)) then Result := True;
  if (PageID = DomainPage.ID) and (AccessPage.SelectedValueIndex <> 3) then Result := True;
  if (PageID = PrivacyPage.ID) and (IsRemote or IsUpgrade) then Result := True;
end;

/// Start Setup again as administrator for the service, and close this one.
function GoService: Boolean;
begin
  Result := False;
  if RelaunchAsService then begin
    Relaunching := True;
    WizardForm.Close;
  end else
    MsgBox('Windows didn''t give Setup administrator rights, so Sara can''t be set up as a service. Try again, or choose "Only while I''m signed in".', mbInformation, MB_OK);
end;

procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  if Relaunching then Confirm := False;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var P: Integer; D, Prev: String;
begin
  Result := True;
  if CurPageID = UsePage.ID then begin
    Prev := PrevMode;
    if UseRemote.Checked and ((Prev = 'user') or (Prev = 'service')) then begin
      MsgBox('Sara''s server is installed on this computer, so the app is already here. To use it with a Sara somewhere else, open Sara and choose "Connect to a different Sara…" from her icon next to the clock.' + #13#10#13#10 +
        'To remove her server from this computer, uninstall Sara first (Settings → Apps → Sara; her data stays), then run this again.', mbInformation, MB_OK);
      Result := False;
    end else if UseLocal.Checked and (Prev = 'service') then
      Result := GoService;  // an update of the service install
  end;
  if (CurPageID = RunPage.ID) and (RunPage.SelectedValueIndex = 0) then Result := GoService;
  if CurPageID = RemotePage.ID then begin
    D := NormalizeServer(RemotePage.Values[0]);
    if D = '' then begin
      MsgBox('Type an address like sara.example.com or https://sara.example.com.', mbError, MB_OK);
      Result := False;
    end else begin
      RemotePage.Values[0] := D;
      if not HttpOk(D + '/api/health') then
        Result := MsgBox(D + ' isn''t answering right now.' + #13#10#13#10 + 'Use this address anyway? (Check it, or whether that Sara is running. You can change it later from her icon next to the clock: Connect to a different Sara…)', mbConfirmation, MB_YESNO) = IDYES;
    end;
  end;
  if CurPageID = AccessPage.ID then begin
    if (AccessPage.SelectedValueIndex = 0) and (TsState <> 3) then begin
      DetectTailscale;
      TsLabel.Caption := TsMessage;
      if TsState <> 3 then begin
        MsgBox(TsMessage, mbInformation, MB_OK);
        Result := False;
      end;
    end;
    if (AccessPage.SelectedValueIndex = 2) then
      Result := MsgBox('On your home network she is reached over plain HTTP: anyone on the same network could read what you send, including your sign-in. Use it only at home, on a network you trust. Go on?', mbConfirmation, MB_YESNO) = IDYES;
  end;
  if CurPageID = DomainPage.ID then begin
    D := Lowercase(Trim(DomainPage.Values[0]));
    StringChangeEx(D, 'https://', '', True);
    StringChangeEx(D, 'http://', '', True);
    if (D = '') or (Pos('.', D) = 0) or (Pos(' ', D) > 0) or (Pos('/', D) > 0) then begin
      MsgBox('Type a web address like sara.example.com.', mbError, MB_OK);
      Result := False;
    end else DomainPage.Values[0] := D;
  end;
  if CurPageID = PortPage.ID then begin
    P := StrToIntDef(Trim(PortPage.Values[0]), 0);
    if (P < 1024) or (P > 65535) then begin
      MsgBox('The port must be a number from 1024 to 65535.', mbError, MB_OK);
      Result := False;
    end else if not PortFree(P) then begin
      MsgBox('Something else on this computer is already using port ' + IntToStr(P) + '. Pick another number.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo, MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
var A: String;
begin
  if IsRemote then begin
    Result := 'What is installed:' + NewLine + Space + 'The Sara app only (no server, nothing else on this computer)' +
      NewLine + NewLine + 'It connects to:' + NewLine + Space + ChosenServer +
      NewLine + NewLine + 'Program:' + NewLine + Space + ExpandConstant('{app}');
    exit;
  end;
  if IsUpgrade then begin
    Result := 'Update Sara to version {#AppVersion}.' + NewLine + NewLine +
      'A backup is made first. Her data, settings, how she runs and how you reach her stay as they are.';
    exit;
  end;
  if IsAdminInstallMode then Result := 'How she runs:' + NewLine + Space + 'As a Windows service, from when the computer starts'
  else Result := 'How she runs:' + NewLine + Space + 'Only while you''re signed in';
  A := ChosenAccess;
  if A = 'tailscale' then A := 'Tailscale (https://' + TsName + ')'
  else if A = 'lan' then A := 'Your home network (plain HTTP)'
  else if A = 'domain' then A := 'Your own web address (https://' + ChosenDomain + ')'
  else A := 'Just this computer';
  Result := Result + NewLine + NewLine + 'How you reach her:' + NewLine + Space + A +
    NewLine + NewLine + 'Port:' + NewLine + Space + IntToStr(ChosenPort) +
    NewLine + NewLine + 'Her data:' + NewLine + Space + DataDir +
    NewLine + NewLine + 'Program:' + NewLine + Space + ExpandConstant('{app}');
end;

/// The other kind of install (service vs signed-in only) is already here: one at a time.
// Security review (M5): in service mode her data folder is C:\ProgramData\Sara, which any local
// user could create in advance (and so own: an owner can always change the permissions again,
// and a planted owner.json would be adopted). Before using it, a folder that isn't owned by
// Administrators, SYSTEM or a service account (or is a link) is moved aside and a fresh one made.
function DataDirTrusted(const Dir: String): Boolean;
var O, Ps: String;
begin
  Result := True;
  if not DirExists(Dir) then exit;
  Ps := '$p = ''' + Dir + '''; $i = Get-Item -LiteralPath $p -Force; ' +
    // The marker is built at run time, so an error message quoting this code never contains it.
    '$m = ''SARA'' + ''OWNER=''; ' +
    'if ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) { $m + ''LINK'' } ' +
    'else { $m + (Get-Acl -LiteralPath $p).GetOwner([Security.Principal.SecurityIdentifier]).Value }';
  Run(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' + Ps + '"', '', O);
  // Couldn't check (no PowerShell answer): keep it; SecureDataDir still takes ownership and locks it.
  if Pos('SARAOWNER=', O) = 0 then exit;
  Result := (Pos('SARAOWNER=S-1-5-32-544', O) > 0) or (Pos('SARAOWNER=S-1-5-18' + #13, O) > 0) or (Pos('SARAOWNER=S-1-5-18' + #10, O) > 0) or (Pos('SARAOWNER=S-1-5-80-', O) > 0);
end;

// Owner Administrators on everything, inherited permissions cleared, then only Windows itself,
// administrators (and the service, once it exists) on a protected list.
procedure SecureDataDir(const Dir: String; WithService: Boolean);
var O, Grants: String;
begin
  Grants := ' /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"';
  if WithService then Grants := Grants + ' "NT SERVICE\Sara:(OI)(CI)M"';
  Run(ExpandConstant('{sys}\icacls.exe'), Q(Dir) + ' /setowner *S-1-5-32-544 /T /C /Q', '', O);
  Run(ExpandConstant('{sys}\icacls.exe'), Q(Dir) + ' /reset /T /C /Q', '', O);
  Run(ExpandConstant('{sys}\icacls.exe'), Q(Dir) + Grants, '', O);
end;

// Moves an untrusted data folder aside (Sara-untrusted-<date>) and makes a fresh, locked one.
// Returns '' or a message why setup can't go on.
function PrepareServiceDataDir: String;
var Dir, Aside: String;
begin
  Result := '';
  if not IsAdminInstallMode then exit;
  Dir := RemoveBackslashUnlessRoot(DataDir);
  if not DataDirTrusted(Dir) then begin
    Aside := ExtractFileDir(Dir) + '\Sara-untrusted-' + GetDateTimeString('yyyymmdd-hhnnss', '-', '-');
    Log('Data folder ' + Dir + ' is not owned by Administrators/SYSTEM: moving it to ' + Aside);
    if not RenameFile(Dir, Aside) then begin
      Result := 'The folder ' + Dir + ' was made by another account, so Sara can''t trust it. Move or delete it (as administrator), then run this again.';
      exit;
    end;
    SetupNote := Trim(SetupNote + ' The data folder ' + Dir + ' was made by another account, so it was moved to ' + Aside + ' and Sara starts fresh. Check it, then delete it.');
  end;
  if not DirExists(Dir) then ForceDirectories(Dir);
  SecureDataDir(Dir, False);
end;

function OtherInstallExists: Boolean;
begin
  if IsAdminInstallMode then Result := RegKeyExists(HKCU, APP_KEY)
  else Result := RegKeyExists(HKLM, APP_KEY);
end;

/// The service install over this user's app-only (remote) install: that one is removed first
/// (only the app; it never had a server or data).
procedure RemoveRemoteApp;
var Unins: String; Code, I: Integer;
begin
  if not RegQueryStringValue(HKCU, APP_KEY, 'UninstallString', Unins) then exit;
  Unins := RemoveQuotes(Unins);
  Log('Removing the app-only install first: ' + Unins);
  Exec(Unins, '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART', '', SW_HIDE, ewWaitUntilTerminated, Code);
  // The uninstaller hands over to a copy of itself: wait until its entry is gone.
  for I := 1 to 120 do begin
    if not RegKeyExists(HKCU, APP_KEY) then break;
    Sleep(250);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var App, O: String; P: Integer;
begin
  Result := '';
  App := ExpandConstant('{app}');
  IsUpgrade := FileExists(App + '\sara.env');
  if IsRemote then begin
    // The app only. Never over a server install (that keeps its own app).
    if IsUpgrade or FileExists(App + '\SaraService.exe') or RegKeyExists(HKLM, APP_KEY) then begin
      Result := 'Sara''s server is installed on this computer. Uninstall it first (Settings → Apps → Sara; her data stays), then install the app only.';
      exit;
    end;
    if ChosenServer = '' then begin
      Result := 'Type the address of your Sara (for example sara.example.com).';
      exit;
    end;
    OldServer := NormalizeServer(AppServer);
    CloseDesktopApp;
    exit;
  end;
  WasRemote := RegKeyExists(HKCU, APP_KEY) and (PrevMode = 'remote');
  if IsAdminInstallMode and WasRemote then RemoveRemoteApp;
  if OtherInstallExists then begin
    if IsAdminInstallMode then
      Result := 'Sara is already installed to run only while you''re signed in. Uninstall that first (Settings → Apps → Sara; her data stays), then run this again.'
    else
      Result := 'Sara is already installed as a Windows service. Uninstall that first (Settings → Apps → Sara; her data stays), then run this again.';
    exit;
  end;
  CloseDesktopApp;
  if IsUpgrade then begin
    // Stop her, then a backup before any file is replaced.
    if FileExists(App + '\SaraService.exe') then Run(App + '\SaraService.exe', '--stop', App, O);
    if FileExists(App + '\node\node.exe') then begin
      if RunServerFlag(App, '--backup', O) <> 0 then begin
        if FileExists(App + '\SaraService.exe') then Run(App + '\SaraService.exe', '--start', App, O);
        Result := 'Sara couldn''t make a backup before updating, so nothing was changed. ' + O;
        exit;
      end;
      SetupNote := Trim(O);
    end;
  end;
  Result := PrepareServiceDataDir;
  if Result <> '' then exit;
  if not IsUpgrade then begin
    KeptData := FileExists(DataDir + '\owner.json');
    P := ChosenPort;
    if (P < 1024) or (P > 65535) then begin
      Result := 'The port must be a number from 1024 to 65535.';
      exit;
    end;
    if not PortFree(P) then begin
      Result := 'Something else on this computer is already using port ' + IntToStr(P) + '. Choose another port.';
      exit;
    end;
  end;
end;

procedure SeedDesktopApp(const Port: String; Force: Boolean);
var Ini, Cur: String;
begin
  // The app on this computer opens her local address, so you only paste the token. (Force: this
  // computer was set up for a Sara somewhere else until now, and now runs its own.)
  Ini := ExpandConstant('{#AppData}\desktop.ini');
  ForceDirectories(ExtractFileDir(Ini));
  Cur := GetIniString('sara', 'server', '', Ini);
  if Force or (Cur = '') or (Pos('http://127.0.0.1:', Cur) = 1) or (Pos('http://localhost:', Cur) = 1) then begin
    SetIniString('sara', 'server', 'http://127.0.0.1:' + Port, Ini);
    SetIniString('sara', 'lastServer', 'http://127.0.0.1:' + Port, Ini);
    // Her own server here: you sign in with the owner token, not a code.
    if GetIniString('sara', 'pairNext', '', Ini) <> '' then SetIniString('sara', 'pairNext', '', Ini);
  end;
end;

procedure TakeOverStandaloneApp(const App: String);
var Loc: String;
begin
  // A Sara.exe that installed itself into this same folder: this installer owns it now.
  if RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\SaraDesktop', 'InstallLocation', Loc) and
     (CompareText(RemoveBackslashUnlessRoot(Loc), RemoveBackslashUnlessRoot(App)) = 0) then
    RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\SaraDesktop');
end;

/// Remote mode: the app's server address, so its first start goes straight to pairing. A new
/// address forgets the old server's sign-in (the app's web view profile) too.
procedure SetUpRemoteApp(const App: String);
var Srv: String;
begin
  Srv := ChosenServer;
  if (OldServer <> '') and (OldServer <> Srv) then begin
    DelTree(ExpandConstant('{#AppData}\WebView'), True, True, True);
    Log('New server address: the old sign-in was removed.');
  end;
  ForceDirectories(ExtractFileDir(AppIni));
  SetIniString('sara', 'server', Srv, AppIni);
  SetIniString('sara', 'lastServer', Srv, AppIni);
  // Its first start opens her sign-in with a code (/pair) when the address is new.
  if OldServer <> Srv then SetIniString('sara', 'pairNext', '1', AppIni);
  TakeOverStandaloneApp(App);
  Log('App only, connected to ' + Srv);
end;

procedure RegisterPreviousData(PreviousDataKey: Integer);
begin
  SetPreviousData(PreviousDataKey, 'Mode', ChosenMode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var App, Node, Cli, Args, O, Data, Port, Url, TokenFile: String; I, P: Integer; Tok: AnsiString;
begin
  if CurStep <> ssPostInstall then exit;
  App := ExpandConstant('{app}');
  if IsRemote then begin
    SetUpRemoteApp(App);
    exit;
  end;
  Node := App + '\node\node.exe';
  Cli := Q(App + '\server\src\sara-windows.ts');
  WizardForm.StatusLabel.Caption := 'Setting Sara up...';
  // 1. Her settings (sara.env) and how she's reached.
  Args := '--disable-warning=ExperimentalWarning ' + Cli + ' setup --mode ' + ModeWord + ' --data ' + Q(DataDir) +
    ' --port ' + IntToStr(ChosenPort) + ' --access ' + ChosenAccess;
  if ChosenAccess = 'domain' then Args := Args + ' --domain ' + Q(ChosenDomain);
  if IsUpgrade then Args := Args + ' --keep' else Args := Args + ' --private ' + ChosenPrivate;
  Run(Node, Args, App + '\server', O);
  P := Pos('ACCESS=', O);
  if P > 0 then O := Copy(O, 1, P - 1);
  if Pos('Kept her settings', O) = 0 then SetupNote := Trim(SetupNote + ' ' + Trim(O));
  Data := EnvValue(App + '\sara.env', 'SARA_DATA');
  Port := EnvValue(App + '\sara.env', 'SARA_PORT');
  Url := EnvValue(App + '\sara.env', 'SARA_PUBLIC_URL');
  if Port = '' then Port := '7860';
  if Url = '' then Url := 'http://127.0.0.1:' + Port;
  FinalUrl := Url;
  // 2. The service (or the sign-in start), the data folder's permissions, the sara command.
  if IsAdminInstallMode then begin
    WizardForm.StatusLabel.Caption := 'Setting up the Sara service...';
    if Run(App + '\SaraService.exe', '--install-service', App, O) <> 0 then SetupNote := SetupNote + #13#10 + 'The service could not be set up: ' + O;
    // C9 for the service: the Sara Update task (SYSTEM, on demand; the service may only start it) runs
    // server\src\update-service.ts, so Settings → Updates → Update now works without the download page.
    // This installer is kept in {app}\updater\keep for going back (only administrators can change it).
    ForceDirectories(App + '\updater\keep');
    if not FileCopy(ExpandConstant('{srcexe}'), App + '\updater\keep\Sara-Setup-{#AppVersion}.exe', False) then Log('Could not keep this installer for going back.');
    if Run(Node, '--disable-warning=ExperimentalWarning ' + Cli + ' updater-task install', App + '\server', O) <> 0 then
      SetupNote := SetupNote + #13#10 + 'Updates from Settings could not be set up (' + Trim(O) + '); download new versions from the release page instead.';
    // Only the service, administrators and Windows itself may read her data (keys, conversations):
    // owner Administrators, nothing inherited, a protected list (NT SERVICE\Sara:(OI)(CI)M).
    SecureDataDir(Data, True);
  end;
  AddToPath(App + '\bin');
  TakeOverStandaloneApp(App);
  SeedDesktopApp(Port, WasRemote);
  // 3. Start her and wait for her first answer (and, on a first install, the owner token).
  WizardForm.StatusLabel.Caption := 'Starting Sara...';
  Run(App + '\SaraService.exe', '--start', App, O);
  StartedOk := False;
  for I := 1 to 60 do begin
    if HttpOk('http://127.0.0.1:' + Port + '/api/health') then begin StartedOk := True; break; end;
    Sleep(500);
  end;
  Token := '';
  TokenFile := Data + '\first-token.txt';
  if StartedOk and not IsUpgrade and not KeptData then
    for I := 1 to 30 do begin
      if FileExists(TokenFile) and LoadStringFromFile(TokenFile, Tok) then begin
        Token := Trim(String(Tok));
        if Token <> '' then break;
      end;
      Sleep(500);
    end;
  Log('Sara started: ' + IntToStr(Ord(StartedOk)) + '; address ' + FinalUrl + '; token shown: ' + IntToStr(Ord(Token <> '')));
end;

function AdminWords: String;
begin
  if IsAdminInstallMode then Result := ' opened as administrator' else Result := '';
end;

procedure CurPageChanged(CurPageID: Integer);
var Local: String;
begin
  if (CurPageID = wpFinished) and IsRemote then begin
    WizardForm.FinishedHeadingLabel.Caption := 'The Sara app is installed';
    WizardForm.FinishedLabel.Caption := 'It connects to ' + ChosenServer + '.' + #13#10#13#10 +
      'Next: open Sara and sign in with a code. On a phone or computer where you''re already signed in to her, open Settings → Connections → Devices and sign-in → Add a phone or computer, and type the code in the app.' + #13#10#13#10 +
      'Moved, or a different Sara? Right-click her icon next to the clock → Connect to a different Sara…';
    // The longer text pushes "Open Sara" down instead of covering it.
    WizardForm.FinishedLabel.AdjustHeight;
    WizardForm.RunList.Top := WizardForm.FinishedLabel.Top + WizardForm.FinishedLabel.Height + ScaleY(12);
  end;
  if CurPageID = DonePage.ID then begin
    Local := 'http://127.0.0.1:' + PortStr('');
    if not StartedOk then
      DoneIntro.Caption := 'Sara is installed but didn''t answer yet. Run "sara status" and "sara logs" in a new terminal to see why.'
    else if IsUpgrade then
      DoneIntro.Caption := 'Sara is updated. Her data and settings are as they were; sign in as before.'
    else if KeptData and (Token = '') then
      DoneIntro.Caption := 'Sara is running, with the data she had before: sign in with your owner token as before.'
    else
      DoneIntro.Caption := 'Sara is running.';
    if FinalUrl <> Local then
      DoneAddress.Caption := 'Open her at ' + FinalUrl + ' on your phone and other devices, and at ' + Local + ' on this computer (the Sara app is already set to it).'
    else
      DoneAddress.Caption := 'Open her at ' + Local + ' (the Sara app is already set to it).';
    if SetupNote <> '' then DoneAddress.Caption := DoneAddress.Caption + ' ' + Trim(SetupNote);
    if Token <> '' then begin
      TokenEdit.Text := Token;
      CopyButton.OnClick := @CopyTokenClick;
      DoneKeep.Caption := 'Keep it in a password manager: it is the key to everything she knows. It is shown only now. Lost it? Run "sara reset-token" in a terminal' +
        AdminWords + '.';
    end else begin
      DoneTokenLabel.Visible := False;
      TokenEdit.Visible := False;
      CopyButton.Visible := False;
      if IsUpgrade or KeptData then
        DoneKeep.Caption := 'Your owner token hasn''t changed. Lost it? Run "sara reset-token" in a terminal' + AdminWords + '.'
      else
        DoneKeep.Caption := 'Her owner token isn''t ready yet. Run "sara reset-token" in a new terminal' + AdminWords + ' to get one.';
    end;
  end;
end;

// ---------- uninstall ----------
/// The app only (connected to a Sara somewhere else): no server, no data here.
function UninstallingAppOnly: Boolean;
var App: String;
begin
  App := ExpandConstant('{app}');
  Result := not FileExists(App + '\sara.env') and not FileExists(App + '\SaraService.exe');
end;

function InitializeUninstall: Boolean;
var Form: TSetupForm; Box: TNewCheckBox; Msg: TNewStaticText; OkB, CancelB: TNewButton;
begin
  Result := True;
  DeleteData := (ExpandConstant('{param:DELETEDATA|0}') = '1') and not UninstallingAppOnly;
  if UninstallSilent then exit;
  Form := CreateCustomForm(ScaleX(420), ScaleY(170), False, True);
  try
    Form.Caption := 'Uninstall Sara';
    Msg := TNewStaticText.Create(Form);
    Msg.Parent := Form;
    Msg.AutoSize := False;
    Msg.WordWrap := True;
    Msg.Left := ScaleX(12);
    Msg.Top := ScaleY(12);
    Msg.Width := Form.ClientWidth - ScaleX(24);
    Msg.Height := ScaleY(48);
    if UninstallingAppOnly then
      Msg.Caption := 'This removes the Sara app from this computer: its shortcut, its settings and its sign-in here. Your Sara and everything she knows stay where she runs; nothing there changes.'
    else
      Msg.Caption := 'This removes Sara and the Sara app from this computer. Her data (conversations, memories, settings, keys) stays, so installing again later picks it up.';
    Box := TNewCheckBox.Create(Form);
    Box.Parent := Form;
    Box.Left := ScaleX(12);
    Box.Top := ScaleY(66);
    Box.Width := Form.ClientWidth - ScaleX(24);
    Box.Height := ScaleY(36);
    Box.Caption := 'Also delete her data (a last backup goes to your Desktop first)';
    Box.Checked := DeleteData;
    Box.Visible := not UninstallingAppOnly;
    OkB := TNewButton.Create(Form);
    OkB.Parent := Form;
    OkB.Caption := 'Uninstall';
    OkB.ModalResult := mrOk;
    OkB.Default := True;
    OkB.Width := ScaleX(90);
    OkB.Height := ScaleY(25);
    OkB.Top := Form.ClientHeight - ScaleY(25 + 12);
    OkB.Left := Form.ClientWidth - ScaleX(90 + 8 + 90 + 12);
    CancelB := TNewButton.Create(Form);
    CancelB.Parent := Form;
    CancelB.Caption := 'Cancel';
    CancelB.ModalResult := mrCancel;
    CancelB.Cancel := True;
    CancelB.Width := ScaleX(90);
    CancelB.Height := ScaleY(25);
    CancelB.Top := OkB.Top;
    CancelB.Left := Form.ClientWidth - ScaleX(90 + 12);
    Form.ActiveControl := CancelB;
    Result := Form.ShowModal = mrOk;
    DeleteData := Box.Checked;
  finally
    Form.Free;
  end;
end;

var
  UninstData: String;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var App, O, Backup: String;
begin
  App := ExpandConstant('{app}');
  if CurUninstallStep = usUninstall then begin
    UninstData := EnvValue(App + '\sara.env', 'SARA_DATA');
    CloseDesktopApp;
    if DeleteData and (UninstData <> '') and DirExists(UninstData) then begin
      Backup := ExpandConstant('{userdesktop}') + '\Sara-last-backup-' + GetDateTimeString('yyyymmdd-hhnnss', '-', ':') + '.tar.gz';
      if RunServerFlag(App, '--backup ' + Q(Backup), O) <> 0 then begin
        if UninstallSilent then DeleteData := False
        else DeleteData := MsgBox('A last backup couldn''t be made (' + Trim(O) + '). Delete her data anyway?', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
        if not DeleteData then Log('Last backup failed; keeping the data.');
      end else Log('Last backup: ' + Backup);
    end;
    if not UninstallingAppOnly then begin
      // Out of Tailscale serve and the firewall (Tailscale itself stays), then stop and remove her.
      if FileExists(App + '\node\node.exe') then
        Run(App + '\node\node.exe', '--disable-warning=ExperimentalWarning ' + Q(App + '\server\src\sara-windows.ts') + ' unconfigure', App + '\server', O);
      if FileExists(App + '\SaraService.exe') then begin
        Run(App + '\SaraService.exe', '--stop', App, O);
        if IsAdminInstallMode then Run(App + '\SaraService.exe', '--remove-service', App, O);
      end;
      // The Sara Update task (service installs) and the installers it kept.
      if IsAdminInstallMode and FileExists(App + '\node\node.exe') then
        Run(App + '\node\node.exe', '--disable-warning=ExperimentalWarning ' + Q(App + '\server\src\sara-windows.ts') + ' updater-task remove', App + '\server', O);
      RemoveFromPath(App + '\bin');
    end;
  end;
  if CurUninstallStep = usPostUninstall then begin
    // The app's "Start with Windows" entry (when it points at this copy).
    if RegQueryStringValue(HKCU, RUN_KEY, 'Sara', O) and (Pos(Uppercase(App), Uppercase(O)) > 0) then RegDeleteValue(HKCU, RUN_KEY, 'Sara');
    // The app's own files on this computer (its sign-in, window place).
    DeleteFile(ExpandConstant('{#AppData}\desktop.ini'));
    DeleteFile(ExpandConstant('{#AppData}\desktop.log'));
    DelTree(ExpandConstant('{#AppData}\WebView'), True, True, True);
    if DeleteData and (UninstData <> '') then begin
      DelTree(UninstData, True, True, True);
      Log('Deleted her data: ' + UninstData);
    end;
    RemoveDir(ExpandConstant('{#AppData}'));
  end;
end;
