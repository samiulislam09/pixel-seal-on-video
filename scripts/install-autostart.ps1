# Registers a scheduled task that runs scripts\host.ps1 so the app and its Cloudflare tunnel start automatically.
#   At sign-in (no admin):     powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#   At boot, no sign-in needed (run as administrator):
#                              powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -AtBoot
#   Remove:                    powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove
param([switch]$Remove, [switch]$AtBoot, [string]$User = "$env:USERDOMAIN\$env:USERNAME")
$ErrorActionPreference = 'Stop'

$TaskName = 'Video Watermark Host'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  "Removed scheduled task '$TaskName'. Running processes were left alone."
  exit 0
}

$script = Join-Path $PSScriptRoot 'host.ps1'
$user = $User
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`"" -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
# At sign-in, and every 5 minutes as a watchdog: if host.ps1 has stopped for any reason it is started
# again; if it is still running, the new copy sees the mutex and exits at once.
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable
if ($AtBoot) {
  # Runs as $user in the background whether or not anyone is signed in. Windows stores the password for the task;
  # for a Microsoft account use its password, not the PIN.
  $cred = Get-Credential -UserName $user -Message "Windows password of $user, so the app can start at boot without signing in"
  $trigger = @((New-ScheduledTaskTrigger -AtStartup), $watchdog)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited `
    -User $user -Password $cred.GetNetworkCredential().Password -Force -ErrorAction Stop | Out-Null
  "Registered '$TaskName': starts the app and tunnel at boot (no sign-in needed)."
} else {
  $trigger = @((New-ScheduledTaskTrigger -AtLogOn -User $user), $watchdog)
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
  "Registered '$TaskName': starts the app and tunnel when $user signs in."
}
