param(
    [switch]$SkipWasm
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$WebRoot = Join-Path $RepoRoot "webapp"
$WebAppRoot = Join-Path $WebRoot "app"
$DistRoot = Join-Path $WebAppRoot "dist"
$DocsRoot = Join-Path $RepoRoot "docs"

if (-not $SkipWasm) {
    Push-Location $WebRoot
    try {
        wasm-pack build --target web
    }
    finally {
        Pop-Location
    }
}

Push-Location $WebAppRoot
try {
    npm run build
}
finally {
    Pop-Location
}

if (-not (Test-Path $DistRoot)) {
    throw "Build output does not exist: $DistRoot"
}

$resolvedRepoRoot = (Resolve-Path $RepoRoot).Path
$resolvedDocsRoot = (Join-Path $resolvedRepoRoot "docs")
if (-not $resolvedDocsRoot.StartsWith($resolvedRepoRoot)) {
    throw "Safety check failed: docs directory is outside repository."
}

if (Test-Path $DocsRoot) {
    Get-ChildItem -Path $DocsRoot -Force | Remove-Item -Recurse -Force
}
else {
    New-Item -ItemType Directory -Path $DocsRoot | Out-Null
}

Copy-Item -Path (Join-Path $DistRoot "*") -Destination $DocsRoot -Recurse -Force
Write-Host "Docs synced from $DistRoot to $DocsRoot"
