#![cfg(all(feature = "pano", target_os = "macos"))]

use std::ffi::{CStr, CString};

use raw_ffi::{
    maple_last_error, maple_pano_preview_constrained, maple_pano_stitch_constrained,
    MaplePanoEdges, MaplePanoFeatureEngine, MaplePanoLocalAlign, MaplePanoPreviewSizes,
    MaplePanoRetention, MaplePanoStrategy,
};

fn call(json: &str, strategy: MaplePanoStrategy, preview: bool) -> (i32, String) {
    let paths = [
        CString::new("/nonexistent/a.dng").unwrap(),
        CString::new("/nonexistent/b.dng").unwrap(),
    ];
    let pointers = paths.iter().map(|s| s.as_ptr()).collect::<Vec<_>>();
    let dir = tempfile::tempdir().unwrap();
    let output = CString::new(dir.path().join("pano.png").to_str().unwrap()).unwrap();
    let request = CString::new(json).unwrap();
    let code = unsafe {
        if preview {
            maple_pano_preview_constrained(
                pointers.as_ptr(),
                pointers.len(),
                output.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                MaplePanoEdges::default(),
                std::ptr::null_mut(),
                MaplePanoRetention::Keep,
                MaplePanoLocalAlign::Off,
                strategy,
                MaplePanoFeatureEngine::Classical,
                request.as_ptr(),
                0,
                std::ptr::null(),
                None,
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        } else {
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
                0,
                None,
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        }
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
    for preview in [false, true] {
        for (field, value) in [
            ("width", serde_json::json!(0)),
            ("frame", serde_json::json!(2)),
            ("x", serde_json::json!(-1)),
            ("height", serde_json::json!(u32::MAX)),
        ] {
            let mut bad = request();
            bad["regions"][0][field] = value;
            let (code, message) = call(&bad.to_string(), MaplePanoStrategy::Rotation, preview);
            assert_eq!(code, -11, "{message}");
            assert!(message.contains("invalid_seam_constraints"), "{message}");
        }
        let mut bad = request();
        bad["version"] = serde_json::json!(2);
        for (json, strategy) in [
            (bad.to_string(), MaplePanoStrategy::Rotation),
            ("[]".into(), MaplePanoStrategy::Rotation),
            ("{".into(), MaplePanoStrategy::Rotation),
            (request().to_string(), MaplePanoStrategy::Tile),
        ] {
            let (code, message) = call(&json, strategy, preview);
            assert_eq!(code, -11, "{message}");
            assert!(message.contains("invalid_seam_constraints"), "{message}");
        }
    }
}

#[test]
fn valid_ffi_request_is_forwarded_to_the_shared_stitch_pipeline() {
    let (code, message) = call(&request().to_string(), MaplePanoStrategy::Rotation, false);
    assert_eq!(code, -7, "{message}");
    assert!(!message.contains("invalid_seam_constraints"), "{message}");
    assert!(message.contains("a.dng"), "{message}");
}

#[test]
fn valid_preview_request_reaches_proxy_decode() {
    let (code, message) = call(&request().to_string(), MaplePanoStrategy::Rotation, true);
    assert_eq!(code, -7, "{message}");
    assert!(!message.contains("invalid_seam_constraints"), "{message}");
    assert!(message.contains("a.dng"), "{message}");
}

/// Fixture-free native regression: supply a known identity solve for two
/// synthetic RAWs, rather than requiring features in a flat grey scene.
/// A full-stitch substitution reports stage 3 at 0 before refinement; the
/// proxy pipeline reports only completion. Excluding both owners must fail,
/// so merely accepting the JSON while dropping intent also fails this gate.
#[test]
fn constrained_preview_skips_full_refinement_and_honors_pins() {
    use maple_pano::graph::{MatchGraph, VerifiedEdge};
    use maple_pano::ingest::ingest_file_proxy;
    use maple_pano::math::Mat3;
    use maple_pano::stitch::{
        AlignedFrame, AlignmentKey, FeatureEngine, FocalSeedSource, SolvedAlignment, StitchOptions,
    };
    use maple_pano::strategy::{select_strategy, StrategyRequest};
    use maple_pano::twoview::PixelCorrespondence;

    let dir = tempfile::tempdir().unwrap();
    let paths: Vec<_> = (0..2)
        .map(|i| {
            let path = dir.path().join(format!("frame{i}.dng"));
            raw_core::test_support::synth_dng::SyntheticGreyDng {
                width: 96,
                height: 80,
                ..Default::default()
            }
            .write_to(&path)
            .unwrap();
            path
        })
        .collect();
    let opts = StitchOptions {
        strategy: StrategyRequest::Rotation,
        feature_engine: FeatureEngine::Classical,
        ..Default::default()
    };
    let frames: Vec<_> = paths
        .iter()
        .map(|p| {
            let meta = ingest_file_proxy(p, opts.proxy_long_edge).unwrap();
            AlignedFrame {
                full_dims: (meta.full_width, meta.full_height),
                proxy_dims: (meta.proxy.width(), meta.proxy.height()),
                proxy_scale: (meta.proxy_scale_x, meta.proxy_scale_y),
                focal_full_px: 100.0,
                priors: meta.priors,
                applied_opcodes: meta.applied_opcodes,
            }
        })
        .collect();
    let matches: Vec<_> = (0..6)
        .flat_map(|y| {
            (0..8).map(move |x| {
                let p = (10.0 + x as f64 * 8.0, 10.0 + y as f64 * 8.0);
                PixelCorrespondence { a: p, b: p }
            })
        })
        .collect();
    let graph = MatchGraph {
        image_count: 2,
        edges: vec![VerifiedEdge {
            a: 0,
            b: 1,
            rotation: Mat3::identity(),
            inlier_count: matches.len(),
            mean_residual_rad: 0.0,
            inlier_matches: matches,
        }],
        rejected: vec![],
        components: vec![vec![0, 1]],
        orphans: vec![],
    };
    let priors: Vec<_> = frames.iter().map(|f| f.priors.clone()).collect();
    let alignment = SolvedAlignment {
        key: AlignmentKey::for_run(&paths, &opts).unwrap(),
        strategy_report: select_strategy(StrategyRequest::Rotation, &graph, &priors, 100.0, 0),
        frames,
        focal_seed_source: FocalSeedSource::Exif,
        graph,
        tile_graph: None,
        lenses: maple_pano::gain::LensGroups {
            labels: vec![],
            of_frame: vec![None, None],
        },
    };
    let alignment_path = dir.path().join("alignment.json");
    std::fs::write(&alignment_path, alignment.to_json()).unwrap();
    let cpaths: Vec<_> = paths
        .iter()
        .map(|p| CString::new(p.to_str().unwrap()).unwrap())
        .collect();
    let pointers: Vec<_> = cpaths.iter().map(|p| p.as_ptr()).collect();
    let alignment_in = CString::new(alignment_path.to_str().unwrap()).unwrap();
    let alignment_out_path = dir.path().join("reused.json");
    let alignment_out = CString::new(alignment_out_path.to_str().unwrap()).unwrap();
    let output_path = dir.path().join("preview.png");
    let output = CString::new(output_path.to_str().unwrap()).unwrap();
    unsafe extern "C" fn progress(stage: u32, fraction: f32, user: *mut std::ffi::c_void) {
        if stage == 3 {
            (&*user.cast::<std::sync::Mutex<Vec<f32>>>())
                .lock()
                .unwrap()
                .push(fraction);
        }
    }
    for impossible in [false, true] {
        let regions = if impossible {
            serde_json::json!([
                {"kind":"exclude","frame":0,"x":0,"y":0,"width":100,"height":100},
                {"kind":"exclude","frame":1,"x":0,"y":0,"width":100,"height":100}
            ])
        } else {
            serde_json::json!([
                {"kind":"include","frame":1,"x":45,"y":45,"width":10,"height":10}
            ])
        };
        let request = CString::new(
            serde_json::json!({
                "version":1,"canvas":{"width":100,"height":100},"regions":regions
            })
            .to_string(),
        )
        .unwrap();
        let stages = std::sync::Mutex::new(Vec::<f32>::new());
        let mut sizes = MaplePanoPreviewSizes::default();
        let code = unsafe {
            maple_pano_preview_constrained(
                pointers.as_ptr(),
                pointers.len(),
                output.as_ptr(),
                alignment_in.as_ptr(),
                alignment_out.as_ptr(),
                &mut sizes,
                MaplePanoEdges::default(),
                std::ptr::null_mut(),
                MaplePanoRetention::Keep,
                MaplePanoLocalAlign::Off,
                MaplePanoStrategy::Rotation,
                MaplePanoFeatureEngine::Classical,
                request.as_ptr(),
                0,
                std::ptr::null(),
                Some(progress),
                (&stages as *const std::sync::Mutex<Vec<f32>>)
                    .cast_mut()
                    .cast(),
                std::ptr::null(),
            )
        };
        let message = unsafe {
            let error = maple_last_error();
            if error.is_null() {
                String::new()
            } else {
                CStr::from_ptr(error).to_string_lossy().into_owned()
            }
        };
        assert_eq!(
            *stages.lock().unwrap(),
            vec![1.0],
            "full-resolution refinement must not run"
        );
        if impossible {
            assert_eq!(code, -11, "{message}");
            assert!(message.contains("invalid_seam_constraints"), "{message}");
        } else {
            assert_eq!(code, 0, "{message}");
            assert!(
                alignment_out_path.exists(),
                "proxy alignment must be handed back"
            );
            let image = image::open(&output_path).unwrap();
            assert!(image.width().max(image.height()) <= maple_pano::stitch::PREVIEW_LONG_EDGE_PX);
            assert!(sizes.largest_frame_px > 0);
            std::fs::remove_file(&output_path).unwrap();
        }
    }
    assert!(
        !output_path.exists(),
        "unsatisfiable pins must not publish a preview"
    );
}
