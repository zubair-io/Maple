#![cfg(all(feature = "pano", target_os = "macos"))]

use std::ffi::{CStr, CString};

use raw_ffi::{
    maple_last_error, maple_pano_stitch_constrained, MaplePanoEdges, MaplePanoFeatureEngine,
    MaplePanoLocalAlign, MaplePanoRetention, MaplePanoStrategy,
};

fn call(json: &str, strategy: MaplePanoStrategy) -> (i32, String) {
    let paths = [
        CString::new("/nonexistent/a.dng").unwrap(),
        CString::new("/nonexistent/b.dng").unwrap(),
    ];
    let pointers = paths.iter().map(|s| s.as_ptr()).collect::<Vec<_>>();
    let dir = tempfile::tempdir().unwrap();
    let output = CString::new(dir.path().join("pano.png").to_str().unwrap()).unwrap();
    let request = CString::new(json).unwrap();
    let code = unsafe {
        maple_pano_stitch_constrained(
            pointers.as_ptr(),
            pointers.len(),
            output.as_ptr(),
            std::ptr::null(),
            0,
            MaplePanoEdges::default(),
            std::ptr::null_mut(),
            MaplePanoRetention::Keep,
            MaplePanoLocalAlign::Off,
            strategy,
            MaplePanoFeatureEngine::Classical,
            request.as_ptr(),
            None,
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    };
    let message = unsafe {
        CStr::from_ptr(maple_last_error())
            .to_string_lossy()
            .into_owned()
    };
    assert!(!dir.path().join("pano.png").exists());
    (code, message)
}

fn request() -> serde_json::Value {
    serde_json::json!({"version":1,"canvas":{"width":100,"height":80},"regions":[
        {"kind":"include","frame":1,"x":10,"y":10,"width":20,"height":20}
    ]})
}

#[test]
fn ffi_refuses_invalid_schema_and_roi_before_decode() {
    for (field, value) in [
        ("width", serde_json::json!(0)),
        ("frame", serde_json::json!(2)),
        ("x", serde_json::json!(-1)),
        ("height", serde_json::json!(u32::MAX)),
    ] {
        let mut bad = request();
        bad["regions"][0][field] = value;
        let (code, message) = call(&bad.to_string(), MaplePanoStrategy::Rotation);
        assert_eq!(code, -11, "{message}");
        assert!(message.contains("invalid_seam_constraints"), "{message}");
    }
    let mut bad = request();
    bad["version"] = serde_json::json!(2);
    assert_eq!(call(&bad.to_string(), MaplePanoStrategy::Rotation).0, -11);
    assert_eq!(call("[]", MaplePanoStrategy::Rotation).0, -11);
    assert_eq!(call(&request().to_string(), MaplePanoStrategy::Tile).0, -11);
}

#[test]
fn valid_ffi_request_is_forwarded_to_the_shared_stitch_pipeline() {
    let (code, message) = call(&request().to_string(), MaplePanoStrategy::Rotation);
    assert_eq!(code, -7, "{message}");
    assert!(!message.contains("invalid_seam_constraints"), "{message}");
    assert!(message.contains("a.dng"), "{message}");
}
