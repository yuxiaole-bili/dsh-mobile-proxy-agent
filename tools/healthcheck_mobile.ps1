# Mobile DSH proxy health check -- one command, read-only.
#
#   & '.\tools\healthcheck_mobile.ps1'                 # full (incl. headless render)
#   & '.\tools\healthcheck_mobile.ps1' -SkipHeadless   # fast (~40s)
#
# NOTE: this file is deliberately pure ASCII. Windows PowerShell reads .ps1 files
# using the ANSI codepage, so non-ASCII literals in here would be mangled (and can
# break parsing outright). All human-readable output is written to the evidence log
# as UTF-8 instead.
#
# Checks: processes (proxy + watchdog), listener, 54-point protocol suite, hotpatch
# bundle syntax, sizes, real traffic on the phone path, headless render.
param(
  [switch]$SkipHeadless,
  [string]$OutDir = (Join-Path $PSScriptRoot '..\evidence')
)
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

$t = Join-Path $env:LOCALAPPDATA 'dsh-gui-forward'
$key = (Get-Content (Join-Path $t 'cap.key') -Raw).Trim()
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$fails = New-Object System.Collections.ArrayList
$log = New-Object System.Collections.ArrayList
function Say($s) { Write-Output $s; [void]$log.Add([string]$s) }
function Bad($s) { [void]$fails.Add([string]$s) }
function Section($n) { Say ''; Say "=== $n ===" }

Say "mobile proxy health check  $stamp"

Section '1. processes (proxy + watchdog)'
$procs = Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'" |
  Where-Object { $_.CommandLine -match 'proxy\.py|forward_watch\.py' }
$pProxy = $procs | Where-Object { $_.CommandLine -match 'proxy\.py' }
$pWatch = $procs | Where-Object { $_.CommandLine -match 'forward_watch\.py' }
foreach ($p in $procs) {
  $what = 'proxy'
  if ($p.CommandLine -match 'forward_watch') { $what = 'watchdog' }
  Say ("  {0,-9} pid={1} since={2}" -f $what, $p.ProcessId, $p.CreationDate)
}
if (-not $pProxy) { Bad 'proxy.py is NOT running' }
if (-not $pWatch) { Bad 'forward_watch.py (watchdog) is NOT running' }

Section '2. listener on 19390'
$lst = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq 19390 }
if ($lst) {
  $lst | ForEach-Object { Say ("  {0}:{1} pid={2}" -f $_.LocalAddress, $_.LocalPort, $_.OwningProcess) }
} else { Bad 'nothing is listening on 19390' }

Section '3. protocol suite (verify_takeover.py, 54 checks)'
$vout = python (Join-Path $PSScriptRoot 'verify_takeover.py') (Join-Path $OutDir "health_$stamp.txt") 2>&1
$summaryLine = ($vout | Select-String -Pattern 'SUMMARY:' | Select-Object -Last 1)
Say ("  " + (([string]$summaryLine).Trim()))
if (-not ([string]$summaryLine -match '(\d+)/(\d+) PASS')) {
  Bad 'protocol suite produced no summary line'
} elseif ($Matches[1] -ne $Matches[2]) {
  $fl = ($vout | Select-String -Pattern '^FAILED:') -join ' '
  Bad ("protocol suite has failures: " + $fl)
}

Section '4. hotpatch bundle syntax'
$pf = Join-Path $env:TEMP "hc_patch_$stamp.js"
curl.exe -s -H "Cookie: dshcap=$key" 'http://<PC-LAN-IP>:19390/__hot/patch.js' -o $pf
node --check $pf 2>&1 | Out-Null
$rc = $LASTEXITCODE
Say ("  patch.js bytes={0} node_check_exit={1}" -f (Get-Item $pf).Length, $rc)
if ($rc -ne 0) { Bad 'assembled /__hot/patch.js fails node --check (a syntax error breaks the whole bundle on the phone)' }

Section '5. sizes / cache growth'
function Get-SizeOf($p) {
  if (-not (Test-Path -LiteralPath $p)) { return 0 }
  if (Test-Path -LiteralPath $p -PathType Leaf) { return (Get-Item -LiteralPath $p).Length }
  $n = 0
  Get-ChildItem -LiteralPath $p -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { $n += $_.Length }
  return $n
}
foreach ($rel in 'proxy.log', 'apicache', 'hotpatch', 'DSH.apk') {
  Say ("  {0,-11} {1,9:N2} MB" -f $rel, ((Get-SizeOf (Join-Path $t $rel)) / 1MB))
}

Section '6. real traffic on the phone path (arrives via <SRV-LAN-IP> -> Tailscale)'
$tail = @(Get-Content (Join-Path $t 'proxy.log') -Tail 5000 -ErrorAction SilentlyContinue)
$phone = @($tail | Where-Object { $_ -match 'from 192\.168\.100\.1\b' })
Say ("  lines scanned={0}  phone-path requests={1}" -f $tail.Count, $phone.Count)
$phone | Select-Object -Last 3 | ForEach-Object { Say ("  last: " + ([string]$_).Trim()) }

if (-not $SkipHeadless) {
  Section '7. headless render (mobile UA, Promise.withResolvers removed first)'
  $h = @(node (Join-Path $t 'cdp_polytest.js') "http://<PC-LAN-IP>:19390/?k=$key" health 2>&1)
  $h | ForEach-Object { Say ("  " + [string]$_) }
  $joined = $h -join "`n"
  if ($joined -notmatch '"hasWithResolvers":"function"') { Bad 'polyfill did not restore Promise.withResolvers' }
  if ($joined -notmatch '"len":[1-9]') { Bad 'headless render produced no page text' }
  # The runner prints console errors after a Chinese label; match on error markers instead
  # (this file must stay ASCII, see the note at the top).
  if ($joined -match 'EXC:|Uncaught|TypeError|ReferenceError') { Bad 'headless render reported a JS error' }
} else {
  Section '7. headless render -- SKIPPED (-SkipHeadless)'
}

Section 'VERDICT'
if ($fails.Count -eq 0) {
  Say '  HEALTHY -- all checks passed'
} else {
  Say ("  PROBLEMS ({0}):" -f $fails.Count)
  $fails | ForEach-Object { Say ("   - " + $_) }
}
$dest = Join-Path $OutDir "healthcheck_$stamp.log"
[System.IO.File]::WriteAllLines($dest, $log, (New-Object System.Text.UTF8Encoding($false)))
Say ("  report: " + $dest)
if ($fails.Count -eq 0) { exit 0 } else { exit 1 }
