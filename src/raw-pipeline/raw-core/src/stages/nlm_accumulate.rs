#[cfg(target_arch = "aarch64")]
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
    for i in start..count {
        let weight = fast_neg_exp(sums[i].max(0.0) * inv_norm);
        acc[i] += weight * shifted[i];
        weights[i] += weight;
        maxima[i] = maxima[i].max(weight);
    }
}
