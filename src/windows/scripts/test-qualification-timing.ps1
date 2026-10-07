$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/qualification-timing.ps1"
function Report($Samples) {
    return [pscustomobject]@{
        timing_clock = 'Stopwatch'; timing_high_resolution = $true
        timing_frequency_hz = 10000000; tick_ms = $Samples
        render_path = 'gpu'; timing_scope = 'exposure-edit-to-present-return'; initial_exposure = 0.0
    }
}
function Reject($Candidate) {
    $rejected = $false
    try { Get-QualificationTiming $Candidate | Out-Null } catch { $rejected = $true }
    if (!$rejected) { throw 'Invalid timing evidence was accepted.' }
}
$normal = Get-QualificationTiming (Report (1..20))
if ($normal.Median -ne 10.5 -or $normal.P95 -ne 19 -or $normal.Maximum -ne 20 -or
    !$normal.Verdict.StartsWith('WITHIN HARD LIMIT')) { throw 'Incorrect normal timing verdict.' }
$target = Get-QualificationTiming (Report (@(10) * 20))
if ($target.Verdict -ne 'PASS (target)') { throw 'Within-target samples failed.' }
$cold = Get-QualificationTiming (Report (@(17) + @(10) * 19))
if (!$cold.Verdict.StartsWith('WITHIN HARD LIMIT')) { throw 'Cold target miss was discarded.' }
$edited = Report (@(10) * 20)
$edited.initial_exposure = -0.01
if (!(Get-QualificationTiming $edited).Verdict.StartsWith('INCOMPLETE')) { throw 'Edited start passed cold activation.' }
$subThreshold = Report (@(10) * 20)
$subThreshold.initial_exposure = 1e-7
if ((Get-QualificationTiming $subThreshold).Verdict -ne 'PASS (target)') { throw 'No-op initial Exposure was rejected.' }
$editedOutlier = Report (@(10) * 19 + @(51))
$editedOutlier.initial_exposure = -0.01
if (!(Get-QualificationTiming $editedOutlier).Verdict.StartsWith('FAIL')) { throw 'Edited-start hard-limit miss escaped.' }
$missingInitial = Report (@(10) * 20)
$missingInitial.initial_exposure = $null
Reject $missingInitial
$legacy = Report (1..20)
$legacy.timing_scope = 'render-loop-only'
Reject $legacy
$failed = Report (@(10) * 20)
$failed | Add-Member -NotePropertyName error -NotePropertyValue 'refine timeout'
Reject $failed
$outlier = Get-QualificationTiming (Report (@(10) * 19 + @(51)))
if ($outlier.P95 -ne 10 -or !$outlier.Verdict.StartsWith('FAIL')) { throw 'Hard-limit outlier escaped p95.' }
$slow = Get-QualificationTiming (Report (@(30) * 20))
if (!$slow.Verdict.StartsWith('WITHIN HARD LIMIT')) { throw 'Missed target was reported as a pass.' }
Reject (Report (1..19))
foreach ($invalid in @($null, '10', $true, -1, [double]::NaN, [double]::PositiveInfinity)) {
    Reject (Report (@(10) * 19 + @($invalid)))
}
$coarse = Report (1..20)
$coarse.timing_high_resolution = $false
Reject $coarse
Write-Output 'PASS: complete interval, neutral start, failed reports, cold target misses, full sample count, median/p95, maximum hard limit, invalid durations and coarse clock'
