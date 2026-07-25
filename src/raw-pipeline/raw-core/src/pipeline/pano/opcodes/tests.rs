use super::*;

/// Serialize a GainMap opcode body (big-endian) for blob-building.
fn gain_map_params(points_v: u32, points_h: u32, map_planes: u32, gains: &[f32]) -> Vec<u8> {
    let mut p = Vec::new();
    for v in [0u32, 0, 24, 32, 0, 3, 1, 1, points_v, points_h] {
        p.extend_from_slice(&v.to_be_bytes());
    }
    for v in [0.5f64, 0.25, 0.0, 0.0] {
        p.extend_from_slice(&v.to_be_bytes());
    }
    p.extend_from_slice(&map_planes.to_be_bytes());
    for g in gains {
        p.extend_from_slice(&g.to_be_bytes());
    }
    p
}

fn opcode_entry(id: u32, params: &[u8]) -> Vec<u8> {
    let mut e = Vec::new();
    e.extend_from_slice(&id.to_be_bytes());
    e.extend_from_slice(&0x0104_0000u32.to_be_bytes()); // DNG version
    e.extend_from_slice(&1u32.to_be_bytes()); // flags: optional
    e.extend_from_slice(&(params.len() as u32).to_be_bytes());
    e.extend_from_slice(params);
    e
}

fn blob(entries: &[Vec<u8>]) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for e in entries {
        b.extend_from_slice(e);
    }
    b
}

fn warp_params(sets: &[[f64; 6]], cx: f64, cy: f64) -> Vec<u8> {
    let mut p = Vec::new();
    p.extend_from_slice(&(sets.len() as u32).to_be_bytes());
    for s in sets {
        for v in s {
            p.extend_from_slice(&v.to_be_bytes());
        }
    }
    p.extend_from_slice(&cx.to_be_bytes());
    p.extend_from_slice(&cy.to_be_bytes());
    p
}

#[test]
fn parses_gain_map_fields_exactly() {
    let gains: Vec<f32> = (0..2 * 3 * 1).map(|i| 1.0 + i as f32 * 0.1).collect();
    let b = blob(&[opcode_entry(9, &gain_map_params(2, 3, 1, &gains))]);
    let list = parse_opcode_list(&b).expect("parses");
    assert_eq!(list.skipped_unknown, 0);
    assert_eq!(list.opcodes.len(), 1);
    let PanoOpcode::GainMap(gm) = &list.opcodes[0] else {
        panic!("expected GainMap, got {:?}", list.opcodes[0]);
    };
    assert_eq!((gm.top, gm.left, gm.bottom, gm.right), (0, 0, 24, 32));
    assert_eq!((gm.plane, gm.planes), (0, 3));
    assert_eq!((gm.row_pitch, gm.col_pitch), (1, 1));
    assert_eq!((gm.points_v, gm.points_h, gm.map_planes), (2, 3, 1));
    assert_eq!((gm.spacing_v, gm.spacing_h), (0.5, 0.25));
    assert_eq!((gm.origin_v, gm.origin_h), (0.0, 0.0));
    assert_eq!(gm.gains, gains);
}

#[test]
fn parses_warp_rectilinear_multi_plane_and_center() {
    let sets = [
        [1.0, -0.06, 0.03, -0.05, 0.001, -0.002],
        [1.001, -0.061, 0.031, -0.051, 0.0, 0.0],
        [1.002, -0.062, 0.032, -0.052, 0.0, 0.0],
    ];
    let b = blob(&[opcode_entry(1, &warp_params(&sets, 0.5, 0.45))]);
    let list = parse_opcode_list(&b).expect("parses");
    let PanoOpcode::WarpRectilinear(w) = &list.opcodes[0] else {
        panic!("expected WarpRectilinear");
    };
    assert_eq!(w.planes.len(), 3);
    assert_eq!(w.planes[0].kr, [1.0, -0.06, 0.03, -0.05]);
    assert_eq!(w.planes[0].kt, [0.001, -0.002]);
    assert_eq!(w.planes[2].kr, [1.002, -0.062, 0.032, -0.052]);
    assert_eq!((w.center_x, w.center_y), (0.5, 0.45));
}

/// Serialize a FixVignetteRadial opcode body (big-endian): k0..k4 then
/// the optical center, horizontal component first (dng_sdk order).
fn vignette_radial_params(k: [f64; 5], cx: f64, cy: f64) -> Vec<u8> {
    let mut p = Vec::new();
    for v in k {
        p.extend_from_slice(&v.to_be_bytes());
    }
    p.extend_from_slice(&cx.to_be_bytes());
    p.extend_from_slice(&cy.to_be_bytes());
    p
}

#[test]
fn parses_fix_vignette_radial_coefficients_and_center() {
    let k = [0.31, -0.12, 0.05, -0.02, 0.008];
    let b = blob(&[opcode_entry(3, &vignette_radial_params(k, 0.5, 0.48))]);
    let list = parse_opcode_list(&b).expect("parses");
    assert_eq!(list.skipped_unknown, 0);
    assert_eq!(list.opcodes.len(), 1);
    let PanoOpcode::FixVignetteRadial(v) = &list.opcodes[0] else {
        panic!("expected FixVignetteRadial, got {:?}", list.opcodes[0]);
    };
    assert_eq!(v.k, k);
    // Center is (horizontal, vertical) in that stream order — a swap here
    // would silently mirror the gain field on non-centered optics.
    assert_eq!((v.center_x, v.center_y), (0.5, 0.48));
}

/// dng_sdk rejects any FixVignetteRadial whose parameter block is not
/// exactly `kNumTerms * 8 + 16` = 56 bytes; we degrade the whole list to
/// `None` (the module's malformed-blob policy) rather than guessing at a
/// truncated coefficient set.
#[test]
fn fix_vignette_radial_with_wrong_param_length_rejects_the_list() {
    let k = [0.31, -0.12, 0.05, -0.02, 0.008];
    let mut short = vignette_radial_params(k, 0.5, 0.5);
    short.truncate(48);
    assert!(parse_opcode_list(&blob(&[opcode_entry(3, &short)])).is_none());

    let mut long = vignette_radial_params(k, 0.5, 0.5);
    long.extend_from_slice(&0.0f64.to_be_bytes());
    assert!(parse_opcode_list(&blob(&[opcode_entry(3, &long)])).is_none());
}

/// A DNG may carry the vignette and the warp together; both must survive
/// in list order (the DNG spec mandates in-order execution).
#[test]
fn parses_fix_vignette_radial_alongside_warp_in_list_order() {
    let b = blob(&[
        opcode_entry(
            3,
            &vignette_radial_params([0.2, 0.0, 0.0, 0.0, 0.0], 0.5, 0.5),
        ),
        opcode_entry(1, &warp_params(&[[1.0, -0.05, 0.0, 0.0, 0.0, 0.0]], 0.5, 0.5)),
    ]);
    let list = parse_opcode_list(&b).expect("parses");
    assert_eq!(list.skipped_unknown, 0);
    assert!(matches!(list.opcodes[0], PanoOpcode::FixVignetteRadial(_)));
    assert!(matches!(list.opcodes[1], PanoOpcode::WarpRectilinear(_)));
}

#[test]
fn unknown_opcode_ids_are_skipped_with_count_in_list_order() {
    let gains = vec![1.0f32; 4];
    let unknown = opcode_entry(42, &[0u8; 12]);
    let b = blob(&[
        opcode_entry(9, &gain_map_params(2, 2, 1, &gains)),
        unknown,
        opcode_entry(1, &warp_params(&[[1.0, 0.0, 0.0, 0.0, 0.0, 0.0]], 0.5, 0.5)),
    ]);
    let list = parse_opcode_list(&b).expect("parses around unknown id");
    assert_eq!(list.skipped_unknown, 1);
    assert_eq!(list.opcodes.len(), 2);
    assert!(matches!(list.opcodes[0], PanoOpcode::GainMap(_)));
    assert!(matches!(list.opcodes[1], PanoOpcode::WarpRectilinear(_)));
}

#[test]
fn truncated_or_malformed_blobs_parse_to_none() {
    let gains = vec![1.0f32; 4];
    let good = blob(&[opcode_entry(9, &gain_map_params(2, 2, 1, &gains))]);
    assert!(
        parse_opcode_list(&good[..good.len() - 2]).is_none(),
        "truncated gains"
    );
    assert!(parse_opcode_list(&good[..7]).is_none(), "truncated header");
    assert!(parse_opcode_list(&[]).is_none(), "empty blob");
    // Parameter length lies about the payload size.
    let mut bad_len = good.clone();
    bad_len[4 + 12..4 + 16].copy_from_slice(&9999u32.to_be_bytes());
    assert!(
        parse_opcode_list(&bad_len).is_none(),
        "param length overrun"
    );
    // Gain count disagrees with the parameter block size.
    let short_gains = blob(&[opcode_entry(9, &gain_map_params(4, 4, 3, &gains))]);
    assert!(
        parse_opcode_list(&short_gains).is_none(),
        "lattice/len mismatch"
    );
    // Warp with a zero coefficient-set count.
    let zero_sets = blob(&[opcode_entry(1, &warp_params(&[], 0.5, 0.5))]);
    assert!(parse_opcode_list(&zero_sets).is_none(), "warp N=0");
}

#[test]
fn implausible_opcode_count_rejected() {
    let mut b = Vec::new();
    b.extend_from_slice(&u32::MAX.to_be_bytes());
    assert!(parse_opcode_list(&b).is_none());
}

/// Fixture-gated: the real DJI blobs parse to the documented shapes.
/// This is the parse-level evidence for #1159 — the L2D-20c carries
/// GainMap + WarpRectilinear (in that order), the L3D-100c
/// WarpRectilinear only, and neither ships OpcodeList1/2.
#[test]
fn parses_real_dji_opcode_lists() {
    for (rel, expect_gain_map) in [
        ("../../../test-fixtures/raws/pano_01/PANO0001.DNG", true),
        ("../../../test-fixtures/raws/pano_00/0000.DNG", false),
    ] {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel);
        if !path.exists() {
            eprintln!("skip: {} (pano fixtures not present)", path.display());
            continue;
        }
        let bytes = std::fs::read(&path).expect("read fixture");
        let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
        let (list, aa) =
            read_opcode_list3(&bytes, "dng", raw.width, raw.height).expect("OpcodeList3");
        assert_eq!(list.skipped_unknown, 0, "{}", path.display());
        if expect_gain_map {
            assert_eq!(list.opcodes.len(), 2);
            let PanoOpcode::GainMap(gm) = &list.opcodes[0] else {
                panic!("L2D-20c list order: GainMap first");
            };
            assert_eq!((gm.points_v, gm.points_h, gm.map_planes), (32, 32, 3));
            assert_eq!((aa.width, aa.height), (5280, 3956));
            assert_eq!((gm.right, gm.bottom), (aa.width, aa.height));
            // Vignette shape: every gain ≥ 1, corners gain more than
            // the lattice center.
            assert!(gm.gains.iter().all(|&g| (1.0..4.0).contains(&g)));
            let at = |v: u32, h: u32| gm.gains[((v * gm.points_h + h) * gm.map_planes) as usize];
            let center = at(gm.points_v / 2, gm.points_h / 2);
            for (cv, ch) in [(0, 0), (0, 31), (31, 0), (31, 31)] {
                assert!(
                    at(cv, ch) > center,
                    "corner ({cv},{ch}) gain {} must exceed center {}",
                    at(cv, ch),
                    center
                );
            }
            let PanoOpcode::WarpRectilinear(_) = &list.opcodes[1] else {
                panic!("L2D-20c list order: WarpRectilinear second");
            };
        } else {
            assert_eq!(list.opcodes.len(), 1);
        }
        let PanoOpcode::WarpRectilinear(w) = &list.opcodes[list.opcodes.len() - 1] else {
            panic!("WarpRectilinear expected last in both fixtures");
        };
        assert_eq!(w.planes.len(), 3);
        for p in &w.planes {
            assert!((p.kr[0] - 1.0).abs() < 0.05, "kr0 ≈ 1, got {}", p.kr[0]);
            assert!(p.kr[1].abs() < 0.1, "|kr1| small, got {}", p.kr[1]);
            assert_eq!(p.kt, [0.0, 0.0], "DJI ships no tangential terms");
        }
        assert_eq!((w.center_x, w.center_y), (0.5, 0.5));
    }
}
