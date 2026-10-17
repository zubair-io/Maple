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
- The full debug core suite passes **2,825 tests**, with 103 explicitly
  ignored tests (including the three physical tests executed separately).
  Metal parity passes **287 tests**, with four existing ignores. FFI passes
  **301 tests**, with six ignores; native-host WASM passes **74 tests**, with
  seven ignores. All source hashes remain unchanged during these runs.

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
passing control, **zero failing cases cleared**, and does not by itself establish acceptance for the remaining comparisons. Exact metrics, input hashes and
the replay script are saved as `baseline-three-way.json` and
`compare-isolated-pixel-baseline.py` in the evidence directory below.

The first candidate launch failed the external-volume executable check before
producing any renders. Its log is retained. The completed comparison uses a
SHA-identical executable copy in the local temporary directory; the archived
binary and all physical inputs remain unchanged.

## Complete Pixel cohort

The candidate completes **44 comparisons: 41 pass, 3 fail**. The balanced-AMaZE
control completes the same cohort with **40 pass, 4 fail**. Both include all
43 authored cases and the Auto baseline, with native-resolution detail
comparisons. No RAWs, candidates, references or unique comparisons are missing;
all original inputs, frozen executables and comparison sources remain unchanged.

The candidate clears the control's `dehaze_max` failure, but that failure is
new in the AMaZE prerequisite, as the three-way comparison below establishes.
The remaining candidate failures are `contrast_min`, `exposure_max`, and native
`sharpen_amount_max`. The earlier report incorrectly listed `whites_min` in
that set; the complete log and a fresh three-way comparison show it passes.

`whites_min` is one confirmed original-main failure cleared: mean/p95 improve
from 10.691575/17.889930 to 8.655390/11.627690, and worst absolute channel bias
from 0.112273 to 0.089589, within the unchanged 9.2/17.4/0.0936 ceilings.
The maximum also improves from 35.012409 to 27.955597 (ceiling43.4). All
12,032,000 pixels and source hashes are checked. However, `contrast_min` is
newly failing versus the balanced-AMaZE control (max32.63, ceiling31.5), and
the exposure maximum remains worse than main. This is not accepted for merge.
Full806 comparison and the lens-resampling follow-up continue.

### Dehaze interaction with the AMaZE prerequisite

The targeted `test_0015/dehaze_max` comparison exposes a regression in the
balanced-AMaZE control: blue bias is -0.073930924, beyond the unchanged
absolute ceiling 0.0734. Frozen main passes this case. Applying the required
GainMaps brings blue bias to -0.040073069, and every budget passes again.
All three renders use the same references/protocol and unchanged inputs.

This clears a regression introduced by the prerequisite, **not an existing
main failure**. The two changes need qualification together against main;
the AMaZE-only branch cannot land on the strength of its passing baseline
controls. Exact metrics and hashes are in `dehaze_max-three-way.json`.

### Remaining exposure outlier

The maximum error for `test_0015/exposure_max` is 45.303858 on frozen main,
54.377235 on balanced AMaZE, and 50.456601 with GainMaps. All exceed the
unchanged maximum ceiling 34. The candidate improves mean/p95 and all channel
biases, but its maximum is worse than main. This is not accepted as regression
qualification; #4650 tracks the reconstruction/resampling interaction.
Exact metrics and unchanged-input identities are in
`exposure_max-three-way.json`. The complete combined 806-comparison run
continues as the control for further repairs.

## Qualification still required

This is a saved implementation checkpoint, not a ready PR or a claim that
the physical Pixel failures are cleared. The core/GPU and binding
suites and paired Pixel cohort are complete. Complete the whole-corpus
regression and performance checks before
merging; preserve every input and numerical budget.

Integrate the then-current pipeline output and Auto fit-model versions and
generated evidence for the qualified combined repair. No numerical budget, original RAW,
authored sidecar or Adobe reference changes.

Replay patches, adaptation scripts and qualification logs are preserved at
`/Volumes/Projects/maple-color-gate-20261015/pixel-gainmaps-isolated/`.
