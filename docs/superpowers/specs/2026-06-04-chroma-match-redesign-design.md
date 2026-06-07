# Raw color closer to ACR/Camera — DCP + AgX + embedded-JPEG chroma (RFC §3.2 redesign)

**Status:** design, awaiting review
**Goal:** On test_0003 (then the full suite), get Maple's raw color materially closer to ACR/Camera by combining three signals — the DCP color baseline, AgX tone, and a per-image chroma correction derived from the embedded JPEG.
**Canonical product intent:** RFC v2 §3.2. **Supersedes** the matcher in `2026-06-04-jpeg-chroma-match-auto-profile-design.md` (root-polynomial solver).
**Related memory:** `project_chroma_match_32_validation`, `project_acr_remains_baseline`, `project_pano_works_in_rec2020`.

## The objective — and what the JPEG is / isn't

**We are not matching the JPEG.** The target is **ACR/Camera color**. Three contributors combine to reach it:

- **DCP (CM/FM + 2D HueSatMap)** — the deterministic linear-color baseline (per-camera color truth).
- **AgX** — the sole tone operator; owns 100% of tone. Everything upstream stays tone-independent.
- **Embedded JPEG** — the per-image **chroma intent** that corrects the residual gap between the DCP+AgX baseline and ACR/Camera.

The JPEG is the only per-image signal available at runtime (there is no per-photo ACR reference on a user's import); we use it _only because it correlates with ACR_. **ACR is an offline validation gate (CI / fixture time), never a runtime input** — at runtime the transform is solved from the JPEG alone plus the baked-in constants. The chroma correction **stacks on top of the full DCP baseline** — it does not replace the HueSatMap, it closes the measured residual.

## Why the JPEG is a valid per-image proxy (measured, 2026-06-04)

Across 15 fixtures with both an embedded JPEG and an ACR reference:

- `corr(JPEG_mid_C*, ACR_mid_C*) = +0.84`; the JPEG's correction direction (vs the neutral render) agrees with ACR's in **14/15**; `corr(ΔJPEG, ΔACR) = +0.75`.
- The neutral/ACR mid-chroma ratio is **image-dependent** (0.41–1.96, median 0.73; test*0001 is 2× \_over*) — a per-image signal is required; a global saturation bump can't fit it.
- The JPEG's _direction_ is right but its _magnitude overshoots ACR_ (Fuji/Canon punchy JPEGs: test_0013 JPEG 25.1 vs ACR 15.8) — so we follow the JPEG's intent at a **conservative strength (`k`<1), validated against ACR**, not 1:1.
- **Coverage:** 3/17 fixtures have no embedded JPEG (test_0001 `.RAW`, test_0002 `.dng`, test_0016 `.X3F`) → those keep the pure DCP+AgX baseline.

## Why the Phase-1 matcher failed — and the fix

1. **√ root-polynomial terms** (`map_ab` used `signum·√|a|`, unbounded derivative at the neutral axis) injected false chroma into near-neutral skin/sky: 10.74% of near-neutral pixels got C\*>15 vs neutral's 3.25% (linear-only: 4.58%). **This is the blotch cause** — _not_ solver divergence (a 12-iter trace showed clean monotone convergence; the Phase-1 reviewer's `L_scene/L_display` step-rescale targets a non-problem). The solver is already AgX-aware (`forward_post_agx_ab` runs AgX, then matches post-AgX OKLAB).
2. **The taper never engaged**, so highlights ran uncontrolled (+6.27 C\* over ACR).
3. **It was calibrated to the JPEG, which overshoots ACR** → it sailed past the target (auto mid 16.1 vs ACR 11.4).

## Design

Keep the through-AgX solve, the chroma-only application (RAW keeps its own scene-linear L), and the placement (after DCP matrix+HSM, before AgX). Change three things:

1. **Linear transform — drop the root-polynomial.** `map_ab` becomes a pure linear `2×2 + bias` on OKLAB `(a,b)` (`chroma_features → [a,b,1]`, a 3-feature ridge-to-identity solve). C¹-continuous at the neutral axis → cannot amplify near-neutral noise. _This supersedes RFC v2 §3.2.5's "root-polynomial preferred" — the root-poly is measured to be the blotch cause._
2. **Global damping `k` — a conservative default, ACR-gated (not ACR-fit).** `T_final = (1−k)·I + k·T_solved`. `k` is a baked-in default (≈0.5–0.7; `k`<1 because the JPEG overshoots ACR). The offline gate _validates_ it (Auto beats Neutral, no overshoot) rather than optimizing it to the references — favouring a robust value over a knife-edge minimum. Generated via the codegen path so Rust/Swift/TS stay in lockstep.
3. **Tone-weighted taper — axis + window fit against ACR.** Full correction in the mids (where the +0.84 correlation and the gap live), faded toward identity in the highlights (where AgX owns path-to-white). **Not hardcoded** (the Phase-1 OKLAB-L taper mis-attenuated — a live bug). Candidates: axis ∈ {scene-V (max channel — tracks AgX's per-channel path-to-white), scene-Y}; window `[taper_lo, taper_hi]` swept to maximize mid-chroma gain toward ACR subject to **highlight C_over ≤ 0**. (Mapped through AgX, the mid display zone ≈ scene Y 0.06–0.45, so a fixed Y>0.18 cutoff would kill upper-mid correction.)

## Alignment with RFC v2 §3.2 (and the deltas)

Already satisfied in the implementation: center-weighted sampling (lens-falloff mitigation, §3.2.1); JPEG TRC linearize incl. Adobe-RGB detection (§3.2.2); clip (>245/<10) + local-variance filtering (§3.2.4); chroma-only inject keeping the RAW's L, before AgX (§3.2.6); regularize-toward-identity (ridge, §3.2.5).

**Working space:** linear **Rec.2020 D65** (CLAUDE.md principle 2; the DCP stage outputs Rec.2020, not ProPhoto as the RFC text says). Both the RAW scene and the decoded JPEG pass through the _same_ `rec2020_to_oklab`, which satisfies RFC §3.2.3's "common space before OKLAB" requirement — do **not** "fix" this to linear-sRGB per the stale RFC wording.

**Honest decoupling (RFC §3.2.3):** dropping OKLAB L decouples _luminance_, but contrast still inflates _saturation_ — which is exactly the JPEG-overshoot the `k` calibration removes. We don't claim full tone decoupling, only lightness.

## Defaults & gates

- **Primary (merge) gate, offline:** `src/scripts/test_color_pipeline.sh` vs ACR. `k` and the taper are conservative defaults; this gate _validates_ them (it does not tune them, and it runs at CI/fixture time — never at runtime). Budgets are the one-way ratchet.
- **Secondary diagnostic:** `src/scripts/chroma_match_diff.py` (per-zone C_over) — tuning only, not the merge bar.
- **Regression guard:** near-neutral false-chroma % (JPEG-near-neutral pixels with render C\*>15) must stay near the neutral baseline (≈3–5%, not the √ model's 10.7%) — add as a fixture check.
- **No-JPEG fixtures:** assert byte-identical to the DCP+AgX baseline (`Profile::Neutral`).

## Scope

**In:** raw-core matcher rebuild (linear + `k` + taper), ACR calibration, the gates above. CPU render path (maple-cli, WASM, Swift-FFI share the raw-core math).

**Out (later):** GPU wiring of the chroma stage into Metal/WebGL (Phase 2, tracks #812/#394); per-camera-model `k` (only if the global-`k` residual proves body-correlated — YAGNI until measured); the no-JPEG coverage gap; §3.1 DCP value-collapse refinements (separate workstream).

## Risks

- **Taper axis/window** is the main uncertainty — mitigated by fitting against ACR with the explicit highlight-C_over constraint, not a guessed threshold.
- **Global `k` may leave body-correlated residual** (punchy JPEGs run hotter) — acceptable for v1; escalate to per-model `k` only if measured to be body-structured. Prefer under- to over-correction (DCP+AgX baseline is the safe fallback).
- **`k`/taper fit on 17 fixtures** may overfit — report held-out behavior, keep the fit conservative.

## Diagnostics in place

`chroma.rs` carries two env-gated knobs (inert in tests/production): `MAPLE_CHROMA_TRACE` (per-iter convergence + coeff norms) and `MAPLE_CHROMA_LINEAR_ONLY` (zeroes `c2` after a 5-feature solve — fast "is it the √ terms" check). The redesign makes linear-only the _production_ behavior via the clean 3-feature solve (Design §1) — not by column-zeroing, which would hit `ridge_solve_channel`'s singular-column fallback. `MAPLE_CHROMA_TRACE` stays as a debug aid; `LINEAR_ONLY` is removed once §1 lands. Diagnostic renders under `~/Desktop/maple-color-tests/chroma-diag/`.
