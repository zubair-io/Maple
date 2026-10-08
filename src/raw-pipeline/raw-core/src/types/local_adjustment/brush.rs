//! Brush (painted) masks (#360): an ordered dab series on disk, a bitmap in
//! memory.
//!
//! The authored stroke is an ordered dab series in Maple's own
//! `papp:BrushCorrections` container (versioned by [`BRUSH_VERSION`];
//! Lightroom's `crs:PaintBasedCorrections` is passthrough, never modelled);
//! evaluation reads a
//! rasterized bitmap through the same registry + GPU-plane substrate
//! `Mask::Bitmap` uses (#3282), rasterized once per EDIT — never per frame.
//! The raster is derived data: the sidecar carries dabs, never pixels, and an
//! unresolved brush (`raster_id == 0`, nothing registered yet) evaluates to
//! weight 0, never a silent global correction.

use std::borrow::Cow;
use std::sync::Arc;

use super::{Mask, MaskRaster, Point2};
use crate::stages::local_adjustments::mask::resolve;
use crate::types::AdjustmentModel;

/// The `papp:BrushVersion` every brush leaf carries. A reader drops a leaf
/// with any other version rather than misreading a newer dab encoding.
pub const BRUSH_VERSION: u32 = 1;

/// Long edge of a brush raster in texels. Hosts size brush rasters
/// aspect-preserving at this long edge (see [`brush_raster_dims`]) — the same
/// 1024 the Vision person/skin path registers at, so both bitmap-mask sources
/// share one resolution policy. A soft brush mask carries no high-frequency
/// detail, so 1024 resolves every stroke while keeping the GPU mask plane
/// (~4 MB f32) far under its 2²⁴-texel ceiling.
pub const BRUSH_RASTER_LONG_EDGE: u32 = 1024;

/// Aspect-preserving raster dims for an image, long edge
/// [`BRUSH_RASTER_LONG_EDGE`], each dim at least 1. Hosts mirror this exact
/// formula when they size the raster they pass to the rasterize entries, so
/// every platform rasterizes the same dab series onto the same grid.
pub fn brush_raster_dims(image_width: u32, image_height: u32) -> (u32, u32) {
    let long = u64::from(BRUSH_RASTER_LONG_EDGE);
    let short = |a: u32, b: u32| {
        ((u64::from(a) * long / u64::from(b)).max(1) as u32).min(BRUSH_RASTER_LONG_EDGE)
    };
    let (w, h) = (image_width.max(1), image_height.max(1));
    if w >= h {
        (BRUSH_RASTER_LONG_EDGE, short(h, w))
    } else {
        (short(w, h), BRUSH_RASTER_LONG_EDGE)
    }
}

/// One brush stamp in a [`Mask::Brush`](super::Mask::Brush) dab series.
///
/// `center` is normalized `[0, 1]` over the full oriented image, origin
/// top-left — the same frame every other mask variant uses. `radius` is a
/// fraction of the image WIDTH (the retouch brush's own convention), and the
/// stamp is circular in pixel space: the rasterizer knows the raster dims, so
/// — unlike the normalized-space radial ellipse — no UI aspect pre-correction
/// is needed. `feather` is the soft-edge fraction of the radius (`0` = hard
/// disc, `1` = falloff from the centre out), the same profile convention as
/// `Mask::Radial`. `weight` (`0..=1`) is the dab's peak value — the
/// pressure→flow modulation the stroke capture records. `erase` dabs subtract
/// (`acc × (1 − v)`) instead of adding (`acc + (1 − acc) × v`), so one series
/// holds paint and erase strokes together and undo stays a dab-vector splice.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BrushDab {
    pub center: Point2,
    pub radius: f32,
    pub feather: f32,
    pub weight: f32,
    pub erase: bool,
}

impl BrushDab {
    pub fn new(center: Point2, radius: f32, feather: f32, weight: f32, erase: bool) -> Self {
        Self {
            center,
            radius,
            feather,
            weight,
            erase,
        }
    }
}

#[inline]
fn smoothstep(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Rasterize `dabs` onto a `width × height` R8 grid (row-major, `0` = weight
/// 0, `255` = weight 1) — the bytes hosts register via
/// `maple_mask_raster_register` / wasm `mask_raster_register` and the render
/// then samples through `MaskRaster::sample`.
///
/// Texel `(x, y)` sits at integer centre coordinates on a
/// `(width − 1) × (height − 1)` grid, matching `MaskRaster::sample`'s own
/// `(dim − 1)` convention, so a dab centred at normalized `(0, 0)` peaks
/// exactly on the first texel. Radius is a LENGTH, not a position, so it
/// scales by the full extent (`radius × width`), not `width − 1`.
///
/// Each dab stamps only its own bounding box — never a full-image pass — so a
/// long stroke of hundreds of dabs rasterizes in milliseconds. Dabs with a
/// non-finite field, non-positive radius, or non-positive weight are skipped:
/// the XMP parsers already reject non-finite numbers, so this is belt-and-
/// braces for the FFI/wasm dab wires rather than a second validation layer.
pub fn rasterize_brush(dabs: &[BrushDab], width: u32, height: u32) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    let mut acc = vec![0.0f32; w.saturating_mul(h)];
    if w == 0 || h == 0 {
        return Vec::new();
    }
    for dab in dabs {
        stamp_dab(dab, &mut acc, w, h);
    }
    acc.iter()
        .map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)
        .collect()
}

fn stamp_dab(dab: &BrushDab, acc: &mut [f32], w: usize, h: usize) {
    let r_px = dab.radius * w as f32;
    if !dab.center.x.is_finite()
        || !dab.center.y.is_finite()
        || !dab.radius.is_finite()
        || !dab.feather.is_finite()
        || !dab.weight.is_finite()
        || r_px <= 0.0
        || dab.weight <= 0.0
    {
        return;
    }
    let cx = dab.center.x * (w as f32 - 1.0).max(0.0);
    let cy = dab.center.y * (h as f32 - 1.0).max(0.0);
    let feather = dab.feather.clamp(0.0, 1.0);
    let weight = dab.weight.clamp(0.0, 1.0);
    let x0 = (cx - r_px).floor().clamp(0.0, w as f32 - 1.0) as usize;
    let x1 = (cx + r_px).ceil().clamp(0.0, w as f32 - 1.0) as usize;
    let y0 = (cy - r_px).floor().clamp(0.0, h as f32 - 1.0) as usize;
    let y1 = (cy + r_px).ceil().clamp(0.0, h as f32 - 1.0) as usize;
    for y in y0..=y1 {
        for x in x0..=x1 {
            let dx = x as f32 - cx;
            let dy = y as f32 - cy;
            let d = dx.hypot(dy) / r_px;
            // Same profile as `mask::radial_weight`: full strength inside
            // `(1 − feather)` of the radius, smoothstep falloff to the edge.
            let profile = if feather <= f32::EPSILON {
                if d <= 1.0 {
                    1.0
                } else {
                    0.0
                }
            } else {
                1.0 - smoothstep((d - (1.0 - feather)) / feather)
            };
            let v = profile * weight;
            if v <= 0.0 {
                continue;
            }
            let slot = &mut acc[y * w + x];
            *slot = if dab.erase {
                *slot * (1.0 - v)
            } else {
                *slot + (1.0 - *slot) * v
            };
        }
    }
}

/// The model a develop or export entry renders: `model` itself when every
/// brush layer already resolves against `model.mask_rasters` (the host
/// registered its raster, or there is no brush), else a copy whose
/// unresolved brushes are rasterized once onto the
/// [`brush_raster_dims`] grid for an `image_width × image_height` oriented
/// frame and attached under the next unused id. Headless callers (the API's sidecar
/// derivatives, `maple-cli`, Windows exports) have no host registry, so this
/// is what makes a brush render there exactly as the editor's registered
/// raster does. Called once per render, never from the per-pixel stage.
pub fn with_brush_rasters(
    model: &AdjustmentModel,
    image_width: u32,
    image_height: u32,
) -> Cow<'_, AdjustmentModel> {
    let unresolved = |mask: &Mask| {
        matches!(mask, Mask::Brush { dabs, .. } if !dabs.is_empty())
            && resolve(mask, &model.mask_rasters).is_none()
    };
    if !model.local_adjustments.iter().any(|l| unresolved(&l.mask)) {
        return Cow::Borrowed(model);
    }
    let (width, height) = brush_raster_dims(image_width, image_height);
    let mut owned = model.clone();
    let AdjustmentModel {
        local_adjustments,
        mask_rasters,
        ..
    } = &mut owned;
    for layer in local_adjustments.iter_mut() {
        if !unresolved(&layer.mask) {
            continue;
        }
        let Mask::Brush {
            dabs,
            digest,
            raster_id,
        } = &mut layer.mask
        else {
            continue;
        };
        // Ids count up from the largest in use: the flat render wire carries
        // them as f32, exact only below 2^24.
        let id = mask_rasters.iter().map(|r| r.id).max().unwrap_or(0) + 1;
        let bytes = rasterize_brush(dabs, width, height);
        mask_rasters.push(Arc::new(MaskRaster::from_u8(
            id, digest, width, height, &bytes,
        )));
        *raster_id = id;
    }
    Cow::Owned(owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dab(x: f32, y: f32, radius: f32, feather: f32, weight: f32, erase: bool) -> BrushDab {
        BrushDab::new(Point2::new(x, y), radius, feather, weight, erase)
    }

    fn at(bytes: &[u8], w: usize, x: usize, y: usize) -> u8 {
        bytes[y * w + x]
    }

    #[test]
    fn raster_dims_follow_the_1024_long_edge() {
        assert_eq!(brush_raster_dims(6000, 4000), (1024, 682));
        assert_eq!(brush_raster_dims(4000, 6000), (682, 1024));
        assert_eq!(brush_raster_dims(1024, 1024), (1024, 1024));
        assert_eq!(brush_raster_dims(0, 0), (1024, 1024));
        assert_eq!(brush_raster_dims(10_000, 10), (1024, 1));
    }

    #[test]
    fn single_dab_peaks_at_its_weight_on_its_centre_texel() {
        let bytes = rasterize_brush(&[dab(0.5, 0.5, 0.2, 0.5, 0.6, false)], 101, 101);
        assert_eq!(at(&bytes, 101, 50, 50), (0.6f32 * 255.0).round() as u8);
    }

    #[test]
    fn hard_dab_is_a_disc_with_no_falloff() {
        let bytes = rasterize_brush(&[dab(0.5, 0.5, 0.1, 0.0, 1.0, false)], 101, 101);
        // r_px = 10.1: (50±10, 50) inside, (50±11, 50) outside.
        assert_eq!(at(&bytes, 101, 40, 50), 255);
        assert_eq!(at(&bytes, 101, 60, 50), 255);
        assert_eq!(at(&bytes, 101, 39, 50), 0);
        assert_eq!(at(&bytes, 101, 61, 50), 0);
    }

    #[test]
    fn feather_rolls_off_monotonically_to_the_edge() {
        let bytes = rasterize_brush(&[dab(0.5, 0.5, 0.2, 1.0, 1.0, false)], 101, 101);
        let row: Vec<u8> = (50..=71).map(|x| at(&bytes, 101, x, 50)).collect();
        assert_eq!(row[0], 255);
        assert!(row.windows(2).all(|w| w[0] >= w[1]), "row: {row:?}");
        assert_eq!(*row.last().unwrap(), 0);
    }

    #[test]
    fn overlapping_paint_dabs_accumulate_like_flow() {
        let one = dab(0.5, 0.5, 0.2, 0.0, 0.5, false);
        let bytes = rasterize_brush(&[one, one], 101, 101);
        assert_eq!(at(&bytes, 101, 50, 50), (0.75f32 * 255.0).round() as u8);
    }

    #[test]
    fn erase_dab_removes_what_paint_laid_down() {
        let bytes = rasterize_brush(
            [
                dab(0.5, 0.5, 0.2, 0.0, 1.0, false),
                dab(0.5, 0.5, 0.2, 0.0, 1.0, true),
            ]
            .as_slice(),
            101,
            101,
        );
        assert!(bytes.iter().all(|b| *b == 0));
    }

    #[test]
    fn partial_erase_scales_the_accumulation() {
        let bytes = rasterize_brush(
            [
                dab(0.5, 0.5, 0.2, 0.0, 1.0, false),
                dab(0.5, 0.5, 0.2, 0.0, 0.5, true),
            ]
            .as_slice(),
            101,
            101,
        );
        assert_eq!(at(&bytes, 101, 50, 50), (0.5f32 * 255.0).round() as u8);
    }

    #[test]
    fn empty_series_and_empty_grid_stay_zero() {
        assert!(rasterize_brush(&[], 64, 64).iter().all(|b| *b == 0));
        assert!(rasterize_brush(&[dab(0.5, 0.5, 0.2, 0.5, 1.0, false)], 0, 64).is_empty());
    }

    #[test]
    fn off_image_dabs_clip_without_panicking() {
        let bytes = rasterize_brush(&[dab(-0.5, -0.5, 0.8, 0.5, 1.0, false)], 51, 51);
        assert_eq!(bytes.len(), 51 * 51);
        assert!(at(&bytes, 51, 0, 0) > 0);
        let bytes = rasterize_brush(&[dab(9.0, 9.0, 0.1, 0.0, 1.0, false)], 51, 51);
        assert!(bytes.iter().all(|b| *b == 0));
    }

    #[test]
    fn radius_is_a_fraction_of_the_raster_width() {
        // 200 wide: radius 0.05 stamps 10 px; the same radius on a 100-wide
        // grid stamps 5 — the stamp is circular in pixel space either way.
        let wide = rasterize_brush(&[dab(0.5, 0.5, 0.05, 0.0, 1.0, false)], 200, 100);
        let narrow = rasterize_brush(&[dab(0.5, 0.5, 0.05, 0.0, 1.0, false)], 100, 100);
        assert_eq!(at(&wide, 200, 110, 50), 0);
        assert_eq!(at(&wide, 200, 109, 50), 255);
        assert_eq!(at(&narrow, 100, 55, 50), 0);
        assert_eq!(at(&narrow, 100, 54, 50), 255);
    }

    #[test]
    fn degenerate_dabs_are_skipped() {
        let dabs = [
            dab(0.5, 0.5, 0.0, 0.5, 1.0, false),
            dab(0.5, 0.5, 0.2, 0.5, 0.0, false),
            dab(f32::NAN, 0.5, 0.2, 0.5, 1.0, false),
            dab(0.5, 0.5, f32::INFINITY, 0.5, 1.0, false),
        ];
        assert!(rasterize_brush(&dabs, 51, 51).iter().all(|b| *b == 0));
    }
}

#[cfg(test)]
mod attach_tests {
    use super::*;
    use crate::types::{LocalAdjustment, PartialAdjustments};

    fn brush(dabs: Vec<BrushDab>, digest: &str, raster_id: u32) -> LocalAdjustment {
        LocalAdjustment {
            mask: Mask::Brush {
                dabs,
                digest: digest.to_string(),
                raster_id,
            },
            range: None,
            adjustments: PartialAdjustments {
                exposure: Some(1.0),
                ..Default::default()
            },
        }
    }

    fn stroke() -> Vec<BrushDab> {
        vec![BrushDab::new(Point2::new(0.5, 0.5), 0.1, 0.0, 1.0, false)]
    }

    #[test]
    fn model_without_unresolved_brushes_is_borrowed() {
        let empty = AdjustmentModel::default();
        assert!(matches!(
            with_brush_rasters(&empty, 600, 400),
            Cow::Borrowed(_)
        ));
        let mut registered = AdjustmentModel::default();
        registered.local_adjustments = vec![brush(stroke(), "aabbccddeeff0011", 0)];
        registered.mask_rasters = vec![Arc::new(MaskRaster::from_u8(
            3,
            "aabbccddeeff0011",
            1,
            1,
            &[255],
        ))];
        assert!(matches!(
            with_brush_rasters(&registered, 600, 400),
            Cow::Borrowed(_)
        ));
        let mut blank = AdjustmentModel::default();
        blank.local_adjustments = vec![brush(Vec::new(), "", 0)];
        assert!(matches!(
            with_brush_rasters(&blank, 600, 400),
            Cow::Borrowed(_)
        ));
    }

    #[test]
    fn unresolved_brush_gets_its_dabs_rasterized_on_the_shared_grid() {
        let mut model = AdjustmentModel::default();
        model.local_adjustments = vec![brush(stroke(), "", 0), brush(stroke(), "", 0)];
        model.mask_rasters = vec![Arc::new(MaskRaster::from_u8(5, "", 1, 1, &[0]))];
        let attached = with_brush_rasters(&model, 6000, 4000).into_owned();
        assert_eq!(attached.mask_rasters.len(), 3);
        let ids: Vec<u32> = attached
            .local_adjustments
            .iter()
            .map(|l| match l.mask {
                Mask::Brush { raster_id, .. } => raster_id,
                _ => unreachable!(),
            })
            .collect();
        assert_eq!(ids, vec![6, 7]);
        let raster = resolve(&attached.local_adjustments[0].mask, &attached.mask_rasters)
            .expect("attached raster resolves");
        assert_eq!((raster.width, raster.height), brush_raster_dims(6000, 4000));
        assert_eq!(raster.sample(0.5, 0.5), 1.0);
        assert_eq!(raster.sample(0.0, 0.0), 0.0);
    }
}

#[cfg(test)]
#[path = "brush_develop_tests.rs"]
mod develop_tests;
