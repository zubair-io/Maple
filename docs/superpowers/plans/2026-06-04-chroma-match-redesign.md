# Chroma-Match Redesign (RFC §3.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On test_0003 (then the full 17-fixture suite), make Maple's `Profile::Auto` raw color measurably closer to **ACR/Camera** than the `Profile::Neutral` (DCP+AgX) baseline — by adding a per-image chroma correction derived from the embedded JPEG. **At runtime the transform is solved from the JPEG alone; ACR is only an offline validation gate, never a runtime input.**

**Architecture:** Three signals combine to reach ACR — **DCP** (linear color truth) + **AgX** (all tone) + **embedded JPEG** (per-image chroma intent). The chroma correction is a per-image transform on OKLAB `(a,b)`, solved _through_ AgX, applied post-DCP / pre-AgX on the shared scene-linear buffer (so it rides to every platform). This redesign replaces the Phase-1 root-polynomial solver with a **linear 2×2** map + a global damping `k` + a tone-weighted highlight taper. **The JPEG is the only runtime signal.** `k` and the taper are conservative baked-in defaults; **ACR is an offline gate that validates them (beats Neutral, no overshoot) — it never defines them and is never touched at runtime.**

**Tech Stack:** Rust (`raw-core`), `maple-cli` for deterministic renders, Python (`compare_images.py` / `chroma_match_diff.py`) for ACR metrics. Spec: [`2026-06-04-chroma-match-redesign-design.md`](../specs/2026-06-04-chroma-match-redesign-design.md).

---

## What is the goal (measured target, test_0003 vs ACR)

| zone                               | ACR (target) | Neutral (today)  | Phase-1 Auto (today, on main) |
| ---------------------------------- | ------------ | ---------------- | ----------------------------- |
| mid C\*                            | **11.4**     | 5.0 (undershoot) | 16.1 (overshoot)              |
| highlight C\*                      | **9.2**      | 6.9              | 14.6 (+5.4 over)              |
| aggregate chroma_dev               | —            | 6.73             | 8.24 (worse than neutral)     |
| near-neutral false chroma (C\*>15) | —            | 3.3%             | 10.7% (the blotches)          |

Land `Profile::Auto` on the ACR column: mid ≈ 11, highlight ≤ ACR, false-chroma ≈ neutral, and **aggregate ACR error below Neutral's across the 17-fixture suite.**

## What is not working (root cause, measured)

1. **Wrong calibration target.** The Phase-1 solver minimizes distance to the _JPEG_, gated by `chroma_match_diff.py` (vs JPEG). The JPEG runs hotter than ACR, so even a perfect solve overshoots. The real gate (`test_color_pipeline.sh`, vs ACR) never runs on `Profile::Auto`, so the regression went unseen.
2. **Root-polynomial `√|a|` terms** (`map_ab`, `chroma_features`) have unbounded derivative at the neutral axis → applied per-pixel they amplify near-neutral noise into false chroma (the blotches). Convergence is clean (traced), so the √ buys nothing the linear form can't.
3. **The highlight taper is never engaged** (`solve_chroma_from_preview` leaves `taper_lo/hi` at their inert 2.0/3.0) → highlights uncontrolled.

## What needs to change

- Drop the root-poly → **linear 2×2** (also drop `bias`/`c2`/`gain`: a bias term shifts the neutral axis = casts; the trace showed bias ≈ 0.002, negligible). Neutral `(0,0)` → `(0,0)` is now guaranteed.
- Damp the solved matrix toward identity by a global **`k`**, fit against ACR.
- **Engage** the taper on **scene-linear V** (max channel — tracks AgX path-to-white), window fit against ACR.
- Put **ACR in the loop**: gate `Profile::Auto` against ACR so this can't silently regress again; add a near-neutral false-chroma regression check.

## File structure

| File                                                                    | Change                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/raw-pipeline/raw-core/src/view/auto_profile/chroma.rs`             | `ChromaTransform`→linear-only; `chroma_features`/`ridge_solve_channel`/`transform_from_coeffs`→2-feature; `map_ab`/`apply_to_scene`→linear + scene-V taper; `solve_chroma_from_preview`→apply `k` + engage taper; drop `MAPLE_CHROMA_LINEAR_ONLY` |
| `src/raw-pipeline/raw-core/src/view/auto_profile/chroma.rs` (tests mod) | update literals; add neutral-preservation + k + taper tests                                                                                                                                                                                       |
| `src/scripts/calibrate_chroma_k.sh` (new)                               | sweep `k` against ACR over the 17 fixtures, report the minimizer                                                                                                                                                                                  |
| `src/scripts/chroma_false_color.py` (new)                               | near-neutral false-chroma metric (regression guard)                                                                                                                                                                                               |
| `test-fixtures/references/manifest.json` + `budgets.json`               | add `*/baseline` **Auto-profile** gate cases                                                                                                                                                                                                      |
| `src/scripts/test_color_pipeline.sh`                                    | run an Auto-profile pass against ACR (process fix)                                                                                                                                                                                                |

---

## Task 0: Branch + safety

**Files:** none (git)

- [ ] **Step 1:** Branch off `main` (the broken Phase-1 matcher is on main; the redesign replaces it via PR).

```bash
git checkout -b chroma-redesign-§3.2
```

- [ ] **Step 2:** Confirm baseline state — record current `Profile::Auto` ACR error so we can prove improvement.

```bash
cd src/raw-pipeline && cargo build --release --bin maple-cli
# (uses the diag renders already under ~/Desktop/maple-color-tests/chroma-diag/)
```

Expected: build OK. _(Per CLAUDE.md a ticket is opened before the PR; `gh issue create` → add to Files board.)_

---

## Task 1: Reduce the transform to linear 2×2 (drop √, bias, gain)

**Files:**

- Modify: `src/raw-pipeline/raw-core/src/view/auto_profile/chroma.rs` (struct, `map_ab`, `apply_to_scene`, `chroma_features`, `ridge_solve_channel`, `transform_from_coeffs`, solver loop, `forward_post_agx_ab`)
- Test: same file's `#[cfg(test)] mod tests`

- [ ] **Step 1: Add the failing neutral-preservation test.** A linear map with no bias must keep gray exactly gray, and must not amplify a tiny near-neutral perturbation (the √ defect).

```rust
#[test]
fn linear_map_preserves_neutral_and_is_bounded() {
    // A non-trivial solved-style transform.
    let t = ChromaTransform { mat: [[1.4, -0.3], [0.2, 1.5]], taper_lo: 2.0, taper_hi: 3.0 };
    // Gray (a=b=0) must map to gray — no neutral-axis cast.
    assert_eq!(t.map_ab(0.0, 0.0), (0.0, 0.0));
    // Tiny near-neutral perturbation stays bounded by the linear gain (no √ blowup).
    let (a, b) = t.map_ab(1e-4, 0.0);
    assert!(a.hypot(b) < 1e-3, "near-neutral output {a},{b} not bounded — root-poly still present");
}
```

- [ ] **Step 2: Run — expect FAIL to compile** (`mat`-only literal won't match the current struct with `bias`/`c2`/`gain`).

```bash
cd src/raw-pipeline && cargo test -p raw-core --lib auto_profile::chroma::tests::linear_map_preserves
```

Expected: compile error (struct fields mismatch) — confirms the struct still carries the dropped fields.

- [ ] **Step 3: Slim the struct + identity.**

```rust
/// A linear chroma map on (a,b) plus a value-aware highlight taper. `mat` is the
/// 2×2 linear term (neutral-preserving: (0,0)→(0,0)); `taper_lo`/`taper_hi`
/// attenuate toward identity as scene-linear V (max channel) rises.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChromaTransform {
    pub mat: [[f32; 2]; 2],
    pub taper_lo: f32,
    pub taper_hi: f32,
}
impl ChromaTransform {
    pub fn identity() -> Self {
        Self { mat: [[1.0, 0.0], [0.0, 1.0]], taper_lo: 2.0, taper_hi: 3.0 }
    }
    pub fn map_ab(&self, a: f32, b: f32) -> (f32, f32) {
        (self.mat[0][0] * a + self.mat[0][1] * b,
         self.mat[1][0] * a + self.mat[1][1] * b)
    }
```

- [ ] **Step 4: Rewrite `apply_to_scene` — linear map + scene-V taper axis** (was OKLAB L, the live bug).

```rust
    pub fn apply_to_scene(&self, img: &mut Image) {
        img.pixels.par_iter_mut().for_each(|p| {
            if p[0] < 0.0 || p[1] < 0.0 || p[2] < 0.0 { return; }
            let v = p[0].max(p[1]).max(p[2]); // scene-linear value — tracks AgX path-to-white
            let lab = rec2020_to_oklab(*p);
            let (ta, tb) = self.map_ab(lab[1], lab[2]);
            let t = ((v - self.taper_lo) / (self.taper_hi - self.taper_lo)).clamp(0.0, 1.0);
            let att = t * t * (3.0 - 2.0 * t); // smoothstep
            let na = lab[1] + (ta - lab[1]) * (1.0 - att);
            let nb = lab[2] + (tb - lab[2]) * (1.0 - att);
            *p = oklab_to_rec2020([lab[0], na, nb]);
        });
    }
}
```

- [ ] **Step 5: Make the solve linear** — 2-feature everywhere.

```rust
fn chroma_features(a: f32, b: f32) -> [f32; 2] { [a, b] }

fn transform_from_coeffs(ca: [f32; 2], cb: [f32; 2]) -> ChromaTransform {
    ChromaTransform { mat: [[ca[0], ca[1]], [cb[0], cb[1]]], taper_lo: 2.0, taper_hi: 3.0 }
}
```

In `ridge_solve_channel`: change `[f32; 5]`→`[f32; 2]`, `[[0.0f64; 5]; 5]`→`[[0.0f64; 2]; 2]`, all `0..5`→`0..2`. In `solve_chroma_through_agx_with_ridge`: `c0_a = [1.0, 0.0]`, `c0_b = [0.0, 1.0]`; `feats: Vec<[f32; 2]>`; drop the `|c2|`/`|bias|` terms from the `MAPLE_CHROMA_TRACE` line (keep `|mat-I|`). Update `forward_post_agx_ab` only if it built a literal `ChromaTransform` (it uses `apply_to_scene`, so likely no change). Delete the `MAPLE_CHROMA_LINEAR_ONLY` branch in `transform_from_coeffs`.

- [ ] **Step 6: Fix test literals + the recovery test.** Update every `ChromaTransform { … }` literal in the tests to the 3-field form. If `solver_recovers_known_shift_through_agx_held_out` builds its known target with an additive **bias**, change the known transform to a 2×2 (e.g. `mat: [[1.3,0.0],[0.0,1.3]]` — a saturation scale) so it's expressible by the linear model.

- [ ] **Step 7: Run the whole chroma suite — expect PASS.**

```bash
cd src/raw-pipeline && cargo test -p raw-core --lib auto_profile::chroma
```

Expected: all pass, including `linear_map_preserves_neutral_and_is_bounded`, `solver_recovers_known_shift…`, `solver_ridge_suppresses_sparse_hue_blowup`.

- [ ] **Step 8: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/view/auto_profile/chroma.rs
git commit -m "refactor(raw-core): linear 2x2 chroma transform (drop root-poly/bias) — kills neutral-axis blotching"
```

---

## Task 2: Global ACR-damping `k`

**Files:** Modify `chroma.rs` (`solve_chroma_from_preview` + new const)

- [ ] **Step 1: Failing test** — damping a solved matrix toward identity by `k`.

```rust
#[test]
fn damping_lerps_matrix_toward_identity() {
    let solved = ChromaTransform { mat: [[1.5, 0.2], [-0.1, 1.4]], taper_lo: 2.0, taper_hi: 3.0 };
    let d = damp_toward_identity(solved, 0.5);
    assert!((d.mat[0][0] - 1.25).abs() < 1e-6); // (1-0.5)*1.0 + 0.5*1.5
    assert!((d.mat[0][1] - 0.10).abs() < 1e-6); // (1-0.5)*0.0 + 0.5*0.2
    assert_eq!(damp_toward_identity(solved, 0.0), ChromaTransform::identity_mat_only(solved));
}
```

- [ ] **Step 2: Run — expect FAIL** (`damp_toward_identity` undefined). `cargo test -p raw-core --lib auto_profile::chroma::tests::damping_lerps`

- [ ] **Step 3: Implement.**

```rust
/// JPEG→ACR strength. The embedded JPEG's chroma direction tracks ACR (corr
/// +0.84) but overshoots its magnitude, so the solved transform is damped
/// toward identity by `k`, fit against ACR (calibrate_chroma_k.sh). Codegen
/// const so Rust/Swift/TS agree.
const CHROMA_STRENGTH: f32 = 0.6; // starting bracket; replaced by Task 4's ACR fit

fn damp_toward_identity(mut t: ChromaTransform, k: f32) -> ChromaTransform {
    for i in 0..2 {
        for j in 0..2 {
            let ident = if i == j { 1.0 } else { 0.0 };
            t.mat[i][j] = (1.0 - k) * ident + k * t.mat[i][j];
        }
    }
    t
}
```

In `solve_chroma_from_preview`, replace `Some(solve_chroma_through_agx(&pairs, contrast))` with:

```rust
    let solved = solve_chroma_through_agx(&pairs, contrast);
    Some(damp_toward_identity(solved, CHROMA_STRENGTH))
```

- [ ] **Step 4: Run — expect PASS.** **Step 5: Commit** `feat(raw-core): ACR-fit global damping k on the chroma transform`.

---

## Task 3: Engage the highlight taper

**Files:** Modify `chroma.rs` (`solve_chroma_from_preview` + consts)

- [ ] **Step 1: Failing test** — high-V pixels keep more of their original chroma than mid-V pixels.

```rust
#[test]
fn taper_attenuates_highlights_not_mids() {
    let t = ChromaTransform { mat: [[1.6, 0.0], [0.0, 1.6]], taper_lo: 0.35, taper_hi: 0.7 };
    let mid = one_px([0.18, 0.10, 0.10]);   // V=0.18 < taper_lo → full correction
    let hi  = one_px([0.95, 0.80, 0.80]);   // V=0.95 > taper_hi → identity
    let mut m = mid.clone(); t.apply_to_scene(&mut m);
    let mut h = hi.clone();  t.apply_to_scene(&mut h);
    let dc = |a: &Image, b: &Image| {
        let la = rec2020_to_oklab(a.pixels[0]); let lb = rec2020_to_oklab(b.pixels[0]);
        (la[1]-lb[1]).hypot(la[2]-lb[2])
    };
    assert!(dc(&mid, &m) > dc(&hi, &h) + 1e-3, "highlight not attenuated relative to mid");
    assert!(dc(&hi, &h) < 1e-4, "highlight should be ~untouched");
}
```

- [ ] **Step 2: Run — expect FAIL** (taper not engaged; `solve_chroma_from_preview` returns inert 2.0/3.0). Note this test exercises `apply_to_scene` directly so it passes once the axis is scene-V (Task 1) and the literal sets the window — it guards the _axis+window_, while Task 5 fits the production consts.

- [ ] **Step 3: Wire production consts.** Add and apply in `solve_chroma_from_preview` (after damping):

```rust
const CHROMA_TAPER_LO: f32 = 0.35; // scene-V; replaced by Task 5's ACR fit
const CHROMA_TAPER_HI: f32 = 0.70;
...
    let mut t = damp_toward_identity(solved, CHROMA_STRENGTH);
    t.taper_lo = CHROMA_TAPER_LO;
    t.taper_hi = CHROMA_TAPER_HI;
    Some(t)
```

- [ ] **Step 4: Run — expect PASS.** **Step 5: Commit** `feat(raw-core): engage scene-V highlight taper on chroma transform`.

---

## Task 4: Choose a conservative `k` default, validate against the offline ACR gate

`k` is a baked-in default, **not** an ACR-minimized fit. We explore offline to pick a robust value, then the gate (Task 7) validates it. ACR never enters runtime.

**Files:** Create `src/scripts/explore_chroma_k.sh` (dev-only, not shipped)

- [ ] **Step 1: Explore `k` on the fixtures.** Add a dev-only `MAPLE_CHROMA_STRENGTH_OVERRIDE` env read in `solve_chroma_from_preview` (inert when unset). For k ∈ {0.3…0.8}, render the RAW+ACR fixtures with `--profile auto` and report each k's aggregate mid-zone `|render_C* − ACR_C*|` **and** highlight `C_over`.

```bash
#!/usr/bin/env bash
set -euo pipefail
BIN=src/raw-pipeline/target/release/maple-cli
for k in 0.3 0.4 0.5 0.6 0.7 0.8; do
  MAPLE_CHROMA_STRENGTH_OVERRIDE=$k python3 src/scripts/_chroma_acr_explore.py "$BIN" "$k"
done
```

(`_chroma_acr_explore.py`: per fixture, `maple-cli render --profile auto`, mid-zone `|render_C* − ACR_C*|` + highlight `C_over` vs `test-fixtures/references/<fx>/down/baseline.png`.)

- [ ] **Step 2: Pick a conservative default.** Choose `k` at/just below where Auto stops improving on Neutral and before highlight `C_over` climbs — favour under- over over-correction (Neutral is the safe fallback). A robust default, not a knife-edge optimum.

- [ ] **Step 3:** Set `CHROMA_STRENGTH` to that default; regenerate the codegen const (`src/scripts/codegen/`) so Swift/TS match. Remove the `_OVERRIDE` env read; the dev script stays out of the shipped build.

- [ ] **Step 4: Commit** `feat(raw-core): chroma strength k=<value> default (ACR-gate validated)`.

---

## Task 5: Choose the taper (axis + window) default, validate against the offline ACR gate

Same principle as `k`: explore offline to pick a sensible default; the gate validates it (the taper's job is "don't overshoot highlights"). Defaults, not ACR-fit values.

**Files:** extend `explore_chroma_k.sh` (or a sibling, dev-only) to sweep taper

- [ ] **Step 1:** With `k` fixed, explore `taper_lo ∈ {0.25,0.35,0.45}`, `taper_hi ∈ {0.55,0.7,0.85}` (via env overrides), V-axis vs a Y-axis variant. Report per-fixture mid-zone C\* gain and highlight `C_over` vs ACR.
- [ ] **Step 2: Pick** the axis + window where the mids stay corrected and **highlight `C_over ≤ 0`** across the suite (favour the simpler/robust window). If only one axis can hold the highlight constraint, the loser is dropped with a one-line note in the spec.
- [ ] **Step 3:** Set `CHROMA_TAPER_LO/HI` (+ axis if Y wins — swap the `v =` line). **Step 4: Commit** `feat(raw-core): chroma taper defaults (ACR-gate validated)`.

---

## Task 6: Near-neutral false-chroma regression guard

**Files:** Create `src/scripts/chroma_false_color.py`; add a fixture assertion

- [ ] **Step 1:** Script: given a render PNG + the embedded JPEG, report the % of JPEG-near-neutral (`jpeg C*<5`) pixels with render `C*>15` (the blotch metric — neutral ≈ 3.3%, Phase-1 was 10.7%).
- [ ] **Step 2:** Add a check (in `test_color_pipeline.sh` or a small harness) asserting test_0003 Auto stays **≤ 5%**. Run; expect PASS post-Task 1. **Step 3: Commit.**

---

## Task 7: Gate `Profile::Auto` against ACR (the process fix)

**Files:** `test-fixtures/references/manifest.json`, `budgets.json`, `src/scripts/test_color_pipeline.sh`

- [ ] **Step 1:** Add an Auto-profile pass: run the `*/baseline` cases with `--profile auto` and diff vs the ACR `baseline.png` (the deterministic cases keep `--profile neutral`). This is what was missing — Auto was never ACR-gated.
- [ ] **Step 2:** Capture the post-redesign numbers, seed `budgets.json` Auto entries at ~5–10% above them (one-way ratchet thereafter). Run the full gate; expect PASS.
- [ ] **Step 3: Commit** `test(color): gate Profile::Auto chroma against ACR references`.

---

## Final verification

- [ ] `cargo test -p raw-core --lib` green; `src/scripts/test_color_pipeline.sh` green (Neutral **and** Auto).
- [ ] test_0003 Auto: mid C\* ≈ 11 (±1.5), highlight `C_over ≤ 0`, false-chroma ≤ 5%, aggregate ACR error < Neutral.
- [ ] Re-render the diag montage (`montage_crop.png`) — the √ panel's blotching gone.
- [ ] Open PR (`Closes #<ticket>`), ready-for-review.

## Self-review notes

- Spec coverage: drop-√ (T1), k (T2/T4), taper (T3/T5), false-chroma guard (T6), ACR gate (T7), no-JPEG fallback (unchanged — `MIN_SOLVE_PAIRS`). ✓
- Open risk carried forward: if T4 shows no `k` beats Neutral, or T5 can't hit mid≈11 under the `C_over≤0` constraint, **stop** — the stable linear form can't reach ACR and the transform needs smooth higher-order structure (not √). That decision is data-gated, not assumed.
