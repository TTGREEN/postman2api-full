$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$bunPath = "C:\Users\Administrator\AppData\Roaming\npm\node_modules\bun\bin\bun.exe"
$databasePath = ".test-state/storage/postman-health.db"
$databaseFile = Join-Path $repoRoot ".test-state\storage\postman-health.db"
$port = 1932
$url = "http://127.0.0.1:$port/health"
$logRoot = Join-Path $repoRoot ".test-state\storage"
$stdoutPath = Join-Path $logRoot "health-server.stdout.log"
$stderrPath = Join-Path $logRoot "health-server.stderr.log"
$server = $null

if (-not (Test-Path -LiteralPath $bunPath -PathType Leaf)) {
  throw "Bun executable not found at $bunPath"
}

Remove-Item -LiteralPath $databaseFile, "$databaseFile-wal", "$databaseFile-shm", $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
$env:HOST = "127.0.0.1"
$env:PORT = [string]$port
$env:DATABASE_PATH = $databasePath

try {
  & $bunPath "src/db/migrate.ts"
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  $server = Start-Process -FilePath $bunPath `
    -ArgumentList @("src/index.ts") `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

  $deadline = (Get-Date).AddSeconds(20)
  $healthy = $false
  while ((Get-Date) -lt $deadline) {
    $server.Refresh()
    if ($server.HasExited) {
      $serverOutput = Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue
      $serverError = Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue
      throw "Server exited before health check. stdout=$serverOutput stderr=$serverError"
    }

    try {
      $response = Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 2
      $body = $response.Content | ConvertFrom-Json
      if ($response.StatusCode -eq 200 -and $body.status -eq "ok") {
        Write-Output "health status=$($response.StatusCode) body.status=$($body.status)"
        $healthy = $true
        break
      }
    }
    catch {
      Start-Sleep -Milliseconds 250
    }
  }

  if (-not $healthy) {
    throw "Health endpoint did not become ready at $url"
  }
}
finally {
  if ($null -ne $server) {
    $server.Refresh()
    if (-not $server.HasExited) {
      Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
      $server.WaitForExit()
    }
  }
  Remove-Item Env:HOST -ErrorAction SilentlyContinue
  Remove-Item Env:PORT -ErrorAction SilentlyContinue
  Remove-Item Env:DATABASE_PATH -ErrorAction SilentlyContinue
}
