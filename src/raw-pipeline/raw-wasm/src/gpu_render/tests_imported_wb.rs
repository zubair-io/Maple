//! #4669: the one-shot GPU entry resolves name-only imported Auto WB to the
//! pair the CPU develop resolves internally, rendering exactly as the same
//! pair authored numerically does.

#[test]
fn imported_auto_white_balance_gpu_equals_the_authored_pair() {
    if !super::tests::gpu_available() {
        eprintln!("imported Auto WB GPU parity: no GPU adapter — skipping (soft pass)");
        return;
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/batch-transfer/source.dng");
    let bytes = std::fs::read(path).unwrap();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").unwrap();
    let imported = crate::mask_registry::parse_model(Some(
        r#"<x crs:WhiteBalance="Auto" papp:Profile="Neutral"/>"#,
    ))
    .unwrap();
    let resolved = raw_core::stages::imported_auto_wb::resolve(
        &raw,
        &imported,
        raw_core::CancelToken::never(),
    )
    .unwrap();
    let (temperature, tint) = (resolved.temperature, resolved.tint);
    let authored_xmp = format!(
        r#"<x crs:WhiteBalance="Custom" crs:Temperature="{temperature}" crs:Tint="{tint}" papp:WbScaleVersion="5" papp:Profile="Neutral"/>"#
    );
    let authored = crate::mask_registry::parse_model(Some(&authored_xmp)).unwrap();
    let gpu = |model: &raw_core::xmp::AdjustmentModel| {
        pollster::block_on(super::render_gpu_core(&raw, &bytes, "dng", model, None))
            .expect("GPU core render failed")
    };
    let cpu = |model: &raw_core::xmp::AdjustmentModel| {
        super::tests::cpu_reference(&raw, &bytes, "dng", model)
    };
    let as_shot = cpu(&raw_core::xmp::AdjustmentModel {
        profile: raw_core::xmp::Profile::Neutral,
        ..Default::default()
    });
    assert_ne!(
        cpu(&imported),
        as_shot,
        "fixture must distinguish Auto from As Shot"
    );
    assert_eq!(cpu(&imported), cpu(&authored));
    assert_eq!(gpu(&resolved), gpu(&authored));
    let (gw, gh, gpu_pixels) = gpu(&resolved);
    let (cw, ch, cpu_pixels) = cpu(&imported);
    assert_eq!((cw, ch), (gw, gh));
    let max_delta = cpu_pixels
        .iter()
        .zip(&gpu_pixels)
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap_or(0);
    assert!(max_delta <= 2, "GPU vs CPU max byte delta {max_delta}");
}
