//! Physical selected-white HSM coverage of the Web CPU entry (#4633).
use raw_core::{pipeline::RenderQuality, xmp};

#[test]
#[ignore = "requires physical HSM RAWs; explicit invocation fails if absent"]
fn selected_hsm_physical_web_cpu_binding_matches_core() {
    for name in ["test_0006.DNG", "test_0007.DNG"] {
        let path = raw_core::test_support::fixtures::require_raw(name);
        let bytes = std::fs::read(&path).unwrap();
        let raw = raw_core::decode::decode_bytes(&bytes, "dng").unwrap();
        let profile = raw_core::color::dcp::profile_for(&raw).unwrap();
        assert!(profile.hsm_endpoints.is_some(), "{name}: dual HSM required");
        for (temperature, tint) in [(2000.0, 0.0), (8500.0, 150.0)] {
            let sidecar = format!(
                r#"<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   xmlns:papp="http://ns.justmaple.app/1.0/" crs:WhiteBalance="Custom"
   crs:Temperature="{temperature}" crs:Tint="{tint}"
   crs:Sharpness="0" crs:ColorNoiseReduction="0"
   papp:Profile="Neutral" papp:AutoExposure="Off" papp:WbScaleVersion="5" />
 </rdf:RDF>
</x:xmpmeta>"#
            );
            let parsed = xmp::parse(&sidecar).unwrap();
            assert_eq!(parsed.temperature, temperature);
            assert_eq!(parsed.tint, tint);
            for (quality, preview) in [
                (RenderQuality::Preview, true),
                (RenderQuality::Amaze, false),
            ] {
                let (width, height, expected) =
                    raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality(
                        &raw, &parsed, quality, 128,
                    )
                    .unwrap();
                let mut actual = crate::render_bytes_scene_linear_sized(
                    &bytes,
                    "dng",
                    Some(sidecar.clone()),
                    preview,
                    128,
                )
                .unwrap();
                assert_eq!((actual.width(), actual.height()), (width, height));
                assert_eq!(
                    actual.take_fp16_rgba(),
                    expected,
                    "{name} {temperature}/{tint} {quality:?}"
                );
            }
        }
        assert_eq!(std::fs::read(&path).unwrap(), bytes, "original changed");
    }
}
