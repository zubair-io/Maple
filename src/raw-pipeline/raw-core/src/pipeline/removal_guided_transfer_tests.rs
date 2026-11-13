use super::*;

fn scene(width: usize, height: usize) -> (Vec<[f32; 3]>, Vec<[f32; 3]>, Vec<u8>) {
    let source: Vec<_> = (0..width * height)
        .map(|index| {
            [
                (index % width) as f32 / width as f32,
                (index / width) as f32 / height as f32,
                ((index * 17) % 101) as f32 / 101.0,
            ]
        })
        .collect();
    let mut guide = source.clone();
    let mut hole = vec![0; width * height];
    for y in 24..40 {
        for x in 24..40 {
            let index = y * width + x;
            hole[index] = 1;
            guide[index] = [0.5; 3];
        }
    }
    (source, guide, hole)
}

#[test]
fn transfer_is_deterministic_preserves_known_pixels_and_uses_native_donors() {
    let (source, guide, hole) = scene(64, 64);
    let first =
        guided_native_texture_transfer(&source, &guide, &hole, 64, 64, CancelToken::never())
            .unwrap();
    let second =
        guided_native_texture_transfer(&source, &guide, &hole, 64, 64, CancelToken::never())
            .unwrap();
    assert_eq!(first, second);
    for (index, (&selected, pixel)) in hole.iter().zip(&first).enumerate() {
        if selected == 0 {
            assert_eq!(*pixel, source[index]);
        } else {
            assert!(pixel.iter().all(|value| (0.0..=1.0).contains(value)));
            assert_ne!(*pixel, [0.5; 3]);
        }
    }
}

#[test]
fn transfer_uses_pixel_blocks_for_small_native_contexts() {
    let width = 16usize;
    let height = 8usize;
    let source: Vec<_> = (0..width * height)
        .map(|index| {
            [
                (index % width) as f32 / width as f32,
                (index / width) as f32 / height as f32,
                ((index * 17) % 101) as f32 / 101.0,
            ]
        })
        .collect();
    let guide = source.clone();
    let mut hole = vec![0; width * height];
    hole[3 * width + 7] = 1;
    let result = guided_native_texture_transfer(
        &source,
        &guide,
        &hole,
        width as u32,
        height as u32,
        CancelToken::never(),
    )
    .unwrap();

    assert_eq!(result.len(), source.len());
    for (index, (&selected, pixel)) in hole.iter().zip(&result).enumerate() {
        if selected == 0 {
            assert_eq!(*pixel, source[index]);
        }
    }
}

#[test]
fn transfer_rejects_invalid_holes_and_contexts_without_known_donors() {
    let (source, guide, mut hole) = scene(64, 64);
    hole.fill(0);
    assert!(
        guided_native_texture_transfer(&source, &guide, &hole, 64, 64, CancelToken::never(),)
            .unwrap_err()
            .contains("nonempty binary hole")
    );

    hole.fill(1);
    hole[0] = 0;
    assert!(
        guided_native_texture_transfer(&source, &guide, &hole, 64, 64, CancelToken::never(),)
            .unwrap_err()
            .contains("no known native donor support")
    );

    hole.fill(0);
    hole[32 * 64 + 32] = 2;
    assert!(
        guided_native_texture_transfer(&source, &guide, &hole, 64, 64, CancelToken::never(),)
            .unwrap_err()
            .contains("nonempty binary hole")
    );
}

#[test]
fn transfer_observes_cancellation_before_allocating_search_state() {
    let (source, guide, hole) = scene(64, 64);
    let flag = std::sync::atomic::AtomicBool::new(true);
    assert_eq!(
        guided_native_texture_transfer(&source, &guide, &hole, 64, 64, CancelToken::new(&flag))
            .unwrap_err(),
        "guided removal: cancelled"
    );
}

#[test]
fn transfer_copies_native_hdr_donors_without_clipping_or_touching_known_pixels() {
    let (mut source, guide, hole) = scene(64, 64);
    source[0] = [-0.25, 1.5, 3.0];
    source[1] = [2.0, 0.25, -0.1];
    let result =
        guided_native_texture_transfer(&source, &guide, &hole, 64, 64, CancelToken::never())
            .unwrap();

    assert_eq!(result[0], source[0]);
    assert_eq!(result[1], source[1]);
    assert!(result.iter().flatten().all(|value| value.is_finite()));
    assert!(result.iter().flatten().any(|value| *value < 0.0));
    assert!(result.iter().flatten().any(|value| *value > 1.0));
}
