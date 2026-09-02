//! CPU-side curve preparation + unit-domain evaluation for the
//! display-referred tone-curve stage's GPU port (#2232).
//!
//! `raw_core::stages::tone_curves::evaluator` is `pub(crate)`-scoped inside
//! `raw-core` (unreachable from this crate), so — matching the sibling
//! `tone_curves/prep.rs`'s own precedent — this module replicates
//! `prepare_curve` / `finalize_prepared_curve` / `eval_curve_unit` /
//! `eval_monotonic_cubic` LINE-FOR-LINE (the Fritsch-Carlson half is
//! identical to the scene-linear stage's; only the evaluation domain
//! differs — no `REF_MAX` rescale, since this stage runs post-AgX on a
//! buffer already bounded to `[0, 1]`). The parity test pins the whole
//! pipeline (prep + GPU eval) to the real
//! `stages::display_tone_curve::apply`, so a transcription slip here can't
//! pass.
//!
//! Deliberately NOT shared with `tone_curves/prep.rs` even though both live
//! in this crate: each GPU stage module is self-contained by this crate's
//! own convention (see that file's header), and the two evaluation domains
//! differ (REF_MAX rescale vs. direct `[0, 1]` clamp) enough that a shared
//! abstraction would need its own branch anyway.

/// Max knots per prepared curve the GPU slot can hold. Matches
/// `tone_curves::prep::CURVE_CAP` — the same fixed-stride flat-buffer cap,
/// same rationale (PV2012 editors author far fewer knots than this in
/// practice; exceeding it is a hard panic, not a silent truncation).
pub(super) const CURVE_CAP: usize = 32;

/// A prepared curve: knots (sorted/deduped/clamped) + per-knot
/// Fritsch-Carlson tangents (length == knots.len() when len >= 2, else 0).
pub(super) struct PreparedCurve {
    pub(super) knots: Vec<(f32, f32)>,
    pub(super) tangents: Vec<f32>,
}

impl PreparedCurve {
    pub(super) fn len(&self) -> usize {
        self.knots.len()
    }

    /// Serialize into a fixed-stride f32 slot: `[len, x0,y0,t0, x1,y1,t1, ...]`,
    /// zero-padded to [`CURVE_CAP`] knots. Stride = `1 + CURVE_CAP*3`, matching
    /// `SLOT_STRIDE` in `display_tone_curve.wgsl`.
    ///
    /// # Panics
    /// Panics if `knots.len() > CURVE_CAP`.
    pub(super) fn to_slot(&self) -> Vec<f32> {
        assert!(
            self.knots.len() <= CURVE_CAP,
            "prepared display tone curve has {} knots, exceeds CURVE_CAP {}",
            self.knots.len(),
            CURVE_CAP
        );
        let mut slot = vec![0.0f32; 1 + CURVE_CAP * 3];
        slot[0] = self.knots.len() as f32;
        for (i, &(x, y)) in self.knots.iter().enumerate() {
            slot[1 + i * 3] = x;
            slot[1 + i * 3 + 1] = y;
            slot[1 + i * 3 + 2] = self.tangents.get(i).copied().unwrap_or(0.0);
        }
        slot
    }
}

/// Sort by x ascending, clamp into `[0, 1]^2`, dedup equal-x neighbours
/// (last-write-wins), then finalize. Mirrors `evaluator::prepare_curve`.
pub(super) fn prepare_curve(points: &[(f32, f32)]) -> PreparedCurve {
    let mut pts: Vec<(f32, f32)> = points
        .iter()
        .map(|&(x, y)| (x.clamp(0.0, 1.0), y.clamp(0.0, 1.0)))
        .collect();
    pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    pts.dedup_by(|next, prev| {
        if (next.0 - prev.0).abs() < f32::EPSILON {
            *prev = *next;
            true
        } else {
            false
        }
    });
    finalize_prepared_curve(pts)
}

/// Compute the Fritsch-Carlson tangents (with the slope-sign + radius-3
/// monotonicity guards). Line-for-line port of
/// `evaluator::finalize_prepared_curve`.
fn finalize_prepared_curve(knots: Vec<(f32, f32)>) -> PreparedCurve {
    let n = knots.len();
    if n < 2 {
        return PreparedCurve {
            knots,
            tangents: Vec::new(),
        };
    }

    let slopes = segment_slopes(&knots);

    let mut tangents = Vec::with_capacity(n);
    tangents.push(slopes[0]);
    for i in 1..n - 1 {
        if slopes[i - 1] * slopes[i] <= 0.0 {
            tangents.push(0.0);
        } else {
            tangents.push((slopes[i - 1] + slopes[i]) * 0.5);
        }
    }
    tangents.push(slopes[n - 2]);

    let tangents = guard_tangents(&slopes, tangents);
    PreparedCurve { knots, tangents }
}

/// Mirrors `evaluator::segment_slopes`.
fn segment_slopes(knots: &[(f32, f32)]) -> Vec<f32> {
    knots
        .windows(2)
        .map(|w| (w[1].1 - w[0].1) / (w[1].0 - w[0].0))
        .collect()
}

/// Mirrors `evaluator::guard_tangents`.
fn guard_tangents(slopes: &[f32], tangents: Vec<f32>) -> Vec<f32> {
    let mut tangents = tangents;
    for (i, &m) in slopes.iter().enumerate() {
        if m.abs() < f32::EPSILON {
            tangents[i] = 0.0;
            tangents[i + 1] = 0.0;
            continue;
        }
        let alpha = tangents[i] / m;
        let beta = tangents[i + 1] / m;
        let mag = alpha.hypot(beta);
        if mag > 3.0 {
            let scale = 3.0 / mag;
            tangents[i] = scale * alpha * m;
            tangents[i + 1] = scale * beta * m;
        }
    }
    tangents
}

/// Evaluate the prepared curve at a value already in the `[0, 1]` authoring
/// domain — no rescale. Line-for-line port of `evaluator::eval_curve_unit`:
/// len 0 -> v (pass-through); len 1 -> constant `knots[0].y`; else clamp `v`
/// into `[0, 1]` and evaluate the monotonic cubic Hermite.
pub(super) fn eval_curve_unit(curve: &PreparedCurve, v: f32) -> f32 {
    if curve.len() < 2 {
        if let Some(&(_, y)) = curve.knots.first() {
            return y;
        }
        return v;
    }
    eval_monotonic_cubic(curve, v.clamp(0.0, 1.0))
}

/// Fritsch-Carlson cubic Hermite at authoring `x`. Line-for-line port of
/// `evaluator::eval_monotonic_cubic`.
fn eval_monotonic_cubic(curve: &PreparedCurve, x: f32) -> f32 {
    let knots = &curve.knots[..];
    let n = knots.len();
    debug_assert!(n >= 2);

    if x <= knots[0].0 {
        return knots[0].1;
    }
    if x >= knots[n - 1].0 {
        return knots[n - 1].1;
    }

    let mut i = 0;
    for j in 0..n - 1 {
        if x >= knots[j].0 && x <= knots[j + 1].0 {
            i = j;
            break;
        }
    }

    let dx = knots[i + 1].0 - knots[i].0;
    let t = (x - knots[i].0) / dx;
    let t2 = t * t;
    let t3 = t2 * t;
    let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
    let h10 = t3 - 2.0 * t2 + t;
    let h01 = -2.0 * t3 + 3.0 * t2;
    let h11 = t3 - t2;
    h00 * knots[i].1 + h10 * dx * curve.tangents[i] + h01 * knots[i + 1].1 + h11 * dx * curve.tangents[i + 1]
}
