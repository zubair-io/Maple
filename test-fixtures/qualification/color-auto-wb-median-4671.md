# Robust final gray population for Auto white balance — #4671

## Status and scope

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
