$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = 'C:\Program Files\nodejs\node.exe'
$index = Join-Path $repo 'index.js'
$log = Join-Path $repo 'bot.log'
$errorLog = Join-Path $repo 'bot-error.log'

Set-Location -LiteralPath $repo
$restartDelay = 10

while ($true) {
  foreach ($path in @($log, $errorLog)) {
    if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -gt 10MB) {
      Move-Item -LiteralPath $path -Destination "$path.1" -Force
    }
  }
  $started = Get-Date -Format o
  Add-Content -LiteralPath $log -Value "[$started] [WATCHDOG] Starting bot."
  $runStarted = Get-Date
  # Use cmd for byte-preserving append redirection, but explicitly hide its
  # window so the watchdog never leaves a console on the desktop.
  $command = "`"$node`" `"$index`" 1>>`"$log`" 2>>`"$errorLog`""
  $process = Start-Process -FilePath 'cmd.exe' -ArgumentList '/d', '/s', '/c', $command -WindowStyle Hidden -Wait -PassThru
  $exitCode = $process.ExitCode
  $stopped = Get-Date -Format o
  if ($exitCode -eq 0) {
    Add-Content -LiteralPath $log -Value "[$stopped] [WATCHDOG] Bot stopped cleanly; watchdog is exiting."
    break
  }
  if (((Get-Date) - $runStarted).TotalMinutes -ge 10) { $restartDelay = 10 }
  Add-Content -LiteralPath $errorLog -Value "[$stopped] [WATCHDOG] Bot exited with code $exitCode; restarting in $restartDelay seconds."
  Start-Sleep -Seconds $restartDelay
  $restartDelay = [Math]::Min($restartDelay * 2, 300)
}
