//! Continuous, shared-bit exponential weights for NLM.

/// Canonical exp(-x) interpolation over [0, 8), extended by exp(-8*n).
/// Positive tails matter after NLM normalization: discarding exp(-8) created
/// visible jumps when CPU/GPU rounding put a distance on opposite sides.
/// Shared binary32 factors preserve continuity through exponential underflow.
const FAST_EXP_RANGE: f32 = 8.0;
const FAST_EXP_TABLE_SIZE: usize = 512;

#[inline(always)]
pub(super) fn fast_neg_exp(x: f32) -> f32 {
    // Negative-input guard — defense layer 2 of 2 for #1086. Post-#1195 the
    // box-sum patch SSD is a sum of squares over a LOCAL window and is ≥ 0 by
    // construction (no global-prefix cancellation), so x = ssd·inv_norm ≥ 0 and
    // layer 1 (the `.max(0.0)` clamp in `process_shift`) is belt-and-braces.
    // This guard is kept as cheap insurance: unguarded, a negative x is silently
    // catastrophic here — `t as usize` saturates to 0, `frac` goes negative, and
    // the first table segment EXTRAPOLATES to ≈ 1 + |x|, a weight growing
    // linearly in |x| instead of capping at 1, letting one shift dominate the
    // average. exp(0) = 1
    // is the correct limit for ssd → 0⁻, so return exactly 1.0.
    if x < 0.0 {
        return 1.0;
    }
    // Range reduction keeps the normalized NLM weights continuous. Dropping
    // exp(-8) is unsafe: normalization can amplify that small absolute weight.
    // At 104 the mathematical exponential rounds to zero in binary32.
    if x >= 104.0 {
        return 0.0;
    }
    let block = (x / FAST_EXP_RANGE) as usize;
    let reduced = x - block as f32 * FAST_EXP_RANGE;
    let t = reduced * (FAST_EXP_TABLE_SIZE as f32 / FAST_EXP_RANGE);
    let i = t as usize;
    let frac = t - i as f32;
    let table = fast_exp_table();
    // SAFETY: i < FAST_EXP_TABLE_SIZE because reduced < FAST_EXP_RANGE.
    // The table has FAST_EXP_TABLE_SIZE + 1 entries to make the
    // i+1 lookup safe at the upper bound.
    let a = table[i];
    let b = table[i + 1];
    (a + (b - a) * frac) * exp_table::SCALES[block]
}

#[path = "nlm_exp_table.rs"]
mod exp_table;
pub(super) fn fast_exp_table() -> &'static [f32; FAST_EXP_TABLE_SIZE + 1] {
    &exp_table::VALUES
}
