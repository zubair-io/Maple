use super::{assess, prefer, ColorLut, Observation};

pub(super) fn select_step(
    proposed: &ColorLut,
    current: &ColorLut,
    native: &[Observation],
    display: &[Observation],
) -> Option<ColorLut> {
    let blend = |fraction: f32| {
        let mut candidate = proposed.clone();
        if fraction != 1. {
            for ((value, &before), &after) in candidate
                .data
                .iter_mut()
                .zip(&current.data)
                .zip(&proposed.data)
            {
                *value = before + fraction * (after - before);
            }
        }
        candidate
    };
    let mut upper = 1.;
    let mut selected = None;
    for fraction in [1., 0.5, 0.25, 0.125, 0.0625] {
        let candidate = blend(fraction);
        if assess(&candidate, native, display).compatible {
            selected = Some((fraction, candidate));
            break;
        }
        upper = fraction;
    }
    let (mut lower, mut result) = selected?;
    if lower != 1. {
        for _ in 0..8 {
            let fraction = (lower + upper) * 0.5;
            let candidate = blend(fraction);
            if assess(&candidate, native, display).compatible {
                lower = fraction;
                result = candidate;
            } else {
                upper = fraction;
            }
        }
    }
    let native_band_backtracked = !assess(&result, native, display).native_bands_preserved;
    if native_band_backtracked {
        let original = lower;
        let mut safe = None;
        // Sampled band limits need interior slack, not a refinement to their estimated boundary.
        for fraction in [0.5, 0.25, 0.125, 0.0625] {
            let fraction = original * fraction;
            let candidate = blend(fraction);
            if prefer(&candidate, native, display) {
                safe = Some((fraction, candidate));
                break;
            }
        }
        (lower, result) = safe?;
    }
    #[cfg(feature = "stage-dump")]
    if let Some(dir) = crate::stage_dump::dump_dir() {
        let _ = prefer(&result, native, display);
        if let Ok(file) = std::fs::File::create(dir.join("auto_fit_step.json")) {
            let _ = serde_json::to_writer(
                file,
                &serde_json::json!({"fraction":lower,"native_band_backtracked":native_band_backtracked}),
            );
        }
    }
    Some(result)
}
