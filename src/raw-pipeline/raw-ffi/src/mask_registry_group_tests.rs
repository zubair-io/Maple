use super::*;
use raw_core::types::{
    layers_to_flat, BitmapRecipe, MaskCombine, MaskComponent, MaskGroup, PartialAdjustments,
};

#[test]
fn group_components_resolve_by_digest_and_flat_ids_on_both_ffi_paths() {
    let digests = ["3408f00100000001", "3408f00100000002"];
    let data = [255u8, 64, 0, 128];
    let ids: Vec<u32> = digests
        .iter()
        .map(|digest| {
            let id = maple_mask_raster_register(digest.as_ptr(), 2, 2, data.as_ptr(), data.len());
            assert!(id > 0);
            id as u32
        })
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
    resolve_into(&mut model);
    assert_eq!(
        model.mask_rasters.iter().map(|r| r.id).collect::<Vec<_>>(),
        ids
    );
    let flat = layers_to_flat(&model.local_adjustments);
    let (decoded, rasters) = layers_and_rasters_from_flat(&flat);
    assert_eq!(rasters.iter().map(|r| r.id).collect::<Vec<_>>(), ids);
    let Mask::Group(group) = &decoded[0].mask else {
        panic!("group lost");
    };
    for (component, expected) in group.components.iter().zip(&ids) {
        let Mask::Bitmap { raster_id, recipe } = component.mask() else {
            panic!("bitmap lost");
        };
        assert_eq!(raster_id, expected);
        assert_eq!(
            recipe.digest,
            rasters.iter().find(|r| r.id == *expected).unwrap().digest
        );
    }
    maple_mask_raster_release(ids[1]);
    let (_, remaining) = layers_and_rasters_from_flat(&flat);
    assert_eq!(remaining.len(), 1);
    // Already-resolved in-flight renders hold their Arc after release.
    assert_eq!(rasters.len(), 2);
    maple_mask_raster_release(ids[0]);
}
