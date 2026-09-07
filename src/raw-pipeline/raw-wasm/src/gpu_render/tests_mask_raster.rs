//! Bitmap-mask raster plumbing gate (#3300).
//!
//! `mask_raster_register` is a `#[wasm_bindgen]` entry and `WebLiveSession`
//! is wasm32-only, but everything the web path DOES with a registered raster
//! — resolve the parsed model's `Mask::Bitmap` layer against the registry,
//! then fold the raster into the [`raw_gpu::FullChainInputs`] the live chain
//! binds as its mask plane — is the platform-neutral `mask_registry::
//! parse_model` + `chain_inputs_for_model` plumbing this file exercises
//! directly, the same split `tests_film.rs` uses. The GPU pass itself is
//! parity-gated against the CPU reference in `raw_gpu::local_adjustments::
//! tests_bitmap` and, inside the full chain, in raw-ffi's
//! `gpu_live_bitmap_scope_tests.rs`; this gate is the missing link between
//! those and the web entry, which used to hard-code `mask_rasters:
//! Vec::new()`.

use crate::mask_registry;
use raw_core::types::local_adjustment::flat::KIND_BITMAP;
use raw_core::types::Mask;

/// One `PersonSkin` correction under `digest`, the shape raw-core's own
/// writer emits for `crs:MaskGroupBasedCorrections`.
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

/// Pure-plumbing gate (no GPU): a registered raster reaches the chain inputs
/// as exactly one `GpuMaskRaster` carrying its id and pixels, and the flat
/// layer wire names that id — so the mask pass samples it. Skips when the
/// synthetic DNG fixture is absent (`chain_inputs_for_model` needs a decoded
/// frame for the Auto Profile fit), mirroring `tests_film.rs`.
#[test]
fn chain_inputs_carry_a_registered_bitmap_raster() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let root = manifest
        .ancestors()
        .nth(3)
        .expect("CARGO_MANIFEST_DIR is not three levels below the repo root");
    let path = root.join("src/apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng");
    if !path.exists() {
        eprintln!("chain_inputs_carry_a_registered_bitmap_raster: synthetic DNG fixture absent — skipping");
        return;
    }
    let bytes = std::fs::read(&path).expect("read synthetic DNG");
    let ext = "dng";
    let raw_img = raw_core::decode::decode_bytes(&bytes, ext).expect("decode synthetic DNG");

    // Left-half-white 4x2 raster under a digest unique to this test.
    let digest = "cafe1000000000a1";
    let raster: [u8; 8] = [255, 255, 0, 0, 255, 255, 0, 0];
    let id = mask_registry::register(digest, 4, 2, &raster).expect("register");

    let model = mask_registry::parse_model(Some(&sidecar_with_person_skin(digest))).expect("parse");
    match &model.local_adjustments[0].mask {
        Mask::Bitmap { raster_id, .. } => assert_eq!(*raster_id, id),
        other => panic!("expected Bitmap, got {other:?}"),
    }

    let inputs = super::chain_inputs_for_model(&raw_img, &bytes, ext, &model, None, 0);
    assert_eq!(inputs.mask_rasters.len(), 1, "one distinct raster resolved");
    assert_eq!(inputs.mask_rasters[0].id, id);
    assert_eq!(
        (inputs.mask_rasters[0].width, inputs.mask_rasters[0].height),
        (4, 2)
    );
    assert_eq!(inputs.mask_rasters[0].data.len(), 8);
    assert_eq!(inputs.mask_rasters[0].data[0], 1.0);
    assert_eq!(inputs.mask_rasters[0].data[2], 0.0);
    assert_eq!(inputs.local_adjustments[6], KIND_BITMAP);
    assert_eq!(inputs.local_adjustments[2], id as f32);

    // Released ⇒ the same sidecar no longer resolves, and the chain sees no plane.
    mask_registry::release(id);
    let unresolved =
        mask_registry::parse_model(Some(&sidecar_with_person_skin(digest))).expect("parse");
    let inputs = super::chain_inputs_for_model(&raw_img, &bytes, ext, &unresolved, None, 0);
    assert!(inputs.mask_rasters.is_empty());
    assert_eq!(
        inputs.local_adjustments[2], 0.0,
        "unresolved id stays 0 on the wire"
    );
}
