//! #4631: independent-axis interpolation, as in DNG SDK RefBaselineHueSatMap.
//! Nonseparable corner values distinguish tensor interpolation from tetrahedra.
use super::{lookup, HsmEncoding, HsmTable};

fn corner_product_table(values: u32) -> HsmTable {
    let mut data = Vec::new();
    // HsmTable's current in-memory order; this test isolates interpolation.
    for h in 0..4 {
        for s in 0..2 {
            for v in 0..values {
                let corner = (h == 1 && s == 1 && (values == 1 || v == 1)) as u8 as f32;
                data.extend_from_slice(&[0.0, 1.0 + 0.4 * corner, 1.0 + 0.8 * corner]);
            }
        }
    }
    HsmTable::new([4, 2, values], data, HsmEncoding::Linear).unwrap()
}

#[test]
fn hue_and_saturation_interpolate_independently() {
    let table = corner_product_table(1);
    for (h, s) in [(0.25, 0.5), (0.7, 0.2), (0.4, 0.8)] {
        let (hd, ss, vs) = lookup(table.dims, &table.data, h * 90.0, s, 0.6);
        assert_eq!(hd, 0.0);
        assert!((ss - (1.0 + 0.4 * h * s)).abs() < 1e-6, "{h},{s}: {ss}");
        assert!((vs - (1.0 + 0.8 * h * s)).abs() < 1e-6, "{h},{s}: {vs}");
    }
}

#[test]
fn all_three_axes_interpolate_independently() {
    let table = corner_product_table(2);
    // All six orderings of fractional coordinates exercise every old tetrahedron.
    for (h, s, v) in [
        (0.2, 0.4, 0.6),
        (0.2, 0.6, 0.4),
        (0.4, 0.2, 0.6),
        (0.4, 0.6, 0.2),
        (0.6, 0.2, 0.4),
        (0.6, 0.4, 0.2),
    ] {
        let (hd, ss, vs) = lookup(table.dims, &table.data, h * 90.0, s, v);
        assert_eq!(hd, 0.0);
        assert!(
            (ss - (1.0 + 0.4 * h * s * v)).abs() < 1e-6,
            "{h},{s},{v}: {ss}"
        );
        assert!(
            (vs - (1.0 + 0.8 * h * s * v)).abs() < 1e-6,
            "{h},{s},{v}: {vs}"
        );
    }
}

#[test]
fn trilinear_cells_retain_hdr_lookup_boundary() {
    let table = corner_product_table(2);
    assert_eq!(
        lookup(table.dims, &table.data, 22.5, 0.5, 1.0),
        lookup(table.dims, &table.data, 22.5, 0.5, 4.0)
    );
    assert_eq!(
        lookup(table.dims, &table.data, 22.5, 0.5, 0.0),
        lookup(table.dims, &table.data, 22.5, 0.5, -0.5)
    );
}
