use std::{env, fs};
struct ColorLut {
    size: usize,
    data: Vec<f32>,
}
mod projection {
    include!("paired_projection.rs");
}
mod anchored {
    use super::ColorLut;
    mod implementation {
        include!("anchored_projection.rs");
    }
    pub fn apply(data: &mut [f32], prior: &ColorLut, confidence: &[f64], anchors: &[f32]) {
        implementation::constrain_to_prior(data, prior, confidence, anchors);
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
    let weights = fs::read(&a[3])
        .unwrap()
        .chunks_exact(8)
        .map(|v| f64::from_le_bytes(v.try_into().unwrap()))
        .collect::<Vec<_>>();
    let anchors = floats(&a[5]);
    anchored::apply(&mut data, &prior, &weights, &anchors);
    fs::write(
        &a[4],
        data.iter()
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<_>>(),
    )
    .unwrap();
}
