$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/qualification-timing.ps1"
function Report($Samples) {
    return [pscustomobject]@{
        timing_clock = 'Stopwatch'; timing_high_resolution = $true
        timing_frequency_hz = 10000000; tick_ms = $Samples
    }
}
function Reject($Candidate) {
    $rejected = $false
    try { Get-QualificationTiming $Candidate | Out-Null } catch { $rejected = $true }
    if (!$rejected) { throw 'Invalid timing evidence was accepted.' }
}
$normal = Get-QualificationTiming (Report (1..20))
if ($normal.Median -ne 10.5 -or $normal.P95 -ne 19 -or $normal.Maximum -ne 20 -or
    $normal.Verdict -ne 'PASS (target)') { throw 'Incorrect normal timing verdict.' }
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
Write-Output 'PASS: full sample count, median/p95, maximum hard limit, target miss, invalid durations and coarse clock'
