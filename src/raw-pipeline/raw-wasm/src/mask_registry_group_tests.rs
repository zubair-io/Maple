use super::*;
use raw_core::types::{
    BitmapRecipe, LocalAdjustment, MaskCombine, MaskComponent, MaskGroup, PartialAdjustments,
};

#[test]
fn group_components_resolve_from_a_real_serialized_sidecar_in_the_wasm_registry() {
    let digests = ["3408a00100000001", "3408a00100000002"];
    let data = [255u8, 64, 0, 128];
    let ids: Vec<u32> = digests
        .iter()
        .map(|digest| register(digest, 2, 2, &data).unwrap())
        .collect();
    let components = digests
        .iter()
        .zip([MaskCombine::Add, MaskCombine::Subtract])
        .map(|(digest, combine)| {
            MaskComponent::new(
                Mask::Bitmap {
                    recipe: BitmapRecipe {
                        digest: (*digest).into(),
                        ..Default::default()
                    },
                    raster_id: 0,
                },
                combine,
                false,
            )
            .unwrap()
        })
        .collect();
    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![LocalAdjustment {
        mask: Mask::Group(MaskGroup::new(components)),
        adjustments: PartialAdjustments {
            exposure: Some(1.0),
            ..Default::default()
        },
        range: None,
    }];
    let fragment = raw_core::xmp::serialize_local_adjustments(&model, "");
    let sidecar = format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/1.0/">{fragment}</rdf:Description></rdf:RDF></x:xmpmeta>"#
    );
    let parsed = parse_model(Some(&sidecar)).unwrap();
    assert_eq!(
        parsed.mask_rasters.iter().map(|r| r.id).collect::<Vec<_>>(),
        ids
    );
    let Mask::Group(group) = &parsed.local_adjustments[0].mask else {
        panic!("group lost");
    };
    for (component, expected) in group.components.iter().zip(&ids) {
        let Mask::Bitmap { raster_id, .. } = component.mask() else {
            panic!("bitmap lost");
        };
        assert_eq!(raster_id, expected);
    }
    for id in ids {
        release(id);
    }
    assert!(parse_model(Some(&sidecar)).unwrap().mask_rasters.is_empty());
}
