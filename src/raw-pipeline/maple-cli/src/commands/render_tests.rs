use super::*;

/// `default_film_lut_dir()` must resolve to the committed
/// `resources/film-luts` pack at the repo root, regardless of the
/// process's cwd when `maple-cli` is invoked (#2683 Task 5b).
#[test]
fn default_film_lut_dir_resolves_to_committed_pack() {
    let dir = default_film_lut_dir();
    assert!(
        dir.is_dir(),
        "expected {} to exist (committed resources/film-luts pack)",
        dir.display()
    );
    assert!(
        dir.join("slide_fuji_velvia_50.mlut").is_file(),
        "expected slide_fuji_velvia_50.mlut under {}",
        dir.display()
    );
}

/// `model.film_look == ""` (the default, no look selected) must never
/// attempt to read a `.mlut` file — `resolve_film_lut` short-circuits
/// to `None` regardless of the directory it's pointed at.
#[test]
fn resolve_film_lut_is_none_when_film_look_is_empty() {
    let model = xmp::AdjustmentModel::default();
    assert_eq!(model.film_look, "");
    let dir = default_film_lut_dir();
    assert!(resolve_film_lut(&model, &dir).is_none());
}

/// A `film_look` id with no matching `.mlut` in the directory (typo,
/// disabled catalog entry, wrong `--film-lut-dir`) must warn and
/// return `None` rather than error — the missing-asset -> identity
/// rule callers rely on.
#[test]
fn resolve_film_lut_is_none_for_missing_file() {
    let model = xmp::AdjustmentModel {
        film_look: "not_a_real_film_look_id".to_string(),
        ..xmp::AdjustmentModel::default()
    };
    let dir = default_film_lut_dir();
    assert!(resolve_film_lut(&model, &dir).is_none());
}

/// A `film_look` id pointed at a directory that exists but doesn't
/// contain the file at all (e.g. an empty temp dir) is the same
/// missing-file path, not a distinct I/O error.
#[test]
fn resolve_film_lut_is_none_when_lut_dir_is_empty() {
    let tmp = std::env::temp_dir().join(format!(
        "maple-cli-render-test-empty-lut-dir-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&tmp).expect("create temp dir");
    let model = xmp::AdjustmentModel {
        film_look: "slide_fuji_velvia_50".to_string(),
        ..xmp::AdjustmentModel::default()
    };
    assert!(resolve_film_lut(&model, &tmp).is_none());
    let _ = std::fs::remove_dir_all(&tmp);
}

/// A `film_look` id with a real, committed `.mlut` decodes
/// successfully to a 33³ lattice — the success path `resolve_film_lut`
/// hands to `render_from_raw_with_quality_source_and_film`.
#[test]
fn resolve_film_lut_decodes_a_real_committed_look() {
    let model = xmp::AdjustmentModel {
        film_look: "slide_fuji_velvia_50".to_string(),
        ..xmp::AdjustmentModel::default()
    };
    let dir = default_film_lut_dir();
    let lut = resolve_film_lut(&model, &dir).expect("velvia_50 should decode");
    assert_eq!(lut.size, 33);
    assert_eq!(lut.data.len(), 33 * 33 * 33 * 3);
}

/// End-to-end smoke (#2683 Task 5b Step 5): a temp XMP carrying
/// `papp:FilmLook="slide_fuji_velvia_50"`, rendered through the same
/// `run()` entry the CLI dispatches to, must move the pixels versus
/// the no-look render of the identical input. Fully synthetic (a
/// 24-patch color chart via `test-support`, not a fixture RAW), so it
/// runs unconditionally whenever `--features test-support` is on
/// rather than skip-passing on absent fixtures.
#[cfg(feature = "test-support")]
#[test]
fn film_look_render_differs_from_no_look_render() {
    use raw_core::test_support::synth_chart::SyntheticColorChart;

    let tmp = std::env::temp_dir().join(format!(
        "maple-cli-render-test-film-smoke-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&tmp).expect("create temp dir");

    let dng_path = tmp.join("chart.dng");
    SyntheticColorChart::default()
        .write_to(&dng_path)
        .expect("write synthetic chart DNG");

    let no_look_xmp = tmp.join("no_look.xmp");
    std::fs::write(
        &no_look_xmp,
        r#"<?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="maple:papp/1.0/"/></rdf:RDF></x:xmpmeta>"#,
    )
    .expect("write no-look xmp");

    let film_xmp = tmp.join("film.xmp");
    std::fs::write(
        &film_xmp,
        r#"<?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="maple:papp/1.0/" papp:FilmLook="slide_fuji_velvia_50"/></rdf:RDF></x:xmpmeta>"#,
    )
    .expect("write film xmp");

    let no_look_model = xmp::parse(&std::fs::read_to_string(&no_look_xmp).unwrap()).unwrap();
    assert_eq!(no_look_model.film_look, "");
    let film_model = xmp::parse(&std::fs::read_to_string(&film_xmp).unwrap()).unwrap();
    assert_eq!(film_model.film_look, "slide_fuji_velvia_50");

    let out_no_look = tmp.join("no_look.png");
    let out_film = tmp.join("film.png");
    run(
        &dng_path,
        Some(&no_look_xmp),
        &out_no_look,
        Some(OutputFormat::Png),
        92,
        DemosaicChoice::Full,
        ProfileChoice::Neutral,
        None, // exercise the default --film-lut-dir resolution
        PrimariesChoice::Srgb,
        &render_lens::LensProfileArgs::default(),
    )
    .expect("no-look render should succeed");
    run(
        &dng_path,
        Some(&film_xmp),
        &out_film,
        Some(OutputFormat::Png),
        92,
        DemosaicChoice::Full,
        ProfileChoice::Neutral,
        None,
        PrimariesChoice::Srgb,
        &render_lens::LensProfileArgs::default(),
    )
    .expect("film-look render should succeed");

    let (no_look_rgb, w1, h1) = decode_png_rgb8_for_test(&out_no_look);
    let (film_rgb, w2, h2) = decode_png_rgb8_for_test(&out_film);
    assert_eq!((w1, h1), (w2, h2), "both renders must be the same size");
    let pixel_delta: i64 = no_look_rgb
        .iter()
        .zip(film_rgb.iter())
        .map(|(a, b)| (*a as i64 - *b as i64).abs())
        .sum();
    assert!(
        pixel_delta > 0,
        "film-look render must move at least one pixel versus the no-look render \
         of the same input; summed |delta| = {pixel_delta}"
    );
    eprintln!("[film smoke] {w1}x{h1}, summed |pixel delta| across all channels = {pixel_delta}");

    let _ = std::fs::remove_dir_all(&tmp);
}

/// #1339 (P3 phase 3): `--target-primaries p3` must actually reach the
/// render — a saturated synthetic chart rendered at P3 must move
/// pixels versus the identical render at the sRGB default, proving
/// `render_path_with_primaries` really threads `TargetPrimaries::P3`
/// down to `rec2020_to_display` (#1337) rather than silently staying
/// on the sRGB entry. Fully synthetic, no fixture RAW needed.
#[cfg(feature = "test-support")]
#[test]
fn target_primaries_p3_render_differs_from_srgb_default() {
    use raw_core::test_support::synth_chart::SyntheticColorChart;

    let tmp = std::env::temp_dir().join(format!(
        "maple-cli-render-test-p3-smoke-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&tmp).expect("create temp dir");

    let dng_path = tmp.join("chart.dng");
    SyntheticColorChart::default()
        .write_to(&dng_path)
        .expect("write synthetic chart DNG");

    let out_srgb = tmp.join("srgb.png");
    let out_p3 = tmp.join("p3.png");
    run(
        &dng_path,
        None,
        &out_srgb,
        Some(OutputFormat::Png),
        92,
        DemosaicChoice::Full,
        ProfileChoice::Neutral,
        None,
        PrimariesChoice::Srgb,
        &render_lens::LensProfileArgs::default(),
    )
    .expect("sRGB render should succeed");
    run(
        &dng_path,
        None,
        &out_p3,
        Some(OutputFormat::Png),
        92,
        DemosaicChoice::Full,
        ProfileChoice::Neutral,
        None,
        PrimariesChoice::P3,
        &render_lens::LensProfileArgs::default(),
    )
    .expect("P3 render should succeed");

    let (srgb_rgb, w1, h1) = decode_png_rgb8_for_test(&out_srgb);
    let (p3_rgb, w2, h2) = decode_png_rgb8_for_test(&out_p3);
    assert_eq!((w1, h1), (w2, h2), "both renders must be the same size");
    let pixel_delta: i64 = srgb_rgb
        .iter()
        .zip(p3_rgb.iter())
        .map(|(a, b)| (*a as i64 - *b as i64).abs())
        .sum();
    assert!(
        pixel_delta > 0,
        "--target-primaries p3 must move at least one pixel versus the \
         sRGB default on a saturated synthetic chart; summed |delta| = {pixel_delta}"
    );
    eprintln!("[P3 smoke] {w1}x{h1}, summed |pixel delta| across all channels = {pixel_delta}");

    let _ = std::fs::remove_dir_all(&tmp);
}

/// The sRGB default must stay byte-for-byte identical to `render_path`
/// (not merely "close") when `--target-primaries` isn't passed — the
/// parity-harness invariant `run`'s own doc comment promises. Renders
/// through the public `run` entry (which dispatches on `PrimariesChoice
/// ::Srgb` + `DemosaicChoice::Full`) and compares against calling
/// `render_path` directly.
#[cfg(feature = "test-support")]
#[test]
fn srgb_default_is_byte_identical_to_render_path_directly() {
    use raw_core::test_support::synth_chart::SyntheticColorChart;

    let tmp = std::env::temp_dir().join(format!(
        "maple-cli-render-test-srgb-identity-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&tmp).expect("create temp dir");
    let dng_path = tmp.join("chart.dng");
    SyntheticColorChart::default()
        .write_to(&dng_path)
        .expect("write synthetic chart DNG");

    let out = tmp.join("out.png");
    run(
        &dng_path,
        None,
        &out,
        Some(OutputFormat::Png),
        92,
        DemosaicChoice::Full,
        ProfileChoice::Neutral,
        None,
        PrimariesChoice::Srgb,
        &render_lens::LensProfileArgs::default(),
    )
    .expect("sRGB render via run() should succeed");
    let (via_run, w1, h1) = decode_png_rgb8_for_test(&out);

    let model = xmp::AdjustmentModel {
        profile: raw_core::types::adjustment::Profile::Neutral,
        ..xmp::AdjustmentModel::default()
    };
    let (w2, h2, direct_bytes) =
        render_path(&dng_path, &model, None).expect("render_path directly");
    assert_eq!((w1, h1), (w2, h2));
    assert_eq!(
        via_run, direct_bytes,
        "PNG round-trip must not perturb bytes"
    );

    let _ = std::fs::remove_dir_all(&tmp);
}

#[cfg(feature = "test-support")]
fn decode_png_rgb8_for_test(path: &Path) -> (Vec<u8>, u32, u32) {
    let f = std::fs::File::open(path).expect("open png");
    let dec = png::Decoder::new(f);
    let mut reader = dec.read_info().expect("png header");
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).expect("png decode");
    assert_eq!(info.bit_depth, png::BitDepth::Eight);
    let rgb = match info.color_type {
        png::ColorType::Rgb => buf[..info.buffer_size()].to_vec(),
        png::ColorType::Rgba => {
            let pixels = (info.width * info.height) as usize;
            let src = &buf[..info.buffer_size()];
            let mut out = Vec::with_capacity(pixels * 3);
            for px in 0..pixels {
                out.push(src[px * 4]);
                out.push(src[px * 4 + 1]);
                out.push(src[px * 4 + 2]);
            }
            out
        }
        other => panic!("unsupported PNG color type {other:?}"),
    };
    (rgb, info.width, info.height)
}
