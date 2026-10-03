use super::*;

fn corner_lut() -> Vec<f32> {
    let mut lut = vec![0.0; 24];
    lut[21..24].copy_from_slice(&[1.0, 0.5, 0.25]);
    lut
}

#[test]
fn all_tetrahedra_use_shared_sampling_and_preserve_alpha() {
    let lut = corner_lut();
    let core = ColorLut {
        size: 2,
        data: lut.clone(),
    };
    for rgb in [
        [0.8, 0.5, 0.2],
        [0.8, 0.2, 0.5],
        [0.5, 0.2, 0.8],
        [0.5, 0.8, 0.2],
        [0.2, 0.8, 0.5],
        [0.2, 0.5, 0.8],
        [0.0, 0.0, 0.0],
        [1.0, 1.0, 1.0],
        [-2.0, 3.0, 0.5],
    ] {
        let expected = core.sample(rgb);
        let mut rgba = [rgb[0], rgb[1], rgb[2], 0.37];
        let rc = unsafe {
            maple_apply_display_lut_rgba_f32(
                rgba.as_mut_ptr(),
                rgba.len(),
                lut.as_ptr(),
                lut.len(),
                2,
            )
        };
        assert_eq!(rc, 0);
        assert_eq!(&rgba[..3], &expected);
        assert_eq!(rgba[3], 0.37);
        if rgb.iter().all(|v| *v > 0.0 && *v < 1.0) {
            assert!((rgba[0] - 0.2).abs() < 1e-6);
            assert!((rgba[0] - rgb[0] * rgb[1] * rgb[2]).abs() > 0.1);
        }
    }
}

#[test]
fn invalid_buffers_fail_before_pixels_are_changed() {
    let lut = corner_lut();
    let original = [0.8, 0.5, 0.2, 0.37];
    for (len, lut_len, size) in [
        (3, 24, 2),
        (4, 23, 2),
        (4, 24, 1),
        (4, 24, 257),
        (usize::MAX - 3, 24, 2),
    ] {
        let mut pixels = original;
        assert_ne!(
            unsafe {
                maple_apply_display_lut_rgba_f32(
                    pixels.as_mut_ptr(),
                    len,
                    lut.as_ptr(),
                    lut_len,
                    size,
                )
            },
            0
        );
        assert_eq!(pixels, original);
    }
    let mut pixels = original;
    assert_ne!(
        unsafe { maple_apply_display_lut_rgba_f32(std::ptr::null_mut(), 4, lut.as_ptr(), 24, 2,) },
        0
    );
    assert_ne!(
        unsafe {
            maple_apply_display_lut_rgba_f32(pixels.as_mut_ptr(), 4, std::ptr::null(), 24, 2)
        },
        0
    );
    assert_eq!(pixels, original);
}

#[test]
fn overlapping_or_unaligned_buffers_are_rejected() {
    let mut lut = corner_lut();
    let before = lut.clone();
    assert_ne!(
        unsafe {
            maple_apply_display_lut_rgba_f32(lut.as_mut_ptr(), 4, lut.as_ptr(), lut.len(), 2)
        },
        0
    );
    assert_eq!(lut, before);
    let mut aligned = [0u32; 5];
    assert_ne!(
        unsafe {
            maple_apply_display_lut_rgba_f32(
                aligned.as_mut_ptr().cast::<u8>().add(1).cast(),
                4,
                lut.as_ptr(),
                lut.len(),
                2,
            )
        },
        0
    );
    assert_eq!(aligned, [0; 5]);
}
