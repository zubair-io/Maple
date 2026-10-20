//! Diagnostic-only global negative-Whites response sweep.
//!
//! Evaluates the existing, single-sourced neutral AgX curve. A strength ratio
//! scales the negative branch's existing amplitude; it does not change any RAW,
//! XMP, reference, budget, production constant or physical qualification result.
//! Physical validation with original -100 inputs is required before adoption.
use raw_core::view::{
    agx::{neutral_curve, AGX_MAX_EV, AGX_MID_GRAY, AGX_MIN_EV},
    agx_whites::WHITES_NEG_AMT,
};

fn main() {
    println!("strength_ratio,negative_amplitude,scene_y,baseline_display_y,whites_display_y");
    for strength_step in 0..=20 {
        let ratio = 0.5 + strength_step as f32 * 0.025;
        for index in 0..=4096 {
            let ev = AGX_MIN_EV + (AGX_MAX_EV - AGX_MIN_EV) * index as f32 / 4096.0;
            let scene = AGX_MID_GRAY * ev.exp2();
            let baseline = neutral_curve(scene, 1.0, 0.0);
            let whites = neutral_curve(scene, 1.0, -100.0 * ratio);
            println!(
                "{ratio:.9},{:.9},{scene:.9},{baseline:.9},{whites:.9}",
                WHITES_NEG_AMT * ratio
            );
        }
    }
}
