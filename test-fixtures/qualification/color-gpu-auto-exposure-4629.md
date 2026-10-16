# GPU scene anchoring — #4629

This is a qualified standalone prerequisite for moving persistent GPU sessions
before camera WB/DCP. `AutoExposurePass` is not enabled in shipping live hosts.
The remaining upstream spatial stages and the complete persistent path still
need migration, physical parity and absolute frame-time qualification. This
change does not resolve the complete Adobe color gate or authorize a merge.

## Implementation

The stage reproduces the existing CPU scene-anchor algorithm over all finite
luminance samples. Four radix passes select the exact float keys at the first
and last included samples of the middle-quartile band, and at P95. Endpoint
multiplicities preserve count-based trimming when a rank splits repeated values.
Positive samples within the band supply its geometric mean; negative samples
still participate in the percentile population. Signed/HDR RGB and alpha are
preserved by the final scalar multiply.

The log reduction uses compensated f32 partials. Constant positive bands retain
the exact input value. Near-black bands use floor-centered logarithms and a
cancellation-safe inverse. The constants are generated from raw-core. Pooled
scratch, uniforms, bindings and compiled pipelines are reused; there is no
intermediate CPU readback.

Two retained failing witnesses motivated the numerical handling:

- Adjacent floats below `1e-6` produced GPU gain 8 instead of CPU identity.
  Tiny pixels alone hid this under the pixel ceiling; a bright witness exposed
  an absolute error of 7. Constant-band handling and stable centered evaluation
  resolve the recorded uniform/mixed cases.
- Selecting the excluded P75 endpoint let a bright sample outside the band
  choose the numerical scale. Two-pixel and signed thirteen-pixel cases failed.
  Selecting `P75 - 1` with an inclusive endpoint count fixes the actual band
  boundary; the expanded regression fails before and passes after this change.

## Final qualification

The second immutable qualification snapshot starts from
`1f677cd17fbb7e50476f54d2272ac972a8f48216`, plus the archived source patch and
new-file snapshots. All captured sources and eleven original RAW hashes were
unchanged after testing. The subsequent `f30b28f098` commit only records the
separate camera-table experiment.

| Gate                                          | Result                                                           |
| --------------------------------------------- | ---------------------------------------------------------------- |
| GPU unit suite                                | 301 passed; five existing fixture/timing tests ignored           |
| Explicit physical camera-prefix test          | 132 comparisons, zero ignored                                    |
| Core library                                  | 2,879 passed; 104 existing fixture-gated tests ignored           |
| Generated AE constants test                   | Passed                                                           |
| Code generation repeat                        | Passed; captured generated sources unchanged                     |
| WGSL validation                               | 56 assembled shader modules, zero failures                       |
| Browser target                                | Nightly wasm32 check with gpu/parallel/avif and build-std passed |
| Rust formatting, source headroom, diff checks | Passed                                                           |

The explicit physical test covers eleven cameras, six white-balance intents,
and AE both Off and On. Its maximum absolute scene error is `8.010864e-5`
(`test_0000`, 2000 K / tint 0, AE On), below the unchanged `1e-4` ceiling.

Four AE-specific GPU tests cover exact ranks, duplicate endpoints, signed/HDR
and nonfinite inputs, broad/narrow colored distributions, 175 cutoff/boundary
cases, and repeated resident updates. The last test checks unchanged allocation
counts after warm-up, recomputation after changing the resident pixels, and one
final output readback. It does not measure the absolute slider-time budget.
The full-sort f64 oracle is independent of CPU quickselect and GPU radix selection.

The first complete qualification also passed, but the later endpoint witness
showed that its edge coverage was insufficient. Its logs and the red/green
regressions remain archived. The second run includes the corrected endpoint
selection and expanded tests. No CPU output math, profile default, numerical
budget, reference image or pipeline output version changes in this stage.

Evidence: `/Volumes/Projects/maple-color-gate-20261015/gpu-auto-exposure-4629/`,
particularly `final-qualification-2/identity.json`, the source snapshots and
per-gate logs. Browser compilation is not browser runtime evidence.
