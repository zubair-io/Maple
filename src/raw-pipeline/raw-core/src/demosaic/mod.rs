pub mod amaze;
pub mod bilinear;
pub mod hamilton_adams;
pub mod half_res;

pub use self::amaze::amaze;
pub use self::bilinear::bilinear;
pub use self::hamilton_adams::hamilton_adams;
pub use self::half_res::half_res;

use crate::image::{CfaPattern, Image};

/// Demosaic algorithm selector. `Bilinear` is the default; `HamiltonAdams`
/// is the previous "high quality" option; `Amaze` is the new high-quality
/// option (slower, better fine-detail and moiré resistance); `HalfRes`
/// halves resolution and is reserved for large-sensor preview paths.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum DemosaicAlgorithm {
    Bilinear,
    HamiltonAdams,
    Amaze,
    HalfRes,
}

impl Default for DemosaicAlgorithm {
    fn default() -> Self { Self::Bilinear }
}

pub fn demosaic(algo: DemosaicAlgorithm, mosaic: &Image, cfa: CfaPattern) -> Image {
    match algo {
        DemosaicAlgorithm::Bilinear      => bilinear(mosaic, cfa),
        DemosaicAlgorithm::HamiltonAdams => hamilton_adams(mosaic, cfa),
        DemosaicAlgorithm::Amaze         => amaze(mosaic, cfa),
        DemosaicAlgorithm::HalfRes       => half_res(mosaic, cfa),
    }
}
