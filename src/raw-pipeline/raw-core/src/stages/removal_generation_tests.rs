use super::*;

fn mask(x: u32, y: u32, width: u32, height: u32, pixels: Vec<u8>) -> RemovalMask {
    RemovalMask {
        source_width: 9,
        source_height: 9,
        x,
        y,
        width,
        height,
        pixels,
    }
}

fn request(hole_radius: u32, fringe_radius: f32) -> GenerationMaskRequest {
    GenerationMaskRequest {
        schema: 1,
        window: NativeWindow {
            x: 0,
            y: 0,
            width: 9,
            height: 9,
        },
        hole_radius,
        fringe_radius,
    }
}

#[test]
fn euclidean_hole_has_opaque_intent_and_exterior_fringe() {
    let intent = mask(4, 4, 1, 1, vec![255]);
    let prepared = prepare(&request(3, 2.0), &intent, None).unwrap();
    assert_eq!(prepared.coverage[4 * 9 + 4], 1.0);
    assert_eq!(prepared.coverage[4 * 9 + 5], 0.5);
    assert_eq!(prepared.coverage[4 * 9 + 6], 0.0);
    assert!(prepared.coverage[5 * 9 + 5] > 0.0 && prepared.coverage[5 * 9 + 5] < 0.5);
    assert_eq!(prepared.hole[4 * 9 + 7], 255);
    assert_eq!(prepared.hole[6 * 9 + 6], 255); // sqrt(8) < 3
    assert_eq!(prepared.hole[7 * 9 + 7], 0); // sqrt(18) > 3
    for (hole, alpha) in prepared.hole.iter().zip(&prepared.coverage) {
        assert!(alpha.is_finite() && (0.0..=1.0).contains(alpha));
        assert!(*alpha == 0.0 || *hole == 255);
    }
    let hard = prepare(&request(3, 0.0), &intent, None).unwrap();
    assert_eq!(hard.hole, prepared.hole);
    assert_eq!(hard.coverage.iter().filter(|v| **v == 1.0).count(), 1);
    assert_eq!(hard.coverage.iter().filter(|v| **v > 0.0).count(), 1);
}

#[test]
fn protection_clips_hole_and_fringe_but_overlap_is_explicit_error() {
    let intent = mask(4, 4, 1, 1, vec![255]);
    let protected = mask(5, 0, 1, 9, vec![255; 9]);
    let prepared = prepare(&request(3, 2.0), &intent, Some(&protected)).unwrap();
    for y in 0..9 {
        assert_eq!(prepared.hole[y * 9 + 5], 0);
        assert_eq!(prepared.coverage[y * 9 + 5], 0.0);
    }
    assert!(prepare(&request(3, 2.0), &intent, Some(&intent))
        .unwrap_err()
        .contains("overlaps protected"));
}

#[test]
fn source_edges_clip_but_model_context_edges_cannot_truncate_holes() {
    let intent = mask(0, 0, 1, 1, vec![255]);
    let prepared = prepare(&request(2, 2.0), &intent, None).unwrap();
    assert_eq!(prepared.coverage[0], 1.0);
    assert_eq!(prepared.hole.iter().filter(|v| **v == 255).count(), 6);
    let interior = mask(4, 4, 1, 1, vec![255]);
    let tight = GenerationMaskRequest {
        window: NativeWindow {
            x: 4,
            y: 4,
            width: 1,
            height: 1,
        },
        ..request(1, 1.0)
    };
    assert!(prepare(&tight, &interior, None)
        .unwrap_err()
        .contains("truncates"));
}

#[test]
fn invalid_and_empty_intent_fail_before_inference() {
    let intent = mask(4, 4, 1, 1, vec![255]);
    assert!(prepare(&request(1, 2.0), &intent, None).is_err());
    assert!(prepare(&request(1, f32::NAN), &intent, None).is_err());
    assert!(prepare(&request(1, -1.0), &intent, None).is_err());
    assert!(prepare(&request(0, 0.0), &mask(4, 4, 1, 1, vec![0]), None).is_err());
    let mut protected = intent.clone();
    protected.source_width = 10;
    assert!(prepare(&request(0, 0.0), &intent, Some(&protected)).is_err());
    let oversized = GenerationMaskRequest {
        window: NativeWindow {
            x: 0,
            y: 0,
            width: 1025,
            height: 1,
        },
        ..request(0, 0.0)
    };
    let large = RemovalMask {
        source_width: 12288,
        source_height: 8192,
        ..intent
    };
    assert!(prepare(&oversized, &large, None).is_err());
}

#[test]
fn preparation_is_bounded_by_context_on_100mp_source_and_wire_planes_match() {
    let intent = RemovalMask {
        source_width: 12288,
        source_height: 8192,
        x: 5000,
        y: 4000,
        width: 2,
        height: 1,
        pixels: vec![255, 255],
    };
    let request = GenerationMaskRequest {
        schema: 1,
        window: NativeWindow {
            x: 4990,
            y: 3990,
            width: 32,
            height: 32,
        },
        hole_radius: 4,
        fringe_radius: 2.0,
    };
    let prepared = prepare(&request, &intent, None).unwrap();
    assert_eq!(prepared.hole.len(), 32 * 32);
    assert_eq!(prepared.coverage.len(), 32 * 32);
    let bytes = crate::pipeline::removal_mask_to_bytes(&intent).unwrap();
    let json = r#"{"schema":1,"window":{"x":4990,"y":3990,"width":32,"height":32},"hole_radius":4,"fringe_radius":2}"#;
    let wire = prepare_json(json, &bytes, &[]).unwrap();
    assert_eq!(wire.len(), 2 * 32 * 32);
    assert_eq!(&wire[32 * 32..], &prepared.coverage);
    assert!(wire[..32 * 32]
        .iter()
        .zip(prepared.hole)
        .all(|(a, h)| *a == f32::from(h) / 255.0));
    assert!(prepare_json(&json.replace("\"schema\":1", "\"schema\":2"), &bytes, &[]).is_err());
}

#[test]
fn distance_envelope_matches_independent_brute_force_on_irregular_intent() {
    let points = [(0usize, 0usize), (3, 4), (8, 1), (1, 7)];
    let mut pixels = vec![0; 81];
    for (x, y) in points {
        pixels[y * 9 + x] = 255;
    }
    let prepared = prepare(&request(2, 2.0), &mask(0, 0, 9, 9, pixels), None).unwrap();
    for y in 0..9usize {
        for x in 0..9usize {
            let distance = points
                .iter()
                .map(|(px, py)| {
                    let dx = x as i32 - *px as i32;
                    let dy = y as i32 - *py as i32;
                    dx * dx + dy * dy
                })
                .min()
                .unwrap();
            assert_eq!(
                prepared.hole[y * 9 + x],
                if distance <= 4 { 255 } else { 0 }
            );
            if distance == 0 {
                assert_eq!(prepared.coverage[y * 9 + x], 1.0);
            }
        }
    }
}
