use super::*;

/// Zone-weight goldens shared with the Web (`color-grading-panel.spec.ts`) and
/// Windows (`ColorGradeZoneWeightsTests.cs`) strips: `(l, balance, blending,
/// shadow_edge, highlight_edge, [shadow, midtone, highlight])`. The editors
/// draw these weights; the stage applies them.
const ZONE_WEIGHT_GOLDENS: [(f32, f32, f32, f32, f32, [f32; 3]); 10] = [
    (
        0.05f32,
        0f32,
        100f32,
        0.564622f32,
        0.564622f32,
        [0.977863f32, 0.022137f32, 0.000000f32],
    ),
    (
        0.3f32,
        0f32,
        100f32,
        0.564622f32,
        0.564622f32,
        [0.453068f32, 0.546932f32, 0.000000f32],
    ),
    (
        0.564622f32,
        0f32,
        100f32,
        0.564622f32,
        0.564622f32,
        [0.000000f32, 1.000000f32, 0.000000f32],
    ),
    (
        0.8f32,
        0f32,
        100f32,
        0.564622f32,
        0.564622f32,
        [0.000000f32, 0.439191f32, 0.560809f32],
    ),
    (
        0.25f32,
        0f32,
        50f32,
        0.3f32,
        0.7f32,
        [0.208630f32, 0.791370f32, 0.000000f32],
    ),
    (
        0.65f32,
        0f32,
        50f32,
        0.3f32,
        0.7f32,
        [0.000000f32, 1.000000f32, 0.000000f32],
    ),
    (
        0.7f32,
        20f32,
        60f32,
        0.35f32,
        0.65f32,
        [0.000000f32, 0.693957f32, 0.306043f32],
    ),
    (
        0.15f32,
        0f32,
        25f32,
        0.2f32,
        0.75f32,
        [0.683594f32, 0.316406f32, 0.000000f32],
    ),
    (
        0.9f32,
        0f32,
        0f32,
        0.3f32,
        0.7f32,
        [0.000000f32, 0.000000f32, 1.000000f32],
    ),
    (
        0.5f32,
        -40f32,
        0f32,
        0.2f32,
        0.8f32,
        [0.000000f32, 1.000000f32, 0.000000f32],
    ),
];

#[test]
fn zone_weights_match_the_goldens_the_editor_strips_are_tested_against() {
    for (l, balance, blending, shadow_edge, highlight_edge, want) in ZONE_WEIGHT_GOLDENS {
        let edges = zone_edges(blending, shadow_edge, highlight_edge);
        let got = zone_weights_with_edges(l, (-balance / 100.0f32).exp2(), edges);
        for (g, w) in got.iter().zip(want) {
            assert!(
                (g - w).abs() < 1e-5,
                "l {l}, balance {balance}, blending {blending}, edges {shadow_edge}/{highlight_edge}: {got:?} != {want:?}"
            );
        }
        assert!(
            (got.iter().sum::<f32>() - 1.0).abs() < 1e-5,
            "partition of unity"
        );
    }
}
