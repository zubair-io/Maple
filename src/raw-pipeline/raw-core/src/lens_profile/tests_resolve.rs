use super::{
    model::{Frame, Perspective, Vignette},
    *,
};

fn sample(focal: f64, aperture: f64, focus: f64, k: f64, error: f64) -> LensSample {
    LensSample {
        properties: [
            ("Make", "Example".into()),
            ("Model", "Body".into()),
            ("Lens", "Zoom".into()),
            ("CameraRawProfile", "True".into()),
            ("SensorFormatFactor", "1".into()),
            ("FocalLength", focal.to_string()),
            ("ApertureValue", aperture.to_string()),
            ("FocusDistance", focus.to_string()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v))
        .collect(),
        models: vec![LensModel {
            namespace: CAMERA_NS.into(),
            kind: "PerspectiveModel".into(),
            text: String::new(),
            properties: [
                ("Version", "2".into()),
                ("RadialDistortParam1", k.to_string()),
                ("ResidualMeanError", error.to_string()),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect(),
            children: Vec::new(),
        }],
    }
}

fn query() -> LensQuery<'static> {
    LensQuery {
        make: "Example",
        camera: "Body",
        lens: "Zoom",
        focal_mm: 40.0,
        f_number: Some(4.0),
        focus_m: Some(4.0),
    }
}

fn profile() -> LensProfile {
    LensProfile {
        samples: vec![
            sample(20.0, 4.0, 4.0, 0.1, 0.01),
            sample(80.0, 4.0, 4.0, 0.3, 0.01),
        ],
    }
}

#[test]
fn exact_identity_interpolates_focal_geometric_midpoint() {
    let result = profile().resolve(&query()).unwrap();
    assert!(result.approximations.is_empty());
    assert!((result.calibration.distortion.unwrap().radial[0] - 0.2).abs() < 1e-12);
    assert_eq!(result.distortion_samples.len(), 2);
    assert!((result.distortion_samples[0].weight - 0.5).abs() < 1e-12);
}

#[test]
fn identity_matching_does_not_guess_aliases_or_jpeg_profiles() {
    let mut q = query();
    q.lens = "Zoom II";
    assert!(profile().resolve(&q).is_err());
    q.lens = " zoom ";
    q.camera = "BODY";
    assert!(profile().resolve(&q).is_ok());
    let mut p = profile();
    for s in &mut p.samples {
        s.properties
            .insert("CameraRawProfile".into(), "False".into());
    }
    assert!(p.resolve(&q).is_err());
}

#[test]
fn duplicate_calibrations_choose_best_fit_independently_of_order() {
    let mut p = LensProfile {
        samples: vec![
            sample(40.0, 4.0, 4.0, 0.1, 0.2),
            sample(40.0, 4.0, 4.0, 0.2, 0.1),
            sample(40.0, 4.0, 4.0, 0.3, 0.1),
        ],
    };
    let before = p.resolve(&query()).unwrap().calibration;
    p.samples.reverse();
    assert_eq!(before, p.resolve(&query()).unwrap().calibration);
    assert_eq!(before.distortion.unwrap().radial[0], 0.2);
}

#[test]
fn sparse_or_missing_focus_and_focal_extrapolation_are_explicit() {
    let mut q = query();
    q.focal_mm = 120.0;
    let result = profile().resolve(&q).unwrap();
    assert!(result.approximations[0].contains("outside calibrated range"));
    assert_eq!(result.calibration.distortion.unwrap().radial[0], 0.3);
    let p = LensProfile {
        samples: vec![
            sample(40.0, 4.0, 1.0, 0.1, 0.01),
            sample(40.0, 4.0, 10.0, 0.3, 0.01),
        ],
    };
    q.focal_mm = 40.0;
    q.focus_m = None;
    assert!(p.resolve(&q).unwrap().approximations[0].contains("missing"));
}

#[test]
fn aperture_uses_apex_and_separate_vignette_sample_grid() {
    let mut p = LensProfile {
        samples: vec![
            sample(40.0, 2.0, 4.0, 0.0, 0.01),
            sample(40.0, 6.0, 4.0, 0.0, 0.01),
        ],
    };
    for (s, k) in p.samples.iter_mut().zip([-0.1, -0.3]) {
        s.models[0].children.push(LensModel {
            namespace: CAMERA_NS.into(),
            kind: "VignetteModel".into(),
            text: String::new(),
            properties: [("VignetteModelParam1".into(), k.to_string())].into(),
            children: Vec::new(),
        });
    }
    let resolved = p.resolve(&query()).unwrap(); // f/4 = APEX4
    assert!(resolved.approximations.is_empty());
    assert!((resolved.calibration.vignette.unwrap().radial[0] + 0.2).abs() < 1e-12);
    assert_eq!(resolved.vignette_samples.len(), 2);
}

#[test]
fn unknown_terms_and_nonfinite_coefficients_never_reach_pixels() {
    for (field, value) in [
        ("RadialDistortParam4", "0.1"),
        ("RadialDistortParam1", "NaN"),
        ("Version", "3"),
    ] {
        let mut p = LensProfile {
            samples: vec![sample(40.0, 4.0, 4.0, 0.1, 0.01)],
        };
        p.samples[0].models[0]
            .properties
            .insert(field.into(), value.into());
        assert!(p.resolve(&query()).is_err(), "accepted {field}");
    }
    let mut p = profile();
    for s in &mut p.samples {
        s.models[0].kind = "Version2PerspectiveModel".into();
    }
    assert!(p
        .resolve(&query())
        .unwrap_err()
        .contains("legacy PerspectiveModel"));
}

#[test]
fn old_rdf_description_model_encoding_has_identical_resolution() {
    let mut p = profile();
    let before = p.resolve(&query()).unwrap().calibration;
    for s in &mut p.samples {
        let mut old = s.models[0].clone();
        old.namespace = "http://www.w3.org/1999/02/22-rdf-syntax-ns#".into();
        old.kind = "Description".into();
        s.models[0].properties.clear();
        s.models[0].children.push(old);
    }
    assert_eq!(before, p.resolve(&query()).unwrap().calibration);
}

#[test]
fn distortion_uses_dmax_and_each_axis_focal_length_without_radius_clamp() {
    let model = Perspective {
        frame: Frame {
            focal: [0.5, 1.0],
            center: [0.5, 0.5],
        },
        radial: [0.1, 0.0, 0.0],
        tangential: [0.0, 0.0],
        scale: 1.0,
    };
    // Dmax100: point offset(50,25) -> normalized(1,.25), r²1.0625.
    let output = model.map(100.0, 50.0, [100.0, 50.0]);
    assert!((output[0] - 105.3125).abs() < 1e-12);
    assert!((output[1] - 52.65625).abs() < 1e-12);
    let scaled = model.map(200.0, 100.0, [200.0, 100.0]);
    assert_eq!(scaled, [2.0 * output[0], 2.0 * output[1]]);
}

#[test]
fn vignette_is_reciprocal_illumination_and_rejects_nonpositive_lobes() {
    let mut model = Vignette {
        frame: Frame {
            focal: [0.5, 0.5],
            center: [0.5, 0.5],
        },
        radial: [-0.5, 0.0, 0.0],
    };
    assert_eq!(model.gain(100.0, 100.0, [50.0, 50.0]), Some(1.0));
    assert_eq!(model.gain(100.0, 100.0, [100.0, 50.0]), Some(2.0));
    model.radial[0] = -1.0;
    assert_eq!(model.gain(100.0, 100.0, [100.0, 50.0]), None);
}

#[test]
fn one_calibration_does_not_make_unknown_capture_distance_confident() {
    let mut q = query();
    q.focus_m = None;
    assert!(profile()
        .resolve(&q)
        .unwrap()
        .approximations
        .iter()
        .any(|reason| reason.contains("missing")));
}

#[test]
fn duplicated_models_and_negative_fit_error_fail_explicitly() {
    let mut p = profile();
    for sample in &mut p.samples {
        sample.models.push(sample.models[0].clone());
    }
    assert!(p.resolve(&query()).is_err());
    p = profile();
    for sample in &mut p.samples {
        sample.models[0]
            .properties
            .insert("ResidualMeanError".into(), "-1".into());
    }
    assert!(p.resolve(&query()).is_err());
}

#[test]
fn tangential_only_calibration_is_not_silently_ignored() {
    let mut p = profile();
    for sample in &mut p.samples {
        sample.models[0].properties.remove("RadialDistortParam1");
        sample.models[0]
            .properties
            .insert("TangentialDistortParam1".into(), "0.1".into());
    }
    assert_eq!(
        p.resolve(&query())
            .unwrap()
            .calibration
            .distortion
            .unwrap()
            .tangential,
        [0.1, 0.0]
    );
}

#[test]
fn chromatic_mapping_uses_green_frame_then_relative_channel_frame() {
    let green = Frame {
        focal: [1.0, 1.0],
        center: [0.5, 0.5],
    };
    let relative = |scale| Perspective {
        frame: green,
        radial: [0.0; 3],
        tangential: [0.0; 2],
        scale,
    };
    let ca = model::Chromatic {
        reference: green,
        relative: [relative(1.02), relative(0.98)],
    };
    let point = [75.0, 40.0];
    assert_eq!(ca.map(100.0, 80.0, point, 1), point);
    assert_eq!(ca.map(100.0, 80.0, point, 0), [75.5, 40.0]);
    assert_eq!(ca.map(100.0, 80.0, point, 2), [74.5, 40.0]);
}
