$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$bunPath = "C:\Users\Administrator\AppData\Roaming\npm\node_modules\bun\bin\bun.exe"
$nodePath = "C:\Program Files\nodejs\node.exe"
$databasePath = ".test-state/storage/temp-email-preview-e2e.db"
$databaseFile = Join-Path $repoRoot ".test-state\storage\temp-email-preview-e2e.db"
$port = 1933
$url = "http://127.0.0.1:$port/health"
$stdoutPath = Join-Path $repoRoot ".test-state\storage\temp-email-preview-e2e-server.stdout.log"
$stderrPath = Join-Path $repoRoot ".test-state\storage\temp-email-preview-e2e-server.stderr.log"
$server = $null

Remove-Item -LiteralPath $databaseFile, "$databaseFile-wal", "$databaseFile-shm", $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
$env:HOST = "127.0.0.1"
$env:PORT = [string]$port
$env:DATABASE_PATH = $databasePath
$env:TEMP_EMAIL_E2E_BASE_URL = "http://127.0.0.1:$port"

try {
  & $bunPath "src/db/migrate.ts"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  $server = Start-Process -FilePath $bunPath `
    -ArgumentList @("src/index.ts") `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 250
    try { $health = Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 2 } catch { $health = $null }
  } while (-not $health -and (Get-Date) -lt $deadline)
  if (-not $health) { throw "Temporary E2E server did not become healthy" }

  & $nodePath "--import" "tsx" "scripts/temp-email-preview-e2e.ts"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
  if ($null -ne $server) {
    $server.Refresh()
    if (-not $server.HasExited) {
      Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
      $server.WaitForExit()
    }
  }
  Remove-Item Env:HOST, Env:PORT, Env:DATABASE_PATH, Env:TEMP_EMAIL_E2E_BASE_URL -ErrorAction SilentlyContinue
}
