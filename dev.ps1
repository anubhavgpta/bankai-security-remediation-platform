<#
  Starts everything needed for local development in one go:
    - Redis                    (via Docker, only if nothing's already on 6379)
    - backend API              (backend: npm run dev, port 4000)
    - backend repo-scan worker (backend: npm run worker, needs Redis)
    - frontend                 (frontend: npm run dev, port 5173)

  Each of backend/worker/frontend runs in its own PowerShell window so logs
  stay readable and any one of them can be restarted/closed independently.
  Close the window (or hit Ctrl+C inside it) to stop that piece. The Redis
  container (if this script started it) keeps running afterward - stop it
  yourself with 'docker stop bankai-redis' when you're done.

  Usage:
    .\dev.ps1            # starts Redis (if needed) + backend API + worker + frontend
    .\dev.ps1 -NoWorker  # skip the repo-scan worker and the Redis check
#>

param(
  [switch]$NoWorker
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

function Start-DevWindow {
  param(
    [string]$Title,
    [string]$WorkingDirectory,
    [string]$Command
  )
  $inner = "`$host.UI.RawUI.WindowTitle = '$Title'; Set-Location '$WorkingDirectory'; $Command"
  Start-Process powershell -ArgumentList "-NoExit", "-Command", $inner | Out-Null
  Write-Host "  Started: $Title" -ForegroundColor Green
}

if (-not (Test-Path (Join-Path $root "backend\node_modules"))) {
  Write-Host "backend\node_modules is missing - run 'npm install' in backend\ first." -ForegroundColor Yellow
}
if (-not (Test-Path (Join-Path $root "frontend\node_modules"))) {
  Write-Host "frontend\node_modules is missing - run 'npm install' in frontend\ first." -ForegroundColor Yellow
}
if (-not (Test-Path (Join-Path $root "backend\.env"))) {
  Write-Host "backend\.env is missing - copy backend\.env.example to backend\.env and fill it in first." -ForegroundColor Yellow
}

if (-not $NoWorker) {
  $redisOk = (Test-NetConnection -ComputerName "localhost" -Port 6379 -WarningAction SilentlyContinue -InformationLevel Quiet)
  if (-not $redisOk) {
    $dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
    if ($dockerCmd) {
      Write-Host "Redis isn't reachable on localhost:6379 - starting it via Docker (container 'bankai-redis')..." -ForegroundColor Yellow
      $existing = docker ps -a --filter "name=^/bankai-redis$" --format "{{.Names}}" 2>$null
      if ($existing -eq "bankai-redis") {
        docker start bankai-redis | Out-Null
      } else {
        docker run -d --name bankai-redis -p 6379:6379 redis | Out-Null
      }
      # Give it a moment to come up, then re-check.
      $ready = $false
      for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Seconds 1
        if (Test-NetConnection -ComputerName "localhost" -Port 6379 -WarningAction SilentlyContinue -InformationLevel Quiet) {
          $ready = $true
          break
        }
      }
      if ($ready) {
        Write-Host "Redis is up (docker container 'bankai-redis')." -ForegroundColor Green
      } else {
        Write-Host "Started the Redis container but it isn't answering on 6379 yet - the worker will retry its connection." -ForegroundColor Yellow
      }
    } else {
      Write-Host "Redis isn't reachable on localhost:6379 and Docker isn't installed - the worker needs Redis (REDIS_URL in backend\.env). Starting it anyway; it'll retry its connection." -ForegroundColor Yellow
    }
  }
}

Write-Host "Starting Bankai dev environment..." -ForegroundColor Cyan

Start-DevWindow -Title "Bankai: backend API (4000)" -WorkingDirectory (Join-Path $root "backend") -Command "npm run dev"

if (-not $NoWorker) {
  Start-DevWindow -Title "Bankai: repo-scan worker" -WorkingDirectory (Join-Path $root "backend") -Command "npm run worker"
}

Start-DevWindow -Title "Bankai: frontend (5173)" -WorkingDirectory (Join-Path $root "frontend") -Command "npm run dev"

Write-Host ""
Write-Host "All set. Frontend: http://localhost:5173  Backend: http://localhost:4000" -ForegroundColor Cyan
Write-Host "Each service is running in its own window - close a window (or Ctrl+C inside it) to stop that piece." -ForegroundColor Cyan
