//! Portable, scene-referred Rust raw-core per `docs/spec/`.
//!
//! Slice 1 scope: decode → bilinear demosaic → minimal DCP →
//! white balance → exposure → dehaze → AgX → Rec.2020→sRGB → PNG.

#![warn(clippy::all, rust_2018_idioms)]

pub mod error;
pub use error::{Error, Result};

pub mod cancel;
pub use cancel::CancelToken;

pub mod math;

pub mod camera_calibration;

pub mod color;

pub mod image;
pub use image::{CfaPattern, ColorSpace, ExifOrientation, Image, RawImage};

pub mod decode;

pub mod decode_cache;

pub mod dng_ifd_walker;

pub mod linearize;

pub mod demosaic;

pub mod stages;

pub mod view;

pub mod synthetic_input;

pub mod png;

pub mod jpeg;

#[cfg(feature = "avif")]
pub mod avif;

pub mod tiff;

#[cfg(any(test, feature = "test-support"))]
pub mod test_support;

#[cfg(feature = "stage-dump")]
pub mod stage_dump;

pub mod types;
pub use types::{
    AdjustmentModel, FieldKind, FieldSpec, HighlightRecoveryMode, LocalAdjustment, Mask,
    PartialAdjustments, Point2, ToneCurveMode, WhiteBalancePreset, ADJUSTMENT_SCHEMA,
};

pub mod ui_tokens;

pub mod version;
pub use version::PIPELINE_OUTPUT_VERSION;

pub mod xmp;

pub mod pipeline;
pub use pipeline::render_from_raw;
// Maple Pano ingest entry (#1156): scene-linear decode that stops before
// every display-prep stage, plus the metadata-only priors pass.
pub use pipeline::{decode_for_pano, read_pano_metadata, PanoIngest, PanoSourceMetadata};

pub mod api;
pub use api::{decode_raw, read_exif, Exif, ExifGps};

pub mod id;
pub use id::{blake3_hex, maple_id, FallbackIdHasher, IdKind, MapleId};
