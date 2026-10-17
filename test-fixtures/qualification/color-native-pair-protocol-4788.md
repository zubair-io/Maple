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
corpus migration remain tracked by #3678. Complete Custom-WB validation
landed separately in #4787.

## Review correction: complete Camera Raw authoring state

The original verifier compared a fixed set of authoring controls, then checked
the two captured PNGs against each other. It could accept both captures with
the same added, missing or changed local correction. A new regression suite
reproduced that failure before the repair.

The verifier now compares every authored CRS property with both captures,
including unknown properties and complete nested local-adjustment payloads.
Nested corrections retain their own properties and sequence order; conflicting
duplicates and nonfinite numbers are rejected. Numeric spelling, boolean case
and XML attribute order do not change the meaning of a property.

Capture-added application/profile bookkeeping and resolved named-white-balance
axes are checked between the two captures; explicitly authored values still
have to match. Inactive subcontrols may be omitted only when their parent
amount is zero on both sides. Exact inactive export values for Glow, Reshape,
OverrideLookVignette and empty PointColors/ColorVariance are recognized;
unknown controls and nonneutral values are rejected.

All **17 new authoring-metadata tests and 15 existing comparator tests pass**,
as do all **28 registry tests**. A metadata-only audit of the frozen repair
corpus accepts **758 of 776 cases** and rejects all **18 nr_luminance_max
cases**: Adobe's active luminance-NR detail/contrast controls were not pinned
in their authoring sidecars. These cases remain unqualified for migration
under #3678. This audit neither changes pixels nor clears color failures.
Original sidecars, references, manifest entries and budgets are unchanged.

The three physical protocol controls below are being replayed after the review
repair. Their original results remain historical evidence until that replay
and its input audit finish. Logs and metadata-audit results use the
`complete-crs-*` prefix in the evidence directory.

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
