//! Test-only helpers. Gated by the `test-support` feature. These do NOT
//! ship in `libraw_ffi.a` (Apple xcframework) or `raw-wasm` binaries —
//! the feature is opt-in and only enabled by Cargo when running tests
//! or the `synth-grey` example.

pub mod canon_dcp;
pub mod colorchecker;
pub mod fixtures;
pub mod hasselblad_dcp;
pub mod predictions;
pub mod predictions_display;
pub mod synth_chart;
pub mod synth_dng;
pub mod synth_perf;
pub mod synth_sweep;
