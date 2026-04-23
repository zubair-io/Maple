# 11 — Testing Strategy

The rewrite has ground truth already: 176 PNGs rendered by Adobe Camera
Raw across 4 RAWs × 43 cases, fully documented in
`test-fixtures/references/REFERENCES.md`. That dataset is the spine of
this testing strategy. Everything below is either (a) how Maple's core
consumes it or (b) what the rewrite adds beyond what ACR can tell us.

**Rule:** pipeline changes are gated by this harness. Screenshot-
eyeballing does not count as evidence a change is correct.

## Philosophy

- **Golden images, not unit tests of pixel math.** Unit tests are fine
  for pure helpers (matrix math, curve evaluation) but they can't catch
  "the pipeline produces something a photographer would reject". The
  ACR references do.
- **Perceptual metrics, not pixel RMSE.** Small numerical drift in a
  tone curve is invisible; a small drift in the highlight recovery
  rolloff is a visible failure. CIEDE2000 captures that asymmetry.
  `compare_images.py` is the authoritative tool.
- **Budget that tightens.** The current mean ΔE ≤ 15 budget is a
  starting line. Each case has its own budget (see below), and the
  budgets ratchet down as the pipeline matures. A regression is
  "budget went up" regardless of absolute number.
- **Test the paths users actually take.** Preview at 25% zoom and
  export at 100% both ship. Both are validated independently against
  the matching ACR tier.

## Reference dataset

Defined in `test-fixtures/references/REFERENCES.md`. In summary:

- **4 RAWs** — `test_0000` Hasselblad 100 MP DNG, `test_0001` RAW,
  `test_0002` DNG, `test_0003` Canon CR2.
- **43 cases per RAW** — one ACR slider at one endpoint per case
  (exposure min/max, contrast min/max, WB presets, clarity, texture,
  dehaze, vibrance, saturation, sharpening amount/radius/detail/masking,
  NR luminance/colour), plus a `baseline` that uses ACR defaults.
- **Two tiers** — `down/` at 4000 px long-edge for tone/colour cases
  (spatially invariant), `full/` at native resolution for spatial-
  frequency cases (sharpening, NR), with `baseline` rendered at both.
- **Output format** — sRGB IEC61966-2.1 8-bit PNG, compression 6.
- **Parameters as XMP** — one `crs:`-namespaced PV2012 sidecar per
  case, committed under `<raw>/xmp/`.

Maple consumes this dataset by reading the XMP for a case, rendering
through its own pipeline at the matching tier, and diffing the result
against the ACR PNG.

## Case matrix alignment

For each case in the ACR matrix, Maple's harness produces two renders:

| ACR case       | ACR tier | Maple render                          | Compared against |
|----------------|----------|---------------------------------------|------------------|
| `baseline`     | down     | `--tier down --zoom 50`               | ACR `baseline` (down) |
| `baseline`     | full     | `--tier full --zoom 100`              | ACR `baseline` (full) |
| `exposure_min` | down     | `--tier down --zoom 50`               | ACR `exposure_min` (down) |
| …tone/WB/presence cases… | down | same                        | ACR `down/` |
| `sharpen_*`, `nr_*` | full | `--tier full --zoom 100`              | ACR `full/` |

This is 1:1 with REFERENCES.md — no new cases required to reach a first
passing run. Cases beyond ACR's slider set (per-channel HSL, tone
curves, local adjustments, lens corrections) are added by extending
`matrix.py` and the Maple core together; the harness design doesn't
change.

## Zoom-parametrised validation

The ACR references cover **what the pipeline should produce**. They do
not cover **how the interactive UI should arrive there**. Zoom-level
testing fills that gap.

The UI has a view-dependent preview strategy (see `05-performance.md`):
below ~50% zoom, render a downsampled raw; at 100% zoom, render tiles
of full-resolution raw. Both paths must agree with the ACR reference at
their respective scales, and they must agree with each other at max
quality.

For every case in the matrix, the harness runs:

1. **Preview, zoomed out.** `--tier down --zoom 25` → downsampled-raw
   path → compare against ACR `down/`.
2. **Preview, zoomed in.** `--tier full --zoom 100` → tiled full-res
   path → compare against ACR `full/` (for cases that have a `full/`
   reference) or an upscaled comparison against `down/` otherwise.
3. **Export.** `--tier full --zoom 100 --quality max` → full pipeline,
   no preview shortcuts → compare against ACR `full/` where available,
   `down/` otherwise.

Gates:

- Preview-zoomed-out must be within budget vs. ACR `down/`.
- Export must be within budget vs. ACR `full/`.
- Preview-at-max-quality and export-at-max-quality must be within a
  much tighter internal budget (ΔE ≤ 1.0 initially, targeting exact
  equality). This is the dual-path check — it catches divergence
  between the preview and export code paths before either can silently
  drift.

Tile-boundary bugs are caught by this check specifically: a tiled
preview that doesn't match a full-frame export reveals boundary math
errors even when both paths individually happen to be close to ACR.

## Metrics and budgets

Authoritative tool: `src/scripts/compare_images.py`.

Reported per comparison:

- **Mean ΔE2000** — primary perceptual metric. Budget applied here.
- **P95 and max ΔE2000** — catches localised failures that mean would
  average out (clipped highlights in one corner, a tile seam).
- **Per-channel bias** — signed R/G/B mean deltas. Non-zero bias in any
  channel usually indicates a WB or gamma bug; drop-through bias is a
  hint for where in the pipeline to look.

Budget table (starting point, tightens over time; tracked in a
`budgets.toml` next to the harness):

| Case class                         | Initial mean ΔE | Target mean ΔE |
|-----------------------------------|-----------------|----------------|
| `baseline`                         | 10              | 2              |
| WB presets (`wb_*`)                | 15              | 3              |
| Exposure / contrast / white/black  | 15              | 3              |
| Highlights / shadows               | 20              | 5              |
| Clarity / texture / dehaze         | 25              | 8              |
| Vibrance / saturation              | 15              | 3              |
| Sharpening (`sharpen_*`)           | 20              | 5              |
| Noise reduction (`nr_*`)           | 25              | 10             |

A case "passes" when its mean, P95, and per-channel bias are all under
budget. CI fails a PR that raises any budget; budgets move only
downward, and only by explicit commit.

## Regression gates

Three tiers of CI gate:

1. **Byte-identical baseline.** For each RAW, a CPU-backend render of
   `baseline` at both tiers must be byte-identical to a checked-in
   expected PNG. Cheap, catches accidental non-determinism.
2. **Perceptual matrix.** Full 176-case matrix rendered through the
   Maple core, diffed against ACR references, budgets enforced. Runs
   on every PR that touches the core.
3. **Dual-path agreement.** For a rotating subset of cases (all of
   them nightly, 10 per PR), the preview and export paths are rendered
   at max quality and compared to each other under the tight internal
   budget.

Cross-platform gates add a fourth:

4. **Backend parity.** The CPU reference render is compared against
   the Metal and WebGPU backend renders. Platform-specific tolerances
   documented in `06-cross-platform.md`; any tolerance wider than
   ΔE ≤ 1.0 requires a written justification.

Format encoder gates add a fifth:

5. **EXR round-trip.** Render a known scene to EXR via Maple, open in
   Blender's compositor (headless, scriptable), re-export from Blender
   with no modifications, re-import into Maple's pipeline. Pixel parity
   asserted to **1e-4 linear** (same tolerance as AgX and the web
   tiling parity tests). Catches metadata mistakes — wrong
   chromaticities, wrong `displayWindow`, off-by-one channel layout —
   that wouldn't fail loudly otherwise. Nuke validation is a manual
   pre-release gate, not CI. See [`08-io.md`](./08-io.md) § Export and
   [`09-open-questions.md`](./09-open-questions.md) § 9.47.

Algorithm calibration adds two more:

6. **Richardson-Lucy capture-sharpening calibration.** Pre-ship gate,
   not a CI loop. A reference scene set covers the failure modes that
   bite RL specifically: aliased edges (chain-link, brick, distant
   power lines — RL can ring), low-contrast detail (foliage, fabric,
   sand — RL should sharpen without amplifying noise), portrait skin
   (over-sharpening is unflattering — masking slider must clip
   cleanly), bokeh boundaries (shallow DOF — RL should respect the
   in-focus → soft transition), and specular highlights (RL can
   produce ringing halos — masking should suppress). The pass produces
   the slider→mix-weight curve, the edge-mask attenuation parameters
   at each `sharpenMasking` value, and any per-path iter-count
   adjustment if the spec'd 3 turns out to be wrong. **Cannot ship
   without this calibration locked.** See
   [`03-algorithms.md`](./03-algorithms.md) § 3.10 and
   [`09-open-questions.md`](./09-open-questions.md) § 9.51.

7. **Vibrance hue-window calibration.** Pre-ship gate followed by a
   permanent CI gate. Reference set: 30 portraits with three-axis
   coverage — Fitzpatrick I–VI (6 skin-tone categories × ~5
   portraits), six lighting conditions (daylight, tungsten, overcast,
   golden hour, fluorescent, mixed), and 2–3 unusual-WB shots.
   Sourcing the set with documented Fitzpatrick categorization is part
   of the deliverable. Phase 1: manual tuning — render each portrait
   at vibrance = +50, iteratively adjust the four `SceneVibrance`
   smoothstep endpoints until skin tones stay perceptually close to
   the input across all 30 images. Phase 2: once endpoints lock, the
   vibrance outputs on the 30-image set become golden images; CI
   catches any regression to **1e-4 linear**. **Cannot ship without
   the calibration locked.** See
   [`03-algorithms.md`](./03-algorithms.md) § 3.7 and
   [`09-open-questions.md`](./09-open-questions.md) § 9.4.

## What each RAW exercises

Recorded here so algorithm authors know which fixture to prioritise
when debugging. Fill in from the fixtures as you characterise them;
placeholder content below.

- `test_0000` (Hasselblad L3D-100c, 100 MP DNG) — stress test for
  memory, tile boundaries, and downsample fidelity. Slowest render;
  run last in local iteration.
- `test_0001` (RAW) — [describe: sensor, scene content, what it
  breaks in practice].
- `test_0002` (DNG) — [describe].
- `test_0003` (Canon CR2) — non-DNG codepath; validates the Canon
  decoder + CR2-specific metadata handling.

## Adding new cases

When the core grows a capability beyond ACR's PV2012 slider set:

1. If it can be expressed as an ACR slider, extend `matrix.py` and
   regenerate the XMP + PNG for that case via `--cases-filter`. Commit
   both.
2. If it cannot (local adjustments, custom curves, lens corrections),
   the reference is generated by Maple itself in a pinned "known-good"
   build, reviewed by eye once, then committed. From that point
   forward it's treated as ground truth and gated the same way as the
   ACR references. The review-by-eye moment is the only time
   eyeballing is allowed.
3. Add the case's budget to `budgets.toml`.
4. Extend the harness to exercise the new case at all three paths
   (preview-zoomed-out, preview-zoomed-in, export).

## Non-goals

- **No end-user acceptance tests here.** UX-level testing lives in the
  web and iOS layers, not in the core's harness.
- **No perf tests against the ACR references.** Performance budgets
  are validated separately (see `05-performance.md`); the ACR dataset
  is for correctness only. They share fixtures but not gates.
- **No fuzzing of RAW decoders.** Decoder robustness is its own
  concern, tracked separately; the golden dataset assumes well-formed
  input.

## Open questions

- Should per-stage dumps (see `10-cli.md`) be gated in CI, or only
  produced on demand? Gating them would let us diff intermediates
  against a Darktable / RawTherapee reference for cross-validation,
  at the cost of ~2× harness runtime.
- How to handle ACR process-version updates. PV2012 is pinned, but
  Adobe could ship PV2026 and make PV2012 rendering subtly
  different. Versioning the reference dataset against ACR build
  numbers is probably necessary.
- Threshold for "a case has drifted enough to retire". If the target
  budget for a case is hit and held for N releases, is it removed from
  PR-blocking gates and kept only in nightly? Open.
