use super::*;

#[test]
fn raster_android_binding_matches_cpu_export() {
    let path =
        std::env::temp_dir().join(format!("maple-android-parity-{}.png", std::process::id()));
    image::RgbImage::from_fn(64, 48, |x, y| {
        image::Rgb([(x * 4) as u8, (y * 5) as u8, 110])
    })
    .save(&path)
    .unwrap();
    check_raster_parity(&path);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn staged_float_raster_android_binding_matches_cpu_export() {
    let path = std::env::temp_dir().join(format!(
        "maple-android-float-parity-{}.tiff",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    let pixels: Vec<u8> = (0..64 * 48)
        .flat_map(|i| [1.2 + (i % 64) as f32 / 128.0, -0.1, 0.3005, 1.0])
        .flat_map(|v| half::f16::from_f32(v).to_bits().to_ne_bytes())
        .collect();
    crate::platform_raster::stage(
        &pixels,
        64,
        48,
        64 * 8,
        9,
        &crate::platform_raster::test_profile(moxcms::ColorProfile::new_srgb(), true),
        &path,
    )
    .unwrap();
    check_raster_parity(&path);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn photo_switch_retains_worker_context_and_replaces_live_image() {
    let directory = std::env::temp_dir().join(format!("maple-worker-gpu-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let first = directory.join("first.png");
    let second = directory.join("second.png");
    image::RgbImage::from_pixel(64, 48, image::Rgb([80, 120, 200]))
        .save(&first)
        .unwrap();
    image::RgbImage::from_pixel(32, 24, image::Rgb([200, 80, 120]))
        .save(&second)
        .unwrap();
    let xml = "<rdf:Description xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"/>";
    let first_session = Session::open(first.to_str().unwrap(), xml, 2048).unwrap();
    let context = Rc::clone(&first_session.ctx);
    first_session
        .live
        .render_to_buffer(&context, &first_session.inputs, &CancelToken::new())
        .unwrap()
        .unwrap();
    drop(first_session);
    let second_session =
        Session::open_with_context(Rc::clone(&context), second.to_str().unwrap(), xml, 2048)
            .unwrap();
    assert!(
        Rc::ptr_eq(&context, &second_session.ctx),
        "photo changes must retain the device and its caches"
    );
    assert_eq!(second_session.live.dims(), (32, 24));
    // The warm device must still render this different image against the CPU reference.
    check_session_raster_parity(second_session);
    std::fs::remove_dir_all(directory).unwrap();
}

fn check_raster_parity(path: &std::path::Path) {
    let xml = "<rdf:Description xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"/>";
    check_session_raster_parity(Session::open(path.to_str().unwrap(), xml, 2048).unwrap());
}

fn check_session_raster_parity(mut session: Session) {
    for exposure in [0.0, 1.25, -1.5] {
        let field = raw_core::types::ADJUSTMENT_SCHEMA
            .iter()
            .position(|f| f.name == "exposure")
            .unwrap();
        crate::fields::set(&mut session.model, field, exposure).unwrap();
        session.update().unwrap();
        let gpu = session
            .live
            .render_to_buffer(&session.ctx, &session.inputs, &CancelToken::new())
            .unwrap()
            .unwrap();
        let (w, h, cpu) = raw_core::pipeline::render_export_raster(
            &session.bytes,
            &session.model,
            None,
            if session.target_primaries == 1 {
                raw_core::view::encode::TargetPrimaries::P3
            } else {
                raw_core::view::encode::TargetPrimaries::Srgb
            },
            raw_core::pipeline::ExportDepth::Eight,
            None,
        )
        .unwrap();
        let raw_core::pipeline::ExportPixels::Eight(cpu) = cpu else {
            panic!("eight-bit export");
        };
        assert_eq!(session.live.dims(), (w, h));
        let worst = gpu
            .iter()
            .zip(&cpu)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap();
        assert!(
            worst <= 2,
            "Raster CPU/GPU byte difference {worst}, exposure {exposure}"
        );
    }
}

#[test]
fn p3_android_target_matches_cpu_export() {
    let path = std::env::temp_dir().join(format!("maple-android-p3-{}.tiff", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let pixels: Vec<u8> = (0..64 * 48)
        .flat_map(|i| [(i % 64) as f32 / 63.0, (i / 64) as f32 / 47.0, 0.05, 1.0])
        .flat_map(|value| half::f16::from_f32(value).to_bits().to_ne_bytes())
        .collect();
    crate::platform_raster::stage(
        &pixels,
        64,
        48,
        64 * 8,
        9,
        &crate::platform_raster::test_profile(moxcms::ColorProfile::new_display_p3(), true),
        &path,
    )
    .unwrap();
    let mut session = Session::open(
        path.to_str().unwrap(),
        "<rdf:Description xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"/>",
        2048,
    )
    .unwrap();
    session.target_primaries = 1;
    check_session_raster_parity(session);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn raw_android_binding_matches_cpu_reference_and_reuses_pool() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/batch-transfer/source.dng");
    let xml = "<rdf:Description xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"/>";
    let mut session = Session::open(path.to_str().unwrap(), xml, 2048).unwrap();
    for exposure in [0.0, 1.25, -0.75] {
        let field = raw_core::types::ADJUSTMENT_SCHEMA
            .iter()
            .position(|f| f.name == "exposure")
            .unwrap();
        crate::fields::set(&mut session.model, field, exposure).unwrap();
        session.update().unwrap();
        let gpu = session
            .live
            .render_to_buffer(&session.ctx, &session.inputs, &CancelToken::new())
            .unwrap()
            .unwrap();
        let raw = session.raw.as_ref().unwrap();
        let (w, h, cpu) = raw_core::pipeline::render_from_raw_with_quality_and_source(
            raw,
            &session.model,
            raw_core::pipeline::RenderQuality::Amaze,
            Some(raw_core::pipeline::RawInput::Bytes {
                bytes: &session.bytes,
                ext: &session.ext,
            }),
        )
        .unwrap();
        assert_eq!(session.live.dims(), (w, h));
        assert_eq!(gpu.len(), cpu.len());
        let worst = gpu
            .iter()
            .zip(&cpu)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap();
        assert!(
            worst <= 2,
            "CPU/GPU maximum byte difference {worst}, exposure {exposure}"
        );
    }
    let allocations = session.live.pool_alloc_count(&session.ctx);
    session.update().unwrap();
    assert_eq!(allocations, session.live.pool_alloc_count(&session.ctx));
}

/// The XML the Android writer emits for both point-curve families reaches the
/// GPU live chain through `maple_android_model`, changes the photo, and stays
/// within the CPU reference's byte budget.
#[test]
fn authored_point_curves_render_on_the_gpu_like_the_cpu_reference() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/batch-transfer/source.dng");
    let identity = "<rdf:Description xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"/>";
    let curves = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/" papp:ToneCurveMode="RatioPreserving">
    <papp:SceneLinearToneCurveRed>
      <rdf:Seq>
        <rdf:li>0, 0</rdf:li>
        <rdf:li>63.75, 90</rdf:li>
        <rdf:li>255, 255</rdf:li>
      </rdf:Seq>
    </papp:SceneLinearToneCurveRed>
    <crs:ToneCurvePV2012>
      <rdf:Seq>
        <rdf:li>0, 0</rdf:li>
        <rdf:li>128, 160</rdf:li>
        <rdf:li>255, 255</rdf:li>
      </rdf:Seq>
    </crs:ToneCurvePV2012>
  </rdf:Description>
</rdf:RDF></x:xmpmeta>"#;
    let mut session = Session::open(path.to_str().unwrap(), identity, 2048).unwrap();
    let render = |session: &mut Session| {
        session.update().unwrap();
        session
            .live
            .render_to_buffer(&session.ctx, &session.inputs, &CancelToken::new())
            .unwrap()
            .unwrap()
    };
    let plain = render(&mut session);
    let raw_xml = std::ffi::CString::new(curves).unwrap();
    let handle = (&mut session as *mut Session).cast::<std::ffi::c_void>();
    assert_eq!(
        unsafe { crate::maple_android_model(handle, raw_xml.as_ptr()) },
        0
    );
    assert_eq!(session.model.display_tone_curve_luma.points.len(), 3);
    let curved = render(&mut session);
    let raw = session.raw.as_ref().unwrap();
    let (_, _, cpu) = raw_core::pipeline::render_from_raw_with_quality_and_source(
        raw,
        &session.model,
        raw_core::pipeline::RenderQuality::Amaze,
        Some(raw_core::pipeline::RawInput::Bytes {
            bytes: &session.bytes,
            ext: &session.ext,
        }),
    )
    .unwrap();
    let worst = curved
        .iter()
        .zip(&cpu)
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap();
    assert!(worst <= 2, "Curve CPU/GPU maximum byte difference {worst}");
    let changed = plain
        .iter()
        .zip(&curved)
        .filter(|(a, b)| a.abs_diff(**b) > 4)
        .count();
    assert!(
        changed > plain.len() / 4,
        "Curves changed only {changed} bytes"
    );
}

#[test]
fn generated_scalar_access_validates_ranges_and_marks_manual_wb() {
    let mut model = AdjustmentModel::default();
    for (index, field) in raw_core::types::ADJUSTMENT_SCHEMA.iter().enumerate() {
        if field.kind != raw_core::types::FieldKind::F32 {
            continue;
        }
        crate::fields::set(&mut model, index, field.default_f32).unwrap();
        assert_eq!(crate::fields::get(&model, index), Some(field.default_f32));
        assert!(crate::fields::set(&mut model, index, f32::NAN).is_err());
        let mut raster = AdjustmentModel::default();
        let allowed = [field.range.0, field.range.1].into_iter().all(|value| {
            crate::fields::set(&mut raster, index, value).unwrap();
            raw_core::pipeline::validate_raster_adjustments(&raster).is_ok()
        });
        assert_eq!(
            crate::fields::raster_allowed(index),
            allowed,
            "Raster availability: {}",
            field.name
        );
    }
    assert!(model.temperature_seen && model.tint_seen);
    assert_eq!(model.wb_source, raw_core::types::WbSource::Manual);
}

const IMPORTED_AUTO_XMP: &str = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/" crs:WhiteBalance="Auto" papp:Profile="Neutral" /></rdf:RDF></x:xmpmeta>"#;

fn imported_auto_fixture() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/batch-transfer/source.dng")
}

/// The `_imported_wb` value the Kotlin renderer reads through the values FFI.
fn imported_wb_flag(session: &mut Session) -> f64 {
    unsafe {
        let json = crate::maple_android_values((session as *mut Session).cast());
        let text = std::ffi::CStr::from_ptr(json).to_str().unwrap().to_owned();
        crate::maple_android_free_string(json);
        serde_json::from_str::<serde_json::Value>(&text).unwrap()["_imported_wb"]
            .as_f64()
            .unwrap()
    }
}

#[test]
fn imported_auto_white_balance_renders_as_shot_until_the_background_estimate_is_adopted() {
    let path = imported_auto_fixture();
    let raw = raw_core::decode::decode(&path).unwrap();
    let expected =
        raw_core::stages::imported_auto_wb::estimate(&raw, raw_core::CancelToken::never()).unwrap();
    let xml = IMPORTED_AUTO_XMP;
    let mut session = Session::open(path.to_str().unwrap(), xml, 64).unwrap();
    // The first frame renders As Shot: nothing was estimated on open.
    assert!(!session.model.unresolved_auto_wb);
    assert!(!session.model.temperature_seen && !session.model.tint_seen);
    assert_eq!(imported_wb_flag(&mut session), 0.0);
    let mut work = session.prepare_imported_auto_white_balance().unwrap();
    // One estimate per session: a surface recreated before it lands starts none.
    assert!(session.prepare_imported_auto_white_balance().is_none());
    work.run(&CancelToken::new()).unwrap();
    session.adopt_imported_auto_white_balance(&work);
    assert_eq!((session.model.temperature, session.model.tint), expected);
    // The host's WB values are display-only now, so it never pushes them back.
    assert_eq!(imported_wb_flag(&mut session), 1.0);
    assert!(session.prepare_imported_auto_white_balance().is_none());
    // Later models reuse the adopted pair without analysis.
    let mut edited = crate::xmp::parse(xml).unwrap();
    edited.exposure = 1.0;
    session.set_model(edited);
    assert_eq!((session.model.temperature, session.model.tint), expected);
    assert_eq!(session.model.exposure, 1.0);
    assert_eq!(imported_wb_flag(&mut session), 1.0);
    // A numeric WB edit is authored and never replaced.
    let authored = crate::xmp::parse(&xml.replace(
        r#"crs:WhiteBalance="Auto""#,
        r#"crs:WhiteBalance="Auto" crs:Temperature="5300" crs:Tint="17""#,
    ))
    .unwrap();
    session.set_model(authored);
    assert_eq!(
        (session.model.temperature, session.model.tint),
        (5300., 17.)
    );
    assert_eq!(imported_wb_flag(&mut session), 0.0);
}

#[test]
fn a_cancelled_imported_auto_estimate_unwinds_and_releases_its_raw() {
    let path = imported_auto_fixture();
    let mut session = Session::open(path.to_str().unwrap(), IMPORTED_AUTO_XMP, 64).unwrap();
    let mut work = session.prepare_imported_auto_white_balance().unwrap();
    let raw = session.raw.clone().unwrap();
    let cancel = CancelToken::new();
    // Navigation or close flips the renderer's flag while the estimate runs.
    cancel.cancel();
    assert!(work.run(&cancel).is_err());
    assert!(work.estimate.pair().is_none());
    // Freeing the cancelled work drops its RAW reference with it.
    let held = Arc::strong_count(&raw);
    drop(work);
    assert_eq!(Arc::strong_count(&raw), held - 1);
    drop(session);
}
