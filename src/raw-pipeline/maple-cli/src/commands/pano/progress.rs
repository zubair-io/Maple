//! Machine-readable stage progress on stderr (#4581):
//! `pano: progress <stage> <label> <percent>%`, one line per whole-percent
//! change, so a parent process (the Windows stitch dialog) can show where a
//! multi-minute run is. Stages are [`maple_pano::stitch`]'s 0–5.

const STAGE_LABELS: [&str; 6] = [
    "decode",
    "features",
    "match_graph",
    "refine",
    "solve",
    "composite",
];

pub(super) fn progress_line(stage: u32, frac: f32) -> String {
    let label = STAGE_LABELS
        .get(stage as usize)
        .copied()
        .unwrap_or("unknown");
    format!("pano: progress {stage} {label} {}%", whole_percent(frac))
}

fn whole_percent(frac: f32) -> u32 {
    (frac.clamp(0.0, 1.0) * 100.0).floor() as u32
}

/// A progress callback that prints [`progress_line`] whenever the stage or
/// its whole percent changes; per-frame callbacks inside a stage would
/// otherwise flood the pipe.
pub(super) fn stderr_progress() -> impl FnMut(u32, f32) {
    let mut last: Option<(u32, u32)> = None;
    move |stage, frac| {
        let current = (stage, whole_percent(frac));
        if last != Some(current) {
            last = Some(current);
            eprintln!("{}", progress_line(stage, frac));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_names_the_stage_and_floors_the_percent() {
        assert_eq!(progress_line(2, 0.0), "pano: progress 2 match_graph 0%");
        assert_eq!(progress_line(0, 0.999), "pano: progress 0 decode 99%");
        assert_eq!(progress_line(5, 1.0), "pano: progress 5 composite 100%");
    }

    #[test]
    fn out_of_range_input_stays_parseable() {
        assert_eq!(progress_line(9, 1.7), "pano: progress 9 unknown 100%");
        assert_eq!(progress_line(1, -0.2), "pano: progress 1 features 0%");
    }
}
