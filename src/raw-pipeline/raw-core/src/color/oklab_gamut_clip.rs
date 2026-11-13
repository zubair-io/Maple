use super::oklab_gamut::{clamp_unit_scrub_non_finite, hull_scale, in_unit_box};

/// Continuous hull clip for a triple that is already a finished colour: returned
/// untouched inside the `[0, 1]^3` box, otherwise its Oklab chroma is scaled to
/// the hull at constant lightness and hue. Unlike [`compress_to_unit_cube_oklab`]
/// there is no knee, so a pixel just past the hull lands just inside it instead of
/// being pulled to a fixed fraction of it (the P3 Auto restore, #4741).
#[inline]
pub(crate) fn clip_chroma_to_unit_cube_oklab<F, G>(
    rgb: [f32; 3],
    to_oklab: F,
    from_oklab: G,
) -> [f32; 3]
where
    F: Fn([f32; 3]) -> [f32; 3],
    G: Fn([f32; 3]) -> [f32; 3],
{
    if in_unit_box(rgb) {
        return rgb.map(clamp_unit_scrub_non_finite);
    }
    let [l, a, b] = to_oklab(rgb);
    let scale_chroma = |s: f32| from_oklab([l, a * s, b * s]);
    let s_hull = hull_scale(&scale_chroma);
    scale_chroma(s_hull.max(0.0)).map(clamp_unit_scrub_non_finite)
}
