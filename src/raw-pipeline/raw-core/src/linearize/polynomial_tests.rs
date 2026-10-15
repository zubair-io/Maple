use super::*;
use crate::image::ColorSpace;

fn operation(area: [i32; 4], plane: u32, planes: u32, pitch: [u32; 2], c: &[f64]) -> Vec<u8> {
    let mut payload = Vec::new();
    for v in area {
        payload.extend_from_slice(&v.to_be_bytes());
    }
    for v in [plane, planes, pitch[0], pitch[1], c.len() as u32 - 1] {
        payload.extend_from_slice(&v.to_be_bytes());
    }
    for v in c {
        payload.extend_from_slice(&v.to_be_bytes());
    }
    let mut result = Vec::new();
    for v in [8, 0x0103_0000, 0, payload.len() as u32] {
        result.extend_from_slice(&v.to_be_bytes());
    }
    result.extend(payload);
    result
}
fn list(operations: &[Vec<u8>]) -> Vec<u8> {
    let mut bytes = (operations.len() as u32).to_be_bytes().to_vec();
    for op in operations {
        bytes.extend(op);
    }
    bytes
}
fn image(w: u32, h: u32, p: [f32; 3]) -> Image {
    let mut image = Image::new(w, h, ColorSpace::CameraNativeLinearRgb);
    image.pixels.fill(p);
    image
}

#[test]
fn declared_cubic_matches_the_lossy_dng_transfer_on_all_codes() {
    let transfer = PolynomialTransfer::parse(&list(&[operation(
        [0; 4],
        0,
        3,
        [1; 2],
        &[0., 0.0625, 0., 0.9375],
    )]))
    .unwrap()
    .unwrap();
    let mut img = image(256, 1, [0.; 3]);
    for (code, pixel) in img.pixels.iter_mut().enumerate() {
        *pixel = [code as f32 / 255.; 3];
    }
    transfer.apply(&mut img);
    for (code, p) in img.pixels.iter().enumerate() {
        let x = code as f64 / 255.;
        let expected = 0.0625 * x + 0.9375 * x * x * x;
        for v in p {
            assert!((f64::from(*v) - expected).abs() < 2e-7);
        }
    }
}

#[test]
fn area_planes_pitch_and_operation_order_are_preserved() {
    let bytes = list(&[
        operation([-1, -1, 5, 6], 1, 1, [2, 3], &[0.1, 2.]),
        operation([0; 4], 1, 1, [1; 2], &[0., 0.5]),
    ]);
    let transfer = PolynomialTransfer::parse(&bytes).unwrap().unwrap();
    let mut img = image(7, 6, [0.2; 3]);
    transfer.apply(&mut img);
    for (i, p) in img.pixels.iter().enumerate() {
        let (x, y) = (i % 7, i / 7);
        let selected = y < 5 && y % 2 == 1 && x < 6 && (x + 1) % 3 == 0;
        assert_eq!(*p, [0.2, if selected { 0.25 } else { 0.1 }, 0.2], "{x},{y}");
    }
}

#[test]
fn declared_transfer_keeps_extended_scene_values() {
    let transfer =
        PolynomialTransfer::parse(&list(&[operation([0; 4], 0, 3, [1; 2], &[-0.1, 2.])]))
            .unwrap()
            .unwrap();
    let mut img = image(1, 1, [0.0, 0.5, 1.0]);
    transfer.apply(&mut img);
    assert_eq!(img.pixels[0], [-0.1, 0.9, 1.9]);
}

#[test]
fn truncated_nonfinite_and_invalid_polynomials_fail_closed() {
    let bytes = list(&[operation([0; 4], 0, 3, [1; 2], &[0., 0.0625, 0., 0.9375])]);
    for end in 0..bytes.len() {
        assert!(PolynomialTransfer::parse(&bytes[..end]).is_err(), "{end}");
    }
    let mut trailing = bytes.clone();
    trailing.push(0);
    assert!(PolynomialTransfer::parse(&trailing).is_err());
    for coefficients in [
        vec![f64::NAN],
        vec![f64::INFINITY],
        vec![f64::MAX],
        vec![0.; 10],
    ] {
        assert!(PolynomialTransfer::parse(&list(&[operation(
            [0; 4],
            0,
            1,
            [1; 2],
            &coefficients
        )]))
        .is_err());
    }
    for (area, plane, planes, pitch) in [
        ([0; 4], 0, 1, [0, 1]),
        ([0; 4], 0, 1, [2, 1]),
        ([0; 4], 0, 0, [1, 1]),
        ([0; 4], u32::MAX, 2, [1, 1]),
        ([0, 0, 2, 2], 0, 1, [3, 1]),
    ] {
        assert!(PolynomialTransfer::parse(&list(&[operation(
            area,
            plane,
            planes,
            pitch,
            &[0., 1.]
        )]))
        .is_err());
    }
}

#[test]
fn unknown_required_opcodes_fail_optional_ones_skip() {
    let mut op = operation([0; 4], 0, 1, [1; 2], &[0., 1.]);
    op[..4].copy_from_slice(&99u32.to_be_bytes());
    assert!(PolynomialTransfer::parse(&list(&[op.clone()])).is_err());
    op[8..12].copy_from_slice(&1u32.to_be_bytes());
    assert!(PolynomialTransfer::parse(&list(&[op])).unwrap().is_none());
    let mut future = operation([0; 4], 0, 1, [1; 2], &[0., 1.]);
    future[4..8].copy_from_slice(&0x0200_0000u32.to_be_bytes());
    assert!(PolynomialTransfer::parse(&list(&[future])).is_err());
}
