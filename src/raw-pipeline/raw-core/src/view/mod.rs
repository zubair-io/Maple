pub mod agx;
pub mod dither;
pub mod encode;
// `look` module retired in #443 (Wave-3 closing step of #416). The
// empirical u8→u8 LUT lived here; the `Look` enum is preserved on
// `AdjustmentModel` for sidecar back-compat. See
// `crate::types::adjustment::Look`.
