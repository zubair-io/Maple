use super::*;
use raw_core::canvas_placeholder::{
    encode_placeholder, reference_present_rgb8, PlaceholderColorSpace,
};
use raw_core::view::encode::TargetPrimaries;

/// An 8-bit RGBA still with gradients on every channel and hard edges.
fn still(width: u32, height: u32) -> Vec<u8> {
    (0..height)
        .flat_map(|y| (0..width).map(move |x| (x, y)))
        .flat_map(|(x, y)| {
            let r = (x * 255 / width.max(2).saturating_sub(1).max(1)).min(255) as u8;
            let g = (y * 255 / height.max(2).saturating_sub(1).max(1)).min(255) as u8;
            let b = if (x / 4 + y / 4) % 2 == 0 { 230 } else { 20 };
            [r, g, b, 255]
        })
        .collect()
}

fn encoded(width: u32, height: u32, target: TargetPrimaries) -> Vec<[f32; 4]> {
    let mut texels = vec![[0.0; 4]; (width * height) as usize];
    encode_placeholder(
        &still(width, height),
        (width, height),
        width as usize * 4,
        PlaceholderColorSpace::Srgb,
        target,
        &mut texels,
    )
    .unwrap();
    texels
}

fn max_byte_diff(got: &[u8], want: &[u8]) -> u8 {
    assert_eq!(got.len(), want.len());
    got.iter()
        .zip(want)
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap_or(0)
}

#[test]
fn the_placeholder_present_matches_its_cpu_reference() {
    let ctx = GpuContext::new_blocking().unwrap();
    let cases = [
        ((64, 43), (300, 201), TargetPrimaries::Srgb),
        ((64, 43), (300, 201), TargetPrimaries::P3),
        ((120, 80), (120, 80), TargetPrimaries::Srgb),
        ((300, 200), (150, 100), TargetPrimaries::P3),
    ];
    for (source_dims, surface, target) in cases {
        let texels = encoded(source_dims.0, source_dims.1, target);
        let mut slot = None;
        PlaceholderSource::upload(&ctx, &mut slot, &texels, source_dims).unwrap();
        let gpu = present_placeholder_to_offscreen(&ctx, slot.as_ref().unwrap(), surface).unwrap();
        let cpu = reference_present_rgb8(&texels, source_dims, surface);
        let diff = max_byte_diff(&gpu, &cpu);
        assert!(
            diff <= 1,
            "{source_dims:?} -> {surface:?} {target:?}: max diff {diff} LSB"
        );
    }
}

/// The present fills the whole surface, as the live chain's does, so the
/// layer shows the placeholder edge to edge in the photo's frame: no clear
/// colour survives at any edge, whatever the surface and source sizes.
#[test]
fn the_placeholder_covers_the_whole_surface() {
    let ctx = GpuContext::new_blocking().unwrap();
    let red: Vec<[f32; 4]> = vec![[1.0, 0.0, 0.0, 1.0]; 7 * 5];
    let mut slot = None;
    PlaceholderSource::upload(&ctx, &mut slot, &red, (7, 5)).unwrap();
    for surface in [(7, 5), (301, 215), (3, 2)] {
        let bytes =
            present_placeholder_to_offscreen(&ctx, slot.as_ref().unwrap(), surface).unwrap();
        assert!(
            bytes.chunks_exact(3).all(|p| p == [255, 0, 0]),
            "{surface:?} shows something other than the placeholder"
        );
    }
}

#[test]
fn a_still_that_fits_reuses_the_buffer_and_a_larger_one_replaces_it() {
    let ctx = GpuContext::new_blocking().unwrap();
    let mut slot = None;
    PlaceholderSource::upload(
        &ctx,
        &mut slot,
        &encoded(64, 43, TargetPrimaries::Srgb),
        (64, 43),
    )
    .unwrap();
    let first = slot.as_ref().unwrap().identity();

    PlaceholderSource::upload(
        &ctx,
        &mut slot,
        &encoded(40, 30, TargetPrimaries::Srgb),
        (40, 30),
    )
    .unwrap();
    assert_eq!(slot.as_ref().unwrap().identity(), first);
    assert_eq!(slot.as_ref().unwrap().dims(), (40, 30));
    let reused = present_placeholder_to_offscreen(&ctx, slot.as_ref().unwrap(), (80, 60)).unwrap();
    let texels = encoded(40, 30, TargetPrimaries::Srgb);
    assert!(
        max_byte_diff(
            &reused,
            &reference_present_rgb8(&texels, (40, 30), (80, 60))
        ) <= 1
    );

    PlaceholderSource::upload(
        &ctx,
        &mut slot,
        &encoded(128, 85, TargetPrimaries::Srgb),
        (128, 85),
    )
    .unwrap();
    assert_ne!(slot.as_ref().unwrap().identity(), first);
}

#[test]
fn a_mismatched_texel_count_is_refused() {
    let ctx = GpuContext::new_blocking().unwrap();
    let mut slot = None;
    let texels = vec![[0.0; 4]; 10];
    assert!(PlaceholderSource::upload(&ctx, &mut slot, &texels, (4, 4)).is_err());
    assert!(PlaceholderSource::upload(&ctx, &mut slot, &[], (0, 0)).is_err());
    assert!(slot.is_none());
}
