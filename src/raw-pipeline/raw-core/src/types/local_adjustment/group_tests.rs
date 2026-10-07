use super::*;
use crate::image::{ColorSpace, Image};
use crate::stages::local_adjustments::{apply_with_scope, mask};
use crate::types::{
    layers_from_flat, layers_to_flat, BitmapRecipe, LocalAdjustment, MaskRaster,
    PartialAdjustments, Point2, LAYER_FLAT_LEN,
};
use std::sync::Arc;

fn component(mask: Mask, combine: MaskCombine, invert: bool) -> MaskComponent {
    MaskComponent::new(mask, combine, invert).unwrap()
}

fn linear() -> Mask {
    Mask::Linear {
        start: Point2::new(0.0, 0.5),
        end: Point2::new(1.0, 0.5),
        feather: 1.0,
    }
}

fn radial() -> Mask {
    Mask::Radial {
        center: Point2::new(0.125, 0.5),
        radii: Point2::new(0.5, 0.5),
        angle: 0.0,
        feather: 0.5,
        invert: false,
    }
}

fn layer(group: MaskGroup) -> LocalAdjustment {
    LocalAdjustment {
        mask: Mask::Group(group),
        range: None,
        adjustments: PartialAdjustments {
            exposure: Some(1.0),
            ..Default::default()
        },
    }
}

fn image() -> Image {
    Image {
        width: 3,
        height: 3,
        pixels: vec![[0.18; 3]; 9],
        space: ColorSpace::SceneLinearRec2020,
        whites_anchor_ev: None,
        nr_sampling_scale: 1.0,
    }
}

fn document(model: &crate::types::AdjustmentModel) -> String {
    let children = crate::xmp::serialize_local_adjustments(model, "      ");
    format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/1.0/">{children}</rdf:Description></rdf:RDF></x:xmpmeta>"#
    )
}

#[test]
fn soft_composition_applies_once_and_scope_records_the_same_weight() {
    for (combine, expected) in [
        (MaskCombine::Add, 0.75f32),
        (MaskCombine::Subtract, 0.25),
        (MaskCombine::Intersect, 0.25),
    ] {
        let group = MaskGroup::new(vec![
            component(radial(), MaskCombine::Add, false),
            component(linear(), combine, false),
        ]);
        let mut img = image();
        let weights = apply_with_scope(&mut img, &[layer(group)], &[], Some(0)).unwrap();
        assert!((weights[4] - expected).abs() < 1e-6);
        assert!((img.pixels[4][0] - 0.18 * expected.exp2()).abs() < 1e-6);
    }
}

#[test]
fn component_inversion_precedes_composition_and_group_opacity_is_last() {
    let group = MaskGroup {
        components: vec![
            component(Mask::Everywhere, MaskCombine::Add, false),
            component(linear(), MaskCombine::Subtract, true),
        ],
        opacity: 0.25,
        invert: true,
    };
    let mut img = image();
    let weights = apply_with_scope(&mut img, &[layer(group)], &[], Some(0)).unwrap();
    assert_eq!(
        weights,
        vec![0.25, 0.125, 0.0, 0.25, 0.125, 0.0, 0.25, 0.125, 0.0]
    );
    assert_eq!(img.pixels[2], [0.18; 3]);
}

#[test]
fn empty_groups_and_missing_subtract_rasters_fail_closed_even_when_inverted() {
    for group in [
        MaskGroup {
            components: vec![],
            opacity: 1.0,
            invert: true,
        },
        MaskGroup {
            components: vec![
                component(Mask::Everywhere, MaskCombine::Add, false),
                component(
                    Mask::Bitmap {
                        recipe: BitmapRecipe::default(),
                        raster_id: 77,
                    },
                    MaskCombine::Subtract,
                    true,
                ),
            ],
            opacity: 1.0,
            invert: true,
        },
    ] {
        let mut img = image();
        let before = img.pixels.clone();
        let weights = apply_with_scope(&mut img, &[layer(group)], &[], Some(0)).unwrap();
        assert_eq!(weights, vec![0.0; 9]);
        assert_eq!(img.pixels, before);
    }
    assert!(
        MaskComponent::new(Mask::Group(MaskGroup::new(vec![])), MaskCombine::Add, false).is_none()
    );
}

#[test]
fn different_bitmap_components_resolve_independently() {
    let rasters: Vec<_> = [(11, 0.8), (12, 0.25)]
        .into_iter()
        .map(|(id, value)| {
            Arc::new(MaskRaster {
                id,
                digest: String::new(),
                width: 1,
                height: 1,
                data: vec![value],
            })
        })
        .collect();
    let group = MaskGroup::new(vec![
        component(
            Mask::Bitmap {
                recipe: BitmapRecipe::default(),
                raster_id: 11,
            },
            MaskCombine::Add,
            false,
        ),
        component(
            Mask::Bitmap {
                recipe: BitmapRecipe::default(),
                raster_id: 12,
            },
            MaskCombine::Subtract,
            false,
        ),
    ]);
    let mut img = image();
    let weights = apply_with_scope(&mut img, &[layer(group)], &rasters, Some(0)).unwrap();
    assert!(weights.iter().all(|weight| (*weight - 0.6).abs() < 1e-6));
}

#[test]
fn flat_groups_preserve_order_modes_inversions_and_following_layers() {
    for combine in [
        MaskCombine::Add,
        MaskCombine::Subtract,
        MaskCombine::Intersect,
    ] {
        for invert in [false, true] {
            let group = MaskGroup {
                components: vec![
                    component(radial(), MaskCombine::Add, false),
                    component(linear(), combine, invert),
                    component(Mask::Everywhere, combine, invert),
                    component(
                        Mask::Bitmap {
                            recipe: BitmapRecipe::default(),
                            raster_id: 55,
                        },
                        combine,
                        invert,
                    ),
                ],
                opacity: 0.375,
                invert: true,
            };
            let layers = vec![
                layer(group),
                LocalAdjustment::linear(
                    Point2::new(0.0, 0.0),
                    Point2::new(1.0, 1.0),
                    PartialAdjustments::default(),
                ),
            ];
            let flat = layers_to_flat(&layers);
            assert_eq!(flat.len(), 6 * LAYER_FLAT_LEN);
            assert_eq!(layers_from_flat(&flat, &[]), layers);
            assert!(layers_from_flat(&flat[..LAYER_FLAT_LEN * 4], &[]).is_empty());
            let mut corrupt = flat.clone();
            corrupt[LAYER_FLAT_LEN + 6] = 29.0;
            assert!(layers_from_flat(&corrupt, &[]).is_empty());
        }
    }
}

#[test]
fn actual_lightroom_composition_exports_import_and_round_trip() {
    for (source, combine) in [
        (
            include_str!(
                "../../../../../../test-fixtures/local-adjustments/lightroom-group-add.xmp"
            ),
            MaskCombine::Add,
        ),
        (
            include_str!(
                "../../../../../../test-fixtures/local-adjustments/lightroom-group-subtract.xmp"
            ),
            MaskCombine::Subtract,
        ),
        (
            include_str!(
                "../../../../../../test-fixtures/local-adjustments/lightroom-group-intersect.xmp"
            ),
            MaskCombine::Intersect,
        ),
    ] {
        let model = crate::xmp::parse(source).unwrap();
        let Mask::Group(group) = &model.local_adjustments[0].mask else {
            panic!("expected composition");
        };
        assert_eq!(group.components.len(), 2);
        assert_eq!(group.components[1].combine, combine);
        let Mask::Radial {
            feather, invert, ..
        } = group.components[0].mask()
        else {
            panic!("expected radial");
        };
        assert_eq!(*feather, 0.5);
        assert!(!invert);
        let rewritten = document(&model);
        let reparsed = crate::xmp::parse(&rewritten).unwrap();
        assert_eq!(
            reparsed.local_adjustments, model.local_adjustments,
            "{rewritten}"
        );
        assert!(rewritten.contains("crs:MaskBlendMode="));
        assert_eq!(
            mask::evaluate(&model.local_adjustments[0].mask, None, 0.1, 0.1),
            mask::evaluate(&reparsed.local_adjustments[0].mask, None, 0.1, 0.1)
        );
    }
}

#[test]
fn future_group_or_radial_versions_never_apply_a_partial_selection() {
    let source = include_str!(
        "../../../../../../test-fixtures/local-adjustments/lightroom-group-subtract.xmp"
    );
    let future_radial = source.replace("crs:Version=\"2\"", "crs:Version=\"3\"");
    assert!(crate::xmp::parse(&future_radial)
        .unwrap()
        .local_adjustments
        .is_empty());
    let model = crate::xmp::parse(source).unwrap();
    let future_group =
        document(&model).replace("papp:MaskGroupVersion=\"1\"", "papp:MaskGroupVersion=\"2\"");
    assert!(crate::xmp::parse(&future_group)
        .unwrap()
        .local_adjustments
        .is_empty());
}

#[test]
fn unsupported_radial_shapes_and_boolean_flags_do_not_widen_groups() {
    let source = include_str!(
        "../../../../../../test-fixtures/local-adjustments/lightroom-group-subtract.xmp"
    );
    for (from, to) in [
        ("crs:Midpoint=\"50\"", "crs:Midpoint=\"25\""),
        ("crs:Roundness=\"0\"", "crs:Roundness=\"20\""),
        ("crs:FullX=\"0.52459\"", "crs:FullX=\"NaN\""),
        ("crs:FullX=\"0.52459\"", ""),
        (
            "crs:CorrectionActive=\"true\"",
            "crs:CorrectionActive=\"true\" papp:RangeKind=\"Future\"",
        ),
        ("crs:MaskInverted=\"false\"", "crs:MaskInverted=\"unknown\""),
        ("crs:Flipped=\"true\"", "crs:Flipped=\"unknown\""),
        ("crs:MaskActive=\"true\"", "crs:MaskActive=\"unknown\""),
        (
            "crs:CorrectionActive=\"true\"",
            "crs:CorrectionActive=\"unknown\"",
        ),
    ] {
        assert!(
            crate::xmp::parse(&source.replace(from, to))
                .unwrap()
                .local_adjustments
                .is_empty(),
            "{to}"
        );
    }
    let model = crate::xmp::parse(source).unwrap();
    let malformed = document(&model).replace(
        "papp:MaskGroupInverted=\"False\"",
        "papp:MaskGroupInverted=\"unknown\"",
    );
    assert!(crate::xmp::parse(&malformed)
        .unwrap()
        .local_adjustments
        .is_empty());
}

#[test]
fn local_group_namespace_aliases_and_foreign_prefixes_are_resolved_by_uri() {
    let source = include_str!(
        "../../../../../../test-fixtures/local-adjustments/lightroom-group-subtract.xmp"
    );
    let expected = crate::xmp::parse(source).unwrap().local_adjustments;
    let aliases = source
        .replace("crs:", "camera:")
        .replace("xmlns:crs=", "xmlns:camera=")
        .replace("rdf:", "graph:")
        .replace("xmlns:rdf=", "xmlns:graph=");
    assert_eq!(
        crate::xmp::parse(&aliases).unwrap().local_adjustments,
        expected
    );
    for source in [
        source.replace(
            "crs:Version=\"2\"/>",
            "crs:Version=\"2\" xmlns:crs=\"urn:foreign\"/>",
        ),
        source.replace(
            "crs:Version=\"2\"/>",
            "crs:Version=\"2\" xmlns:rdf=\"urn:foreign\"/>",
        ),
        source.replace(
            "http://ns.adobe.com/camera-raw-settings/1.0/",
            "urn:foreign",
        ),
    ] {
        assert!(crate::xmp::parse(&source)
            .unwrap()
            .local_adjustments
            .is_empty());
    }
    let foreign_attribute = source.replace(
        "crs:Version=\"2\"/>",
        "crs:Version=\"2\" xmlns:papp=\"urn:foreign\" papp:MaskCombine=\"keep\"/>",
    );
    assert_eq!(
        crate::xmp::parse(&foreign_attribute)
            .unwrap()
            .local_adjustments,
        expected
    );
    let foreign_attributes = source.replace(
        "crs:Version=\"2\"/>",
        "crs:Version=\"2\" xmlns:a=\"urn:a\" xmlns:b=\"urn:b\" a:Tag=\"one\" b:Tag=\"two\"/>",
    );
    assert_eq!(
        crate::xmp::parse(&foreign_attributes)
            .unwrap()
            .local_adjustments,
        expected
    );
}

#[test]
fn group_opacity_keeps_float_precision_in_xmp() {
    let model = crate::xmp::AdjustmentModel {
        local_adjustments: vec![layer(MaskGroup {
            components: vec![component(Mask::Everywhere, MaskCombine::Add, false)],
            opacity: 0.31876543,
            invert: false,
        })],
        ..Default::default()
    };
    assert_eq!(
        crate::xmp::parse(&document(&model))
            .unwrap()
            .local_adjustments,
        model.local_adjustments
    );
}

#[test]
fn explicit_single_component_group_retains_opacity_and_inversion() {
    let mut model = crate::types::AdjustmentModel::default();
    model.local_adjustments = vec![layer(MaskGroup::new(vec![component(
        linear(),
        MaskCombine::Add,
        false,
    )]))];
    let parsed = crate::xmp::parse(&document(&model)).unwrap();
    assert_eq!(parsed.local_adjustments, model.local_adjustments);
}

/// Brush is a top-level-only mask in this slice (#360): a group component
/// cannot hold one, so a foreign group with a paint leaf imports as
/// unsupported (dropped, never widened) rather than half-modelled.
#[test]
fn mask_component_rejects_brush() {
    use crate::types::BrushDab;
    let brush = Mask::Brush {
        dabs: vec![BrushDab::new(Point2::new(0.5, 0.5), 0.05, 0.5, 1.0, false)],
        digest: String::new(),
        raster_id: 0,
    };
    assert!(MaskComponent::new(brush, MaskCombine::Add, false).is_none());
}
