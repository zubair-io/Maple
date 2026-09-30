# Reject incomplete/coarse evidence and apply the hard limit to every fast tick.
function Get-QualificationTiming($Report) {
    if ($Report.timing_clock -ne 'Stopwatch' -or $Report.timing_high_resolution -ne $true -or
        $Report.timing_frequency_hz -lt 1000000) {
        throw 'Qualification requires a high-resolution Stopwatch timing report.'
    }
    $samples = @($Report.tick_ms)
    if ($samples.Count -ne 20) { throw 'Qualification requires all 20 fast-tick samples.' }
    foreach ($sample in $samples) {
        if ($null -eq $sample -or $sample -is [string] -or $sample -is [bool] -or
            [double]::IsNaN([double]$sample) -or [double]::IsInfinity([double]$sample) -or [double]$sample -lt 0) {
            throw 'Qualification contains an invalid fast-tick duration.'
        }
    }
    $sorted = @($samples | ForEach-Object { [double]$_ } | Sort-Object)
    $median = ($sorted[9] + $sorted[10]) / 2
    $p95 = $sorted[18]
    $maximum = $sorted[19]
    $verdict = if ($maximum -gt 50) { 'FAIL (fast tick exceeds 50ms hard limit)' }
        elseif ($median -le 16) { 'PASS (target)' }
        else { 'WITHIN HARD LIMIT (misses 16ms target)' }
    return [pscustomobject]@{ Median = $median; P95 = $p95; Maximum = $maximum; Verdict = $verdict }
}
