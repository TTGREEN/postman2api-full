$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$bunPath = "C:\Users\Administrator\AppData\Roaming\npm\node_modules\bun\bin\bun.exe"
$databasePath = ".test-state/storage/postman-unit.db"
$databaseFile = Join-Path $repoRoot ".test-state\storage\postman-unit.db"

if (-not (Test-Path -LiteralPath $bunPath -PathType Leaf)) {
  throw "Bun executable not found at $bunPath"
}

Remove-Item -LiteralPath $databaseFile, "$databaseFile-wal", "$databaseFile-shm" -Force -ErrorAction SilentlyContinue
$env:DATABASE_PATH = $databasePath

try {
  & $bunPath "src/db/migrate.ts"
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  & $bunPath "test"
  exit $LASTEXITCODE
}
finally {
  Remove-Item Env:DATABASE_PATH -ErrorAction SilentlyContinue
}
