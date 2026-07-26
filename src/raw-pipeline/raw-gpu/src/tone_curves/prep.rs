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

/// Build from knots whose tangents the caller already knows analytically (the
/// parametric path — see [`build_parametric_curve`]). Mirrors
/// `evaluator::prepare_curve_with_tangents`.
fn prepare_curve_with_tangents(knots: Vec<(f32, f32)>, tangents: Vec<f32>) -> PreparedCurve {
    assert_eq!(
        knots.len(),
        tangents.len(),
        "prepare_curve_with_tangents: {} knots but {} tangents",
        knots.len(),
        tangents.len()
    );
    if knots.len() < 2 {
        return PreparedCurve {
            knots,
            tangents: Vec::new(),
        };
    }
    let slopes = segment_slopes(&knots);
    let guarded = guard_tangents(&slopes, tangents);
    PreparedCurve {
        knots,
        tangents: guarded,
    }
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

// ---------------------------------------------------------------------------
// Parametric region curve — line-for-line port of
// `raw_core::stages::tone_curves::parametric` (#2318). The region model, the
// derivation of the monotonicity bound and the reason the knots land on the
// axis landmarks all live in that module's docs; this is transcription only.
// ---------------------------------------------------------------------------

const MIDGREY: f32 = 0.18;
const AXIS_MIDTONE: f32 = 50.0;
const AXIS_UNITS_PER_STOP: f32 = 12.5;
const AXIS_MAX: f32 = 100.0;
const SPLIT_SHADOW: f32 = 25.0;
const SPLIT_MIDTONE: f32 = AXIS_MIDTONE;
const SPLIT_HIGHLIGHT: f32 = 75.0;
const AXIS_TOP: f32 = 105.924_14;
const MAX_STOPS: f32 = 0.5;

const REGION_CENTRES: [f32; 4] = [
    SPLIT_SHADOW * 0.5,
    (SPLIT_SHADOW + SPLIT_MIDTONE) * 0.5,
    (SPLIT_MIDTONE + SPLIT_HIGHLIGHT) * 0.5,
    (SPLIT_HIGHLIGHT + AXIS_MAX) * 0.5,
];

const SAMPLE_AXIS: [f32; 8] = [
    REGION_CENTRES[0],
    SPLIT_SHADOW,
    REGION_CENTRES[1],
    SPLIT_MIDTONE,
    REGION_CENTRES[2],
    SPLIT_HIGHLIGHT,
    REGION_CENTRES[3],
    (REGION_CENTRES[3] + AXIS_TOP) * 0.5,
];

/// Knots in the synthesised parametric curve (endpoints + [`SAMPLE_AXIS`]).
/// Must stay `<= CURVE_CAP`; `to_slot` panics otherwise.
pub(super) const PARAMETRIC_KNOT_COUNT: usize = SAMPLE_AXIS.len() + 2;

fn axis_to_authoring_x(p: f32) -> f32 {
    MIDGREY * ((p - AXIS_MIDTONE) / AXIS_UNITS_PER_STOP).exp2() / REF_MAX
}

fn region_amplitude(slider: f32) -> f32 {
    slider.clamp(-100.0, 100.0) / 100.0 * MAX_STOPS
}

fn smoothstep(a: f32, b: f32, p: f32) -> (f32, f32) {
    let t_raw = (p - a) / (b - a);
    let t = t_raw.clamp(0.0, 1.0);
    let value = t * t * (3.0 - 2.0 * t);
    let slope = if t_raw <= 0.0 || t_raw >= 1.0 {
        0.0
    } else {
        6.0 * t * (1.0 - t) / (b - a)
    };
    (value, slope)
}

fn region_windows(p: f32) -> ([f32; 4], [f32; 4]) {
    let (s01, d01) = smoothstep(REGION_CENTRES[0], REGION_CENTRES[1], p);
    let (s12, d12) = smoothstep(REGION_CENTRES[1], REGION_CENTRES[2], p);
    let (s23, d23) = smoothstep(REGION_CENTRES[2], REGION_CENTRES[3], p);
    let (s3t, d3t) = smoothstep(REGION_CENTRES[3], AXIS_TOP, p);
    (
        [1.0 - s01, s01 - s12, s12 - s23, s23 - s3t],
        [-d01, d01 - d12, d12 - d23, d23 - d3t],
    )
}

fn dot4(a: &[f32; 4], b: &[f32; 4]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
}

/// Build the parametric curve from the four region sliders, CPU-side. Port of
/// `parametric::build_parametric_curve_from_sliders`.
pub(super) fn build_parametric_curve(
    shadows: f32,
    darks: f32,
    lights: f32,
    highlights: f32,
) -> PreparedCurve {
    let amps = [
        region_amplitude(shadows),
        region_amplitude(darks),
        region_amplitude(lights),
        region_amplitude(highlights),
    ];

    let mut knots: Vec<(f32, f32)> = Vec::with_capacity(PARAMETRIC_KNOT_COUNT);
    let mut tangents: Vec<f32> = Vec::with_capacity(PARAMETRIC_KNOT_COUNT);

    knots.push((0.0, 0.0));
    tangents.push(amps[0].exp2());

    for &p in &SAMPLE_AXIS {
        let x = axis_to_authoring_x(p);
        let (w, dw) = region_windows(p);
        let gain = dot4(&amps, &w).exp2();
        knots.push((x, x * gain));
        tangents.push(gain * (1.0 + AXIS_UNITS_PER_STOP * dot4(&amps, &dw)));
    }

    knots.push((1.0, 1.0));
    tangents.push(1.0);

    prepare_curve_with_tangents(knots, tangents)
}
