pub mod amaze;
pub mod bilinear;
pub mod half_res;
pub mod hamilton_adams;
pub mod rcd;
pub mod xtrans;

pub use self::amaze::amaze;
pub use self::bilinear::{bilinear, bilinear_cancellable};
pub use self::half_res::{half_res, half_res_cancellable};
pub use self::hamilton_adams::hamilton_adams;
pub use self::rcd::{rcd, rcd_cancellable};
pub use self::xtrans::{markesteijn, xtrans_bilinear};

use crate::image::{CfaPattern, Image};
use rayon::prelude::*;

/// Demosaic algorithm selector. `Bilinear` is the cheapest and the
/// small-frame / border fallback every other Bayer kernel leans on;
/// `HamiltonAdams` is the historic "high quality" option; `Rcd` is the
/// on-screen full-quality kernel (`RenderQuality::Full`); `Amaze` is the
/// export kernel (slower, best fine-detail and moiré resistance);
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
    HalfRes,
    Markesteijn,
}

pub fn demosaic(algo: DemosaicAlgorithm, mosaic: &Image, cfa: CfaPattern) -> Image {
    match algo {
        DemosaicAlgorithm::Bilinear => bilinear(mosaic, cfa),
        DemosaicAlgorithm::HamiltonAdams => hamilton_adams(mosaic, cfa),
        DemosaicAlgorithm::Rcd => rcd(mosaic, cfa),
        DemosaicAlgorithm::Amaze => amaze(mosaic, cfa),
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
