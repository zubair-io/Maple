//! Full-frame scene statistic for Whites (#3601), measured before AE.
//! Bounded deterministic sampling avoids a full-image allocation and sort.
//! Hosts carry this value with the decoded frame; a tile never measures it.
const SAMPLE_COUNT: usize = 16384;

pub fn measure(count: usize, pixel: impl Fn(usize) -> [f32; 3]) -> f32 {
    if count == 0 {
        return 0.0;
    }
    let n = count.min(SAMPLE_COUNT);
    let mut values = [0.0f32; SAMPLE_COUNT];
    for (i, value) in values[..n].iter_mut().enumerate() {
        // One reproducible sample per stratum. Midpoints alias a handful of
        // columns when the image width divides the stride (e.g. 4096²).
        // Hash the stratum, never the pixels or mutable random state.
        let start = i * (count / n) + i * (count % n) / n;
        let end = (i + 1) * (count / n) + (i + 1) * (count % n) / n;
        let hash = (i as u32).wrapping_add(0x9e37_79b9);
        let hash = (hash ^ (hash >> 16)).wrapping_mul(0x7feb_352d);
        let hash = (hash ^ (hash >> 15)).wrapping_mul(0x846c_a68b);
        let hash = hash ^ (hash >> 16);
        let index = start + hash as usize % (end - start);
        let p = pixel(index);
        let y = 0.2627 * p[0] + 0.6780 * p[1] + 0.0593 * p[2];
        *value = if y.is_finite() { y.max(1e-8) } else { 1e-8 };
    }
    let rank = ((n - 1) as f64 * 0.99).round() as usize;
    let (_, white, _) = values[..n].select_nth_unstable_by(rank, f32::total_cmp);
    (*white / 0.18).log2()
}

/// Resolve an image's positive Whites amplitude inside the monotonic bound.
/// Negative Whites is independently calibrated and does not use this anchor.
pub fn resolve(whites: f32, ev: f32) -> f32 {
    if whites <= 0.0 {
        return whites;
    }
    let factor = if ev.is_finite() {
        (2.0 - 0.58 * ev).clamp(0.1, 1.1)
    } else {
        1.0
    };
    whites * factor
}
