param(
    [switch]$SkipWebBuild
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$webappDir = Join-Path $repoRoot "webapp/app"
$tauriDir = Join-Path $repoRoot "desktopapp/src-tauri"

if (-not $SkipWebBuild) {
    Write-Host "[vtracer-desktop] building webapp dist..."
    Push-Location $webappDir
    try {
        npm run build
    } finally {
        Pop-Location
    }
}

Write-Host "[vtracer-desktop] starting tauri dev..."
Push-Location $tauriDir
try {
    cargo tauri dev
} finally {
    Pop-Location
}
