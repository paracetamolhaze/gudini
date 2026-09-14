param([switch]$InstallStartup)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDirectory = Join-Path $projectRoot 'data\codex'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$bridgeScript = Join-Path $projectRoot 'scripts\codex-bridge.ts'
if ($InstallStartup) {
  $shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Gudini Codex.lnk'
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
  $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $shortcut.Arguments = '-NoProfile -WindowStyle Hidden -File "' + $PSCommandPath + '"'
  $shortcut.WorkingDirectory = $projectRoot
  $shortcut.WindowStyle = 7
  $shortcut.Save()
}
$existing = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Contains($bridgeScript)
}
if ($existing) { Write-Output 'Gudini Codex bridge is already running'; exit 0 }
Start-Process -FilePath $nodeExecutable -ArgumentList @('--import', 'tsx', ('"' + $bridgeScript + '"')) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory 'bridge.out.log') -RedirectStandardError (Join-Path $logDirectory 'bridge.err.log')
Write-Output 'Gudini Codex bridge started'
