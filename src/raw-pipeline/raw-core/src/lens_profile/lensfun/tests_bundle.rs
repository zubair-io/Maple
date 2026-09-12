use super::bundle::*;
use super::test_support::sample_bundle;

#[test]
fn parses_every_field_of_the_layout() {
    let db = parse(&sample_bundle()).unwrap();
    assert_eq!(db.version.commit, "12f5976");
    assert_eq!(db.version.date, "2026-09-11");
    assert_eq!(db.mounts[0].name, "Sony E");
    assert_eq!(db.mounts[0].compat, ["M42"]);
    let cam = &db.cameras[0];
    assert_eq!(
        (cam.maker.as_str(), cam.model.as_str()),
        ("Sony", "ILCE-7RM4")
    );
    assert_eq!(cam.variants, ["Alpha 7R IV"]);
    assert_eq!((cam.mount, cam.crop), (0, 1.0));
    let lens = &db.lenses[0];
    assert_eq!(lens.model, "FE 24-70mm f/4 ZA OSS");
    assert!(lens.rectilinear && lens.mounts == [0]);
    assert_eq!((lens.crop, lens.aspect), (1.0, 1.5));
    let d = lens.distortion[0];
    assert_eq!((d.focal, d.real_focal), (24.0, f64::from(23.9f32)));
    assert_eq!(d.terms.scale, f64::from(0.97f32));
    assert_eq!(d.terms.odd, [f64::from(0.005f32), f64::from(-0.01f32)]);
    assert_eq!(lens.tca[0].blue.scale, f64::from(0.9998f32));
    assert_eq!(lens.vignetting.len(), 2);
    assert_eq!(lens.vignetting[1].aperture, f64::from(5.6f32));
}

#[test]
fn truncation_bad_magic_and_trailing_bytes_are_errors() {
    let bytes = sample_bundle();
    assert!(parse(&bytes[..bytes.len() - 3])
        .unwrap_err()
        .contains("truncated"));
    let mut bad = bytes.clone();
    bad[0] = b'X';
    assert!(parse(&bad).unwrap_err().contains("magic"));
    let mut long = bytes.clone();
    long.push(0);
    assert!(parse(&long).unwrap_err().contains("trailing"));
    let mut version = bytes;
    version[4] = 9;
    assert!(parse(&version).unwrap_err().contains("version 9"));
}
