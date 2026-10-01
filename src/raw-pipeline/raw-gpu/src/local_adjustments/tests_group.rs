//! Mask-group parity against the shipping CPU evaluator (#3408).

use super::tests::{buffer_16x12, max_abs_diff, only, raw_core_local, run_gpu};
use super::*;
use crate::{chain::ChainRunner, image::GpuImage, local_spatial::LocalSpatialPass};
use raw_core::types::{
    layers_to_flat, LocalAdjustment, Mask, MaskCombine, MaskComponent, MaskGroup, MaskRaster,
    PartialAdjustments, Point2, SKIN_TONE_RANGE,
};
use std::sync::Arc;

fn component(mask: Mask, combine: MaskCombine, invert: bool) -> MaskComponent {
    MaskComponent::new(mask, combine, invert).unwrap()
}

fn group(combine: MaskCombine, component_invert: bool, group_invert: bool) -> LocalAdjustment {
    LocalAdjustment {
        mask: Mask::Group(MaskGroup {
            components: vec![
                component(
                    Mask::Radial {
                        center: Point2::new(0.48, 0.52),
                        radii: Point2::new(0.43, 0.35),
                        angle: 0.4,
                        feather: 0.6,
                        invert: false,
                    },
                    MaskCombine::Add,
                    false,
                ),
                component(
                    Mask::Linear {
                        start: Point2::new(0.15, 0.1),
                        end: Point2::new(0.9, 0.8),
                        feather: 0.7,
                    },
                    combine,
                    component_invert,
                ),
            ],
            opacity: 0.73,
            invert: group_invert,
        }),
        range: None,
        adjustments: only(|a| {
            a.exposure = Some(0.7);
            a.hue = Some(19.0);
        }),
    }
}

#[test]
fn wgsl_mask_groups_match_cpu_composition_inversion_opacity_range_and_order() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = buffer_16x12();
    for combine in [
        MaskCombine::Add,
        MaskCombine::Subtract,
        MaskCombine::Intersect,
    ] {
        for component_invert in [false, true] {
            for group_invert in [false, true] {
                for range in [None, Some(SKIN_TONE_RANGE)] {
                    let mut layer = group(combine, component_invert, group_invert);
                    layer.range = range;
                    let layers = [
                        layer,
                        LocalAdjustment {
                            mask: Mask::Everywhere,
                            range: None,
                            adjustments: only(|a| a.exposure = Some(-0.3)),
                        },
                    ];
                    let reference = raw_core_local(&input, w, h, &layers, &[]);
                    let gpu = run_gpu(&ctx, &input, w, h, &layers, &[]);
                    let diff = max_abs_diff(&reference, &gpu);
                    assert!(
                        diff < 1e-4,
                        "{combine:?}/{component_invert}/{group_invert}/{range:?}: {diff:e}"
                    );
                }
            }
        }
    }
}

#[test]
fn wgsl_imported_lightroom_mask_groups_match_cpu() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = buffer_16x12();
    for source in [
        include_str!("../../../../../test-fixtures/local-adjustments/lightroom-group-add.xmp"),
        include_str!("../../../../../test-fixtures/local-adjustments/lightroom-group-subtract.xmp"),
        include_str!(
            "../../../../../test-fixtures/local-adjustments/lightroom-group-intersect.xmp"
        ),
    ] {
        let model = raw_core::xmp::parse(source).unwrap();
        assert!(matches!(model.local_adjustments[0].mask, Mask::Group(_)));
        let reference = raw_core_local(&input, w, h, &model.local_adjustments, &[]);
        let gpu = run_gpu(&ctx, &input, w, h, &model.local_adjustments, &[]);
        assert!(max_abs_diff(&reference, &gpu) < 1e-4);
    }
}

#[test]
fn wgsl_bitmap_group_components_resolve_separately_and_missing_masks_fail_closed() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = buffer_16x12();
    let bitmap = |id| Mask::Bitmap {
        recipe: Default::default(),
        raster_id: id,
    };
    let rasters = [
        Arc::new(MaskRaster::from_u8(
            11,
            "0123456789abcdef",
            2,
            2,
            &[255, 100, 0, 200],
        )),
        Arc::new(MaskRaster::from_u8(
            12,
            "fedcba9876543210",
            2,
            2,
            &[0, 255, 128, 50],
        )),
    ];
    for resolved in [true, false] {
        for invert in [true, false] {
            let layers = [LocalAdjustment {
                mask: Mask::Group(MaskGroup {
                    components: vec![
                        component(bitmap(11), MaskCombine::Add, false),
                        component(bitmap(12), MaskCombine::Subtract, true),
                    ],
                    opacity: 0.63,
                    invert,
                }),
                range: None,
                adjustments: only(|a| a.exposure = Some(1.0)),
            }];
            let rasters = if resolved {
                &rasters[..]
            } else {
                &rasters[..1]
            };
            let reference = raw_core_local(&input, w, h, &layers, rasters);
            let gpu = run_gpu(&ctx, &input, w, h, &layers, rasters);
            assert!(max_abs_diff(&reference, &gpu) < 1e-4);
            if !resolved {
                assert_eq!(gpu, input);
            }
        }
    }
}

#[test]
fn wgsl_scope_indexes_logical_layers_and_spatial_pass_keeps_group_components() {
    use raw_core::image::{ColorSpace, Image};
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = buffer_16x12();
    let mut second = group(MaskCombine::Subtract, false, false);
    second.adjustments = PartialAdjustments::default();
    let layers = [group(MaskCombine::Intersect, true, false), second.clone()];
    let flat = layers_to_flat(&layers);
    assert_eq!(logical_layers(&flat).count(), 2);
    assert!(!local_adjustments_are_active(
        &layers_to_flat(&[second.clone()]),
        1
    ));
    for scope in 0..2 {
        let mut reference = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        for (pixel, rgba) in reference.pixels.iter_mut().zip(input.chunks_exact(4)) {
            *pixel = [rgba[0], rgba[1], rgba[2]];
        }
        let weights = raw_core::stages::local_adjustments::apply_with_scope(
            &mut reference,
            &layers,
            &[],
            Some(scope),
        )
        .unwrap();
        let image = GpuImage::upload(&ctx, &input, w, h);
        let pass = LocalAdjustmentsPass::new(&flat, &[]).with_scope_layer(scope as i32);
        let gpu = ChainRunner::new(&ctx, &image).run_blocking(&[&pass]);
        for ((rgba, rgb), weight) in gpu.chunks_exact(4).zip(reference.pixels).zip(weights) {
            assert!(max_abs_diff(&rgba[..3], &rgb) < 1e-4);
            assert!((rgba[3] - weight).abs() < 1e-6);
        }
    }
    second.adjustments.sharpness = Some(35.0);
    let reference = raw_core_local(&input, w, h, &[second.clone()], &[]);
    let image = GpuImage::upload(&ctx, &input, w, h);
    let pass = LocalSpatialPass::new(&layers_to_flat(&[second]), &[], false);
    let gpu = ChainRunner::new(&ctx, &image).run_blocking(&[&pass]);
    assert!(max_abs_diff(&reference, &gpu) < 1e-4);
}

#[test]
fn mask_group_wire_constants_and_invalid_groups_are_pinned() {
    use raw_core::types::local_adjustment::flat as core;
    assert_eq!(KIND_GROUP, core::KIND_GROUP);
    assert_eq!(wire::KIND_COMPONENT_BASE, core::KIND_COMPONENT_BASE);
    let mut wire = layers_to_flat(&[group(MaskCombine::Add, false, false)]);
    wire[LAYER_FLAT_LEN + 6] = 29.0;
    assert_eq!(logical_layers(&wire).count(), 0);
    assert!(!local_adjustments_are_active(&wire, 0));
    assert!(LocalAdjustmentsPass::new(&wire, &[]).layers_flat.is_empty());
}

#[test]
fn live_chain_keeps_group_point_spatial_order_and_invalidates_changed_group_layout() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = buffer_16x12();
    let mut first = group(MaskCombine::Subtract, false, false);
    first.adjustments.sharpness = Some(35.0);
    let last = group(MaskCombine::Intersect, true, false);
    let layers = [
        first.clone(),
        LocalAdjustment {
            mask: Mask::Everywhere,
            range: None,
            adjustments: only(|a| a.exposure = Some(-0.4)),
        },
        last.clone(),
    ];
    let inputs = super::bench::bench_inputs(layers_to_flat(&layers));
    let cpu_local = raw_core_local(&input, w, h, &layers, &[]);
    let view_only = super::bench::bench_inputs(vec![]);
    let render = |pixels: &[f32], inputs: &crate::FullChainInputs<'_>| {
        let image = GpuImage::upload(&ctx, pixels, w, h);
        let passes = crate::build_live_chain(inputs, crate::AirlightSource::OnGpu);
        let refs: Vec<&dyn crate::chain::Pass> = passes.iter().map(|pass| pass.as_ref()).collect();
        ChainRunner::new(&ctx, &image).run_blocking(&refs)
    };
    let reference = render(&cpu_local, &view_only);
    let gpu = render(&input, &inputs);
    assert!(max_abs_diff(&reference, &gpu) < 1e-4);
    let mut shorter = last;
    let Mask::Group(group) = &mut shorter.mask else {
        unreachable!()
    };
    group.components.pop();
    shorter.adjustments = first.adjustments.clone();
    let left = super::bench::bench_inputs(layers_to_flat(&[first.clone(), shorter.clone()]));
    let right = super::bench::bench_inputs(layers_to_flat(&[shorter, first]));
    assert_eq!(left.local_adjustments.len(), right.local_adjustments.len());
    assert_ne!(
        crate::chain_signature(&left, (w, h), 1),
        crate::chain_signature(&right, (w, h), 1)
    );
}
