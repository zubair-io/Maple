# WinUI 3 qualification harness (#2587): ΔE00 color parity vs the maple-cli
# reference renderer, plus slider-tick timing through the real render loop.
#
# Two app runs in MAPLE_QUALIFY mode (see MainWindow.Qualify.cs):
#   1. GPU  — tick timing (the product path).
#   2. CPU  — MAPLE_FORCE_CPU=1 + MAPLE_DUMP_FRAME for the pixel-exact frame,
#             plus a full-resolution production export; both compared
#             against `maple-cli render` and directly against each other.
#
# ΔE verdict needs python3 (compare_images.py via `maple-cli diff`); without
# it the parity artifacts are still produced, but qualification fails.
# Missing fixtures or parity tooling fail qualification; CI functional smoke
# remains a separate workflow and does not imply a hardware qualification pass.
param(
    [string]$Raw = "",
    [string]$AppExe = "$PSScriptRoot\..\Maple.WinUI\bin\x64\Debug\net8.0-windows10.0.19041.0\Maple.WinUI.exe",
    [string]$MapleCli = "$PSScriptRoot\..\..\raw-pipeline\target\release\maple-cli.exe",
    [double]$ParityBudgetMean = 2.0
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/qualification-fixture.ps1"
. "$PSScriptRoot/qualification-timing.ps1"

if ($Raw -eq "") {
    $fixture = Join-Path $PSScriptRoot "..\..\..\test-fixtures\raws\dji-mavic3pro-100mp.dng"
    if (Test-Path $fixture) { $Raw = (Resolve-Path $fixture).Path }
}
if ($Raw -eq "" -or -not (Test-Path -LiteralPath $Raw -PathType Leaf)) {
    throw "qualify-winui: no RAW fixture available; qualification was not performed."
}
foreach ($tool in @($AppExe, $MapleCli)) {
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw "missing: $tool (build the app / maple-cli first)" }
}

$work = Join-Path $env:TEMP "maple-qualify-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory $work | Out-Null
$sourceRaw = (Resolve-Path -LiteralPath $Raw).Path
$sourceSidecar = [IO.Path]::ChangeExtension($sourceRaw, ".xmp")
$sourceHash = (Get-FileHash -LiteralPath $sourceRaw -Algorithm SHA256).Hash
$sidecarHash = if (Test-Path -LiteralPath $sourceSidecar) { (Get-FileHash -LiteralPath $sourceSidecar -Algorithm SHA256).Hash } else { $null }
# Preserve one pristine reference input. Each editing run gets another copy,
# so autosave cannot mutate the source or contaminate the next render path.
$Raw = Copy-QualificationFixture $sourceRaw $work
$sidecar = [IO.Path]::ChangeExtension($Raw, ".xmp")
@{
    fixture_sha256 = $sourceHash
    sidecar_sha256 = $sidecarHash
    app_sha256 = (Get-FileHash -LiteralPath $AppExe -Algorithm SHA256).Hash
    managed_app_sha256 = (Get-FileHash -LiteralPath ([IO.Path]::ChangeExtension($AppExe, '.dll')) -Algorithm SHA256).Hash
    cli_sha256 = (Get-FileHash -LiteralPath $MapleCli -Algorithm SHA256).Hash
    native_pipeline_sha256 = (Get-FileHash -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName((Resolve-Path -LiteralPath $AppExe).Path)) 'raw_ffi.dll') -Algorithm SHA256).Hash
    physical_reference_qualified = $false
    reference_demosaic = 'AMaZE with sidecar override'
    production_export_demosaic = 'Auto policy with sidecar override'
    qualification_limits = @('Physical reference hardware and 100MP source dimensions require separate verification.', 'GPU screenshot perceptual parity is not covered by these CPU-preview and production-export comparisons.')
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $work 'provenance.json')
$sidecarArgs = if (Test-Path -LiteralPath $sidecar) { @("--params", $sidecar) } else { @() }

function Invoke-QualifyRun([hashtable]$extraEnv, [string]$outDir) {
    New-Item -ItemType Directory $outDir -Force | Out-Null
    $runRaw = Copy-QualificationFixture $Raw $outDir
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $AppExe
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $psi.EnvironmentVariables["MAPLE_FORCE_CPU"] = ""
    $psi.EnvironmentVariables["MAPLE_DUMP_FRAME"] = ""
    $psi.EnvironmentVariables["MAPLE_QUALIFY_RAW"] = $runRaw
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
if ($gpu.render_path -ne 'gpu') { throw "GPU qualification fell back to $($gpu.render_path); no GPU result." }
$timing = Get-QualificationTiming $gpu
Write-Output ("path={0} decode={1}ms median tick={2}ms p95={3}ms max={4}ms (target 16ms, hard limit 50ms)" -f `
    $gpu.render_path, $gpu.decode_ms, $timing.Median, $timing.P95, $timing.Maximum)
$tickVerdict = $timing.Verdict
Write-Output "tick verdict: $tickVerdict"

Write-Output "== CPU parity frame =="
$appFrame = Join-Path $work "app-frame.png"
$cpu = Invoke-QualifyRun @{ MAPLE_FORCE_CPU = "1"; MAPLE_DUMP_FRAME = $appFrame } (Join-Path $work "cpu")
if ($cpu.render_path -ne 'cpu') { throw "CPU qualification reported $($cpu.render_path); no CPU result." }
if (-not (Test-Path $appFrame)) { throw "CPU run produced no frame dump" }

Write-Output "== maple-cli reference render =="
$refFrame = Join-Path $work "ref-frame.png"
& $MapleCli render $Raw @sidecarArgs --demosaic amaze --out $refFrame
if ($LASTEXITCODE -ne 0) { throw "maple-cli render failed" }

# Real python3 only — the Windows Store app-execution alias is a shim that
# fails with "Python was not found" when actually invoked.
$pythonWorks = $false
try { $null = & python3 --version 2>&1; $pythonWorks = ($LASTEXITCODE -eq 0) } catch { }
if ($pythonWorks) {
    Write-Output "== Delta-E00 (compare_images.py via maple-cli diff) =="
    & $MapleCli diff $appFrame $refFrame --budget $ParityBudgetMean
    $previewParityFailed = $LASTEXITCODE -ne 0
    Write-Output "preview/full-reference parity failed: $previewParityFailed (budget $ParityBudgetMean)"
    # Independently exercise the production Windows snapshot/queue/encoder,
    # not just a reduced preview buffer. Keep both verdicts even when preview
    # parity fails; a passing export must never hide a failing preview.
    $exportResult = Get-Content -LiteralPath (Join-Path $work 'cpu/export-result.json') -Raw | ConvertFrom-Json
    if (-not (Test-Path -LiteralPath $exportResult.output -PathType Leaf)) { throw 'Production export artifact missing.' }
    if ((Get-FileHash -LiteralPath $exportResult.output -Algorithm SHA256).Hash -ne $exportResult.sha256) {
        throw 'Production export artifact changed after publication.'
    }
    Write-Output "== Production export / full-reference Delta-E00 =="
    # The shared perceptual comparator can resize previews; export parity
    # instead requires matching dimensions before it is allowed to compare.
    & python3 -c 'import sys; from PIL import Image; a=Image.open(sys.argv[1]); b=Image.open(sys.argv[2]); print("export dimensions:", a.size, "reference:", b.size); sys.exit(0 if a.size == b.size else 1)' $exportResult.output $refFrame
    if ($LASTEXITCODE -ne 0) { throw 'Production export dimensions differ from the full reference.' }
    & $MapleCli diff $exportResult.output $refFrame --budget $ParityBudgetMean
    $exportParityFailed = $LASTEXITCODE -ne 0
    Write-Output "export/full-reference parity failed: $exportParityFailed (budget $ParityBudgetMean)"
    Write-Output "== CPU preview / production export Delta-E00 =="
    & $MapleCli diff $appFrame $exportResult.output --budget $ParityBudgetMean |
        Tee-Object -FilePath (Join-Path $work 'preview-export-diff.json')
    $previewExportParityFailed = $LASTEXITCODE -ne 0
    Write-Output "preview/production-export parity failed: $previewExportParityFailed (budget $ParityBudgetMean)"
    @{ preview_parity_failed = $previewParityFailed; export_parity_failed = $exportParityFailed;
       preview_export_parity_failed = $previewExportParityFailed;
       mean_budget = $ParityBudgetMean; tick_verdict = $tickVerdict } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $work 'verdict.json')
    if ($previewParityFailed -or $exportParityFailed -or $previewExportParityFailed) { throw "Parity FAIL. Evidence: $work" }
} else {
    Write-Output "python3 not found - parity artifacts written, no Delta-E verdict:"
    Write-Output "  candidate: $appFrame"
    Write-Output "  reference: $refFrame"
    throw "Parity qualification was not performed: working python3 is required."
}
Write-Output "report dir: $work"
if ($tickVerdict.StartsWith("FAIL")) { exit 1 }
