param(
    [ValidateSet("Launch", "Server", "Stop")]
    [string]$Mode = "Launch"
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dist = Join-Path $Root "webapp\app\dist"
$Port = 18180
$Url = "http://localhost:$Port/index.html"
$LaunchLog = Join-Path $Root "vtracer-ui-launch.log"

function Get-ListeningPids {
    param([int]$TargetPort)

    $matches = netstat -ano | Select-String "LISTENING" | Select-String ":$TargetPort"
    if (-not $matches) {
        return @()
    }

    $ids = @()
    foreach ($match in $matches) {
        $line = $match.ToString().Trim() -replace "\s+", " "
        $parts = $line.Split(" ")
        if ($parts.Length -ge 5) {
            $ids += [int]$parts[-1]
        }
    }

    return $ids | Sort-Object -Unique
}

function Resolve-Python {
    $python = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($python) {
        return $python.Source
    }

    if (Test-Path "D:\py\python38\python.exe") {
        return "D:\py\python38\python.exe"
    }

    throw "Python executable not found."
}

function Assert-Dist {
    $index = Join-Path $Dist "index.html"
    if (-not (Test-Path $index)) {
        throw "Missing UI package: $index"
    }
}

function Write-LaunchLog {
    param([string]$Message)

    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $LaunchLog -Value "[$timestamp] $Message" -Encoding UTF8
}

function Resolve-WindowsTerminal {
    $wt = Get-Command wt.exe -ErrorAction SilentlyContinue
    if ($wt) {
        return $wt.Source
    }

    $windowsAppsWt = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\wt.exe"
    if (Test-Path $windowsAppsWt) {
        return $windowsAppsWt
    }

    throw "Windows Terminal is unavailable. Cannot find wt.exe."
}

function Quote-NativeArg {
    param([string]$Value)
    return '"' + ($Value -replace '"', '\"') + '"'
}

function Start-WindowsTerminalServerTab {
    $wtExe = Resolve-WindowsTerminal
    $scriptPath = $PSCommandPath
    $wtArgs = @(
        "-w last",
        "new-tab",
        "--title", (Quote-NativeArg "VTracer UI Server"),
        "--",
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy Bypass",
        "-File", (Quote-NativeArg $scriptPath),
        "-Mode Server"
    ) -join " "

    Write-LaunchLog "Launching WT: $wtExe $wtArgs"
    try {
        Start-Process -FilePath $wtExe -ArgumentList $wtArgs
        Start-Sleep -Milliseconds 800
    } catch {
        Write-LaunchLog "WT launch failed: $($_.Exception.Message)"
        throw "Failed to start Windows Terminal. $($_.Exception.Message)"
    }
}

function Start-LaunchMode {
    Assert-Dist

    $existing = Get-ListeningPids -TargetPort $Port
    if ($existing.Count -eq 0) {
        Write-Host "[INFO] Opening Windows Terminal tab for VTracer UI server..."

        Start-WindowsTerminalServerTab

        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Milliseconds 500
            $existing = Get-ListeningPids -TargetPort $Port
            if ($existing.Count -gt 0) {
                break
            }
        }

        if ($existing.Count -eq 0) {
            Write-LaunchLog "Server did not listen on port $Port after WT launch."
            throw "Server did not start. Check the Windows Terminal tab for details."
        }
    }

    Write-Host "[OK] Server running. PID=$($existing -join ',')"
    Start-Process $Url
    Write-Host "[OK] Browser opened: $Url"
}

function Start-ServerMode {
    Assert-Dist

    $existing = Get-ListeningPids -TargetPort $Port
    if ($existing.Count -gt 0) {
        Write-Host "VTracer UI Server is already running. PID=$($existing -join ',')"
        Write-Host "URL : $Url"
        return
    }

    $pythonExe = Resolve-Python

    Write-Host "VTracer UI Server"
    Write-Host "URL : $Url"
    Write-Host "Dist: $Dist"
    Write-Host ""
    Write-Host "Press Q to stop, or Ctrl+C to stop."
    Write-Host ""

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $pythonExe
    $startInfo.Arguments = "-m http.server $Port --directory `"$Dist`""
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $false

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    [void]$process.Start()

    try {
        while (-not $process.HasExited) {
            try {
                if ([Console]::KeyAvailable) {
                    $key = [Console]::ReadKey($true)
                    if ($key.Key -eq [ConsoleKey]::Q) {
                        Write-Host ""
                        Write-Host "[INFO] Stopping VTracer UI server..."
                        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                        break
                    }
                }
            } catch {
                # Non-interactive hosts cannot read keys; keep the server alive.
            }
            Start-Sleep -Milliseconds 200
        }
    } finally {
        if ($process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
        Write-Host "[OK] VTracer UI server stopped."
    }
}

function Start-StopMode {
    $pids = Get-ListeningPids -TargetPort $Port
    if (-not $pids -or $pids.Count -eq 0) {
        Write-Host "[INFO] No VTracer UI server found on port $Port."
        return
    }

    foreach ($serverPid in $pids) {
        Write-Host "[INFO] Stopping PID=$serverPid on port $Port"
        Stop-Process -Id $serverPid -Force -ErrorAction Stop
    }

    Start-Sleep -Seconds 1
    $remaining = Get-ListeningPids -TargetPort $Port
    if ($remaining.Count -gt 0) {
        throw "VTracer UI server is still running on port $Port. Try running as Administrator."
    }

    Write-Host "[OK] VTracer UI server stopped."
}

try {
    switch ($Mode) {
        "Launch" { Start-LaunchMode }
        "Server" { Start-ServerMode }
        "Stop" { Start-StopMode }
    }
    exit 0
} catch {
    Write-Host "[ERROR] $($_.Exception.Message)"
    exit 1
}
