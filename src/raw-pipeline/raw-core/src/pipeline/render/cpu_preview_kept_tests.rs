use super::resume::{MAX_KEPT_BYTES, REFUSE_RESERVATIONS};
use super::resume_tests::{chart, drive, engaged, fresh};
use super::*;
use crate::types::adjustment::Profile;

fn keeps(plan: DetailPlan<'_>) -> Option<bool> {
    match plan {
        DetailPlan::Resume(_) => None,
        DetailPlan::Run { keep } => Some(keep),
    }
}

#[test]
fn the_kept_scene_is_lazy_capped_and_released() {
    let amounts = detail_amounts(&AdjustmentModel::default());
    let moved = detail_amounts(&engaged(Profile::Auto));
    let scene = Image::new(4, 3, crate::image::ColorSpace::SceneLinearRec2020);
    let mut detailed = DetailedScene::opened(amounts);
    assert_eq!(keeps(detailed.plan(amounts, 144)), Some(false));
    assert_eq!(keeps(detailed.plan(amounts, 144)), Some(true));
    assert!(detailed.kept().is_none());
    detailed.keep(&scene);
    assert!(matches!(
        detailed.plan(amounts, 144),
        DetailPlan::Resume(kept) if kept.pixels == scene.pixels
    ));
    assert_eq!(keeps(detailed.plan(moved, 144)), Some(false));
    assert!(detailed.kept().is_none());
    assert_eq!(keeps(detailed.plan(moved, 144)), Some(false));
    assert_eq!(keeps(detailed.plan(moved, MAX_KEPT_BYTES + 1)), Some(false));
    assert_eq!(keeps(detailed.plan(moved, MAX_KEPT_BYTES)), Some(true));
    let mut unopened = DetailedScene::default();
    assert_eq!(keeps(unopened.plan(amounts, 144)), Some(false));
    let idle = [0.0f32.to_bits(); 3];
    let mut undetailed = DetailedScene::opened(idle);
    for _ in 0..4 {
        assert_eq!(keeps(undetailed.plan(idle, 144)), Some(false));
    }
}

#[test]
fn zero_detail_amounts_never_keep_a_copy_of_the_prefix() {
    let bytes = chart(12);
    let raw = crate::decode::decode_bytes(&bytes, "dng").unwrap();
    let source = RawInput::Bytes {
        bytes: &bytes,
        ext: "dng",
    };
    let base = AdjustmentModel {
        sharpen_amount: 0.,
        nr_luminance: 0.,
        nr_color: 0.,
        ..engaged(Profile::Neutral)
    };
    let (mut resident, _) =
        CpuPreview::open(&raw, source, base.clone(), RenderQuality::Preview, 80, None).unwrap();
    let ticks = [10., 20., 30., 40.].map(|contrast| AdjustmentModel {
        contrast,
        ..base.clone()
    });
    drive(&mut resident, &raw, source, ticks, 80, None);
    assert!(resident.detailed.kept().is_none());
}

#[test]
fn a_refused_reservation_keeps_nothing_and_changes_no_frame() {
    let bytes = chart(12);
    let raw = crate::decode::decode_bytes(&bytes, "dng").unwrap();
    let source = RawInput::Bytes {
        bytes: &bytes,
        ext: "dng",
    };
    let base = engaged(Profile::Neutral);
    let (mut resident, _) =
        CpuPreview::open(&raw, source, base.clone(), RenderQuality::Preview, 80, None).unwrap();
    REFUSE_RESERVATIONS.with(|refuse| refuse.set(true));
    for contrast in [10., 20., 30., 40.] {
        let model = AdjustmentModel {
            contrast,
            ..base.clone()
        };
        let actual = resident
            .render(
                &raw,
                source,
                model.clone(),
                RenderQuality::Preview,
                80,
                None,
                CancelToken::never(),
            )
            .unwrap();
        assert!(actual == fresh(&raw, source, &model, 80, None));
        assert!(resident.detailed.kept().is_none());
    }
    REFUSE_RESERVATIONS.with(|refuse| refuse.set(false));
    let model = AdjustmentModel {
        contrast: 50.,
        ..base.clone()
    };
    let actual = resident
        .render(
            &raw,
            source,
            model.clone(),
            RenderQuality::Preview,
            80,
            None,
            CancelToken::never(),
        )
        .unwrap();
    assert!(actual == fresh(&raw, source, &model, 80, None));
    assert!(resident.detailed.kept().is_some());
}
