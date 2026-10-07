<#
.SYNOPSIS
  Installs Gluon on Windows (x64). Linux and macOS: install.sh.

.DESCRIPTION
  irm https://github.com/fidipro/gluon/releases/latest/download/install.ps1 | iex

  Downloads gluon-bun-windows-x64.exe, checks it against the release's SHA256SUMS (no match, no
  install) and installs it as %LOCALAPPDATA%\Programs\gluon\gluon.exe. No administrator
  rights. The user PATH is changed only with -AddToPath (or GLUON_ADD_TO_PATH=1).

  Environment:
    GLUON_VERSION       a version such as 1.0.0 (default: latest, the newest published GitHub
                        release of fidipro/gluon)
    GLUON_RELEASE_URL   where the release files are: an https:// base URL, a file:// URL or a
                        local directory holding gluon-bun-windows-x64.exe and SHA256SUMS.
                        It wins over GLUON_VERSION.
    GLUON_INSTALL_DIR   where to install (default: %LOCALAPPDATA%\Programs\gluon)
    GLUON_ADD_TO_PATH   1: add the install directory to the user PATH (same as -AddToPath)

  This script never carries or asks for a token. To install a release GitHub doesn't serve
  anonymously (a draft or a pre-release), download it with your own gh login and install from that
  directory:

    gh release download v1.0.0 -R fidipro/gluon -D gluon-release
    $env:GLUON_RELEASE_URL = "$PWD\gluon-release"; .\gluon-release\install.ps1

  Everything runs in a script block of its own: run as `irm ... | iex`, it leaves the session's
  preferences, strict mode, TLS settings and variables as they were (BUG-120).

.PARAMETER AddToPath
  Add the install directory to the user PATH (HKCU\Environment).
#>
& {
  [CmdletBinding()]
  param(
    [switch]$AddToPath
  )

  Set-StrictMode -Version 2.0
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $InformationPreference = 'Continue'

  $Repo = 'fidipro/gluon'
  $Asset = 'gluon-bun-windows-x64.exe'

  # A throw, not exit: run as `irm ... | iex`, exit would close the user's PowerShell window.
  function Exit-Install([string]$Message) {
    throw "gluon install: $Message"
  }

  # https only, every hop: redirects are followed by hand, and one to anything but https is refused
  # (Windows PowerShell 5.1 would follow https -> http: BUG-119).
  function Save-HttpsFile([Uri]$Uri, [string]$Destination) {
    $current = $Uri
    for ($hop = 0; $hop -le 10; $hop++) {
      if ($current.Scheme -ne 'https') { throw "refusing $($current.AbsoluteUri): not https" }
      $request = [Net.HttpWebRequest]::Create($current)
      $request.AllowAutoRedirect = $false
      $request.UserAgent = 'gluon-install'
      try {
        $response = $request.GetResponse()
      } catch [Net.WebException] {
        $response = $_.Exception.Response
        if (-not $response) { throw $_.Exception.Message }
      }
      try {
        $code = [int]$response.StatusCode
        if ($code -ge 300 -and $code -lt 400) {
          $location = $response.Headers['Location']
          if (-not $location) { throw "HTTP $code without a Location from $($current.AbsoluteUri)" }
          $current = New-Object Uri($current, $location)
          continue
        }
        if ($code -ne 200) { throw "HTTP $code from $($current.AbsoluteUri)" }
        $in = $response.GetResponseStream()
        $out = [IO.File]::Create($Destination)
        try { $in.CopyTo($out) } finally { $out.Dispose(); $in.Dispose() }
        return
      } finally {
        $response.Close()
      }
    }
    throw "too many redirects from $($Uri.AbsoluteUri)"
  }

  # Copies or downloads one release file; returns $null, or why it couldn't.
  function Get-ReleaseFile([string]$Name, [string]$Destination) {
    if ($sourceKind -eq 'local') {
      $src = Join-Path $base $Name
      if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { return "no file $src" }
      Copy-Item -LiteralPath $src -Destination $Destination
      return $null
    }
    try {
      Save-HttpsFile ([Uri]"$base/$Name") $Destination
      return $null
    } catch {
      return "$($_.Exception.Message)"
    }
  }

  # --- where the release is -------------------------------------------------------------------
  $version = $env:GLUON_VERSION
  if (-not $version) { $version = 'latest' }
  if ($version -ne 'latest' -and $version -notmatch '^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$') {
    Exit-Install "GLUON_VERSION must be a version such as 1.0.0 (or latest), not: $version"
  }
  $sourceKind = 'https'
  if ($env:GLUON_RELEASE_URL) {
    $base = $env:GLUON_RELEASE_URL.TrimEnd('/', '\')
    if ($base -match '^https://') {
      $sourceKind = 'https'
    } elseif ($base -match '^file://') {
      $sourceKind = 'local'
      $base = ([Uri]$base).LocalPath
    } elseif ($base -match '^[a-zA-Z][a-zA-Z0-9+.-]+://') {
      Exit-Install "refusing ${base}: only https:// (or a local directory) is allowed"
    } else {
      $sourceKind = 'local'
    }
    if ($sourceKind -eq 'local' -and -not (Test-Path -LiteralPath $base -PathType Container)) {
      Exit-Install "no such directory: $base"
    }
  } elseif ($version -eq 'latest') {
    $base = "https://github.com/$Repo/releases/latest/download"
  } else {
    $base = "https://github.com/$Repo/releases/download/v$($version.TrimStart('v'))"
  }

  # --- this machine ---------------------------------------------------------------------------
  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
  if ($arch -eq 'ARM64') {
    Write-Information 'Windows on Arm: installing the x64 build, which runs under Windows 11 x64 emulation.'
  } elseif ($arch -ne 'AMD64') {
    Exit-Install "unsupported CPU: $arch (Windows x64 is supported)"
  }

  $installDir = $env:GLUON_INSTALL_DIR
  if (-not $installDir) { $installDir = Join-Path $env:LOCALAPPDATA 'Programs\gluon' }
  $addToPath = $AddToPath.IsPresent -or ($env:GLUON_ADD_TO_PATH -eq '1')

  # --- download and check ---------------------------------------------------------------------
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("gluon-install-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $staged = $null
  # Windows PowerShell 5.1 may default to TLS 1.0; GitHub needs 1.2. Put back as it was at the end.
  $protocols = [Net.ServicePointManager]::SecurityProtocol

  try {
    [Net.ServicePointManager]::SecurityProtocol = $protocols -bor [Net.SecurityProtocolType]::Tls12
    Write-Information "Installing Gluon ($Asset) from $base"

    $sums = Join-Path $tmp 'SHA256SUMS'
    $why = Get-ReleaseFile 'SHA256SUMS' $sums
    if ($why) { Exit-Install "could not get SHA256SUMS from ${base} ($why); nothing installed" }
    $exe = Join-Path $tmp $Asset
    $why = Get-ReleaseFile $Asset $exe
    if ($why) {
      Exit-Install "could not get $Asset from ${base} ($why); nothing installed"
    }

    # The line for this file: "<hash>  <name>" (or "<hash> *<name>"); LF or CRLF.
    $expected = $null
    foreach ($line in Get-Content -LiteralPath $sums) {
      $parts = $line.Trim() -split '\s+', 2
      if ($parts.Count -eq 2 -and ($parts[1] -eq $Asset -or $parts[1] -eq "*$Asset")) { $expected = $parts[0].ToLowerInvariant(); break }
    }
    if (-not $expected) { Exit-Install "SHA256SUMS has no entry for $Asset; nothing installed" }
    $actual = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      Write-Information "checksum mismatch for $Asset`n  expected $expected`n  got      $actual"
      Exit-Install 'the download is not the released file; nothing installed'
    }
    Write-Information "  sha256 ok  $actual"
    Write-Information '  signature: not checked here; see docs/getting-started/install.md for cosign verify-blob'

    # --- install ------------------------------------------------------------------------------
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    # Absolute from here on: the hints, the PATH check and -AddToPath need it (BUG-124).
    $installDir = (Resolve-Path -LiteralPath $installDir).ProviderPath
    $target = Join-Path $installDir 'gluon.exe'
    if (Test-Path -LiteralPath $target -PathType Container) { Exit-Install "$target is a directory; nothing installed" }
    $staged = Join-Path $installDir (".gluon." + [Guid]::NewGuid().ToString('N') + '.tmp')
    Copy-Item -LiteralPath $exe -Destination $staged
    try {
      Move-Item -LiteralPath $staged -Destination $target -Force
    } catch {
      Exit-Install "could not replace ${target} (is gluon running?): $($_.Exception.Message)"
    }
    $staged = $null
    Write-Information "Installed $target"

    $userPath = (Get-Item -LiteralPath 'HKCU:\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    $onPath = @($userPath -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ieq $installDir.TrimEnd('\')) }).Count -gt 0
    if ($onPath) {
      # Already on the user PATH.
    } elseif ($addToPath) {
      $newPath = if ($userPath) { "$($userPath.TrimEnd(';'));$installDir" } else { $installDir }
      # ExpandString keeps entries such as %USERPROFILE%\bin working.
      Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name 'Path' -Value $newPath -Type ExpandString
      # Setting a user variable through .NET tells running programs (Explorer, new terminals) to reload.
      [Environment]::SetEnvironmentVariable('GLUON_PATH_REFRESH', '1', 'User')
      [Environment]::SetEnvironmentVariable('GLUON_PATH_REFRESH', $null, 'User')
      $env:Path = "$env:Path;$installDir"
      Write-Information "Added $installDir to your user PATH (open a new terminal to use it)."
    } else {
      Write-Information ''
      Write-Information "$installDir is not on your PATH. To add it for your user:"
      Write-Information "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';$installDir', 'User')"
      Write-Information '  (or run this installer again with -AddToPath, or with GLUON_ADD_TO_PATH=1)'
    }

    Write-Information ''
    Write-Information 'Get started: gluon'
    Write-Information "Uninstall:   gluon uninstall   (config and saved API keys), then Remove-Item '$target'"
    Write-Information '             and remove the directory from your user PATH if you added it.'
  } finally {
    [Net.ServicePointManager]::SecurityProtocol = $protocols
    if ($staged -and (Test-Path -LiteralPath $staged)) { Remove-Item -LiteralPath $staged -Force }
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
} @args
