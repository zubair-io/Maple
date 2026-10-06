#[cfg(any(
    target_arch = "aarch64",
    all(target_arch = "wasm32", target_feature = "simd128")
))]
use super::fast_exp_table;
use super::fast_neg_exp;

pub(super) fn accumulate(
    sums: &[f32],
    shifted: &[f32],
    acc: &mut [f32],
    weights: &mut [f32],
    maxima: &mut [f32],
    inv_norm: f32,
) {
    let count = sums.len();
    assert_eq!(shifted.len(), count);
    assert_eq!(acc.len(), count);
    assert_eq!(weights.len(), count);
    assert_eq!(maxima.len(), count);
    #[allow(unused_mut)]
    let mut start = 0;
    #[cfg(target_arch = "aarch64")]
    {
        use std::arch::aarch64::*;
        let table = fast_exp_table();
        // AArch64 guarantees NEON; every load/store stays inside these equal-length slices.
        unsafe {
            let norm = vdupq_n_f32(inv_norm);
            while start + 4 <= count {
                let x = vmulq_f32(
                    vmaxnmq_f32(vld1q_f32(sums.as_ptr().add(start)), vdupq_n_f32(0.0)),
                    norm,
                );
                let t = vmulq_f32(vminnmq_f32(x, vdupq_n_f32(8.0)), vdupq_n_f32(64.0));
                let indices = vcvtq_u32_f32(t);
                let mut index = [0u32; 4];
                vst1q_u32(index.as_mut_ptr(), indices);
                let a = index.map(|i| table[(i as usize).min(511)]);
                let b = index.map(|i| table[(i as usize).min(511) + 1]);
                let av = vld1q_f32(a.as_ptr());
                let fraction = vsubq_f32(t, vcvtq_f32_u32(indices));
                let weight = vaddq_f32(
                    av,
                    vmulq_f32(vsubq_f32(vld1q_f32(b.as_ptr()), av), fraction),
                );
                let weight = vbslq_f32(vcltq_f32(x, vdupq_n_f32(8.0)), weight, vdupq_n_f32(0.0));
                vst1q_f32(
                    acc.as_mut_ptr().add(start),
                    vaddq_f32(
                        vld1q_f32(acc.as_ptr().add(start)),
                        vmulq_f32(weight, vld1q_f32(shifted.as_ptr().add(start))),
                    ),
                );
                vst1q_f32(
                    weights.as_mut_ptr().add(start),
                    vaddq_f32(vld1q_f32(weights.as_ptr().add(start)), weight),
                );
                vst1q_f32(
                    maxima.as_mut_ptr().add(start),
                    vmaxq_f32(vld1q_f32(maxima.as_ptr().add(start)), weight),
                );
                start += 4;
            }
        }
    }
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        use std::arch::wasm32::*;
        // Rust's numeric max ignores a single NaN; wasm f32x4.max does not.
        // Keep that scalar boundary, including max's signed-zero result.
        fn max_number(a: v128, b: v128) -> v128 {
            v128_bitselect(
                b,
                v128_bitselect(a, f32x4_max(a, b), f32x4_ne(b, b)),
                f32x4_ne(a, a),
            )
        }
        let table = fast_exp_table();
        // SIMD128 is a shipping target feature. Equal-length guards above
        // bound every unaligned four-lane load/store; the tail stays scalar.
        unsafe {
            let zero = f32x4_splat(0.0);
            let norm = f32x4_splat(inv_norm);
            while start + 4 <= count {
                let x = f32x4_mul(
                    max_number(v128_load(sums.as_ptr().add(start).cast()), zero),
                    norm,
                );
                let bounded =
                    v128_bitselect(zero, f32x4_min(x, f32x4_splat(8.0)), f32x4_lt(x, zero));
                let t = f32x4_mul(bounded, f32x4_splat(64.0));
                let indices = i32x4_trunc_sat_f32x4(t);
                let index = [
                    i32x4_extract_lane::<0>(indices),
                    i32x4_extract_lane::<1>(indices),
                    i32x4_extract_lane::<2>(indices),
                    i32x4_extract_lane::<3>(indices),
                ];
                let a = index.map(|i| table[i.clamp(0, 511) as usize]);
                let b = index.map(|i| table[i.clamp(0, 511) as usize + 1]);
                let av = v128_load(a.as_ptr().cast());
                let fraction = f32x4_sub(t, f32x4_convert_i32x4(indices));
                // Separate multiply/add, matching scalar interpolation; no FMA.
                let weight = f32x4_add(
                    av,
                    f32x4_mul(f32x4_sub(v128_load(b.as_ptr().cast()), av), fraction),
                );
                let weight = v128_bitselect(zero, weight, f32x4_ge(x, f32x4_splat(8.0)));
                let weight = v128_bitselect(f32x4_splat(1.0), weight, f32x4_lt(x, zero));
                v128_store(
                    acc.as_mut_ptr().add(start).cast(),
                    f32x4_add(
                        v128_load(acc.as_ptr().add(start).cast()),
                        f32x4_mul(weight, v128_load(shifted.as_ptr().add(start).cast())),
                    ),
                );
                v128_store(
                    weights.as_mut_ptr().add(start).cast(),
                    f32x4_add(v128_load(weights.as_ptr().add(start).cast()), weight),
                );
                v128_store(
                    maxima.as_mut_ptr().add(start).cast(),
                    max_number(v128_load(maxima.as_ptr().add(start).cast()), weight),
                );
                start += 4;
            }
        }
    }
    for i in start..count {
        let weight = fast_neg_exp(sums[i].max(0.0) * inv_norm);
        acc[i] += weight * shifted[i];
        weights[i] += weight;
        maxima[i] = maxima[i].max(weight);
    }
}

// Dynamic camera-noise rows already own norms/search radii in the NLM kernel.
// Borrow them without changing its sums, pruning, or worker/reseed geometry.
#[cfg(any(test, all(target_arch = "wasm32", target_feature = "simd128")))]
pub(super) fn accumulate_dynamic(
    sums: &[f32],
    shifted: &[f32],
    acc: &mut [f32],
    weights: &mut [f32],
    maxima: &mut [f32],
    dynamic: (&[f32], &[isize], isize),
) {
    let (norms, search, distance) = dynamic;
    let count = sums.len();
    assert_eq!(shifted.len(), count);
    assert_eq!(acc.len(), count);
    assert_eq!(weights.len(), count);
    assert_eq!(maxima.len(), count);
    assert_eq!(norms.len(), count);
    assert_eq!(search.len(), count);
    #[allow(unused_mut)]
    let mut start = 0;
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        use std::arch::wasm32::*;
        let table = fast_exp_table();
        unsafe {
            let zero = f32x4_splat(0.0);
            while start + 4 <= count {
                let sum_lanes = v128_load(sums.as_ptr().add(start).cast());
                let clamped = v128_bitselect(
                    zero,
                    f32x4_max(sum_lanes, zero),
                    f32x4_ne(sum_lanes, sum_lanes),
                );
                let x = f32x4_mul(clamped, v128_load(norms.as_ptr().add(start).cast()));
                let bounded =
                    v128_bitselect(zero, f32x4_min(x, f32x4_splat(8.0)), f32x4_lt(x, zero));
                let t = f32x4_mul(bounded, f32x4_splat(64.0));
                let indices = i32x4_trunc_sat_f32x4(t);
                let index = [
                    i32x4_extract_lane::<0>(indices),
                    i32x4_extract_lane::<1>(indices),
                    i32x4_extract_lane::<2>(indices),
                    i32x4_extract_lane::<3>(indices),
                ];
                let a = index.map(|i| table[i.clamp(0, 511) as usize]);
                let b = index.map(|i| table[i.clamp(0, 511) as usize + 1]);
                let av = v128_load(a.as_ptr().cast());
                let frac = f32x4_sub(t, f32x4_convert_i32x4(indices));
                let weight = f32x4_add(
                    av,
                    f32x4_mul(f32x4_sub(v128_load(b.as_ptr().cast()), av), frac),
                );
                let weight = v128_bitselect(zero, weight, f32x4_ge(x, f32x4_splat(8.0)));
                let weight = v128_bitselect(f32x4_splat(1.0), weight, f32x4_lt(x, zero));
                let enabled = i32x4_ge(
                    v128_load(search.as_ptr().add(start).cast()),
                    i32x4_splat(distance as i32),
                );
                let old_acc = v128_load(acc.as_ptr().add(start).cast());
                let old_weights = v128_load(weights.as_ptr().add(start).cast());
                let old_max = v128_load(maxima.as_ptr().add(start).cast());
                if v128_any_true(v128_or(
                    f32x4_ne(old_acc, old_acc),
                    f32x4_ne(old_weights, old_weights),
                )) {
                    scalar_dynamic(
                        &sums[start..start + 4],
                        &shifted[start..start + 4],
                        &mut acc[start..start + 4],
                        &mut weights[start..start + 4],
                        &mut maxima[start..start + 4],
                        (
                            &norms[start..start + 4],
                            &search[start..start + 4],
                            distance,
                        ),
                    );
                    start += 4;
                    continue;
                }
                // A pruned lane is not evaluated by the scalar caller. Select
                // its original bits, rather than add zero (NaN/signed zero).
                v128_store(
                    acc.as_mut_ptr().add(start).cast(),
                    v128_bitselect(
                        f32x4_add(
                            old_acc,
                            f32x4_mul(weight, v128_load(shifted.as_ptr().add(start).cast())),
                        ),
                        old_acc,
                        enabled,
                    ),
                );
                v128_store(
                    weights.as_mut_ptr().add(start).cast(),
                    v128_bitselect(f32x4_add(old_weights, weight), old_weights, enabled),
                );
                // The original dynamic path uses ordered `>`; numeric max
                // would incorrectly replace a NaN maximum.
                v128_store(
                    maxima.as_mut_ptr().add(start).cast(),
                    v128_bitselect(
                        weight,
                        old_max,
                        v128_and(enabled, f32x4_gt(weight, old_max)),
                    ),
                );
                start += 4;
            }
        }
    }
    if start < count {
        scalar_dynamic(
            &sums[start..],
            &shifted[start..],
            &mut acc[start..],
            &mut weights[start..],
            &mut maxima[start..],
            (&norms[start..], &search[start..], distance),
        );
    }
}

// Nonfinite accumulators retain the original scalar operation/payload choice.
// Finite camera rows do not enter this fallback. The original kernel body is
// also the required WASM witness's mechanically source-captured oracle.
#[cfg(any(test, all(target_arch = "wasm32", target_feature = "simd128")))]
#[inline(never)]
pub(super) fn scalar_dynamic(
    sums: &[f32],
    shifted: &[f32],
    acc: &mut [f32],
    weights: &mut [f32],
    maxima: &mut [f32],
    dynamic: (&[f32], &[isize], isize),
) {
    let (local_inv_norm_plane, local_s_plane, dy) = dynamic;
    let dx = 0isize;
    let y = 0usize;
    let w = sums.len();
    let colsum = sums;
    let shift_row = shifted;
    let acc_row = acc;
    let wsum_row = weights;
    let max_w_row = maxima;
    for x in 0..w {
        // Dynamic variance-scaled NLM
        let idx = y * w + x;
        let local_s = local_s_plane[idx];

        if dx.abs() > local_s || dy.abs() > local_s {
            continue;
        }

        let ssd = colsum[x].max(0.0);
        let weight = fast_neg_exp(ssd * local_inv_norm_plane[idx]);
        let sx = (x as isize + dx) as usize;
        acc_row[x] += weight * shift_row[sx];
        wsum_row[x] += weight;
        if weight > max_w_row[x] {
            max_w_row[x] = weight;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vector_accumulation_is_bit_identical_to_scalar_including_tail() {
        // All LUT segments, interpolation fractions, cutoff and SIMD tail.
        let sums: Vec<f32> = (0..4103).map(|i| i as f32 / 512.0).collect();
        let shifted: Vec<f32> = (0..sums.len()).map(|i| (i % 31) as f32 / 32.0).collect();
        let mut acc = vec![0.125; sums.len()];
        let mut weights = vec![0.25; sums.len()];
        let mut maxima = vec![0.375; sums.len()];
        accumulate(&sums, &shifted, &mut acc, &mut weights, &mut maxima, 1.0);
        for i in 0..sums.len() {
            let weight = fast_neg_exp(sums[i]);
            assert_eq!(
                acc[i].to_bits(),
                (0.125 + weight * shifted[i]).to_bits(),
                "{i}"
            );
            assert_eq!(weights[i].to_bits(), (0.25 + weight).to_bits(), "{i}");
            assert_eq!(maxima[i].to_bits(), 0.375f32.max(weight).to_bits(), "{i}");
        }
    }
    #[test]
    fn accumulation_keeps_scalar_bits_across_cutoffs_and_short_tails() {
        let edges = [0.0, -0.0, -1.0, 1.0 / 64.0, 7.999, 8.0, 8.001, 64.0];
        for count in 0..20 {
            let sums: Vec<_> = (0..count).map(|i| edges[i % edges.len()]).collect();
            let shifted: Vec<_> = (0..count).map(|i| (i as f32 - 9.0) * 1024.0).collect();
            let mut acc = vec![-0.125; count];
            let mut weights = vec![0.25; count];
            let mut maxima = vec![0.375; count];
            accumulate(&sums, &shifted, &mut acc, &mut weights, &mut maxima, 1.0);
            for i in 0..count {
                let weight = fast_neg_exp(sums[i].max(0.0));
                assert_eq!(acc[i].to_bits(), (-0.125 + weight * shifted[i]).to_bits());
                assert_eq!(weights[i].to_bits(), (0.25 + weight).to_bits());
                assert_eq!(maxima[i].to_bits(), 0.375f32.max(weight).to_bits());
            }
        }
    }
}
