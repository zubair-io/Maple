# Dehaze transmission after guided refinement — #4654

Positive dehaze's guided filter could lower the transmission estimate beyond
what the observed pixel supports. Recovery then created negative channels
from positive scene RGB; AgX mapped an affected Hasselblad patch to black.
The candidate restores the original estimate's pointwise bound before the
existing strength blend. It uses the existing omega 0.95 and airlight floor
1e-6, with no reference fitting or new threshold. Negative dehaze retains
its forward model. Scene RGB remains signed and unbounded.

CPU and WGSL implement the same bound. Generated constants feed the existing
min-filter and recovery kernels. Unit transmission returns the original
pixel exactly, avoiding cancellation and sky-mask rounding. No extra GPU
pass, buffer or allocation is introduced. Output version 44 invalidates
derived renders; Auto-fit version 13 remains because fitting uses zero dehaze.

## Physical attribution

At native Hasselblad coordinate (6203,6722), the input RGB is
[.42959556,.43827519,.56217474] and airlight is
[2.76159191,2.88449025,3.33888435]. The local-minimum transmission .86112887
becomes .84017307 after guidance. Recovery produces
[-.00812565,-.02088525,.04097987], then the view transform produces black.
The corresponding Adobe dehaze pixel remains a light neutral region.

A read-only instrumented v43 render reproduces the uninstrumented PNG
byte-for-byte. Its 12,500 traced binary32 values match an independent
standalone reconstruction at 1,250 sample locations. Five physical inputs
are unchanged. This establishes the actual production path, beyond a
synthetic demonstration.

Let m = min(Ic / max(Ac, floor)). The original window minimum is no greater
than m, so the original transmission is at least 1 - omega*m. Guided
refinement need not preserve this inequality. Restoring
max(clamp(t_guided,0,1), clamp(1-omega*m,0,1)) retains the existing haze
fraction. For nonnegative observations and positive airlight, recovery
retains a nonnegative residual; an already signed observation makes the
bound one and passes through. HDR values above one remain unbounded.

## Independent regressions

Four initial closed-form regressions cover exact fractional predictors at
50/100 strength, infeasible guided estimates over multiple airlights,
unchanged safe positive/negative recovery, and signed/HDR samples. The old
implementation passes 16/19 combined tests; the bounded version passes all 19. A separate actual-guided-filter test, using a dark point in a positive
129x129 field at interior and border locations, fails the old implementation
at -4.004153 and passes after the correction.

A sixth integrated regression exposes cancellation at unit transmission:
a -1e-10 channel and nonzero sky mask must retain their original bits. It
fails before the exact identity branch and passes afterward. Final focused
checks pass: 21 core dehaze tests, 12 GPU dehaze-filtered tests, 9 codegen matrix tests,
WGSL validation and file headroom. GPU tests cover CPU-computed and resident
GPU airlight, positive/negative amounts, tiny signed values, HDR and alpha;
the existing 1e-4 parity ceiling is unchanged. Source hashes are stable.

## Synthetic local-mask golden

The existing local spatial regression changes by at most 1,753 counts in
16-bit encoding. Its sidecar engages local dehaze 30 among six spatial
controls. A read-only reconstruction using the previous dehaze implementation
reproduces the committed golden exactly, while the candidate composition
reproduces the final production result exactly. Replacing only recovery with
an independently rearranged f64 calculation agrees within one 16-bit count.
All other stages and the real sidecar/mask remain identical. The candidate
image has been inspected and installed after the source audit completed.
The original gate passes with zero differing counts; its 128-count tolerance
is unchanged. Evidence is in
`local-golden-attribution/`. This synthetic image is not an Adobe reference.

## Physical qualification

The final v44 executable passes the former Hasselblad failure: mean 7.94608,
p95 16.76073, max 46.87774 and RGB bias
[-.0538596,-.0530085,-.0657270], against unchanged ceilings
9 / 17.4 / 48.7 / .0751. The v43 maximum is 50.86705.

The complete final dehaze cohort has 36 comparisons across 18 fixtures:
32 pass, four fail, zero missing cases and zero comparison errors. All 162
input hashes remain unchanged. The final executable SHA-256 is
`33dd1ff134a27c75f2a95b4ab10feef8ec221fbff6d457f4c325ee8c4e9d539c`.
It includes the exact unit-transmission identity branch. Compared with the
earlier prototype, 25 of 36 PNGs are byte-identical, including all 18 negative
cases; 11 positive cases change slightly. The final gate has the same four
failing cells as that prototype:

| Fixture / positive dehaze | Failing measurements                                  | Unchanged ceilings                |
| ------------------------- | ----------------------------------------------------- | --------------------------------- |
| 0003                      | p95 19.09                                             | 18.90                             |
| 0004                      | p95 17.15; red bias -0.0469                           | 16.80; absolute bias 0.0451       |
| 0007                      | mean 7.81; p95 18.50; green/blue bias -0.0320/-0.0382 | 7.80; 17.40; absolute bias 0.0274 |
| 0011                      | p95 39.50                                             | 36.50                             |

The mean breach on 0007 is additional to that already failing cell's earlier
p95 and channel-bias breaches; it must be resolved before the overall gate
can pass. The complete paired comparison against the unchanged v43 executable reduces
failed cells from five to four, clears Hasselblad positive dehaze, and adds
no newly failing cell. All 18 negative-dehaze PNGs are byte-identical. The
0007 mean is the only newly breached metric within the existing failing
cells. All 162 physical input hashes match the v43 pre-run identities and
remain unchanged; all 72 control/candidate PNG hashes were rechecked after
comparison. The exact per-case ledger and audit are in
`final-cohort/control-comparison.jsonl` and `final-cohort/paired-input-audit.json`.
This report does not infer an overall remaining-failure count from this subset.

## Integrated checks

The initial final-source domain run passes 18 of 19 commands; its sole failure
is the independently attributed synthetic golden described above. Those 18
include 296 GPU tests (five existing ignores), physical camera/DCP/HSM and
GainMap checks, Android, WASM, FFI, the browser-target build, synthetic grey
and banding gates, WASM SIMD, one-shot WB parity, WGSL validation and headroom.
The source/input audit reports no changes during that run.

After installing only the verified synthetic PNG and explanatory test comment,
the full core rerun passes 2,863 tests, with zero failures and 104 existing
fixture-gated ignores. Its separate source/golden audit also reports no changes.
This completes the 19-command domain qualification using the same runtime
implementation. It does not count ignored tests as physical evidence or claim
that all 19 commands were repeated after the synthetic golden update.
Evidence is in `final-domains/` and `post-golden-core/`.

Physical-scene GPU timing at 1.7–1.9 MP and 7.1–8.0 MP is inconclusive:
repeated runs of the identical control vary substantially, including the
zero-dehaze path. Some larger-scene control and candidate runs exceed 50 ms.
These measurements do not establish a new regression or a performance pass.
Only task-owned background renderers were paused for the measurements and
all were resumed. The complete timing series and frozen binaries are retained
in `performance-runs/` and `performance-build/`; controlled performance
qualification remains required. This report does not establish
a passing complete color gate or authorize a merge.

Evidence root:
`/Volumes/Projects/maple-color-gate-20261015/dehaze-transmission-4654/`.
It contains the frozen prototype and final build, source patches, independent
regressions, exact-path trace verification, physical metrics and input hashes.
The read-only production trace is under `hasselblad-v43-dehaze-trace/` and
standalone witness analysis under `hasselblad-dehaze-standalone/` in the parent
color-gate evidence directory.
