# Color convergence — design spec

**Status:** Draft
**Owner:** Zubair
**Last updated:** 2026-04-30
**Related plans (folded in):**
- [2026-04-27 clipping-and-artifacts](../plans/2026-04-27-clipping-and-artifacts.md) — AgX hue, highlight recovery, negative channels
- [2026-04-27 edit-flow-remediation](../plans/2026-04-27-edit-flow-remediation.md) — calibration drift, slider hot-path
- [2026-04-29 grey-card-dcp-coverage](../plans/2026-04-29-grey-card-dcp-coverage.md) — synthetic DCP tests
- [2026-04-28 grey-card-adjustment-tests](../plans/2026-04-28-grey-card-adjustment-tests.md) — synthetic slider tests

This spec supersedes the calibration / AgX-clipping portions of the two 2026-04-27 plans. The slider hot-path performance work in `edit-flow-remediation.md` (Phase 2 onward) remains an independent track and is **not** in scope here.

## TL;DR

Maple is the outlier in a tight cluster of professional RAW developers (ACR, RawTherapee, Darktable). The grand mean ΔE on baseline ACR references is 13.42 with systematic negative bias across all three channels — Maple looks darker and the colors don't match. The cause is **not** missing DNG profile support; the embedded HSM/PLT/PTC/ProfileGainTableMap path is largely wired. The cause is a **stack of disabled/empty foundations** that the wired path sits on:

1. DNG WB pre-gain (`AsShotNeutral`) is intentionally disabled at `pipeline.rs:126`, with a comment that says "reintroduce together with per-body BaselineExposure sourced from Adobe DCPs." Adobe DCPs are out by constraint.
2. Vendor-RAW baseline-exposure calibration table (`camera_calibration/mod.rs:202`) is **literally empty** — every CR2/ARW/RAF/NEF/X3F/FFF body gets 0 EV calibration.
3. The empirical `MAPLE_AGX_BASELINE_COMPENSATION_EV = 0.65` constant + damped auto-exposure (damping=0.2) are layered on top of the missing foundation as a tower of compensations.
4. AgX is per-channel (`view/agx.rs:67-89`); saturated highlights hue-rotate.
5. Highlight recovery is wired but defaults to `Off` (`xmp.rs:55`).
6. Two separate "color truth" scripts produce two answers: `test_color_pipeline.sh` (vs embedded JPEG preview) and `calibrate_color_pipeline.sh` (vs ACR references).

The plan: **build a convergence system rooted in open standards and synthetic ground truth that ratchets toward the consensus cluster of professional renderers without copying any of them.** AgX stays. No Adobe DCPs. The cluster is a diagnostic compass, not a CI target.

## Convergence philosophy

The system anchors correctness in two open sources of truth, ordered by strength.

**Strong truth — synthetic ground truth.** A `SyntheticColorChart` DNG with each patch's known sRGB target value renders through Maple. Each patch's output is measured in ΔE₀₀ against its target. This is provable color math — no other app's output is involved. The codebase already has the writer at `src/raw-pipeline/raw-core/src/test_support/synth_chart.rs`; we extend it to cover D50 / D55 / D65 / Tungsten / Fluorescent / Shade illuminants and forged camera identities (per-body Make/Model tags) so it exercises every code path that branches on camera body.

**Spec truth — DNG metadata.** Every DNG already carries `ColorMatrix1/2`, `ForwardMatrix1/2`, `AsShotNeutral`, `BaselineExposure`, and frequently `ProfileToneCurve` / `HueSatDeltas1/2` / `LookTable` / `ProfileGainTableMap`. The `dcp.rs` path applies all of these except `AsShotNeutral` (the disabled WB pre-gain). The DNG spec is **open and freely implementable**; using these tags is not an Adobe IP issue. The convergence work is reconciling our pipeline with what these tags already tell us.

**Cluster as a compass, not a target.** ACR / RawTherapee / Darktable renders are kept as a diagnostic dashboard — "is Maple sliding toward or away from the cluster over time" — but **never** become CI ground truth. Match-to-ACR is replaced by **be-correct-and-trend-toward-cluster**. The CI gate is the synthetic chart suite plus per-fixture ratcheting budgets against ACR references; the cluster dashboard is for diagnosis.

## Phase plan

### Phase 0 — Unified gate + per-stage diagnostic (~5 days)

**Goal:** one canonical color truth, and the ability to localize divergence to a specific pipeline stage rather than only seeing end-to-end ΔE.

- **Promote `calibrate_color_pipeline.sh` → canonical `test_color_pipeline.sh`.** Per-fixture × per-case budget table committed at `test-fixtures/budgets.json`:
  ```json
  { "test_0000": { "baseline": { "mean": 13.5, "p95": 38, "max": 83, "bias": 0.06 }, ... } }
  ```
  CI gates on no-regression vs. committed budgets per fixture × case. Old embedded-preview script either retires or moves to `tools/sanity-checks/test_embedded_preview.sh` (no CI gate; sanity only).
- **Per-stage diagnostic.** The pipeline already has `stage(name, closure)` instrumentation in `pipeline.rs`. Extend with feature-gated `MAPLE_STAGE_DUMP=/tmp/trace` env var that writes the f32 buffer after each stage as `linearize.exr`, `demosaic.exr`, `baseline_exposure.exr`, `dcp_apply.exr`, `auto_exposure.exr`, `white_balance.exr`, `scene_tone_controls.exr`, `agx.exr`. Zero overhead in production builds (`#[cfg(feature = "stage-dump")]`).
- **Stage-diff Python tool** at `src/scripts/stage_diff.py`. Takes two stage-trace dirs (typically Maple-current vs. Maple-prev or Maple-current vs. ACR-stage-equivalents-where-extractable) and produces a per-stage ΔE table + heatmap PNGs. Prints which stage introduced the largest delta.

**Exit criteria:**
- Unified script runs against `test-fixtures/references/manifest.json`, produces a per-fixture × per-case pass/fail table.
- `MAPLE_STAGE_DUMP=...` works on a single fixture and emits 8 EXRs.
- `stage_diff.py` produces a sortable per-stage delta report.
- Old `test_color_pipeline.sh` content is either retired or moved with no CI gate.

### Phase 1 — Calibration foundations (~7–10 days, the centerpiece)

**Goal:** the tower of compensations comes down. WB pre-gain re-enabled per DNG spec; vendor-RAW BaselineExposure populated from open data; the empirical `MAPLE_AGX_BASELINE_COMPENSATION_EV` and `auto_exposure` damping retuned (or removed) on top of the corrected foundation.

#### 1.1 Re-enable DNG WB pre-gain bundle

Apply `AsShotNeutral` per DNG spec § 1.4.4.5 in `pipeline.rs:126` (where the disabled comment lives). The deferral reason in the existing comment — "without HSM/PLT and per-body BE the result was worse" — is partially obsolete: HSM/PLT/PTC are wired; the missing piece is the per-body BE, which Phase 1.2 below provides.

Use the per-stage diagnostic (Phase 0) to verify the bundle moves the post-DCP scene-linear closer to the synthetic-chart target on every fixture, and that the high-ISO chroma-noise amplification flagged in the existing comment is bounded. Land 1.1 and 1.2 together — never one without the other.

**Files:**
- `src/raw-pipeline/raw-core/src/pipeline.rs:126-139` — remove the deferral block; insert `white_balance::apply_pre_gain(&mut camera_rgb, raw.as_shot_neutral)` as DNG step 4.
- `src/raw-pipeline/raw-core/src/white_balance.rs` — add `apply_pre_gain(img, neutral)` that divides each channel by the AsShotNeutral component (identity when `neutral == [1,1,1]`).
- Tests in `pipeline.rs` and `white_balance.rs` — synthetic neutral DNG with non-identity AsShotNeutral round-trips through the pipeline to neutral output.

#### 1.2 Build Maple-owned baseline-exposure table (no Adobe)

Three open-data sources, used in priority order:

**Source A — Synthetic-chart-derived (preferred where possible).** For each unique camera body in our fixture set, render a per-body synthetic ColorChecker DNG (forged Make/Model + body's CM1/CM2 + AsShotNeutral) through Maple's pipeline. The BE value that minimizes ΔE on the neutral patches *is* the calibration. Fully reproducible from code; no external data dependency.

**Source B — RawTherapee `camconst.json`.** RT ships a community-maintained per-body color-matrix + black/white level + raw-crop database under GPL. Mirror their per-body WP/BL adjustments where Maple disagrees with rawler's defaults.

**Source C — Darktable's color-matrix database** (GPL). Cross-check Source B; resolve disagreements by Source A.

Each table entry **cites its source** (`synthetic-derived` / `rt-camconst` / `dt-matrix`) in a comment. Today's `camera_calibration/mod.rs:202-214` placeholder gets the same shape with new sources. Adobe DCPs are not consulted.

**Files:**
- `src/raw-pipeline/raw-core/src/camera_calibration/mod.rs:202-214` — replace `_ => None` placeholder with populated lookup table.
- New `src/raw-pipeline/raw-core/src/test_support/per_body_calibration.rs` — drives synthetic-chart-derived calibration for the 18 fixture bodies + a long tail of common bodies.
- New `tools/calibration/derive_baseline_exposure.py` — scriptable per-body calibration loop that prints proposed table entries.

#### 1.3 Reconcile `MAPLE_AGX_BASELINE_COMPENSATION_EV` and `auto_exposure`

Once the foundation is correct, the compensations either (a) become smaller, (b) become per-body conditional, or (c) get retired. Decide empirically per fixture via the unified gate from Phase 0. The current `0.65` constant is a "fudge factor" by its author's own comment.

Specifically: with WB pre-gain on + per-body BE populated, re-run the unified gate at three values of `MAPLE_AGX_BASELINE_COMPENSATION_EV` ∈ {0.0, 0.3, 0.65} × `AE_DAMPING` ∈ {0.0, 0.1, 0.2}. Pick the (compensation, damping) pair that minimizes grand-mean ΔE while keeping per-fixture max ΔE bounded. Document the empirical sweep in the commit message.

**Exit criteria for Phase 1 as a whole:**
- Unified gate's grand-mean ΔE drops materially from today's 13.42 — target ≤ 8.0 grand mean, ≤ 25 p95, ≤ 0.05 absolute per-channel bias on baseline cases.
- Synthetic ColorChecker neutral patches at D65 land within ΔE ≤ 1.5 of target.
- Per-fixture budgets ratchet down by ≥ 30% on average.
- The disabled-WB-pre-gain comment block is gone.
- `camera_calibration/mod.rs` lookup table has at least one entry per body in the current fixture set, each citing its source.

### Phase 2 — AgX hardening (~7 days)

Wholesale pull-in of [`docs/superpowers/plans/2026-04-27-clipping-and-artifacts.md`](../plans/2026-04-27-clipping-and-artifacts.md) Phases 1, 2, 3, 4 (clipping/hue/floor/extension/recovery-default). The chain of reasoning is sequential: AgX pre-formation rolloff handles scene-linear values > 1.0 correctly, so scene-linear extension above 1.0 becomes safe, so highlight_recovery default → `Blend` becomes useful (it had nothing to recover into when the chain clamped at 1.0). Phase 5 of that plan (Apple Rec.2020 → P3 gamut) is separate platform work; defer to a follow-up.

- **AgX pre-formation rolloff** (Sobotka Open Domain rolloff) in `view/agx.rs:67-92` — eliminates per-channel hue shift on saturated highlights. Picks the AgX 1.x Open Domain variant per the existing plan's "open question 1." Document the choice in `docs/architecture.md` § "Scene-linear chain."
- **Negative-channel soft floor** at DCP exit (`color/dcp.rs`) — preserves hue when post-DCP camera-native produces small negatives.
- **Scene-linear extension above 1.0** in `linearize.rs:134-136` — let raw counts above white_level produce values > 1.0; AgX rolloff handles them gracefully. Same change at `linearize.rs:58` for the LinearRaw path.
- **Highlight recovery default flips** to `Blend` (`xmp.rs:55`); mirror in Swift/TS defaults at `src/apple/Packages/MapleCore/Sources/MapleCore/AdjustmentModel.swift` and `src/web/projects/maple-common/src/lib/models/adjustment-model.ts`.

**Tests:**
- New hue-preservation unit test in `view/agx.rs`: a saturated red specular `[20.0 * AGX_MID_GRAY, 0.5 * AGX_MID_GRAY, 0.5 * AGX_MID_GRAY]` round-trips with R/G ≈ R/B ratio preserved (within 5%).
- Update `per_channel_gamut_compression_reduces_saturation_on_blown_channels` to assert hue, not just bound spread.
- Cross-platform parity gate: Rust output, Metal output, WebGL output identical to ≤ 1e-4 ΔE on a 16-color saturated test set.

**Exit criteria:**
- Every fixture's `max ΔE` drops in the unified gate.
- Visual: pure red specular stays red, no orange-pink shift; saturation-min/max slider cases preserve hue.
- New hue-preservation unit test passes; updated gamut-compression test asserts hue.

### Phase 3 — Synthetic chart calibration suite (~5 days)

Extend the existing grey DCP coverage (`tests/grey_dcp_phase1.rs`, 4 passing tests) to full chart coverage. The user's 2026-04-29 grey-DCP-coverage plan already scopes some of this; expand:

- **24-patch ColorChecker per illuminant** (D50/D55/D65/Tungsten/Fluorescent/Shade) — each patch's expected sRGB known from the X-Rite reflectance × CIE D-illuminant SPDs (already shipped as `ColorChecker24` constants in `colorchecker.rs`).
- **HSM coverage chart** — saturated primaries + secondaries + 5°-stepped hue ring; verifies `HueSatDeltas` application end-to-end.
- **ProfileToneCurve coverage** — synthetic ramp 0 → 1 in scene-linear; verify PTC applies once and doesn't double-apply with `scene_tone_controls`.
- **ProfileGainTableMap coverage** — synthetic spatial gradient with a known PGTM; verify the spatial gain lands in the right pixel locations after the gamut conversion.
- **Per-body forged DNGs** (Make/Model + CM1/CM2 swapped) so we exercise body-specific code paths without real bodies.

**Files:**
- New `src/raw-pipeline/raw-core/tests/synthetic_color_charts.rs` — runs all charts at all illuminants.
- Extend `src/raw-pipeline/raw-core/src/test_support/synth_chart.rs` with HSM / PTC / PGTM-aware variants.

**Exit criteria:**
- `cargo test -p raw-core --features test-support --test synthetic_color_charts` runs all charts at all illuminants, asserts every patch within ΔE ≤ 1.5 of target.
- Test runs in under 10 seconds (synthetic data, no real RAW decode).
- Coverage report shows all four DNG profile ops (HSM, PTC, PLT, PGTM) exercised by the suite.

### Phase 4 — Cross-app convergence dashboard (~5 days, diagnostic only)

- **Headless RT and DT** (`rawtherapee-cli` + `darktable-cli`) in a Docker image at `tools/convergence-renderers/Dockerfile`. Render every fixture × case to PNGs stored in `test-fixtures/references/<stem>/{rt,dt}/<case>.png`.
- **HTML dashboard** at `tools/convergence-dashboard/index.html`: per-fixture row with side-by-side {ACR, RT, DT, Maple} thumbnails + a **convergence scatterplot** (X = mean ΔE Maple-vs-ACR, Y = mean ΔE Maple-vs-cluster-median). Trend lines over time, sourced from a CSV that gets a row appended per CI run.
- Generated nightly by CI; published as a static artifact (GitHub Pages or similar). **No CI gate.**
- **Reference XMP equivalence**: ensure RT and DT receive sliders with the same semantic meaning as the ACR XMP cases. RT's pp3 sidecars + DT's xmp sidecars need a small mapping table at `tools/convergence-renderers/case_mapping.json` (e.g. ACR `Exposure2012=+1.0` → RT `[Exposure] Compensation=1.0` → DT `iop:exposure exposure=1.0`). Document semantic mismatches as "this case has no equivalent in tool X" rather than fudging.

**Exit criteria:**
- Dashboard renders for all 18 fixtures × all baseline cases at minimum.
- Scatterplot has a visible cluster region; Maple's point sits at a measurable distance from it that we can watch shrink across PRs.
- CI publishes the dashboard nightly without blocking anything.

### Phase 5 — Slider parity ratchet (~3 days infrastructure + ongoing)

The existing `SliderMatrixUITests` already covers ~43 cases × 18 fixtures. Today its budgets are loose: mean=25, p95=50, max=100, bias=0.10.

- **Tighten budgets monotonically.** Per-slider × per-fixture budget table at `test-fixtures/slider-budgets.json`. Sourced from the unified gate's outputs after each phase. CI rejects any PR that raises any budget.
- **Edit-delta metric.** Instead of only measuring `Maple-with-slider vs ACR-with-slider`, also measure `(Maple-with-slider) − (Maple-baseline) vs (ACR-with-slider) − (ACR-baseline)`. This isolates **slider behavior** from baseline calibration. A well-calibrated baseline + a wrong slider response is now distinguishable from a calibration drift. Both metrics get budget rows.

**Files:**
- `src/apple/MapleUITests/SliderMatrixUITests.swift` — add budget-table loader and edit-delta metric.
- New `test-fixtures/slider-budgets.json` — committed table.

**Exit criteria:**
- Harness reports both end-to-end ΔE and edit-delta ΔE per case.
- Budget table committed; per-slider × per-fixture entries.
- CI rejects any PR that raises any budget (one-way ratchet).

### Phase 6 — Fixture pool expansion (deferred, ~2 days when triggered)

Hold until Phases 0–5 are green on existing 18 fixtures. Then add ~10 curated fixtures targeting:

- **Modern bodies not yet covered:** Sony A7Rv-class, Nikon Z9-class, Canon R5-class, Fuji X-T5, Pixel/iPhone DNG (smartphone DNG path).
- **Explicit content categories:** ColorChecker shot in-camera under D50 / D65 / Tungsten, foliage scene, skin tones (multiple ethnicities), deep shadow with crushed blacks, specular highlight (chrome / sun on water), high-ISO mixed lighting.
- Each new fixture brings a baseline + 5 representative slider cases minimum.

**Exit criteria:** existing 18 fixtures green at the post-Phase-5 budgets; new fixtures added with ACR refs + entered into the budget tables; the pool grows without lowering the bar.

## Sequencing

| Phase | Days | Depends on | Can run in parallel |
|---|---|---|---|
| 0 — Unified gate + diagnostic | 5 | — | — |
| 1 — Calibration foundations | 7–10 | 0 | — |
| 2 — AgX hardening | 7 | 0, 1.1+1.2 | 3 |
| 3 — Synthetic chart suite | 5 | 0 | 2 |
| 4 — Convergence dashboard | 5 | 0 | 2, 3 |
| 5 — Slider parity ratchet | 3 + ongoing | 1 | continuous |
| 6 — Fixture expansion | 2 | 0–5 green | — |

Total ~30 working days for Phases 0–5. Phases 0 and 1 are on the critical path; everything else opens up after Phase 1 lands.

## Out of scope

- **Slider hot-path performance** (`edit-flow-remediation.md` Phase 2 onward — buffer pooling, GPU-resident cheap stages, refine path crop, etc.). Independent track. Color-correct work and slider-speed work can ship in parallel.
- **Apple Rec.2020 → Display P3 gamut handling** (`clipping-and-artifacts.md` Phase 5). Defer to a follow-up after Phase 2 here lands.
- **Deep-zoom tile rendering**. Already disabled by default; orthogonal.
- **Adobe DCPs.** Constraint: never load Adobe-licensed `.dcp` files. Open-spec DNG metadata + community-licensed RT/DT data only.
- **Replacing AgX.** Constraint: AgX stays. Hardening only.

## Risks

1. **WB pre-gain re-enable regresses some fixtures.** The disabled-comment block warned of high-ISO chroma noise + per-channel hue shift. Mitigation: land 1.1 and 1.2 together; per-stage diagnostic (Phase 0) lets us see the post-DCP delta before/after; ratchet budgets one fixture at a time and back out per-body if regression > tolerance.
2. **Synthetic-chart-derived BE doesn't match real-world body behavior** for some cameras. Mitigation: cross-check against RT camconst.json and DT matrix data; where they disagree, prefer the source that minimizes real-fixture ΔE.
3. **AgX pre-formation rolloff changes the perceived contrast at default sliders.** Per the existing plan's open question 3. Mitigation: re-record the ACR reference budgets after Phase 2 lands; treat the new look as the new baseline.
4. **`AE_DAMPING` and `MAPLE_AGX_BASELINE_COMPENSATION_EV` retuning destabilizes existing slider matrix tests.** Mitigation: Phase 1.3 retunes empirically with the unified gate as the optimization target; the slider matrix budget table absorbs whatever the new equilibrium is via Phase 5.
5. **RT and DT XMP equivalence is incomplete for some sliders** (e.g. ACR's `Texture` slider has no exact RT/DT equivalent). Mitigation: Phase 4 case mapping table documents gaps; dashboard shows N/A for those cells rather than producing fake comparisons.
6. **Headless RT/DT in CI is heavy.** Both binaries are ~100MB and need a display server emulation. Mitigation: Docker image with Xvfb; Phase 4 is diagnostic-only so a flaky nightly build doesn't block anything.

## Open questions

1. **Reference policy after Phase 2** — when AgX pre-formation lands, the ACR refs no longer match Maple's intended look. Re-record? Or keep them and accept higher ΔE on "look" cases while tightening on "calibration" cases (neutrals, exposure, WB)? Recommend re-record for baseline cases; keep ACR refs as-is for slider matrix and rely on edit-delta metric to isolate slider behavior.
2. **Sobotka AgX 1.x or 2.x rolloff?** Open question carried over from clipping plan. Recommend 1.x (simpler, well-validated in Blender 4.x); revisit if 2.x shows materially better behavior on test charts.
3. **Per-body BE table size limit** — populate aggressively (every body in fixture set + top 50 bodies by sales) or lazily (only bodies that fail unified gate)? Recommend lazy: only populate when a fixture's body lacks an entry and is failing budgets, to keep maintenance cost low.

## Definition of done

- Unified `test_color_pipeline.sh` is the single CI color gate; no second script claims to be authoritative.
- Grand-mean ΔE on baseline ACR refs ≤ 8.0 (down from 13.42).
- Synthetic ColorChecker D65 neutral patches ≤ 1.5 ΔE per patch.
- Hue-preservation unit test for AgX passes.
- All four DNG profile ops (HSM, PTC, PLT, PGTM) exercised by `synthetic_color_charts.rs`.
- `camera_calibration/mod.rs` lookup table populated for every body in the fixture set, each citing its open-data source.
- Cross-app convergence dashboard publishes nightly; Maple's distance-to-cluster trend is downward.
- Slider matrix harness reports edit-delta metric in addition to end-to-end ΔE; budgets are one-way ratcheted.
