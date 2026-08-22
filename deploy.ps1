$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Test-Tool([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Ensure-Directory([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
  }
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

function Set-EnvValue([string]$Name, [string]$Value) {
  $envPath = Join-Path $root ".env"
  if (-not (Test-Path -LiteralPath $envPath)) { return }
  $pattern = "^\s*" + [regex]::Escape($Name) + "\s*="
  $lines = [System.Collections.Generic.List[string]]::new()
  if (Test-Path -LiteralPath $envPath) {
    [string[]]$existing = [System.IO.File]::ReadAllLines($envPath)
    foreach ($line in $existing) { $lines.Add($line) }
  }
  $updated = $false
  for ($i = 0; $i -lt $lines.Count; $i += 1) {
    if ($lines[$i] -match $pattern) {
      $lines[$i] = "$Name=$Value"
      $updated = $true
    }
  }
  if (-not $updated) {
    $lines.Add("$Name=$Value")
    Write-Host "Added setting to .env: $Name"
  } else {
    Write-Host "Updated deployment-managed .env setting: $Name"
  }
  Write-Utf8NoBom $envPath (($lines -join [Environment]::NewLine) + [Environment]::NewLine)
}

function Ensure-Bun() {
  if (Test-Tool "bun") {
    Write-Host "Bun detected."
    return
  }

  Write-Host "Bun not found. Installing Bun runtime..."
  if (Test-Tool "npm") {
    npm install -g bun
    if ($LASTEXITCODE -ne 0) { throw "Bun install through npm failed." }
  } else {
    $installer = Join-Path $env:TEMP "bun-install.ps1"
    Invoke-WebRequest -UseBasicParsing -Uri "https://bun.sh/install.ps1" -OutFile $installer
    powershell -ExecutionPolicy Bypass -File $installer
    $bunBin = Join-Path $env:USERPROFILE ".bun\bin"
    if (Test-Path -LiteralPath $bunBin) {
      $env:PATH = "$bunBin;$env:PATH"
    }
  }

  if (-not (Test-Tool "bun")) {
    throw "Bun installation finished but bun is still not available in this shell. Reopen PowerShell and run deploy.ps1 again."
  }
}

function Ensure-CamoufoxRuntime() {
  $camoufoxRoot = Join-Path $root "runtime\camoufox"
  $camoufoxExe = Join-Path $camoufoxRoot "camoufox.exe"
  if (-not (Test-Path -LiteralPath $camoufoxExe)) {
    Write-Host "Bundled Camoufox runtime not found; dependency install may download browser assets if needed."
    return
  }

  $versionPath = Join-Path $camoufoxRoot "version.json"
  $defaultVersion = [ordered]@{ version = "152.0.4"; release = "beta.28" }
  if (Test-Path -LiteralPath $versionPath) {
    $raw = [System.IO.File]::ReadAllText($versionPath)
    $trimmed = $raw.TrimStart([char]0xFEFF)
    try {
      $parsed = $trimmed | ConvertFrom-Json -ErrorAction Stop
      $defaultVersion = [ordered]@{ version = [string]$parsed.version; release = [string]$parsed.release }
    } catch {
      Write-Host "Rewriting malformed runtime\camoufox\version.json."
    }
  }
  Write-JsonNoBom $versionPath $defaultVersion 4

  $env:CAMOUFOX_INSTALL_DIR = $camoufoxRoot
  $env:CAMOUFOX_SKIP_BROWSER_DOWNLOAD = "1"
  $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"
  Set-EnvValue "CAMOUFOX_INSTALL_DIR" $camoufoxRoot
  Set-EnvValue "CAMOUFOX_SKIP_BROWSER_DOWNLOAD" "1"
  Set-EnvValue "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD" "1"
  Write-Host "Bundled Camoufox runtime enabled."
}

function Test-RootDependencies() {
  return (Test-Path -LiteralPath (Join-Path $root "node_modules\hono")) -and
    (Test-Path -LiteralPath (Join-Path $root "node_modules\camoufox-js")) -and
    (Test-Path -LiteralPath (Join-Path $root "node_modules\playwright"))
}

function Assert-CamoufoxDataFiles() {
  $webglDb = Join-Path $root "node_modules\camoufox-js\dist\data-files\webgl_data.db"
  if (-not (Test-Path -LiteralPath $webglDb)) {
    throw "camoufox-js WebGL fingerprint database is missing. Re-run deploy.ps1 from a complete release package."
  }
}

Write-Host "== postman2api one-click deploy =="
Write-Host "Project: $root"

$envPath = Join-Path $root ".env"
if (-not (Test-Path -LiteralPath $envPath)) {
  $examplePath = Join-Path $root ".env.example"
  if (Test-Path -LiteralPath $examplePath) {
    Copy-Item -LiteralPath $examplePath -Destination $envPath -Force
    Write-Host "Created .env from .env.example."
  } else {
    Write-Host ".env not found and .env.example is missing; continuing without creating .env."
  }
} else {
  Write-Host "Preserved existing .env."
}

Ensure-Directory (Join-Path $root "data")
Ensure-CamoufoxRuntime
Ensure-Bun

if (Test-RootDependencies) {
  Write-Host "Root dependencies are already included."
} else {
  Write-Host "Root dependencies missing; running bun install."
  bun install
  if ($LASTEXITCODE -ne 0) { throw "bun install failed." }
}
Assert-CamoufoxDataFiles

$dashboardRoot = Join-Path $root "dashboard"
if (Test-Path -LiteralPath (Join-Path $dashboardRoot "package.json")) {
  $dashboardDepsOk = (Test-Path -LiteralPath (Join-Path $dashboardRoot "node_modules\vite")) -and
    (Test-Path -LiteralPath (Join-Path $dashboardRoot "node_modules\react"))
  if ($dashboardDepsOk) {
    Write-Host "Dashboard dependencies are already included."
  } else {
    Write-Host "Dashboard dependencies missing; installing dashboard dependencies."
    Push-Location $dashboardRoot
    try {
      bun install
      if ($LASTEXITCODE -ne 0) { throw "dashboard bun install failed." }
    } finally {
      Pop-Location
    }
  }
}

if (Test-Path -LiteralPath (Join-Path $dashboardRoot "dist\index.html")) {
  Write-Host "Dashboard build output already exists."
} else {
  Write-Host "Dashboard build output missing; building dashboard."
  bun run build
  if ($LASTEXITCODE -ne 0) { throw "bun run build failed." }
}

Write-Host "Running database migration without replacing existing data..."
bun run migrate
if ($LASTEXITCODE -ne 0) { throw "bun run migrate failed." }

Write-Host ""
Write-Host "Deployment check finished."
Write-Host "Start service with: .\start-service.ps1"
Write-Host "Dashboard: http://127.0.0.1:1930/"
Write-Host "OpenAI endpoint: http://127.0.0.1:1930/v1/chat/completions"