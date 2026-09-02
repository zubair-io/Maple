//! Two-image content-aware seam via Boykov-Kolmogorov max-flow / min-cut
//! (spec §5.7, #1179).
//!
//! Given two already-warped, same-size canvas layers `a` and `b` with an
//! overlap, [`cut`] partitions every canvas pixel into "use A" or "use B"
//! by minimum-cost min-cut, so the seam routes through content both
//! frames agree on and away from anything that only one of them shows
//! (a moving subject, a parallax-shifted edge). [`crate::seam::labels`]
//! drives this pairwise cut repeatedly (alpha-expansion) to resolve the
//! N-image case.
//!
//! # Graph construction
//!
//! One BK node per overlap pixel (both `a` and `b` valid there).
//! - A pixel valid **only** in `a` is wired to the source with an
//!   effectively-infinite capacity: the cut can never place it on `b`'s
//!   side, because there is no `b` content there to show.
//! - A pixel valid **only** in `b` is wired to the sink the same way.
//! - Every 4-connected pair of overlap pixels gets an undirected edge
//!   whose capacity is [`edge_cost`] — a high cost makes it expensive
//!   for the seam to separate that pair, so the cut avoids cutting
//!   there.
//!
//! After [`super::bk::BkGraph::solve`], pixels on the source side keep
//! `a`; the rest take `b`.
//!
//! # Cost function
//!
//! ```text
//! data(p)  = |grad(luma_a(p) - luma_b(p))|      // gradient-domain difference
//! local(p) = (|grad luma_a(p)| + |grad luma_b(p)|) / 2   // local contrast
//! edge_cost(p, q) = (data(p) + data(q)) / (1 + LOCAL_CONTRAST_WEIGHT * (local(p) + local(q)))
//! ```
//!
//! `data` is the gradient magnitude of the two frames' **difference**
//! image, not their raw color difference: a statically well-aligned
//! region with a residual gain/exposure mismatch has a difference image
//! that is locally flat (low gradient) even though it isn't zero
//! everywhere, so it stays cheap to cut through. A misaligned or moving
//! subject shows up as a sharp edge in the difference image (the same
//! feature at two different positions), which spikes `data` and makes
//! the seam route around it — this is the P0-6 ghosting fix.
//!
//! `local` is the busyness of the underlying content itself (not the
//! disagreement between the two frames). Dividing by `1 + local`
//! discounts the cost in areas with a lot of existing detail (foliage,
//! texture, an already-present edge) — a small handoff there blends
//! into what's already visually busy, whereas the same handoff in a
//! flat sky or wall is the one place a viewer's eye catches it. This is
//! the classic contrast-sensitive smoothness term used for interactive
//! segmentation boundaries, applied here to seam placement instead.

use crate::ingest::PlanarImage;

use super::bk::BkGraph;

/// "Effectively infinite" capacity for terminal edges that must never be
/// cut — large enough to dominate any real edge cost, small enough that
/// summing a handful of them can't overflow `i64`.
const INF_CAP: i64 = i64::MAX / 4;
/// Integer scale for converting `f32` edge costs to BK capacities.
///
/// Deliberately coarse (not `1_000_000` — measured too fine on real
/// photo content): `bk`'s documented heterogeneous-capacity pathology
/// (see its module doc, "Known correctness limitation") is sensitive to
/// how many *distinct* capacity levels the graph has, not just their
/// ratio — a real overlap's gradient-domain data term spans a wide,
/// continuously-varying range on real texture (unlike the synthetic
/// tests' few discrete values), and scaling that by 1e6 produced graphs
/// that took multiple minutes to solve on a real pano_01 overlap. `1_000`
/// keeps ~3 significant digits of the cost ordering (which is all
/// min-cut needs) while cutting the flow-granularity a thousandfold.
const COST_SCALE: f64 = 1_000.0;
/// Absolute cap on BK `solve()` augmenting-path iterations.
///
/// Fixed, **not** scaled by node count: a per-node multiplier looks
/// "generous" but is unbounded at seam-canvas scale (a few-million-node
/// graph turns any positive per-node factor into a cap that still lets a
/// pathological solve run for minutes — measured on real pano_01
/// content, see [`COST_SCALE`]'s doc). BK on a well-conditioned grid
/// graph converges in a small multiple of the node count, so this cap
/// only bites on the documented heterogeneous-capacity pathology; when
/// it does, `solve()` returns the partial flow with the cut state as it
/// stands (still a valid partition, just not necessarily the global
/// minimum) rather than running unbounded.
const MAX_ITER: u64 = 20_000;
/// Weight on the local-contrast discount in [`edge_cost`]. Not exposed
/// as a tunable — the ticket asks for the two named terms (gradient-
/// domain data term, local-contrast smoothness), not a knob surface.
const LOCAL_CONTRAST_WEIGHT: f32 = 4.0;

#[inline]
fn luma(r: f32, g: f32, b: f32) -> f32 {
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// Row-major luma plane for a [`PlanarImage`], length `w * h`.
fn luma_plane(img: &PlanarImage) -> Vec<f32> {
    let n = img.pixel_count();
    (0..n).map(|i| luma(img.r[i], img.g[i], img.b[i])).collect()
}

/// Finite-difference gradient magnitude of a row-major plane at `(x, y)`,
/// clamped at the border (forward difference, replicated last sample).
#[inline]
fn grad_mag(plane: &[f32], w: u32, h: u32, x: u32, y: u32) -> f32 {
    let at = |px: u32, py: u32| plane[(py as usize) * (w as usize) + (px as usize)];
    let x1 = if x + 1 < w { x + 1 } else { x };
    let y1 = if y + 1 < h { y + 1 } else { y };
    let gx = at(x1, y) - at(x, y);
    let gy = at(x, y1) - at(x, y);
    (gx * gx + gy * gy).sqrt()
}

/// Bounding box (inclusive) of pixels valid in both `a` and `b`, or
/// `None` when they don't overlap.
fn overlap_bbox(a: &PlanarImage, b: &PlanarImage) -> Option<(u32, u32, u32, u32)> {
    let (w, h) = (a.width(), a.height());
    let (mut x_min, mut x_max, mut y_min, mut y_max) = (w, 0u32, h, 0u32);
    let mut any = false;
    for y in 0..h {
        for x in 0..w {
            if a.validity.get(x, y) && b.validity.get(x, y) {
                any = true;
                x_min = x_min.min(x);
                x_max = x_max.max(x);
                y_min = y_min.min(y);
                y_max = y_max.max(y);
            }
        }
    }
    any.then_some((x_min, x_max, y_min, y_max))
}

/// Per-pixel precomputed cost features, shared across every edge lookup
/// so `edge_cost` is O(1) instead of recomputing gradients per call.
struct CostFields {
    data: Vec<f32>,
    local: Vec<f32>,
}

fn build_cost_fields(a: &PlanarImage, b: &PlanarImage) -> CostFields {
    let (w, h) = (a.width(), a.height());
    let luma_a = luma_plane(a);
    let luma_b = luma_plane(b);
    let diff: Vec<f32> = luma_a.iter().zip(&luma_b).map(|(&x, &y)| x - y).collect();
    let n = (w as usize) * (h as usize);
    let mut data = vec![0.0_f32; n];
    let mut local = vec![0.0_f32; n];
    for y in 0..h {
        for x in 0..w {
            let idx = (y as usize) * (w as usize) + (x as usize);
            data[idx] = grad_mag(&diff, w, h, x, y);
            let ca = grad_mag(&luma_a, w, h, x, y);
            let cb = grad_mag(&luma_b, w, h, x, y);
            local[idx] = 0.5 * (ca + cb);
        }
    }
    CostFields { data, local }
}

#[inline]
fn edge_cost(fields: &CostFields, p: usize, q: usize) -> i64 {
    let data = fields.data[p] + fields.data[q];
    let local = fields.local[p] + fields.local[q];
    let cost = data / (1.0 + LOCAL_CONTRAST_WEIGHT * local);
    // Scale to integer and clamp to a sane positive minimum so every
    // edge has some capacity (a zero-capacity edge would let the BK
    // grow phase never cross it, effectively deleting it from the
    // graph, which is not the intent — identical content should be
    // "free to cut anywhere", not "impossible to cut").
    ((cost as f64 * COST_SCALE).round() as i64).max(1)
}

/// Minimum-cost min-cut partition of the canvas `a`/`b` share.
///
/// Returns a flat `Vec<bool>` of length `width * height`: `true` means
/// "use b's content at this pixel", `false` means "use a's". Pixels
/// valid in neither image are `false` (irrelevant — the caller only
/// consumes this at pixels it already knows are covered).
///
/// `a` and `b` must have equal dimensions (both warped onto the same
/// canvas). Returns an all-`false` (defaults to `a`) partition when
/// there's no overlap — nothing to cut.
pub fn cut(a: &PlanarImage, b: &PlanarImage) -> Vec<bool> {
    assert_eq!(
        (a.width(), a.height()),
        (b.width(), b.height()),
        "seam::pairwise::cut: a/b must share canvas dimensions"
    );
    let (w, h) = (a.width(), a.height());
    let n = (w as usize) * (h as usize);
    let mut use_b = vec![false; n];

    // Outside the overlap: assign to whichever image is actually valid.
    for y in 0..h {
        for x in 0..w {
            let idx = (y as usize) * (w as usize) + (x as usize);
            let (va, vb) = (a.validity.get(x, y), b.validity.get(x, y));
            if !va && vb {
                use_b[idx] = true;
            }
        }
    }

    let Some((x_min, x_max, y_min, y_max)) = overlap_bbox(a, b) else {
        return use_b;
    };
    let ov_w = (x_max - x_min + 1) as usize;
    let ov_h = (y_max - y_min + 1) as usize;
    let n_ov = ov_w * ov_h;

    const INVALID_NODE: u32 = u32::MAX;
    let mut node_map = vec![INVALID_NODE; n_ov];
    let mut n_valid = 0u32;
    for oy in 0..ov_h as u32 {
        for ox in 0..ov_w as u32 {
            let (x, y) = (x_min + ox, y_min + oy);
            if a.validity.get(x, y) && b.validity.get(x, y) {
                node_map[(oy as usize) * ov_w + ox as usize] = n_valid;
                n_valid += 1;
            }
        }
    }
    if n_valid == 0 {
        return use_b;
    }

    let fields = build_cost_fields(a, b);
    let canvas_idx = |x: u32, y: u32| (y as usize) * (w as usize) + (x as usize);

    let mut g = BkGraph::with_capacity(n_valid as usize, n_valid as usize * 2);
    for _ in 0..n_valid {
        g.add_node();
    }

    for oy in 0..ov_h as u32 {
        for ox in 0..ov_w as u32 {
            let nid = node_map[(oy as usize) * ov_w + ox as usize];
            if nid == INVALID_NODE {
                continue;
            }
            let (x, y) = (x_min + ox, y_min + oy);

            // Terminal edges: pixels bordering "only A" or "only B" get
            // pinned so the cut can never place non-existent content.
            let mut near_a_only = false;
            let mut near_b_only = false;
            for (nx, ny) in [
                (x.wrapping_sub(1), y),
                (x + 1, y),
                (x, y.wrapping_sub(1)),
                (x, y + 1),
            ] {
                if nx >= w || ny >= h {
                    continue;
                }
                let (va, vb) = (a.validity.get(nx, ny), b.validity.get(nx, ny));
                near_a_only |= va && !vb;
                near_b_only |= vb && !va;
            }
            if near_a_only {
                g.add_terminal(nid, INF_CAP, 0);
            }
            if near_b_only {
                g.add_terminal(nid, 0, INF_CAP);
            }

            // Right / down neighbour edges (4-connected, each pair visited once).
            if ox + 1 < ov_w as u32 {
                let nid_r = node_map[(oy as usize) * ov_w + (ox + 1) as usize];
                if nid_r != INVALID_NODE {
                    let c = edge_cost(&fields, canvas_idx(x, y), canvas_idx(x + 1, y));
                    g.add_edge(nid, nid_r, c, c);
                }
            }
            if oy + 1 < ov_h as u32 {
                let nid_d = node_map[(oy + 1) as usize * ov_w + ox as usize];
                if nid_d != INVALID_NODE {
                    let c = edge_cost(&fields, canvas_idx(x, y), canvas_idx(x, y + 1));
                    g.add_edge(nid, nid_d, c, c);
                }
            }
        }
    }

    g.set_iter_limit(MAX_ITER);
    g.finalize();
    g.solve();

    for oy in 0..ov_h as u32 {
        for ox in 0..ov_w as u32 {
            let nid = node_map[(oy as usize) * ov_w + ox as usize];
            if nid == INVALID_NODE {
                continue;
            }
            let (x, y) = (x_min + ox, y_min + oy);
            // Source side keeps `a`; everything else (including sink
            // side) takes `b`.
            use_b[canvas_idx(x, y)] = !g.is_in_source(nid);
        }
    }
    use_b
}

/// Total [`edge_cost`] summed over every 4-connected pixel pair whose
/// partition value differs — the "seam-line gradient energy" of a given
/// A/B partition. Test-only: used to compare the graph-cut seam against
/// a naive fixed seam on the same cost field.
#[cfg(test)]
fn seam_crossing_cost(fields: &CostFields, use_b: &[bool], w: u32, h: u32) -> i64 {
    let idx = |x: u32, y: u32| (y as usize) * (w as usize) + (x as usize);
    let mut total = 0i64;
    for y in 0..h {
        for x in 0..w {
            let p = idx(x, y);
            if x + 1 < w {
                let q = idx(x + 1, y);
                if use_b[p] != use_b[q] {
                    total += edge_cost(fields, p, q);
                }
            }
            if y + 1 < h {
                let q = idx(x, y + 1);
                if use_b[p] != use_b[q] {
                    total += edge_cost(fields, p, q);
                }
            }
        }
    }
    total
}

#[cfg(test)]
mod tests {
    #[test]
    fn perf_probe_realistic_textured_overlap() {
        // Deterministic pseudo-random texture (not a smooth gradient) to
        // better emulate real photo content's high-frequency detail,
        // which is what triggered the multi-minute real-world slowdown
        // this test guards against regressing.
        fn lcg_next(state: &mut u32) -> u32 {
            *state = state.wrapping_mul(1664525).wrapping_add(1013904223);
            *state
        }
        let (w, h) = (2000u32, 2000u32);
        let n = (w * h) as usize;
        let mut seed_a = 12345u32;
        let mut seed_b = 999u32;
        let mut a = gradient_image(w, h);
        let mut b = gradient_image(w, h);
        for i in 0..n {
            let va = (lcg_next(&mut seed_a) % 1000) as f32 / 1000.0;
            let vb = (lcg_next(&mut seed_b) % 1000) as f32 / 1000.0;
            a.r[i] = (a.r[i] + 0.3 * va).clamp(0.0, 1.0);
            a.g[i] = (a.g[i] + 0.3 * va).clamp(0.0, 1.0);
            a.b[i] = (a.b[i] + 0.3 * va).clamp(0.0, 1.0);
            b.r[i] = (b.r[i] + 0.3 * vb).clamp(0.0, 1.0);
            b.g[i] = (b.g[i] + 0.3 * vb).clamp(0.0, 1.0);
            b.b[i] = (b.b[i] + 0.3 * vb).clamp(0.0, 1.0);
        }
        let t0 = std::time::Instant::now();
        let _use_b = cut(&a, &b);
        let elapsed = t0.elapsed();
        eprintln!("perf_probe_realistic_textured_overlap: {elapsed:?} for {w}x{h}");
        assert!(
            elapsed.as_secs() < 30,
            "graph-cut took {elapsed:?} on a {w}x{h} noisy overlap — regression vs the \
             COST_SCALE/iter-limit fix for the pano_01 real-content slowdown"
        );
    }

    use super::*;
    use crate::ingest::ValidityMask;

    fn solid(w: u32, h: u32, r: f32, g: f32, b: f32) -> PlanarImage {
        let n = (w as usize) * (h as usize);
        PlanarImage::from_planes(
            w,
            h,
            vec![r; n],
            vec![g; n],
            vec![b; n],
            ValidityMask::new_filled(w, h, true),
        )
    }

    /// A smooth gradient so `grad_mag` sees real (non-degenerate) local
    /// contrast, rather than the all-zero field a flat image gives.
    fn gradient_image(w: u32, h: u32) -> PlanarImage {
        let mut r = vec![0.0f32; (w * h) as usize];
        let (mut g, mut b) = (r.clone(), r.clone());
        for y in 0..h {
            for x in 0..w {
                let idx = (y * w + x) as usize;
                let v = (x as f32 / w.max(1) as f32) * 0.6 + (y as f32 / h.max(1) as f32) * 0.2;
                r[idx] = v;
                g[idx] = v * 0.8;
                b[idx] = v * 0.6;
            }
        }
        PlanarImage::from_planes(w, h, r, g, b, ValidityMask::new_filled(w, h, true))
    }

    #[test]
    fn no_overlap_defaults_to_valid_image() {
        let w = 8;
        let h = 8;
        let mut a = solid(w, h, 0.5, 0.5, 0.5);
        let mut b = solid(w, h, 0.9, 0.9, 0.9);
        // a valid on the left half, b valid on the right half: no overlap.
        for y in 0..h {
            for x in 0..w {
                a.validity.set(x, y, x < w / 2);
                b.validity.set(x, y, x >= w / 2);
            }
        }
        let use_b = cut(&a, &b);
        for y in 0..h {
            for x in 0..w {
                let idx = (y * w + x) as usize;
                assert_eq!(use_b[idx], x >= w / 2, "pixel ({x},{y})");
            }
        }
    }

    /// Identical content everywhere: the gradient-domain **data term** is
    /// exactly zero at every pixel (no disagreement to route around), so
    /// there's no content-driven cost pushing the seam anywhere in
    /// particular. This checks `CostFields::data` directly rather than
    /// the integer BK edge capacities `edge_cost` produces from it —
    /// those are deliberately clamped to a `.max(1)` floor (see its doc)
    /// so no edge is ever truly free to cross, which is a graph-topology
    /// concern separate from whether the two frames agree on content.
    #[test]
    fn identical_content_has_zero_gradient_domain_data_term() {
        let (w, h) = (16, 12);
        let img = gradient_image(w, h);
        let use_b = cut(&img, &img.clone());
        // Every pixel's data term must be zero (both images are literally
        // the same buffer, so grad(diff) == 0 everywhere).
        let fields = build_cost_fields(&img, &img);
        for y in 0..h {
            for x in 0..w {
                let idx = (y * w + x) as usize;
                assert!(
                    fields.data[idx].abs() < 1e-6,
                    "expected zero gradient-domain difference on identical images at ({x},{y}), got {}",
                    fields.data[idx]
                );
            }
        }
        // Sanity: the cut still produces a valid, fully-covered partition
        // (every pixel decided, whichever way — a zero data term means
        // content isn't steering the seam, not that the graph has no
        // cost at all to route around).
        assert_eq!(use_b.len(), (w * h) as usize);
    }

    /// The ticket #1179 acceptance gate (deferred from #1155): a moving
    /// object present in only one frame's overlap must not get cut
    /// through, and the resulting seam must be markedly cheaper than a
    /// naive fixed seam that ignores content.
    #[test]
    fn moving_blob_is_routed_around_not_through() {
        // Realistic overlap topology: A covers the left ~2/3 of the
        // canvas, B the right ~2/3, overlapping in a middle band —
        // exactly the shape a real neighbouring-frame overlap has (unlike
        // two frames that are both valid over the *entire* canvas, which
        // has no validity boundary to anchor a cut at all).
        let (w, h) = (40u32, 20u32);
        let (a_valid_end, b_valid_start) = (26u32, 14u32); // overlap = [14, 26)
        let mut a = solid(w, h, 0.0, 0.0, 0.0);
        let mut b = solid(w, h, 0.0, 0.0, 0.0);
        for y in 0..h {
            for x in 0..w {
                a.validity.set(x, y, x < a_valid_end);
                b.validity.set(x, y, x >= b_valid_start);
            }
        }
        // A "moving subject": present in B only, inside the overlap band,
        // straddling its midline (~x=20) so a content-blind vertical seam
        // has no choice but to cut through it. Checkerboarded (not flat)
        // so the gradient-domain data term sees disagreement throughout
        // its interior, not only at its 1px border — a real moving
        // subject has internal texture, not a solid silhouette.
        let (bx0, bx1, by0, by1) = (17u32, 23u32, 6u32, 14u32);
        for y in by0..by1 {
            for x in bx0..bx1 {
                let idx = (y * w + x) as usize;
                let v = if (x + y) % 2 == 0 { 0.9 } else { 0.1 };
                b.r[idx] = v;
                b.g[idx] = v;
                b.b[idx] = v;
            }
        }

        let use_b = cut(&a, &b);

        // The seam must not thread through the blob's interior: every
        // pixel strictly inside it (avoiding its own border, where an
        // adjacent-pixel edge cost is legitimately part of the blob's
        // own high-cost boundary) shares one partition value.
        let interior = (bx0 + 1..bx1 - 1).flat_map(|x| (by0 + 1..by1 - 1).map(move |y| (x, y)));
        let first = use_b[((by0 + 1) * w + (bx0 + 1)) as usize];
        for (x, y) in interior {
            assert_eq!(
                use_b[(y * w + x) as usize],
                first,
                "seam cut through the interior of the moving blob at ({x},{y})"
            );
        }

        // The routed seam's total crossing cost must beat a content-blind
        // vertical mid-line seam (running down the middle of the overlap
        // band, straight through the blob) by the ticket's 2x margin.
        let fields = build_cost_fields(&a, &b);
        let graph_cut_cost = seam_crossing_cost(&fields, &use_b, w, h);
        let mid = (bx0 + bx1) / 2;
        let naive_mid_line: Vec<bool> = (0..h).flat_map(|_| (0..w).map(|x| x >= mid)).collect();
        let naive_cost = seam_crossing_cost(&fields, &naive_mid_line, w, h);
        assert!(
            (graph_cut_cost as f64) < 0.5 * naive_cost as f64,
            "graph-cut seam energy {graph_cut_cost} not < 0.5x naive mid-line seam energy {naive_cost}"
        );
    }
}
