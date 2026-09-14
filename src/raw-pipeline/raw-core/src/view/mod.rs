pub mod acr_fit;
pub mod agx;
pub mod agx_inverse;
pub mod agx_whites;
pub mod auto_profile;
pub mod dither;
pub mod encode;
pub mod gamma;
pub mod grade_inverse;
pub mod look;
pub mod quantize16;

/// Phase-0 inpainting de-risk gate (#1473) — end-to-end synthetic-raw
/// round-trip. Test-only; lives in a sibling file to keep this module list
/// clean and stay under the file-size budget.
#[cfg(test)]
#[path = "inpaint_roundtrip_tests.rs"]
mod inpaint_roundtrip_tests;

/// `whites` parameter tests for `agx::neutral_curve` (Task 2, #3601) — split
/// out of `agx.rs`'s own `mod tests` to stay within the 570-line budget.
#[cfg(test)]
#[path = "agx_whites_tests.rs"]
mod agx_whites_tests;

/// Shared full-frame Whites statistic.
pub mod whites_anchor;

#[cfg(test)]
mod whites_anchor_tests;
