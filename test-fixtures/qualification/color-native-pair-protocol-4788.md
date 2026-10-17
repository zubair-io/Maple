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

The three physical protocol controls below were replayed after the review
repair. All three preserve their original statistics and pixel populations,
including all 100,663,296 pixels in the full-detail control. The final audit
confirms all 15 input hashes are unchanged. Generation and repeat generation
also complete without output drift. Logs and metadata-audit results use the
`complete-crs-*` prefix in the evidence directory.

## Qualification

### Missing native reference in the canonical harness

Review found that the full-detail pass could skip an explicitly migrated
case before reaching the protocol-aware comparator. With another passing
case present, a missing native PNG or missing full manifest entry could
therefore leave the pass green. The comparator itself already rejected
missing native inputs; the harness was bypassing it.

The full-detail pass now sends declared protocols through the comparator
even when reference selection fails, recording a per-case error and exiting
nonzero. Undeclared legacy skip accounting remains unchanged. New tests
execute the actual embedded detail pass using real temporary PNGs and XMP
sidecars, including a second valid case. Five rejection scenarios fail
before the correction and pass after it: missing PNG/entry for sharpening
and NR, plus an unknown protocol with a missing reference. Positive and
legacy controls also pass. All four test methods run in the Rust CI workflow.
The existing 15 comparator tests also pass; comparison math is unchanged.
All 19 metadata and 28 registry tests pass, and two code-generation runs leave
generated outputs unchanged. A physical replay through the corrected embedded
detail pass retains all 100,663,296 pixels and exactly the previous statistics
for test_0000/sharpen_detail_max. It still reports the existing max breach
54.710431 versus 52.2; no references are skipped and no comparator errors occur.
Every input and comparator/harness source hash is unchanged during the replay.
The evidence directory records these checks under `missing-native-*`.

### Further review checks

The same missing-preferred-reference bypass also existed in the Neutral and
Auto passes. Both now send explicitly declared protocols through the comparator
when a down entry or PNG is absent. Native-only sharpening/NR cases remain
deferred to the mandatory full-detail pass; a declared down PNG missing on disk
and an unknown protocol still fail immediately. Six rejection scenarios failed
before this correction. All nine harness tests pass across the three passes, including valid pairs
and legacy skip accounting. Code generation and a repeat leave outputs unchanged.

Both workflow path filters now watch the harness and metadata regression files.
Four event/path assertions failed before the update; all six workflow tests
pass afterward. The existing 15 comparator and 19 metadata tests also pass.
Replaying the two physical down comparisons through the actual Neutral pass
preserves every previous metric and all 10,668,000 pixels per comparison.
Both pass their unchanged budgets with zero skips or errors. Input and source
hashes are unchanged during the replay. Evidence uses `missing-down-*`.

Camera Raw packets now reject DTD declarations before the subset verifier
parses either an authoring sidecar or a captured PNG. Empty, internal and
external declarations are covered on both sides; ordinary XML character
references still work. The old reader fails all six rejection controls. The
two new tests and all existing tests pass: **19 metadata + 15 comparator**,
with **28 registry tests** also passing. This uses the existing XML parser's
doctype callback and adds no dependency.

The duplicate authored/native comparison is removed after complete equality
of native/preferred metadata has been established. The test helper imports
the authoring tool once. Review/merge-policy wording has been replaced with
factual qualification results and remaining integration state.

All three physical controls were replayed at
`9de6cb0d43d9bf95d4613b98b433a193f937f8e6` after this update. Every metric is
exactly equal to the previous qualified run: 10,668,000 pixels for each reduced
control and 100,663,296 for full detail. All 15 physical input hashes and the
comparator source hashes remain unchanged during the replay. Code generation
and its repeat produce no drift. The new artifacts use `review-cleanup-*` in
the evidence directory.

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

The whole physical color corpus has existing failures on main. This report
records scoped protocol qualification; it does not establish a passing
whole-corpus gate. Current-main integration, CI and review remain pending.
