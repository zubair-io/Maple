//! The overlay pass against `raw_core::canvas::rasterize_overlay`, the CPU
//! fallback. One 8-bit step is the budget: the GPU's unorm store rounding and
//! fused multiply-adds are the only sanctioned differences.

use super::*;
use raw_core::canvas::{
    crop_overlay, rasterize_overlay, CanvasOverlay, CropEdges, CropHandle, CropOverlayInput, Size,
    CROP_OVERLAY_OVERSCAN,
};

fn params(overlay: &CanvasOverlay) -> OverlayParams {
    overlay.active().iter().enumerate().fold(
        OverlayParams {
            count: [overlay.active().len() as u32, 0, 0, 0],
            ..OverlayParams::EMPTY
        },
        |mut acc, (index, primitive)| {
            acc.primitives[index] = OverlayPrimitive {
                rect: primitive.rect,
                clip: primitive.clip,
                color: primitive.color,
                kind: [primitive.kind, 0, 0, 0],
            };
            acc
        },
    )
}

fn cpu(overlay: &CanvasOverlay, width: u32, height: u32) -> Vec<u8> {
    let mut out = vec![0_u8; width as usize * height as usize * 4];
    rasterize_overlay(overlay, width, height, width as usize * 4, &mut out).expect("rasterize");
    out
}

fn crop_input(viewport: (f64, f64), scale: f64, active: Option<CropHandle>) -> CropOverlayInput {
    CropOverlayInput {
        crop: CropEdges {
            top: 0.13,
            left: 0.07,
            bottom: 0.91,
            right: 0.66,
            angle: -4.0,
        },
        viewport: Size::new(viewport.0, viewport.1),
        image: Size::new(6000.0, 4000.0),
        pixel_scale: scale,
        active,
    }
}

fn assert_within_one_step(gpu: &[u8], cpu: &[u8], label: &str) {
    assert_eq!(gpu.len(), cpu.len(), "{label}: length");
    let worst = gpu
        .iter()
        .zip(cpu)
        .map(|(g, c)| g.abs_diff(*c))
        .max()
        .unwrap_or(0);
    assert!(worst <= 1, "{label}: max channel difference {worst} > 1");
}

#[test]
fn crop_overlay_gpu_matches_cpu_rasterizer_within_one_step() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let cases = [
        ((300.0, 200.0), 2.0, None),
        ((257.0, 311.0), 1.5, Some(CropHandle::TopLeft)),
        ((180.0, 120.0), 3.0, Some(CropHandle::Right)),
        ((333.0, 190.0), 1.0, Some(CropHandle::BottomRight)),
    ];
    for (viewport, scale, active) in cases {
        let overlay = crop_overlay(crop_input(viewport, scale, active));
        let width = ((viewport.0 + 2.0 * CROP_OVERLAY_OVERSCAN) * scale).round() as u32;
        let height = ((viewport.1 + 2.0 * CROP_OVERLAY_OVERSCAN) * scale).round() as u32;
        let gpu = render_overlay_offscreen(&ctx, &params(&overlay), width, height).expect("gpu");
        assert_within_one_step(
            &gpu,
            &cpu(&overlay, width, height),
            &format!("{viewport:?}@{scale} {active:?}"),
        );
    }
}

#[test]
fn full_frame_fit_keeps_dots_and_frame_off_the_drawable_edge() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (viewport, scale) = ((300.0, 200.0), 2.0);
    let overlay = crop_overlay(CropOverlayInput {
        crop: CropEdges::default(),
        ..crop_input(viewport, scale, None)
    });
    let width = ((viewport.0 + 2.0 * CROP_OVERLAY_OVERSCAN) * scale).round() as u32;
    let height = ((viewport.1 + 2.0 * CROP_OVERLAY_OVERSCAN) * scale).round() as u32;
    let gpu = render_overlay_offscreen(&ctx, &params(&overlay), width, height).expect("gpu");
    assert_within_one_step(&gpu, &cpu(&overlay, width, height), "full frame");
    let alpha = |x: u32, y: u32| gpu[((y * width + x) * 4 + 3) as usize];
    let border = (0..width)
        .flat_map(|x| [(x, 0), (x, height - 1)])
        .chain((0..height).flat_map(|y| [(0, y), (width - 1, y)]));
    assert!(border.into_iter().all(|(x, y)| alpha(x, y) == 0));
    let margin = (CROP_OVERLAY_OVERSCAN * scale) as u32;
    assert_eq!(
        alpha(margin, margin),
        255,
        "the top-left dot is drawn whole"
    );
}

#[test]
fn overlay_draws_its_primitives_not_a_blank_surface() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let overlay = crop_overlay(crop_input((200.0, 150.0), 1.0, None));
    let gpu = render_overlay_offscreen(&ctx, &params(&overlay), 200, 150).expect("gpu");
    let opaque_white = gpu
        .chunks(4)
        .filter(|px| *px == [255, 255, 255, 255])
        .count();
    let dimmed = gpu
        .chunks(4)
        .filter(|px| px[..3] == [0, 0, 0] && px[3] > 100)
        .count();
    assert!(opaque_white > 100, "corner dots: {opaque_white} px");
    assert!(dimmed > 1000, "mask: {dimmed} px");
}

#[test]
fn empty_overlay_is_fully_transparent() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let gpu = render_overlay_offscreen(&ctx, &OverlayParams::EMPTY, 37, 21).expect("gpu");
    assert!(gpu.iter().all(|&b| b == 0));
}

#[test]
fn offscreen_rejects_degenerate_dims() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    assert!(render_overlay_offscreen(&ctx, &OverlayParams::EMPTY, 0, 4).is_err());
}

#[test]
fn params_layout_matches_the_wgsl_uniform() {
    assert_eq!(std::mem::size_of::<OverlayPrimitive>(), 64);
    assert_eq!(
        std::mem::size_of::<OverlayParams>(),
        16 + 64 * OVERLAY_CAPACITY
    );
    assert_eq!(OVERLAY_CAPACITY, raw_core::canvas::OVERLAY_CAPACITY);
}

#[test]
fn format_and_alpha_pickers_refuse_unusable_surfaces() {
    use wgpu::CompositeAlphaMode as Mode;
    use wgpu::TextureFormat as Format;
    assert_eq!(
        pick_overlay_format(&[Format::Bgra8UnormSrgb, Format::Bgra8Unorm]),
        Some(Format::Bgra8Unorm)
    );
    assert_eq!(pick_overlay_format(&[Format::Rgba16Float]), None);
    assert_eq!(
        pick_overlay_alpha_mode(&[Mode::Opaque, Mode::PostMultiplied]),
        Some(Mode::PostMultiplied)
    );
    assert_eq!(
        pick_overlay_alpha_mode(&[Mode::PostMultiplied, Mode::PreMultiplied]),
        Some(Mode::PreMultiplied)
    );
    assert_eq!(pick_overlay_alpha_mode(&[Mode::Opaque]), None);
}
