//! Clone / heal repair stage (#3409).
//!
//! Applies `AdjustmentModel.retouch_spots` to the scene-linear Rec.2020
//! buffer as a **decode-product** edit: it runs immediately after DCP
//! colorimetry and post-DCP highlight recovery, upstream of the chroma
//! pre-filter, so the repaired pixels are denoised, sharpened, exposed and
//! graded exactly like the sensor data around them, and so a slider tick
//! never re-runs the patch work. Changing the spot list therefore
//! invalidates the decoded-image caches, the same family
//! `chroma_prefilter` / `deep_denoise` / the lens corrections belong to
//! (`docs/caching.md`).
//!
//! Per spot, in list order:
//!
//! 1. Resolve the destination and source discs to a common pixel grid,
//!    clamped so neither patch leaves the frame ([`geometry`]).
//! 2. Build the replacement — `Clone` copies the source patch, `Heal`
//!    puts the source's high-frequency detail on the destination's own
//!    low-frequency colour via a Gaussian split ([`patch`]).
//! 3. Composite it through a feathered circular coverage scaled by opacity.
//!
//! Spots are sequential by construction: each reads the buffer as the
//! previous spot left it, so a spot may legitimately source from an area an
//! earlier spot repaired. Within one spot the two patches are copied out
//! before anything is written back, so an overlapping source and destination
//! is still order-independent.
//!
//! **Identity.** An empty list returns before touching a pixel, which keeps
//! every existing colour-parity budget bit-identical.
//!
//! **Windowed renders.** [`apply_windowed`] takes the buffer's origin in the
//! frame the way `stages::local_adjustments` does. Unlike a mask, a repair
//! spot is not a point operation — it reads a whole neighbourhood, and its
//! source can sit anywhere in the frame — so a window that holds only part
//! of a spot's footprint cannot reproduce it. Such a tile is REFUSED loudly
//! rather than rendered without the repair, matching how the tile path
//! already refuses dehaze and deep denoise. A tile no spot reaches renders
//! normally.

use crate::error::{Error, Result};
use crate::image::{ColorSpace, Image};
use crate::types::retouch::RetouchSpot;

mod geometry;
mod patch;

/// Apply every spot to the whole frame. Infallible in practice — the
/// full-frame window contains every clamped footprint by construction — but
/// returns `Result` so callers share one shape with [`apply_windowed`].
pub fn apply(img: &mut Image, spots: &[RetouchSpot]) -> Result<()> {
    let full = (img.width, img.height);
    apply_windowed(img, spots, (0, 0), full)
}

/// [`apply`] for a buffer that is a window of the frame: the buffer's pixel
/// `(x, y)` is frame pixel `origin + (x, y)`, and spot coordinates normalise
/// against `full`. `origin` is signed because a tile's padded crop can start
/// before the frame origin.
///
/// Returns `Err` when a spot's footprint overlaps this window but is not
/// wholly inside it.
pub fn apply_windowed(
    img: &mut Image,
    spots: &[RetouchSpot],
    origin: (i32, i32),
    full: (u32, u32),
) -> Result<()> {
    if spots.is_empty() {
        return Ok(());
    }
    img.assert_space(ColorSpace::SceneLinearRec2020);
    let (w, h) = (img.width as usize, img.height as usize);
    if w == 0 || h == 0 {
        return Ok(());
    }
    for (index, spot) in spots.iter().enumerate() {
        let Some(fp) = geometry::footprint(spot, full) else {
            continue;
        };
        if !geometry::overlaps_window(fp.dest_bounds(), origin, w, h) {
            continue;
        }
        let bounds = fp.bounds();
        if !geometry::fits_window(bounds, origin, w, h) {
            return Err(Error::Pipeline(format!(
                "retouch spot {index} does not fit this render window: its destination and \
                 source patches span frame pixels ({}, {})–({}, {}) but the buffer covers \
                 ({}, {})–({}, {}). A repair spot is not a point operation — render the \
                 whole image instead of this tile. See #3409.",
                bounds.0,
                bounds.1,
                bounds.2,
                bounds.3,
                origin.0,
                origin.1,
                origin.0 + w as i32 - 1,
                origin.1 + h as i32 - 1,
            )));
        }
        patch::apply_footprint(img, spot, &fp, origin);
    }
    Ok(())
}

/// True when at least one spot in `spots` would change a pixel of a frame
/// this size. The tile entry's guard uses it to refuse before any decode
/// work, and hosts use it to decide whether the repair panel shows a
/// modified marker.
pub fn has_effective_spots(spots: &[RetouchSpot], full: (u32, u32)) -> bool {
    spots.iter().any(|s| geometry::footprint(s, full).is_some())
}

#[cfg(test)]
mod tests;
