# Robust final gray population for Auto white balance — #4671

## Current checkpoint: Auto population analysis without color NLM (v50)

Global and imported Auto now omit color NLM from their analysis probe. The
point sampler retains authored color NR: its small 5×5 mean benefits from
filtering. Actual image rendering retains authored NR, and stored numeric WB
pairs are not re-estimated. Output version is **50**, Auto-WB provenance **4**,
point-sampler provenance **2**, and Auto-fit **14**. Generated bindings carry
the updated versions. There is no separate WGSL estimator.

The decision follows paired noise experiments, rather than timing alone:

- 1,080 point samples over three light levels, three independent sensor-noise
  levels, twelve seeds, two filtering modes and five positions show that
  removing color NR worsens point-sampler mired/tint RMS by about 21–23% in all
  nine light/noise conditions. That shared-probe change was rejected.
- 216 global estimates over the same light/noise/seed/filter combinations
  improve mired RMS in all nine conditions without NR. The worst tint RMS
  improves from `0.80765` to `0.55287`.
- A real-DNG regression proves that authored color-NR strength no longer
  changes the Auto recommendation or mutates the caller. It fails on the
  preceding implementation and passes with this change. A twelve-seed noisy
  synthetic DNG also keeps both mired and tint RMS below 1.

### Physical and binding evidence

All **18 actual unresolved Auto imports** were rendered with the new code;
all exactly reproduce the previously measured full-precision prediction
pixels. **17 pass, one Sony case fails**, with no newly failing or cleared
comparison relative to v49. Sony red/green bias is
`+0.0678778843 / +0.0441374368`, above the unchanged `0.0317` ceiling.
Original RAW, sidecar and reference hashes are unchanged. This checkpoint
does not claim a full-corpus pass or a merge exception.

| Check | Passed | Failed | Existing exclusions |
| --- | ---: | ---: | ---: |
| Core library, `gpu,test-support` | 2,902 | 0 | 105 |
| Explicit physical Auto WB/Auto Tone domain tests | 6 | 0 | 0 |
| FFI library with GPU | 302 | 0 | 7 |
| Native WASM library with GPU | 76 | 0 | 9 |
| Real Chrome, rebuilt WASM CPU/WebGPU cold-open checks | 7 | 0 | 0 |
| MapleCore imported/partial-WB tests, rebuilt release framework | 13 | 0 | 0 |
| Windows portable WB/XMP/ABI classes on macOS arm64 .NET 8 | 303 | 0 | 0 |

All four Apple release targets rebuilt and the 143-symbol guard passed.
The browser checks cover imported Auto, persisted WB intent and unchanged RAW
bytes. The portable .NET run includes every previously qualified test plus 28
additional tests in those classes; it does not execute the Windows UI.

### Cold cost and remaining limits

Three interleaved cold CLI processes per mode and RAW include file read,
decode and all eight recommendations. The control is the initial v49 median
implementation; the candidate includes both the already committed traversal
fusion and this Auto-only NR omission. These shared-host timings do not
isolate either change's contribution or certify an absolute UI budget.

| RAW | Control median ms | Current median ms |
| --- | ---: | ---: |
| test_0000 (100 MP) | 3,754.2 | 1,617.9 |
| test_0006 | 3,690.1 | 807.6 |
| test_0008 | 1,687.7 | 931.4 |
| test_0011 | 1,098.2 | 472.7 |

The reduction is 44–78% across these four samples. The 100 MP case still
exceeds one second. Controlled cold-open/slider performance and the remaining
Sony color failure remain unfinished under #4671.

### Actual cold import operation

A follow-up measures `maple_resolve_imported_white_balance_file` directly
through the rebuilt release C-FFI library. Each of twelve samples uses a fresh
process. The timed call includes RAW read/decode, sidecar parsing and WB
estimation, but excludes library loading, UI presentation, image rendering and
the seven other fields returned by global Auto. All twelve returned f32 pairs
exactly match the corresponding qualified CLI recommendation. Source RAW/XMP
and library hashes remain unchanged.

| RAW | Cold import median ms | Maximum process RSS MB |
| --- | ---: | ---: |
| test_0000 (100 MP) | 980.7 | 2,972.9 |
| test_0006 | 762.1 | 1,304.1 |
| test_0008 | 812.8 | 1,272.2 |
| test_0011 | 463.1 | 1,485.2 |

These shared-host results clarify the operation boundary: the earlier
1,617.9 ms figure measures all eight recommendations. The near-one-second
import result does not establish an end-to-end UI timing or memory-budget
pass. Peak RSS covers the whole fresh process, not just the estimator's scratch
vector. A separate run of the existing stage timers attributes 238 ms of the
100 MP all-adjustments call to probe development; that call totals 1,119 ms
under its different host load. No implementation change follows from those
single-run timings. The complete logs and commands are in `stage-profile/`
and `import-operation-cost/` beneath the v50 evidence directory.

### Evidence and qualification corrections

Evidence is under
`/Volumes/Projects/maple-color-gate-20261015/auto-population-nr-v50/`;
the noise experiments and failing control are under
`auto-wb-detail-attribution-v49/{sampler-noise,auto-noise}/` in the same root.
The frozen CLI SHA-256 is
`c2e0dc5f56cd3f310054c4a6f0a3bf2d70e9e6cff1de0c6b21eed4284127cd26`.

Two qualification-wrapper issues are retained explicitly. The concurrent
xcframework build reordered its tracked plist library array, causing the
whole-patch equality guard to fail after the physical runs completed. The
plists were structurally equal; restoring only array order restored the exact
qualified source patch (`source-revalidation.json`). No color source changed.
The first .NET attempt could not load xUnit and executed no tests; cleaning
and restoring the build resolved it. A subsequent wrapper expected the old
275 count despite all 303 tests passing. Test-name comparison confirmed all
275 were present; a repeat using coverage and actual execution counts passed.
Both unsuccessful attempts remain archived with the final successful run.

The sections below record earlier v49 checkpoints; their versions, timings
and unfinished experiments describe those snapshots.

## Historical v49: Auto Tone population refresh after the WB repair

An explicit run of all six physical Auto WB/Auto Tone fixture tests on the
unchanged v49 repair found five passes and one failure: the measured pre-tone
p95 population median is `0.6657919`, while its saved target was `0.6773`.
The existing `0.01` drift limit correctly rejects that difference.

The four measured endpoint medians are
`[0.013165161, 0.0679708, 0.6657919, 0.721627]`. The production targets are
refreshed to their four-decimal values: `[0.0132, 0.0680, 0.6658, 0.7216]`.
Only three constants change. The ACR-derived contrast spread stays `0.3673`;
the solver, damping, bounds, test assertions and tolerances are unchanged.

After the refresh, all six physical tests pass with zero skips, including
the population check, per-scene slider bounds/spread, and improvement toward
the tone anchors on six rendered photographs. The normal core library suite
passes 2,900 tests with 105 existing exclusions. Three FFI error-guard tests
and one native WASM result-layout test also pass; those four checks are not
physical platform parity evidence. The measured RAW hashes and the source
patch remain unchanged during qualification.

This changes newly requested Auto Tone recommendations. It does not change
rendering of an existing stored model or imported Auto WB, so output version
49 and WB estimator version 3 remain appropriate under the version policy.
There is no WGSL Auto Tone estimator; all bindings call this Rust function.
The already-running frozen v49 Adobe corpus remains applicable to stored-model
rendering. This clears one additional domain failure, not an Adobe corpus row.

Evidence is in
`/Volumes/Projects/maple-color-gate-20261015/auto-wb-detail-attribution-v49/`:
`domain-gates/` preserves the failing control; `anchor-refresh/` preserves the
passing repair, commands, source patch and original-input hashes.

## Historical v49: shared analysis-probe detail-cost experiment

A read-only stage profile identified color NR as a large cost in the two slow
LinearRGB DNG probes. A separate 104-probe experiment compared the unchanged
model, no sharpening, no color NR, and neither. All 18 control pairs exactly
match the frozen v49 estimates, and original inputs and production sources
were restored unchanged. Automatic bundled lens matching was disabled for
this experiment to match the physical comparison protocol.

With only color NR omitted from analysis, three interleaved rounds measured
median develop-plus-estimate times of `2684 → 690 ms` for test_0000 and
`2787 → 486 ms` for test_0006. These are shared-host diagnostic timings,
excluding decode and UI presentation, not an absolute performance pass.
Actual image sharpening and NR remain authored in all resulting renders.

Applying those full-precision estimated pairs through the frozen v49 renderer
in disposable sidecars passes 17/18 original comparisons, with no newly failed
or cleared case. Sony's red/green bias remains `+0.0678779 / +0.0441374`, above
`0.0317`. All reference, RAW, original XMP, comparator and binary hashes remain
unchanged. This predicts the effect of the pairs; it is not qualification of
an adopted implementation.

Both probe variants pass five of the six existing physical domain tests and
fail the same pre-existing p95 calibration check described above, with exactly
the same measured population medians. The shared probe also serves the neutral
sampler; provenance, sampler behavior and binding qualification remain needed
before adopting the optimization. Production still uses the original probe.

## Historical v49: status and scope

The implemented component median passes **17 of the 18** original name-only
Auto-WB comparisons. Relative to v48, it clears Fuji `test_0008/wb_auto` and
introduces no newly failing case in that cohort. Sony `test_0011/wb_auto` still
fails. This is a focused improvement, not a complete physical-gate pass or a
merge exception. The full-corpus total must be measured separately.

The first three admission gates keep their existing mean-guided centers. Only
the final admitted gray population changes to component medians of R/G and B/G.
Sensor clipping and noise eligibility, white-patch mean/population/blend, camera
prior bounds, and explicitly authored pairs retain their existing behavior.
The shared Rust cold-analysis stage serves every binding; there is no separate
WGSL estimator. Live sessions retain the result rather than estimating per tick.

Pipeline output version advances to **49**, estimator provenance to **3**, and
Auto-fit remains **14**. Generated bindings and derived-cache identities carry
those versions. No camera-specific constants, budgets, reference renders or
original RAW/XMP bytes change.

## Physical evidence

The frozen actual implementation uses CLI SHA-256
`1a6a5fd1b6c3bb1dc4e7e6de0509bb1984f43ff29a429b3511b22557df02e415`.
All 18 native-pair comparisons completed with unchanged inputs, comparison
sources and binary. Fuji mean ΔE drops from **11.9029295393** to
**11.2487051049**, below the unchanged **11.9** ceiling. Sony red/green bias
remains **+0.0678506109 / +0.0441330900**, above **0.0317**; the estimator does
not repair that separate rendering mismatch.

The original predicted-pair equivalence assertion failed because the diagnostic
used different automatic-lens settings. Repeating with matched lens settings
reproduced all 18 actual pixel streams. The initial failing assertion and its
inputs remain archived. The later retained-detail cache fix also reproduces all
18 frozen pixel streams exactly; its qualification is recorded separately in
`color-native-detail-auto-wb-4669.md`.

## Correctness and binding coverage

- The analytic admitted-colored-minority regression fails with the prior mean.
  Reversed ordering produces the same majority-neutral answer with the median.
- The 16 focused estimator tests pass, with three fixture tests explicitly
  excluded from that run. They cover clipping, insufficient population, strong
  cast, white-patch eligibility/blend and camera-prior bounds.
- The three physical estimator fixture tests pass when explicitly enabled.
  Their historical `ACR_AUTO` table is fitted through Maple and is not a table
  of Adobe metadata. The 18 original-reference comparisons above are the
  perceptual acceptance evidence.
- All 2,900 core tests with `gpu,test-support` pass in the normal profile;
  105 existing exclusions remain visible. The separate release broad-suite
  attempt fails three debug-assertion contract tests, as recorded by the
  retained-detail report; it is not treated as a full-suite pass.
- The rebuilt release WASM package passes three retained CPU-session tests and
  seven actual Chrome cold-open tests, including Auto-import CPU/WebGPU paths.
  The native-detail cache additionally passes six real worker tile requests
  against explicit full-precision V5 pairs.
- All Apple xcframework targets rebuilt and passed the 143-symbol guard.
  The actual MapleCore import/partial-WB suites pass **13 tests, zero skips**
  against that release framework, including unchanged RAW/sidecar bytes and
  CPU/GPU parameter agreement.
- The Windows shell's focused WB/XMP/ABI suite passes **275 tests, zero skips**
  on arm64 .NET 8 on macOS, against the freshly rebuilt Rust dylib. This is
  portable binding coverage, not execution of the Windows UI. An initial broad
  invocation on macOS reports 1,611 passes, 19 failures and 18 skips, including
  Windows path/filesystem cases; that log and TRX remain archived.

## Cold-analysis cost

A release diagnostic compares the original mean implementation with the actual
median on each identical, already-developed physical probe. Seven rounds
alternate execution order. RAW/source hashes are unchanged. Times below are
local shared-host measurements, not a controlled hardware performance gate.
The first fixture is the 100 MP RAW (12,288 × 8,192).

| RAW | Mean estimator ms | Median estimator ms | Cold import ms | 10,000 cached resolutions ms |
| --- | ---: | ---: | ---: | ---: |
| test_0000.DNG | 263.6 | 559.3 | 2845.0 | 0.045 |
| test_0006.DNG | 219.9 | 533.1 | 2377.8 | 0.070 |
| test_0008.RAF | 236.6 | 534.8 | 1077.3 | 0.051 |
| test_0011.ARW | 127.8 | 253.7 | 566.6 | 0.065 |

The median adds 126–313 ms on these four scenes. Cold import includes probe
development; decode is measured separately. Cached requests were preallocated
outside the timed interval, and a cancelled estimation token proves that their
resolver reused the retained pair. These results establish the absence of repeat
analysis in that resolver, not an end-to-end slider latency pass.

**Cold-analysis performance remains unfinished under #4671.** Three measured
cold imports exceed the product's one-second uncached-open target, and the new
median increases estimator time. This checkpoint must not be represented as
complete performance qualification or a ready-to-merge color repair.

## Reproducibility

`/Volumes/Projects/maple-color-gate-20261015/auto-wb-median-v49/` preserves the
physical metrics, exact source/binary identity, matched-lens proof and logs.
`final-qualification/` preserves the timing diagnostic and frozen executable,
seven interleaved samples per estimator/fixture, input/source identity, rebuilt
native library hashes, and binding logs. The temporary timing test was restored
after compilation, with exact source-patch equality verified after execution.

## Follow-up: fuse the final admission and collection passes

The subsequent performance fix collects admitted gray chromaticities and the
white-patch mean during the last gate, removing one complete probe traversal.
The first two mean-guided gates, final gate center, white-population denominator,
ordered white sum and upper component medians are unchanged. One scratch vector
uses the previous gate's population as a capacity hint; it may grow during cold
analysis. The retained-request path still performs no estimation.

A single release diagnostic includes both the exact preceding implementation
and the new production implementation. **All 18 original Auto-WB RAWs return
exactly equal f32 temperature/tint pairs**. Each pair also matches a fresh
cached resolver, whose 10,000 subsequent requests succeed with estimation
cancelled. All 18 input hashes and the source patch remain unchanged. This is
an output-preserving optimization and keeps version 49 / estimator 3.

Seven interleaved rounds on four representative RAWs give:

| RAW | Separate final pass ms | Fused final pass ms | Reduction |
| --- | ---: | ---: | ---: |
| test_0000.DNG | 498.8 | 396.5 | 20.5% |
| test_0006.DNG | 537.2 | 424.7 | 20.9% |
| test_0008.RAF | 769.2 | 588.3 | 23.5% |
| test_0011.ARW | 255.5 | 204.1 | 20.1% |

The optimization reduces the estimator's measured cost by **20–24%**. These are
same-run ratios; absolute times from earlier runs must not be subtracted because
host load differed. Cold imports in this run still take 1,898 ms and 1,724 ms
on the two DNGs, so the complete uncached-open performance target remains unmet.
No end-to-end slider or Windows UI performance pass is claimed.

The 16 focused unit tests pass (three physical tests excluded in that invocation).
The physical same-binary diagnostic above supplies all 18 actual RAW witnesses.
Its first execution on the NAS returned PermissionError before running any test;
a byte-identical local copy completed successfully. Both attempts and the exact
control source/executable are preserved under
`/Volumes/Projects/maple-color-gate-20261015/auto-wb-median-fused/`.

The full normal-profile core suite on current main plus the fused change passes
**2,900 tests**, with **105 existing exclusions** visible as ignored.
This matches the earlier fully enabled core suite count. Formatting and file
headroom checks also pass.
