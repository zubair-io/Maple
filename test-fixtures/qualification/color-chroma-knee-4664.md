# Scene chroma continuity — #4664

## Defect and correction

Saturation, vibrance and HSL returned an uncompressed target until its RGB
projection crossed the nonnegative Rec.2020 cone. The slow branch then
applied the existing Reinhard knee beginning at 80% of the hull chroma.
At the branch boundary, the left limit was the hull chroma and the right
limit was 90% of it. Testing the scalar knee alone missed this 10% step.
A native synthetic skin ramp showed a saturation-stage RGB step of 0.05917
between inputs separated by 0.001259; the discontinuity propagated through
AgX and became visible to the proposed display conversion in #4663.

The fast-path probe now uses target chroma / 0.8. Only targets below the
knee bypass compression. The same probe supplies the bisection's known
outside bracket. Existing gamut tolerance, 24 iterations, HDR range,
saturation/vibrance input-chroma floors and negative-amount paths remain.
The CPU operators, GPU scalar oracles, global shaders and the masked
saturation/vibrance shader copies use the same condition.

HSL requires a separate continuity condition: a fixed knee would desaturate
an input already above 80% of its hull on the first nonzero slider tick.
A regression demonstrates an Oklab displacement of 0.00625049 for a hue
setting of -0.01 under the initial fix. The final HSL shoulder is

    span = min(0.2 * hull, max(hull - input_chroma, 0) + geometry_distance)
    knee = hull - span

Here geometry_distance is the Euclidean Oklab displacement due to hue and
luminance at the original chroma; it excludes the saturation change. At
fixed hue/luminance, the knee cannot move below a physical input, and the
saturation response remains monotone. Hue/luminance changes open the
shoulder continuously. There is no output floor at the original chroma:
that could exceed a narrower rotated hull. The Reinhard shape and its
existing zero-span guard remain.

Output version 45 invalidates derived renders. Auto-fit version 13 stays:
default fit preparation uses zero saturation, vibrance and HSL controls.
Original RAWs, authored sidecars, numerical budgets and Auto's default
selection are unchanged.

## Regression and domain evidence

The three chroma-ramp regressions fail against v44 and pass with the fix.
They sweep nonnegative scene inputs at 40 lightness/hue combinations,
including HDR lightness 1.25, while the target crosses its hull. Additional
regressions check tiny positive/negative HSL edits and monotone saturation
sweeps at three near-hull fractions. No existing tolerance was relaxed.

The audited candidate passes all 20 qualification commands, with no changed
source or physical-input hashes during the run:

- raw-core: 2,868 passed, 104 existing fixture-gated ignores; the selected
  physical camera/colorimetry suite separately passes all five cases.
- raw-gpu: 296 passed, five existing ignores; physical HSM tests also pass.
- raw-ffi: 301 passed, six existing ignores, including the masked live path.
- Android native and WASM library suites, browser-target compilation, WGSL
  validation, gain-map/tile/CA checks, synthetic grey/adjustment/DCP gates,
  WASM SIMD checks, one-shot white-balance checks and file headroom pass.
- The synthetic color-chart gate passes all seven tests.
- All 90 gradient/Auto-tail banding reports pass with unchanged budgets.

The earlier candidate failed three masked GPU checks and one masked FFI
check because local_adjustments.wgsl retained the old saturation/vibrance
branch. Updating both copies resolves those failures. Those failed runs
remain archived; they are not treated as passing evidence.

## Photographic evidence and its limits

The 76-comparison cohort contains all 20 Neutral and Auto baselines and 36
positive saturation/vibrance cases. It has 71 passes and the same five
failing cells as the preceding complete v43 run: test_0006 baseline and
vibrance_max; test_0011 baseline, saturation_max and vibrance_max. All 244
physical input hashes remain unchanged. This cohort contains no HSL or
local-adjustment case and is not evidence of a complete color-gate pass.

Three existing HSL sidecars had no Adobe PNGs. Photoshop/Camera Raw rendered
new full/down pairs from an isolated copy of test_0000, plus a baseline
control. All eight saved PNGs pass the effective-settings verifier. The
fresh Adobe baseline differs from the recorded capture by at most one
8-bit count per channel. No original input changed.

Matched-native Lanczos comparisons against those audited Adobe captures:

| Case | v44 mean ΔE | Revised mean ΔE |
| --- | ---: | ---: |
| Orange hue -50 | 5.67989731 | 5.67989742 |
| Blue saturation +60 | 6.06117665 | 6.06118060 |
| Green luminance -40 | 5.67805596 | 5.67805840 |
| Baseline control | 5.69082305 | 5.69082305 |

The orange case's maximum changes by +0.006334 ΔE; the other maxima are
unchanged. These are diagnostic controls without newly invented budgets.
They establish the size of the photographic change, not an improvement in
the outstanding physical-gate count. No HSL capture or synthetic golden is
substituted for an existing reference.

## Evidence identities and outstanding qualification

The audited pixel-math candidate is frozen as
`maple-chroma-knee-anchored-4664-cli`, SHA-256
`681c8be785307ab2c23ba1dc8abd724c8e15e71ee6a7dc858ed38501ef10d5b4`.
It reports output version 44 because it predates the cache invalidation
bump. Its exact source hashes, complete command results and logs are in
`/Volumes/Projects/maple-color-gate-20261015/chroma-knee-4664/domains-anchored/`;
`build-anchored/`, `banding-anchored/`, `hsl-adobe/` and `hsl-physical/`
retain executable/source identities, metrics, captures and input audits.

The final version-45 executable is frozen as `maple-chroma-knee-v45-cli`,
SHA-256 `99f2e00a73dba414fc5a872a4f0cb75e0d93ff36c9bfd9714d24715962b6868b`.
All 12 audited pixel-stage and regression-source hashes are unchanged from
the candidate above. Fresh version-45 renders of baseline and blue HSL
saturation +60 are byte-identical to that candidate's PNGs, with unchanged
physical inputs. The five regressions, version tests, codegen tests,
headroom and whitespace checks pass. A second complete codegen run changes
no file; generated platform versions and support records consistently say
45. These checks are archived in `build-v45/`, `v45-final-checks/` and
`v45-pixel-identity/` under the same evidence root.

The profile/Bradford/display experiments in #4661/#4663 are separate and
are not included in this correction. Absolute slider performance and the
complete physical color gate still require qualification before merging
the overall repair. The last complete production-candidate run remains
73 failed comparisons over 796 unique cases; this subset does not establish
a new complete-suite count or authorize a merge exception.
