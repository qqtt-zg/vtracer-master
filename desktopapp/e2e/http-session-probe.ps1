param(
    [string]$TauriDriverPath = "",
    [string]$NativeDriverPath = "",
    [string]$AppPath = "",
    [string]$OutputDir = "",
    [string]$DriverHost = "127.0.0.1",
    [int]$Port = 4777,
    [int]$NativePort = 9777,
    [int]$ReadyTimeoutSec = 20,
    [int]$RequestTimeoutSec = 45,
    [switch]$SkipNativeDriverArg
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$createdAliasDrive = ""

function New-AsciiRepoAliasIfNeeded {
    param([string]$SourcePath)
    if ($SourcePath -notmatch '[^\x00-\x7F]') {
        return ""
    }
    $letters = @("X", "Y", "Z", "W", "V", "U", "T", "S")
    foreach ($letter in $letters) {
        cmd /c ("subst {0}: ""{1}""" -f $letter, $SourcePath) | Out-Null
        if ($LASTEXITCODE -eq 0) {
            return ("{0}:" -f $letter)
        }
    }
    return ""
}

if ([string]::IsNullOrWhiteSpace($TauriDriverPath)) {
    $TauriDriverPath = Join-Path $env:USERPROFILE ".cargo\bin\tauri-driver.exe"
}
if ([string]::IsNullOrWhiteSpace($NativeDriverPath)) {
    $NativeDriverPath = Join-Path $repoRoot "msedgedriver.exe"
}
if ([string]::IsNullOrWhiteSpace($AppPath)) {
    $AppPath = Join-Path $repoRoot "desktopapp\src-tauri\target\debug\vtracer-desktop.exe"
}
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $PSScriptRoot ".artifacts\logs"
}

$createdAliasDrive = New-AsciiRepoAliasIfNeeded -SourcePath $repoRoot
if (-not [string]::IsNullOrWhiteSpace($createdAliasDrive)) {
    if ($NativeDriverPath -eq (Join-Path $repoRoot "msedgedriver.exe")) {
        $NativeDriverPath = Join-Path ($createdAliasDrive + "\") "msedgedriver.exe"
    }
    if ($AppPath -eq (Join-Path $repoRoot "desktopapp\src-tauri\target\debug\vtracer-desktop.exe")) {
        $AppPath = Join-Path ($createdAliasDrive + "\") "desktopapp\src-tauri\target\debug\vtracer-desktop.exe"
    }
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$driverStdOut = Join-Path $OutputDir "http-probe.tauri-driver.stdout.log"
$driverStdErr = Join-Path $OutputDir "http-probe.tauri-driver.stderr.log"
$reportPath = Join-Path $OutputDir "http-probe.report.json"

if (-not (Test-Path $TauriDriverPath)) {
    throw "tauri-driver not found: $TauriDriverPath"
}
if (-not $SkipNativeDriverArg -and -not (Test-Path $NativeDriverPath)) {
    throw "native driver not found: $NativeDriverPath"
}
if (-not (Test-Path $AppPath)) {
    throw "desktop app not found: $AppPath"
}

function Wait-DriverReady {
    param(
        [string]$TargetHost,
        [int]$TargetPort,
        [int]$TimeoutSec
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $resp = Invoke-WebRequest -Uri ("http://{0}:{1}/status" -f $TargetHost, $TargetPort) `
                -Method Get -TimeoutSec 3 -UseBasicParsing
            if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300) {
                return $true
            }
        } catch {
            # keep polling
        }
        Start-Sleep -Milliseconds 300
    }
    return $false
}

function Invoke-SessionAttempt {
    param(
        [string]$CapabilityLabel,
        [string]$TargetHost,
        [int]$TargetPort,
        [hashtable]$AlwaysMatch,
        [int]$TimeoutSec
    )

    $payloadObject = @{
        capabilities = @{
            alwaysMatch = $AlwaysMatch
            firstMatch = @(@{})
        }
    }
    $payloadJson = $payloadObject | ConvertTo-Json -Depth 10

    $attempt = [ordered]@{
        browserName = $CapabilityLabel
        startedAt = (Get-Date).ToString("o")
        statusCode = 0
        responseBody = ""
        sessionId = ""
        deleteStatusCode = 0
        ok = $false
        error = ""
    }

    try {
        $sessionResp = Invoke-WebRequest -Uri ("http://{0}:{1}/session" -f $TargetHost, $TargetPort) `
            -Method Post -TimeoutSec $TimeoutSec -ContentType "application/json" -Body $payloadJson -UseBasicParsing

        $attempt.statusCode = [int]$sessionResp.StatusCode
        $attempt.responseBody = [string]$sessionResp.Content

        if ($attempt.statusCode -lt 200 -or $attempt.statusCode -ge 300) {
            throw "session create returned status $($attempt.statusCode)"
        }

        $sessionParsed = $null
        try {
            $sessionParsed = $attempt.responseBody | ConvertFrom-Json
        } catch {
            throw "session response is not valid json"
        }

        $sessionId = ""
        if ($sessionParsed -and $sessionParsed.value -and $sessionParsed.value.sessionId) {
            $sessionId = [string]$sessionParsed.value.sessionId
        } elseif ($sessionParsed -and $sessionParsed.sessionId) {
            $sessionId = [string]$sessionParsed.sessionId
        }
        if ([string]::IsNullOrWhiteSpace($sessionId)) {
            throw "session response missing sessionId"
        }

        $attempt.sessionId = $sessionId
        $deleteResp = Invoke-WebRequest -Uri ("http://{0}:{1}/session/{2}" -f $TargetHost, $TargetPort, $sessionId) `
            -Method Delete -TimeoutSec 10 -UseBasicParsing
        $attempt.deleteStatusCode = [int]$deleteResp.StatusCode
        $attempt.ok = $true
    } catch {
        $webResp = $_.Exception.Response
        if ($webResp) {
            try {
                $attempt.statusCode = [int]$webResp.StatusCode
            } catch {}
            try {
                $stream = $webResp.GetResponseStream()
                if ($stream) {
                    $reader = New-Object System.IO.StreamReader($stream)
                    $attempt.responseBody = $reader.ReadToEnd()
                    $reader.Dispose()
                    $stream.Dispose()
                }
            } catch {}
        }
        $attempt.error = [string]$_.Exception.Message
    } finally {
        $attempt.finishedAt = (Get-Date).ToString("o")
    }

    return [pscustomobject]$attempt
}

$hasPath = Test-Path Env:Path
$hasPATH = Test-Path Env:PATH
if ($hasPath -and $hasPATH) {
    $pathValue = $env:Path
    Remove-Item Env:PATH -ErrorAction SilentlyContinue
    $env:Path = $pathValue
}

$report = [ordered]@{
    startedAt = (Get-Date).ToString("o")
    host = $DriverHost
    port = $Port
    nativePort = $NativePort
    tauriDriverPath = $TauriDriverPath
    nativeDriverPath = $NativeDriverPath
    appPath = $AppPath
    ready = $false
    statusProbe = $null
    attempts = @()
    sessionCreated = $false
    selectedBrowser = ""
    sessionId = ""
    driverPid = 0
    driverExitCode = ""
    driverExitedEarly = $false
    error = ""
}

$driverProc = $null
try {
    if (Test-Path $driverStdOut) { Remove-Item -Path $driverStdOut -Force }
    if (Test-Path $driverStdErr) { Remove-Item -Path $driverStdErr -Force }
    "stdout redirection disabled to avoid Path/PATH collision in PowerShell Start-Process." | Out-File -FilePath $driverStdOut -Encoding utf8

    $driverArgs = @("--port", $Port)
    if (-not $SkipNativeDriverArg) {
        $driverArgs += @("--native-driver", $NativeDriverPath, "--native-port", $NativePort)
    }

    $driverProc = Start-Process -FilePath $TauriDriverPath `
        -ArgumentList $driverArgs `
        -WindowStyle Hidden `
        -PassThru
    "stderr redirection disabled to avoid Path/PATH collision in PowerShell Start-Process." | Out-File -FilePath $driverStdErr -Encoding utf8
    $report.driverPid = [int]$driverProc.Id

    Start-Sleep -Milliseconds 500
    if ($driverProc.HasExited) {
        $report.driverExitedEarly = $true
        $report.driverExitCode = [string]$driverProc.ExitCode
        throw "tauri-driver exited early with code $($driverProc.ExitCode)"
    }

    $report.ready = Wait-DriverReady -TargetHost $DriverHost -TargetPort $Port -TimeoutSec $ReadyTimeoutSec
    if (-not $report.ready) {
        if ($driverProc.HasExited) {
            $report.driverExitedEarly = $true
            $report.driverExitCode = [string]$driverProc.ExitCode
            throw "tauri-driver exited before ready with code $($driverProc.ExitCode)"
        }
        throw "tauri-driver not ready within ${ReadyTimeoutSec}s"
    }

    $statusResp = Invoke-WebRequest -Uri ("http://{0}:{1}/status" -f $DriverHost, $Port) `
        -Method Get -TimeoutSec 5 -UseBasicParsing
    $report.statusProbe = [ordered]@{
        statusCode = [int]$statusResp.StatusCode
        responseBody = [string]$statusResp.Content
    }

    $candidates = @(
        @{
            label = "tauri"
            alwaysMatch = @{
                browserName = "tauri"
                "tauri:options" = @{
                    application = $AppPath
                    webviewOptions = @{
                        additionalBrowserArguments = @("--remote-debugging-port=9222")
                    }
                }
            }
        },
        @{
            label = "wry"
            alwaysMatch = @{
                browserName = "wry"
                "tauri:options" = @{
                    application = $AppPath
                    webviewOptions = @{
                        additionalBrowserArguments = @("--remote-debugging-port=9222")
                    }
                }
            }
        },
        @{
            label = "tauri-options-only"
            alwaysMatch = @{
                "tauri:options" = @{
                    application = $AppPath
                    webviewOptions = @{
                        additionalBrowserArguments = @("--remote-debugging-port=9222")
                    }
                }
            }
        }
    )
    foreach ($candidate in $candidates) {
        $attempt = Invoke-SessionAttempt -CapabilityLabel $candidate.label -TargetHost $DriverHost -TargetPort $Port `
            -AlwaysMatch $candidate.alwaysMatch -TimeoutSec $RequestTimeoutSec
        $report.attempts += $attempt
        if ($attempt.ok) {
            $report.sessionCreated = $true
            $report.selectedBrowser = $candidate.label
            $report.sessionId = $attempt.sessionId
            break
        }
    }

    if (-not $report.sessionCreated) {
        $brief = ($report.attempts | ForEach-Object { "{0}:{1}:{2}" -f $_.browserName, $_.statusCode, $_.error }) -join " | "
        throw "all session attempts failed -> $brief"
    }
} catch {
    $report.error = [string]$_.Exception.Message
} finally {
    $report.finishedAt = (Get-Date).ToString("o")
    $report | ConvertTo-Json -Depth 20 | Out-File -FilePath $reportPath -Encoding utf8
    if ($driverProc -and -not $driverProc.HasExited) {
        Stop-Process -Id $driverProc.Id -Force -ErrorAction SilentlyContinue
    }
    if (-not [string]::IsNullOrWhiteSpace($createdAliasDrive)) {
        cmd /c ("subst {0} /d" -f $createdAliasDrive) | Out-Null
    }
}

if (-not $report.sessionCreated) {
    Write-Host "HTTP session probe failed: $($report.error)"
    exit 1
}

Write-Host "HTTP session probe passed with browserName=$($report.selectedBrowser)"
exit 0
