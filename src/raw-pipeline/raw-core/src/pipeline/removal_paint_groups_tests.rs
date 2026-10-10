use super::*;
use crate::types::accepted_removal::ContentDigest;
use std::collections::BTreeSet;

fn source(width: u32, height: u32) -> String {
    serde_json::to_string(&SourceAnchor {
        original: ContentDigest::for_bytes(b"paint-original"),
        decode: ContentDigest::for_bytes(b"paint-decode"),
        width,
        height,
    })
    .unwrap()
}

fn intent(size: [u32; 2], frame: [u32; 4], selected: &[[u32; 2]]) -> Vec<u8> {
    let [x, y, width, height] = frame;
    let mut pixels = vec![0; width as usize * height as usize];
    for [sx, sy] in selected {
        pixels[(sy - y) as usize * width as usize + (sx - x) as usize] = 255;
    }
    removal_mask_to_bytes(&RemovalMask {
        source_width: size[0],
        source_height: size[1],
        x,
        y,
        width,
        height,
        pixels,
    })
    .unwrap()
}

fn selected(bytes: &[u8]) -> BTreeSet<[u32; 2]> {
    let mask = crate::pipeline::removal_mask_from_bytes(bytes).unwrap();
    mask.pixels
        .iter()
        .enumerate()
        .filter_map(|(index, v)| {
            (*v == 255).then_some([
                mask.x + (index % mask.width as usize) as u32,
                mask.y + (index / mask.width as usize) as u32,
            ])
        })
        .collect()
}

#[test]
fn an_existing_bounded_selection_keeps_exact_asset_bytes() {
    let bytes = intent([6000, 4000], [200, 300, 80, 50], &[[210, 310], [270, 340]]);
    assert_eq!(
        paint_generation_intents(&source(6000, 4000), &bytes, 8, 4.0).unwrap(),
        [bytes]
    );
}

#[test]
fn distant_painted_areas_preserve_every_native_pixel_on_a_100mp_source() {
    let points: Vec<_> = (100..120)
        .flat_map(|y| (100..120).chain(9900..9920).map(move |x| [x, y]))
        .collect();
    let bytes = intent([10000, 10000], [100, 100, 9820, 20], &points);
    let anchor = source(10000, 10000);
    assert!(plan_removal_generation(&anchor, &bytes, 8, 4.0).is_err());
    let groups = paint_generation_intents(&anchor, &bytes, 8, 4.0).unwrap();
    assert_eq!(groups.len(), 2);
    let first = selected(&groups[0]);
    let second = selected(&groups[1]);
    assert!(first.is_disjoint(&second));
    assert_eq!(
        first.union(&second).copied().collect::<BTreeSet<_>>(),
        selected(&bytes)
    );
    for group in groups {
        let plan: crate::stages::removal_generation::GenerationMaskRequest =
            serde_json::from_str(&plan_removal_generation(&anchor, &group, 8, 4.0).unwrap())
                .unwrap();
        assert_eq!([plan.window.width, plan.window.height], [2048, 2048]);
    }
}

#[test]
fn nearby_disconnected_paint_is_kept_in_one_context_and_order_is_stable() {
    let bytes = intent(
        [3000, 2000],
        [100, 100, 2201, 1],
        &[[100, 100], [700, 100], [2300, 100]],
    );
    let anchor = source(3000, 2000);
    let first = paint_generation_intents(&anchor, &bytes, 8, 4.0).unwrap();
    assert_eq!(
        first,
        paint_generation_intents(&anchor, &bytes, 8, 4.0).unwrap()
    );
    assert_eq!(first.len(), 2);
    assert_eq!(
        selected(&first[0]),
        BTreeSet::from([[100, 100], [700, 100]])
    );
    assert_eq!(selected(&first[1]), BTreeSet::from([[2300, 100]]));
}

#[test]
fn a_diagonally_connected_large_area_refuses_the_whole_operation() {
    let points: Vec<_> = std::iter::once([2500, 0])
        .chain((1..2100).map(|n| [n, n]))
        .collect();
    let bytes = intent([3000, 3000], [1, 0, 2500, 2100], &points);
    let error = paint_generation_intents(&source(3000, 3000), &bytes, 8, 4.0).unwrap_err();
    assert!(error.contains("one connected painted area"), "{error}");
}

#[test]
fn clipped_source_edges_fit_but_a_component_expansion_is_never_truncated() {
    let points: Vec<_> = (0..2040).map(|x| [x, 10]).chain([[2999, 10]]).collect();
    let bytes = intent([3000, 100], [0, 10, 3000, 1], &points);
    assert_eq!(
        paint_generation_intents(&source(3000, 100), &bytes, 8, 4.0)
            .unwrap()
            .len(),
        2
    );
    let points: Vec<_> = (0..2041).map(|x| [x, 10]).chain([[2999, 10]]).collect();
    let too_big = intent([3000, 100], [0, 10, 3000, 1], &points);
    assert!(paint_generation_intents(&source(3000, 100), &too_big, 8, 4.0).is_err());
}

#[test]
fn packed_transport_and_invalid_source_radii_or_empty_masks_are_checked() {
    let anchor = source(3000, 2000);
    let bytes = intent(
        [3000, 2000],
        [100, 100, 2201, 1],
        &[[100, 100], [2300, 100]],
    );
    let groups = paint_generation_intents(&anchor, &bytes, 8, 4.0).unwrap();
    let packed = paint_generation_intents_packed(&anchor, &bytes, 8, 4.0).unwrap();
    assert_eq!(u32::from_le_bytes(packed[..4].try_into().unwrap()), 2);
    let mut cursor = 4;
    for group in groups {
        let length = u32::from_le_bytes(packed[cursor..cursor + 4].try_into().unwrap()) as usize;
        cursor += 4;
        assert_eq!(&packed[cursor..cursor + length], group);
        cursor += length;
    }
    assert_eq!(cursor, packed.len());
    assert!(paint_generation_intents(&source(3001, 2000), &bytes, 8, 4.0).is_err());
    assert!(paint_generation_intents(&anchor, &bytes, 0, 1.0).is_err());
    assert!(paint_generation_intents(&anchor, &bytes, 8, f32::NAN).is_err());
    let empty = intent([3000, 2000], [100, 100, 2201, 1], &[]);
    assert!(paint_generation_intents(&anchor, &empty, 8, 4.0).is_err());
    assert!(paint_generation_intents(&anchor, &bytes[..bytes.len() - 1], 8, 4.0).is_err());
}
