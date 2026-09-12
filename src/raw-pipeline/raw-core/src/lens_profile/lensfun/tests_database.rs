//! The real bundle: counts, coverage and every sample through the evaluator.

use super::*;

#[test]
fn bundle_parses_and_counts_match_coverage() {
    let db = database();
    assert_eq!(db.version.commit, "12f5976");
    assert_eq!(db.version.date, "2026-09-11");
    let coverage = include_str!("COVERAGE.md");
    assert!(
        coverage.contains(&format!("Lenses: {}", db.lenses.len())),
        "{}",
        db.lenses.len()
    );
    assert!(
        coverage.contains(&format!("Cameras: {}", db.cameras.len())),
        "{}",
        db.cameras.len()
    );
    assert!(
        coverage.contains(&format!("Mounts: {}", db.mounts.len())),
        "{}",
        db.mounts.len()
    );
    assert!(db.lenses.len() > 1500 && db.cameras.len() > 1000 && db.mounts.len() > 100);
}

#[test]
fn every_bundled_sample_is_finite_through_the_evaluator() {
    let db = database();
    let (mut vignetting_total, mut uncovered) = (0usize, 0usize);
    for lens in &db.lenses {
        // The calibration's own aspect: a corner outside the calibrated
        // frame is not a defect of the sample.
        let (w, h) = (6000.0, (6000.0 / lens.aspect).round());
        for s in &lens.distortion {
            let p = distortion(s, lens.crop, w, h);
            for point in [[w / 2.0, h / 2.0], [0.0, 0.0], [w - 1.0, h - 1.0]] {
                let [x, y] = p.map(w, h, point);
                assert!(
                    x.is_finite() && y.is_finite(),
                    "{} {} @{}",
                    lens.maker,
                    lens.model,
                    s.focal
                );
            }
        }
        for s in &lens.tca {
            let c = chromatic(s, lens.crop, w, h);
            for channel in [0, 2] {
                let [x, y] = c.map(w, h, [0.0, 0.0], channel);
                assert!(
                    x.is_finite() && y.is_finite(),
                    "{} {} tca @{}",
                    lens.maker,
                    lens.model,
                    s.focal
                );
            }
        }
        for s in &lens.vignetting {
            let v = vignette(s, lens.crop, w, h);
            let [x, y] = v.frame.coordinates(w, h, [0.0, 0.0]);
            assert!(x.is_finite() && y.is_finite());
            vignetting_total += 1;
            if v.gain(w, h, [0.0, 0.0]).is_none() {
                uncovered += 1;
            }
        }
    }
    // A few compact-camera polynomials cross zero before the corner of
    // their own frame; the resolver drops such a sample per shot. They must
    // stay rare, or the conversion is wrong rather than the data.
    assert!(
        uncovered * 200 < vignetting_total,
        "{uncovered} of {vignetting_total} vignetting samples do not cover their corners"
    );
}

#[test]
fn fixture_identities_resolve_or_are_refused() {
    let db = database();
    let sony = find(db, "SONY", "ILCE-7RM4", "FE 24-70mm F4 ZA OSS").expect("sony");
    assert_eq!(sony.lens.model, "FE 24-70mm f/4 ZA OSS");
    assert_eq!(sony.lens.crop, 1.0);
    assert_eq!(sony.slug, "sony/fe24-70mmf4zaoss@sonye");
    assert!(!sony.lens.distortion.is_empty() && !sony.lens.tca.is_empty());
    assert!(find(
        db,
        "Canon",
        "Canon EOS 5D Mark III",
        "EF70-200mm f/2.8L IS II USM"
    )
    .is_some());
    assert!(find(db, "Canon", "Canon EOS 5DS R", "EF50mm f/1.2L USM").is_some());
    assert!(find(db, "FUJIFILM", "X-T3", "XF35mmF2 R WR").is_some());
    assert!(find(db, "NIKON CORPORATION", "NIKON D850", "").is_none());
    // Ambiguous EXIF, unknown body, unknown lens: no guess.
    assert!(find(db, "Canon", "Canon EOS 5D Mark IV", "24-70mm").is_none());
    assert!(find(
        db,
        "Apple",
        "iPhone 12 Pro",
        "iPhone 12 Pro back triple camera 4.2mm f/1.6"
    )
    .is_none());
    // Leica writes the lens name the way Lensfun spells it: a real match.
    let leica = find(
        db,
        "Leica Camera AG",
        "LEICA M10",
        "Summicron-M 1:2/35 ASPH.",
    )
    .expect("leica");
    assert!(
        leica.lens.model.contains("Summicron"),
        "{}",
        leica.lens.model
    );
}

#[test]
fn a_full_frame_body_does_not_use_an_aps_c_calibration() {
    let db = database();
    let aps = db
        .lenses
        .iter()
        .find(|l| l.model == "Sony AF DT 16-105mm f/3.5-5.6")
        .expect("dt lens");
    assert!(aps.crop > 1.4);
    assert!(find(db, "Sony", "ILCE-7RM4", "DT 16-105mm F3.5-5.6").is_none());
}

#[test]
fn slugs_round_trip_and_compatible_lists_the_mount() {
    let db = database();
    let m = find(db, "SONY", "ILCE-7RM4", "FE 24-70mm F4 ZA OSS").unwrap();
    let (lens, _) = by_slug(db, &m.slug, m.camera.crop).unwrap();
    assert!(std::ptr::eq(lens, m.lens));
    let list = compatible(db, m.camera);
    assert!(list.iter().any(|l| std::ptr::eq(*l, m.lens)));
    assert!(list.len() > 50, "{}", list.len());
    assert!(list
        .windows(2)
        .all(|w| (&w[0].maker, &w[0].model) <= (&w[1].maker, &w[1].model)));
}
