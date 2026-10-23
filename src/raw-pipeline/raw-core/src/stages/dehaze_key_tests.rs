//! `haze_key` (#3287): which dehaze amounts a retained haze map depends on.
use super::*;

#[test]
fn the_haze_key_ignores_amounts_no_retained_map_depends_on() {
    use crate::types::{LocalAdjustment, PartialAdjustments, Point2};
    use crate::xmp::AdjustmentModel;
    let layer = |dehaze: Option<f32>| {
        LocalAdjustment::radial(
            Point2::new(0.5, 0.5),
            Point2::new(0.3, 0.3),
            PartialAdjustments {
                dehaze,
                ..Default::default()
            },
        )
    };
    let model = |global: f32, first: Option<f32>, second: Option<f32>| AdjustmentModel {
        dehaze: global,
        local_adjustments: vec![layer(first), layer(second)],
        ..Default::default()
    };
    let key = |m: AdjustmentModel| haze_key(&m);
    // The last dehaze layer's amount feeds no map.
    assert_eq!(
        key(model(0.0, Some(20.0), Some(30.0))),
        key(model(0.0, Some(20.0), Some(-70.0)))
    );
    assert_eq!(
        key(model(0.0, None, Some(30.0))),
        key(model(0.0, None, Some(90.0)))
    );
    // An upstream layer's amount feeds the later layer's map.
    assert_ne!(
        key(model(0.0, Some(20.0), Some(30.0))),
        key(model(0.0, Some(60.0), Some(30.0)))
    );
    // The global amount feeds every layer's map, and no map without layers.
    assert_ne!(
        key(model(10.0, None, Some(30.0))),
        key(model(40.0, None, Some(30.0)))
    );
    assert_eq!(key(model(10.0, None, None)), key(model(-40.0, None, None)));
    // Engagement decides which maps exist, so it always changes the key.
    assert_ne!(
        key(model(0.0, None, Some(30.0))),
        key(model(0.0, None, None))
    );
    assert_ne!(key(model(10.0, None, None)), key(model(0.0, None, None)));
}
