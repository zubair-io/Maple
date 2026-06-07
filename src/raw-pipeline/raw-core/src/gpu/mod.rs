//! GPU compute spike (epic #925, P0). Feature-gated behind `gpu` (OFF by
//! default). Proves one stage (exposure: `rgb *= 2^ev`) runs GPU-resident via
//! wgpu+WGSL and matches the Rust CPU oracle within 1e-4. The CPU path in
//! `raw-core` stays the parity oracle and fallback.

/// Scene-linear exposure gain on an interleaved RGBA f32 buffer:
/// `rgb *= 2^ev`, alpha untouched. This is the spike's CPU oracle — it mirrors
/// the `baseline_exposure.exp2()` multiply in `pipeline::develop` (and the
/// additive-EV user exposure), kept standalone so the spike isolates GPU
/// plumbing rather than pipeline integration.
pub fn apply_exposure_gain(buf: &mut [f32], ev: f32) {
    let gain = ev.exp2();
    for px in buf.chunks_exact_mut(4) {
        px[0] *= gain;
        px[1] *= gain;
        px[2] *= gain;
        // px[3] (alpha) untouched
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposure_gain_doubles_rgb_at_plus_one_ev_and_keeps_alpha() {
        // Two RGBA pixels. +1 EV → gain = 2^1 = 2.0.
        let mut buf = vec![0.1, 0.2, 0.4, 1.0, 0.5, 0.5, 0.5, 0.3];
        apply_exposure_gain(&mut buf, 1.0);
        assert!((buf[0] - 0.2).abs() < 1e-6);
        assert!((buf[1] - 0.4).abs() < 1e-6);
        assert!((buf[2] - 0.8).abs() < 1e-6);
        assert!((buf[3] - 1.0).abs() < 1e-6, "alpha untouched");
        assert!((buf[4] - 1.0).abs() < 1e-6);
        assert!((buf[7] - 0.3).abs() < 1e-6, "alpha untouched");
    }
}
