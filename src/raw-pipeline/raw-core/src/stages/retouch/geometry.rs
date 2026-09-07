//! Spot geometry: where a spot's pixels live in the frame, and whether that
//! footprint fits inside the buffer a given render path is holding.
//!
//! Everything here is integer pixel arithmetic in FRAME coordinates — the
//! DefaultCrop'd, unrotated buffer the develop chain hands the stage. A
//! buffer that is a window of that frame (the tile path) is described by an
//! origin and the frame extent, exactly as `stages::local_adjustments`
//! describes its own window.

use crate::types::retouch::RetouchSpot;

/// The pixel footprint of one spot: a common offset range around both
/// centres, so destination and source sample the same grid.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct SpotFootprint {
    /// Destination centre in frame pixels.
    pub center: (i32, i32),
    /// Source centre in frame pixels.
    pub source: (i32, i32),
    /// Inclusive offset range shared by both centres.
    pub off_x: (i32, i32),
    pub off_y: (i32, i32),
    /// Disc radius in pixels (`> 0`).
    pub radius_px: f32,
    /// Gaussian sigma for the heal low/high split.
    pub sigma: f32,
}

impl SpotFootprint {
    pub(super) fn width(&self) -> usize {
        (self.off_x.1 - self.off_x.0 + 1) as usize
    }
    pub(super) fn height(&self) -> usize {
        (self.off_y.1 - self.off_y.0 + 1) as usize
    }

    /// Frame-pixel bounds `(x0, y0, x1, y1)` inclusive, of the destination
    /// patch and the source patch together — the region a render path has to
    /// hold in memory for this spot to be reproducible.
    pub(super) fn bounds(&self) -> (i32, i32, i32, i32) {
        let x0 = (self.center.0 + self.off_x.0).min(self.source.0 + self.off_x.0);
        let x1 = (self.center.0 + self.off_x.1).max(self.source.0 + self.off_x.1);
        let y0 = (self.center.1 + self.off_y.0).min(self.source.1 + self.off_y.0);
        let y1 = (self.center.1 + self.off_y.1).max(self.source.1 + self.off_y.1);
        (x0, y0, x1, y1)
    }

    /// Destination-only bounds — used to decide whether a spot touches a
    /// window at all before asking whether its whole footprint fits.
    pub(super) fn dest_bounds(&self) -> (i32, i32, i32, i32) {
        (
            self.center.0 + self.off_x.0,
            self.center.1 + self.off_y.0,
            self.center.0 + self.off_x.1,
            self.center.1 + self.off_y.1,
        )
    }
}

/// The heal split's Gaussian sigma as a fraction of the disc radius. Half
/// the radius puts the low/high crossover at roughly the scale of the blemish
/// being covered: coarser than that and the source's own tonality bleeds in,
/// finer and the destination's colour is not carried at all.
const HEAL_SIGMA_FRACTION: f32 = 0.5;
/// Blur reach in sigmas. `gaussian_kernel_1d` truncates at 3σ, so a patch
/// padded by this much sees no border clamping inside the disc itself.
const BLUR_REACH_SIGMAS: f32 = 3.0;

/// Resolve `spot` against a frame of `full` pixels. `None` when the spot
/// cannot change a pixel — degenerate parameters, a radius that rounds to
/// nothing, or centres so close to opposite edges that no common offset
/// range survives.
pub(super) fn footprint(spot: &RetouchSpot, full: (u32, u32)) -> Option<SpotFootprint> {
    if !spot.is_effective() {
        return None;
    }
    let (fw, fh) = (full.0 as i32, full.1 as i32);
    if fw <= 0 || fh <= 0 {
        return None;
    }
    // Same normalisation as `stages::local_adjustments`: pixel `i` sits at
    // `i / (dim - 1)`, so 0 and 1 land exactly on the first and last pixel.
    let span_x = (fw - 1).max(0) as f32;
    let span_y = (fh - 1).max(0) as f32;
    let center = (
        (spot.center.x * span_x).round() as i32,
        (spot.center.y * span_y).round() as i32,
    );
    let source = (
        (spot.source.x * span_x).round() as i32,
        (spot.source.y * span_y).round() as i32,
    );
    // Radius is a fraction of the frame WIDTH and is used on both axes, so
    // the disc is a circle in pixels rather than in normalised space.
    let radius_px = spot.radius * fw as f32;
    if !(radius_px >= 0.5) {
        return None;
    }
    let sigma = (radius_px * HEAL_SIGMA_FRACTION).max(0.5);
    let half = (radius_px.ceil() as i32) + (sigma * BLUR_REACH_SIGMAS).ceil() as i32;

    // The offset range both centres can walk without leaving the frame. A
    // spot near an edge simply gets a shorter patch on that side — the
    // "clamped to the image" behaviour, expressed once for both discs so
    // destination and source always index the same grid.
    let off_x = clamped_offsets(half, center.0, source.0, fw)?;
    let off_y = clamped_offsets(half, center.1, source.1, fh)?;
    Some(SpotFootprint {
        center,
        source,
        off_x,
        off_y,
        radius_px,
        sigma,
    })
}

/// Inclusive `[lo, hi]` offsets around both `a` and `b` that stay inside
/// `0..dim`. `None` when the range is empty (a centre outside the frame far
/// enough that nothing overlaps).
fn clamped_offsets(half: i32, a: i32, b: i32, dim: i32) -> Option<(i32, i32)> {
    let lo = (-half).max(-a).max(-b);
    let hi = half.min(dim - 1 - a).min(dim - 1 - b);
    if lo > hi {
        None
    } else {
        Some((lo, hi))
    }
}

/// Whether `bounds` (inclusive frame-pixel rect) lies wholly inside the
/// buffer that starts at `origin` and is `w × h` pixels.
pub(super) fn fits_window(
    bounds: (i32, i32, i32, i32),
    origin: (i32, i32),
    w: usize,
    h: usize,
) -> bool {
    let (x0, y0, x1, y1) = bounds;
    x0 >= origin.0
        && y0 >= origin.1
        && x1 <= origin.0 + w as i32 - 1
        && y1 <= origin.1 + h as i32 - 1
}

/// Whether `bounds` overlaps the buffer at all.
pub(super) fn overlaps_window(
    bounds: (i32, i32, i32, i32),
    origin: (i32, i32),
    w: usize,
    h: usize,
) -> bool {
    let (x0, y0, x1, y1) = bounds;
    x1 >= origin.0
        && y1 >= origin.1
        && x0 <= origin.0 + w as i32 - 1
        && y0 <= origin.1 + h as i32 - 1
}
