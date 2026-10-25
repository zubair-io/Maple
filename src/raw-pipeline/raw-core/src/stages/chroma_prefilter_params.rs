//! Shared chroma prefilter parameters, compiled by CPU and GPU hosts.

/// Rec.2020 luma weights — same constants as `stages::scene_tone_controls`
/// and the WGSL kernels.
pub const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

/// The 8 off-center sparse taps (center is implicit, weight 1). Two 4-tap
/// 90°-rotation orbits: radius √5 ≈ 2.24 px and radius √17 ≈ 4.12 px, so
/// the kernel spans 9 px corner-to-corner. Every offset has at least one
/// odd coordinate (decorrelates from the 2×2 Bayer period — a same-CFA-site
/// offset is (even, even)) and none is ≡ (0, 0) mod 6 (X-Trans period).
/// Each orbit sums to zero displacement, so the kernel is directionally
/// unbiased.
pub const TAPS: [(i32, i32); 8] = [
    (1, -2),
    (-2, -1),
    (2, 1),
    (-1, 2),
    (4, 1),
    (-1, 4),
    (-4, -1),
    (1, -4),
];

/// Quadratic spatial penalty: `w = 1 / (1 + r² / R0²)` with `R0² = 16`
/// (≈ the outer-orbit radius squared). Inner orbit (r² = 5) → 16/21;
/// outer orbit (r² = 17) → 16/33. Indexed in step with [`TAPS`].
pub const SPATIAL_W: [f32; 8] = [
    16.0 / 21.0,
    16.0 / 21.0,
    16.0 / 21.0,
    16.0 / 21.0,
    16.0 / 33.0,
    16.0 / 33.0,
    16.0 / 33.0,
    16.0 / 33.0,
];

/// Relative range sigma at strength 100. The Cauchy range weight is
/// `1 / (1 + (ΔY / (σ·scale))²)` with `scale = |Y_c + Y_t|/2 + PEDESTAL`,
/// so σ is a *relative* luma difference: at strength 100 a tap whose luma
/// differs from the center by 50% of the local level still carries half
/// weight. Relative normalisation keeps the response invariant to the
/// per-camera capture scale (the stage runs before auto-exposure).
pub const SIGMA_MAX_REL: f32 = 0.5;

/// Pedestal added to the local luma scale so deep-shadow noise (where the
/// *relative* fluctuation is huge but the *absolute* signal is tiny) is
/// still smoothed: below ~0.01 (≈ −4 EV under mid-grey) differences are
/// effectively measured against the pedestal instead of the signal.
pub const PEDESTAL: f32 = 0.01;
