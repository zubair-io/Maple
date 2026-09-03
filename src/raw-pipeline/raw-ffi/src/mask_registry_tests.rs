use super::*;
use raw_core::types::{BitmapRecipe, PartialAdjustments};

const DATA: [u8; 4] = [0, 255, 255, 0];

fn bitmap_layer(recipe: BitmapRecipe, raster_id: u32) -> LocalAdjustment {
    LocalAdjustment {
        mask: Mask::Bitmap { recipe, raster_id },
        range: None,
        adjustments: PartialAdjustments {
            exposure: Some(1.0),
            ..Default::default()
        },
    }
}

// `REGISTRY` is one process-wide table and these tests run concurrently on
// shared threads (the crate's default test harness), so every test that
// exercises DIGEST-based lookup (`resolve_into`'s fallback) below uses its
// OWN digest, unique from every other test in this file — otherwise
// `lookup_digest` could legitimately return a DIFFERENT test's entry.
// Id-keyed lookups (`layers_and_rasters_from_flat`, and `resolve_into`'s id
// fast path) don't have this problem: the id `maple_mask_raster_register`
// returns is unique across the whole process by construction.

#[test]
fn register_returns_a_positive_id_and_resolve_attaches_the_raster() {
    let digest = b"f00d1000000000d1";
    let id = maple_mask_raster_register(digest.as_ptr(), 2, 2, DATA.as_ptr(), DATA.len());
    assert!(id >= 1, "expected a positive id, got {id}");

    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![bitmap_layer(
        BitmapRecipe {
            digest: "f00d1000000000d1".into(),
            ..Default::default()
        },
        0, // unresolved, as a fresh XMP parse always leaves it
    )];
    resolve_into(&mut model);

    assert_eq!(model.mask_rasters.len(), 1);
    assert_eq!(model.mask_rasters[0].id, id as u32);
    match &model.local_adjustments[0].mask {
        Mask::Bitmap { raster_id, .. } => assert_eq!(*raster_id, id as u32),
        other => panic!("expected Bitmap, got {other:?}"),
    }

    maple_mask_raster_release(id as u32);
    let mut again = AdjustmentModel::default();
    again.local_adjustments = vec![bitmap_layer(
        BitmapRecipe {
            digest: "f00d1000000000d1".into(),
            ..Default::default()
        },
        0,
    )];
    resolve_into(&mut again);
    assert!(
        again.mask_rasters.is_empty(),
        "a released raster must no longer resolve"
    );
    match &again.local_adjustments[0].mask {
        Mask::Bitmap { raster_id, .. } => {
            assert_eq!(*raster_id, 0, "an unresolved id stays 0, not defaulted")
        }
        other => panic!("expected Bitmap, got {other:?}"),
    }
}

/// A raster_id carried over from an earlier registration in the SAME
/// process (not 0) that has since been released still resolves if the SAME
/// digest is re-registered under a new id — the digest fallback, not just
/// the id fast path.
#[test]
fn resolve_falls_back_to_digest_when_the_carried_id_is_stale() {
    let digest = b"f00d2000000000d2";
    let first_id = maple_mask_raster_register(digest.as_ptr(), 2, 2, DATA.as_ptr(), DATA.len());
    maple_mask_raster_release(first_id as u32);
    let second_id = maple_mask_raster_register(digest.as_ptr(), 2, 2, DATA.as_ptr(), DATA.len());
    assert_ne!(first_id, second_id);

    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![bitmap_layer(
        BitmapRecipe {
            digest: "f00d2000000000d2".into(),
            ..Default::default()
        },
        first_id as u32, // stale — no longer registered
    )];
    resolve_into(&mut model);

    assert_eq!(model.mask_rasters.len(), 1);
    match &model.local_adjustments[0].mask {
        Mask::Bitmap { raster_id, .. } => assert_eq!(*raster_id, second_id as u32),
        other => panic!("expected Bitmap, got {other:?}"),
    }
    maple_mask_raster_release(second_id as u32);
}

#[test]
fn register_rejects_null_bad_length_and_non_hex_digest() {
    let digest = b"f00d3000000000d3";
    assert_eq!(
        maple_mask_raster_register(std::ptr::null(), 2, 2, DATA.as_ptr(), DATA.len()),
        -1,
        "null digest pointer"
    );
    assert_eq!(
        maple_mask_raster_register(digest.as_ptr(), 2, 2, DATA.as_ptr(), 3),
        -2,
        "data_len must equal width * height"
    );
    assert_eq!(
        maple_mask_raster_register(
            b"not-hex-not-hex!".as_ptr(),
            2,
            2,
            DATA.as_ptr(),
            DATA.len()
        ),
        -3,
        "digest bytes must be 16 lowercase hex chars"
    );
    assert_eq!(
        maple_mask_raster_register(
            b"0123456789ABCDEF".as_ptr(),
            2,
            2,
            DATA.as_ptr(),
            DATA.len()
        ),
        -3,
        "uppercase hex is rejected — the documented format is lowercase"
    );
}

/// Id-keyed, not digest-keyed — safe to run concurrently with every other
/// test here regardless of digest content, since `id` is unique by
/// construction (`NEXT_ID` is a process-wide monotonic counter).
#[test]
fn layers_and_rasters_from_flat_resolves_a_registered_bitmap_record() {
    let digest = b"f00d4000000000d4";
    let id = maple_mask_raster_register(digest.as_ptr(), 2, 2, DATA.as_ptr(), DATA.len());
    let layers = vec![bitmap_layer(BitmapRecipe::default(), id as u32)];
    let flat = raw_core::types::layers_to_flat(&layers);

    let (decoded, rasters) = layers_and_rasters_from_flat(&flat);
    assert_eq!(decoded.len(), 1);
    assert_eq!(rasters.len(), 1);
    assert_eq!(rasters[0].id, id as u32);
    match &decoded[0].mask {
        Mask::Bitmap { raster_id, .. } => assert_eq!(*raster_id, id as u32),
        other => panic!("expected Bitmap, got {other:?}"),
    }
    maple_mask_raster_release(id as u32);
}

/// An id with no registry entry at all (never registered this process, or
/// released) decodes to an empty rasters list — the flat-wire path has no
/// digest to fall back on, unlike `resolve_into`.
#[test]
fn layers_and_rasters_from_flat_leaves_an_unregistered_id_unresolved() {
    let layers = vec![bitmap_layer(BitmapRecipe::default(), 999_999)];
    let flat = raw_core::types::layers_to_flat(&layers);

    let (decoded, rasters) = layers_and_rasters_from_flat(&flat);
    assert!(rasters.is_empty());
    match &decoded[0].mask {
        Mask::Bitmap { raster_id, .. } => assert_eq!(*raster_id, 999_999),
        other => panic!("expected Bitmap, got {other:?}"),
    }
}
