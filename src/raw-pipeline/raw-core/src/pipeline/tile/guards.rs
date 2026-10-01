//! The tile entry's guard set: every `(raw, model, rect)` condition the tile
//! path refuses rather than renders wrong. Split out of `super::mod` for the
//! file-size budget (#1157) — the entry calls [`reject_untileable`] once,
//! before any pixel work, and the FFI maps the `Err` to return code 10 (or
//! 11 / 12 for the geometry cases), which the Apple caller turns into a
//! bounded whole-image render.
//!
//! What is NOT here any more (#1157): vignette and local adjustments are
//! point ops given the tile's window in the frame, which `develop.rs` now
//! threads through (`TileWindow`); capture sharpening and the S/H detail
//! mask have finite, computable stencils, which `overlap.rs` pads for. The
//! remaining rejections are the stages whose correct tile form needs a
//! full-frame proxy plane or a coordinate mapping that does not exist yet.

use super::TileRect;
use crate::{error::Result, image::RawImage, xmp::AdjustmentModel};

fn reject(msg: impl Into<String>) -> Result<()> {
    Err(crate::error::Error::Pipeline(msg.into()))
}

/// Refuse the models and formats the tile chain cannot reproduce.
pub(super) fn reject_untileable(
    raw: &RawImage,
    model: &AdjustmentModel,
    rect: TileRect,
) -> Result<()> {
    let (width, height) = if raw.orientation.swaps_wh() {
        (raw.height, raw.width)
    } else {
        (raw.width, raw.height)
    };
    if rect.src_w == 0
        || rect.src_h == 0
        || rect.out_w == 0
        || rect.out_h == 0
        || rect.src_x >= width
        || rect.src_y >= height
        || rect.src_w > width.saturating_sub(rect.src_x)
        || rect.src_h > height.saturating_sub(rect.src_y)
    {
        return reject("tile source rectangle is empty or outside the oriented sensor extent");
    }
    if raw.cfa == crate::image::CfaPattern::LinearRgb {
        return reject(
            "tile path does not support LinearRaw DNGs; use the full-image render entry instead. See ticket #07.",
        );
    }
    if matches!(raw.cfa, crate::image::CfaPattern::XTrans(_)) {
        // The padded rect's start corners round to even multiples (2×2 Bayer
        // phase); X-Trans has a 6×6 phase, so the CFA mapping would corrupt
        // across tile boundaries (#420 / #417).
        return reject(
            "tile path does not support Fuji X-Trans RAFs; use the full-image render entry instead (#420).",
        );
    }
    // #3876: CA estimation is anchored to the full sensor, not this crop.
    // Refuse instead of silently replacing the corrected preview with an
    // uncorrected native patch. Vendor warps are rejected below as well.
    if model.auto_lateral_ca == crate::types::adjustment::AutoLateralCa::On {
        return reject(
            "tile path is not supported with automatic lateral CA (full-frame estimation required; use the full-image render entry instead)",
        );
    }
    // Dehaze is global — atmospheric light and the dark channel are
    // statistics of the whole frame — and its transmission map is refined
    // by a radius-60 guided filter. Neither survives a crop; the correct
    // tile form is a full-frame proxy plane (tone-zoom design § 5.3), which
    // the tile chain does not build yet. Refuse loudly.
    if model.dehaze.abs() > 1e-3 {
        return reject(
            "tile path is not supported when dehaze != 0 (global statistics + radius-60 transmission refine need a full-frame proxy plane)",
        );
    }
    // The same rejection for the PER-MASK dehaze control (#3407): a layer's
    // dehaze runs the identical global kernel on that layer's scratch copy,
    // so it inherits the identical whole-frame dependency. The threshold
    // matches `stages::local_adjustments::spatial`'s own engage check.
    if crate::stages::local_adjustments::spatial::any_dehaze_engaged(&model.local_adjustments) {
        return reject(
            "tile path is not supported when a local-adjustment layer sets dehaze != 0 (global statistics + radius-60 transmission refine need a full-frame proxy plane). See #3407.",
        );
    }
    // BM3D deep denoise (#1105): the reference-patch grid is anchored at the
    // buffer origin, so a tile-relative grid aggregates different groups
    // than the full-frame render and seams at tile borders. The threshold
    // matches `bm3d::apply`'s own early-exit (1e-3).
    if model.deep_denoise.abs() > 1e-3 {
        return reject(
            "tile path is not supported when deep denoise != 0 (the BM3D reference-patch grid is frame-anchored; use the full-image render entry instead). See #1105.",
        );
    }
// DNG OpcodeList3 (#1932, #4288): tile develop supports bounded source
    // gathering for a single radial WarpRectilinear opcode without lateral CA
    // or GainMap. When all lens corrections are disabled, the full chain skips
    // these opcodes too, so their presence alone is safe for a tile render.
    if raw.opcode_list3.is_some()
        && crate::pipeline::pano::opcode_apply::LensCorrectionScales::from_model(model)
            != crate::pipeline::pano::opcode_apply::LensCorrectionScales::NONE
    {
        if let Some((list, _aa)) = raw.opcode_list3.as_ref() {
            if !is_supported_tile_opcode_list(list) {
                return reject(
                    "tile path is not supported when the DNG carries unsupported OpcodeList3 (only radial WarpRectilinear without lateral CA or GainMap is supported in tile path; use full-image render instead). See #1932, #4288.",
                );
            }
        }
    }
    let TileRect {
        src_w,
        src_h,
        out_w,
        out_h,
        ..
    } = rect;
    if out_w > src_w || out_h > src_h {
        return reject(format!(
            "tile path is downscale-only (no upscale): out {}×{} > src {}×{}",
            out_w, out_h, src_w, src_h
        ));
    }
    // Aspect-mismatch guard: the trim → downsample path drives a single
    // long-edge scale, so a request whose aspect differs from the source's
    // would be silently fitted to a square. Cross-product comparison avoids
    // fp; tolerance is one row / column of integer rounding.
    let cross = (out_w as u64 * src_h as u64).abs_diff(out_h as u64 * src_w as u64);
    let tol = src_w.max(src_h) as u64;
    if cross > tol {
        return reject(format!(
            "tile path requires matching aspect: src {}×{}, out {}×{}",
            src_w, src_h, out_w, out_h
        ));
    }
    Ok(())
}

/// A DNG OpcodeList3 is supported in the tile path if and only if it consists
/// solely of a single radial WarpRectilinear opcode with identical per-plane
/// coefficients (no lateral CA difference and no GainMap).
pub(super) fn is_supported_tile_opcode_list(
    list: &crate::pipeline::pano::opcodes::OpcodeList3,
) -> bool {
    use crate::pipeline::pano::opcodes::PanoOpcode;
    if list.skipped_unknown > 0 || list.opcodes.len() != 1 {
        return false;
    }
    match &list.opcodes[0] {
        PanoOpcode::WarpRectilinear(w) => {
            if !w.center_x.is_finite() || !w.center_y.is_finite() || w.planes.is_empty() {
                return false;
            }
            let first = &w.planes[0];
            if first.kt != [0.0, 0.0] {
                return false;
            }
            if w.planes.iter().any(|p| p != first) {
                return false;
            }
            if first.kr.iter().any(|&k| !k.is_finite()) {
                return false;
            }
            true
        }
        _ => false,
    }
}
