$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..\..")).Path
$pidFile = Join-Path $root "data\service.pid"

if (-not (Test-Path -LiteralPath $pidFile)) {
  Write-Host "未找到 PID 文件（data\service.pid），服务可能未通过本脚本启动。"
  exit 0
}

try {
  $servicePid = [int]([System.IO.File]::ReadAllText($pidFile).Trim())
} catch {
  Write-Host "PID 文件无效: $pidFile"
  exit 1
}

if (Get-Process -Id $servicePid -ErrorAction SilentlyContinue) {
  & taskkill /PID $servicePid /T /F
  Write-Host "服务已停止 (PID $servicePid)。"
} else {
  Write-Host "进程 $servicePid 未在运行，清理 PID 文件。"
}

Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
