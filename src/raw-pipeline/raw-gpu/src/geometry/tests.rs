use super::*;
use crate::{chain::ChainRunner, image::GpuImage};
use raw_core::{
    image::{ColorSpace, Image},
    stages::geometry::{self, Geometry},
};

#[test]
fn wgsl_matches_core_for_projective_resampling() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (37, 29);
    let input: Vec<f32> = (0..w * h)
        .flat_map(|i| {
            let t = i as f32 / (w * h) as f32;
            [t, 1.0 - t, (i % 7) as f32 / 7.0, 1.0]
        })
        .collect();
    for controls in [
        Geometry::default(),
        Geometry {
            perspective_h: 0.3,
            perspective_v: -0.25,
            rotation: 17.0,
            aspect: 1.4,
            scale: 1.1,
        },
        Geometry {
            scale: 0.5,
            ..Geometry::default()
        },
    ] {
        let inverse = controls.forward(w, h).unwrap().inverse().unwrap();
        let mut reference = Image::new(w, h, ColorSpace::DisplayEncodedSrgb);
        for (out, p) in reference.pixels.iter_mut().zip(input.chunks_exact(4)) {
            *out = [p[0], p[1], p[2]];
        }
        geometry::apply(&mut reference, inverse, &mut vec![]);
        let image = GpuImage::upload(&ctx, &input, w, h);
        let runner = ChainRunner::new(&ctx, &image);
        let output = runner.run_blocking(&[&GeometryPass { inverse: inverse.0 }]);
        let error = reference
            .pixels
            .iter()
            .zip(output.chunks_exact(4))
            .flat_map(|(a, b)| (0..3).map(move |c| (a[c] - b[c]).abs()))
            .fold(0.0_f32, f32::max);
        assert!(error < 1e-4, "geometry GPU/core difference {error}");
    }
}
