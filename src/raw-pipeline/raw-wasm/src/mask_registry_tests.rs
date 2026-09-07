//! Host-target tests for the wasm raster registry (#3300) — the plain-Rust
//! `register` / `release` / `resolve_into` / `parse_model` bodies the
//! `#[wasm_bindgen]` wrappers delegate to, so they run as ordinary native
//! `#[test]`s like every other module in this crate (`tests.rs`).
//!
//! `REGISTRY` is one instance-wide table and these tests run concurrently on
//! the default test harness, so every DIGEST-keyed lookup below uses its own
//! digest, unique within this file — otherwise `lookup_digest` could return
//! another test's entry. Id-keyed lookups are safe regardless (`NEXT_ID` is
//! a process-wide monotonic counter).

use super::*;
use raw_core::types::local_adjustment::flat::KIND_BITMAP;
use raw_core::types::{layers_to_flat, BitmapRecipe, LocalAdjustment, PartialAdjustments};

const DATA: [u8; 4] = [0, 255, 255, 0];

fn bitmap_layer(digest: &str, raster_id: u32) -> LocalAdjustment {
    LocalAdjustment {
        mask: Mask::Bitmap {
            recipe: BitmapRecipe {
                digest: digest.into(),
                ..Default::default()
            },
            raster_id,
        },
        range: None,
        adjustments: PartialAdjustments {
            exposure: Some(1.0),
            ..Default::default()
        },
    }
}

/// A sidecar carrying one `PersonSkin` correction under `digest` — the
/// canonical `crs:MaskGroupBasedCorrections` shape raw-core writes.
fn sidecar_with_person_skin(digest: &str) -> String {
    format!(
        r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:papp="http://ns.justmaple.app/1.0/"
      crs:Version="11.0">
      <crs:MaskGroupBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="True" crs:LocalExposure2012="1">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li crs:What="Mask/Image" crs:MaskSubType="1" crs:MaskValue="1" papp:MaskSource="PersonSkin" papp:MaskDigest="{digest}"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:MaskGroupBasedCorrections>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"#
    )
}

#[test]
fn register_returns_a_positive_id_and_resolve_attaches_the_raster_by_digest() {
    let digest = "beef1000000000d1";
    let id = register(digest, 2, 2, &DATA).expect("register");
    assert!(id >= 1);

    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![bitmap_layer(digest, 0)];
    resolve_into(&mut model);

    assert_eq!(model.mask_rasters.len(), 1);
    assert_eq!(model.mask_rasters[0].id, id);
    assert_eq!(model.mask_rasters[0].width, 2);
    match &model.local_adjustments[0].mask {
        Mask::Bitmap { raster_id, .. } => assert_eq!(*raster_id, id),
        other => panic!("expected Bitmap, got {other:?}"),
    }

    release(id);
    let mut again = AdjustmentModel::default();
    again.local_adjustments = vec![bitmap_layer(digest, 0)];
    resolve_into(&mut again);
    assert!(
        again.mask_rasters.is_empty(),
        "a released raster must no longer resolve"
    );
    match &again.local_adjustments[0].mask {
        Mask::Bitmap { raster_id, .. } => assert_eq!(*raster_id, 0, "unresolved stays 0"),
        other => panic!("expected Bitmap, got {other:?}"),
    }
}

/// A stale id (registered earlier, since released) still resolves when the
/// same digest was re-registered under a new id — the digest fallback.
#[test]
fn resolve_falls_back_to_digest_when_the_carried_id_is_stale() {
    let digest = "beef2000000000d2";
    let first = register(digest, 2, 2, &DATA).expect("register");
    release(first);
    let second = register(digest, 2, 2, &DATA).expect("register");
    assert_ne!(first, second);

    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![bitmap_layer(digest, first)];
    resolve_into(&mut model);
    match &model.local_adjustments[0].mask {
        Mask::Bitmap { raster_id, .. } => assert_eq!(*raster_id, second),
        other => panic!("expected Bitmap, got {other:?}"),
    }
    release(second);
}

#[test]
fn register_rejects_a_bad_digest_and_a_length_mismatch() {
    assert!(register("not-hex-not-hex!", 2, 2, &DATA).is_err());
    assert!(
        register("0123456789ABCDEF", 2, 2, &DATA).is_err(),
        "uppercase hex is rejected"
    );
    assert!(
        register("0123456789abcde", 2, 2, &DATA).is_err(),
        "15 chars"
    );
    assert!(
        register("beef3000000000d3", 2, 2, &DATA[..3]).is_err(),
        "data_len != w*h"
    );
    assert!(
        register("beef3000000000d3", 0, 0, &[]).is_ok(),
        "an empty raster is legal"
    );
    // `usize::MAX` on this host, `u32::MAX`-adjacent on wasm32: either way
    // `width * height` must not wrap around and match an empty `data`.
    assert!(
        register("beef3000000000d3", u32::MAX, u32::MAX, &[]).is_err(),
        "an overflowing width * height is rejected, not wrapped to 0"
    );
}

/// The load-bearing plumbing claim: a sidecar parsed through the shared
/// `parse_model` comes back with its `PersonSkin` layer resolved to the
/// registered raster — `raster_id` stamped and `mask_rasters` populated —
/// and the flat wire the GPU chain binds carries that id.
#[test]
fn parse_model_resolves_a_registered_person_skin_layer() {
    let digest = "beef4000000000d4";
    let id = register(digest, 2, 2, &DATA).expect("register");

    let model = parse_model(Some(&sidecar_with_person_skin(digest))).expect("parse");
    assert_eq!(model.local_adjustments.len(), 1);
    assert_eq!(model.mask_rasters.len(), 1);
    assert_eq!(model.mask_rasters[0].id, id);
    match &model.local_adjustments[0].mask {
        Mask::Bitmap { raster_id, recipe } => {
            assert_eq!(*raster_id, id);
            assert_eq!(recipe.digest, digest);
        }
        other => panic!("expected Bitmap, got {other:?}"),
    }
    let flat = layers_to_flat(&model.local_adjustments);
    assert_eq!(flat[6], KIND_BITMAP);
    assert_eq!(flat[2], id as f32);

    release(id);
}

/// Without a registration the same sidecar parses to an UNRESOLVED layer —
/// present (its other edits still load), `raster_id` 0, no rasters — never
/// dropped and never promoted to a whole-image correction.
#[test]
fn parse_model_leaves_an_unregistered_digest_unresolved() {
    let model = parse_model(Some(&sidecar_with_person_skin("beef5000000000d5"))).expect("parse");
    assert_eq!(model.local_adjustments.len(), 1);
    assert!(model.mask_rasters.is_empty());
    match &model.local_adjustments[0].mask {
        Mask::Bitmap { raster_id, .. } => assert_eq!(*raster_id, 0),
        other => panic!("expected Bitmap, got {other:?}"),
    }
}

#[test]
fn parse_model_without_a_sidecar_is_the_default_model() {
    assert_eq!(
        parse_model(None).expect("parse"),
        AdjustmentModel::default()
    );
}
