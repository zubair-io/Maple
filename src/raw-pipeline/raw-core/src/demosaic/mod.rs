pub mod amaze;
pub mod bilinear;
pub mod half_res;
pub mod hamilton_adams;
pub mod xtrans;

pub use self::amaze::amaze;
pub use self::bilinear::{bilinear, bilinear_cancellable};
pub use self::half_res::{half_res, half_res_cancellable};
pub use self::hamilton_adams::hamilton_adams;
pub use self::xtrans::{markesteijn, xtrans_bilinear};

use crate::image::{CfaPattern, Image};

/// Demosaic algorithm selector. `Bilinear` is the default; `HamiltonAdams`
/// is the previous "high quality" option; `Amaze` is the new high-quality
/// option (slower, better fine-detail and moiré resistance); `HalfRes`
/// halves resolution and is reserved for large-sensor preview paths.
/// `Markesteijn` is the X-Trans counterpart to `Amaze` — Bayer kernels
/// produce garbage on a 6×6 X-Trans CFA, so the pipeline dispatches
/// `XTrans(_)` patterns to this kernel regardless of the `RenderQuality`
/// the caller requested. See [`demosaic`].
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum DemosaicAlgorithm {
    Bilinear,
    HamiltonAdams,
    Amaze,
    HalfRes,
    Markesteijn,
}

impl Default for DemosaicAlgorithm {
    fn default() -> Self {
        Self::Bilinear
    }
}

pub fn demosaic(algo: DemosaicAlgorithm, mosaic: &Image, cfa: CfaPattern) -> Image {
    match algo {
        DemosaicAlgorithm::Bilinear => bilinear(mosaic, cfa),
        DemosaicAlgorithm::HamiltonAdams => hamilton_adams(mosaic, cfa),
        DemosaicAlgorithm::Amaze => amaze(mosaic, cfa),
        DemosaicAlgorithm::HalfRes => half_res(mosaic, cfa),
        DemosaicAlgorithm::Markesteijn => markesteijn(mosaic, cfa),
    }
}
