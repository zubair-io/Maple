//! Mask orientation remapping between display and sensor frames (#4426).
//!
//! Masks (linear gradients, radial gradients, brush strokes, and host-supplied
//! bitmap rasters) are authored in the display frame: normalized coordinates
//! `[0, 1] × [0, 1]` over the upright, display-oriented image.
//!
//! The develop pipeline operates on the sensor-frame buffer and only applies
//! EXIF orientation at the finish/geometry tail. When a RAW carries a non-Normal
//! EXIF orientation (e.g. `Rotate90`, `Rotate180`, `Rotate270`, or mirrored),
//! mask geometry and mask rasters must be mapped from the display frame into the
//! sensor frame before `stages::local_adjustments`, so that the adjustments
//! land on the correct sensor pixels and rotate into their authored display
//! positions during the final geometry pass.

use std::borrow::Cow;
use std::f32::consts::{FRAC_PI_2, PI};
use std::sync::Arc;

use rayon::prelude::*;

use crate::image::ExifOrientation;
use crate::types::{BrushDab, LocalAdjustment, Mask, MaskComponent, MaskGroup, MaskRaster, Point2};

/// Map a local adjustment stack and its associated rasters from the oriented
/// display frame into the raw sensor frame.
///
/// If `orientation` is [`ExifOrientation::Normal`] or `layers` is empty,
/// returns borrowed slices with zero allocation.
pub fn orient_adjustments_to_sensor<'a>(
    layers: &'a [LocalAdjustment],
    rasters: &'a [Arc<MaskRaster>],
    orientation: ExifOrientation,
) -> (Cow<'a, [LocalAdjustment]>, Cow<'a, [Arc<MaskRaster>]>) {
    if orientation == ExifOrientation::Normal || layers.is_empty() {
        return (Cow::Borrowed(layers), Cow::Borrowed(rasters));
    }
    let mapped_layers: Vec<LocalAdjustment> = layers
        .iter()
        .map(|layer| orient_layer_to_sensor(layer, orientation))
        .collect();
    let mapped_rasters: Vec<Arc<MaskRaster>> = rasters
        .iter()
        .map(|raster| Arc::new(orient_raster_to_sensor(raster, orientation)))
        .collect();
    (Cow::Owned(mapped_layers), Cow::Owned(mapped_rasters))
}

/// Map a single [`LocalAdjustment`] from display frame to sensor frame.
pub fn orient_layer_to_sensor(
    layer: &LocalAdjustment,
    orientation: ExifOrientation,
) -> LocalAdjustment {
    LocalAdjustment {
        mask: orient_mask_to_sensor(&layer.mask, orientation),
        range: layer.range.clone(),
        adjustments: layer.adjustments.clone(),
    }
}

/// Map a [`Mask`] from display frame to sensor frame.
pub fn orient_mask_to_sensor(mask: &Mask, orientation: ExifOrientation) -> Mask {
    match mask {
        Mask::Linear {
            start,
            end,
            feather,
        } => Mask::Linear {
            start: display_to_sensor_norm(*start, orientation),
            end: display_to_sensor_norm(*end, orientation),
            feather: *feather,
        },
        Mask::Radial {
            center,
            radii,
            angle,
            feather,
            invert,
        } => Mask::Radial {
            center: display_to_sensor_norm(*center, orientation),
            radii: *radii,
            angle: display_to_sensor_angle(*angle, orientation),
            feather: *feather,
            invert: *invert,
        },
        Mask::Bitmap { recipe, raster_id } => Mask::Bitmap {
            recipe: recipe.clone(),
            raster_id: *raster_id,
        },
        Mask::Brush {
            dabs,
            digest,
            raster_id,
        } => Mask::Brush {
            dabs: dabs
                .iter()
                .map(|d| BrushDab {
                    center: display_to_sensor_norm(d.center, orientation),
                    radius: d.radius,
                    feather: d.feather,
                    weight: d.weight,
                    erase: d.erase,
                })
                .collect(),
            digest: digest.clone(),
            raster_id: *raster_id,
        },
        Mask::Everywhere => Mask::Everywhere,
        Mask::Group(group) => Mask::Group(MaskGroup {
            components: group
                .components
                .iter()
                .filter_map(|c| {
                    MaskComponent::new(
                        orient_mask_to_sensor(c.mask(), orientation),
                        c.combine,
                        c.invert,
                    )
                })
                .collect(),
            opacity: group.opacity,
            invert: group.invert,
        }),
    }
}

/// Map a normalized coordinate `(x, y) ∈ [0, 1]²` from the display frame
/// into the sensor frame.
#[inline]
pub fn display_to_sensor_norm(p: Point2, orientation: ExifOrientation) -> Point2 {
    let (x, y) = (p.x, p.y);
    let (sx, sy) = match orientation {
        ExifOrientation::Normal => (x, y),
        ExifOrientation::HorizontalFlip => (1.0 - x, y),
        ExifOrientation::Rotate180 => (1.0 - x, 1.0 - y),
        ExifOrientation::VerticalFlip => (x, 1.0 - y),
        ExifOrientation::Transpose => (y, x),
        ExifOrientation::Rotate90 => (y, 1.0 - x),
        ExifOrientation::Transverse => (1.0 - y, 1.0 - x),
        ExifOrientation::Rotate270 => (1.0 - y, x),
    };
    Point2::new(sx, sy)
}

/// Map an ellipse angle in radians from the display frame into the sensor frame.
#[inline]
pub fn display_to_sensor_angle(angle: f32, orientation: ExifOrientation) -> f32 {
    match orientation {
        ExifOrientation::Normal => angle,
        ExifOrientation::HorizontalFlip => PI - angle,
        ExifOrientation::Rotate180 => angle + PI,
        ExifOrientation::VerticalFlip => -angle,
        ExifOrientation::Transpose => FRAC_PI_2 - angle,
        ExifOrientation::Rotate90 => angle - FRAC_PI_2,
        ExifOrientation::Transverse => -FRAC_PI_2 - angle,
        ExifOrientation::Rotate270 => angle + FRAC_PI_2,
    }
}

/// Rotate a display-oriented [`MaskRaster`] into the sensor frame.
pub fn orient_raster_to_sensor(raster: &MaskRaster, orientation: ExifOrientation) -> MaskRaster {
    if orientation == ExifOrientation::Normal
        || raster.width == 0
        || raster.height == 0
        || raster.data.is_empty()
        || raster.data.len() != (raster.width as usize) * (raster.height as usize)
    {
        return raster.clone();
    }
    let (dw, dh) = (raster.width as usize, raster.height as usize);
    let (sw, sh) = if orientation.swaps_wh() {
        (dh, dw)
    } else {
        (dw, dh)
    };
    let mut out = vec![0.0f32; sw * sh];
    out.par_chunks_mut(sw).enumerate().for_each(|(sy, row)| {
        for (sx, slot) in row.iter_mut().enumerate() {
            let (dx, dy) = match orientation {
                ExifOrientation::Normal => (sx, sy),
                ExifOrientation::HorizontalFlip => (dw - 1 - sx, sy),
                ExifOrientation::Rotate180 => (dw - 1 - sx, dh - 1 - sy),
                ExifOrientation::VerticalFlip => (sx, dh - 1 - sy),
                ExifOrientation::Transpose => (sy, sx),
                ExifOrientation::Rotate90 => (dw - 1 - sy, sx),
                ExifOrientation::Transverse => (dw - 1 - sy, dh - 1 - sx),
                ExifOrientation::Rotate270 => (sy, dh - 1 - sx),
            };
            *slot = raster.data[dy * dw + dx];
        }
    });
    MaskRaster {
        id: raster.id,
        digest: raster.digest.clone(),
        width: sw as u32,
        height: sh as u32,
        data: out,
    }
}

#[cfg(test)]
mod tests;
