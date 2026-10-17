# Film input isolation for Auto fitting — #4640

## Isolated repair on main

This branch was qualified at `d0689ff4cea06b320910cc703a90fd8241c24808`, then
rebased onto `676c40a7db1121179b5fe08dd2332e7da8a1834a` with an unchanged Rust
pipeline tree. It includes
only the film-cache repair, its regression, and derived-output invalidation.
It does not include the other accumulated color-pipeline repairs.

A film LUT is supplied separately from `AdjustmentModel`. The Auto-fit fast
path previously reused the current display pixels whenever that model matched
the pinned default model, even when the external LUT had modified those pixels.
The resulting fit shared a RAW/quality/render-size cache key with no-film renders.

The fast path now requires the external LUT to be inactive (absent or at
nonpositive strength), and ignores inert film metadata in its model comparison.
Engaged film renders use
the existing pinned, no-film develop for fitting and retain cache reuse. The
film continues to affect the rendered image. No new cache, shader math or
per-slider work is added. GPU fit entries already use the pinned helper.

Pipeline output **26** invalidates derivatives; Auto-fit model **3** invalidates
old fit artifacts. Generated bindings and qualification summaries are updated.
Their prior-version evidence is not relabeled as new qualification.

## Before and after

The real `test_0002.dng` regression fails on unchanged main: cold and warm film
renders differ in **1,276,306 channel samples**. With the isolated fix it passes,
with zero ignored cases. It proves:

- Auto fitting engages on the physical RAW.
- Cold and warm film output is byte-identical.
- Film-first and no-film-first cache orders produce identical no-film output.
- The supplied film still changes the image.
- Original RAW bytes remain unchanged.

## Local qualification

### Retained CPU preview review correction

The direct film render uses the side-fit route and applies its returned curve.
The retained CPU preview still classified a default model with an external
film LUT as the uncurved fast route. Its next default-detail tick therefore
omitted the curve, whose identity form still compresses values above 0.95.
The real test_0017 RAW with a high-key LUT reproduces **371 differing channel
samples** between the retained tick and direct render before correction.

`CpuPreview::open` uses the same effective-film condition as the direct
render for the uncurved route. This decision is made once at session open and
adds no per-tick allocation. The physical regression now preserves exact
bytes against direct renders at sharpening amounts 40, 0, 150 and 40, matches
the first frame on returning to the default amount, retains both image-buffer
allocations and preserves the original RAW hash. The no-film repeat control
also passes. All six retained-preview tests passed at revision `386bcf479c`. The table
below records the earlier isolated-repair qualification; it is not the
current review-fix qualification.

This route is used by the WASM CPU fallback. The CLI corpus does not call
`CpuPreview`; the existing one-shot render and GPU fit paths are unchanged by
this review correction. Evidence uses the `retained-film-*` prefix below.

| Check | Passed | Existing ignored cases |
| --- | ---: | ---: |
| Explicit physical regression, release | 1 | 0 |
| Core library | 2,805 | 101 |
| GPU library, Metal | 287 | 4 |
| WASM binding, native GPU-enabled target | 74 | 7 |
| FFI library, GPU-enabled | 301 | 6 |

All executed tests pass. The explicit physical regression is included in the
core suite's ignored count and is run separately above. The native WASM suite
has its real RAW fixture present, including both sized film entry tests.
This is native binding execution, not a new browser or Apple UI qualification.
Generation and its repeat, file headroom and whitespace checks pass.

### Inactive film review correction

A physical Canon `test_0007.DNG` render at 768px reproduced **18 changed
channel samples** at zero film strength versus deselecting the look. The
original 128px `test_0017` probe passed before the fix; it did not exercise
the highlight shoulder and is not claimed as reproduction evidence.

Both direct and retained rendering now share the route predicate. It matches
`film_look::apply`'s nonpositive-strength no-op and ignores the film identifier
and strength only when no film operation can affect the input. The fit model
itself remains pinned to defaults. Positive film strength still requires the
separate no-film fit, and other user edits still prevent direct-buffer fitting.

The new physical regression and route-unit matrix pass (2 tests). The physical
test requires a real embedded-JPEG fit and verifies exact direct, first-frame
and retained-repeat output for zero strength with a loaded LUT, zero strength
without a LUT, and a named but unresolved look at full strength. The original
RAW hash remains unchanged. The unit matrix covers empty/named look identifiers,
negative/zero/tiny-positive/full strength and an independent exposure edit.

All 776 canonical sidecars were audited again: FilmLook is empty/absent and
FilmStrength is 100/absent. The new predicate preserves every corpus route
comparison. This input/source audit is not a new full physical corpus pass.
Evidence: `inactive-film-0007-before.log`, `inactive-film-after-visible.log`
and `inactive-film-corpus-audit.json` in the archive below. All seven retained
preview tests and the original cold/warm film-cache regression also pass on
this source, with zero ignored tests in those explicit runs.

The preceding platform run at `386bcf479c` passed core (2,805), GPU (287) and
native GPU-enabled WASM (74), but FFI had 300 passes and one failure in the
unchanged nonblocking scope-poll test. Its three isolated repeats passed.
That parallel run remains recorded as failed; final-source qualification
runs the complete FFI library serially and must finish before merge.

### Fresh CI evidence records

CI detected that the synthetic-grey and API sidecar records still named
pipeline 25 after this isolated fix moved to 26. Their executed assertions
passed; the evidence-version check correctly failed. All five CI-recorded
suites were rerun through `tools/qualification/record.sh`, then independently
rerun with `--check`:

| Evidence source | Passed | Failed / skipped |
| --- | ---: | ---: |
| Synthetic grey | 6 | 0 / 0 |
| Color chart | 7 | 0 / 0 |
| Grey adjustments | 41 | 0 / 0 |
| Grey DCP | 5 | 0 / 0 |
| API sidecar contract | 3 | 0 / 0 |

The five records now attest to actual runs of pipeline 26. The generated
capability summaries were regenerated twice with no drift. Production source,
physical references and budgets were unchanged during these runs. Existing
physical color, Apple and Metal evidence retains its original version; this
refresh does not promote those records to current qualification. Logs, records
and source identities are archived under `qualification-refresh-d068/` in the
directory below.

After rebasing onto that main revision, the physical regression and all five
recorded suites were rerun, and the five suites independently checked again.
Their tested revision is `161117c9bad8eb77ff53b9ba92f0dc62c5584f94`, retained on
the remote branch `codex/qualification-film-auto-fit-161117c9`. That branch
preserves the source named by the records when the PR branch is rebased or
deleted after merge. The Rust pipeline tree is unchanged from the revision
used for the broader library qualification above.

All 776 canonical corpus XMP inputs were parsed; none has a nonempty film-look
selection. The CLI therefore passes `None`, and the added guard preserves the
existing Auto-fit branch for those cases. The input audit and hashes are in
`qualification-refresh-d068/corpus-film-input-audit.json`. This is evidence
that the changed film-only condition does not affect the corpus; it is not a
new full-corpus result.

The original failure log, fixed results, exact source patch and RAW identity
are saved in `/Volumes/Projects/maple-color-gate-20261015/film-auto-fit-current-main/`.

This repairs a deterministic cache-order defect. It does not claim to clear a
case in the 806-comparison Adobe corpus or to pass that entire gate. No physical
color budget, reference, RAW or authored XMP changes.

