use maple_linux::{export::export, library::MediaKind};
use raw_core::types::adjustment::AdjustmentModel;
use std::path::PathBuf;

#[test]
fn real_raw_exports_and_existing_files_are_protected() {
    let directory = tempfile::tempdir().unwrap();
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng");
    let original = std::fs::read(&source).unwrap();
    for (extension, magic) in [
        ("jpg", &[0xff, 0xd8][..]),
        ("png", &[137, 80, 78, 71][..]),
        ("tiff", &[73, 73, 42, 0][..]),
    ] {
        let output = directory.path().join(format!("export.{extension}"));
        export(
            &source,
            MediaKind::Raw,
            &AdjustmentModel::default(),
            &output,
        )
        .unwrap();
        let bytes = std::fs::read(&output).unwrap();
        assert!(bytes.starts_with(magic));
        assert!(export(
            &source,
            MediaKind::Raw,
            &AdjustmentModel::default(),
            &output
        )
        .is_err());
        assert_eq!(std::fs::read(output).unwrap(), bytes);
    }
    assert!(export(
        &source,
        MediaKind::Raw,
        &AdjustmentModel::default(),
        &source
    )
    .is_err());
    assert_eq!(std::fs::read(source).unwrap(), original);
}

#[test]
fn dangling_symlink_destination_is_not_followed() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("missing.jpg");
    let output = directory.path().join("output.jpg");
    std::os::unix::fs::symlink(&target, &output).unwrap();
    assert!(export(
        &directory.path().join("nonexistent.dng"),
        MediaKind::Raw,
        &AdjustmentModel::default(),
        &output
    )
    .is_err());
    assert!(!target.exists());
}

#[test]
fn raster_export_applies_adjustments_and_preserves_source_pixels() {
    let directory = tempfile::tempdir().unwrap();
    let original = directory.path().join("source.jpg");
    let raster = raw_core::raster::RasterImage::new_rgb(8, 8, vec![96; 8 * 8 * 3]);
    let source =
        raw_core::export::encode_raster(&raster, raw_core::export::ExportFormat::Jpeg, 100)
            .unwrap();
    std::fs::write(&original, &source).unwrap();
    let model = AdjustmentModel {
        exposure: 1.0,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        ..Default::default()
    };
    let output = directory.path().join("edited.png");
    export(&original, MediaKind::Raster, &model, &output).unwrap();
    let bytes = std::fs::read(output).unwrap();
    let decoded = raw_core::raster::decode_raster(&bytes, Some("png")).unwrap();
    assert_eq!((decoded.width, decoded.height), (8, 8));
    assert!(decoded.to_rgb_bytes().iter().all(|&value| value > 96));
    assert_eq!(std::fs::read(original).unwrap(), source);
}

#[test]
fn raster_film_export_matches_loaded_core_and_unknown_look_renders_without_film() {
    let directory = tempfile::tempdir().unwrap();
    let original = directory.path().join("source.png");
    let source = raw_core::png::encode(8, 6, &[96; 8 * 6 * 3]).unwrap();
    std::fs::write(&original, &source).unwrap();
    let model = AdjustmentModel {
        film_look: raw_core::film_catalog::FILM_CATALOG[0].id.to_owned(),
        film_strength: 100.0,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        ..Default::default()
    };
    let output = directory.path().join("film.png");
    export(&original, MediaKind::Raster, &model, &output).unwrap();
    let film = maple_linux::film::resolve(&model.film_look)
        .unwrap()
        .unwrap();
    let (w, h, expected) = raw_core::pipeline::render_export_raster(
        &source,
        &model,
        None,
        raw_core::view::encode::TargetPrimaries::Srgb,
        raw_core::pipeline::ExportDepth::Eight,
        Some(film.lut),
    )
    .unwrap();
    let raw_core::pipeline::ExportPixels::Eight(rgb) = expected else {
        panic!("wrong output depth")
    };
    let expected = raw_core::export::encode_raster(
        &raw_core::raster::RasterImage::new_rgb(w, h, rgb),
        raw_core::export::ExportFormat::Png,
        95,
    )
    .unwrap();
    assert_eq!(std::fs::read(output).unwrap(), expected);
    let unknown = directory.path().join("unknown.png");
    let plain = directory.path().join("plain.png");
    let newer_catalog = AdjustmentModel {
        film_look: "../../missing".into(),
        ..model.clone()
    };
    export(&original, MediaKind::Raster, &newer_catalog, &unknown).unwrap();
    let without_film = AdjustmentModel {
        film_look: String::new(),
        ..model
    };
    export(&original, MediaKind::Raster, &without_film, &plain).unwrap();
    assert_eq!(
        std::fs::read(unknown).unwrap(),
        std::fs::read(plain).unwrap()
    );
    assert_eq!(std::fs::read(original).unwrap(), source);
}
