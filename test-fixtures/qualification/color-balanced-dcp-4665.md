# Balanced-camera DCP qualification (#4665, #4661)

## Status and scope

This is an unmerged output-version-46 candidate. It corrects no-ForwardMatrix
colorimetry and adds the exact Hasselblad L3D-100c calibration. It is **not a
physical color-gate pass**: the focused run includes a newly failing cold-WB
case, and complete-corpus qualification remains in progress. Numerical budgets
and original RAW/XMP files are unchanged.

The source build is based on `02b9bf0a883976a6ee2480b3e6f2027e8cc23712`
plus the source changes archived with its build identity. The frozen CLI SHA-256
is `46877fbafa47f5cfcb15b4d6dc5c3cd91769284c8c1046ede6cba3c7290a8e11`.
The subsequent comparator correction, commit
`0acaf6e0af683a8ecd90038a7794def430bdb94c` (#4667), does not change render pixels.

## Corrected transform

When white-balance pre-gain has divided camera RGB by neutral `n`, inverse
ColorMatrix cannot consume that buffer directly. With `W = inverse(CM) * n`,
the balanced-camera-to-XYZ-D50 transform is:

```text
Bradford(W / W.y → D50) * inverse(CM) * diag(n / W.y)
```

The common resolver supplies the as-shot transform, selected white balance,
decode-time Whites statistic, exported WB frame and GPU camera-colorimetry
uniforms. Existing supplied-ForwardMatrix behavior is retained. The legacy
pre-gain-skipped path still consumes unbalanced camera values. Signed and HDR
scene values remain unbounded.

The exact L3D-100c profile replaces the incorrect alias to DJI FC4382. Its record
is appended to the bundle; the previous 1,406 records remain byte-identical.
Source calibration identity is recorded in
`raw-core/src/color/profiles/l3d-100c-provenance.json`. The selected record has
ColorMatrices and no ForwardMatrix. This candidate does not add experimental
Fujifilm HSM tables or change the display gamut mapper or Auto tone fitter.

Output version 46 and Auto-fit model version 14 invalidate affected derived
renders and fitted artifacts. Generated consumers were regenerated together.

## Completed tests

| Gate                               | Result                        | Scope / limitation                                                          |
| ---------------------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| Core and GPU-enabled core library  | 2,874 passed, 104 ignored     | Ignored fixture gates are not physical qualification                        |
| Default FFI library                | 258 passed, 1 ignored         | Native FFI contracts                                                        |
| GPU library                        | 296 passed, 5 ignored         | GPU kernels and composition                                                 |
| GPU-enabled FFI library            | 301 passed, 6 ignored         | Existing native GPU contracts                                               |
| Expanded physical GPU camera tests | 2 passed, 0 failed, 0 ignored | 10 cameras; 60 actual prefix comparisons and 250 calibration/WB comparisons |

The expanded physical tests include no-ForwardMatrix fixtures `test_0018` and
`test_0020`, plus 2000 K camera-prefix comparisons. Maximum absolute differences
were `1.1920929e-5` for actual camera prefixes and `1.7166138e-5` for calibration,
both below the unchanged `1e-4` limit. All ten RAW hashes and production source
hashes were unchanged during that run.

An independent f64 test constructs the SDK's normalized PCS-to-camera transform
and inverts it after composition. It checks primary, neutral, signed and HDR
vectors, single/dual calibrations, CM scaling and selected white balance. This
is a mathematical oracle, separate from the photographic gate.

These tests qualify the shared matrix and standalone GPU camera stage. They do
not establish complete cached-live WB parity or the absolute slider-time
performance limits. Persistent-session stage migration remains tracked by
#4629.

## Focused physical results

The initial v46 run compared 52 cases: 20 Neutral baselines, 20 Auto baselines,
eight selected-WB cases and four Whites cases. It reported 46 passing and six
failing comparisons, zero required skips, with all 148 input hashes unchanged.
All 20 Auto baselines passed. `test_0018/temperature_max` cleared its previous
failure.

That run predates #4667's float64 bias accumulation. Its six reported failures
were:

| Case                        | Finding                                                         |
| --------------------------- | --------------------------------------------------------------- |
| `test_0000/temperature_min` | New failure: mean ΔE 17.5379 exceeds 10.0; blue bias also fails |
| `test_0006/baseline`        | Later identified as a false bias failure by #4667               |
| `test_0011/baseline`        | Existing Sony failure                                           |
| `test_0018/tint_min`        | Existing failure                                                |
| `test_0018/tint_max`        | Existing failure                                                |
| `test_0018/whites_min`      | Existing failure                                                |

The later saved-v43 bias audit reports 99 failures across 806 comparisons. That
is neither a new v46 render nor proof of the current candidate's failure count.
A complete v46 run with the corrected comparator is running separately.

## Evidence locations

Local evidence root:
`/Volumes/Projects/maple-color-gate-20261015/l3d-profile-4661/balanced-dcp-v46/`.

- `build-identity.json`, `source-commit.tar`, `source-changes.patch` and
  `changed-files/`: exact build provenance.
- `physical/`: 52-comparison focused gate and input identities.
- `domain-tests.json`, `ffi-tests.log`, `gpu-tests.log` and
  `ffi-gpu-tests.log`: completed domain runs.
- `physical-gpu-expanded-identity.json`,
  `physical-gpu-expanded-summary.json` and `physical-gpu-expanded-tests.log`:
  ten-camera GPU qualification.

The full corrected-comparator run is under
`/Volumes/Projects/maple-color-gate-20261015/full-gate-v46-corrected-bias/`.
Its intended scope is 776 manifest cases, 796 unique budget cells and 806
comparisons, with 2,954 physical inputs checked before and after execution.
An in-progress run is not acceptance evidence.

## Remaining acceptance requirements

Resolve the cold-WB regression and all other physical failures, complete the
entire color corpus without missing required cases, complete live-binding parity
and performance qualification, and pass review plus fresh CI on the current
base before merging. This report does not waive any of those gates.
