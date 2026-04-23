//! Portable, scene-referred Rust raw-core per `docs/spec/`.
//!
//! Slice 1 scope: decode → bilinear demosaic → minimal DCP →
//! white balance → exposure → dehaze → AgX → Rec.2020→sRGB → PNG.

#![warn(clippy::all, rust_2018_idioms)]
