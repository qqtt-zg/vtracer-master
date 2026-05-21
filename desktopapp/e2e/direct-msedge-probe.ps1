param(
    [string]$DriverPath = "",
    [string]$AppPath = "",
    [string]$DriverHost = "127.0.0.1",
    [int]$Port = 9777
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if ([string]::IsNullOrWhiteSpace($DriverPath)) {
    $DriverPath = Join-Path $repoRoot "msedgedriver.exe"
}
if ([string]::IsNullOrWhiteSpace($AppPath)) {
    $AppPath = Join-Path $repoRoot "desktopapp\src-tauri\target\debug\vtracer-desktop.exe"
}
$logsDir = Join-Path $PSScriptRoot ".artifacts\logs"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
$driverLog = Join-Path $logsDir "msedgedriver.direct.log"

if (-not (Test-Path $DriverPath)) {
    throw "msedgedriver not found: $DriverPath"
}
if (-not (Test-Path $AppPath)) {
    throw "app not found: $AppPath"
}

$proc = $null
try {
    $proc = Start-Process -FilePath $DriverPath `
        -ArgumentList @("--port=$Port", "--host=$DriverHost", "--verbose", "--log-path=$driverLog") `
        -PassThru
    Start-Sleep -Seconds 2

    $statusResp = Invoke-WebRequest -Uri ("http://{0}:{1}/status" -f $DriverHost, $Port) `
        -Method Get -UseBasicParsing -TimeoutSec 5
    Write-Host ("STATUS:{0}" -f $statusResp.StatusCode)

    $payloadObj = @{
        capabilities = @{
            alwaysMatch = @{
                browserName = "webview2"
                "ms:edgeChromium" = $true
                "ms:edgeOptions" = @{
                    binary = $AppPath
                    args = @()
                    webviewOptions = @{
                        additionalBrowserArguments = @("--remote-debugging-port=9222")
                    }
                }
            }
            firstMatch = @(@{})
        }
    }
    $payload = $payloadObj | ConvertTo-Json -Depth 12

    try {
        $sessionResp = Invoke-WebRequest -Uri ("http://{0}:{1}/session" -f $DriverHost, $Port) `
            -Method Post -ContentType "application/json" -Body $payload -UseBasicParsing -TimeoutSec 60
        Write-Host ("SESSION_STATUS:{0}" -f $sessionResp.StatusCode)
        Write-Host ($sessionResp.Content)
        try {
            $parsed = $sessionResp.Content | ConvertFrom-Json
            $sessionId = $parsed.value.sessionId
            if (-not [string]::IsNullOrWhiteSpace($sessionId)) {
                $windowResp = Invoke-WebRequest -Uri ("http://{0}:{1}/session/{2}/window" -f $DriverHost, $Port, $sessionId) `
                    -Method Get -UseBasicParsing -TimeoutSec 10
                Write-Host ("WINDOW_STATUS:{0}" -f $windowResp.StatusCode)
                Write-Host ($windowResp.Content)
            }
        } catch {
            Write-Host ("WINDOW_ERR:{0}" -f $_.Exception.Message)
        }
    } catch {
        $webResp = $_.Exception.Response
        if ($webResp) {
            Write-Host ("SESSION_STATUS:{0}" -f [int]$webResp.StatusCode)
            try {
                $stream = $webResp.GetResponseStream()
                if ($stream) {
                    $reader = New-Object System.IO.StreamReader($stream)
                    $body = $reader.ReadToEnd()
                    $reader.Dispose()
                    $stream.Dispose()
                    if ($body) {
                        Write-Host $body
                    }
                }
            } catch {}
        }
        Write-Host ("SESSION_ERR:{0}" -f $_.Exception.Message)
        exit 1
    }
}
finally {
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
}
