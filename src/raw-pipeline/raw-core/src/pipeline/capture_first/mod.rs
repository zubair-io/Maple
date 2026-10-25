//! Capture-first develop (#5213).
//!
//! The develop chain splits into two halves that full, sized and tile
//! develop (and, once hosts adopt it, the per-tick chain) share:
//!
//! 1. **Capture** ([`capture`]): the as-shot camera buffer moves into a fixed
//!    as-shot Rec.2020 basis — the as-shot DCP's linear core, with no
//!    HueSatMap, LookTable or soft floor, so values stay signed — and
//!    retouch, chroma prefilter, BM3D and capture sharpening run there. The
//!    user's white balance never reaches them.
//! 2. **Creative** ([`CreativeStage::render`]): the capture result maps back
//!    through the inverse basis and runs the unchanged camera WB → DCP →
//!    Oklab highlight recovery → auto exposure → fallback WB sequence.
//!
//! With no capture stage engaged the basis is skipped, so at the as-shot
//! white balance a render is bit-identical to the pre-#5213 chain. Auto
//! exposure is measured on the as-shot render, so moving white balance no
//! longer re-anchors exposure.

mod creative;
mod creative_plan;
mod export;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_plan;
#[cfg(test)]
mod tests_signed;
#[cfg(test)]
mod tests_transport;
mod transport;

pub(crate) use creative::CaptureSpace;
pub use creative::{CreativeAnchors, CreativeStage};
pub use creative_plan::{
    AsShotTable, CreativePlan, CreativeWire, PlanTable, TableLayout, TableSpan,
};
pub(crate) use export::{capture_in_basis, export_capture};
pub use transport::{CreativeHeader, CreativeTick, ProfileCore};

use super::{capture_sharpening_helper::capture_sharpening_params_from_model, dump_after, stage};
use crate::{
    cancel::CancelToken,
    color::dcp::{self, DcpProfile},
    error::{Error, Result},
    image::{ColorSpace, Image},
    math::Matrix3,
    stages::{bm3d, capture_sharpening, chroma_prefilter, retouch},
    xmp::AdjustmentModel,
};
use rayon::prelude::*;

/// Which chain is developing, so `MAPLE_PROFILE` traces keep the `sized_` and
/// `tile_` prefixes the legacy stages use.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Chain {
    Full,
    Sized,
    Tile,
}

macro_rules! label {
    ($chain:expr, $name:literal) => {
        match $chain {
            Chain::Full => $name,
            Chain::Sized => concat!("sized_", $name),
            Chain::Tile => concat!("tile_", $name),
        }
    };
}
pub(crate) use label;

/// Where the buffer sits in the developed frame. Repair spots address the
/// whole frame, so a tile passes its window.
#[derive(Clone, Copy)]
pub(crate) enum Site {
    Frame,
    Window {
        origin: (i32, i32),
        full: (u32, u32),
    },
}

/// Whether any capture stage would change pixels, at the thresholds the
/// stages themselves early-return on.
pub(crate) fn engages_capture_stage(model: &AdjustmentModel) -> bool {
    model.chroma_prefilter >= 1e-3
        || model.deep_denoise >= 1e-3
        || capture_sharpening_params_from_model(model).is_some()
        || !model.retouch_spots.is_empty()
}

/// Run the capture stages on the as-shot camera buffer. Returns the buffer
/// unchanged in camera space when no stage is engaged; otherwise the result
/// is in the fixed as-shot basis. The returned [`CaptureSpace`] says which,
/// for [`CreativeStage::render`].
pub(crate) fn capture(
    mut camera: Image,
    profile: &DcpProfile,
    model: &AdjustmentModel,
    site: Site,
    chain: Chain,
    cancel: CancelToken<'_>,
) -> Result<(Image, CaptureSpace)> {
    camera.assert_space(ColorSpace::CameraNativeLinearRgb);
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    if !engages_capture_stage(model) {
        return Ok((camera, CaptureSpace::Camera));
    }
    let basis = dcp::camera_to_rec2020_matrix(profile)?;
    // Checked before seconds of denoise, not after: the creative stage needs it.
    basis_inverse(&basis)?;
    stage(label!(chain, "capture_basis"), || {
        transform(&mut camera, &basis)
    });
    camera.space = ColorSpace::SceneLinearRec2020;
    let mut capture = camera;
    let (origin, full) = match site {
        Site::Frame => ((0, 0), (capture.width, capture.height)),
        Site::Window { origin, full } => (origin, full),
    };
    stage(label!(chain, "capture_retouch"), || {
        retouch::apply_windowed_cancellable(
            &mut capture,
            &model.retouch_spots,
            origin,
            full,
            cancel,
        )
    })?;
    dump(chain, "03c_retouch", &capture);
    stage(label!(chain, "capture_chroma_prefilter"), || {
        chroma_prefilter::apply(&mut capture, model.chroma_prefilter)
    });
    dump(chain, "04a_chroma_prefilter", &capture);
    // A tile never reaches here with BM3D engaged: its reference-patch grid
    // is frame-anchored, so the tile entry rejects `deep_denoise` first.
    stage(label!(chain, "capture_deep_denoise"), || {
        bm3d::apply_cancellable(
            &mut capture,
            model.deep_denoise,
            cancel,
            bm3d::active_progress(),
        )
    });
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    dump(chain, "04ab_deep_denoise", &capture);
    if let Some(params) = capture_sharpening_params_from_model(model) {
        stage(label!(chain, "capture_sharpening"), || {
            capture_sharpening::apply_capture_sharpening_cancellable(&mut capture, &params, cancel)
        })?;
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
    }
    dump(chain, "04b_capture_sharpening", &capture);
    Ok((capture, CaptureSpace::Basis))
}

fn basis_inverse(basis: &Matrix3) -> Result<Matrix3> {
    basis
        .inverse()
        .ok_or_else(|| Error::Pipeline("capture basis is singular".into()))
}

/// Stage dumps from the whole-frame chains; a tile would overwrite them.
fn dump(chain: Chain, name: &str, img: &Image) {
    if chain != Chain::Tile {
        dump_after(name, img);
    }
}

fn transform(img: &mut Image, m: &Matrix3) {
    img.pixels.par_iter_mut().for_each(|p| *p = m.mul_vec(*p));
}
