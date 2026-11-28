use super::*;
use crate::test_support::synth_dng::SyntheticGreyDng;
use crate::types::Crop;

const TARGET_PX: u32 = 64;

fn sensor() -> RawImage {
    let bytes = SyntheticGreyDng {
        width: 256,
        height: 192,
        ..Default::default()
    }
    .write_to_bytes();
    crate::decode::decode_bytes(&bytes, "dng").unwrap()
}

fn half_size_crop() -> AdjustmentModel {
    AdjustmentModel {
        crop: Crop {
            top: 0.25,
            left: 0.25,
            bottom: 0.75,
            right: 0.75,
            angle: 0.0,
        },
        ..AdjustmentModel::default()
    }
}

fn long_edge(render: &(u32, u32, Vec<u8>)) -> u32 {
    render.0.max(render.1)
}

#[test]
fn an_edited_half_size_crop_still_reaches_the_target_long_edge() {
    let raw = sensor();
    let render = render_develop_preview(&raw, &half_size_crop(), None, TARGET_PX, true).unwrap();
    assert!(
        long_edge(&render) >= TARGET_PX,
        "got {}x{}",
        render.0,
        render.1
    );
}

#[test]
fn the_sized_chain_alone_would_crop_an_edited_photo_below_the_target() {
    let raw = sensor();
    let render = render_sized_from_raw_with_quality_and_source(
        &raw,
        &half_size_crop(),
        RenderQuality::Full,
        None,
        TARGET_PX,
    )
    .unwrap();
    assert!(
        long_edge(&render) < TARGET_PX,
        "got {}x{}",
        render.0,
        render.1
    );
}

#[test]
fn an_unedited_photo_develops_through_the_sized_chain() {
    let raw = sensor();
    let model = AdjustmentModel::default();
    let sized = render_sized_from_raw_with_quality_and_source(
        &raw,
        &model,
        RenderQuality::Full,
        None,
        TARGET_PX,
    )
    .unwrap();
    let preview = render_develop_preview(&raw, &model, None, TARGET_PX, false).unwrap();
    assert_eq!(long_edge(&preview), TARGET_PX);
    assert_eq!(preview, sized);
}
