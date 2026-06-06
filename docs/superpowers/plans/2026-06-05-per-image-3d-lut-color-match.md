# Per-Image 3D LUT Color Match — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the per-pixel chroma grid and the #550 per-channel curve with a single robust per-image 3D RGB→RGB LUT, fit from the embedded JPEG in display space, that is blotch-free by construction and at least matches #550's ΔE.

**Architecture:** New `ColorLut` (Nᶟ RGB→RGB grid, trilinear apply). Fit by refactoring #550's JPEG↔Maple display-pair sampling into a shared function, then a **local confidence-weighted + identity-fallback + grid-smoothed** fit (no global overshoot). Reuses #550's JPEG extraction / orientation / color-space decode / cache / GPU bake-layout. Wired into the render display tail in place of `apply_curve`; the pre-AgX chroma stage is removed.

**Tech Stack:** Rust (`raw-core`), existing `view/auto_profile/` modules, `rayon` for the parallel apply.

Design of record: `docs/superpowers/specs/2026-06-05-per-image-3d-lut-color-match-design.md`.

---

## File Structure

- **Create** `src/raw-pipeline/raw-core/src/view/auto_profile/lut.rs` — `ColorLut` type, `identity`, trilinear `apply`, `fit_lut_from_pairs`, and the `fit_lut_from_raw_display` / `fit_lut_from_bytes_display` entry points. One responsibility: the per-image color LUT.
- **Create** `src/raw-pipeline/raw-core/src/view/auto_profile/pairs.rs` — `DisplayPair { maple: [f32;3], jpeg: [f32;3] }` and `sample_display_pairs(...)`, refactored out of `fit_display.rs`. One responsibility: build aligned JPEG↔Maple display correspondences.
- **Modify** `fit_display.rs` — call the new `pairs::sample_display_pairs` instead of its inlined cropping/decode/footprint logic (keeps #550 building, no behavior change).
- **Modify** `cache.rs` — store `ColorLut` (or a parallel LUT cache) instead of `ProfileCurve`.
- **Modify** `mod.rs` (auto_profile) — export `lut`, `pairs`.
- **Modify** `pipeline/render/mod.rs` — remove the pre-AgX `chroma_match` call; replace the `apply_curve` calls with `lut::apply`; update the GPU fit entry to return a LUT.
- **Reuse unchanged**: `preview.rs` (extract/orient/colorspace), `bake.rs` (LUT grid layout constants).

---

## Task 1: `ColorLut` type + trilinear apply

**Files:** Create `view/auto_profile/lut.rs`; Test: inline `#[cfg(test)]` in `lut.rs`.

- [ ] **Step 1 — failing test (identity is a no-op + a known shift maps).**
```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_lut_is_noop() {
        let lut = ColorLut::identity(17);
        let mut px = vec![0.2f32, 0.5, 0.8, 0.0, 1.0, 0.33];
        let before = px.clone();
        lut.apply(&mut px);
        for (a, b) in px.iter().zip(&before) { assert!((a - b).abs() < 1e-4, "{a} vs {b}"); }
    }
    #[test]
    fn trilinear_recovers_node_values() {
        // A LUT that adds +0.1 to red everywhere: sampling at a node returns node+shift.
        let mut lut = ColorLut::identity(9);
        for n in lut.data.chunks_mut(3) { n[0] = (n[0] + 0.1).min(1.0); }
        let mut px = vec![0.5f32, 0.5, 0.5];
        lut.apply(&mut px);
        assert!((px[0] - 0.6).abs() < 1e-3, "got {}", px[0]);
        assert!((px[1] - 0.5).abs() < 1e-3);
    }
}
```
- [ ] **Step 2 — run, expect FAIL** (`cargo test -p raw-core --lib lut::`).
- [ ] **Step 3 — implement.**
```rust
//! Per-image color LUT: a smooth Nᶟ RGB→RGB grid applied by trilinear interpolation.
//! Value-keyed (no atan2 / ÷L) + smooth ⇒ spatially coherent (cannot blotch).
use rayon::prelude::*;

/// Grid layout matches `bake.rs`: index = ((b*N + g)*N + r)*3 + c, values in [0,1].
#[derive(Clone, Debug, PartialEq)]
pub struct ColorLut { pub size: usize, pub data: Vec<f32> }

impl ColorLut {
    pub fn identity(size: usize) -> Self {
        let n = size.max(2);
        let mut data = vec![0.0f32; n * n * n * 3];
        let denom = (n - 1) as f32;
        for b in 0..n { for g in 0..n { for r in 0..n {
            let i = ((b * n + g) * n + r) * 3;
            data[i] = r as f32 / denom; data[i+1] = g as f32 / denom; data[i+2] = b as f32 / denom;
        }}}
        Self { size: n, data }
    }
    #[inline]
    fn node(&self, r: usize, g: usize, b: usize) -> [f32; 3] {
        let n = self.size; let i = ((b * n + g) * n + r) * 3;
        [self.data[i], self.data[i+1], self.data[i+2]]
    }
    /// Trilinear lookup of one RGB triplet (inputs clamped to [0,1]).
    pub fn sample(&self, rgb: [f32; 3]) -> [f32; 3] {
        let n = self.size; let last = (n - 1) as f32;
        let mut lo = [0usize; 3]; let mut f = [0f32; 3];
        for c in 0..3 {
            let p = rgb[c].clamp(0.0, 1.0) * last;
            let l = p.floor().min(last - 1.0);
            lo[c] = l as usize; f[c] = p - l;
        }
        let mut out = [0f32; 3];
        for c in 0..3 {
            let c000 = self.node(lo[0],   lo[1],   lo[2])[c];
            let c100 = self.node(lo[0]+1, lo[1],   lo[2])[c];
            let c010 = self.node(lo[0],   lo[1]+1, lo[2])[c];
            let c110 = self.node(lo[0]+1, lo[1]+1, lo[2])[c];
            let c001 = self.node(lo[0],   lo[1],   lo[2]+1)[c];
            let c101 = self.node(lo[0]+1, lo[1],   lo[2]+1)[c];
            let c011 = self.node(lo[0],   lo[1]+1, lo[2]+1)[c];
            let c111 = self.node(lo[0]+1, lo[1]+1, lo[2]+1)[c];
            let c00 = c000*(1.0-f[0]) + c100*f[0];
            let c10 = c010*(1.0-f[0]) + c110*f[0];
            let c01 = c001*(1.0-f[0]) + c101*f[0];
            let c11 = c011*(1.0-f[0]) + c111*f[0];
            let c0 = c00*(1.0-f[1]) + c10*f[1];
            let c1 = c01*(1.0-f[1]) + c11*f[1];
            out[c] = c0*(1.0-f[2]) + c1*f[2];
        }
        out
    }
    /// Apply in place to an interleaved RGB f32 buffer (DisplayEncodedSrgb, [0,1]).
    pub fn apply(&self, rgb: &mut [f32]) {
        rgb.par_chunks_mut(3).for_each(|p| {
            let o = self.sample([p[0], p[1], p[2]]);
            p[0] = o[0]; p[1] = o[1]; p[2] = o[2];
        });
    }
}
```
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `feat(raw-core): ColorLut type + trilinear apply (#NNN)`.

---

## Task 2: Shared `sample_display_pairs` for the LUT (leave #550's solve intact)

**Files:** Create `view/auto_profile/pairs.rs`; Modify `preview.rs` (extract a shared JPEG→display-sRGB decode helper); export in `mod.rs`. **Do NOT change #550's per-channel solve** — `fit_curve_from_preview_display`'s `build_design_matrices`/band-target path stays exactly as-is and is removed later in Task 5.

**Why not refactor #550 to use the pairs:** #550's design matrix distributes each source pixel across two curve anchors with sub-pixel weights (`solve::build_design_matrices`) — strictly finer than footprint-mean pairs. Re-deriving its targets from mean pairs would change #550's output. The LUT only needs representative `(maple_rgb, jpeg_rgb)` pairs (footprint mean is fine), so share just the pure decode and reimplement the small crop/footprint-mean pairing.

- [ ] **Step 1 — failing test** (`pairs.rs`): a synthetic 4×4 source + 2×2 preview with known aspect produces 4 pairs whose maple values equal the footprint means. (Tiny `DynamicImage` + f32 source; assert pair count + a known averaged value.)
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3a — extract the decode helper.** Pull the Adobe-aware JPEG→display-sRGB-f32 conversion (currently inlined `fit_display.rs:139-160`) into a pure fn in `preview.rs`, e.g. `decode_jpeg_pixel_to_srgb(rgb01: [f32;3], cs: JpegColorSpace) -> [f32;3]`. Have #550's `fit_curve_from_preview_display` call it — it produces identical values, so #550 stays byte-identical.
- [ ] **Step 3b — implement** `pairs::sample_display_pairs`:
```rust
pub struct DisplayPair { pub maple: [f32; 3], pub jpeg: [f32; 3] }

/// Build display-space JPEG↔Maple correspondences. `source_rgb` is the developed
/// DisplayEncodedSrgb buffer (sensor-oriented); `preview` is the embedded JPEG
/// (sensor-oriented). Both are oriented to display, aspect-matched, 10%-border-
/// cropped; each output pixel pairs the footprint-MEAN source RGB with the JPEG
/// pixel (decoded via the shared `preview::decode_jpeg_pixel_to_srgb`).
pub fn sample_display_pairs(
    source_rgb: &[f32], source_w: usize, source_h: usize,
    preview: image::DynamicImage, cs: super::preview::JpegColorSpace,
    orientation: crate::image::ExifOrientation,
) -> Vec<DisplayPair>
```
Reuse `preview::orient_preview_to_display`, `solve::footprint_sizes`, and the new decode helper; reimplement the aspect-crop + 10%-border + footprint-mean loop (do not touch #550's fit body beyond the decode-helper swap).
- [ ] **Step 4 — run the full suite** (`cargo test -p raw-core --lib`). #550's `fit_display`/`solve` tests + the new pairs test all green.
- [ ] **Step 5 — verify #550 byte-parity** on one fixture: render test_0003 `--profile auto` before/after (git stash), `compare_images.py` mean ΔE ≈ 0 (only the decode-helper extraction touched #550). Commit `refactor(raw-core): shared JPEG decode + sample_display_pairs (#NNN)`.

---

## Task 3: `fit_lut_from_pairs` — the robust local fit

**Files:** `lut.rs`; Test: inline.

- [ ] **Step 1 — failing tests.**
```rust
#[test]
fn sparse_pairs_stay_identity() {
    // One pair far from a node leaves distant nodes at identity.
    let pairs = vec![DisplayPair{ maple:[0.5,0.5,0.5], jpeg:[0.5,0.5,0.5] }];
    let lut = fit_lut_from_pairs(&pairs, 9, 1.0);
    let id = ColorLut::identity(9);
    assert!((lut.node(0,0,0)[0] - id.node(0,0,0)[0]).abs() < 1e-3);
}
#[test]
fn recovers_uniform_shift() {
    // Pairs that all add +0.1 red → LUT maps mid-grey toward +0.1 red.
    let pairs: Vec<_> = (0..200).map(|i|{ let v=i as f32/199.0;
        DisplayPair{ maple:[v,v,v], jpeg:[(v+0.1).min(1.0),v,v] }}).collect();
    let lut = fit_lut_from_pairs(&pairs, 9, 1.0);
    let mut px = vec![0.5f32,0.5,0.5]; lut.apply(&mut px);
    assert!(px[0] > 0.55, "red not boosted: {}", px[0]);
    assert!((px[1]-0.5).abs() < 0.03 && (px[2]-0.5).abs() < 0.03, "green/blue drifted");
}
```
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** per the spec §"The LUT" fit:
```rust
const SIGMA: f32 = 0.18;       // RBF radius in RGB units
const REG: f32 = 4.0;          // confidence reg: c = Σw/(Σw+REG·node_volume)
const SMOOTH_PASSES: usize = 1; // separable 3D box smooth of the delta grid

pub fn fit_lut_from_pairs(pairs: &[DisplayPair], size: usize, strength: f32) -> ColorLut {
    let n = size.max(2); let last = (n-1) as f32;
    let id = ColorLut::identity(n);
    if pairs.is_empty() { return id; }
    // Per-node confidence-weighted delta toward identity.
    let mut delta = vec![[0f32;3]; n*n*n];
    let two_s2 = 2.0 * SIGMA * SIGMA;
    for b in 0..n { for g in 0..n { for r in 0..n {
        let p = [r as f32/last, g as f32/last, b as f32/last];
        let (mut wsum, mut acc) = (0f32, [0f32;3]);
        for pr in pairs {
            let d2 = (pr.maple[0]-p[0]).powi(2)+(pr.maple[1]-p[1]).powi(2)+(pr.maple[2]-p[2]).powi(2);
            let w = (-d2/two_s2).exp();
            wsum += w;
            for c in 0..3 { acc[c] += w*(pr.jpeg[c]-pr.maple[c]); }
        }
        let idx = (b*n+g)*n+r;
        if wsum > 1e-6 {
            let c = wsum/(wsum+REG);              // sparse → 0 → identity
            for k in 0..3 { delta[idx][k] = c*(acc[k]/wsum); }
        }
    }}}
    // Separable 3D smoothing of the delta grid for coherence.
    for _ in 0..SMOOTH_PASSES { smooth3(&mut delta, n); }
    // Compose onto identity, apply strength, clamp.
    let mut lut = id.clone();
    for i in 0..n*n*n { for c in 0..3 {
        lut.data[i*3+c] = (lut.data[i*3+c] + strength*delta[i][c]).clamp(0.0, 1.0);
    }}
    lut
}
```
Implement `smooth3` (a 1-2-1 separable pass over r, then g, then b, identity at the borders).
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `feat(raw-core): robust local 3D LUT fit (#NNN)`.

---

## Task 4: Fit entry points + cache

**Files:** `lut.rs` (entries), `cache.rs` (store `ColorLut`), `mod.rs`.

- [ ] **Step 1 — implement** `fit_lut_from_raw_display` / `fit_lut_from_bytes_display`, mirroring `fit_curve_from_raw_display` (`fit_display.rs:86`) but calling `pairs::sample_display_pairs` + `fit_lut_from_pairs`:
```rust
pub fn fit_lut_from_raw_display<P: AsRef<Path>>(
    raw_path: P, source_rgb: &[f32], w: usize, h: usize, orientation: ExifOrientation,
) -> Option<ColorLut> {
    let preview = preview::extract_preview(&raw_path)?;
    let cs = preview::detect_jpeg_color_space(&raw_path);
    let pairs = pairs::sample_display_pairs(source_rgb, w, h, preview, cs, orientation);
    if pairs.len() < MIN_LUT_PAIRS { return None; }      // else Neutral fallback
    // Strength env override mirrors the old MAPLE_CHROMA_STRENGTH_OVERRIDE so the
    // verify step (Task 6) can render LUT-off (k=0 = identity) vs LUT-on (k=1).
    let k = std::env::var("MAPLE_AUTO_LUT_STRENGTH").ok()
        .and_then(|s| s.parse().ok()).unwrap_or(1.0f32);
    Some(fit_lut_from_pairs(&pairs, LUT_SIZE, k))         // LUT_SIZE = 17
}
```
(Bytes variant uses `extract_preview_from_bytes` + `detect_jpeg_color_space_from_bytes`.)
- [ ] **Step 2 — cache:** change `cache.rs` to cache `ColorLut` (value type swap; key logic `from_path`/`from_bytes` unchanged). Add a `get`/`insert` for `ColorLut` (or generic).
- [ ] **Step 3 — test:** fit a LUT from a fixture's pairs is `Some`, identity-applies cleanly, and a cache round-trip returns an equal LUT.
- [ ] **Step 4 — run + commit** `feat(raw-core): LUT fit entries + cache (#NNN)`.

---

## Task 5: Wire into the render path (remove grid, replace curve)

**Files:** `pipeline/render/mod.rs`.

- [ ] **Step 1 — remove the pre-AgX chroma stage** (mod.rs:151-179): delete the `if model.profile == Profile::Auto { … solve_chroma_for_* … apply_to_scene … }` block.
- [ ] **Step 2 — replace `apply_curve` with the LUT** at both Auto sites (mod.rs:208-239 Path, 240-261 Bytes): fit-or-cached `ColorLut` via `auto_profile::lut::fit_lut_from_raw_display`/`_bytes_display` + `cache::get_lut`/`insert_lut`, then `lut.apply(pixels)`. Update the `auto_will_fit` block (mod.rs:107-129) to look up `cache::get_lut` instead of `cache::get` (the `cached_curve` → `cached_lut` rename) so the AE-off gate still triggers on a cache hit. Keep `assert_space(DisplayEncodedSrgb)`. Keep the AE-off gate (mod.rs:85-149) — the LUT owns the display mapping, same as the curve. Rename the POC env gate `MAPLE_DISABLE_AUTO_CURVE` → `MAPLE_DISABLE_AUTO_LUT` (skip apply + keep AE-on).
- [ ] **Step 3 — LEAVE the GPU fit entry** (`fit_profile_curve_from_raw`, mod.rs:319-367) untouched. GPU LUT migration is out of scope (spec); keeping it means #550's fit (`fit_curve_*`, `solve`, `apply_curve`, `bake`) stays a live GPU-path (no dead-code churn, no raw-ffi breakage). The CPU render path no longer references the `ProfileCurve` cache — that's fine (it stays for the GPU entry's potential cache use).
- [ ] **Step 4 — build** `cd src/raw-pipeline && cargo build --release --bin maple-cli` (no `tail` piping). Confirm clean (allow/expect that `apply_curve`/`bake_profile_lut` may now be unused-but-`pub` — no warning; if any private item goes unused, gate with `#[allow(dead_code)]` + a `// GPU path, #NNN` note rather than deleting).
- [ ] **Step 5 — smoke test + commit:** render test_0003 `--profile auto` (`maple-cli render`) — confirm it produces a valid PNG and does NOT panic on the `assert_space`/cache paths. Commit `feat(raw-core): wire per-image 3D LUT into Profile::Auto, drop chroma grid (#NNN)`.

---

## Task 6: Verify — blotch-free + accuracy + no regression

**Files:** none (harness). Uses the session diagnostics under `~/Desktop/maple-color-tests/`.

- [ ] **Step 1 — blotch:** render test_0003 `--profile auto` at `MAPLE_CHROMA_STRENGTH_OVERRIDE` equivalent k=0 (identity) and full; compute per-region local-std of the contribution (forearm/sky/trees) via the `/tmp/blotch_check.py` method. **Expect ≈0** (vs the grid's 6.3/9.0/8.4). View the ×6 amplified diff — no oil-slick.
- [ ] **Step 2 — accuracy:** `compare_images.py` ΔE2000 of `--profile auto` vs `test-fixtures/references/test_0003/down/baseline.png` (ACR) **and** vs the embedded JPEG (extract via `maple-cli extract-preview`). Must not regress vs chroma-off; target ≤ #550's 4.24 on this fixture.
- [ ] **Step 3 — aggregate:** loop the 15 fixtures (the `bz188umk7`-style table): LUT-Auto vs Neutral vs (recorded) #550 column, mean ΔE vs ACR. Target: **≥ match #550's 8.81 aggregate**, no per-fixture catastrophe. Watch test_0000 (DJI) — flag if it inherits #550's blowup.
- [ ] **Step 4 — no Neutral regression:** `src/scripts/test_color_pipeline.sh` (Neutral gate unaffected; confirms nothing else moved).
- [ ] **Step 5 — unit suite:** `cargo test -p raw-core --lib` all green.

---

## Notes / out of scope
- Deleting the now-unused `chroma.rs` TPS code and `math_solver.rs` is a follow-up tidy-up once the LUT is proven (leave dormant this pass).
- GPU (Metal/WebGL) application of the LUT 3D texture is a follow-up (the bake layout is already compatible).
- Spatial/lens RAW↔JPEG alignment ("Gap 2") is unchanged — same sampling as #550.
- Pick the real ticket number for `#NNN` before opening the PR (`Closes #N`).
