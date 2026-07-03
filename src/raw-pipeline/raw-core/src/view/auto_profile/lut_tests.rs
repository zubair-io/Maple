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
    let pairs = vec![DisplayPair { maple: [0.5, 0.5, 0.5], jpeg: [0.5, 0.5, 0.5] }];
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
            DisplayPair { maple: [v, v, v], jpeg: [(v + 0.1).min(1.0), v, v] }
        })
        .collect();
    let lut = fit_lut_from_pairs(&pairs, 9, 1.0);
    let mut px = vec![0.5f32, 0.5, 0.5];
    lut.apply(&mut px);
    assert!(px[0] > 0.55, "red not boosted: {}", px[0]);
    assert!((px[1] - 0.5).abs() < 0.03 && (px[2] - 0.5).abs() < 0.03, "green/blue drifted");
}

/// #1737 (b): out-of-gamut feathering + smoothness regularization.
///
/// Builds a fake JPEG fit whose `(maple, jpeg)` pairs only cover a
/// bounded, voluminous sub-region of the RGB cube — a "backlit bokeh"
/// stand-in: a real photograph's in-gamut midtones and shadows populate
/// a broad swath of the cube (like `sample_display_pairs` produces for a
/// real image), but its brightest, most saturated highlights fall outside
/// the embedded 8-bit sRGB JPEG's gamut and leave that corner of the
/// lattice with NO correspondence data at all. Then asserts:
///   1. no second-difference (curvature) spike across adjacent grid cells
///      along a smooth scene-linear gradient probe exceeds the derived
///      budget — this is the posterization/banding metric: a smooth
///      continuous scene must not produce a lattice kink.
///   2. far-out-of-gamut cells (no fit support at all) carry ZERO
///      residual correction, not an extrapolated / clamped copy of the
///      nearest fitted value.
mod gamut_feathering {
    use super::*;

    const SIZE: usize = 17;

    /// Pairs covering a voluminous IN-GAMUT box `[0, 0.6]³` of the cube
    /// (dense random sampling, matching the shape `sample_display_pairs`
    /// produces for a real photo's midtones/shadows), each carrying a
    /// strong, roughly-uniform +0.2 lift (the backlit-bokeh stand-in: the
    /// JPEG clips/tone-maps brighter than Maple's scene-linear render).
    /// The `(0.6, 1.0]` shell of the cube — the brightest, most saturated
    /// highlights — gets NO pairs at all: no JPEG correspondence, exactly
    /// the ticket's out-of-gamut backlit-bokeh scenario.
    fn box_fit_with_out_of_gamut_shell() -> Vec<DisplayPair> {
        const IN_GAMUT_MAX: f32 = 0.6;
        let mut pairs = Vec::new();
        let mut state = 0x243f6a8885a308d3u64; // fixed seed, deterministic
        let mut next_unit = || {
            // xorshift64*, cheap deterministic PRNG — no external dep.
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 11) as f32 / (1u64 << 53) as f32
        };
        for _ in 0..20_000 {
            let r = next_unit() * IN_GAMUT_MAX;
            let g = next_unit() * IN_GAMUT_MAX;
            let b = next_unit() * IN_GAMUT_MAX;
            let lifted = |v: f32| (v + 0.2).clamp(0.0, 1.0);
            pairs.push(DisplayPair {
                maple: [r, g, b],
                jpeg: [lifted(r), lifted(g), lifted(b)],
            });
        }
        pairs
    }

    /// Max |second difference| of the red-channel residual delta
    /// (`sample(node) - node`) along a smooth scene-linear gradient probe
    /// that sweeps the grey diagonal from black to white — crossing
    /// straight through the populated-box / empty-shell boundary at
    /// `v ~= 0.6`. This is the discrete curvature the interpolant carries
    /// into the rendered image — a smooth continuous scene must not show
    /// a spike here, or the render bands.
    fn max_second_diff_on_diagonal(lut: &ColorLut) -> f32 {
        let n = lut.size;
        let denom = (n - 1) as f32;
        let residual = |i: usize| -> f32 {
            let v = i as f32 / denom;
            let out = lut.sample([v, v, v]);
            out[0] - v
        };
        (1..n - 1)
            .map(|i| (residual(i + 1) - 2.0 * residual(i) + residual(i - 1)).abs())
            .fold(0.0f32, f32::max)
    }

    /// RED-run derivation (#1737b): on `main` (pre-fix, no feathering),
    /// this fixture's confidence-masked smoothing leaves the last-
    /// populated cells at their full fitted delta while their untouched
    /// neighbours one step into the empty shell are hard-zero, measuring
    /// a max second difference of **0.08710** on the grey diagonal probe
    /// — a one-cell-wide kink at the populated/empty boundary. After
    /// [`feather_to_identity`] (best-of-13-lines DENSITY, smootherstep-
    /// ramped so both the empty-side and full-strength-side joins have
    /// matching zero curvature) the same fixture measures **0.07808** at
    /// [`FEATHER_RADIUS`] = 2. This budget is that post-fix number plus
    /// ~8% headroom (per repo convention: derive on RED, then add slack).
    ///
    /// [`FEATHER_RADIUS`] is deliberately NOT tuned wider to chase a
    /// bigger margin here: this fixture is a synthetic worst case (a
    /// hard-edged, deliberately unrealistic box/shell cut with a uniform
    /// +0.2 residual), and widening the radius to shrink its spike
    /// measurably regresses `baseline_auto` ΔE-vs-ACR on real fixtures
    /// (see [`FEATHER_RADIUS`]'s derivation comment) by over-feathering
    /// the naturally porous correspondence sets real photos produce. The
    /// modest margin here reflects a deliberate trade favouring real-
    /// fixture accuracy over this synthetic probe's headroom.
    const MAX_SECOND_DIFF_BUDGET: f32 = 0.0843;

    #[test]
    fn no_second_difference_spike_across_sparse_boundary() {
        let pairs = box_fit_with_out_of_gamut_shell();
        let lut = fit_lut_from_pairs(&pairs, SIZE, 1.0);
        let spike = max_second_diff_on_diagonal(&lut);
        if spike >= MAX_SECOND_DIFF_BUDGET {
            eprintln!("DIAG spike={spike}");
            let denom = (lut.size - 1) as f32;
            for i in 0..lut.size {
                let v = i as f32 / denom;
                let out = lut.sample([v, v, v]);
                eprintln!("  i={i} v={v:.4} delta_r={:.5}", out[0] - v);
            }
        }
        assert!(
            spike < MAX_SECOND_DIFF_BUDGET,
            "second-difference spike {spike} exceeds budget {MAX_SECOND_DIFF_BUDGET} \
             (lattice kink at the sparse-fit boundary -> banding)"
        );
    }

    /// Far-out-of-gamut cells (no fit support, and far from the populated
    /// box) must carry ZERO residual correction — decay to identity, not
    /// an extrapolated/clamped copy of the last fitted value. Probes the
    /// brightest, most saturated corner (`r=1,g=1,b=1` and `r=1,g=0,b=0`),
    /// which the `[0, 0.6]³` box fit never reaches.
    #[test]
    fn far_out_of_gamut_corner_has_zero_correction() {
        let pairs = box_fit_with_out_of_gamut_shell();
        let lut = fit_lut_from_pairs(&pairs, SIZE, 1.0);
        let id = ColorLut::identity(SIZE);
        for (r, g, b) in [(SIZE - 1, SIZE - 1, SIZE - 1), (SIZE - 1, 0, 0)] {
            let corner = lut.node(r, g, b);
            let id_corner = id.node(r, g, b);
            for c in 0..3 {
                assert!(
                    (corner[c] - id_corner[c]).abs() < 1e-4,
                    "far out-of-gamut corner ({r},{g},{b}) channel {c} carries \
                     correction: {} vs identity {}",
                    corner[c],
                    id_corner[c]
                );
            }
        }
    }
}
