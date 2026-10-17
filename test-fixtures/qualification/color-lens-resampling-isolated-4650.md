# Lens resampling isolation — #4650

## Saved candidate

This candidate follows the balanced-AMaZE and Bayer GainMap changes from
#4627/#4647. Their fresh Pixel `exposure_max` comparison measures maximum
DeltaE 45.303858 on main, 54.377235 with balanced AMaZE, and 50.456601 after
GainMaps; all exceed the unchanged maximum ceiling 34. The combined change
improves average error but worsens the maximum relative to main, so it is
not accepted for merging.

The isolated candidate uses Catmull–Rom coefficients (A=-0.5) in the existing
32-phase cubic lens sampler. Adobe's SDK uses A=-0.75; this is a deliberate
reconstruction choice for Maple's unbounded scene data, not a claim of SDK
kernel identity. It reproduces affine/quadratic data and reduces the analytic
negative lobe while retaining signed/HDR samples, tap coordinates, table
phase selection, sticky borders and full/window agreement. The table remains
compile-time data and introduces no sampling allocation.

Only the shared ordinary RAW opcode sampler, its tests and its documentation
change. The earlier large repair's generated versions and other pipeline
changes are not imported. A preceding broad-branch result is diagnostic
history, not qualification for this isolated candidate.

## Initial qualification

All **30 opcode tests pass**, including the new all-phase affine/quadratic,
translated-window and analytic ringing checks, plus existing constant,
integer, signed/HDR, border, warp and gain-map tests. This does not yet
establish a physical improvement on the current integration base.

## Targeted physical result

The three Pixel outliers were rerendered with the frozen candidate executable
and compared against their unchanged Adobe references using the same native-pair
protocol and budgets. All input and binary hashes remain unchanged.

| Case | Frozen main maximum ΔE2000 | GainMap control | Lens candidate | Ceiling |
| --- | ---: | ---: | ---: | ---: |
| `contrast_min` | 29.992821 | 32.634240 | 31.412438 | 31.5 |
| `exposure_max` | 45.303858 | 50.456601 | 29.463274 | 34.0 |
| native `sharpen_amount_max` | 60.420009 | 65.771927 | 66.770884 | 64.7 |

All other gated metrics pass in these three comparisons. The lens candidate
repairs the introduced contrast breach and clears the original-main exposure
failure. The combined GainMap repair separately clears `whites_min`, giving
two confirmed main failures cleared in this targeted evidence, with one new
native sharpening breach still blocking acceptance. The 806-case combined-control
run remains pending; this is not a full-corpus pass or a confirmed global count
of remaining failures.

## Completed affected-camera comparison

The frozen lens candidate completed all **88 comparisons: 85 pass, 3 fail**.
These comprise 66 standard comparisons (64 pass), two Auto comparisons (both
pass), and 20 native detail comparisons (19 pass). There are no missing RAWs,
candidates, or errors. The standard pass deliberately defers its 20 native
detail entries to the native pass; those entries were all compared there.

The remaining failures are `test_0000/contrast_min` and
`test_0000/dehaze_max` (also failures on main), plus the new Pixel
`test_0015/sharpen_amount_max` maximum breach recorded above. The later,
separately qualified dark-halo correction at `c95d1a7de9` reduces that Pixel
maximum to 45.204288, but it does not retroactively make this frozen lens
candidate pass.

An interruption ended the original process. The resumed run verified and reused
the 88 complete renders and the two completed comparison passes, then completed
the native pass with per-case metric checkpoints. The terminal identity is
`physical/resumed/identity.json`; original inputs, comparison sources and the
candidate binary all retain their initial hashes.

This run uses the frozen historical native-pair protocol. The later complete
CRS-authoring audit found 18 corpus-wide `nr_luminance_max` references whose
active subcontrols were not explicitly authored. Their reference migration is
tracked by #3678; these measurements remain diagnostic until that qualification
gap is closed. This does not change or waive any rendering budget.

A full native pixel scan finds the lens sharpening maximum at (1108,1591):
Maple RGB 40/44/46 versus Adobe 210/212/212; main gives 122/120/122 there.
One of 12,419,584 pixels exceeds the unchanged maximum budget. The full pixel
population remains in the gate. The preceding AMaZE-only and GainMap renders
each have two pixels above that budget. This localizes the remaining regression
without changing its threshold or excluding any pixels.

## Sampling cost probe

A standalone release benchmark compiles the exact control and candidate sampler
sources. After two warmups it alternates 16 pairs over 3,145,728 three-channel
samples, with buffers preallocated outside the timed calls. Median times are
45.536 ms control and 47.435 ms candidate (ratio 1.0417). Other qualification
workloads were active, so this is a preliminary throughput observation, not a
controlled performance-ratchet result or a slider/frame-time claim.

## Qualification required

Run the analytic opcode tests, fresh Pixel and all affected camera cases,
complete corpus, CPU/GPU and binding parity, and performance checks against
the frozen current-main and combined controls. Cache versions and generated
evidence must be integrated on the actual merge revision. Numerical budgets,
original RAWs, authored sidecars and Adobe references remain unchanged.

Replay patch and fresh logs are preserved in
`/Volumes/Projects/maple-color-gate-20261015/lens-resampling-isolated/`.
