use super::*;
use crate::color::hsm::{apply_one, hsv_to_rgb, lerp_tables, HsmTable};

/// Two smooth, clearly different HueSatMaps over a 6×4×`val_divs` lattice:
/// hue shifts of several degrees and saturation and value scales away from 1
/// that vary across the lattice (value too, when it has an axis), so a delta
/// that ignored the table, or read it at the wrong brightness, would miss.
fn endpoint_tables_shaped(val_divs: u32, encoding: HsmEncoding) -> (HsmTable, HsmTable) {
    let table = |phase: f32, hue_amp: f32, sat_amp: f32| {
        let data = (0..6)
            .flat_map(|h| (0..4).flat_map(move |s| (0..val_divs).map(move |v| (h, s, v))))
            .flat_map(|(h, s, v)| {
                let angle = h as f32 / 6.0 * std::f32::consts::TAU + phase;
                let sat = s as f32 / 3.0;
                let val = v as f32 / (val_divs - 1).max(1) as f32;
                [
                    hue_amp * angle.sin() * sat * (1.0 + val),
                    1.0 + sat_amp * angle.cos() * sat * (1.0 - 0.5 * val),
                    1.0 - 0.04 * angle.sin() * sat + 0.03 * val,
                ]
            })
            .collect();
        HsmTable::new([6, 4, val_divs], data, encoding).unwrap()
    };
    (table(0.0, 8.0, 0.15), table(1.3, -6.0, -0.1))
}

fn endpoint_tables() -> (HsmTable, HsmTable) {
    endpoint_tables_shaped(1, HsmEncoding::Linear)
}

#[test]
fn blended_lookup_matches_the_develops_lerped_table() {
    let (cold, warm) = endpoint_tables();
    for t in [0.0, 0.25, 0.6, 1.0] {
        let lerped = lerp_tables(&cold, &warm, t).unwrap();
        for rgb in [
            [0.8, 0.2, 0.1],
            [0.1, 0.5, 0.9],
            [0.3, 0.3, 0.31],
            [0.05, 0.9, 0.4],
            [-0.02, 0.4, 0.6],
        ] {
            let want = apply_one(rgb, &lerped);
            let got = apply_one_blended(rgb, cold.dims, cold.encoding, (&cold.data, &warm.data), t);
            for c in 0..3 {
                assert!(
                    (got[c] - want[c]).abs() < 1e-5,
                    "t {t} {rgb:?}: {got:?} vs {want:?}"
                );
            }
        }
    }
}

#[test]
fn blended_lookup_matches_develop_when_endpoint_and_spatial_unwrap_branches_differ() {
    let table = |hues: [f32; 2]| {
        HsmTable::new(
            [2, 2, 1],
            hues.into_iter()
                .flat_map(|h| [[h, 1.0, 1.0]; 2].into_iter().flatten())
                .collect(),
            HsmEncoding::Linear,
        )
        .unwrap()
    };
    let cold = table([-70.0, -126.0]);
    let warm = table([158.0, 45.0]);
    for t in [0.0, 0.25, 0.5, 0.75, 1.0] {
        let blended = lerp_tables(&cold, &warm, t).unwrap();
        for hue in [15.0, 45.0, 90.0, 135.0, 210.0, 315.0] {
            for sat in [0.005, 0.05, 0.5, 1.0] {
                let rgb = hsv_to_rgb(hue, sat, 0.8);
                let want = apply_one(rgb, &blended);
                let got =
                    apply_one_blended(rgb, cold.dims, cold.encoding, (&cold.data, &warm.data), t);
                for c in 0..3 {
                    assert!(
                        (got[c] - want[c]).abs() < 1e-6,
                        "t={t}, hue={hue}, sat={sat}: {got:?} vs {want:?}"
                    );
                }
            }
        }
    }
}
