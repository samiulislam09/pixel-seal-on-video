# Keeps the app and its Cloudflare tunnel running; restarts either if it stops.
# Started at logon by the "Video Watermark Host" scheduled task (see scripts\install-autostart.ps1),
# or by hand:  powershell -ExecutionPolicy Bypass -File scripts\host.ps1
#
# Tunnel:
#   - With CLOUDFLARE_TUNNEL_TOKEN in .env: a named tunnel with your own fixed hostname.
#   - Without it: a free "quick tunnel" with a random https://....trycloudflare.com address that
#     changes every time the tunnel restarts. The current address is written to storage\public-url.txt.

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Storage = Join-Path $Root 'storage'
New-Item -ItemType Directory -Force $Storage | Out-Null
$HostLog = Join-Path $Storage 'host.log'
$UrlFile = Join-Path $Storage 'public-url.txt'

function Log($msg) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Add-Content -Path $HostLog -Encoding utf8 }

# Settings from .env (only the ones this script needs).
$envFile = Join-Path $Root '.env'
$settings = @{}
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$') { $settings[$Matches[1]] = $Matches[2].Trim('"', "'") }
  }
}
$Port = if ($settings.PORT) { $settings.PORT } else { '3000' }
$Token = if ($env:CLOUDFLARE_TUNNEL_TOKEN) { $env:CLOUDFLARE_TUNNEL_TOKEN } else { $settings.CLOUDFLARE_TUNNEL_TOKEN }

$Cloudflared = @(
  (Get-Command cloudflared -ErrorAction SilentlyContinue).Source,
  "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe",
  "$env:ProgramFiles\cloudflared\cloudflared.exe",
  "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $Cloudflared) { Log 'cloudflared not found. Install it: winget install Cloudflare.cloudflared'; exit 1 }
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { $Node = "$env:ProgramFiles\nodejs\node.exe" }

# Only one supervisor at a time.
$mutex = New-Object System.Threading.Mutex($false, 'Global\VideoWatermarkHost')
if (-not $mutex.WaitOne(0)) { Log 'Another host.ps1 is already running; exiting.'; exit 0 }

function Find-Proc($name, $pattern) {
  Get-CimInstance Win32_Process -Filter "Name='$name'" | Where-Object { $_.CommandLine -match $pattern } | Select-Object -First 1
}

function Start-App {
  Log "Starting app on port $Port"
  # cmd /c gives the server a console of its own and a log file; the app reads .env itself.
  Start-Process -FilePath cmd.exe -ArgumentList '/c', "`"$Node`" server.js > storage\server.log 2>&1" -WorkingDirectory $Root -WindowStyle Hidden
}

function Start-Tunnel {
  $tlog = Join-Path $Storage 'tunnel.log'
  Remove-Item $tlog -ErrorAction SilentlyContinue
  if ($Token) {
    Log 'Starting named Cloudflare tunnel'
    Start-Process -FilePath $Cloudflared -ArgumentList 'tunnel', '--no-autoupdate', '--logfile', "`"$tlog`"", '--url', "http://localhost:$Port", 'run', '--token', $Token -WindowStyle Hidden
  } else {
    Log 'Starting quick Cloudflare tunnel (random address)'
    Remove-Item $UrlFile -ErrorAction SilentlyContinue
    Start-Process -FilePath $Cloudflared -ArgumentList 'tunnel', '--no-autoupdate', '--logfile', "`"$tlog`"", '--url', "http://localhost:$Port" -WindowStyle Hidden
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep 2
      $m = [regex]::Match((Get-Content $tlog -Raw -ErrorAction SilentlyContinue), 'https://[a-z0-9-]+\.trycloudflare\.com')
      if ($m.Success) { Set-Content -Path $UrlFile -Value $m.Value -Encoding ascii; Log "Public URL: $($m.Value)"; return }
    }
    Log 'Quick tunnel started but no URL appeared yet; see storage\tunnel.log'
  }
}

Log "Supervisor started (pid $PID)"
try {
  while ($true) {
    try {
      if (-not (Find-Proc 'node.exe' 'server\.js')) { Start-App }
      if (-not (Find-Proc 'cloudflared.exe' '\btunnel\b')) { Start-Tunnel }
    } catch {
      Log "Error: $($_.Exception.Message)"
    }
    Start-Sleep 20
  }
} finally {
  # Runs on Ctrl+C / console close too. The scheduled task starts a new supervisor within 5 minutes.
  Log "Supervisor stopping (pid $PID)"
}
