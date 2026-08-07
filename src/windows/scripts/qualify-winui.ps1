# WinUI 3 qualification harness (#2587): ΔE00 color parity vs the maple-cli
# reference renderer, plus slider-tick timing through the real render loop.
#
# Two app runs in MAPLE_QUALIFY mode (see MainWindow.Qualify.cs):
#   1. GPU  — tick timing (the product path).
#   2. CPU  — MAPLE_FORCE_CPU=1 + MAPLE_DUMP_FRAME for the pixel-exact frame,
#             compared against `maple-cli render` of the same RAW + sidecar.
#
# ΔE verdict needs python3 (compare_images.py via `maple-cli diff`); without
# it the parity artifacts are still produced and the script says so.
# Skip-passes when no RAW is available (CI without fixtures), mirroring
# test_color_pipeline.sh.
param(
    [string]$Raw = "",
    [string]$AppExe = "$PSScriptRoot\..\Maple.WinUI\bin\x64\Debug\net8.0-windows10.0.19041.0\Maple.WinUI.exe",
    [string]$MapleCli = "$PSScriptRoot\..\..\raw-pipeline\target\release\maple-cli.exe",
    [double]$ParityBudgetMean = 2.0
)
$ErrorActionPreference = 'Stop'

if ($Raw -eq "") {
    $fixture = Join-Path $PSScriptRoot "..\..\..\test-fixtures\raws\dji-mavic3pro-100mp.dng"
    if (Test-Path $fixture) { $Raw = (Resolve-Path $fixture).Path }
}
if ($Raw -eq "" -or -not (Test-Path $Raw)) {
    Write-Output "qualify-winui: no RAW fixture available - skipping (soft pass)."
    exit 0
}
foreach ($tool in @($AppExe, $MapleCli)) {
    if (-not (Test-Path $tool)) { throw "missing: $tool (build the app / maple-cli first)" }
}

$work = Join-Path $env:TEMP "maple-qualify-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory $work | Out-Null
$sidecar = [IO.Path]::ChangeExtension($Raw, ".xmp")
$sidecarArgs = if (Test-Path $sidecar) { @("--params", $sidecar) } else { @() }

function Invoke-QualifyRun([hashtable]$extraEnv, [string]$outDir) {
    New-Item -ItemType Directory $outDir -Force | Out-Null
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $AppExe
    $psi.UseShellExecute = $false
    $psi.EnvironmentVariables["MAPLE_QUALIFY_RAW"] = $Raw
    $psi.EnvironmentVariables["MAPLE_QUALIFY_OUT"] = $outDir
    foreach ($k in $extraEnv.Keys) { $psi.EnvironmentVariables[$k] = $extraEnv[$k] }
    $proc = [System.Diagnostics.Process]::Start($psi)
    if (-not $proc.WaitForExit(300000)) { $proc.Kill(); throw "qualify run timed out" }
    $report = Join-Path $outDir "report.json"
    if ($proc.ExitCode -ne 0) {
        $detail = if (Test-Path $report) { Get-Content $report -Raw } else { "(no report)" }
        throw "qualify run failed (exit $($proc.ExitCode)): $detail"
    }
    if (-not (Test-Path $report)) { throw "qualify run wrote no report.json" }
    Get-Content $report -Raw | ConvertFrom-Json
}

Write-Output "== GPU tick timing =="
$gpu = Invoke-QualifyRun @{} (Join-Path $work "gpu")
Write-Output ("path={0} decode={1}ms median tick={2}ms p95={3}ms (target 16ms, hard limit 50ms)" -f `
    $gpu.render_path, $gpu.decode_ms, $gpu.median_ms, $gpu.p95_ms)
$tickVerdict = if ($gpu.median_ms -le 16) { "PASS (target)" }
    elseif ($gpu.median_ms -le 50) { "WITHIN HARD LIMIT (misses 16ms target - #2587 optimization backlog)" }
    else { "FAIL (exceeds 50ms hard limit)" }
Write-Output "tick verdict: $tickVerdict"

Write-Output "== CPU parity frame =="
$appFrame = Join-Path $work "app-frame.png"
$cpu = Invoke-QualifyRun @{ MAPLE_FORCE_CPU = "1"; MAPLE_DUMP_FRAME = $appFrame } (Join-Path $work "cpu")
if (-not (Test-Path $appFrame)) { throw "CPU run produced no frame dump" }

Write-Output "== maple-cli reference render =="
$refFrame = Join-Path $work "ref-frame.png"
& $MapleCli render $Raw @sidecarArgs --out $refFrame
if ($LASTEXITCODE -ne 0) { throw "maple-cli render failed" }

# Real python3 only — the Windows Store app-execution alias is a shim that
# fails with "Python was not found" when actually invoked.
$pythonWorks = $false
try { $null = & python3 --version 2>&1; $pythonWorks = ($LASTEXITCODE -eq 0) } catch { }
if ($pythonWorks) {
    Write-Output "== Delta-E00 (compare_images.py via maple-cli diff) =="
    & $MapleCli diff $appFrame $refFrame --budget $ParityBudgetMean
    if ($LASTEXITCODE -ne 0) { throw "parity FAIL: mean Delta-E exceeds $ParityBudgetMean" }
    Write-Output "parity verdict: PASS (mean <= $ParityBudgetMean)"
} else {
    Write-Output "python3 not found - parity artifacts written, no Delta-E verdict:"
    Write-Output "  candidate: $appFrame"
    Write-Output "  reference: $refFrame"
}
Write-Output "report dir: $work"
if ($tickVerdict.StartsWith("FAIL")) { exit 1 }
