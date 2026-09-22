# Сторож моста: раз в минуту смотрит, жив ли мост к Claude, и поднимает его, если нет.
# Запускается сам при входе в систему (ярлык в автозапуске) и работает скрыто, без окна,
# поэтому его нельзя закрыть случайно — в отличие от окна самого моста.
$ErrorActionPreference = "Continue"
$keepalive = Join-Path $PSScriptRoot "bridge-keepalive.ps1"

while ($true) {
  try { & $keepalive } catch { }
  Start-Sleep -Seconds 60
}
