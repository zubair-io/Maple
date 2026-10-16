# Retained native-detail Auto white balance — #4669

## Scope

The shared display render now resolves name-only Auto white balance before
preparing the scene and saving its detail context. The context retains both the
original request model and the resolved camera model; native evidence and later
tiles reuse the resolved pair. The browser native-detail session retains one
`CachedEstimate` with its immutable RAW across unrelated XMP edits. Its original
XMP string remains unchanged, and a new session starts with an empty cache.

This is a missing retained-path part of #4669. It changes no estimator, shader,
rendering budget or input file. Ordinary and explicitly authored models remain
borrowed unchanged. No new pipeline output version is required for this cache
correction; the separate #4671 estimator candidate is still version 49.

## Regression evidence

- The new core retained-context test fails before the fix because the saved
  camera model still requires Auto estimation. The first invocation omitted
  `test-support` and ran zero tests; it is not passing evidence. Re-running with
  the required feature reproduced the failure.
- All seven core native-detail tests pass after the fix, including Neutral and
  Auto-profile context retention, exact comparison with resolved-pair base/tile
  renders, source/sidecar preservation and existing crop/orientation coverage.
- All four WASM host native-detail tests pass. The new session test covers three
  exposure settings and two overlapping tile positions, and compares each tile
  byte-for-byte with an explicit full-precision V5 pair. A cancelled estimation
  token proves that the session retained its pair after each unrelated edit.
  Cross-window overlap meets the existing core limit of one output code;
  each individual window is identical to its explicit-WB control. Existing
  default-model exact-overlap assertions are unchanged.
- Test setup initially omitted the explicit pair's WB scale and then used a
  serializer that rounds authored values. Those controls did not represent the
  exact resolved pair. The final control specifies V5 and retains f32 precision.

The full core suite with `gpu,test-support` in the normal debug profile passes
**2,900 tests**, with 105 existing fixture/feature exclusions reported as ignored.
An earlier release-profile full-suite attempt had three failures because debug
color-space assertions were disabled; its log is preserved. No test was removed
or weakened to make the normal suite pass.

## Physical output identity

All **18 original name-only Auto cases** were rendered with the corrected
snapshot and compared with frozen v49 outputs. All 18 IHDR/IDAT pixel streams
are identical. Input, Rust-source and binary hashes were unchanged throughout
that run. Thus the prior focused result remains **17 passing / 1 failing**;
Sony `test_0011/wb_auto` still needs color repair. This measurement does not
replace the full-corpus physical gate or establish a new current-main count.

## Actual browser execution

A release `gpu,parallel` WASM package was rebuilt with the repository wrapper.
Chrome 154.0.8037.100 ran its real `NativeDetailSession` in a cross-origin-isolated
worker with two WASM threads, using the committed 96×64 DNG. Six tile requests
(three exposures × two positions) matched explicit-pair pixels exactly, with
unchanged source SHA-256 and matching overlap. This is browser binding/caching
coverage, not UI integration or a reference-hardware performance qualification.

The first direct-main-thread attempt was terminated after 60 seconds. A worker
attempt exposed the static server's missing directory-module mapping used by
wasm-bindgen-rayon. Routing that module entry to `raw_wasm.js` completed the
threaded worker test. Failed harness attempts remain archived; no result came
from them.

## Archive and limits

`/Volumes/Projects/maple-color-gate-20261015/native-detail-auto-cache/`
contains the per-case identity report, actual browser results, source checkpoint
and test logs. The complete physical gate still has outstanding failures; no
threshold was raised and no reference or original RAW/XMP was changed.
