//! Stateless zoom rules: the fit/fill detents, the zoom-step targets, the
//! named stops the badge cycles, and the focal-anchored pan derivations.

use super::geometry::{Point, Size};
use super::zoom::{
    DETENT_TOLERANCE, MAX_PIXEL_SCALE, MIN_EXPLICIT_ZOOM, MIN_FIT_FRACTION, ZOOM_STEP,
};

/// A named zoom level a user reaches deliberately.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ZoomStop {
    /// The whole image inside the viewport (`pixel_scale` 0).
    Fit,
    /// The image covers the whole viewport (no letterbox).
    Fill,
    /// 100%: one image pixel per real screen pixel.
    ActualSize,
}

/// Up to three distinct stops in cycle order — a fixed-capacity list so the
/// per-gesture path never allocates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZoomStops {
    stops: [ZoomStop; 3],
    len: usize,
}

impl ZoomStops {
    /// The first three of `stops`; any beyond that are dropped.
    #[must_use]
    pub fn from_slice(stops: &[ZoomStop]) -> Self {
        let kept = &stops[..stops.len().min(3)];
        let mut out = [ZoomStop::Fit; 3];
        out[..kept.len()].copy_from_slice(kept);
        Self {
            stops: out,
            len: kept.len(),
        }
    }

    #[must_use]
    pub fn as_slice(&self) -> &[ZoomStop] {
        &self.stops[..self.len]
    }

    #[must_use]
    pub fn contains(&self, stop: ZoomStop) -> bool {
        self.as_slice().contains(&stop)
    }
}

/// Outcome of a zoom-out step.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ZoomOutResult {
    /// Return to fit mode (pixel scale 0, pans cleared).
    SnapToFit,
    Scale(f64),
}

/// `|scale / stop − 1|`, infinite for a non-positive stop.
fn relative_distance(scale: f64, stop: f64) -> f64 {
    if stop > 0.0 {
        (scale / stop - 1.0).abs()
    } else {
        f64::INFINITY
    }
}

/// The fit or fill stop `scale` sits within `DETENT_TOLERANCE` of — the nearer
/// one when both bands overlap, fit on a tie. `None` outside both bands.
#[must_use]
pub fn detent(scale: f64, fit: f64, fill: f64) -> Option<ZoomStop> {
    let fit_distance = relative_distance(scale, fit);
    let fill_distance = relative_distance(scale, fill);
    let (stop, distance) = if fit_distance <= fill_distance {
        (ZoomStop::Fit, fit_distance)
    } else {
        (ZoomStop::Fill, fill_distance)
    };
    (distance <= DETENT_TOLERANCE).then_some(stop)
}

/// Live pinch scale: `start × magnification` (magnification is cumulative
/// since the gesture began) clamped to `fit × MIN_FIT_FRACTION …
/// MAX_PIXEL_SCALE`. No detent applies while the fingers are down — snapping
/// onto fit or fill mid-gesture jumped the image — so the scale follows the
/// fingers continuously and the release settles it (`pinch_ended`). A NaN
/// product resolves to fit. The floor is applied last, so on an image so small
/// that half of fit exceeds the cap, the floor wins.
#[must_use]
pub fn pinch_scale(start: f64, magnification: f64, fit: f64) -> f64 {
    let product = start * magnification;
    if product.is_nan() {
        return fit;
    }
    product.min(MAX_PIXEL_SCALE).max(fit * MIN_FIT_FRACTION)
}

/// True when a discrete zoom `current → next` reaches fit's detent band from
/// the far side, so the step settles on fit instead of jumping over it.
/// Starting exactly at fit is never a crossing, and the band only captures a
/// step moving toward fit.
#[must_use]
pub fn crosses_fit(current: f64, next: f64, fit: f64) -> bool {
    if next < current {
        current > fit && next <= fit * (1.0 + DETENT_TOLERANCE)
    } else {
        current < fit && next >= fit * (1.0 - DETENT_TOLERANCE)
    }
}

/// A programmatic zoom target (toolbar "100%", ⌘1) clamped to
/// `MIN_EXPLICIT_ZOOM … MAX_PIXEL_SCALE`, so a programmatic 0 or NaN cannot
/// silently re-enter fit mode.
// `f64::clamp` would return NaN for a NaN scale; max/min resolves it to the floor.
#[allow(clippy::manual_clamp)]
#[must_use]
pub fn clamped_explicit_zoom(scale: f64) -> f64 {
    scale.max(MIN_EXPLICIT_ZOOM).min(MAX_PIXEL_SCALE)
}

/// The scale after one zoom-in step.
#[must_use]
pub fn zoom_in_target(current: f64) -> f64 {
    (current * ZOOM_STEP).min(MAX_PIXEL_SCALE)
}

/// One zoom-out step from `current`: a step from above fit that lands in (or
/// past) fit's band settles on fit; otherwise it divides by `ZOOM_STEP`, down
/// to `fit × MIN_FIT_FRACTION`.
#[must_use]
pub fn zoom_out_target(current: f64, fit: f64) -> ZoomOutResult {
    let next = current / ZOOM_STEP;
    if crosses_fit(current, next, fit) {
        ZoomOutResult::SnapToFit
    } else {
        ZoomOutResult::Scale(next.max(fit * MIN_FIT_FRACTION))
    }
}

/// The cycle `fit → fill → 100%`, dropping any stop within the detent band of
/// an earlier kept one (an image matching the viewport aspect has no separate
/// fill; a small image may fit at 100%). `actual_size` is the 100% stop's
/// scale, or `None` on a surface without one.
#[must_use]
pub fn distinct_stops(fit: f64, fill: f64, actual_size: Option<f64>) -> ZoomStops {
    let candidates = [
        Some((ZoomStop::Fit, fit)),
        Some((ZoomStop::Fill, fill)),
        actual_size.map(|scale| (ZoomStop::ActualSize, scale)),
    ];
    let mut stops = [ZoomStop::Fit; 3];
    let mut kept_scales = [0.0; 3];
    let mut len = 0;
    for (stop, scale) in candidates.into_iter().flatten() {
        let is_distinct = kept_scales[..len]
            .iter()
            .all(|&earlier| relative_distance(scale, earlier) > DETENT_TOLERANCE);
        if is_distinct {
            stops[len] = stop;
            kept_scales[len] = scale;
            len += 1;
        }
    }
    ZoomStops { stops, len }
}

/// The stop after `current` in `stops`, wrapping; a free scale (`None`) or a
/// stop not in the list returns to fit.
#[must_use]
pub fn next_stop(current: Option<ZoomStop>, stops: &[ZoomStop]) -> ZoomStop {
    current
        .and_then(|stop| stops.iter().position(|&candidate| candidate == stop))
        .map_or(ZoomStop::Fit, |index| stops[(index + 1) % stops.len()])
}

/// Pan that keeps the image point under `anchor` (viewport points) fixed
/// across `start_scale → new_scale`. With `C` the viewport centre:
/// `p₁ = (q − C) − ((q − C) − p₀)·(s₁/s₀)`; the display scale and the image
/// size cancel. A non-positive `start_scale` returns `start_pan`.
#[must_use]
pub fn anchored_pan(
    anchor: Point,
    viewport_points: Size,
    start_pan: Size,
    start_scale: f64,
    new_scale: f64,
) -> Size {
    live_pinch_pan(
        anchor,
        anchor,
        start_pan,
        start_scale,
        new_scale,
        viewport_points,
    )
}

/// Pan that keeps the image point under the gesture's START centroid under
/// the LIVE centroid across `start_scale → new_scale`:
/// `pan = a_live − (a_start − start_pan)·(new/start)`, `a = centroid − centre`.
/// Always derived from the start values, so per-frame clamping cannot drift
/// the anchor. A non-positive `start_scale` returns `start_pan`.
#[must_use]
pub fn live_pinch_pan(
    live_centroid: Point,
    start_centroid: Point,
    start_pan: Size,
    start_scale: f64,
    new_scale: f64,
    viewport_points: Size,
) -> Size {
    if start_scale.is_nan() || start_scale <= 0.0 {
        return start_pan;
    }
    let half_width = viewport_points.width / 2.0;
    let half_height = viewport_points.height / 2.0;
    let ratio = new_scale / start_scale;
    Size::new(
        (live_centroid.x - half_width)
            - ((start_centroid.x - half_width) - start_pan.width) * ratio,
        (live_centroid.y - half_height)
            - ((start_centroid.y - half_height) - start_pan.height) * ratio,
    )
}

#[cfg(test)]
#[path = "zoom_rules_tests.rs"]
mod tests;
