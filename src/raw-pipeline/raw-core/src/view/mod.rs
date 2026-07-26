pub mod acr_fit;
pub mod agx;
pub mod agx_inverse;
pub mod auto_profile;
pub mod dither;
pub mod encode;
pub mod grade_inverse;
pub mod look;
pub mod quantize16;

/// Phase-0 inpainting de-risk gate (#1473) — end-to-end synthetic-raw
/// round-trip. Test-only; lives in a sibling file to keep this module list
/// clean and stay under the file-size budget.
#[cfg(test)]
#[path = "inpaint_roundtrip_tests.rs"]
mod inpaint_roundtrip_tests;
