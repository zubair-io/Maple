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
- All three physical Pixel tests pass on the original `test_0015.dng`:
  required-map decoding and saturation counts, native tile/vendor-warp
  agreement, and the shared GPU upload prefix. The prefix equals the CPU
  preparation exactly, differs when calibration is removed, and stays
  unchanged when hot exposure, white-balance and saturation controls change.
  This checks GPU host preparation, not end-to-end Metal shader parity.
- The saturation-mask oracle passes for both constant and spatial ceilings,
  including nonfinite channels and bounded sensor regions.
- All **20 original corpus RAWs** decode successfully with unchanged file
  hashes. Metadata inspection identifies the Pixel as the only corpus RAW
  with Bayer GainMaps. The Canon LinearRaw file with three MapPolynomial
  operations also decodes successfully through its existing path.
- Rust formatting, whitespace and file-headroom checks pass.

## First physical comparison

The first completed baseline uses all **12,032,000 comparison pixels** with
the frozen native-pair Lanczos protocol and unchanged Adobe reference.
The control contains the same balanced-AMaZE change but no sensor GainMaps.

| Renderer | Mean ΔE2000 | p95 ΔE2000 | Maximum ΔE2000 |
| --- | ---: | ---: | ---: |
| Frozen main | 11.514175 | 19.489712 | 38.529583 |
| Balanced-AMaZE control | 11.498462 | 19.488783 | 38.374285 |
| GainMap candidate | 9.155584 | 12.814162 | 29.491901 |

All three pass this baseline's existing mean/p95/max/bias budgets. The
original files and reference hashes are unchanged. This is one improved
passing control, **zero failing cases cleared**, and does not establish
acceptance for the remaining 43 comparisons. Exact metrics, input hashes and
the replay script are saved as `baseline-three-way.json` and
`compare-isolated-pixel-baseline.py` in the evidence directory below.

The first candidate launch failed the external-volume executable check before
producing any renders. Its log is retained. The running comparison uses a
SHA-identical executable copy in the local temporary directory; the archived
binary and all physical inputs remain unchanged.

## Qualification still required

This is a saved implementation checkpoint, not a ready PR or a claim that
the physical Pixel failures are cleared. Complete the full core/GPU and
binding suites, and paired Pixel renders against the balanced-AMaZE
control. Complete the whole-corpus regression and performance checks before
merging; preserve every input and numerical budget.

Integrate the then-current pipeline output and Auto fit-model versions and
generated evidence after #4627 lands. No numerical budget, original RAW,
authored sidecar or Adobe reference changes.

Replay patches, adaptation scripts and qualification logs are preserved at
`/Volumes/Projects/maple-color-gate-20261015/pixel-gainmaps-isolated/`.
