# Explicit native reference-pair protocol — #4788

## Scope

The comparator supports `native-pair-lanczos-v1` only when a case explicitly
declares it in its manifest. A migrated case requires an Adobe authoring
sidecar, matching effective Camera Raw settings in the captured PNGs, native
candidate/reference dimensions and compatible full/down geometry. Missing
native input and unknown protocol names fail closed. Existing baseline and
undeclared legacy behavior remain unchanged; full detail retains every pixel.

The color-harness identity now includes both comparator helper modules.
Changing the declared protocol or either helper invalidates old evidence.
Generated registry documentation lists those inputs, and CI watches them.

This isolates the executable protocol from the larger repair branch. It does
not migrate the installed manifest, alter original RAW/XMP/reference bytes,
change rendering math or loosen budgets. Actual capture qualification and
corpus migration remain tracked by #3678. Complete Custom-WB validation is
the separate #4787 change and must land before this chunk is merged.

## Qualification

- Main `d0689ff4cea06b320910cc703a90fd8241c24808` rejects the new protocol
  argument. The saved before-control records that failure.
- All **15 comparator tests** pass, including explicit opt-in, unchanged
  legacy behavior, native pixel counts, unknown/missing protocol inputs,
  incompatible geometry and ignored Adobe tint.
- All **28 capability-registry tests** pass. Mutation tests cover the
  protocol, comparator helper bytes, Adobe sidecars and physical inputs.
- Ruff, rustfmt, shfmt, shell syntax, Prettier, whitespace and file headroom
  checks pass. Code generation updates only the two registry documents.

Three qualified physical cases use the same frozen main-rendered candidate
PNGs for all comparisons. The candidate's undeclared legacy results exactly
equal the actual main comparator's results. Explicit native-pair comparison
uses identical reduction for Maple and Adobe. Every compared pixel count is
preserved, and the full-detail case retains all **100,663,296 pixels** with
exactly unchanged statistics.

| Case | Legacy mean ΔE2000 | Native-pair mean ΔE2000 |
| --- | ---: | ---: |
| `test_0000/exposure_max` | 8.441669 | 8.449212 |
| `test_0000/tint_min` | 8.088864 | 7.818343 |
| `test_0000/sharpen_detail_max` (full) | 5.820834 | 5.820834 |

These are measurement-protocol checks, not cleared rendering failures. The
original inputs are hashed before and after and remain unchanged. Full logs,
per-case metrics, source controls and replay commands are preserved under
`/Volumes/Projects/maple-color-gate-20261015/native-pair-protocol-4788/`.

The session exception allows documented existing physical color failures on
main. Fresh CI, current-main integration and resolved review remain merge
requirements; this report does not claim a passing whole-corpus gate.
