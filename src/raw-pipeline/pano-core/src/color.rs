//! Color-space descriptors for the panorama working buffer.
//!
//! `pano-core` keeps everything in scene-linear ProPhoto float32 by
//! default; the matrices for converting in/out come from
//! [`raw_core::color::matrices`].

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Primaries {
    /// ROMM RGB (ProPhoto).
    ProPhoto,
    /// ITU-R BT.709 / sRGB primaries.
    Bt709,
    /// ITU-R BT.2020.
    Bt2020,
    /// CIE XYZ (identity primaries).
    Xyz,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WhitePoint {
    D50,
    D65,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transfer {
    Linear,
    Srgb,
}

/// Triple `(primaries, white_point, transfer)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ColorSpace {
    pub primaries: Primaries,
    pub white_point: WhitePoint,
    pub transfer: Transfer,
}

impl ColorSpace {
    /// `pano-core`'s working space — scene-linear Rec.2020 D65.
    ///
    /// The design spec (§ 4.1, § 7) names ProPhoto D50, but raw-core's
    /// DCP stage actually emits `SceneLinearRec2020` D65 (see
    /// `raw-core/src/color/dcp.rs`). Pano works in the same space as
    /// what `raw-core::decode_for_pano` hands it; conversion to
    /// ProPhoto happens at export.
    pub const fn rec2020_d65_linear() -> Self {
        Self {
            primaries: Primaries::Bt2020,
            white_point: WhitePoint::D65,
            transfer: Transfer::Linear,
        }
    }

    /// Export-target space — scene-linear ProPhoto D50.
    pub const fn prophoto_d50_linear() -> Self {
        Self {
            primaries: Primaries::ProPhoto,
            white_point: WhitePoint::D50,
            transfer: Transfer::Linear,
        }
    }
}
