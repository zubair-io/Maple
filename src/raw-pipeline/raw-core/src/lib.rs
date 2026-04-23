//! Portable, scene-referred Rust raw-core per `docs/spec/`.
//!
//! Slice 1 scope: decode → bilinear demosaic → minimal DCP →
//! white balance → exposure → dehaze → AgX → Rec.2020→sRGB → PNG.

#![warn(clippy::all, rust_2018_idioms)]

pub mod error;
pub use error::{Error, Result};

pub mod math;

pub mod color;

pub mod image;
pub use image::{CfaPattern, ColorSpace, Image, RawImage};
