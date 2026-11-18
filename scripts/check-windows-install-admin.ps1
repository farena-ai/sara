# U1.3: the all-users (/ALLUSERS) cases of the Windows install matrix, which need an administrator.
# Uses ONLY the TestInstall build ("Sara update test"); refuses next to anything of a real Sara.
# Run in an administrator PowerShell from the repository:
#   powershell -ExecutionPolicy Bypass -File scripts\check-windows-install-admin.ps1 [-Setups outputs\windows-updtest]
# Writes outputs\checks\windows-admin-<date>.md and removes everything it installed.
# Note: the test build's Windows service is still named "Sara" and its update task \Sara\Update (the same
# names as a real Sara), which is why it refuses when either exists.
param([string]$Setups = (Join-Path $PSScriptRoot '..\outputs\windows-updtest'))
$ErrorActionPreference = 'Continue'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
$TestId = '{8C1D7E52-3F0A-4B6E-9D21-5A7B3C9E0F64}_is1'
$RealId = '{6F0B2C1E-7A51-4C8B-9E2D-3B5A0C9D4E17}_is1'
$Uninst = 'Software\Microsoft\Windows\CurrentVersion\Uninstall'
$AllDir = Join-Path $env:ProgramFiles 'SaraUpdTest'
$UserDir = Join-Path $env:LOCALAPPDATA 'Programs\SaraUpdTest'
$AppData = Join-Path $env:LOCALAPPDATA 'SaraUpdTest\data'
$SrvData = Join-Path $env:ProgramData 'SaraUpdTest'
$Date = Get-Date -Format 'yyyy-MM-dd'
$Logs = Join-Path $Root "outputs\checks\windows-admin-$Date-logs"
$Report = Join-Path $Root "outputs\checks\windows-admin-$Date.md"
New-Item -ItemType Directory -Force -Path $Logs | Out-Null
$rows = @(); $cleanup = @()

function Entry($hive, $id) { Get-ItemProperty -Path "$($hive):\$Uninst\$id" -ErrorAction SilentlyContinue }
function Count { @((Entry 'HKCU' $TestId), (Entry 'HKLM' $TestId) | Where-Object { $_ }).Count }
function Row($title, $problems, $notes) {
  $script:rows += [pscustomobject]@{ Title = $title; Problems = @($problems | Where-Object { $_ }); Notes = $notes }
  if ($problems) { Write-Host "FAIL  $title : $($problems -join '; ')" } else { Write-Host "pass  $title" }
}
function TestProcs { Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*\SaraUpdTest\*' } }
function StopTestApps { TestProcs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }
function RealEntries { "$(Entry 'HKCU' $RealId | ConvertTo-Json -Compress)|$(Entry 'HKLM' $RealId | ConvertTo-Json -Compress)" }
function FreePort { $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0); $l.Start(); $p = $l.LocalEndpoint.Port; $l.Stop(); $p }
function WaitGone($path) { for ($i = 0; $i -lt 120 -and (Test-Path $path); $i++) { Start-Sleep -Milliseconds 500 } }

# ---- guards
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Error 'Run this in an administrator PowerShell.'; exit 2 }
$why = @()
if (Get-Service -Name Sara -ErrorAction SilentlyContinue) { $why += 'a Windows service named Sara exists (the test build installs one of that name)' }
schtasks.exe /query /tn '\Sara\Update' *> $null; if ($LASTEXITCODE -eq 0) { $why += 'the \Sara\Update task exists' }
if (Test-Path (Join-Path $env:ProgramData 'Sara')) { $why += 'C:\ProgramData\Sara exists' }
if ((Entry 'HKLM' $RealId) -or (Entry 'HKCU' $RealId)) { $why += 'a real Sara is installed' }
if ((Count) -gt 0 -or (Test-Path $AllDir) -or (Test-Path $UserDir)) { $why += 'a test install (Sara update test) is already here: remove it first' }
if ($why) { Write-Error ("Not running: " + ($why -join '; ')); exit 2 }
$vers = Get-ChildItem $Setups -Filter 'Sara-Setup-*.exe' | ForEach-Object { if ($_.Name -match '^Sara-Setup-(\d+\.\d+\.\d+)\.exe$') { [version]$Matches[1] } } | Sort-Object
if (@($vers).Count -lt 2) { Write-Error "Need two TestInstall builds in $Setups"; exit 2 }
$B = "$($vers[-1])"; $A = "$($vers[-2])"
$real0 = RealEntries
$path0 = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$port = FreePort
$n = 0
function Setup($ver, $list) { $script:n++; $p = Start-Process -FilePath (Join-Path $Setups "Sara-Setup-$ver.exe") -ArgumentList ($list + "/LOG=`"$Logs\setup-$script:n.log`"") -Wait -PassThru; $p.ExitCode }

try {
  # 1. All users: the service, its own data folder (never C:\ProgramData\Sara), only on this computer.
  $code = Setup $B @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/ALLUSERS', '/MODE=service', '/ACCESS=local', "/PORT=$port", "/DATA=`"$SrvData`"")
  $p = @()
  if ((Count) -ne 1) { $p += "$(Count) uninstall entries, wanted 1" }
  $e = Entry 'HKLM' $TestId
  if (-not $e) { $p += 'no all-users entry' } elseif ($e.DisplayVersion -ne $B) { $p += "version $($e.DisplayVersion), wanted $B" }
  foreach ($f in 'Sara.exe', 'SaraService.exe', 'node\node.exe', 'unins000.exe') { if (-not (Test-Path (Join-Path $AllDir $f))) { $p += "$f missing" } }
  $svc = Get-Service -Name Sara -ErrorAction SilentlyContinue
  if (-not $svc -or $svc.Status -ne 'Running') { $p += 'the service is not running' }
  $health = $false; for ($i = 0; $i -lt 60 -and -not $health; $i++) { try { $health = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/api/health" -TimeoutSec 2).StatusCode -eq 200 } catch { Start-Sleep 1 } }
  if (-not $health) { $p += "no answer on 127.0.0.1:$port/api/health" }
  if (-not (Test-Path $SrvData)) { $p += 'her data folder was not made' }
  if ((RealEntries) -ne $real0) { $p += "the real Sara's entry changed" }
  Row 'All-users install (/ALLUSERS, the service)' $p @("Setup exit $code", "port $port", "data $SrvData")

  # 2. A per-user app-only copy next to it; the all-users app's start removes it silently, keeping data.
  $code = Setup $A @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/MODE=remote', '/CURRENTUSER', "/SERVER=http://127.0.0.1:$port")
  $two = Count
  $env:SARA_DESKTOP_TEST_DIR = $AppData
  Start-Process -FilePath (Join-Path $AllDir 'Sara.exe') -ArgumentList '--background' -WindowStyle Hidden | Out-Null
  for ($i = 0; $i -lt 120 -and (Entry 'HKCU' $TestId); $i++) { Start-Sleep -Milliseconds 500 }
  Start-Sleep 2
  StopTestApps
  Remove-Item Env:SARA_DESKTOP_TEST_DIR
  $p = @()
  if ($two -ne 2) { $p += "the per-user copy did not make a second entry ($two)" }
  if ((Count) -ne 1) { $p += "$(Count) uninstall entries after the start, wanted 1" }
  if (Entry 'HKCU' $TestId) { $p += 'the stale per-user copy is still listed' }
  if (-not (Test-Path (Join-Path $AppData 'desktop.ini'))) { $p += "the app's data (desktop.ini) was lost" }
  if ((RealEntries) -ne $real0) { $p += "the real Sara's entry changed" }
  Row 'A per-user copy next to the all-users one: removed on start, data kept' $p @("per-user Setup exit $code")

  # 3. All-users uninstall: entry, service, update task, PATH entry and program folder gone.
  Start-Process -FilePath (Join-Path $AllDir 'unins000.exe') -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait | Out-Null
  WaitGone (Join-Path $AllDir 'Sara.exe'); Start-Sleep 2
  $p = @()
  if ((Count) -ne 0) { $p += "$(Count) uninstall entries left" }
  if (Get-Service -Name Sara -ErrorAction SilentlyContinue) { $p += 'the service is still there' }
  schtasks.exe /query /tn '\Sara\Update' *> $null; if ($LASTEXITCODE -eq 0) { $p += 'the \Sara\Update task is still there' }
  if ([Environment]::GetEnvironmentVariable('Path', 'Machine') -like '*SaraUpdTest*') { $p += 'the PATH entry is still there' }
  if (Test-Path (Join-Path $AllDir 'Sara.exe')) { $p += 'Sara.exe still there' }
  if ((RealEntries) -ne $real0) { $p += "the real Sara's entry changed" }
  Row 'All-users uninstall (service, task, PATH and folder gone)' $p @("data kept at $SrvData until cleanup")
} finally {
  StopTestApps
  if (Test-Path (Join-Path $UserDir 'unins000.exe')) { Start-Process (Join-Path $UserDir 'unins000.exe') -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait; WaitGone (Join-Path $UserDir 'Sara.exe'); $cleanup += 'uninstalled the per-user test copy' }
  if (Test-Path (Join-Path $AllDir 'unins000.exe')) { Start-Process (Join-Path $AllDir 'unins000.exe') -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait; WaitGone (Join-Path $AllDir 'Sara.exe'); $cleanup += 'uninstalled the all-users test copy' }
  foreach ($d in $AllDir, $UserDir, (Join-Path $env:LOCALAPPDATA 'SaraUpdTest'), $SrvData) { if (Test-Path $d) { Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue; $cleanup += "removed $d" } }
  if ([Environment]::GetEnvironmentVariable('Path', 'Machine') -ne $path0) { $cleanup += 'WARNING: the system PATH differs from before the run' }
  if ((RealEntries) -eq $real0) { $cleanup += "the real Sara's uninstall entries are as before the run" } else { $cleanup += "WARNING: the real Sara's uninstall entries differ" }
}

$ok = @($rows | Where-Object { $_.Problems.Count -eq 0 }).Count
$md = @("# Windows install matrix, all-users cases - $Date", '', "Built by ``scripts/check-windows-install-admin.ps1`` (ROADMAP_U U1.3) with the TestInstall build only ($A, $B).", '', "**$ok of $($rows.Count) steps passed.**", '', '| Step | Result | Notes |', '|---|---|---|')
foreach ($r in $rows) { $md += "| $($r.Title) | $(if ($r.Problems.Count) { 'FAIL' } else { 'pass' }) | $((@($r.Problems) + @($r.Notes)) -join '; ') |" }
$md += @('', '## Cleanup', '') + ($cleanup | ForEach-Object { "- $_" })
New-Item -ItemType Directory -Force -Path (Split-Path $Report) | Out-Null
[IO.File]::WriteAllText($Report, ($md -join "`n") + "`n")
Write-Host "Report: $Report"
if ($ok -eq $rows.Count) { exit 0 } else { exit 1 }
