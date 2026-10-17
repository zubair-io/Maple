# Bayer sensor GainMap isolation — #4647

## Implementation checkpoint

This branch follows the isolated balanced-AMaZE implementation from #4627.
It applies required DNG OpcodeList2 GainMaps after sensor black/white
normalization and preserves unbounded calibrated scene range. Parsing
validates operation order, area/pitch/plane selection, grid dimensions,
finite positive samples and supported required operations.

The same gain field carries local saturation ceilings through AMaZE,
highlight recovery, half-resolution preparation, tile origins and lateral
chromatic-aberration resampling. Measured CFA phases retain their original
calibrated samples. With no GainMaps, the existing constant-ceiling behavior
is retained. The original scalar highlight mask remains a test oracle.

Full and sized camera preparation have local helpers so the develop entries
retain file-size headroom. Stage ordering and diagnostic labels are retained.
The shared ordinary RAW ingest path receives the same calibration; this
does not implement panorama features.

The saved wider repair included separate camera-matrix and lossy-LinearRaw
changes. Those changes are not included here: DCP/ColorMatrix/ForwardMatrix
math and LinearRaw transfer behavior remain those of this branch's base.

## Completed initial checks

- The focused gain-map selection passes **17 tests**, with two physical
  fixture tests explicitly ignored by this initial invocation. Coverage
  includes analytical interpolation, phase/area/plane handling, malformed
  operations, calibrated highlight range, full/tile agreement and retained
  lateral-CA sampling. Five selected tests exercise the pre-existing
  post-demosaic opcode implementation.
- `cargo check` passes for all targets of `raw-core`, `raw-ffi`, `raw-wasm`
  and `maple-cli`, with GPU bindings and core test support enabled.
- Rust formatting, whitespace and file-headroom checks pass.

## Qualification still required

This is a saved implementation checkpoint, not a ready PR or a claim that
the physical Pixel failures are cleared. Run the two ignored tests on the
original Pixel RAW, the independent saturation-mask oracle, full core/GPU
and binding suites, and paired Pixel renders against the balanced-AMaZE
control. Complete the whole-corpus regression and performance checks before
merging; preserve every input and numerical budget.

Integrate the then-current pipeline output and Auto fit-model versions and
generated evidence after #4627 lands. The session exception permits only
documented failures already on main, not new regressions or raised budgets.

Replay patches, adaptation scripts and qualification logs are preserved at
`/Volumes/Projects/maple-color-gate-20261015/pixel-gainmaps-isolated/`.
