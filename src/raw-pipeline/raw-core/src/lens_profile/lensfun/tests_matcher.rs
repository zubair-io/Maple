use super::bundle::parse;
use super::matcher::*;
use super::test_support::sample_bundle;

#[test]
fn exif_spellings_find_the_bundled_lens_and_refuse_unknowns() {
    let db = parse(&sample_bundle()).unwrap();
    let m = find(&db, "SONY", "ILCE-7RM4", "FE 24-70mm F4 ZA OSS").expect("match");
    assert_eq!(m.lens.model, "FE 24-70mm f/4 ZA OSS");
    assert_eq!(m.mount.name, "Sony E");
    assert_eq!(m.slug, "sony/fe24-70mmf4zaoss@sonye");
    // The camera's English variant is a spelling too.
    assert!(find(&db, "Sony", "Alpha 7R IV", "FE 24-70mm f/4 ZA OSS").is_some());
    assert!(find(&db, "Sony", "ILCE-7RM4", "24-70mm").is_none());
    assert!(find(&db, "Canon", "Canon EOS 5D Mark IV", "FE 24-70mm F4 ZA OSS").is_none());
    assert!(find(&db, "", "", "").is_none());
}

#[test]
fn a_larger_sensor_does_not_use_a_smaller_calibration() {
    let mut db = parse(&sample_bundle()).unwrap();
    db.lenses[0].crop = 1.5; // calibrated on APS-C
    assert!(find(&db, "Sony", "ILCE-7RM4", "FE 24-70mm F4 ZA OSS").is_none());
    db.cameras[0].crop = 1.53; // an APS-C body may use it (ratio 1.02)
    assert!(find(&db, "Sony", "ILCE-7RM4", "FE 24-70mm F4 ZA OSS").is_some());
    db.lenses[0].rectilinear = false;
    assert!(find(&db, "Sony", "ILCE-7RM4", "FE 24-70mm F4 ZA OSS").is_none());
}

#[test]
fn the_calibration_set_closest_to_the_sensor_wins() {
    let mut db = parse(&sample_bundle()).unwrap();
    let mut aps = db.lenses[0].clone();
    aps.crop = 1.534;
    db.lenses.insert(0, aps); // the APS-C set is listed first
    let ff = find(&db, "SONY", "ILCE-7RM4", "FE 24-70mm F4 ZA OSS").unwrap();
    assert_eq!(ff.lens.crop, 1.0);
    db.cameras[0].crop = 1.534;
    let crop = find(&db, "SONY", "ILCE-7RM4", "FE 24-70mm F4 ZA OSS").unwrap();
    assert_eq!(crop.lens.crop, 1.534);
}

#[test]
fn slugs_round_trip_and_compatible_lists_the_mount() {
    let db = parse(&sample_bundle()).unwrap();
    let m = find(&db, "SONY", "ILCE-7RM4", "FE 24-70mm F4 ZA OSS").unwrap();
    let (lens, mount) = by_slug(&db, &m.slug).expect("slug");
    assert!(std::ptr::eq(lens, m.lens) && std::ptr::eq(mount, m.mount));
    assert!(by_slug(&db, "sony/nosuchlens@sonye").is_none());
    assert!(by_slug(&db, "nonsense").is_none());
    let list = compatible(&db, m.camera);
    assert_eq!(list.len(), 1);
    assert!(std::ptr::eq(list[0], m.lens));
}
