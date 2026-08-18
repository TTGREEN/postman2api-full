param(
  [string]$SourceRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
  [string]$OutputRoot = (Join-Path (Split-Path -Parent $SourceRoot) "$([char]0x53CD)$([char]0x4EE3)$([char]0x5B8C)$([char]0x6574)$([char]0x7248)"),
  [string]$ZipPath = "$OutputRoot.zip",
  [string]$CamoufoxSource = (Join-Path (Split-Path -Parent $SourceRoot) "camoufox-152.0.4-beta.28-win.x86_64"),
  [bool]$IncludeDependencies = $true,
  [bool]$IncludeDashboardDependencies = $true,
  [bool]$IncludeDashboardDist = $true,
  [bool]$IncludeCamoufox = $true,
  [switch]$SkipBuild,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Resolve-FullPath([string]$Path) {
  $parent = Split-Path -Parent $Path
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  [System.IO.Path]::GetFullPath($Path)
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

function Get-RelativePathCompat([string]$BasePath, [string]$FullPath) {
  $baseFull = [System.IO.Path]::GetFullPath($BasePath).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  $full = [System.IO.Path]::GetFullPath($FullPath)
  $baseUri = [Uri]::new($baseFull)
  $fullUri = [Uri]::new($full)
  [Uri]::UnescapeDataString($baseUri.MakeRelativeUri($fullUri).ToString()).Replace('/', [System.IO.Path]::DirectorySeparatorChar)
}

function Test-ExcludedSourcePath([string]$RelativePath) {
  $normalized = $RelativePath.Replace("\", "/").TrimStart("/")
  if ($normalized -eq "") { return $false }

  $blockedExact = @(
    ".env",
    ".git",
    ".test-state",
    ".test-orchestrator",
    "data",
    "node_modules",
    "runtime",
    "tokens",
    "tokens copy",
    "dashboard/node_modules",
    "dashboard/dist",
    ".workbuddy",
    ".playwright-cli"
  )
  foreach ($blocked in $blockedExact) {
    if ($normalized -eq $blocked -or $normalized.StartsWith("$blocked/")) { return $true }
  }
  if ($normalized -like ".env.*") { return $true }
  if ($normalized -like "*.db" -or $normalized -like "*.db-wal" -or $normalized -like "*.db-shm") { return $true }
  if ($normalized -like "*.log") { return $true }
  return $false
}

function Test-PayloadExcludedPath([string]$RelativePath) {
  $normalized = $RelativePath.Replace("\", "/").TrimStart("/")
  if ($normalized -eq "") { return $false }
  if ($normalized -eq ".git" -or $normalized.StartsWith(".git/")) { return $true }
  if ($normalized -eq ".test-state" -or $normalized.StartsWith(".test-state/")) { return $true }
  if ($normalized -eq ".test-orchestrator" -or $normalized.StartsWith(".test-orchestrator/")) { return $true }
  if ($normalized -eq ".env" -or $normalized -like ".env.*") { return $true }
  if ($normalized -eq "data" -or $normalized.StartsWith("data/")) { return $true }
  if ($normalized -eq "tokens" -or $normalized.StartsWith("tokens/")) { return $true }
  if ($normalized -eq "tokens copy" -or $normalized.StartsWith("tokens copy/")) { return $true }
  if ($normalized -like "data/*.db" -or $normalized -like "data/*.db-wal" -or $normalized -like "data/*.db-shm") { return $true }
  if ($normalized -like "*.log") { return $true }
  return $false
}

function Copy-FilteredTree([string]$FromRoot, [string]$ToRoot, [ValidateSet("Source", "Payload")][string]$Mode = "Source") {
  if (-not (Test-Path -LiteralPath $FromRoot)) { return }
  $fromFull = [System.IO.Path]::GetFullPath($FromRoot)
  $files = Get-ChildItem -LiteralPath $fromFull -Recurse -Force -File
  foreach ($file in $files) {
    $relative = Get-RelativePathCompat $fromFull $file.FullName
    if ($Mode -eq "Source") {
      if (Test-ExcludedSourcePath $relative) { continue }
    } else {
      if (Test-PayloadExcludedPath $relative) { continue }
    }
    $target = Join-Path $ToRoot $relative
    $targetDir = Split-Path -Parent $target
    if ($targetDir -and -not (Test-Path -LiteralPath $targetDir)) {
      New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    }
    Copy-Item -LiteralPath $file.FullName -Destination $target -Force
  }
}

function Add-HashBytes($Hash, [byte[]]$Bytes) {
  if ($Bytes.Length -gt 0) {
    [void]$Hash.TransformBlock($Bytes, 0, $Bytes.Length, $null, 0)
  }
}

function Add-HashFile($Hash, [string]$Path) {
  $buffer = [byte[]]::new(1048576)
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      [void]$Hash.TransformBlock($buffer, 0, $read, $null, 0)
    }
  }
  finally {
    $stream.Dispose()
  }
}

function Get-TreeStats([string]$Root, [ValidateSet("Source", "Payload", "Raw")][string]$Mode = "Raw") {
  if (-not (Test-Path -LiteralPath $Root)) {
    return [ordered]@{ present = $false; fileCount = 0; totalBytes = 0; sha256 = $null }
  }
  $hash = [System.Security.Cryptography.SHA256]::Create()
  $totalBytes = 0L
  $fileCount = 0
  $files = Get-ChildItem -LiteralPath $Root -Recurse -Force -File | Sort-Object FullName
  foreach ($file in $files) {
    $relative = Get-RelativePathCompat $Root $file.FullName
    if ($Mode -eq "Source" -and (Test-ExcludedSourcePath $relative)) { continue }
    if ($Mode -eq "Payload" -and (Test-PayloadExcludedPath $relative)) { continue }
    $fileCount += 1
    $totalBytes += $file.Length
    $relativeNormalized = $relative.Replace("\", "/")
    $relativeBytes = [System.Text.Encoding]::UTF8.GetBytes($relativeNormalized)
    Add-HashBytes $hash $relativeBytes
    Add-HashFile $hash $file.FullName
  }
  [void]$hash.TransformFinalBlock([byte[]]::new(0), 0, 0)
  $digest = [BitConverter]::ToString($hash.Hash).Replace("-", "").ToLowerInvariant()
  return [ordered]@{ present = $true; fileCount = $fileCount; totalBytes = $totalBytes; sha256 = $digest }
}

function Backup-ExistingPath([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupPath = "$Path.backup-$stamp"
  $i = 1
  while (Test-Path -LiteralPath $backupPath) {
    $backupPath = "$Path.backup-$stamp-$i"
    $i += 1
  }
  Move-Item -LiteralPath $Path -Destination $backupPath -Force
  return $backupPath
}

function Test-PreservedReleasePath([string]$RelativePath) {
  $normalized = $RelativePath.Replace("\", "/").TrimStart("/")
  if ($normalized -eq ".env" -or $normalized -like ".env.*") { return $true }
  if ($normalized -eq "data" -or $normalized.StartsWith("data/")) { return $true }
  return $false
}

function Assert-ChildPath([string]$Root, [string]$Candidate) {
  $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  $candidateFull = [System.IO.Path]::GetFullPath($Candidate)
  if (-not $candidateFull.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify path outside release root: $candidateFull"
  }
}

function Clear-ReleasePayload([string]$ReleaseRoot) {
  if (-not (Test-Path -LiteralPath $ReleaseRoot)) {
    New-Item -ItemType Directory -Force -Path $ReleaseRoot | Out-Null
    return
  }
  $items = Get-ChildItem -LiteralPath $ReleaseRoot -Force
  foreach ($item in $items) {
    $relative = Get-RelativePathCompat $ReleaseRoot $item.FullName
    if (Test-PreservedReleasePath $relative) { continue }
    Assert-ChildPath $ReleaseRoot $item.FullName
    Remove-Item -LiteralPath $item.FullName -Recurse -Force
  }
}

function Publish-StagingToOutput([string]$StagingRoot, [string]$ReleaseRoot) {
  Clear-ReleasePayload $ReleaseRoot
  Copy-FilteredTree -FromRoot $StagingRoot -ToRoot $ReleaseRoot -Mode Payload
}

function Get-CamoufoxVersionInfo([string]$Path) {
  $leaf = Split-Path -Leaf $Path
  $version = "152.0.4"
  $release = "beta.28"
  if ($leaf -match "camoufox-(?<version>\d+\.\d+\.\d+)-(?<release>[a-zA-Z]+\.\d+)") {
    $version = $Matches.version
    $release = $Matches.release
  }
  return [ordered]@{ version = $version; release = $release }
}

function Ensure-CamoufoxVersionJson([string]$CamoufoxRoot, [string]$SourcePath) {
  if (-not (Test-Path -LiteralPath $CamoufoxRoot)) { return $false }
  $versionPath = Join-Path $CamoufoxRoot "version.json"
  if (Test-Path -LiteralPath $versionPath) {
    $raw = [System.IO.File]::ReadAllText($versionPath)
    $trimmed = $raw.TrimStart([char]0xFEFF)
    try {
      $parsed = $trimmed | ConvertFrom-Json -ErrorAction Stop
      Write-JsonNoBom $versionPath ([ordered]@{ version = [string]$parsed.version; release = [string]$parsed.release }) 4
      return $raw.StartsWith([string][char]0xFEFF)
    }
    catch {
      # Fall through and regenerate malformed version metadata.
    }
  }
  $info = Get-CamoufoxVersionInfo $SourcePath
  Write-JsonNoBom $versionPath $info 4
  return $true
}

function Write-DeployScript([string]$ReleaseRoot) {
  $deploy = @'
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
'@
  Write-Utf8NoBom (Join-Path $ReleaseRoot "deploy.ps1") $deploy
  Write-Utf8NoBom (Join-Path $ReleaseRoot "$([char]0x4E00)$([char]0x952E)$([char]0x90E8)$([char]0x7F72).ps1") $deploy
  Write-Utf8NoBom (Join-Path $ReleaseRoot "$([char]0x4E00)$([char]0x952E)$([char]0x90E8)$([char]0x7F72).cmd") "@echo off`r`npowershell -ExecutionPolicy Bypass -File ""%~dp0deploy.ps1""`r`npause`r`n"
}

function Write-StartScript([string]$ReleaseRoot) {
  $start = @'
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Test-Tool([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
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
    throw "Bundled Camoufox runtime is missing. Run deploy.ps1 from a complete release package first."
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
    throw "Bun is not available. Run deploy.ps1 first, then reopen PowerShell if needed."
  }
  $webglDb = Join-Path $root "node_modules\camoufox-js\dist\data-files\webgl_data.db"
  if (-not (Test-Path -LiteralPath $webglDb)) {
    throw "camoufox-js WebGL fingerprint database is missing. Run deploy.ps1 from a complete release package first."
  }
}

Write-Host "== postman2api service startup =="
Write-Host "Project: $root"
Enable-CamoufoxRuntime
Assert-Ready

Write-Host "Running database migration..."
bun run migrate
if ($LASTEXITCODE -ne 0) { throw "bun run migrate failed." }

Write-Host ""
Write-Host "Dashboard: http://127.0.0.1:1930/"
Write-Host "OpenAI endpoint: http://127.0.0.1:1930/v1/chat/completions"
Write-Host "Starting service..."
bun run start
'@
  Write-Utf8NoBom (Join-Path $ReleaseRoot "start-service.ps1") $start
  Write-Utf8NoBom (Join-Path $ReleaseRoot "$([char]0x4E00)$([char]0x952E)$([char]0x542F)$([char]0x52A8)$([char]0x670D)$([char]0x52A1).ps1") $start
  Write-Utf8NoBom (Join-Path $ReleaseRoot "start-service.cmd") "@echo off`r`npowershell -ExecutionPolicy Bypass -File ""%~dp0start-service.ps1""`r`npause`r`n"
  Write-Utf8NoBom (Join-Path $ReleaseRoot "$([char]0x4E00)$([char]0x952E)$([char]0x542F)$([char]0x52A8)$([char]0x670D)$([char]0x52A1).cmd") "@echo off`r`npowershell -ExecutionPolicy Bypass -File ""%~dp0start-service.ps1""`r`npause`r`n"
}

$source = (Resolve-Path -LiteralPath $SourceRoot).Path
$output = Resolve-FullPath $OutputRoot
$zip = Resolve-FullPath $ZipPath
$rootDependenciesSource = Join-Path $source "node_modules"
$dashboardDependenciesSource = Join-Path $source "dashboard\node_modules"
$dashboardDistSource = Join-Path $source "dashboard\dist"
$camoufoxSourceResolved = if (Test-Path -LiteralPath $CamoufoxSource) { (Resolve-Path -LiteralPath $CamoufoxSource).Path } else { $CamoufoxSource }

  if ($DryRun) {
  $candidateFiles = Get-ChildItem -LiteralPath $source -Recurse -Force -File |
    Where-Object { -not (Test-ExcludedSourcePath (Get-RelativePathCompat $source $_.FullName)) }
  [ordered]@{
    mode = "dry-run"
    source = $source
    output = $output
    zip = $zip
    sourceFileCount = $candidateFiles.Count
    includeDependencies = [bool]$IncludeDependencies
    includeDashboardDependencies = [bool]$IncludeDashboardDependencies
    includeDashboardDist = [bool]$IncludeDashboardDist
    includeCamoufox = [bool]$IncludeCamoufox
    rootDependencies = Get-TreeStats $rootDependenciesSource Payload
    dashboardDependencies = Get-TreeStats $dashboardDependenciesSource Payload
    dashboardDist = Get-TreeStats $dashboardDistSource Payload
    camoufoxSource = $camoufoxSourceResolved
    camoufox = Get-TreeStats $camoufoxSourceResolved Payload
    preservedExistingEnv = $true
    preservedExistingDatabase = $true
    exclusions = @(".env", ".env.*", ".git", "data", ".test-state", ".test-orchestrator", "tokens", "tokens copy", "*.log")
  } | ConvertTo-Json -Depth 8
  exit 0
}

Push-Location $source
try {
  if (-not $SkipBuild) {
    bun run build
    if ($LASTEXITCODE -ne 0) { throw "bun run build failed before packaging." }
  }

  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $staging = Resolve-FullPath "$output.staging-$stamp"
  if (Test-Path -LiteralPath $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $staging | Out-Null

  Copy-FilteredTree -FromRoot $source -ToRoot $staging -Mode Source

  $dependenciesIncluded = $false
  $dashboardDependenciesIncluded = $false
  $dashboardDistIncluded = $false
  $camoufoxIncluded = $false
  $camoufoxVersionJsonGenerated = $false

  if ($IncludeDependencies -and (Test-Path -LiteralPath $rootDependenciesSource)) {
    Copy-FilteredTree -FromRoot $rootDependenciesSource -ToRoot (Join-Path $staging "node_modules") -Mode Payload
    $dependenciesIncluded = $true
  }

  if ($IncludeDashboardDependencies -and (Test-Path -LiteralPath $dashboardDependenciesSource)) {
    Copy-FilteredTree -FromRoot $dashboardDependenciesSource -ToRoot (Join-Path $staging "dashboard\node_modules") -Mode Payload
    $dashboardDependenciesIncluded = $true
  }

  if ($IncludeDashboardDist -and (Test-Path -LiteralPath $dashboardDistSource)) {
    Copy-FilteredTree -FromRoot $dashboardDistSource -ToRoot (Join-Path $staging "dashboard\dist") -Mode Payload
    $dashboardDistIncluded = $true
  }

  if ($IncludeCamoufox -and (Test-Path -LiteralPath $camoufoxSourceResolved)) {
    $camoufoxTarget = Join-Path $staging "runtime\camoufox"
    Copy-FilteredTree -FromRoot $camoufoxSourceResolved -ToRoot $camoufoxTarget -Mode Payload
    $camoufoxVersionJsonGenerated = Ensure-CamoufoxVersionJson $camoufoxTarget $camoufoxSourceResolved
    $camoufoxIncluded = Test-Path -LiteralPath (Join-Path $camoufoxTarget "camoufox.exe")
  }

  Write-DeployScript $staging
  Write-StartScript $staging

  $commit = (git rev-parse HEAD).Trim()
  $branch = (git branch --show-current).Trim()
  $status = git status --short
  $rootDependencyStats = Get-TreeStats (Join-Path $staging "node_modules") Raw
  $dashboardDependencyStats = Get-TreeStats (Join-Path $staging "dashboard\node_modules") Raw
  $dashboardDistStats = Get-TreeStats (Join-Path $staging "dashboard\dist") Raw
  $camoufoxStats = Get-TreeStats (Join-Path $staging "runtime\camoufox") Raw
  $releaseStats = Get-TreeStats $staging Raw
  $previousOutputBackup = $null

  $manifest = [ordered]@{
    name = "postman2api-release"
    generatedAt = (Get-Date).ToString("o")
    source = $source
    branch = $branch
    commit = $commit
    dirty = [bool]$status
    output = $output
    staging = $staging
    zip = $zip
    buildCommand = if ($SkipBuild) { "skipped" } else { "bun run build" }
    deployScripts = @("deploy.ps1", "$([char]0x4E00)$([char]0x952E)$([char]0x90E8)$([char]0x7F72).ps1", "$([char]0x4E00)$([char]0x952E)$([char]0x90E8)$([char]0x7F72).cmd")
    startScripts = @("start-service.ps1", "start-service.cmd", "$([char]0x4E00)$([char]0x952E)$([char]0x542F)$([char]0x52A8)$([char]0x670D)$([char]0x52A1).ps1", "$([char]0x4E00)$([char]0x952E)$([char]0x542F)$([char]0x52A8)$([char]0x670D)$([char]0x52A1).cmd")
    deployScript = "deploy.ps1"
    startScript = "start-service.ps1"
    publishMode = "in-place-preserve-env-and-data"
    preservedExistingEnv = $true
    preservedExistingDatabase = $true
    migrationCommand = "bun run migrate"
    dependenciesIncluded = [bool]$dependenciesIncluded
    dashboardDependenciesIncluded = [bool]$dashboardDependenciesIncluded
    dashboardDistIncluded = [bool]$dashboardDistIncluded
    camoufoxIncluded = [bool]$camoufoxIncluded
    camoufoxSource = $camoufoxSourceResolved
    camoufoxVersionJsonGenerated = [bool]$camoufoxVersionJsonGenerated
    rootDependencies = $rootDependencyStats
    dashboardDependencies = $dashboardDependencyStats
    dashboardDist = $dashboardDistStats
    camoufox = $camoufoxStats
    release = $releaseStats
    previousOutputBackup = $previousOutputBackup
    previousZipBackup = $null
    exclusions = @(".env", ".env.*", ".git", "data", ".test-state", ".test-orchestrator", "tokens", "tokens copy", "*.log")
  }

  $previousZipBackup = Backup-ExistingPath $zip
  $manifest["previousZipBackup"] = $previousZipBackup
  Write-JsonNoBom (Join-Path $staging "RELEASE_MANIFEST.json") $manifest 10
  Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zip -Force
  Publish-StagingToOutput -StagingRoot $staging -ReleaseRoot $output
  Remove-Item -LiteralPath $staging -Recurse -Force

  Write-Host "Release package created:"
  Write-Host "  Directory: $output"
  Write-Host "  Zip:       $zip"
  $manifestPath = Join-Path $output "RELEASE_MANIFEST.json"
  Write-Host "  Manifest:  $manifestPath"
}
finally {
  Pop-Location
}
