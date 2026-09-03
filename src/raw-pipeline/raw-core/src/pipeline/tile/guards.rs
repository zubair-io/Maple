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
    // BM3D deep denoise (#1105): the reference-patch grid is anchored at the
    // buffer origin, so a tile-relative grid aggregates different groups
    // than the full-frame render and seams at tile borders. The threshold
    // matches `bm3d::apply`'s own early-exit (1e-3).
    if model.deep_denoise.abs() > 1e-3 {
        return reject(
            "tile path is not supported when deep denoise != 0 (the BM3D reference-patch grid is frame-anchored; use the full-image render entry instead). See #1105.",
        );
    }
    // DNG OpcodeList3 (#1932): the full and sized develop chains apply
    // GainMap / WarpRectilinear on the demosaiced buffer in full-sensor
    // ActiveArea coordinates; the tile chain never did, and the warp
    // resample gathers from source positions displaced by the (unbounded)
    // lens model. Refuse so opcode-carrying DNGs fall back to the render
    // that applies them correctly (#1173 tracks a tile-local GainMap).
    if raw.opcode_list3.is_some() {
        return reject(
            "tile path is not supported when the DNG carries OpcodeList3 (GainMap / WarpRectilinear gain/warp/CA correction; the warp resample gather exceeds the overlap pad and the tile chain does not apply opcodes — use the full-image render entry instead). See #1932.",
        );
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
