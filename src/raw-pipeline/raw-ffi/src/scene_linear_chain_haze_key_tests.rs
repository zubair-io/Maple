//! `maple_scene_linear_chain_haze_key` (#3287): allocation-free, and every
//! parameter is either hashed or a stage downstream of the haze maps.

use super::maple_scene_linear_chain_haze_key;
use crate::scene_linear_chain::MapleAdjustmentParams;
use crate::scene_linear_chain_curves::MapleToneCurves;
use crate::scene_linear_chain_tests::default_params;
use raw_core::types::{layers_to_flat, LocalAdjustment, PartialAdjustments, Point2};

/// Parameters of stages after the haze maps; nothing else may be unhashed.
const DOWNSTREAM: &[&str] = &[
    "contrast",
    "whites",
    "nr_luminance",
    "nr_color",
    "vignette_amount",
    "vignette_feather",
    "grain_amount",
    "grain_size",
    "grain_roughness",
    "split_tone_shadow_hue",
    "split_tone_shadow_saturation",
    "split_tone_highlight_hue",
    "split_tone_highlight_saturation",
    "split_tone_balance",
    "color_grade_shadow_luminance",
    "color_grade_midtone_hue",
    "color_grade_midtone_saturation",
    "color_grade_midtone_luminance",
    "color_grade_highlight_luminance",
    "color_grade_global_hue",
    "color_grade_global_saturation",
    "color_grade_global_luminance",
    "color_grade_blending",
    "color_grade_shadow_edge",
    "color_grade_highlight_edge",
    "sharpen_amount",
    "sharpen_radius",
    "sharpen_detail",
    "sharpen_masking",
];

fn layered(flat: &[f32]) -> MapleAdjustmentParams {
    MapleAdjustmentParams {
        dehaze: 30.0,
        local_adjustments_ptr: flat.as_ptr(),
        local_adjustments_len: flat.len(),
        ..default_params()
    }
}

fn dehaze_layer() -> Vec<f32> {
    layers_to_flat(&[LocalAdjustment::radial(
        Point2::new(0.5, 0.5),
        Point2::new(0.3, 0.3),
        PartialAdjustments {
            exposure: Some(0.4),
            dehaze: Some(40.0),
            ..Default::default()
        },
    )])
}

#[test]
fn computing_the_key_allocates_nothing() {
    let flat = dehaze_layer();
    let curve = [0.0f32, 0.0, 0.5, 0.6, 1.0, 1.0];
    let p = layered(&flat);
    let curves = MapleToneCurves {
        luma_ptr: curve.as_ptr(),
        luma_len: curve.len(),
        // SAFETY: every field is a nullable pointer, a length or a scalar.
        ..unsafe { std::mem::zeroed() }
    };
    let key = unsafe { maple_scene_linear_chain_haze_key(&p, &curves) };
    let allocations = crate::allocation_counter::count(|| {
        assert_eq!(
            unsafe { maple_scene_linear_chain_haze_key(&p, &curves) },
            key
        );
    });
    assert_ne!(key, 0);
    assert_eq!(allocations, 0);
}

/// Perturbs each parameter in turn (from the exported ABI layout, so a new
/// field cannot slip past): the key must move for everything upstream and
/// stay for the stages after the maps.
#[test]
fn every_parameter_is_hashed_or_downstream() {
    let flat = dehaze_layer();
    let unperturbed =
        unsafe { maple_scene_linear_chain_haze_key(&layered(&flat), std::ptr::null()) };
    let key = |p: &MapleAdjustmentParams| unsafe {
        maple_scene_linear_chain_haze_key(p, std::ptr::null())
    };
    let layout = crate::abi_layout::describe("MapleAdjustmentParams").expect("exported");
    let fields = layout.split(';').skip(1).map(|field| {
        let (name, offset) = field.split_once('=').expect("name=offset");
        (name.to_owned(), offset.parse::<usize>().expect("offset"))
    });
    for (name, offset) in fields {
        if name.ends_with("_ptr") || name.ends_with("_len") {
            continue;
        }
        let mut perturbed = layered(&flat);
        unsafe {
            let byte = (&mut perturbed as *mut MapleAdjustmentParams as *mut u8).add(offset);
            *byte ^= 0x5a;
        }
        let moved = key(&perturbed) != unperturbed;
        assert_eq!(
            moved,
            !DOWNSTREAM.contains(&name.as_str()),
            "{name}: hashed must equal upstream"
        );
    }
}

/// The tone-curve wire feeds the maps except its display-referred curves,
/// which run after AgX.
#[test]
fn every_scene_curve_is_hashed_and_display_curves_are_not() {
    let flat = dehaze_layer();
    let p = layered(&flat);
    let point = [0.0f32, 0.0, 0.5, 0.6, 1.0, 1.0];
    // SAFETY: every field is a nullable pointer, a length or a scalar.
    let identity = || -> MapleToneCurves { unsafe { std::mem::zeroed() } };
    let key = |c: &MapleToneCurves| unsafe { maple_scene_linear_chain_haze_key(&p, c) };
    let base = key(&identity());
    let layout = crate::abi_layout::describe("MapleToneCurves").expect("exported");
    for field in layout.split(';').skip(1) {
        let (name, offset) = field.split_once('=').expect("name=offset");
        let offset: usize = offset.parse().expect("offset");
        if name.ends_with("_len") {
            continue;
        }
        let mut curves = identity();
        unsafe {
            let at = (&mut curves as *mut MapleToneCurves as *mut u8).add(offset);
            if let Some(stem) = name.strip_suffix("_ptr") {
                at.cast::<*const f32>().write(point.as_ptr());
                let len = layout
                    .split(';')
                    .find_map(|f| f.strip_prefix(&format!("{stem}_len=")))
                    .expect("paired length")
                    .parse::<usize>()
                    .expect("offset");
                (&mut curves as *mut MapleToneCurves as *mut u8)
                    .add(len)
                    .cast::<usize>()
                    .write(point.len());
            } else {
                *at ^= 0x5a;
            }
        }
        assert_eq!(
            key(&curves) != base,
            !name.starts_with("display_"),
            "{name}: hashed must equal upstream"
        );
    }
}

/// The creative stage runs before the maps (#5377): another decode's stage,
/// a different exposure gain or no stage at all is another key.
#[test]
fn the_creative_stage_is_hashed() {
    use crate::capture_creative::MapleCaptureCreative;
    use raw_core::test_support::creative::{creative_stage, Tables};
    let flat = dehaze_layer();
    let creative = |ae_gain: f32| {
        let (header, wire) = creative_stage(Tables::DualHueSatMapAndLook, ae_gain)
            .transport(raw_core::xmp::HighlightRecoveryMode::Off)
            .unwrap();
        MapleCaptureCreative::new(
            &header,
            crate::wb_frame_flat::intern_table_wire(wire.floats()),
        )
    };
    let (a, b) = (creative(1.4), creative(1.6));
    let key = |creative: Option<&MapleCaptureCreative>| {
        let p = MapleAdjustmentParams {
            creative_ptr: creative.map_or(std::ptr::null(), |c| c as *const _),
            ..layered(&flat)
        };
        unsafe { maple_scene_linear_chain_haze_key(&p, std::ptr::null()) }
    };
    assert_eq!(key(Some(&a)), key(Some(&creative(1.4))));
    assert_ne!(key(Some(&a)), key(Some(&b)));
    assert_ne!(key(Some(&a)), key(None));
}
