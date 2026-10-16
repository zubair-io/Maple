//! Physical selected-white HSM coverage through the public C ABI (#4633).
use crate::buffers::{maple_free_scene_linear_buffer, MapleSceneLinearBuffer};
use crate::scene_linear::{
    maple_render_bytes_scene_linear_sized, maple_render_file_scene_linear_sized,
};
use raw_core::{pipeline::RenderQuality, xmp};
use std::ffi::CString;

#[test]
#[ignore = "requires physical HSM RAWs; explicit invocation fails if absent"]
fn selected_hsm_physical_file_and_bytes_ffi_match_core() {
    for name in ["test_0006.DNG", "test_0007.DNG"] {
        let path = raw_core::test_support::fixtures::require_raw(name);
        let bytes = std::fs::read(&path).unwrap();
        let raw = raw_core::decode::decode_bytes(&bytes, "dng").unwrap();
        let profile = raw_core::color::dcp::profile_for(&raw).unwrap();
        assert!(profile.hsm_endpoints.is_some(), "{name}: dual HSM required");
        let temp = tempfile::tempdir().unwrap();
        let xmp_path = temp.path().join("selected-white.xmp");
        let c_path = CString::new(path.to_str().unwrap()).unwrap();
        let c_xmp = CString::new(xmp_path.to_str().unwrap()).unwrap();
        let ext = CString::new("dng").unwrap();
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
            std::fs::write(&xmp_path, &sidecar).unwrap();
            // Use the parsed, real sidecar as both bindings' model contract.
            let parsed = xmp::parse(&sidecar).unwrap();
            assert_eq!(parsed.temperature, temperature);
            assert_eq!(parsed.tint, tint);
            for (quality, flag) in [(RenderQuality::Preview, 1), (RenderQuality::Amaze, 2)] {
                let (width, height, expected) =
                    raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality(
                        &raw, &parsed, quality, 128,
                    )
                    .unwrap();
                for from_bytes in [false, true] {
                    let mut buffer = MapleSceneLinearBuffer {
                        fp16_rgba: std::ptr::null_mut(),
                        len_bytes: 0,
                        channels: 0,
                        bytes_per_pixel: 0,
                        width: 0,
                        height: 0,
                    };
                    let result = unsafe {
                        if from_bytes {
                            maple_render_bytes_scene_linear_sized(
                                bytes.as_ptr(),
                                bytes.len(),
                                ext.as_ptr(),
                                c_xmp.as_ptr(),
                                128,
                                flag,
                                &mut buffer,
                            )
                        } else {
                            maple_render_file_scene_linear_sized(
                                c_path.as_ptr(),
                                c_xmp.as_ptr(),
                                128,
                                flag,
                                &mut buffer,
                            )
                        }
                    };
                    assert_eq!(
                        result, 0,
                        "{name} {temperature}/{tint} {quality:?} bytes={from_bytes}"
                    );
                    assert_eq!((buffer.width, buffer.height), (width, height));
                    assert_eq!(buffer.len_bytes, expected.len() * 2);
                    let actual = unsafe {
                        std::slice::from_raw_parts(buffer.fp16_rgba, expected.len()).to_vec()
                    };
                    unsafe { maple_free_scene_linear_buffer(&mut buffer) };
                    assert_eq!(
                        actual, expected,
                        "{name} {temperature}/{tint} {quality:?} bytes={from_bytes}"
                    );
                }
            }
            assert_eq!(std::fs::read_to_string(&xmp_path).unwrap(), sidecar);
        }
        assert_eq!(std::fs::read(&path).unwrap(), bytes, "original changed");
    }
}
