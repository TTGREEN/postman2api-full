$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..\..")).Path
Set-Location $root

function Test-Tool([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-ServicePort() {
  $envPath = Join-Path $root ".env"
  if (Test-Path -LiteralPath $envPath) {
    foreach ($line in [System.IO.File]::ReadAllLines($envPath)) {
      if ($line -match '^\s*PORT\s*=\s*(\d+)\s*$') { return [int]$Matches[1] }
    }
  }
  return 1930
}

function Write-Utf8NoBom([string]$Path, [string]$Value) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  [System.IO.File]::WriteAllText($Path, $Value, [System.Text.UTF8Encoding]::new($false))
}

function Write-JsonNoBom([string]$Path, $Value, [int]$Depth = 10) {
  $json = $Value | ConvertTo-Json -Depth $Depth
  Write-Utf8NoBom $Path ($json + [Environment]::NewLine)
}

function Enable-CamoufoxRuntime() {
  $camoufoxRoot = Join-Path $root "runtime\camoufox"
  $camoufoxExe = Join-Path $camoufoxRoot "camoufox.exe"
  if (-not (Test-Path -LiteralPath $camoufoxExe)) {
    Write-Warning "未找到内置 Camoufox 运行时 (runtime\camoufox\camoufox.exe)，浏览器登录不可用。API 服务不受影响；需要浏览器登录时请从完整发布包运行 scripts\ops\windows-deploy.ps1。"
    return
  }

  $versionPath = Join-Path $camoufoxRoot "version.json"
  $versionInfo = [ordered]@{ version = "152.0.4"; release = "beta.28" }
  if (Test-Path -LiteralPath $versionPath) {
    $raw = [System.IO.File]::ReadAllText($versionPath)
    $trimmed = $raw.TrimStart([char]0xFEFF)
    try {
      $parsed = $trimmed | ConvertFrom-Json -ErrorAction Stop
      $versionInfo = [ordered]@{ version = [string]$parsed.version; release = [string]$parsed.release }
    } catch {
      Write-Host "Rewriting malformed runtime\camoufox\version.json."
    }
  }
  Write-JsonNoBom $versionPath $versionInfo 4

  $env:CAMOUFOX_INSTALL_DIR = $camoufoxRoot
  $env:CAMOUFOX_SKIP_BROWSER_DOWNLOAD = "1"
  $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"
}

function Assert-Ready() {
  if (-not (Test-Tool "bun")) {
    throw "未检测到 Bun。请先运行 scripts\ops\windows-deploy.ps1（或双击 一键部署.cmd），必要时重开 PowerShell。"
  }
  $webglDb = Join-Path $root "node_modules\camoufox-js\dist\data-files\webgl_data.db"
  if (-not (Test-Path -LiteralPath $webglDb)) {
    Write-Warning "缺少 camoufox-js WebGL 指纹数据库，浏览器登录不可用。API 服务不受影响。"
  }
}

function Test-ServiceAlive([int]$Port) {
  try {
    $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

Write-Host "== postman2api 本地网关启动 =="
Write-Host "目录: $root"
Enable-CamoufoxRuntime
Assert-Ready

$port = Get-ServicePort
$baseUrl = "http://127.0.0.1:$port"

$dataDir = Join-Path $root "data"
if (-not (Test-Path -LiteralPath $dataDir)) {
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
}
$pidFile = Join-Path $dataDir "service.pid"
$logFile = Join-Path $dataDir "service.log"

if (Test-ServiceAlive $port) {
  Write-Host ""
  Write-Host "服务已在运行。面板: $baseUrl/"
  exit 0
}

# 清理残留进程（PID 文件指向的进程还在，但服务已无响应）
if (Test-Path -LiteralPath $pidFile) {
  try {
    $oldPid = [int]([System.IO.File]::ReadAllText($pidFile).Trim())
    if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
      & taskkill /PID $oldPid /T /F 2>$null | Out-Null
      Write-Host "已清理残留进程 (PID $oldPid)。"
    }
  } catch { }
}

Write-Host "正在执行数据库迁移..."
bun run migrate
if ($LASTEXITCODE -ne 0) { throw "bun run migrate 失败。" }

Write-Host ""
Write-Host "面板: $baseUrl/"
Write-Host "OpenAI 接口: $baseUrl/v1/chat/completions"
Write-Host "正在后台启动服务（隐藏窗口，不占用任务栏）..."

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = "cmd.exe"
$psi.Arguments = "/c bun run start >> `"$logFile`" 2>&1"
$psi.WorkingDirectory = $root
$psi.UseShellExecute = $true
$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$proc = [System.Diagnostics.Process]::Start($psi)

[System.IO.File]::WriteAllText($pidFile, [string]$proc.Id)

$ready = $false
foreach ($attempt in 1..30) {
  Start-Sleep -Seconds 1
  if (Test-ServiceAlive $port) { $ready = $true; break }
}

if (-not $ready) {
  Write-Host ""
  Write-Host "启动失败：30 秒内 $baseUrl/health 没有响应。"
  Write-Host "日志: $logFile"
  if (Test-Path -LiteralPath $logFile) {
    Write-Host "--- 日志末尾 ---"
    Get-Content -LiteralPath $logFile -Tail 20
  }
  exit 1
}

Write-Host ""
Write-Host "服务已就绪，本窗口即将关闭。"
Write-Host "PID: $($proc.Id)"
Write-Host "日志: $logFile"
Write-Host "停止: 双击 一键停止服务.cmd"
