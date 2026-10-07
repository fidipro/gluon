<#
  install.ps1 against a local release directory (Windows PowerShell 5.1 or PowerShell 7): a good
  install, file://, a tampered exe and a missing SHA256SUMS (both fail with nothing installed), run
  through `iex` (the session is left as it was), and the BUG-1xx cases. With -HttpsBase (a running
  test/fixtures/https-release.ts serving the same exe) or -Fixture (this script starts that fixture:
  a .ts run by bun, or the fixture compiled to an .exe; the certificate comes from -OpenSsl), the https
  cases too. Everything happens in a
  scratch directory under %TEMP%; -AddToPath is never passed and GLUON_ADD_TO_PATH is cleared, so
  the user PATH and the registry are only read.

    powershell -NoProfile -ExecutionPolicy Bypass -File test\install-ps1.ps1 -Exe dist\gluon-bun-windows-x64.exe [-Fixture test\fixtures\https-release.ts | -HttpsBase https://localhost:8443]
#>
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$HttpsBase,
  [string]$Fixture,
  [string]$OpenSsl = (Join-Path $env:ProgramFiles 'Git\mingw64\bin\openssl.exe')
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$InformationPreference = 'Continue'

$installer = Join-Path (Split-Path -Parent $PSScriptRoot) 'install.ps1'
$Exe = (Resolve-Path -LiteralPath $Exe).Path
$scratch = Join-Path ([IO.Path]::GetTempPath()) ("gluon-ps1-test-" + [Guid]::NewGuid().ToString('N'))
$asset = 'gluon-bun-windows-x64.exe'
$failures = 0
$pathBefore = (Get-Item -LiteralPath 'HKCU:\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')

function Build-Release([string]$Name, [switch]$Tamper, [switch]$NoSums, [switch]$Crlf) {
  $dir = Join-Path $scratch $Name
  New-Item -ItemType Directory -Path $dir | Out-Null
  Copy-Item -LiteralPath $Exe -Destination (Join-Path $dir $asset)
  $hash = (Get-FileHash -LiteralPath $Exe -Algorithm SHA256).Hash.ToLowerInvariant()
  $eol = if ($Crlf) { "`r`n" } else { "`n" }
  if (-not $NoSums) { [IO.File]::WriteAllText((Join-Path $dir 'SHA256SUMS'), "0000  other-file$eol$hash  $asset$eol") }
  if ($Tamper) { Add-Content -LiteralPath (Join-Path $dir $asset) -Value 'tampered' }
  return $dir
}

# Runs install.ps1 in a child PowerShell (the same edition as this one), from a script file that
# first runs $Prelude; $Iex runs it as `iex (the script's text)`. Returns exit code and output.
function Invoke-Installer([string]$ReleaseUrl, [string]$InstallDir, [string]$Prelude = '', [switch]$Iex, [hashtable]$Env = @{}) {
  $env:GLUON_RELEASE_URL = $ReleaseUrl
  $env:GLUON_INSTALL_DIR = $InstallDir
  $env:GLUON_ADD_TO_PATH = $null
  $env:GLUON_VERSION = $null
  foreach ($k in $Env.Keys) { Set-Item -LiteralPath "Env:$k" -Value $Env[$k] }
  $run = if ($Iex) { "iex (Get-Content -Raw -LiteralPath '$installer')" } else { "& '$installer'" }
  $child = Join-Path $scratch ("run-" + [Guid]::NewGuid().ToString('N') + '.ps1')
  [IO.File]::WriteAllText($child, "$Prelude`r`n$run`r`n")
  $ps = (Get-Process -Id $PID).Path
  # Windows PowerShell 5.1 turns a native command's stderr into an error record: not fatal here.
  $ErrorActionPreference = 'Continue'
  $out = & $ps -NoProfile -ExecutionPolicy Bypass -File $child 2>&1 | Out-String
  $code = $LASTEXITCODE
  foreach ($k in $Env.Keys) { Remove-Item -LiteralPath "Env:$k" -ErrorAction SilentlyContinue }
  return @{ Code = $code; Out = $out }
}

function Test-Case([string]$Name, [bool]$Ok, [string]$Detail) {
  if ($Ok) { Write-Information "ok    $Name" } else { $script:failures++; Write-Information "FAIL  $Name`n$Detail" }
}

function Test-Same([string]$Path) {
  (Test-Path -LiteralPath $Path) -and ((Get-FileHash -LiteralPath $Path).Hash -eq (Get-FileHash -LiteralPath $Exe).Hash)
}

# The session's state after the installer ran through iex, in the child: strict mode, preferences,
# TLS protocols and the installer's names must be as before (BUG-120).
$leakCheck = @'
$gluonBefore = @{ EA = $ErrorActionPreference; PP = $ProgressPreference; IP = $InformationPreference; TLS = [Net.ServicePointManager]::SecurityProtocol }
$gluonVars = @(Get-Variable -Scope Local | ForEach-Object { $_.Name })
try { __RUN__ } catch { Write-Output "INSTALLER-THREW: $($_.Exception.Message)" }
$strict = try { $null = $gluonNoSuchVariable.Length; 'off' } catch { 'on' }
$leaks = @(Get-Variable -Scope Local | ForEach-Object { $_.Name } | Where-Object { $gluonVars -notcontains $_ -and $_ -notin @('gluonVars', 'strict', 'gluonBefore', 'leaks', 'fns', 'LASTEXITCODE', 'Error', '_', 'args', 'input', 'PSItem', 'Matches', '?', '^', '$', 'StackTrace', 'foreach', 'switch', 'this', 'true', 'false', 'null') })
$fns = @(Get-ChildItem Function: | Where-Object { $_.Name -in @('Exit-Install', 'Get-ReleaseFile', 'Save-HttpsFile') })
$same = $ErrorActionPreference -eq $gluonBefore.EA -and $ProgressPreference -eq $gluonBefore.PP -and $InformationPreference -eq $gluonBefore.IP -and [Net.ServicePointManager]::SecurityProtocol -eq $gluonBefore.TLS
Write-Output "STATE strict=$strict same=$same leaks=[$($leaks -join ',')] functions=$($fns.Count)"
'@

New-Item -ItemType Directory -Path $scratch | Out-Null
$server = $null
try {
  if ($Fixture) {
    $fx = Join-Path $scratch 'fixture'
    New-Item -ItemType Directory -Path (Join-Path $fx 'release') | Out-Null
    Copy-Item -LiteralPath $Exe -Destination (Join-Path $fx "release\$asset")
    $hash = (Get-FileHash -LiteralPath $Exe -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $fx 'release\SHA256SUMS'), "$hash  $asset`n")
    $ErrorActionPreference = 'Continue'
    & $OpenSsl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' -keyout (Join-Path $fx 'key.pem') -out (Join-Path $fx 'cert.pem') 2>&1 | Out-Null
    $ErrorActionPreference = 'Stop'
    if (-not (Test-Path -LiteralPath (Join-Path $fx 'cert.pem'))) { throw "no certificate from $OpenSsl" }
    $env:RELEASE_DIR = Join-Path $fx 'release'
    $env:TLS_CERT = Join-Path $fx 'cert.pem'
    $env:TLS_KEY = Join-Path $fx 'key.pem'
    $env:HTTPS_PORT = '18443'
    $env:HTTP_PORT = '18080'
    $env:HTTP_LOG = Join-Path $fx 'http.log'
    $log = Join-Path $fx 'fixture.log'
    if ($Fixture -like '*.exe') {
      $server = Start-Process -FilePath $Fixture -PassThru -NoNewWindow -RedirectStandardOutput $log -RedirectStandardError (Join-Path $fx 'fixture.err')
    } else {
      $bunfig = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\empty-bunfig.toml'
      $server = Start-Process -FilePath 'bun' -ArgumentList @('--no-env-file', "--config=$bunfig", $Fixture) -PassThru -NoNewWindow -RedirectStandardOutput $log -RedirectStandardError (Join-Path $fx 'fixture.err')
    }
    for ($i = 0; $i -lt 100 -and -not ((Test-Path -LiteralPath $log) -and (Get-Content -LiteralPath $log -Raw) -match 'ready'); $i++) { Start-Sleep -Milliseconds 100 }
    if (-not ((Get-Content -LiteralPath $log -Raw) -match 'ready')) { throw "the https fixture didn't start: $(Get-Content -Raw -LiteralPath (Join-Path $fx 'fixture.err'))" }
    $HttpsBase = 'https://localhost:18443'
  }

  $good = Build-Release 'good'
  $dir = Join-Path $scratch 'install-good'
  $r = Invoke-Installer $good $dir
  $installed = Join-Path $dir 'gluon.exe'
  Test-Case 'good install' ($r.Code -eq 0 -and (Test-Same $installed) -and $r.Out -match 'sha256 ok' -and $r.Out -match 'is not on your PATH') $r.Out
  $ErrorActionPreference = 'Continue'
  $v = & $installed --version | Out-String
  Test-Case 'installed exe runs --version' ($LASTEXITCODE -eq 0 -and $v.Trim() -match '^\d+\.\d+\.\d+') $v
  Test-Case 'no staged file left behind' (@(Get-ChildItem -LiteralPath $dir -Force).Count -eq 1) ((Get-ChildItem -LiteralPath $dir -Force | Out-String))

  $r = Invoke-Installer ([Uri]$good).AbsoluteUri (Join-Path $scratch 'install-file-url')
  Test-Case 'file:// URL' ($r.Code -eq 0 -and (Test-Same (Join-Path $scratch 'install-file-url\gluon.exe'))) $r.Out

  $dir = Join-Path $scratch 'install-tampered'
  $r = Invoke-Installer (Build-Release 'tampered' -Tamper) $dir
  Test-Case 'tampered exe fails closed' ($r.Code -ne 0 -and $r.Out -match 'checksum mismatch' -and -not (Test-Path -LiteralPath (Join-Path $dir 'gluon.exe'))) $r.Out

  $dir = Join-Path $scratch 'install-nosums'
  $r = Invoke-Installer (Build-Release 'nosums' -NoSums) $dir
  Test-Case 'missing SHA256SUMS fails closed, with the reason (BUG-127)' ($r.Code -ne 0 -and $r.Out -match 'could not get SHA256SUMS' -and $r.Out -match '\(no file ' -and -not (Test-Path -LiteralPath (Join-Path $dir 'gluon.exe'))) $r.Out

  $r = Invoke-Installer 'http://example.invalid/release' (Join-Path $scratch 'install-http')
  Test-Case 'plain http refused' ($r.Code -ne 0 -and $r.Out -match 'only https://') $r.Out

  # BUG-120: through iex, the session keeps its strict mode, preferences, TLS setting and names.
  $dir = Join-Path $scratch 'install-iex'
  $r = Invoke-Installer $good $dir -Prelude ($leakCheck -replace '__RUN__', "iex (Get-Content -Raw -LiteralPath '$installer')")
  Test-Case 'BUG-120: iex install leaves the session as it was' ($r.Out -match 'STATE strict=off same=True leaks=\[\] functions=0' -and $r.Out -notmatch 'INSTALLER-THREW' -and (Test-Same (Join-Path $dir 'gluon.exe'))) $r.Out
  $r = Invoke-Installer (Join-Path $scratch 'tampered') (Join-Path $scratch 'install-iex-fail') -Prelude ($leakCheck -replace '__RUN__', "iex (Get-Content -Raw -LiteralPath '$installer')")
  Test-Case 'BUG-120: a failed iex install leaves the session as it was' ($r.Out -match 'INSTALLER-THREW: gluon install:' -and $r.Out -match 'STATE strict=off same=True leaks=\[\] functions=0') $r.Out

  # BUG-122: the target is a directory.
  $dir = Join-Path $scratch 'install-dir-target'
  New-Item -ItemType Directory -Path (Join-Path $dir 'gluon.exe') | Out-Null
  $r = Invoke-Installer $good $dir
  Test-Case 'BUG-122: a target that is a directory is refused' ($r.Code -ne 0 -and $r.Out -match 'is a directory' -and $r.Out -cnotmatch 'Installed ' -and @(Get-ChildItem -LiteralPath (Join-Path $dir 'gluon.exe')).Count -eq 0) $r.Out

  # BUG-124: a relative install dir is made absolute.
  $r = Invoke-Installer $good 'rel\bin' -Prelude "Set-Location -LiteralPath '$scratch'"
  $abs = Join-Path $scratch 'rel\bin'
  Test-Case 'BUG-124: a relative install dir is made absolute' ($r.Code -eq 0 -and $r.Out.Contains("Installed $abs\gluon.exe") -and $r.Out.Contains("$abs is not on your PATH")) $r.Out

  # BUG-125: GLUON_VERSION is a version or latest.
  foreach ($bad in @('garbage', '1.0', '1.0.0/../x', '1.0.0; Remove-Item x')) {
    $r = Invoke-Installer '' (Join-Path $scratch 'install-badversion') -Env @{ GLUON_VERSION = $bad }
    Test-Case "BUG-125: GLUON_VERSION=$bad refused" ($r.Code -ne 0 -and $r.Out -match 'must be a version' -and -not (Test-Path -LiteralPath (Join-Path $scratch 'install-badversion'))) $r.Out
  }

  # BUG-127: a CRLF SHA256SUMS reads the same (and still fails closed on a mismatch).
  $r = Invoke-Installer (Build-Release 'crlf' -Crlf) (Join-Path $scratch 'install-crlf')
  Test-Case 'BUG-127: a CRLF SHA256SUMS is read' ($r.Code -eq 0 -and (Test-Same (Join-Path $scratch 'install-crlf\gluon.exe'))) $r.Out
  $r = Invoke-Installer (Build-Release 'crlf-tampered' -Crlf -Tamper) (Join-Path $scratch 'install-crlf-tampered')
  Test-Case 'BUG-127: CRLF, tampered: fails closed' ($r.Code -ne 0 -and $r.Out -match 'checksum mismatch') $r.Out

  # BUG-119: https, with redirects followed by hand (a self-signed fixture: trusted in the child only).
  if ($HttpsBase) {
    $trust = @'
Add-Type -TypeDefinition 'public static class GluonTestTrust { public static bool Ok(object s, System.Security.Cryptography.X509Certificates.X509Certificate c, System.Security.Cryptography.X509Certificates.X509Chain h, System.Net.Security.SslPolicyErrors e) { return true; } }'
[Net.ServicePointManager]::ServerCertificateValidationCallback = [Delegate]::CreateDelegate([Net.Security.RemoteCertificateValidationCallback], [GluonTestTrust].GetMethod('Ok'))
'@
    $r = Invoke-Installer "$HttpsBase/r" (Join-Path $scratch 'install-https') -Prelude $trust
    Test-Case 'BUG-119: install over https' ($r.Code -eq 0 -and (Test-Same (Join-Path $scratch 'install-https\gluon.exe'))) $r.Out
    $r = Invoke-Installer "$HttpsBase/to-https" (Join-Path $scratch 'install-https-redirect') -Prelude $trust
    Test-Case 'BUG-119: an https -> https redirect is followed' ($r.Code -eq 0 -and (Test-Same (Join-Path $scratch 'install-https-redirect\gluon.exe'))) $r.Out
    $r = Invoke-Installer "$HttpsBase/to-http" (Join-Path $scratch 'install-http-redirect') -Prelude $trust
    Test-Case 'BUG-119: an https -> http redirect is refused' ($r.Code -ne 0 -and $r.Out -match 'not https' -and -not (Test-Path -LiteralPath (Join-Path $scratch 'install-http-redirect'))) $r.Out
    $r = Invoke-Installer "$HttpsBase/nothing-here" (Join-Path $scratch 'install-https-404') -Prelude $trust
    Test-Case 'BUG-127: a 404 names the reason' ($r.Code -ne 0 -and $r.Out -match 'HTTP 404') $r.Out
    if ($Fixture) {
      $httpHits = if (Test-Path -LiteralPath $env:HTTP_LOG) { Get-Content -Raw -LiteralPath $env:HTTP_LOG } else { '' }
      Test-Case 'BUG-119: the plain-http server was never asked' (-not $httpHits) $httpHits
    }
  } else {
    Write-Information 'skip  https cases (no -HttpsBase or -Fixture)'
  }

  $pathAfter = (Get-Item -LiteralPath 'HKCU:\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  Test-Case 'user PATH untouched' ($pathBefore -eq $pathAfter) "before: $pathBefore`nafter: $pathAfter"
} finally {
  if ($server) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue; $server.WaitForExit(5000) | Out-Null }
  Remove-Item Env:GLUON_RELEASE_URL, Env:GLUON_INSTALL_DIR -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures) { Write-Information "$failures failed"; exit 1 }
Write-Information 'install.ps1: all passed'
exit 0
