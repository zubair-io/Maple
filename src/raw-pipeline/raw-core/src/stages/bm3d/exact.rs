//! Backend-independent multiply-adds for the values BM3D ranks on (#5217).
//!
//! WGSL `fma` may round once (Metal) or twice (lavapipe), and a plain
//! `a * b + c` may be contracted either way. Splitting every operand into
//! halves of at most 12 significant bits makes each partial product exact
//! in f32, so fused and unfused evaluation agree and the CPU reference, Metal
//! and Vulkan produce identical luma and match distances. The WGSL twins live
//! in `raw-gpu/src/bm3d/common.wgsl` and must keep the same term order.

use super::parameters::LUMA_REC2020;

/// `x = hi + lo` exactly, each with at most 12 significant bits.
#[inline]
fn split(x: f32) -> (f32, f32) {
    let hi = f32::from_bits(x.to_bits() & 0xffff_f000);
    (hi, x - hi)
}

/// `acc + a·b`, adding the four exact partial products in a fixed order.
#[inline]
pub fn mul_add(a: f32, b: f32, acc: f32) -> f32 {
    let (ah, al) = split(a);
    let (bh, bl) = split(b);
    acc + ah * bh + ah * bl + al * bh + al * bl
}

/// `acc + d²`, adding the three exact partial products in a fixed order.
#[inline]
pub fn square_add(d: f32, acc: f32) -> f32 {
    let (dh, dl) = split(d);
    acc + dh * dh + dh * (dl + dl) + dl * dl
}

/// Rec.2020 luma, blue term first.
#[inline]
pub fn luminance(p: [f32; 3]) -> f32 {
    let blue = mul_add(LUMA_REC2020[2], p[2], 0.0);
    mul_add(LUMA_REC2020[0], p[0], mul_add(LUMA_REC2020[1], p[1], blue))
}
