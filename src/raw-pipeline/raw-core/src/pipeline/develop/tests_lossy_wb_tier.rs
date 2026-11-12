//! #5081 review: an 8-bit lossy LinearRaw DNG decodes through its declared
//! transfer but keeps its white balance on the post-DCP CAT16 tier
//! (`RawImage::keeps_post_dcp_white_balance`), so a sidecar edited before
//! #5081 keeps its meaning: the edited render is the as-shot render times
//! exactly the CAT16 matrix the pre-#5081 chain applied for the stored pair
//! (`white_balance::apply` of `resolve_wb`). Adopting the camera-space frame
//! for these files needs a `WbScaleVersion` stamp and a converter (#5924).

use crate::{
    cancel::CancelToken,
    decode::decode_bytes,
    image::{CfaPattern, ColorSpace, Image, RawImage},
    pipeline::{render_capture_from_raw_f32, CreativeStage, RenderQuality},
    stages::white_balance,
    test_support::{
        gain_map::{opcode_list, polynomial_entry},
        synth_dng::SyntheticGreyDng,
    },
    view::acr_fit::model::ciede2000,
    xmp::{self, AdjustmentModel},
};

const RED_BLUE: [f64; 4] = [0., 0.0625, 0., 0.9375];
const GREEN: [f64; 4] = [0.01, 0.0625, 0., 0.9275];

/// Sidecars a Maple editor wrote for a lossy DNG before #5081.
const EDITED: [(&str, &str); 2] = [
    (
        "V5 manual 5000/+10",
        r#"crs:WhiteBalance="Custom" crs:Temperature="5000" crs:Tint="+10" papp:WbScaleVersion="5" papp:WbSource="Manual""#,
    ),
    (
        "V5 preset Tungsten 2850/0",
        r#"crs:WhiteBalance="Tungsten" crs:Temperature="2850" crs:Tint="0" papp:WbScaleVersion="5" papp:WbSource="Preset""#,
    ),
];

fn sidecar(attributes: &str) -> AdjustmentModel {
    xmp::parse(&format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/" {attributes}/></rdf:RDF></x:xmpmeta>"#
    ))
    .expect("sidecar parses")
}

/// A DNG-Converter-shaped LinearRaw: the synthetic camera's calibration, a
/// declared per-plane transfer and a varied scene, at `white_level`.
fn linear_raw(white_level: u32) -> RawImage {
    let declared = [
        polynomial_entry([0, 0, 64, 64], 0, 1, &RED_BLUE),
        polynomial_entry([0, 0, 64, 64], 1, 1, &GREEN),
        polynomial_entry([0, 0, 64, 64], 2, 1, &RED_BLUE),
    ];
    let mut raw = decode_bytes(
        &SyntheticGreyDng {
            opcode_list2: Some(opcode_list(&declared)),
            ..Default::default()
        }
        .with_hasselblad_dcp()
        .write_to_bytes(),
        "dng",
    )
    .expect("decode the synthetic DNG");
    raw.cfa = CfaPattern::LinearRgb;
    raw.black_level = [0; 4];
    raw.white_level = white_level;
    // Near-neutral surfaces of varied level and mild chroma: camera RGB is
    // a level times the as-shot neutral, nudged per channel by up to ±10 %.
    let neutral = raw.as_shot_neutral;
    let samples = raw.width as usize * raw.height as usize * 3;
    raw.raw_data = (0..samples)
        .map(|i| {
            let (pixel, channel) = (i / 3, i % 3);
            let level = (30 + (pixel * 37) % 200) as f32 / 255.;
            let nudge = 0.9 + 0.2 * ((pixel * 13 + channel * 5) % 7) as f32 / 6.;
            let value = (level * neutral[channel] * nudge).min(1.) * white_level as f32;
            value.round() as u16
        })
        .collect();
    raw
}

/// The develop's creative stage and the capture it renders, decoded at the
/// as-shot sidecar; `frame` is whether the stage has a camera-space frame.
fn creative(raw: &RawImage) -> (CreativeStage, Image, bool) {
    let render = render_capture_from_raw_f32(
        raw,
        &sidecar(""),
        RenderQuality::Preview,
        CancelToken::default(),
    )
    .expect("capture decode");
    let mut capture = Image::new(render.width, render.height, ColorSpace::SceneLinearRec2020);
    for (pixel, rgba) in capture.pixels.iter_mut().zip(render.rgba.chunks_exact(4)) {
        *pixel = [rgba[0], rgba[1], rgba[2]];
    }
    let stage = render
        .creative
        .stage(render.tables.floats())
        .expect("stage");
    (stage, capture, render.creative.frame.is_some())
}

/// Rec.2020 linear → CIE Lab (D65), on a scale that puts the frame's mean
/// luminance at 0.18.
fn lab(rgb: [f32; 3], scale: f32) -> [f32; 3] {
    let [r, g, b] = rgb.map(|v| (v * scale).max(0.0));
    let xyz = [
        0.636_958 * r + 0.144_617 * g + 0.168_881 * b,
        0.262_700 * r + 0.677_998 * g + 0.059_302 * b,
        0.028_073 * g + 1.060_985 * b,
    ];
    let white = [0.950_47, 1.0, 1.088_83];
    let f = |t: f32| {
        if t > 216.0 / 24389.0 {
            t.cbrt()
        } else {
            (24389.0 / 27.0 * t + 16.0) / 116.0
        }
    };
    let [fx, fy, fz] = std::array::from_fn(|c| f(xyz[c] / white[c]));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

/// Mean CIEDE2000 between the render of `model` and the as-shot render with
/// the pre-#5081 post-DCP CAT16 white balance applied for the same pair.
fn delta_from_cat16_meaning(raw: &RawImage, model: &AdjustmentModel) -> f32 {
    let (stage, capture, _) = creative(raw);
    let render = |model: &AdjustmentModel| {
        stage
            .render_basis(capture.clone(), model)
            .expect("creative render")
            .0
    };
    let mut want = render(&sidecar(""));
    let n = want.pixels.len() as f32;
    let luminance = want
        .pixels
        .iter()
        .map(|p| 0.2627 * p[0] + 0.678 * p[1] + 0.0593 * p[2]);
    let scale = 0.18 / (luminance.sum::<f32>() / n).max(1e-6);
    let (temperature, tint) = white_balance::resolve_wb(model);
    white_balance::apply(&mut want, temperature, tint, model.wb_method);
    render(model)
        .pixels
        .iter()
        .zip(&want.pixels)
        .map(|(a, b)| ciede2000(lab(*a, scale), lab(*b, scale)))
        .sum::<f32>()
        / n
}

#[test]
fn an_edited_sidecar_on_a_lossy_dng_keeps_its_cat16_meaning() {
    let raw = linear_raw(255);
    assert!(raw.keeps_post_dcp_white_balance());
    assert!(!creative(&raw).2, "no camera-space frame");
    assert!(raw.skipped_required_opcodes().is_empty(), "transfers run");
    for (label, attributes) in EDITED {
        let delta = delta_from_cat16_meaning(&raw, &sidecar(attributes));
        assert!(
            delta < 0.05,
            "{label}: mean dE2000 {delta} from the CAT16 meaning"
        );
    }
}

/// The gate is not vacuous: the same pairs on a high-bit-depth LinearRaw (the
/// camera-space frame) land far from the CAT16 meaning.
#[test]
fn the_camera_space_frame_reads_the_same_pairs_differently() {
    let raw = linear_raw(4095);
    assert!(!raw.keeps_post_dcp_white_balance());
    assert!(creative(&raw).2, "the camera-space frame");
    for (label, attributes) in EDITED {
        let delta = delta_from_cat16_meaning(&raw, &sidecar(attributes));
        assert!(delta > 1.0, "{label}: mean dE2000 only {delta}");
    }
}

/// The same on the physical lossy DNG (needs `test-fixtures/raws`).
#[test]
#[ignore = "physical RAW: provision test-fixtures/raws/test_0006.DNG"]
fn an_edited_sidecar_on_test_0006_keeps_its_cat16_meaning() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0006.DNG");
    let raw = crate::decode::decode(&path).expect("decode test_0006.DNG");
    assert!(raw.keeps_post_dcp_white_balance());
    assert!(!creative(&raw).2, "no camera-space frame");
    for (label, attributes) in EDITED {
        let delta = delta_from_cat16_meaning(&raw, &sidecar(attributes));
        assert!(
            delta < 0.05,
            "{label}: mean dE2000 {delta} from the CAT16 meaning"
        );
    }
}
