pub mod amaze;
pub mod bilinear;
mod chroma_diff;
pub mod dual;
pub mod half_res;
pub mod hamilton_adams;
pub mod lmmse;
pub mod policy;
pub mod rcd;
pub mod vng4;
pub mod xtrans;

#[cfg(test)]
mod test_scenes;

pub use self::amaze::amaze;
pub use self::bilinear::{bilinear, bilinear_cancellable};
pub use self::dual::{dual_amaze_vng4, dual_rcd_vng4, dual_rcd_vng4_cancellable};
pub use self::half_res::{half_res, half_res_cancellable};
pub use self::hamilton_adams::hamilton_adams;
pub use self::lmmse::{lmmse, lmmse_cancellable};
pub use self::policy::{
    auto_algorithm, is_high_noise, mid_grey_sigma, resolve_algorithm, sensor_pixels,
    DUAL_MIN_PIXELS, LMMSE_ISO_FALLBACK, LMMSE_SIGMA_MID_GREY,
};
pub use self::rcd::{rcd, rcd_cancellable};
pub use self::vng4::{vng4, vng4_cancellable};
pub use self::xtrans::{markesteijn, xtrans_bilinear};

use crate::image::{CfaPattern, Image};
use rayon::prelude::*;

/// Demosaic algorithm selector.
///
/// **Detail-first kernels.** `Bilinear` is the cheapest and the small-frame
/// / border fallback every other Bayer kernel leans on; `HamiltonAdams` is
/// the historic "high quality" option; `Rcd` is the on-screen full-quality
/// kernel (`RenderQuality::Full`); `Amaze` is the export kernel (slower,
/// best fine-detail and moiré resistance).
///
/// **Smooth kernels (#3413).** `Vng4` averages every direction the gradient
/// threshold accepts, which is what a flat noisy region wants and what a
/// resolved edge does not; `Lmmse` is the high-ISO kernel, estimating green
/// from the horizontally and vertically interpolated colour-difference
/// signals under an explicit signal/noise model.
///
/// **Dual modes (#3413).** `DualAmazeVng4` and `DualRcdVng4` run a
/// detail-first kernel and `Vng4` and blend them per pixel by local
/// contrast, so detail gets the sharp reconstruction and flat sky gets the
/// quiet one. See [`dual`].
///
/// `HalfRes` halves resolution and is reserved for large-sensor preview
/// paths. `Markesteijn` is the X-Trans counterpart to `Amaze` — Bayer
/// kernels produce garbage on a 6×6 X-Trans CFA, so the pipeline
/// dispatches `XTrans(_)` patterns to this kernel regardless of the
/// `RenderQuality` the caller requested. See [`demosaic`].
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub enum DemosaicAlgorithm {
    #[default]
    Bilinear,
    HamiltonAdams,
    Rcd,
    Amaze,
    Vng4,
    Lmmse,
    DualAmazeVng4,
    DualRcdVng4,
    HalfRes,
    Markesteijn,
}

pub fn demosaic(algo: DemosaicAlgorithm, mosaic: &Image, cfa: CfaPattern) -> Image {
    match algo {
        DemosaicAlgorithm::Bilinear => bilinear(mosaic, cfa),
        DemosaicAlgorithm::HamiltonAdams => hamilton_adams(mosaic, cfa),
        DemosaicAlgorithm::Rcd => rcd(mosaic, cfa),
        DemosaicAlgorithm::Amaze => amaze(mosaic, cfa),
        DemosaicAlgorithm::Vng4 => vng4(mosaic, cfa),
        DemosaicAlgorithm::Lmmse => lmmse(mosaic, cfa),
        DemosaicAlgorithm::DualAmazeVng4 => dual_amaze_vng4(mosaic, cfa),
        DemosaicAlgorithm::DualRcdVng4 => dual_rcd_vng4(mosaic, cfa),
        DemosaicAlgorithm::HalfRes => half_res(mosaic, cfa),
        DemosaicAlgorithm::Markesteijn => markesteijn(mosaic, cfa),
    }
}

/// Flatten the sparse 3-channel mosaic to a single float per CFA position.
///
/// `sensor_linearize` populates exactly one of `[r, g, b]` per pixel — the
/// one the CFA says that site samples — and leaves the other two at zero.
/// The tiled kernels (`amaze`, `rcd`) index a dense single-channel plane
/// rather than re-deriving the live channel on every neighbour read.
pub(crate) fn flatten_mosaic(mosaic: &Image, cfa: CfaPattern) -> Vec<f32> {
    let w = mosaic.width as usize;
    mosaic
        .pixels
        .par_iter()
        .enumerate()
        .map(|(i, p)| {
            let x = (i % w) as u32;
            let y = (i / w) as u32;
            p[cfa.color_at(x, y) as usize]
        })
        .collect()
}
