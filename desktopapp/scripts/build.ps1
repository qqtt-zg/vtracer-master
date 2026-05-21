$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$webappDir = Join-Path $repoRoot "webapp/app"
$tauriDir = Join-Path $repoRoot "desktopapp/src-tauri"

Write-Host "[vtracer-desktop] building webapp dist..."
Push-Location $webappDir
try {
    npm run build
} finally {
    Pop-Location
}

Write-Host "[vtracer-desktop] building tauri windows package..."
Push-Location $tauriDir
try {
    cargo tauri build
} finally {
    Pop-Location
}
