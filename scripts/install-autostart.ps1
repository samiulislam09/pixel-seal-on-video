# Registers a scheduled task that runs scripts\host.ps1 when you sign in to Windows,
# so the app and its Cloudflare tunnel start automatically. No administrator rights needed.
#   Install:    powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#   Remove:     powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove
param([switch]$Remove)

$TaskName = 'Video Watermark Host'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  "Removed scheduled task '$TaskName'. Running processes were left alone."
  exit 0
}

$script = Join-Path $PSScriptRoot 'host.ps1'
$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`"" -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
# At sign-in, and every 5 minutes as a watchdog: if host.ps1 has stopped for any reason it is started
# again; if it is still running, the new copy sees the mutex and exits at once.
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $user
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$trigger = @($atLogon, $watchdog)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
"Registered '$TaskName': starts the app and tunnel when $user signs in."
