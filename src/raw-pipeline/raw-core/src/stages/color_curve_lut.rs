//! Shared CPU/GPU LUT baking; reusable per-thread spline scratch keeps
//! changed-point render ticks allocation-free after session warmup.
use std::cell::RefCell;

pub const COLOR_CURVE_LUT_LEN: usize = 256;
pub const NUM_COLOR_CURVES: usize = 6;
pub const EDITOR_MAX_KNOTS: usize = 16;

/// Baked 256-sample table of signed offsets $d(u) = y(u) - 0.5 \in [-0.5, +0.5]$ for one curve.
#[derive(Clone, Copy, Debug)]
pub struct ColorCurveLut {
    pub offsets: [f32; COLOR_CURVE_LUT_LEN],
    pub is_identity: bool,
}

impl Default for ColorCurveLut {
    fn default() -> Self {
        Self {
            offsets: [0.0; COLOR_CURVE_LUT_LEN],
            is_identity: true,
        }
    }
}

struct Scratch {
    knots: Vec<(f32, f32, usize)>,
    h: Vec<f32>,
    delta: Vec<f32>,
    m: Vec<f32>,
}
impl Default for Scratch {
    fn default() -> Self {
        Self {
            knots: Vec::with_capacity(EDITOR_MAX_KNOTS),
            h: Vec::with_capacity(EDITOR_MAX_KNOTS),
            delta: Vec::with_capacity(EDITOR_MAX_KNOTS),
            m: Vec::with_capacity(EDITOR_MAX_KNOTS),
        }
    }
}
thread_local! {
    static SCRATCH: RefCell<Scratch> = RefCell::new(Scratch::default());
}

pub fn bake_curve_lut(
    points: impl ExactSizeIterator<Item = (f32, f32)>,
    periodic: bool,
) -> ColorCurveLut {
    SCRATCH.with(|entry| {
        let mut scratch = entry.borrow_mut();
        let Scratch { knots, h, delta, m } = &mut *scratch;
        knots.clear();
        let input_len = points.len();
        knots.reserve(input_len);
        // Imports with initially coincident or neutral knots can spread out
        // during edits. Warm their full capacity before any early return.
        h.reserve(input_len.saturating_sub(h.len()));
        delta.reserve(input_len.saturating_sub(delta.len()));
        m.reserve(input_len.saturating_sub(m.len()));
        knots.extend(points.enumerate().filter_map(|(index, (x, y))| {
            if !x.is_finite() || !y.is_finite() {
                return None;
            }
            let x = if periodic {
                x.clamp(0.0, 1.0).rem_euclid(1.0)
            } else {
                x.clamp(0.0, 1.0)
            };
            Some((x, y.clamp(0.0, 1.0), index))
        }));
        if knots.is_empty() {
            return ColorCurveLut::default();
        }
        // The ordinal preserves the old stable-sort order at equal x, while
        // sort_unstable avoids allocating temporary merge storage for imports.
        knots.sort_unstable_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then(a.2.cmp(&b.2)));
        let mut count = 0;
        for index in 0..knots.len() {
            let point = knots[index];
            if count > 0 && (point.0 - knots[count - 1].0).abs() < 1e-5 {
                knots[count - 1] = point;
            } else {
                knots[count] = point;
                count += 1;
            }
        }
        knots.truncate(count);
        if knots.iter().all(|point| (point.1 - 0.5).abs() < 1e-6) {
            return ColorCurveLut::default();
        }
        if count == 1 {
            let offset = (knots[0].1 - 0.5).clamp(-0.5, 0.5);
            return ColorCurveLut {
                offsets: [offset; COLOR_CURVE_LUT_LEN],
                is_identity: offset.abs() < 1e-6,
            };
        }
        h.resize(count, 0.0);
        delta.resize(count, 0.0);
        m.resize(count, 0.0);
        m.fill(0.0);
        let mut offsets = [0.0; COLOR_CURVE_LUT_LEN];
        if periodic {
            bake_periodic_hermite(knots, &mut offsets, h, delta, m);
        } else {
            bake_clamped_hermite(knots, &mut offsets, h, delta, m);
        }
        ColorCurveLut {
            is_identity: offsets.iter().all(|d| d.abs() < 1e-6),
            offsets,
        }
    })
}

fn bake_periodic_hermite(
    knots: &[(f32, f32, usize)],
    offsets: &mut [f32; COLOR_CURVE_LUT_LEN],
    h: &mut [f32],
    delta: &mut [f32],
    m: &mut [f32],
) {
    let n = knots.len();
    for k in 0..n {
        let next = (k + 1) % n;
        let hk = if k + 1 < n {
            knots[next].0 - knots[k].0
        } else {
            (knots[0].0 + 1.0) - knots[k].0
        };
        let hk = hk.max(1e-5);
        h[k] = hk;
        delta[k] = (knots[next].1 - knots[k].1) / hk;
    }

    for k in 0..n {
        let prev = (k + n - 1) % n;
        let dl = delta[prev];
        let dr = delta[k];
        if dl * dr > 0.0 {
            let hl = h[prev];
            let hr = h[k];
            let w1 = 2.0 * hr + hl;
            let w2 = hr + 2.0 * hl;
            m[k] = (w1 + w2) / (w1 / dl + w2 / dr);
        }
    }
    // Fritsch-Carlson monotonicity clamp per circular segment.
    for k in 0..n {
        let next = (k + 1) % n;
        let dk = delta[k];
        if dk.abs() < 1e-7 {
            m[k] = 0.0;
            m[next] = 0.0;
        } else {
            let alpha = m[k] / dk;
            let beta = m[next] / dk;
            let r2 = alpha * alpha + beta * beta;
            if r2 > 9.0 {
                let tau = 3.0 / r2.sqrt();
                m[k] = tau * alpha * dk;
                m[next] = tau * beta * dk;
            }
        }
    }

    for (i, slot) in offsets.iter_mut().enumerate() {
        let u = i as f32 / COLOR_CURVE_LUT_LEN as f32;
        // Locate segment k containing u on the circle [0, 1).
        let (k, local_u) = if u < knots[0].0 {
            (n - 1, u + 1.0 - knots[n - 1].0)
        } else {
            let mut seg = n - 1;
            for s in 0..(n - 1) {
                if u >= knots[s].0 && u < knots[s + 1].0 {
                    seg = s;
                    break;
                }
            }
            (seg, u - knots[seg].0)
        };
        let next = (k + 1) % n;
        let t = (local_u / h[k]).clamp(0.0, 1.0);
        let y = hermite(t, knots[k].1, knots[next].1, h[k] * m[k], h[k] * m[next]);
        *slot = (y.clamp(0.0, 1.0) - 0.5).clamp(-0.5, 0.5);
    }
}

fn bake_clamped_hermite(
    knots: &[(f32, f32, usize)],
    offsets: &mut [f32; COLOR_CURVE_LUT_LEN],
    h: &mut [f32],
    delta: &mut [f32],
    m: &mut [f32],
) {
    let n = knots.len();
    for k in 0..(n - 1) {
        let hk = (knots[k + 1].0 - knots[k].0).max(1e-5);
        h[k] = hk;
        delta[k] = (knots[k + 1].1 - knots[k].1) / hk;
    }

    m[0] = delta[0];
    m[n - 1] = delta[n - 2];
    for k in 1..(n - 1) {
        let dl = delta[k - 1];
        let dr = delta[k];
        if dl * dr > 0.0 {
            let hl = h[k - 1];
            let hr = h[k];
            let w1 = 2.0 * hr + hl;
            let w2 = hr + 2.0 * hl;
            m[k] = (w1 + w2) / (w1 / dl + w2 / dr);
        }
    }
    for k in 0..(n - 1) {
        let dk = delta[k];
        if dk.abs() < 1e-7 {
            m[k] = 0.0;
            m[k + 1] = 0.0;
        } else {
            let alpha = m[k] / dk;
            let beta = m[k + 1] / dk;
            let r2 = alpha * alpha + beta * beta;
            if r2 > 9.0 {
                let tau = 3.0 / r2.sqrt();
                m[k] = tau * alpha * dk;
                m[k + 1] = tau * beta * dk;
            }
        }
    }

    for (i, slot) in offsets.iter_mut().enumerate() {
        let u = i as f32 / (COLOR_CURVE_LUT_LEN - 1) as f32;
        let y = if u <= knots[0].0 {
            knots[0].1
        } else if u >= knots[n - 1].0 {
            knots[n - 1].1
        } else {
            let mut seg = n - 2;
            for s in 0..(n - 1) {
                if u >= knots[s].0 && u <= knots[s + 1].0 {
                    seg = s;
                    break;
                }
            }
            let t = ((u - knots[seg].0) / h[seg]).clamp(0.0, 1.0);
            hermite(
                t,
                knots[seg].1,
                knots[seg + 1].1,
                h[seg] * m[seg],
                h[seg] * m[seg + 1],
            )
        };
        *slot = (y.clamp(0.0, 1.0) - 0.5).clamp(-0.5, 0.5);
    }
}

#[inline]
fn hermite(t: f32, y0: f32, y1: f32, m0: f32, m1: f32) -> f32 {
    let t2 = t * t;
    let t3 = t2 * t;
    let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
    let h10 = t3 - 2.0 * t2 + t;
    let h01 = -2.0 * t3 + 3.0 * t2;
    let h11 = t3 - t2;
    h00 * y0 + h10 * m0 + h01 * y1 + h11 * m1
}
