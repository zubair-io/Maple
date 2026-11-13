use std::{env, fs};
struct ColorLut {
    size: usize,
    data: Vec<f32>,
}
mod projection {
    include!("/Users/riabuz/.codex/worktrees/color-suite-progress/_Maple/src/raw-pipeline/raw-core/src/view/auto_profile/paired_projection.rs");
}
mod anchored {
    use super::ColorLut;
    pub(crate) fn project(data: &mut [f32], prior: &ColorLut, confidence: &[f64]) {
        projection::constrain_to_prior(data, prior, confidence);
    }
    pub(crate) mod projection {
        include!("/Users/riabuz/.codex/worktrees/color-suite-progress/_Maple/src/raw-pipeline/raw-core/src/view/auto_profile/paired_refinement_projection.rs");
    }
}
fn floats(path: &str) -> Vec<f32> {
    fs::read(path)
        .unwrap()
        .chunks_exact(4)
        .map(|x| f32::from_le_bytes(x.try_into().unwrap()))
        .collect()
}
fn main() {
    let a: Vec<_> = env::args().collect();
    let prior = ColorLut {
        size: 33,
        data: floats(&a[1]),
    };
    let mut data = floats(&a[2]);
    let confidence = fs::read(&a[3])
        .unwrap()
        .chunks_exact(8)
        .map(|x| f64::from_le_bytes(x.try_into().unwrap()))
        .collect::<Vec<_>>();
    anchored::project(&mut data, &prior, &confidence);
    fs::write(
        &a[4],
        data.iter()
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<_>>(),
    )
    .unwrap();
}
