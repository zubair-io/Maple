# Actual WinUI process, native decoder and DX12 SwapChainPanel. No fixture skips.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot/../../..").Path
$app = Join-Path $repo 'src/windows/Maple.WinUI/bin/Release/x86_64-pc-windows-msvc/Maple.WinUI.exe'
$original = Join-Path $repo 'src/apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng'
$root = Join-Path $env:RUNNER_TEMP 'maple-window-lifecycle'
New-Item -ItemType Directory -Force $root | Out-Null
$before = (Get-FileHash $original -Algorithm SHA256).Hash
$fixture = Join-Path $root 'input.dng'
Copy-Item $original $fixture
$hostInfo = @{
    os = [Environment]::OSVersion.VersionString
    interactive = [Environment]::UserInteractive
    sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
    adapters = @(Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion)
    source = (& git -C $repo rev-parse HEAD)
    originalSha256 = $before
}
$hostInfo | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $root 'host.json')
$failures = @()
foreach ($mode in @('gpu', 'cpu', 'empty')) {
    $output = Join-Path $root $mode
    New-Item -ItemType Directory -Force $output | Out-Null
    $start = [Diagnostics.ProcessStartInfo]::new($app)
    $start.UseShellExecute = $false
    foreach ($argument in @('--lifecycle-smoke', $fixture, $output, $mode)) {
        $start.ArgumentList.Add($argument)
    }
    $start.Environment.Remove('MAPLE_QUALIFY_RAW') | Out-Null
    $start.Environment.Remove('MAPLE_QUALIFY_OUT') | Out-Null
    $start.Environment.Remove('MAPLE_FORCE_CPU') | Out-Null
    if ($mode -eq 'cpu') { $start.Environment['MAPLE_FORCE_CPU'] = '1' }
    $process = [Diagnostics.Process]::Start($start)
    try {
        if (-not $process.WaitForExit(120000)) {
            $process.Kill($true)
            throw "$mode lifecycle timed out; forced cleanup is a FAILURE"
        }
        if ($process.ExitCode -ne 0) { throw "$mode app exited $($process.ExitCode); inspect lifecycle.json" }
        $report = Get-Content (Join-Path $output 'lifecycle.json') -Raw | ConvertFrom-Json
        if (-not $report.passed -or $report.renderPath -ne $mode -or
            -not $report.rendererStopped -or $report.panelReleases -ne 1 -or $report.hwnd -eq 0) {
            throw "$mode lifecycle proof incomplete"
        }
        if ($mode -eq 'gpu' -and $report.droppedClosingPresents -lt 1) {
            throw 'No pending real GPU present was drained during close'
        }
        Write-Output "$mode real WinUI lifecycle passed (normal exit, renderer joined, panel released once)"
    } catch {
        $failures += "${mode}: $_"
        Write-Warning $_
    } finally {
        $log = Join-Path $env:LOCALAPPDATA 'Maple/maple.log'
        if (Test-Path $log) { Copy-Item $log (Join-Path $output 'maple.log') }
        $process.Dispose()
        if ((Get-FileHash $original -Algorithm SHA256).Hash -ne $before -or
            (Get-FileHash $fixture -Algorithm SHA256).Hash -ne $before) {
            throw 'Original RAW bytes changed'
        }
    }
}

if ($failures.Count -gt 0) { throw ($failures -join "`n") }
