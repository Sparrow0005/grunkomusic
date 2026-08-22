$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = 'C:\Program Files\nodejs\node.exe'
$index = Join-Path $repo 'index.js'
$log = Join-Path $repo 'bot.log'
$errorLog = Join-Path $repo 'bot-error.log'

Set-Location -LiteralPath $repo

while ($true) {
  foreach ($path in @($log, $errorLog)) {
    if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -gt 10MB) {
      Move-Item -LiteralPath $path -Destination "$path.1" -Force
    }
  }
  $started = Get-Date -Format o
  Add-Content -LiteralPath $log -Value "[$started] [WATCHDOG] Starting bot."
  $command = "`"$node`" `"$index`" 1>>`"$log`" 2>>`"$errorLog`""
  & cmd.exe /d /s /c $command
  $exitCode = $LASTEXITCODE
  $stopped = Get-Date -Format o
  Add-Content -LiteralPath $errorLog -Value "[$stopped] [WATCHDOG] Bot exited with code $exitCode; restarting in 10 seconds."
  Start-Sleep -Seconds 10
}
