# Мост к Claude должен быть жив всегда: без него сервис не может написать ни поста, ни ответа.
# Скрипт ничего не делает, если мост уже слушает свой порт, и поднимает его, если нет.
# Запускается задачей планировщика при входе в систему и раз в несколько минут.
$ErrorActionPreference = "Stop"
$port = if ($env:CLAUDE_BRIDGE_PORT) { [int]$env:CLAUDE_BRIDGE_PORT } else { 43131 }
$dir = Split-Path -Parent $PSScriptRoot

$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listening) { exit 0 }

Start-Process -FilePath "node" -ArgumentList "scripts/claude-bridge.mjs" -WorkingDirectory $dir -WindowStyle Hidden
