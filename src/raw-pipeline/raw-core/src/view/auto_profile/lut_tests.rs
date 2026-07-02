//! Unit tests for [`super`] (the auto-profile color LUT). Split out of
//! `lut.rs` under the 600-LOC file-size budget. Contents moved verbatim.

use super::*;
use crate::view::auto_profile::pairs::DisplayPair;

#[test]
fn identity_lut_is_noop() {
    let lut = ColorLut::identity(17);
    let mut px = vec![0.2f32, 0.5, 0.8, 0.0, 1.0, 0.33];
    let before = px.clone();
    lut.apply(&mut px);
    for (a, b) in px.iter().zip(&before) {
        assert!((a - b).abs() < 1e-4, "{a} vs {b}");
    }
}

#[test]
fn trilinear_recovers_node_values() {
    // A LUT that adds +0.1 to red everywhere: sampling returns node+shift.
    let mut lut = ColorLut::identity(9);
    for n in lut.data.chunks_mut(3) {
        n[0] = (n[0] + 0.1).min(1.0);
    }
    let mut px = vec![0.5f32, 0.5, 0.5];
    lut.apply(&mut px);
    assert!((px[0] - 0.6).abs() < 1e-3, "got {}", px[0]);
    assert!((px[1] - 0.5).abs() < 1e-3);
}

#[test]
fn sparse_pairs_stay_identity() {
    // A lone neutral pair leaves distant corner nodes at identity.
    let pairs = vec![DisplayPair {
        maple: [0.5, 0.5, 0.5],
        jpeg: [0.5, 0.5, 0.5],
    }];
    let lut = fit_lut_from_pairs(&pairs, 9, 1.0);
    let id = ColorLut::identity(9);
    assert!((lut.node(0, 0, 0)[0] - id.node(0, 0, 0)[0]).abs() < 1e-3);
    assert!((lut.node(0, 0, 0)[2] - id.node(0, 0, 0)[2]).abs() < 1e-3);
}

/// #1085 strength contract: the cache stores the full-strength LUT and
/// strength is applied at apply/return time. `apply_with_strength(_, 1.0)`
/// must be BIT-identical to `apply` (the default path the harness gates);
/// `0.0` must be an exact no-op; a mid `k` must lerp input → sample.
#[test]
fn apply_with_strength_matches_contract() {
    let mut lut = ColorLut::identity(9);
    for n in lut.data.chunks_mut(3) {
        n[0] = (n[0] + 0.2).min(1.0); // +0.2 red everywhere
    }
    let src = vec![0.4f32, 0.5, 0.6];

    let mut full = src.clone();
    lut.apply(&mut full);
    let mut k1 = src.clone();
    lut.apply_with_strength(&mut k1, 1.0);
    assert_eq!(k1, full, "k=1.0 must be bit-identical to plain apply");

    let mut k0 = src.clone();
    lut.apply_with_strength(&mut k0, 0.0);
    assert_eq!(k0, src, "k=0.0 must be an exact no-op");

    let mut half = src.clone();
    lut.apply_with_strength(&mut half, 0.5);
    for c in 0..3 {
        let expect = src[c] + 0.5 * (full[c] - src[c]);
        assert!(
            (half[c] - expect).abs() < 1e-6,
            "k=0.5 channel {c}: got {} want {expect}",
            half[c]
        );
    }
}

/// `with_strength` (the GPU-return scaling) agrees with the apply-time
/// lerp away from the node clamp, and `1.0` is a plain clone.
#[test]
fn with_strength_scales_nodes_toward_identity() {
    let mut lut = ColorLut::identity(9);
    for n in lut.data.chunks_mut(3) {
        n[0] = (n[0] + 0.2).min(1.0);
    }
    assert_eq!(lut.with_strength(1.0), lut, "k=1.0 is a plain clone");
    let half = lut.with_strength(0.5);
    // Mid-grey is far from the clamp: scaled-LUT sample == lerped apply.
    let mut via_scaled = vec![0.4f32, 0.5, 0.6];
    half.apply(&mut via_scaled);
    let mut via_lerp = vec![0.4f32, 0.5, 0.6];
    lut.apply_with_strength(&mut via_lerp, 0.5);
    for c in 0..3 {
        assert!(
            (via_scaled[c] - via_lerp[c]).abs() < 1e-6,
            "channel {c}: scaled {} vs lerp {}",
            via_scaled[c],
            via_lerp[c]
        );
    }
}

#[test]
fn recovers_uniform_shift() {
    // Pairs along the grey diagonal that all add +0.1 red → LUT boosts mid-grey red.
    let pairs: Vec<_> = (0..200)
        .map(|i| {
            let v = i as f32 / 199.0;
            DisplayPair {
                maple: [v, v, v],
                jpeg: [(v + 0.1).min(1.0), v, v],
            }
        })
        .collect();
    let lut = fit_lut_from_pairs(&pairs, 9, 1.0);
    let mut px = vec![0.5f32, 0.5, 0.5];
    lut.apply(&mut px);
    assert!(px[0] > 0.55, "red not boosted: {}", px[0]);
    assert!(
        (px[1] - 0.5).abs() < 0.03 && (px[2] - 0.5).abs() < 0.03,
        "green/blue drifted"
    );
}
