use super::resume::VIEW_TAIL_FIELDS;
use super::*;
use crate::test_support::synth_chart::{ChartEncoding, SyntheticColorChart};
use crate::types::{adjustment::Profile, ToneCurve};

type Edit = fn(AdjustmentModel) -> AdjustmentModel;

macro_rules! edits {
    ($($field:ident: $value:expr),* $(,)?) => {
        [$((stringify!($field), (|model| AdjustmentModel { $field: $value, ..model }) as Edit)),*]
    };
}

const LATE_EDITS: [(&str, Edit); 27] = edits! {
    contrast: 35.,
    whites: 40.,
    display_tone_curve_luma: s_curve(),
    display_tone_curve_red: s_curve(),
    display_tone_curve_green: s_curve(),
    display_tone_curve_blue: s_curve(),
    split_tone_shadow_hue: 210.,
    split_tone_shadow_saturation: 45.,
    split_tone_highlight_hue: 40.,
    split_tone_highlight_saturation: 55.,
    split_tone_balance: -35.,
    color_grade_shadow_luminance: 25.,
    color_grade_midtone_hue: 120.,
    color_grade_midtone_saturation: 50.,
    color_grade_midtone_luminance: -20.,
    color_grade_highlight_luminance: 30.,
    color_grade_global_hue: 300.,
    color_grade_global_saturation: 35.,
    color_grade_global_luminance: 15.,
    color_grade_blending: 40.,
    color_grade_shadow_edge: 0.3,
    color_grade_highlight_edge: 0.8,
    film_look: "another-look".into(),
    film_strength: 60.,
    grain_amount: 45.,
    grain_size: 70.,
    grain_roughness: 20.,
};

const UPSTREAM_EDITS: [(&str, Edit); 8] = edits! {
    exposure: 0.7,
    temperature: 4200.,
    clarity: 55.,
    sharpen_radius: 2.,
    vignette_amount: -30.,
    tone_curve_luma: s_curve(),
    profile: Profile::Auto,
    perspective_vertical: 20.,
};

fn s_curve() -> ToneCurve {
    ToneCurve::new(vec![(0., 0.), (0.3, 0.22), (0.7, 0.8), (1., 1.)])
}

fn graded(model: AdjustmentModel) -> AdjustmentModel {
    AdjustmentModel {
        split_tone_shadow_saturation: 30.,
        split_tone_highlight_saturation: 30.,
        color_grade_midtone_saturation: 30.,
        color_grade_global_saturation: 20.,
        grain_amount: 30.,
        ..model
    }
}

pub(super) fn engaged(profile: Profile) -> AdjustmentModel {
    AdjustmentModel {
        profile,
        sharpen_amount: 90.,
        nr_luminance: 45.,
        nr_color: 60.,
        clarity: 30.,
        texture: 25.,
        dehaze: 20.,
        ..Default::default()
    }
}

pub(super) fn chart(patch_size: u32) -> Vec<u8> {
    SyntheticColorChart {
        patch_size,
        guard: 4,
        encoding: ChartEncoding::Camera,
        ..Default::default()
    }
    .write_to_bytes()
}

fn tinted_film() -> FilmLut {
    let identity = crate::view::auto_profile::lut::ColorLut::identity(3).data;
    FilmLut {
        size: 3,
        data: identity
            .chunks_exact(3)
            .flat_map(|rgb| [rgb[0], rgb[1] * 0.87, rgb[2]])
            .collect(),
    }
}

pub(super) fn fresh(
    raw: &RawImage,
    source: RawInput<'_>,
    model: &AdjustmentModel,
    cap: u32,
    film: Option<&FilmLut>,
) -> PreviewFrame {
    super::super::render_from_raw_with_auto_fit(
        raw,
        model,
        RenderQuality::Preview,
        Some(source),
        Some(cap),
        film,
    )
    .unwrap()
}

pub(super) fn drive(
    resident: &mut CpuPreview,
    raw: &RawImage,
    source: RawInput<'_>,
    models: impl IntoIterator<Item = AdjustmentModel>,
    cap: u32,
    film: Option<&FilmLut>,
) {
    let mut streak = 0;
    for (step, model) in models.into_iter().enumerate() {
        let developed = resident.source.matches(raw, source)
            && develop_key(model.clone()) == resident.key
            && cap == resident.cap;
        let late = developed && detail_amounts(&model) == detail_amounts(&resident.context.model);
        streak = if late { streak + 1 } else { 0 };
        let prefix = resident.prefix.pixels.as_ptr();
        let kept = resident.detailed.kept().map(|scene| scene.pixels.as_ptr());
        let actual = resident
            .render(
                raw,
                source,
                model.clone(),
                RenderQuality::Preview,
                cap,
                film,
                CancelToken::never(),
            )
            .unwrap();
        assert!(
            actual == fresh(raw, source, &model, cap, film),
            "step {step} differs from a fresh render"
        );
        let now = resident.detailed.kept().map(|scene| scene.pixels.as_ptr());
        let engaged = detail_amounts(&model) != [0.0f32.to_bits(); 3];
        assert_eq!(
            now.is_some(),
            streak >= 2 && engaged,
            "step {step}, streak {streak}"
        );
        if developed {
            assert_eq!(prefix, resident.prefix.pixels.as_ptr(), "step {step}");
        }
        if streak >= 3 {
            assert_eq!(kept, now, "step {step} reallocated the kept scene");
        }
        if let Some(scene) = resident.detailed.kept() {
            assert_eq!(scene.pixels.len(), resident.prefix.pixels.len());
        }
    }
}

#[test]
fn slider_sequences_match_fresh_renders_and_keep_only_repeated_late_ticks() {
    let (first_bytes, second_bytes) = (chart(12), chart(16));
    let first = crate::decode::decode_bytes(&first_bytes, "dng").unwrap();
    let second = crate::decode::decode_bytes(&second_bytes, "dng").unwrap();
    let first_source = RawInput::Bytes {
        bytes: &first_bytes,
        ext: "dng",
    };
    let second_source = RawInput::Bytes {
        bytes: &second_bytes,
        ext: "dng",
    };
    let film = tinted_film();
    for profile in [Profile::Auto, Profile::Neutral] {
        let default = AdjustmentModel {
            profile,
            ..Default::default()
        };
        for base in [default, engaged(profile)] {
            let contrast = |amount: f32, model: &AdjustmentModel| AdjustmentModel {
                contrast: amount,
                ..model.clone()
            };
            let exposed = AdjustmentModel {
                exposure: 0.7,
                ..base.clone()
            };
            let warmed = AdjustmentModel {
                temperature: 4200.,
                grain_amount: 35.,
                ..exposed.clone()
            };
            let softened = AdjustmentModel {
                nr_luminance: 80.,
                ..warmed.clone()
            };
            let (mut resident, frame) = CpuPreview::open(
                &first,
                first_source,
                base.clone(),
                RenderQuality::Preview,
                80,
                Some(&film),
            )
            .unwrap();
            assert!(frame == fresh(&first, first_source, &base, 80, Some(&film)));
            drive(
                &mut resident,
                &first,
                first_source,
                [
                    contrast(20., &base),
                    contrast(35., &base),
                    AdjustmentModel {
                        whites: 30.,
                        film_strength: 55.,
                        ..contrast(35., &base)
                    },
                    base.clone(),
                    exposed.clone(),
                    contrast(-25., &exposed),
                    graded(contrast(-25., &exposed)),
                    exposed.clone(),
                    warmed.clone(),
                    contrast(15., &warmed),
                    contrast(30., &warmed),
                    softened.clone(),
                    contrast(10., &softened),
                    contrast(40., &softened),
                    contrast(55., &softened),
                ],
                80,
                Some(&film),
            );
            assert!(resident.detailed.kept().is_some());
            drive(
                &mut resident,
                &second,
                second_source,
                [
                    contrast(55., &softened),
                    contrast(5., &softened),
                    contrast(25., &softened),
                    base.clone(),
                ],
                80,
                Some(&film),
            );
        }
    }
}

#[test]
fn every_late_field_alone_resumes_and_matches_a_fresh_render() {
    let bytes = chart(12);
    let raw = crate::decode::decode_bytes(&bytes, "dng").unwrap();
    let source = RawInput::Bytes {
        bytes: &bytes,
        ext: "dng",
    };
    let film = tinted_film();
    let base = graded(engaged(Profile::Neutral));
    let sorted = |names: Vec<&'static str>| {
        let mut names = names;
        names.sort_unstable();
        names
    };
    assert_eq!(
        sorted(LATE_EDITS.iter().map(|(name, _)| *name).collect()),
        sorted(VIEW_TAIL_FIELDS.to_vec()),
        "every view-tail field of the key needs an edit here"
    );
    for (_, edit) in LATE_EDITS {
        assert_eq!(develop_key(edit(base.clone())), develop_key(base.clone()));
        assert_ne!(edit(base.clone()), base);
    }
    for (_, edit) in UPSTREAM_EDITS {
        assert_ne!(develop_key(edit(base.clone())), develop_key(base.clone()));
    }
    let (mut resident, _) = CpuPreview::open(
        &raw,
        source,
        base.clone(),
        RenderQuality::Preview,
        80,
        Some(&film),
    )
    .unwrap();
    drive(
        &mut resident,
        &raw,
        source,
        LATE_EDITS.iter().map(|(_, edit)| edit(base.clone())),
        80,
        Some(&film),
    );
    assert!(resident.detailed.kept().is_some());
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn real_fitted_auto_late_ticks_cross_the_pinned_route_and_match_fresh_renders() {
    let path = crate::test_support::fixtures::require_raw("test_0017.dng");
    let bytes = std::fs::read(path).unwrap();
    let raw = crate::decode::decode_bytes(&bytes, "dng").unwrap();
    let source = RawInput::Bytes {
        bytes: &bytes,
        ext: "dng",
    };
    let film = tinted_film();
    for base in [AdjustmentModel::default(), engaged(Profile::Auto)] {
        let contrast = |amount: f32, model: &AdjustmentModel| AdjustmentModel {
            contrast: amount,
            ..model.clone()
        };
        let exposed = AdjustmentModel {
            exposure: 0.6,
            ..base.clone()
        };
        for supplied in [None, Some(&film)] {
            let (mut resident, frame) = CpuPreview::open(
                &raw,
                source,
                base.clone(),
                RenderQuality::Preview,
                160,
                supplied,
            )
            .unwrap();
            assert_eq!(
                frame.3,
                Some(crate::view::auto_profile::AutoFitOutcome::Applied),
                "authentic embedded-JPEG Auto fit must engage"
            );
            assert!(frame == fresh(&raw, source, &base, 160, supplied));
            drive(
                &mut resident,
                &raw,
                source,
                [
                    contrast(25., &base),
                    base.clone(),
                    contrast(40., &base),
                    base.clone(),
                    AdjustmentModel {
                        film_strength: 0.,
                        ..base.clone()
                    },
                    graded(base.clone()),
                    AdjustmentModel {
                        sharpen_amount: AdjustmentModel::default().sharpen_amount,
                        nr_luminance: AdjustmentModel::default().nr_luminance,
                        nr_color: AdjustmentModel::default().nr_color,
                        ..base.clone()
                    },
                    base.clone(),
                    base.clone(),
                    exposed.clone(),
                    contrast(-30., &exposed),
                    contrast(-10., &exposed),
                    graded(exposed.clone()),
                    base.clone(),
                    base.clone(),
                    base.clone(),
                ],
                160,
                supplied,
            );
        }
    }
}
