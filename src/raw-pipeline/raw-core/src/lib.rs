//! Portable, scene-referred Rust raw-core per `docs/spec/`.
//!
//! Slice 1 scope: decode → bilinear demosaic → minimal DCP →
//! white balance → exposure → dehaze → AgX → Rec.2020→sRGB → PNG.

#![warn(clippy::all, rust_2018_idioms)]

pub mod error;
pub use error::{Error, Result};

pub mod math;

pub mod camera_calibration;

pub mod color;

pub mod image;
pub use image::{CfaPattern, ColorSpace, ExifOrientation, Image, RawImage};

pub mod decode;

pub mod dng_ifd_walker;

pub mod linearize;

pub mod demosaic;

pub mod stages;

pub mod view;

pub mod png;

pub mod jpeg;

pub mod tiff;

pub mod xmp;
pub use xmp::AdjustmentModel;

pub mod pipeline;
pub use pipeline::render_from_raw;

pub mod api;
pub use api::{
    apply, decode_raw, encode as encode_out, histogram, preview, read_exif, thumbnail, waveform,
    xmp_read, xmp_write, EncodeOpts, Exif, ExifGps, Flag, Histogram, OutFmt, Rendered, Rgba,
    Sidecar, Waveform,
};

pub mod id;
pub use id::{maple_id, IdKind, MapleId};
