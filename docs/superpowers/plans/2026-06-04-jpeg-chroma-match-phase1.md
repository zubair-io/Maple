# JPEG chroma-match — Phase 1 (raw-core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `Profile::Auto` with a per-image scene-linear OKLAB `a`/`b` chroma transform solved from the embedded JPEG and applied at decode (keeping the RAW's `L`), **fit through AgX** so it does not reproduce the HSM-class highlight over-saturation, validated post-AgX/per-zone/held-out on test_0003.

**Architecture:** New `view/auto_profile/chroma.rs` holding a `ChromaTransform` (a low-degree root-polynomial on `(a,b)` + a value-aware highlight taper) and its solver. The solver's objective is **post-AgX**: it minimizes ΔE between the AgX-rendered, chroma-injected RAW and the embedded JPEG (AgX is a fixed forward model in the loss). The transform is applied as a new stage in the shared `develop_scene_linear_from_raw_with_quality` right after `dcp::apply_colorimetry`, gated on `Profile::Auto`, so it rides the shared scene-linear buffer to every platform. Validation extends the Feature-1 per-hue/per-zone instrument.

**Tech Stack:** Rust (raw-core; `color::oklab`, `view::agx`, the `Image`/`Vec3` types), Python (numpy/Pillow/colour for the gate, reusing `compare_images.py`), `maple-cli`.

**Source spec:** `docs/superpowers/specs/2026-06-04-jpeg-chroma-match-auto-profile-design.md`. **Build base:** this branch (`spec/jpeg-chroma-match`) is stacked on PR #910 so the Feature-1 instrument is present.

**Scope:** Phase 1 = raw-core solver + decode inject + CPU validation only. The GPU tone-LUT wiring (Phase 2, #812/#394) is a separate per-platform cycle and is NOT in this plan. The chroma reaches Apple/Web via the shared decode with no shader.

---

## Key surfaces (verified)

- `src/raw-pipeline/raw-core/src/color/oklab.rs`: `pub fn rec2020_to_oklab(rgb: Vec3) -> Vec3` (:50), `pub fn oklab_to_rec2020(lab: Vec3) -> Vec3` (:63). OKLAB is `[L, a, b]`.
- `src/raw-pipeline/raw-core/src/view/agx.rs`: `pub fn apply(img: &mut Image, contrast: f32)` (:150) — the fixed forward tone model.
- `src/raw-pipeline/raw-core/src/pipeline/develop/mod.rs`: `develop_scene_linear_from_raw_with_quality` (:148); inject after the `stage("dcp::apply", || dcp::apply_colorimetry(...))` call (:271).
- `src/raw-pipeline/raw-core/src/types/adjustment/mod.rs`: `enum Profile` (:55), `Profile::Auto`.
- `src/raw-pipeline/raw-core/src/view/auto_profile/`: `preview.rs` (embedded-JPEG extract + orientation), `cache.rs` (LRU keyed on RAW path/mtime|bytes-hash), `solve.rs`/`fit_display.rs` (existing tone sampling to mirror). `Image` has `pixels: Vec<[f32;3]>`.

---

## File structure

| File                                                        | Action             | Responsibility                                                                                                                                   |
| ----------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/raw-pipeline/raw-core/src/view/auto_profile/chroma.rs` | Create             | `ChromaTransform` (root-poly on a/b + value taper), `apply_to_scene`, the through-AgX `solve_chroma`, sampling+filtering. The whole chroma unit. |
| `src/raw-pipeline/raw-core/src/view/auto_profile/mod.rs`    | Modify             | `pub mod chroma;` + re-exports.                                                                                                                  |
| `src/raw-pipeline/raw-core/src/pipeline/develop/mod.rs`     | Modify (~:271)     | Inject the chroma stage after `dcp::apply_colorimetry`, gated on `Profile::Auto`; thread the solved transform in.                                |
| `src/raw-pipeline/raw-core/src/pipeline/render/mod.rs`      | Modify (~:107–207) | Solve+cache the chroma transform alongside the existing tone fit; keep the chroma-then-tone ordering.                                            |
| `src/scripts/chroma_match_diff.py`                          | Create             | Post-AgX, per-zone/per-hue, held-out chroma-match metric vs the linearized JPEG (imports `compare_images`).                                      |
| `src/scripts/test_chroma_match.sh`                          | Create             | Gate: render test_0003 `--profile auto`, run the metric, ratchet a committed budget.                                                             |

---

## Task 1: `ChromaTransform` representation + apply (keep L)

**Files:** Create `src/raw-pipeline/raw-core/src/view/auto_profile/chroma.rs`; Modify `view/auto_profile/mod.rs` (`pub mod chroma;`).

- [ ] **Step 1: Write the failing test** (append to `chroma.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::{ColorSpace, Image};

    fn one_px(rgb: [f32; 3]) -> Image {
        Image { pixels: vec![rgb], width: 1, height: 1, space: ColorSpace::SceneLinearRec2020 }
    }

    #[test]
    fn identity_transform_is_noop() {
        let t = ChromaTransform::identity();
        let mut img = one_px([0.4, 0.2, 0.1]);
        let before = img.pixels[0];
        t.apply_to_scene(&mut img);
        for c in 0..3 { assert!((img.pixels[0][c] - before[c]).abs() < 1e-5, "{:?}", img.pixels[0]); }
    }

    #[test]
    fn apply_preserves_oklab_L() {
        // A non-identity transform must change a/b but leave OKLAB L within float noise.
        let t = ChromaTransform { gain: 1.5, ..ChromaTransform::identity() }; // scales a,b by 1.5
        let mut img = one_px([0.5, 0.25, 0.15]);
        let l_before = crate::color::oklab::rec2020_to_oklab(img.pixels[0])[0];
        t.apply_to_scene(&mut img);
        let lab_after = crate::color::oklab::rec2020_to_oklab(img.pixels[0]);
        assert!((lab_after[0] - l_before).abs() < 1e-4, "L moved: {} -> {}", l_before, lab_after[0]);
    }
}
```

- [ ] **Step 2: Run, verify it fails** — `cd src/raw-pipeline && cargo test -p raw-core chroma:: 2>&1 | grep -E 'error|test result'` → FAIL (`ChromaTransform` undefined). (No `tail` piping of cargo.)

- [ ] **Step 3: Implement the minimal struct + apply** (top of `chroma.rs`)

```rust
//! Per-image JPEG chroma-match transform (Auto Profile chroma). Operates on
//! OKLAB a/b only — keeps L (AgX owns tone). See
//! docs/superpowers/specs/2026-06-04-jpeg-chroma-match-auto-profile-design.md.
use crate::color::oklab::{oklab_to_rec2020, rec2020_to_oklab};
use crate::image::Image;
use rayon::prelude::*;

/// A root-polynomial chroma map on (a,b) plus a value-aware highlight taper.
/// `gain`/`mat` express the low-degree term; `taper_lo/hi` attenuate toward
/// identity as scene OKLAB L rises (the HSM-validated highlight guard).
#[derive(Clone, Copy, Debug)]
pub struct ChromaTransform {
    /// 2x2 linear part on (a,b) and a 2-vector bias; the root-polynomial adds
    /// the sqrt-magnitude term via `c2`. Identity = mat=I, bias=0, c2=0.
    pub mat: [[f32; 2]; 2],
    pub bias: [f32; 2],
    pub c2: [[f32; 2]; 2], // root-polynomial coeff on (sqrt|a|·sign, sqrt|b|·sign)
    pub gain: f32,         // global a,b scale (subsumed into mat at solve time; 1.0 = identity)
    pub taper_lo: f32,     // OKLAB L where taper begins (1.0 = no taper)
    pub taper_hi: f32,     // OKLAB L where transform is fully identity
}

impl ChromaTransform {
    pub fn identity() -> Self {
        Self { mat: [[1.0, 0.0], [0.0, 1.0]], bias: [0.0, 0.0], c2: [[0.0; 2]; 2],
               gain: 1.0, taper_lo: 2.0, taper_hi: 3.0 }
    }

    /// Map (a,b) -> (a',b') (no taper; pure transform).
    #[inline]
    fn map_ab(&self, a: f32, b: f32) -> (f32, f32) {
        let g = self.gain;
        let ra = a.signum() * a.abs().sqrt();
        let rb = b.signum() * b.abs().sqrt();
        let na = g * (self.mat[0][0] * a + self.mat[0][1] * b) + self.c2[0][0] * ra + self.c2[0][1] * rb + self.bias[0];
        let nb = g * (self.mat[1][0] * a + self.mat[1][1] * b) + self.c2[1][0] * ra + self.c2[1][1] * rb + self.bias[1];
        (na, nb)
    }

    /// Apply in-place to a scene-linear Rec.2020 image; keeps OKLAB L.
    pub fn apply_to_scene(&self, img: &mut Image) {
        img.pixels.par_iter_mut().for_each(|p| {
            if p[0] < 0.0 || p[1] < 0.0 || p[2] < 0.0 { return; } // match HSM neg-bypass
            let lab = rec2020_to_oklab(*p);
            let (mut na, mut nb) = self.map_ab(lab[1], lab[2]);
            // value-aware taper toward identity in highlights
            let t = ((lab[0] - self.taper_lo) / (self.taper_hi - self.taper_lo)).clamp(0.0, 1.0);
            let att = t * t * (3.0 - 2.0 * t);
            na = lab[1] + (na - lab[1]) * (1.0 - att);
            nb = lab[2] + (nb - lab[2]) * (1.0 - att);
            *p = oklab_to_rec2020([lab[0], na, nb]);
        });
    }
}
```

- [ ] **Step 4: Run, verify pass** — `cargo test -p raw-core chroma::` → `identity_transform_is_noop` + `apply_preserves_oklab_L` PASS. (`gain: 1.5` scales a/b, L untouched.)

- [ ] **Step 5: Commit** — `git add src/raw-pipeline/raw-core/src/view/auto_profile/chroma.rs src/raw-pipeline/raw-core/src/view/auto_profile/mod.rs && git commit -m "feat(raw-core): ChromaTransform (OKLAB a/b root-poly + value taper, keeps L)"`

---

## Task 2: Forward model (inject + AgX) — the post-AgX objective primitive

The solver fits against post-AgX appearance, so it needs a cheap "samples → post-AgX display a/b" function reusing the real `agx::apply`.

**Files:** Modify `chroma.rs`.

- [ ] **Step 1: Failing test**

```rust
#[test]
fn forward_identity_matches_plain_agx() {
    let scene: Vec<[f32;3]> = vec![[0.3,0.18,0.12],[0.6,0.5,0.45],[0.05,0.04,0.04]];
    let id = ChromaTransform::identity();
    let got = forward_post_agx_ab(&scene, &id, 0.0);
    // plain AgX on the same pixels, then to OKLAB a/b
    let mut img = Image { pixels: scene.clone(), width: 3, height: 1, space: crate::image::ColorSpace::SceneLinearRec2020 };
    crate::view::agx::apply(&mut img, 0.0);
    for (i, p) in img.pixels.iter().enumerate() {
        let lab = crate::color::oklab::rec2020_to_oklab(*p);
        assert!((got[i].0 - lab[1]).abs() < 1e-4 && (got[i].1 - lab[2]).abs() < 1e-4);
    }
}
```

- [ ] **Step 2: Run → FAIL** (`forward_post_agx_ab` undefined). Command as Task 1 Step 2.

- [ ] **Step 3: Implement**

```rust
use crate::image::{ColorSpace, Image as Img};

/// Apply `t` to scene samples, run AgX, return post-AgX OKLAB (a,b) per pixel.
pub(crate) fn forward_post_agx_ab(scene: &[[f32; 3]], t: &ChromaTransform, contrast: f32) -> Vec<(f32, f32)> {
    let mut img = Img { pixels: scene.to_vec(), width: scene.len(), height: 1, space: ColorSpace::SceneLinearRec2020 };
    t.apply_to_scene(&mut img);
    crate::view::agx::apply(&mut img, contrast);
    img.pixels.iter().map(|p| { let lab = rec2020_to_oklab(*p); (lab[1], lab[2]) }).collect()
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(raw-core): post-AgX forward model for chroma fit`

---

## Task 3: JPEG sampling + filtering (clip / variance / center-weight)

**Files:** Modify `chroma.rs`. Reuse `view::auto_profile::preview` for extraction (already returns oriented preview pixels + dims).

- [ ] **Step 1: Failing test** — synthetic: a 4×4 RAW + a 4×4 "JPEG" where one pixel is clipped (255) and one is in a high-variance neighborhood; assert `sample_pairs` excludes both and that center pixels get higher weight than corners.

```rust
#[test]
fn sampling_excludes_clipped_and_weights_center() {
    // 4x4 RAW scene-linear + JPEG bytes (sRGB 0..1). One JPEG pixel clipped.
    let raw = vec![[0.2_f32,0.18,0.15]; 16];
    let mut jpeg = vec![[0.4_f32,0.35,0.30]; 16];
    jpeg[5] = [1.0, 0.02, 0.30]; // clipped R (>245/255) and crushed G (<10/255)
    let pairs = sample_pairs(&raw, 4, 4, &jpeg, 4, 4);
    assert!(pairs.iter().all(|p| !(p.clipped)), "clipped pair retained");
    let w_center = pairs.iter().find(|p| p.x==2 && p.y==2).unwrap().weight;
    let w_corner = pairs.iter().find(|p| p.x==0 && p.y==0).unwrap().weight;
    assert!(w_center > w_corner, "center {} !> corner {}", w_center, w_corner);
}
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `struct Pair { raw_ab:(f32,f32), jpeg_lin:[f32;3], x:usize, y:usize, weight:f32, clipped:bool }` and `sample_pairs(raw_scene, rw, rh, jpeg_srgb01, jw, jh) -> Vec<Pair>`:
  - box-downscale RAW to JPEG dims (mirror `solve.rs::footprint_sizes`), `rec2020_to_oklab` → `raw_ab`;
  - `jpeg_lin` = inverse-sRGB of the JPEG pixel (reuse `srgb_to_linear_one`);
  - `clipped` = any JPEG channel byte `>245 || <10`;
  - drop pairs whose 3×3 JPEG-luma variance exceeds a threshold (CA/edges/blocks);
  - `weight` = radial cosine falloff from image center (center-weighting). Keep only non-clipped, low-variance pairs.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(raw-core): chroma sample/filter (clip + variance + center-weight)`

---

## Task 4: The solver — fit through AgX (the research-y core; test defines correctness)

**Files:** Modify `chroma.rs`. This is the load-bearing task; the **test is the spec**, the iteration internals are TDD-refined.

- [ ] **Step 1: Failing test — recover a known shift THROUGH AgX, on held-out pixels, no highlight blow-up**

```rust
#[test]
fn solver_recovers_known_shift_through_agx_held_out() {
    // Ground-truth transform we will try to recover.
    let truth = ChromaTransform { gain: 1.0, mat: [[1.0, 0.0],[0.0, 1.18]], ..ChromaTransform::identity() };
    // Random-ish scene (deterministic), split fit/measure.
    let scene: Vec<[f32;3]> = (0..400).map(|i| {
        let f = i as f32; [0.05+0.5*((f*0.013).sin().abs()), 0.04+0.4*((f*0.07).cos().abs()), 0.03+0.4*((f*0.11).sin().abs())]
    }).collect();
    // "JPEG target" = post-AgX of the truth-transformed scene (so a perfect solver matches it).
    let jpeg_ab: Vec<(f32,f32)> = forward_post_agx_ab(&scene, &truth, 0.0);
    let (fit, meas) = (&scene[..300], &scene[300..]);
    let (fit_t, meas_t) = (&jpeg_ab[..300], &jpeg_ab[300..]);
    let solved = solve_chroma_through_agx(fit, fit_t, 0.0);
    // On held-out pixels, post-AgX a/b must match the target far better than identity.
    let id_err = mean_ab_err(&forward_post_agx_ab(meas, &ChromaTransform::identity(), 0.0), meas_t);
    let solved_err = mean_ab_err(&forward_post_agx_ab(meas, &solved, 0.0), meas_t);
    assert!(solved_err < id_err * 0.25, "solved {} not << identity {}", solved_err, id_err);
}
```

(`mean_ab_err` = mean Euclidean (a,b) distance — a tiny test helper.)

- [ ] **Step 2: Run → FAIL** (`solve_chroma_through_agx` undefined).

- [ ] **Step 3: Implement the damped fixed-point through-AgX solve.** Concrete scheme (refine constants under the test):
  1. `t = identity`. Repeat `K=8` times:
  2. `out = forward_post_agx_ab(fit_scene, &t, contrast)`.
  3. residual per sample `r_i = target_i - out_i` (post-AgX a/b error).
  4. Form **adjusted pre-AgX targets**: `adj_i = t.map_ab(raw_ab_i) + λ·r_i` (λ≈0.7 damping — AgX is ~locally-linear in a/b at fixed L, so a post-AgX residual maps back to a pre-AgX nudge).
  5. **Weighted, regularized least-squares** refit of `t`'s `(mat,bias,c2)` mapping `raw_ab_i → adj_i`, weights = `Pair.weight`, ridge term pulling toward identity (`mat→I, bias→0, c2→0`) so sparse hues don't drift.
  6. Stop when the post-AgX mean error stops improving.
  7. Set `taper_lo/hi` from the fit-scene OKLAB-L distribution (begin taper near the L-p90 so highlights ride toward identity — the HSM-validated guard).
     Return `t`. Add `solve_chroma_through_agx(scene, target_ab, contrast) -> ChromaTransform` and the ridge LSQ helper (4 unknowns per output channel → small normal-equations solve; use a 6×6 or two 6-unknown solves with `nalgebra`-free hand-rolled Gaussian elimination to avoid a new dep, matching repo style).

- [ ] **Step 4: Run → PASS** (held-out error ≤ 25% of identity). Iterate `K`, `λ`, ridge strength until green; these are the TDD-discovered constants.

- [ ] **Step 5: Add the guard tests + commit**

```rust
#[test] fn solver_identity_when_target_is_plain_agx() { /* target = forward(identity); solved ≈ identity */ }
#[test] fn solver_regularizes_sparse_hues() { /* a target covering only one hue octant must not wildly move others (held-out other-hue pixels stay near identity) */ }
```

`git commit -m "feat(raw-core): through-AgX chroma solver (damped fixed-point + ridge-to-identity + highlight taper)"`

---

## Task 5: Decode-stage integration + cache + chroma/tone ordering

**Files:** Modify `pipeline/develop/mod.rs` (~:271), `pipeline/render/mod.rs` (~:107–207), `view/auto_profile/mod.rs`.

- [ ] **Step 1: Failing test** (raw-core integration test, `pipeline/render/tests.rs` or a new `chroma_integration` test): render a real fixture twice — `Profile::Neutral` and `Profile::Auto` — assert (a) Neutral is byte-identical with/without the chroma code path (chroma never fires), and (b) Auto differs from Neutral in chromatic regions but the neutral/grey patch ΔE between them is ~0 (chroma leaves neutrals alone). Gate behind the `MAPLE_UITEST_FIXTURE`/fixture-present pattern (skip if absent).

- [ ] **Step 2: Run → FAIL** (chroma not wired).

- [ ] **Step 3: Implement.**
  - `develop/mod.rs`: after the `dcp::apply` stage (:271), add `if let Some(ct) = chroma_transform { stage("chroma_match", || ct.apply_to_scene(&mut scene)); }` — `chroma_transform: Option<ChromaTransform>` threaded into `develop_scene_linear_from_raw_with_quality` (None for Neutral).
  - `render/mod.rs`: where `Profile::Auto` already extracts the JPEG + fits the tone curve (:107–207), **first** solve the chroma transform (extract JPEG via `preview`, `sample_pairs`, `solve_chroma_through_agx`), pass it into develop, **then** fit the tone curve on the chroma-applied render (existing call, now downstream of chroma) — the spec's chroma-then-tone consistency. Cache the `ChromaTransform` next to the tone curve in the existing LRU (`cache.rs`), same key.
  - Fallback: JPEG-extract failure / degenerate fit → `chroma_transform = None` → deterministic baseline.

- [ ] **Step 4: Run → PASS** (Neutral unchanged; Auto moves chroma, neutrals ~0).
- [ ] **Step 5: Commit** — `feat(raw-core): wire chroma-match into Profile::Auto decode (chroma-then-tone)`

---

## Task 6: Post-AgX / per-zone / held-out chroma-match gate (Python)

**Files:** Create `src/scripts/chroma_match_diff.py`, `src/scripts/test_chroma_match.sh`. Reuses `compare_images.py` (Feature-1 per-hue/per-zone) — present on this stacked branch.

- [ ] **Step 1: Failing test** — `chroma_match_diff.py <render.png> <jpeg.png>` must emit per-zone (shadow/mid/**highlight**) and per-hue a/b deltas vs the **linearized, EXIF-oriented, aspect-matched** JPEG, plus a held-out note. Write `chroma_match_diff_test.py` (plain-assert, mirror `compare_images_test.py`): synthetic render+JPEG with a known red-highlight chroma gap → the metric attributes it to the highlight zone + red hue bin; identical inputs → ~0.

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `chroma_match_diff.py`: extract+orient+linearize the JPEG (mirror `preview.rs` orientation), resize render→JPEG dims, center-weight, and reuse `compare_images.diff(..., zones=True, hue_bins=12)` on (render vs JPEG) — reporting **highlight-zone a/b** and per-hue a/b specifically, since those are where the tone-collision shows. Emit JSON.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(scripts): post-AgX per-zone chroma-match metric (vs embedded JPEG)`

---

## Task 7: End-to-end gate on test_0003 (the make-or-break)

**Files:** `src/scripts/test_chroma_match.sh`, `test-fixtures/budgets.json` (or a sibling `chroma_budgets.json`).

- [ ] **Step 1:** Build maple-cli (`cargo build --release --bin maple-cli > /tmp/b.log 2>&1`; read the log — no tail pipe). Extract test_0003's embedded JPEG (`maple-cli extract-preview test-fixtures/raws/test_0003.CR2 --out /tmp/t3.png`).
- [ ] **Step 2:** Render `maple-cli batch ... --cases-filter test_0003/baseline --profile auto`.
- [ ] **Step 3:** `chroma_match_diff.py <auto-render> /tmp/t3.png` → record per-zone/per-hue. **Acceptance:** vs the matrices-only baseline, the per-hue chroma error drops materially AND the **highlight-zone chroma does NOT over-saturate** (highlight C\* stays at/below the JPEG, not above — the explicit anti-HSM-collision check). Held-out: fit on half the grid, measure the gate on the other half.
- [ ] **Step 4:** If highlights over-saturate, the taper/`through-AgX` constants need tuning (Task 4) — iterate. If it passes, seed a committed chroma budget.
- [ ] **Step 5: Commit** — `test(scripts): test_0003 chroma-match gate (post-AgX, per-zone, held-out)` + the budget.

---

## Self-review

- **Spec coverage:** solver-through-AgX (Task 4 — the headline-risk fix) ✓; OKLAB correct-per-space + sampling/filter/center-weight (Task 3) ✓; inject-at-decode keep-L (Tasks 1,5) ✓; chroma-then-tone consistency (Task 5) ✓; fallback-to-identity (Task 5) ✓; post-AgX/per-zone/held-out gate (Tasks 6,7) ✓; in-memory cache (Task 5) ✓; `--profile neutral` untouched (Task 5 test) ✓. GPU (Phase 2) intentionally absent ✓.
- **Placeholder scan:** Task 4's solver constants (`K`, `λ`, ridge, taper) are explicitly TDD-discovered against a concrete test contract — that is the correct treatment for a numerical solve, not a placeholder. No "TODO"/"handle errors" hand-waves.
- **Type consistency:** `ChromaTransform` fields (`mat/bias/c2/gain/taper_lo/taper_hi`), `forward_post_agx_ab`, `sample_pairs`/`Pair`, `solve_chroma_through_agx` are used consistently across Tasks 1–7. `rec2020_to_oklab`/`oklab_to_rec2020`/`agx::apply` signatures match the verified surfaces.

## Risks / notes for the executor

- **The load-bearing check is Task 7's highlight-no-over-saturation**, not the global mean — that is the exact failure the through-AgX objective + taper exist to prevent. Do not declare success on a global ΔE alone.
- If the damped fixed-point (Task 4) won't converge, fall back to the spec's simpler route: tone-normalize the JPEG (inverse of the #550 tone curve) and fit a linear ridge LSQ — same gate decides.
- No `tail`-piping of `cargo`/long output (watchdog). Run cargo with output to a file and read it.
- This is Phase 1 only. Do not start the Metal/WebGL wiring (#812/#394) — that is Phase 2, a separate per-platform cycle.
