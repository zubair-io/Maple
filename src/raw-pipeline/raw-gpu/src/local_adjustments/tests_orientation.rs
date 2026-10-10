//! Sensor-framed buffers read upright-authored masks (#4426): every mask
//! kind under every EXIF orientation against raw-core's own sensor-frame
//! remap (`pipeline::mask::orient_adjustments_to_sensor`, #4453),
//! plus the live builder threading `FullChainInputs::mask_orientation` into
//! both the fused and the per-layer spatial shapes.

use super::tests::{buffer_16x12, max_abs_diff, only};
use super::*;
use crate::{chain::ChainRunner, image::GpuImage};
use raw_core::image::{ColorSpace, ExifOrientation, Image};
use raw_core::types::{
    layers_to_flat, rasterize_brush, BrushDab, LocalAdjustment, Mask, MaskCombine, MaskComponent,
    MaskGroup, MaskRaster, Point2,
};
use std::sync::Arc;

fn oriented_reference(
    buf: &[f32],
    w: u32,
    h: u32,
    layers: &[LocalAdjustment],
    rasters: &[Arc<MaskRaster>],
    orientation: ExifOrientation,
) -> Vec<f32> {
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (pixel, rgba) in img.pixels.iter_mut().zip(buf.chunks_exact(4)) {
        *pixel = [rgba[0], rgba[1], rgba[2]];
    }
    let (sensor_layers, sensor_rasters) =
        raw_core::pipeline::mask::orient_adjustments_to_sensor(layers, rasters, orientation);
    raw_core::stages::local_adjustments::apply(&mut img, &sensor_layers, &sensor_rasters);
    img.pixels
        .iter()
        .zip(buf.chunks_exact(4))
        .flat_map(|(p, rgba)| [p[0], p[1], p[2], rgba[3]])
        .collect()
}

fn gpu_rasters(rasters: &[Arc<MaskRaster>]) -> Vec<GpuMaskRaster> {
    rasters
        .iter()
        .map(|r| GpuMaskRaster {
            id: r.id,
            width: r.width,
            height: r.height,
            data: r.data.clone(),
        })
        .collect()
}

fn layer(mask: Mask) -> LocalAdjustment {
    LocalAdjustment {
        mask,
        range: None,
        adjustments: only(|a| a.exposure = Some(1.2)),
    }
}

fn mask_cases() -> (Vec<(&'static str, LocalAdjustment)>, Vec<Arc<MaskRaster>>) {
    let bitmap: Vec<u8> = (0..8 * 6)
        .map(|i| if i % 8 < 3 && i / 8 < 4 { 255 } else { 20 })
        .collect();
    let brush = rasterize_brush(
        &[BrushDab::new(Point2::new(0.25, 0.3), 0.2, 0.4, 1.0, false)],
        12,
        16,
    );
    let rasters = vec![
        Arc::new(MaskRaster::from_u8(3, "0123456789abcdef", 8, 6, &bitmap)),
        Arc::new(MaskRaster::from_u8(4, "fedcba9876543210", 12, 16, &brush)),
    ];
    let radial = Mask::Radial {
        center: Point2::new(0.3, 0.25),
        radii: Point2::new(0.35, 0.2),
        angle: 0.4,
        feather: 0.5,
        invert: false,
    };
    let linear = Mask::Linear {
        start: Point2::new(0.1, 0.2),
        end: Point2::new(0.6, 0.5),
        feather: 0.4,
    };
    let cases = vec![
        ("linear", layer(linear.clone())),
        ("radial", layer(radial.clone())),
        (
            "bitmap",
            layer(Mask::Bitmap {
                recipe: Default::default(),
                raster_id: 3,
            }),
        ),
        (
            "brush",
            layer(Mask::Brush {
                dabs: Vec::new(),
                digest: String::new(),
                raster_id: 4,
            }),
        ),
        (
            "group",
            layer(Mask::Group(MaskGroup {
                components: vec![
                    MaskComponent::new(radial, MaskCombine::Add, false).unwrap(),
                    MaskComponent::new(linear, MaskCombine::Subtract, false).unwrap(),
                ],
                opacity: 1.0,
                invert: false,
            })),
        ),
    ];
    (cases, rasters)
}

#[test]
fn wgsl_masks_on_a_sensor_framed_buffer_match_raw_core_in_every_orientation() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = buffer_16x12();
    let (cases, rasters) = mask_cases();
    for tag in 1..=8u16 {
        let orientation = ExifOrientation::from_u16(tag);
        for (kind, layer) in &cases {
            let layers = std::slice::from_ref(layer);
            let reference = oriented_reference(&input, w, h, layers, &rasters, orientation);
            let image = GpuImage::upload(&ctx, &input, w, h);
            let pass = LocalAdjustmentsPass::new(&layers_to_flat(layers), &gpu_rasters(&rasters))
                .with_orientation(u32::from(tag));
            let gpu = ChainRunner::new(&ctx, &image).run_blocking(&[&pass]);
            let diff = max_abs_diff(&reference, &gpu);
            assert!(diff < 1e-4, "{kind} tag {tag}: max |diff| {diff:e}");
        }
    }
}

#[test]
fn live_chain_threads_mask_orientation_into_fused_and_spatial_layers() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = buffer_16x12();
    let (cases, rasters) = mask_cases();
    let mut spatial = cases[1].1.clone();
    spatial.adjustments.sharpness = Some(35.0);
    let render = |pixels: &[f32], inputs: &crate::FullChainInputs<'_>| {
        let image = GpuImage::upload(&ctx, pixels, w, h);
        let passes = crate::build_live_chain(inputs, crate::AirlightSource::OnGpu);
        let refs: Vec<&dyn crate::chain::Pass> = passes.iter().map(|pass| pass.as_ref()).collect();
        ChainRunner::new(&ctx, &image).run_blocking(&refs)
    };
    let view_only = super::bench::bench_inputs(vec![]);
    for tag in 1..=8u16 {
        for layers in [
            vec![cases[0].1.clone()],
            vec![cases[0].1.clone(), spatial.clone()],
        ] {
            let orientation = ExifOrientation::from_u16(tag);
            let cpu_local = oriented_reference(&input, w, h, &layers, &rasters, orientation);
            let mut inputs = super::bench::bench_inputs(layers_to_flat(&layers));
            inputs.mask_orientation = u32::from(tag);
            let diff = max_abs_diff(&render(&cpu_local, &view_only), &render(&input, &inputs));
            assert!(
                diff < 1e-4,
                "tag {tag}, {} layer(s): max |diff| {diff:e}",
                layers.len()
            );
        }
    }
}
