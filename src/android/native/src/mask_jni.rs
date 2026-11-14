//! Mask authoring entries for the Android bridge: read and write the
//! sidecar's mask containers (`mask_document` / `mask_write`), the selected
//! layer's weight from raw-core's evaluator, the presentation's map (crop and
//! manual geometry) onto the full frame masks live in, and the colour-range
//! eyedropper.
use crate::preview::Session;
use crate::{guarded, text};
use raw_core::stages::crop::CropPresentation;
use raw_core::stages::local_adjustments::mask::evaluate;
use raw_core::stages::mask_range_sample::{sample_mask_range, RangeSampleError, RangeSeed};
use raw_core::stages::perspective::{aspect_ratio, Perspective};
use raw_core::types::{AdjustmentModel, Crop};
use raw_core::RawImage;
use std::ffi::{c_char, c_void, CString};
use std::{ptr, slice, sync::Arc};

fn json_call(
    input: *const c_char,
    body: fn(&serde_json::Value) -> Result<serde_json::Value, String>,
) -> *mut c_char {
    guarded(ptr::null_mut(), || {
        let input: serde_json::Value =
            serde_json::from_str(unsafe { text(input) }?).map_err(|e| e.to_string())?;
        Ok(CString::new(body(&input)?.to_string())
            .map_err(|e| e.to_string())?
            .into_raw())
    })
}

/// `{"layers": [...]}` for the containers described by `input`.
#[no_mangle]
pub unsafe extern "C" fn maple_android_masks_read(input: *const c_char) -> *mut c_char {
    json_call(input, crate::mask_write::read)
}

/// `{"containers": [...], "appended": "..."}` replacing the input containers.
#[no_mangle]
pub unsafe extern "C" fn maple_android_masks_write(input: *const c_char) -> *mut c_char {
    json_call(input, crate::mask_write::write)
}

/// Writes `width × height` weights of the JSON layer's mask, `0…255`, over
/// the full frame (`x / (width − 1)` across, as the stage samples).
#[no_mangle]
pub unsafe extern "C" fn maple_android_mask_weights(
    layer: *const c_char,
    width: u32,
    height: u32,
    out: *mut u8,
) -> bool {
    guarded(false, || {
        if out.is_null() || width < 2 || height < 2 || width > 1024 || height > 1024 {
            return Err("Invalid mask weight request".into());
        }
        let value: serde_json::Value =
            serde_json::from_str(text(layer)?).map_err(|e| e.to_string())?;
        let mask = crate::mask_model::layer_from_json(&value)?.layer.mask;
        let output = slice::from_raw_parts_mut(out, (width * height) as usize);
        let (sx, sy) = (1.0 / (width - 1) as f32, 1.0 / (height - 1) as f32);
        for (index, slot) in output.iter_mut().enumerate() {
            let (x, y) = (index as u32 % width, index as u32 / width);
            let weight = evaluate(&mask, None, x as f32 * sx, y as f32 * sy);
            *slot = (weight.clamp(0.0, 1.0) * 255.0).round() as u8;
        }
        Ok(true)
    })
}

/// The row-major projective map `[m0 … m8]` taking a point normalised over
/// the presented image to the full display frame masks are evaluated in: the
/// crop's inverse, then the manual geometry's inverse — the composition
/// `preview::present_geometry` samples the frame through, so a mask drawn
/// through it lands where the render puts its weight. A keystone makes it
/// projective, so callers divide by the third row.
pub fn presentation_to_frame(
    width: u32,
    height: u32,
    crop: Crop,
    perspective: Perspective,
) -> [f64; 9] {
    let h = perspective
        .inverse_matrix(aspect_ratio(width, height))
        .mul(&CropPresentation::new(&crop, width, height).inverse)
        .0
        .map(f64::from);
    // Both maps work in centred [-1, 1] coordinates; re-base on [0, 1] as
    // `B⁻¹ · H · B` with `B(p) = 2p − 1`.
    let (row, w) = ([h[6], h[7], h[8]], h[8] - h[6] - h[7]);
    let rebase = |r: [f64; 3]| [r[0] + row[0], r[1] + row[1], (r[2] - r[0] - r[1] + w) / 2.0];
    let [a, b, c] = rebase([h[0], h[1], h[2]]);
    let [d, e, f] = rebase([h[3], h[4], h[5]]);
    [a, b, c, d, e, f, 2.0 * row[0], 2.0 * row[1], w]
}

/// Writes [`presentation_to_frame`] for the crop and the seven manual-geometry
/// sliders (`geometry`: vertical, horizontal, rotate, scale, aspect, x, y).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn maple_android_mask_frame(
    width: u32,
    height: u32,
    top: f32,
    left: f32,
    bottom: f32,
    right: f32,
    angle: f32,
    geometry: *const f32,
    out: *mut f64,
) -> bool {
    guarded(false, || {
        if out.is_null() || geometry.is_null() {
            return Err("Invalid mask frame request".into());
        }
        let crop = Crop {
            top,
            left,
            bottom,
            right,
            angle,
        };
        let g = slice::from_raw_parts(geometry, 7);
        let perspective = Perspective {
            vertical: g[0],
            horizontal: g[1],
            rotate: g[2],
            scale: g[3],
            aspect: g[4],
            x: g[5],
            y: g[6],
        };
        slice::from_raw_parts_mut(out, 9).copy_from_slice(&presentation_to_frame(
            width,
            height,
            crop,
            perspective,
        ));
        Ok(true)
    })
}

/// The colour-range eyedropper's work: the open RAW and the model the photo
/// is developed under, sampled off the render thread like auto white balance.
pub struct MaskRangeWork {
    raw: Arc<RawImage>,
    model: AdjustmentModel,
}

impl MaskRangeWork {
    pub fn new(raw: Arc<RawImage>, xml: &str) -> Result<Self, String> {
        Ok(Self {
            raw,
            model: crate::xmp::parse(xml)?,
        })
    }

    /// `{"seed": {...}}` for the colour at the display-oriented full-frame
    /// point, or `{"refused": message}` when the click has no colour to give.
    pub fn run(&self, x: f32, y: f32) -> Result<String, String> {
        let m = self.raw.orientation.display_to_sensor_matrix();
        let (u, v) = (2.0 * x - 1.0, 2.0 * y - 1.0);
        let (sx, sy) = (
            (m[0] * u + m[1] * v + 1.0) / 2.0,
            (m[3] * u + m[4] * v + 1.0) / 2.0,
        );
        let outcome = match sample_mask_range(&self.raw, &self.model, sx, sy) {
            Ok(sample) => {
                let seed = RangeSeed::from_sample(&sample);
                serde_json::json!({"seed": {"hue_deg": seed.hue_deg, "chroma_min": seed.chroma_min,
                    "l_min": seed.l_min, "l_max": seed.l_max}})
            }
            Err(RangeSampleError::Develop(error)) => return Err(error),
            Err(refused) => {
                let message = refused.to_string();
                let mut chars = message.chars();
                let message = chars
                    .next()
                    .map(|first| first.to_uppercase().chain(chars).collect::<String>())
                    .unwrap_or_default();
                serde_json::json!({"refused": message})
            }
        };
        Ok(outcome.to_string())
    }
}

#[no_mangle]
pub unsafe extern "C" fn maple_android_mask_range_new(
    handle: *mut c_void,
    xml: *const c_char,
) -> *mut c_void {
    guarded(ptr::null_mut(), || {
        let session = handle.cast::<Session>().as_ref().ok_or("Closed editor")?;
        let raw = session.raw().ok_or("Colour sampling needs a RAW photo")?;
        Ok(Box::into_raw(Box::new(MaskRangeWork::new(raw, text(xml)?)?)).cast())
    })
}

#[no_mangle]
pub unsafe extern "C" fn maple_android_mask_range_run(
    work: *const c_void,
    x: f32,
    y: f32,
) -> *mut c_char {
    guarded(ptr::null_mut(), || {
        let work = work
            .cast::<MaskRangeWork>()
            .as_ref()
            .ok_or("Closed colour sampling")?;
        Ok(CString::new(work.run(x, y)?)
            .map_err(|e| e.to_string())?
            .into_raw())
    })
}

#[no_mangle]
pub unsafe extern "C" fn maple_android_mask_range_free(work: *mut c_void) {
    if !work.is_null() {
        guarded((), || {
            drop(Box::from_raw(work.cast::<MaskRangeWork>()));
            Ok(())
        });
    }
}

#[cfg(test)]
#[path = "mask_jni_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "mask_frame_tests.rs"]
mod frame_tests;
