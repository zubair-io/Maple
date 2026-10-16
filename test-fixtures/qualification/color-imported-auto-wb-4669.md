# Imported Auto white balance — #4669

## Status

**Not qualified for merge.** The paired physical run completed all 36 comparisons (18 cases × two frozen binaries). The v47 control passes 17/18 and v48 passes 16/18: no existing failure clears, `test_0011/wb_auto` remains, and `test_0008/wb_auto` newly fails mean ΔE2000. No budgets, references or input sidecars changed.

## Implementation

The core retains name-only `crs:WhiteBalance="Auto"` intent and resolves it through the existing shared estimator on the complete RAW before camera preparation. Either authored numeric component suppresses Auto estimation. Full, sized and tile entries share the resolver; one-shot GPU preparation retains its intent. Browser retained sessions cache the pair. Native cold import hydration calls the same Rust resolver. Apple, Web and Windows preserve absent axes through unrelated edits and expose the resolved pair to the editor. Explicit WB actions replace the import intent. RAWs and source sidecars are never written during analysis.

Output version **48** invalidates derived renders. Auto-fit version remains **14**, because its pinned default As Shot preparation is unchanged. This change does not complete the separate persistent GPU camera-stage migration in #4629.

## Physical evidence

- Archive: `/Volumes/Projects/maple-color-gate-20261015/auto-wb-import-v48`.
- `identity.json` records all 36 metrics, unchanged budgets, reference protocol, input hashes and frozen binary hashes. Its final changed-input/source/binary lists are empty.
- `build-identity.json`, `build.patch` and `untracked/` retain the v48 CLI source identity. Later binding/UI additions require their own validation; this run only qualifies the frozen CLI behavior.
- Control SHA-256: `8f22131e7a45ca846e4951233fe6c5f62c78feda351d5c7812347ec7ab81545e`.
- Candidate SHA-256: `d2727e60112168f0a147458aa1e1f3718b28e3297d28dce4a306784b7c3932cb`.
- Native-pair Lanczos comparison, Neutral profile, original Auto-only sidecars, bundled lens disabled in both arms.
- Mean ΔE improves in 12/18 cases. Aggregate improvement is not a substitute for each budget passing.

| Fixture           | v47 mean ΔE | v48 mean ΔE | v47  | v48  |
| ----------------- | ----------: | ----------: | ---- | ---- |
| test_0000/wb_auto |    7.042133 |    5.293391 | PASS | PASS |
| test_0001/wb_auto |   16.696122 |   16.454338 | PASS | PASS |
| test_0002/wb_auto |   14.490155 |   13.378985 | PASS | PASS |
| test_0003/wb_auto |    9.012979 |    7.318861 | PASS | PASS |
| test_0004/wb_auto |    5.930734 |    6.084147 | PASS | PASS |
| test_0005/wb_auto |   12.690981 |   11.912580 | PASS | PASS |
| test_0006/wb_auto |   13.257098 |    5.724451 | PASS | PASS |
| test_0007/wb_auto |   12.897033 |    5.504271 | PASS | PASS |
| test_0008/wb_auto |   11.322127 |   11.902930 | PASS | FAIL |
| test_0009/wb_auto |    9.164970 |    8.704739 | PASS | PASS |
| test_0010/wb_auto |    9.853883 |    9.432304 | PASS | PASS |
| test_0011/wb_auto |    6.855370 |    6.906852 | FAIL | FAIL |
| test_0012/wb_auto |   12.061768 |   10.059573 | PASS | PASS |
| test_0013/wb_auto |    8.761601 |    6.332514 | PASS | PASS |
| test_0014/wb_auto |   16.088236 |   16.763000 | PASS | PASS |
| test_0015/wb_auto |   10.450739 |    8.494843 | PASS | PASS |
| test_0017/wb_auto |    7.485259 |    7.578871 | PASS | PASS |
| test_0018/wb_auto |   14.511698 |   14.853073 | PASS | PASS |

### Remaining failures

- `test_0008/wb_auto`: mean ΔE **11.9029295393 > 11.9**; control 11.3221272628. The unrounded value fails. P95/max/bias pass; no rounding or budget increase is accepted.
- `test_0011/wb_auto`: red bias **+0.066042194** and green bias **+0.044326853** exceed **0.0317**. Its control already fails red and blue bias. The import fix changes the requested white balance but does not repair the underlying color mismatch.

## Completed targeted validation

- Core import regression tests: **7 passed**, no ignored; full/sized/tile, GPU-prefix equivalence, real sidecar round trips, explicit-axis precedence, cancellation, cached estimate reuse.
- Full core library: **2886 passed**, **104 existing ignored**. The ignored fixture tests are not counted as physical qualification.
- Native FFI import suite: **5 passed**, including actual RAW estimator agreement and existing V1–V5 partial-pair coverage.
- Apple package import suites against freshly rebuilt xcframework: **13 passed**, including cold Auto resolution, unchanged RAW/sidecar bytes, and CPU/GPU parameter agreement.
- Windows XMP/WB suite against the freshly built arm64 Rust dylib: **267 passed, 0 skipped**. The legacy missing-tint case preserves its raw coordinate and scale until actual-camera resolution; explicit zero tint retains joint conversion coverage. Custom/manual edits preserve an existing complete V1 coordinate scale; new estimator/preset pairs use V5, and undo restores the original import intent.
- Windows actual native cold resolver: **7 passed, 0 skipped**, with the freshly built arm64 Rust dylib. It matches global AUTO's WB pair, preserves source bytes and unrelated exposure, and reuses the resolved pair without re-opening a missing RAW.
- Web parser/state/cold-open/dispatch suites: **35 passed**.
- Real-browser cold-open suite: the two new CPU/WebGPU Auto-import cases pass, checking the actual shared-estimator slider pair, preservation of omitted axes on an unrelated exposure save, unchanged RAW SHA-256 and manual override. The five existing As Shot/Custom/profile-switch cases also pass. This is import behavior coverage, not a full CPU/GPU color-parity or timing qualification.
- Both production Angular app builds (`maple` and `maple-syrup`) passed. Standalone shared-library compilation passed, but packaging failed because its existing `qrcode` dependency is absent from `allowedNonPeerDependencies`; this is not a successful library package build.
- WASM CPU retained-session tests: **3 passed**; Auto metadata and pixels equal one-shot fast/refine renders without source re-open.
- wasm32 GPU/parallel/AVIF compile check passed. Full GPU pixel/performance qualification remains outstanding.

The broader full-corpus run is separate. No full 806-comparison pass, live-platform pixel pass or absolute slider-performance pass is claimed here.

## Adobe-pair attribution diagnostic

The saved Adobe PNG metadata contains the actual effective pair. It differs from
the older `ACR_AUTO` fixture-test table, whose numbers were fitted through Maple
renders and are not Adobe readings. The full/down reference pairs agree:

| Case                | Adobe effective pair | Existing Maple estimate  | Diagnostic with Adobe pair                                      |
| ------------------- | -------------------- | ------------------------ | --------------------------------------------------------------- |
| `test_0008/wb_auto` | 5400 K / +30         | 4911.68 K / +47.120262   | Pass; mean 10.914636 against 11.9                               |
| `test_0011/wb_auto` | 7500 K / +15         | 10093.986 K / +11.262144 | Fail; RGB bias +0.049672 / +0.037760 / +0.035188 against 0.0317 |

The diagnostic uses disposable sidecar copies with the effective Adobe pair,
the same frozen v48 binary, original references, comparator and budgets. Its two
comparisons completed with unchanged input/source/binary hashes. Evidence lives
under `auto-wb-import-v48/adobe-pair-diagnostic/` in the qualification archive.

This points to the estimator for Fuji's new failure and shows that Sony also has
a rendering mismatch after matching white balance. Neither diagnostic pair is a
production override, and neither diagnostic result replaces the name-only Auto
acceptance result above. Estimator repair and Sony color attribution remain open.

The subsequent #4671 diagnostic retains the clipping/noise guards, gate schedule,
white-patch population and blend, and prior bounds, but uses the component median
of the final admitted gray population. All 18 physical cases completed with
unchanged input/source/binary hashes: 17 pass, Fuji clears (mean 11.250559), and
only Sony's existing bias failure remains. This is recorded in
`auto-wb-import-v48/median-diagnostic/identity.json`; it used explicit diagnostic
pairs and does not yet qualify a production estimator implementation.
