# Reject incomplete/coarse evidence and apply the hard limit to every fast tick.
function Get-QualificationTiming($Report) {
    if ($Report.error) { throw 'Qualification run failed; retained samples are diagnostic evidence only.' }
    if ($Report.render_path -eq 'gpu' -and $Report.timing_scope -ne 'exposure-edit-to-present-return') {
        throw 'GPU qualification requires the complete Exposure edit-to-present interval.'
    }
    $tone = @($Report.initial_scene_tone)
    if ($Report.render_path -eq 'gpu') {
        if ($tone.Count -ne 5) { throw 'GPU qualification requires the initial scene-tone values.' }
        foreach ($value in $tone) {
            if ($null -eq $value -or $value -is [string] -or $value -is [bool] -or
                [double]::IsNaN([double]$value) -or [double]::IsInfinity([double]$value)) {
                throw 'GPU qualification contains an invalid initial scene-tone value.'
            }
        }
    }
    # Mirrors raw-gpu scene_tone_is_noop: [exposure, brightness, highlights, shadows, blacks].
    $neutralStart = $Report.render_path -ne 'gpu' -or ([math]::Abs([double]$tone[0]) -lt 1e-6 -and
        @($tone[1..4] | Where-Object { [math]::Abs([double]$_) -ge 1e-3 }).Count -eq 0)
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
        elseif (!$neutralStart) { 'INCOMPLETE (edited start; neutral Exposure activation not measured)' }
        elseif ($maximum -le 16) { 'PASS (target)' }
        else { 'WITHIN HARD LIMIT (misses 16ms target)' }
    return [pscustomobject]@{ Median = $median; P95 = $p95; Maximum = $maximum; Verdict = $verdict }
}
