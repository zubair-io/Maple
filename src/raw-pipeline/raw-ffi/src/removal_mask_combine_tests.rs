use super::*;

fn mask(x: u32, width: u32, source_width: u32) -> Vec<u8> {
    raw_core::pipeline::removal_mask_to_bytes(&raw_core::types::removal_mask::RemovalMask {
        source_width,
        source_height: 10,
        x,
        y: 2,
        width,
        height: 2,
        pixels: vec![255; (width * 2) as usize],
    })
    .unwrap()
}

fn combine(left: &[u8], right: &[u8], subtract: i32) -> Vec<u8> {
    let mut length = 0;
    let call = |out: *mut u8, cap: usize, length: &mut usize| unsafe {
        maple_removal_combine_masks_buf(
            left.as_ptr(),
            left.len(),
            right.as_ptr(),
            right.len(),
            subtract,
            out,
            cap,
            length,
        )
    };
    let probe = call(std::ptr::null_mut(), 0, &mut length);
    if probe == 0 {
        assert_eq!(length, 0);
        return Vec::new();
    }
    assert_eq!(probe, 100);
    let mut bytes = vec![0; length];
    assert_eq!(call(bytes.as_mut_ptr(), bytes.len(), &mut length), 0);
    bytes
}

#[test]
fn native_union_and_protection_use_exact_binary_source_windows() {
    let left = mask(1, 3, 10);
    let right = mask(3, 2, 10);
    let union = combine(&left, &right, 0);
    let decoded = raw_core::pipeline::removal_mask_from_bytes(&union).unwrap();
    assert_eq!(
        (decoded.x, decoded.y, decoded.width, decoded.height),
        (1, 2, 4, 2)
    );
    assert_eq!(decoded.pixels, [255; 8]);
    let protected = combine(&left, &right, 1);
    let decoded = raw_core::pipeline::removal_mask_from_bytes(&protected).unwrap();
    assert_eq!(
        (decoded.x, decoded.y, decoded.width, decoded.height),
        (1, 2, 3, 2)
    );
    assert_eq!(decoded.pixels, [255, 255, 0, 255, 255, 0]);
    assert!(combine(&union, &union, 1).is_empty());
    assert!(combine(&[], &left, 1).is_empty());
    assert_eq!(combine(&[], &left, 0), left);
    assert_eq!(combine(&left, &[], 0), left);
}

#[test]
fn native_combine_preserves_short_output_and_rejects_invalid_inputs() {
    let left = mask(1, 3, 10);
    let right = mask(3, 2, 10);
    let mut byte = 0xab;
    let mut length = 0;
    assert_eq!(
        unsafe {
            maple_removal_combine_masks_buf(
                left.as_ptr(),
                left.len(),
                right.as_ptr(),
                right.len(),
                0,
                &mut byte,
                1,
                &mut length,
            )
        },
        100
    );
    assert_eq!(byte, 0xab);
    assert!(length > 1);
    let other_source = mask(3, 2, 11);
    for (right, subtract) in [
        (other_source.as_slice(), 0),
        (b"bad asset".as_slice(), 0),
        (right.as_slice(), 2),
    ] {
        length = 99;
        assert_eq!(
            unsafe {
                maple_removal_combine_masks_buf(
                    left.as_ptr(),
                    left.len(),
                    right.as_ptr(),
                    right.len(),
                    subtract,
                    &mut byte,
                    1,
                    &mut length,
                )
            },
            5
        );
        assert_eq!(length, 0);
        assert_eq!(byte, 0xab);
    }
    for len in [1, usize::MAX] {
        length = 99;
        assert_eq!(
            unsafe {
                maple_removal_combine_masks_buf(
                    std::ptr::null(),
                    len,
                    right.as_ptr(),
                    right.len(),
                    0,
                    &mut byte,
                    1,
                    &mut length,
                )
            },
            5
        );
        assert_eq!(length, 0);
    }
}
