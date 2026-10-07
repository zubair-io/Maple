//! Guided tiers of sensor-highlight reconstruction (#1690).
//!
//! Split out of the parent stage to keep that file under the 600-LOC hard
//! budget — the same sibling-submodule pattern as the stage's test modules.
//! Tier 1 (the dense 7×7 pass) stays in the parent; this module holds tiers
//! 2–3, which resolve the pixels tier 1 defers, plus the scene prior. See
//! the parent module docs for the tier contract.
//!
//! Tier 2 works per 16×16 cell rather than per pixel: a clipped region's
//! interior holds thousands of pixels sharing one regional chromaticity, so
//! the estimate is computed once per cell from a strided means field and
//! every deferred pixel in the cell shares it, modulated by its own
//! surviving channels (which carry the per-pixel texture). Per-pixel
//! expanding rings were measured at 34 ms on a 2 MP viewport with a 400 px
//! blown block — 9× the sparse stage budget — where the per-cell field
//! resolves the same workload for ~2 ms of a ~6 ms total.

use crate::image::Image;

/// Tier-2 coarse cell size (px). Cells accumulate unclipped means (the
/// regional field) and, separately, the deferred pixels' known-channel sums
/// per clip mask (the bilateral target).
const CELL: i32 = 16;

/// Sampling stride (px) for the means pass: up to 16 samples per cell,
/// plenty for a regional prior while keeping the pass inside ~1 ms.
const MEANS_STRIDE: i32 = 4;

/// Minimum unclipped samples for a cell to join a gather. Edge cells with
/// fewer samples are too noisy to trust.
const CELL_MIN_SAMPLES: f32 = 4.0;

/// Tier-2 gather radius in cells: 5×5, ≈80 px window, ≈40 px reach.
const GATHER_RADIUS: i32 = 2;

/// Bilateral sharpness K in `w = 1/(1+K·d²)²`, with K = 1/(2σ²) and σ = 0.12
/// per-channel-ratio units. The squared inverse keeps the Gaussian's
/// ~1/~0 behavior at matched/crossed edges without a per-cell `exp`.
const BILATERAL_K: f32 = 34.7;

/// Cell support weight for full confidence. A uniform surround gathers ~25
/// cells at weight ~1, so this saturates quickly; sparse support degrades
/// gracefully toward the scene-aware fallback.
const CELL_WSUM_FULL: f32 = 4.0;

/// Tier-3 blend of the scene-chromaticity estimate into the zero-support
/// fallback: halfway between the neutral anchor and the scene estimate,
/// bounding the error when the global prior misfires. Tier 2 blends toward
/// this same fallback, so the tier-2/tier-3 boundary is continuous.
const SCENE_BLEND: f32 = 0.5;

/// Tier-3 scene sampling grid stride (px) and sample cap. `scene_median`
/// keeps every eligible stride-8 sample when they fit the cap and otherwise
/// decimates them evenly, so the kept set always spans the whole region.
const SCENE_SAMPLE_STRIDE: i32 = 8;
const SCENE_SAMPLE_CAP: usize = 4096;

/// Partial-clip mask count. Deferred pixels carry masks 1..=6 (mask 0 is
/// unclipped, mask 7 fully clipped — neither is ever deferred); the slot is
/// `mask - 1`.
const PARTIAL_MASKS: usize = 6;

/// Tier-1 skip-grid cell size (px). Cells mark 16×16 blocks holding at least
/// one unclipped pixel, dilated by 1 cell; a clipped pixel in a zero cell
/// sits provably beyond tier 1's 3 px stencil (nearest unclipped pixel ≥
/// 2×16−15 = 17 px away) and skips the 49-tap scan outright. Pure
/// optimization: the skipped scan would have found zero witnesses.
const SKIP_CELL: i32 = 16;

/// Deferred-pixel count that triggers the skip-grid build. Sparse scenes
/// never reach it and pay nothing; dense scenes amortize the one mask pass
/// over thousands of skipped scans.
pub(super) const SKIP_GRID_TRIGGER: usize = 1024;

/// Lazily built tier-1 skip grid (see [`SKIP_CELL`]).
pub(super) struct SkipGrid {
    gw: usize,
    cells: Vec<u8>,
}

impl SkipGrid {
    pub(super) fn build(clip_mask: &[u8], width: u32, height: u32) -> Self {
        let gw = width.div_ceil(SKIP_CELL as u32) as usize;
        let gh = height.div_ceil(SKIP_CELL as u32) as usize;
        let mut cells = vec![0u8; gw * gh];
        for (i, m) in clip_mask.iter().enumerate() {
            if *m == 0 {
                let cx = (i % width as usize) / SKIP_CELL as usize;
                let cy = (i / width as usize) / SKIP_CELL as usize;
                cells[cy * gw + cx] = 1;
            }
        }
        let base = cells.clone();
        for cy in 0..gh {
            for cx in 0..gw {
                if base[cy * gw + cx] == 0 {
                    let mut v = 0u8;
                    for dy in -1..=1 {
                        for dx in -1..=1 {
                            let nx = cx as isize + dx;
                            let ny = cy as isize + dy;
                            if nx >= 0 && ny >= 0 && nx < gw as isize && ny < gh as isize {
                                v |= base[ny as usize * gw + nx as usize];
                            }
                        }
                    }
                    cells[cy * gw + cx] = v;
                }
            }
        }
        Self { gw, cells }
    }

    /// Whether the 7×7 window around `(x, y)` may contain a witness. `false`
    /// is a proof (see [`SKIP_CELL`]); `true` means "scan and see".
    pub(super) fn may_have_witness(&self, x: i32, y: i32) -> bool {
        self.cells[(y / SKIP_CELL) as usize * self.gw + (x / SKIP_CELL) as usize] != 0
    }
}

/// Tier-2 scratch field, allocated lazily on the first pixel tier 1 defers —
/// scenes without large clipped regions never pay for it.
pub(super) struct CellField {
    gw: usize,
    /// Per cell `[n, Σr, Σg, Σb]` over strided unclipped samples.
    means: Vec<[f32; 4]>,
    /// Per clipped cell, per partial mask `[cnt, Σr, Σg, Σb]` over deferred
    /// pixels, indexed by the cell's slot in `clipped_cells`. Only known
    /// channels are ever read; the clipped lanes hold saturated values and
    /// are ignored.
    target: Vec<[[f32; 4]; PARTIAL_MASKS]>,
    /// Per clipped cell, per partial mask `[ratio_r, ratio_g, ratio_b, wsum]`.
    /// `wsum == 0` marks "no gather support" (tier 3 decides).
    ratio: Vec<[[f32; 4]; PARTIAL_MASKS]>,
    /// Deduped indices of cells holding deferred pixels.
    clipped_cells: Vec<u32>,
    /// Cell index to its slot in `clipped_cells`/`target`/`ratio`;
    /// `u32::MAX` marks cells holding no deferred pixel. The per-mask arrays
    /// grow with the clipped area only, so a sparse render pays the dense
    /// means (16 B/cell) plus this map (4 B/cell) instead of ~200 B/cell —
    /// a 100 MP frame with one blown cell rents ~8 MB, not ~80 MB.
    slot: Vec<u32>,
}

impl CellField {
    pub(super) fn new(width: u32, height: u32) -> Self {
        let gw = width.div_ceil(CELL as u32) as usize;
        let gh = height.div_ceil(CELL as u32) as usize;
        let n = gw * gh;
        Self {
            gw,
            means: vec![[0.0; 4]; n],
            target: Vec::new(),
            ratio: Vec::new(),
            clipped_cells: Vec::new(),
            slot: vec![u32::MAX; n],
        }
    }

    fn cell_index(&self, x: i32, y: i32) -> usize {
        (y / CELL) as usize * self.gw + (x / CELL) as usize
    }

    /// Record a deferred pixel: mark its cell once and accumulate its full
    /// RGB into the cell's per-mask target slot.
    pub(super) fn mark_and_accum(&mut self, x: i32, y: i32, mask: u8, pixel: [f32; 3]) {
        let cell = self.cell_index(x, y);
        let s = self.slot[cell];
        let slot_idx = if s == u32::MAX {
            let s = self.clipped_cells.len() as u32;
            self.slot[cell] = s;
            self.clipped_cells.push(cell as u32);
            self.target.push([[0.0; 4]; PARTIAL_MASKS]);
            self.ratio.push([[0.0; 4]; PARTIAL_MASKS]);
            s
        } else {
            s
        };
        let slot = &mut self.target[slot_idx as usize][(mask - 1) as usize];
        slot[0] += 1.0;
        slot[1] += pixel[0];
        slot[2] += pixel[1];
        slot[3] += pixel[2];
    }

    /// Strided means pass over the region. Samples only frozen-mask
    /// unclipped, finite, non-negative pixels — the same validity rule as
    /// tier-1 witnesses.
    fn build_means(
        &mut self,
        img: &Image,
        clip_mask: &[u8],
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    ) {
        let w = img.width as i32;
        let mut y = top;
        while y < bottom {
            let mut x = left;
            while x < right {
                let idx = (y * w + x) as usize;
                if clip_mask[idx] == 0 {
                    let p = img.pixels[idx];
                    if p.iter().all(|v| v.is_finite() && *v >= 0.0) {
                        let cell = self.cell_index(x, y);
                        let s = &mut self.means[cell];
                        s[0] += 1.0;
                        s[1] += p[0];
                        s[2] += p[1];
                        s[3] += p[2];
                    }
                }
                x += MEANS_STRIDE;
            }
            y += MEANS_STRIDE;
        }
    }

    /// Per clipped cell, per active mask: gather the surrounding cells'
    /// means with bilateral weights into a missing-channel ratio estimate.
    fn resolve_cells(&mut self, floor: f32) {
        let gh = self.means.len() / self.gw;
        for si in 0..self.clipped_cells.len() {
            let cell = self.clipped_cells[si] as usize;
            let cx = (cell % self.gw) as i32;
            let cy = (cell / self.gw) as i32;
            for mi in 0..PARTIAL_MASKS {
                let t = self.target[si][mi];
                if t[0] <= 0.0 {
                    continue;
                }
                let mask = (mi + 1) as u8;
                let known_n = 3 - mask.count_ones();
                let tc = [t[1] / t[0], t[2] / t[0], t[3] / t[0]];
                let target_level = known_mean_of(tc, mask, known_n);
                if target_level <= floor {
                    continue;
                }
                let mut acc = [0.0f32; 3];
                let mut wsum = 0.0f32;
                for dy in -GATHER_RADIUS..=GATHER_RADIUS {
                    for dx in -GATHER_RADIUS..=GATHER_RADIUS {
                        let nx = cx + dx;
                        let ny = cy + dy;
                        if nx < 0 || ny < 0 || nx >= self.gw as i32 || ny >= gh as i32 {
                            continue;
                        }
                        let cm = self.means[(ny as usize) * self.gw + nx as usize];
                        if cm[0] < CELL_MIN_SAMPLES {
                            continue;
                        }
                        let cc = [cm[1] / cm[0], cm[2] / cm[0], cm[3] / cm[0]];
                        let cell_level = known_mean_of(cc, mask, known_n);
                        if cell_level <= floor {
                            continue;
                        }
                        let w = chroma_weight(cc, cell_level, tc, target_level, mask, known_n);
                        for c in 0..3 {
                            if (mask >> c) & 1 == 1 {
                                acc[c] += w * cc[c] / cell_level;
                            }
                        }
                        wsum += w;
                    }
                }
                if wsum > 0.0 {
                    self.ratio[si][mi] = [acc[0] / wsum, acc[1] / wsum, acc[2] / wsum, wsum];
                }
            }
        }
    }

    /// The resolved estimate for one deferred pixel: shared cell ratio and
    /// confidence, or `None` when the gather found no support (tier 3).
    fn cell_estimate(&self, x: i32, y: i32, mask: u8) -> (Option<[f32; 3]>, f32) {
        // Every deferred pixel passed through `mark_and_accum`, so its cell
        // always holds a slot; an unmarked cell here is a caller bug.
        let r = self.ratio[self.slot[self.cell_index(x, y)] as usize][(mask - 1) as usize];
        if r[3] > 0.0 {
            (Some([r[0], r[1], r[2]]), (r[3] / CELL_WSUM_FULL).min(1.0))
        } else {
            (None, 0.0)
        }
    }
}

/// Mean over a mask's known channels. `known_n` is the caller's
/// `3 - mask.count_ones()`; the caller guarantees it is nonzero.
fn known_mean_of(p: [f32; 3], mask: u8, known_n: u32) -> f32 {
    (0..3)
        .filter(|c| (mask >> c) & 1 == 0)
        .map(|c| p[c])
        .sum::<f32>()
        / (known_n as f32)
}

/// Resolve every pixel tier 1 deferred: build the regional field once,
/// resolve each clipped cell, then reconstruct each pixel from its cell's
/// estimate blended toward the scene-aware fallback (tier 2), or from the
/// fallback alone when the cell has no support (tier 3).
pub(super) fn resolve_deferred(
    field: &mut CellField,
    img: &mut Image,
    clip_mask: &[u8],
    deferred: &[u32],
    scene: Option<[f32; 3]>,
    region: (i32, i32, i32, i32),
    floor: f32,
) {
    let (left, top, right, bottom) = region;
    field.build_means(img, clip_mask, left, top, right, bottom);
    field.resolve_cells(floor);
    // The scene ratios depend only on the clip mask (6 partial masks), so
    // hoist them out of the per-pixel loop.
    let scene_table: [Option<[f32; 3]>; PARTIAL_MASKS] =
        std::array::from_fn(|mi| scene_ratios(scene, (mi + 1) as u8, floor));
    let w = img.width;
    for &idx in deferred {
        let i = idx as usize;
        let p_in = img.pixels[i];
        let m = clip_mask[i];
        let known_n = 3 - m.count_ones();
        let known_level = known_mean_of(p_in, m, known_n);
        let neutral_level = (0..3)
            .filter(|c| (m >> c) & 1 == 0)
            .map(|c| p_in[c])
            .fold(f32::NEG_INFINITY, f32::max);
        let ratios = scene_table[(m - 1) as usize];
        let x = (idx % w) as i32;
        let y = (idx / w) as i32;
        let (cell_ratio, conf) = field.cell_estimate(x, y, m);
        let mut p_out = p_in;
        for c in 0..3 {
            if (m >> c) & 1 == 1 {
                let fallback = match ratios {
                    Some(sr) => neutral_level + SCENE_BLEND * (known_level * sr[c] - neutral_level),
                    None => neutral_level,
                };
                p_out[c] = match cell_ratio {
                    Some(r) => fallback + conf * (known_level * r[c] - fallback),
                    None => fallback,
                };
            }
        }
        img.pixels[i] = p_out;
    }
}

/// Bilateral range weight for a tier-2 gather cell: 1 when the cell's
/// known-channel chromaticity matches the target's, decaying as the squared
/// inverse with sharpness [`BILATERAL_K`]. Chromaticity — not level — is the
/// comparator, so a bright highlight draws on its dimmer same-surface
/// surround. A single-known-channel target carries no chromaticity and leaves
/// its cells unweighted.
pub(super) fn chroma_weight(
    witness: [f32; 3],
    witness_level: f32,
    target: [f32; 3],
    target_level: f32,
    mask: u8,
    known_count: u32,
) -> f32 {
    if known_count < 2 {
        return 1.0;
    }
    let mut d2 = 0.0f32;
    for k in 0..3 {
        if (mask >> k) & 1 == 0 {
            let d = witness[k] / witness_level - target[k] / target_level;
            d2 += d * d;
        }
    }
    let t = 1.0 + BILATERAL_K * d2;
    1.0 / (t * t)
}

/// Tier-3 scene prior: per-channel medians over a strided grid of unclipped,
/// finite, non-negative region pixels. `None` when the region holds no usable
/// scene evidence (a fully blown frame), in which case the fallback degrades
/// to the pre-#1690 neutral exactly.
pub(super) fn scene_median(
    img: &Image,
    clip_mask: &[u8],
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
) -> Option<[f32; 3]> {
    let w = img.width as i32;
    let step = SCENE_SAMPLE_STRIDE as usize;
    // Two passes over the same stride-8 grid: count the eligible samples,
    // then keep every k-th. A raster-ordered cap would stop after the top
    // strip of a large frame and read sky as scene; a coarser lattice would
    // skip sparse unclipped evidence the stride-8 grid sees.
    let eligible = || {
        (top..bottom).step_by(step).flat_map(move |y| {
            (left..right).step_by(step).filter_map(move |x| {
                let idx = (y * w + x) as usize;
                let p = img.pixels[idx];
                (clip_mask[idx] == 0 && p.iter().all(|v| v.is_finite() && *v >= 0.0)).then_some(p)
            })
        })
    };
    let count = eligible().count();
    if count == 0 {
        return None;
    }
    let mut samples: Vec<[f32; 3]> = eligible()
        .step_by(count.div_ceil(SCENE_SAMPLE_CAP))
        .collect();
    let mid = samples.len() / 2;
    Some(std::array::from_fn(|c| {
        // Each call re-partitions the same buffer for its own channel: the
        // three medians are independent per-channel selections, not one
        // joint median pixel, so reusing the allocation is correct.
        samples
            .select_nth_unstable_by(mid, |a, b| a[c].total_cmp(&b[c]))
            .1[c]
    }))
}

/// Tier-3 per-channel scene ratios: scene median normalized by the target's
/// known-channel mask, the same shape as a tier-1 witness average. `None`
/// when there is no scene evidence or no known scene energy.
fn scene_ratios(scene: Option<[f32; 3]>, mask: u8, floor: f32) -> Option<[f32; 3]> {
    let s = scene?;
    let n = 3 - mask.count_ones();
    let mean = known_mean_of(s, mask, n);
    if mean > floor {
        Some(s.map(|v| v / mean))
    } else {
        None
    }
}
