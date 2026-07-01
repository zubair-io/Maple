//! CPU-side curve preparation + scene-linear evaluation for the tone-curve
//! stage's GPU port (epic #925 / #990).
//!
//! `raw_core::stages::tone_curves::evaluator` is `pub(super)` (unreachable from
//! this crate), so this module replicates its `prepare_curve` /
//! `finalize_prepared_curve` / `eval_curve_scene_linear` / `eval_monotonic_cubic`
//! LINE-FOR-LINE. The prepared curve (sorted/deduped/clamped knots + the
//! Fritsch-Carlson tangents) is the runtime data uploaded to the GPU — the analog
//! of white_balance deriving its matrix CPU-side once. The parity test pins the
//! whole pipeline (prep + GPU eval) to the real `stages::tone_curves::apply`, so
//! a transcription slip here can't pass.
//!
//! Split out of `tone_curves.rs` for the 600-LOC budget (mirrors raw-core's own
//! `evaluator.rs` split for the same reason).

/// Authoring `[0, 1]` -> scene `[0, REF_MAX]` mapping. Mirrors
/// `evaluator::REF_MAX` (= 4.0; two stops above diffuse white, paper § 4.6).
pub(super) const REF_MAX: f32 = 4.0;

/// Max knots per prepared curve the GPU slot can hold (the flat-buffer
/// fixed-stride cap). 32 comfortably exceeds any realistic UI curve (PV2012
/// editors cap well below this) and matches the auto_profile anchor-count
/// precedent. A prepared curve exceeding this is a hard PANIC, not a silent
/// truncation (a truncated curve would diverge from the CPU oracle — the
/// "silent placeholder" CLAUDE.md forbids).
pub(super) const CURVE_CAP: usize = 32;

/// A prepared curve: knots (sorted/deduped/clamped) + per-knot Fritsch-Carlson
/// tangents (length == knots.len() when len >= 2, else 0). The GPU consumes the
/// flat form ([`to_slot`]); the oracle consumes this struct directly.
pub(super) struct PreparedCurve {
    pub(super) knots: Vec<(f32, f32)>,
    pub(super) tangents: Vec<f32>,
}

impl PreparedCurve {
    pub(super) fn len(&self) -> usize {
        self.knots.len()
    }

    /// Serialize into a fixed-stride f32 slot: `[len, x0,y0,t0, x1,y1,t1, ...]`,
    /// zero-padded to [`CURVE_CAP`] knots. The slot stride is `1 + CURVE_CAP*3`,
    /// matching `SLOT_STRIDE` in the WGSL kernel.
    ///
    /// # Panics
    /// Panics if `knots.len() > CURVE_CAP` (the slot can't hold it; truncating
    /// would silently diverge from the CPU evaluator).
    pub(super) fn to_slot(&self) -> Vec<f32> {
        assert!(
            self.knots.len() <= CURVE_CAP,
            "prepared tone curve has {} knots, exceeds CURVE_CAP {}",
            self.knots.len(),
            CURVE_CAP
        );
        let mut slot = vec![0.0f32; 1 + CURVE_CAP * 3];
        slot[0] = self.knots.len() as f32;
        for (i, &(x, y)) in self.knots.iter().enumerate() {
            slot[1 + i * 3] = x;
            slot[1 + i * 3 + 1] = y;
            // tangents is empty when len < 2 (degenerate); leave t = 0 then.
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

/// Finalize from an already-authoring-domain knot slice (the parametric path's
/// synthesised 5-knot array). Mirrors `evaluator::prepare_curve_from_slice`.
pub(super) fn prepare_curve_from_slice(pts: &[(f32, f32)]) -> PreparedCurve {
    finalize_prepared_curve(pts.to_vec())
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

    let mut slopes = Vec::with_capacity(n - 1);
    for i in 0..n - 1 {
        let dx = knots[i + 1].0 - knots[i].0;
        let dy = knots[i + 1].1 - knots[i].1;
        slopes.push(dy / dx);
    }

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

    for i in 0..n - 1 {
        let m = slopes[i];
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

    PreparedCurve { knots, tangents }
}

/// Evaluate the prepared curve at scene-linear `v`. Line-for-line port of
/// `evaluator::eval_curve_scene_linear` (REF_MAX both directions; len 0 -> v;
/// len 1 -> constant `knots[0].y * REF_MAX`).
pub(super) fn eval_curve_scene_linear(curve: &PreparedCurve, v: f32) -> f32 {
    if curve.len() < 2 {
        if let Some(&(_, y)) = curve.knots.first() {
            return y * REF_MAX;
        }
        return v;
    }
    let x_raw = v / REF_MAX;
    let x = if x_raw < 0.98 {
        x_raw
    } else {
        0.98 + 0.02 * ((x_raw - 0.98) / 0.02).tanh()
    };
    let x = x.clamp(0.0, 1.0);
    let y_authoring = eval_monotonic_cubic(curve, x);
    y_authoring * REF_MAX
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
    h00 * knots[i].1
        + h10 * dx * curve.tangents[i]
        + h01 * knots[i + 1].1
        + h11 * dx * curve.tangents[i + 1]
}

/// Build the parametric 5-knot curve from the four region sliders, CPU-side.
/// Line-for-line port of `mod::build_parametric_knots` (knot amplitude 0.25;
/// the left-to-right cumulative-max monotonicity guard + `[0, 1]` clamp).
pub(super) fn build_parametric_knots(
    shadows: f32,
    darks: f32,
    lights: f32,
    highlights: f32,
) -> [(f32, f32); 5] {
    let s = shadows / 100.0;
    let d = darks / 100.0;
    let l = lights / 100.0;
    let h = highlights / 100.0;
    let knot_amplitude = 0.25;

    let mut knots: [(f32, f32); 5] = [
        (0.0, 0.0),
        (0.25, 0.25 + s * knot_amplitude),
        (0.5, 0.5 + (d + l) * 0.5 * knot_amplitude),
        (0.75, 0.75 + h * knot_amplitude),
        (1.0, 1.0),
    ];
    for i in 1..knots.len() {
        let lo = knots[i - 1].1;
        if knots[i].1 < lo {
            knots[i].1 = lo;
        }
        knots[i].1 = knots[i].1.clamp(0.0, 1.0);
    }
    knots
}
