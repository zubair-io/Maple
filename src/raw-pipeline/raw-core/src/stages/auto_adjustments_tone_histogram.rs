//! Log-domain luma histogram for the AUTO tone calibration (#1376).
//!
//! Split out of `auto_adjustments_tone.rs` under the 600-LOC file budget; same
//! sibling `#[path]` pattern the rest of `stages/` uses.

use crate::image::{ColorSpace, Image};

/// Rec.2020 luma weights — the working color space of the probe buffer.
const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

/// Lowest EV (relative to mid-gray) the histogram resolves. Below −12 EV every
/// tone renders to display black regardless of what any slider does.
const EV_MIN: f32 = -12.0;
/// Highest EV (relative to mid-gray) the histogram resolves. Above the AgX
/// shoulder; specular highlights beyond this saturate into the top bin.
const EV_MAX: f32 = 8.0;
/// Bin count — 20 EV over 2048 bins ≈ 0.0098 EV per bin.
const LOG_BINS: usize = 2048;

/// Mid-gray anchor, shared with the exposure heuristic and AgX.
pub(crate) const MID_GRAY: f32 = 0.18;

/// A luma histogram binned in log2 EV relative to mid-gray.
///
/// The M0 prototype reused the linear `[0, 1]`-binned histogram, which saturates
/// EVERY scene value above 1.0 into the top bin — so on any frame with specular
/// highlights `p99.5` read back as ≈ 1.0 no matter how bright the highlights
/// really were, and the whites/highlights inversions were solving against a
/// censored statistic. Scene-linear buffers routinely carry values well above
/// 1.0 (post-DCP normalizes DIFFUSE white to ≈ 1.0, not peak white), so the log
/// binning is a correctness fix, not a resolution tweak.
pub(crate) struct LogLumaHistogram {
    bins: [u32; LOG_BINS],
    total: u64,
}

impl LogLumaHistogram {
    pub(crate) fn build(image: &Image) -> Self {
        image.assert_space(ColorSpace::SceneLinearRec2020);
        let mut bins = [0u32; LOG_BINS];
        let mut total = 0u64;
        for p in &image.pixels {
            let y = LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2];
            if !y.is_finite() {
                continue;
            }
            let idx = Self::bin_of(y);
            bins[idx] = bins[idx].saturating_add(1);
            total += 1;
        }
        Self { bins, total }
    }

    fn bin_of(y: f32) -> usize {
        // Non-positive luma (legitimate in a scene-referred buffer) lands in the
        // bottom bin, which is what a percentile lookup wants.
        let ev = if y > 0.0 {
            (y / MID_GRAY).log2()
        } else {
            EV_MIN
        };
        let scaled = ((ev - EV_MIN) / (EV_MAX - EV_MIN)) * LOG_BINS as f32;
        if !(scaled > 0.0) {
            0
        } else if scaled >= (LOG_BINS - 1) as f32 {
            LOG_BINS - 1
        } else {
            scaled as usize
        }
    }

    fn ev_of_bin(i: usize) -> f32 {
        EV_MIN + ((i as f32 + 0.5) / LOG_BINS as f32) * (EV_MAX - EV_MIN)
    }

    /// Scene-linear luma at quantile `q`. `None` on an empty histogram.
    pub(crate) fn percentile(&self, q: f32) -> Option<f32> {
        if self.total == 0 {
            return None;
        }
        let target = ((self.total as f64) * (q as f64)).ceil().max(1.0) as u64;
        let mut acc = 0u64;
        for (i, &c) in self.bins.iter().enumerate() {
            acc += c as u64;
            if acc >= target {
                return Some(MID_GRAY * Self::ev_of_bin(i).exp2());
            }
        }
        Some(MID_GRAY * Self::ev_of_bin(LOG_BINS - 1).exp2())
    }
}
