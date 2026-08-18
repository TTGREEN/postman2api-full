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
  if ($normalized -like "*.db" -or $normalized -like "*.db-wal" -or $normalized -like "*.db-shm") { return $true }
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
  if (Test-Path -LiteralPath $versionPath) { return $false }
  $info = Get-CamoufoxVersionInfo $SourcePath
  $info | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $versionPath -Encoding UTF8
  return $true
}

function Write-DeployScript([string]$ReleaseRoot) {
  $deployB64 = "JEVycm9yQWN0aW9uUHJlZmVyZW5jZSA9ICJTdG9wIgpTZXQtU3RyaWN0TW9kZSAtVmVyc2lvbiBMYXRlc3QKCiRyb290ID0gU3BsaXQtUGF0aCAtUGFyZW50ICRNeUludm9jYXRpb24uTXlDb21tYW5kLlBhdGgKU2V0LUxvY2F0aW9uICRyb290CgpmdW5jdGlvbiBUZXN0LVRvb2woW3N0cmluZ10kTmFtZSkgewogIHJldHVybiBbYm9vbF0oR2V0LUNvbW1hbmQgJE5hbWUgLUVycm9yQWN0aW9uIFNpbGVudGx5Q29udGludWUpCn0KCmZ1bmN0aW9uIEVuc3VyZS1EaXJlY3RvcnkoW3N0cmluZ10kUGF0aCkgewogIGlmICgtbm90IChUZXN0LVBhdGggLUxpdGVyYWxQYXRoICRQYXRoKSkgewogICAgTmV3LUl0ZW0gLUl0ZW1UeXBlIERpcmVjdG9yeSAtRm9yY2UgLVBhdGggJFBhdGggfCBPdXQtTnVsbAogIH0KfQoKZnVuY3Rpb24gQWRkLUVudlZhbHVlSWZNaXNzaW5nKFtzdHJpbmddJE5hbWUsIFtzdHJpbmddJFZhbHVlKSB7CiAgJGVudlBhdGggPSBKb2luLVBhdGggJHJvb3QgIi5lbnYiCiAgaWYgKC1ub3QgKFRlc3QtUGF0aCAtTGl0ZXJhbFBhdGggJGVudlBhdGgpKSB7IHJldHVybiB9CiAgJHBhdHRlcm4gPSAiXlxzKiIgKyBbcmVnZXhdOjpFc2NhcGUoJE5hbWUpICsgIlxzKj0iCiAgaWYgKC1ub3QgKFNlbGVjdC1TdHJpbmcgLUxpdGVyYWxQYXRoICRlbnZQYXRoIC1QYXR0ZXJuICRwYXR0ZXJuIC1RdWlldCkpIHsKICAgIEFkZC1Db250ZW50IC1MaXRlcmFsUGF0aCAkZW52UGF0aCAtRW5jb2RpbmcgVVRGOCAtVmFsdWUgIiROYW1lPSRWYWx1ZSIKICAgIFdyaXRlLUhvc3QgIkFkZGVkIHNldHRpbmcgdG8gLmVudjogJE5hbWUiCiAgfSBlbHNlIHsKICAgIFdyaXRlLUhvc3QgIlByZXNlcnZlZCBleGlzdGluZyAuZW52IHNldHRpbmc6ICROYW1lIgogIH0KfQoKZnVuY3Rpb24gRW5zdXJlLUJ1bigpIHsKICBpZiAoVGVzdC1Ub29sICJidW4iKSB7CiAgICBXcml0ZS1Ib3N0ICJCdW4gZGV0ZWN0ZWQuIgogICAgcmV0dXJuCiAgfQoKICBXcml0ZS1Ib3N0ICJCdW4gbm90IGZvdW5kLiBJbnN0YWxsaW5nIEJ1biBydW50aW1lLi4uIgogIGlmIChUZXN0LVRvb2wgIm5wbSIpIHsKICAgIG5wbSBpbnN0YWxsIC1nIGJ1bgogICAgaWYgKCRMQVNURVhJVENPREUgLW5lIDApIHsgdGhyb3cgIkJ1biBpbnN0YWxsIHRocm91Z2ggbnBtIGZhaWxlZC4iIH0KICB9IGVsc2UgewogICAgJGluc3RhbGxlciA9IEpvaW4tUGF0aCAkZW52OlRFTVAgImJ1bi1pbnN0YWxsLnBzMSIKICAgIEludm9rZS1XZWJSZXF1ZXN0IC1Vc2VCYXNpY1BhcnNpbmcgLVVyaSAiaHR0cHM6Ly9idW4uc2gvaW5zdGFsbC5wczEiIC1PdXRGaWxlICRpbnN0YWxsZXIKICAgIHBvd2Vyc2hlbGwgLUV4ZWN1dGlvblBvbGljeSBCeXBhc3MgLUZpbGUgJGluc3RhbGxlcgogICAgJGJ1bkJpbiA9IEpvaW4tUGF0aCAkZW52OlVTRVJQUk9GSUxFICIuYnVuXGJpbiIKICAgIGlmIChUZXN0LVBhdGggLUxpdGVyYWxQYXRoICRidW5CaW4pIHsKICAgICAgJGVudjpQQVRIID0gIiRidW5CaW47JGVudjpQQVRIIgogICAgfQogIH0KCiAgaWYgKC1ub3QgKFRlc3QtVG9vbCAiYnVuIikpIHsKICAgIHRocm93ICJCdW4gaW5zdGFsbGF0aW9uIGZpbmlzaGVkIGJ1dCBidW4gaXMgc3RpbGwgbm90IGF2YWlsYWJsZSBpbiB0aGlzIHNoZWxsLiBSZW9wZW4gUG93ZXJTaGVsbCBhbmQgcnVuIGRlcGxveS5wczEgYWdhaW4uIgogIH0KfQoKV3JpdGUtSG9zdCAiPT0gcG9zdG1hbjJhcGkgb25lLWNsaWNrIGRlcGxveSA9PSIKV3JpdGUtSG9zdCAiUHJvamVjdDogJHJvb3QiCgppZiAoLW5vdCAoVGVzdC1QYXRoIC1MaXRlcmFsUGF0aCAoSm9pbi1QYXRoICRyb290ICIuZW52IikpKSB7CiAgaWYgKFRlc3QtUGF0aCAtTGl0ZXJhbFBhdGggKEpvaW4tUGF0aCAkcm9vdCAiLmVudi5leGFtcGxlIikpIHsKICAgIENvcHktSXRlbSAtTGl0ZXJhbFBhdGggKEpvaW4tUGF0aCAkcm9vdCAiLmVudi5leGFtcGxlIikgLURlc3RpbmF0aW9uIChKb2luLVBhdGggJHJvb3QgIi5lbnYiKSAtRm9yY2UKICAgIFdyaXRlLUhvc3QgIkNyZWF0ZWQgLmVudiBmcm9tIC5lbnYuZXhhbXBsZS4iCiAgfSBlbHNlIHsKICAgIFdyaXRlLUhvc3QgIi5lbnYgbm90IGZvdW5kIGFuZCAuZW52LmV4YW1wbGUgaXMgbWlzc2luZzsga2VlcGluZyBkZXBsb3ltZW50IHdpdGhvdXQgY3JlYXRpbmcgLmVudi4iCiAgfQp9IGVsc2UgewogIFdyaXRlLUhvc3QgIlByZXNlcnZlZCBleGlzdGluZyAuZW52LiIKfQoKJGRhdGFEaXIgPSBKb2luLVBhdGggJHJvb3QgImRhdGEiCkVuc3VyZS1EaXJlY3RvcnkgJGRhdGFEaXIKJGRlZmF1bHREYiA9IEpvaW4tUGF0aCAkZGF0YURpciAicG9zdG1hbjJhcGkuZGIiCmlmIChUZXN0LVBhdGggLUxpdGVyYWxQYXRoICRkZWZhdWx0RGIpIHsKICBXcml0ZS1Ib3N0ICJQcmVzZXJ2ZWQgZXhpc3RpbmcgZGF0YWJhc2U6IGRhdGFccG9zdG1hbjJhcGkuZGIiCn0gZWxzZSB7CiAgV3JpdGUtSG9zdCAiRGF0YWJhc2UgZmlsZSBub3QgZm91bmQ7IG1pZ3JhdGlvbiB3aWxsIGNyZWF0ZSBpdCBpZiBkZWZhdWx0IERBVEFCQVNFX1BBVEggaXMgdXNlZC4iCn0KCiRjYW1vdWZveFJvb3QgPSBKb2luLVBhdGggJHJvb3QgInJ1bnRpbWVcY2Ftb3Vmb3giCiRjYW1vdWZveEV4ZSA9IEpvaW4tUGF0aCAkY2Ftb3Vmb3hSb290ICJjYW1vdWZveC5leGUiCmlmIChUZXN0LVBhdGggLUxpdGVyYWxQYXRoICRjYW1vdWZveEV4ZSkgewogICR2ZXJzaW9uUGF0aCA9IEpvaW4tUGF0aCAkY2Ftb3Vmb3hSb290ICJ2ZXJzaW9uLmpzb24iCiAgaWYgKC1ub3QgKFRlc3QtUGF0aCAtTGl0ZXJhbFBhdGggJHZlcnNpb25QYXRoKSkgewogICAgQHsgdmVyc2lvbiA9ICIxNTIuMC40IjsgcmVsZWFzZSA9ICJiZXRhLjI4IiB9IHwgQ29udmVydFRvLUpzb24gfCBTZXQtQ29udGVudCAtTGl0ZXJhbFBhdGggJHZlcnNpb25QYXRoIC1FbmNvZGluZyBVVEY4CiAgICBXcml0ZS1Ib3N0ICJDcmVhdGVkIHJ1bnRpbWVcY2Ftb3Vmb3hcdmVyc2lvbi5qc29uLiIKICB9CiAgJGVudjpDQU1PVUZPWF9JTlNUQUxMX0RJUiA9ICRjYW1vdWZveFJvb3QKICAkZW52OkNBTU9VRk9YX1NLSVBfQlJPV1NFUl9ET1dOTE9BRCA9ICIxIgogICRlbnY6UExBWVdSSUdIVF9TS0lQX0JST1dTRVJfRE9XTkxPQUQgPSAiMSIKICBBZGQtRW52VmFsdWVJZk1pc3NpbmcgIkNBTU9VRk9YX0lOU1RBTExfRElSIiAkY2Ftb3Vmb3hSb290CiAgQWRkLUVudlZhbHVlSWZNaXNzaW5nICJDQU1PVUZPWF9TS0lQX0JST1dTRVJfRE9XTkxPQUQiICIxIgogIEFkZC1FbnZWYWx1ZUlmTWlzc2luZyAiUExBWVdSSUdIVF9TS0lQX0JST1dTRVJfRE9XTkxPQUQiICIxIgogIFdyaXRlLUhvc3QgIkJ1bmRsZWQgQ2Ftb3Vmb3ggcnVudGltZSBkZXRlY3RlZC4gQnJvd3NlciBkb3dubG9hZCBpcyBza2lwcGVkLiIKfSBlbHNlIHsKICBXcml0ZS1Ib3N0ICJCdW5kbGVkIENhbW91Zm94IHJ1bnRpbWUgbm90IGZvdW5kLiBEZXBlbmRlbmN5IGluc3RhbGwgbWF5IGRvd25sb2FkIGJyb3dzZXIgYXNzZXRzIGlmIG5lZWRlZC4iCn0KCkVuc3VyZS1CdW4KCiRyb290RGVwc09rID0gKFRlc3QtUGF0aCAtTGl0ZXJhbFBhdGggKEpvaW4tUGF0aCAkcm9vdCAibm9kZV9tb2R1bGVzXGhvbm8iKSkgLWFuZCAoVGVzdC1QYXRoIC1MaXRlcmFsUGF0aCAoSm9pbi1QYXRoICRyb290ICJub2RlX21vZHVsZXNcY2Ftb3Vmb3gtanMiKSkgLWFuZCAoVGVzdC1QYXRoIC1MaXRlcmFsUGF0aCAoSm9pbi1QYXRoICRyb290ICJub2RlX21vZHVsZXNccGxheXdyaWdodCIpKQppZiAoJHJvb3REZXBzT2spIHsKICBXcml0ZS1Ib3N0ICJSb290IGRlcGVuZGVuY2llcyBhcmUgYWxyZWFkeSBpbmNsdWRlZC4iCn0gZWxzZSB7CiAgV3JpdGUtSG9zdCAiUm9vdCBkZXBlbmRlbmNpZXMgbWlzc2luZzsgcnVubmluZyBidW4gaW5zdGFsbC4iCiAgYnVuIGluc3RhbGwKICBpZiAoJExBU1RFWElUQ09ERSAtbmUgMCkgeyB0aHJvdyAiYnVuIGluc3RhbGwgZmFpbGVkLiIgfQp9CgokZGFzaGJvYXJkUm9vdCA9IEpvaW4tUGF0aCAkcm9vdCAiZGFzaGJvYXJkIgppZiAoVGVzdC1QYXRoIC1MaXRlcmFsUGF0aCAoSm9pbi1QYXRoICRkYXNoYm9hcmRSb290ICJwYWNrYWdlLmpzb24iKSkgewogICRkYXNoYm9hcmREZXBzT2sgPSAoVGVzdC1QYXRoIC1MaXRlcmFsUGF0aCAoSm9pbi1QYXRoICRkYXNoYm9hcmRSb290ICJub2RlX21vZHVsZXNcdml0ZSIpKSAtYW5kIChUZXN0LVBhdGggLUxpdGVyYWxQYXRoIChKb2luLVBhdGggJGRhc2hib2FyZFJvb3QgIm5vZGVfbW9kdWxlc1xyZWFjdCIpKQogIGlmICgkZGFzaGJvYXJkRGVwc09rKSB7CiAgICBXcml0ZS1Ib3N0ICJEYXNoYm9hcmQgZGVwZW5kZW5jaWVzIGFyZSBhbHJlYWR5IGluY2x1ZGVkLiIKICB9IGVsc2UgewogICAgV3JpdGUtSG9zdCAiRGFzaGJvYXJkIGRlcGVuZGVuY2llcyBtaXNzaW5nOyBpbnN0YWxsaW5nIGRhc2hib2FyZCBkZXBlbmRlbmNpZXMuIgogICAgUHVzaC1Mb2NhdGlvbiAkZGFzaGJvYXJkUm9vdAogICAgdHJ5IHsKICAgICAgYnVuIGluc3RhbGwKICAgICAgaWYgKCRMQVNURVhJVENPREUgLW5lIDApIHsgdGhyb3cgImRhc2hib2FyZCBidW4gaW5zdGFsbCBmYWlsZWQuIiB9CiAgICB9IGZpbmFsbHkgewogICAgICBQb3AtTG9jYXRpb24KICAgIH0KICB9Cn0KCiRkaXN0SW5kZXggPSBKb2luLVBhdGggJGRhc2hib2FyZFJvb3QgImRpc3RcaW5kZXguaHRtbCIKaWYgKFRlc3QtUGF0aCAtTGl0ZXJhbFBhdGggJGRpc3RJbmRleCkgewogIFdyaXRlLUhvc3QgIkRhc2hib2FyZCBidWlsZCBvdXRwdXQgYWxyZWFkeSBleGlzdHMuIgp9IGVsc2UgewogIFdyaXRlLUhvc3QgIkRhc2hib2FyZCBidWlsZCBvdXRwdXQgbWlzc2luZzsgYnVpbGRpbmcgZGFzaGJvYXJkLiIKICBidW4gcnVuIGJ1aWxkCiAgaWYgKCRMQVNURVhJVENPREUgLW5lIDApIHsgdGhyb3cgImJ1biBydW4gYnVpbGQgZmFpbGVkLiIgfQp9CgpXcml0ZS1Ib3N0ICJSdW5uaW5nIGRhdGFiYXNlIG1pZ3JhdGlvbiB3aXRob3V0IHJlcGxhY2luZyBleGlzdGluZyBkYXRhLi4uIgpidW4gcnVuIG1pZ3JhdGUKaWYgKCRMQVNURVhJVENPREUgLW5lIDApIHsgdGhyb3cgImJ1biBydW4gbWlncmF0ZSBmYWlsZWQuIiB9CgpXcml0ZS1Ib3N0ICIiCldyaXRlLUhvc3QgIkRlcGxveW1lbnQgY2hlY2sgZmluaXNoZWQuIgpXcml0ZS1Ib3N0ICJTdGFydCBzZXJ2aWNlIHdpdGg6IGJ1biBydW4gc3RhcnQiCg=="
  $deploy = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($deployB64))
  Set-Content -LiteralPath (Join-Path $ReleaseRoot "deploy.ps1") -Value $deploy -Encoding UTF8
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
    exclusions = @(".env", ".env.*", ".git", "data", ".test-state", ".test-orchestrator", "tokens", "*.db", "*.log")
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
    deployScript = "deploy.ps1"
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
    exclusions = @(".env", ".env.*", ".git", "data", ".test-state", ".test-orchestrator", "tokens", "*.db", "*.db-wal", "*.db-shm", "*.log")
  }

  $previousZipBackup = Backup-ExistingPath $zip
  $manifest["previousZipBackup"] = $previousZipBackup
  $manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $staging "RELEASE_MANIFEST.json") -Encoding UTF8
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
