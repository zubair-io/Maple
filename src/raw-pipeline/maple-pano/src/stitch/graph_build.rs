//! The one place the stitch paths choose candidate providers (#4519).
//!
//! Without a declared grid every graph build — rotation bootstrap,
//! homography-focal rebuild, tile branch, standalone tile — keeps the
//! capture-order + gimbal-prior (+ descriptor top-k where features are
//! at hand) nomination it always had. With a declared grid all of those
//! global nominators are replaced by [`GridPriorProvider`] and the
//! verified graph passes through the grid loop-closure gate, so the
//! O(N) candidate set and the false-closure rejection hold on every
//! path, not just the first build.

use crate::graph::{
    build_match_graph, CandidateProvider, CaptureOrderProvider, DescriptorTopKProvider,
    GimbalPriorProvider, GraphImage, GridLayout, GridPriorProvider, MatchGraph,
};
use crate::robust::RobustOptions;
use crate::twoview::PixelCorrespondence;

pub(super) fn build_stitch_graph(
    images: &[GraphImage],
    grid: Option<&GridLayout>,
    descriptor_topk: Option<&DescriptorTopKProvider>,
    fetch: impl FnMut(usize, usize) -> Vec<PixelCorrespondence>,
) -> MatchGraph {
    let opts = RobustOptions::default();
    match grid {
        Some(layout) => {
            let mut graph = build_match_graph(
                images,
                &[&GridPriorProvider { layout: *layout }],
                fetch,
                &opts,
            );
            graph.admit_grid_loop_closures(layout);
            graph
        }
        None => {
            let gimbal = GimbalPriorProvider::default();
            let providers: Vec<&dyn CandidateProvider> =
                [&CaptureOrderProvider as &dyn CandidateProvider, &gimbal]
                    .into_iter()
                    .chain(descriptor_topk.map(|d| d as &dyn CandidateProvider))
                    .collect();
            build_match_graph(images, &providers, fetch, &opts)
        }
    }
}

#[cfg(all(test, feature = "testkit"))]
mod tests {
    use super::*;
    use crate::camera::{focal_px_for_hfov, Camera};
    use crate::graph::GridOrder;
    use crate::math::{matrix_to_axis_angle, Mat3};
    use crate::prng::SplitMix64;
    use crate::testkit::{generate_pair_correspondences, CorrespondenceOptions};

    fn strip(count: usize) -> Vec<Camera> {
        (0..count)
            .map(|i| {
                let r = Mat3::rotation_y((i as f64 * 25.0).to_radians());
                Camera::new(
                    matrix_to_axis_angle(&r),
                    focal_px_for_hfov(60.0, 640),
                    0.0,
                    0.0,
                    640,
                    480,
                )
            })
            .collect()
    }

    fn fetcher(cams: &[Camera]) -> impl FnMut(usize, usize) -> Vec<PixelCorrespondence> + '_ {
        |a, b| {
            let mut rng = SplitMix64::new(((a as u64) << 32) ^ b as u64);
            generate_pair_correspondences(
                &cams[a],
                &cams[b],
                &CorrespondenceOptions {
                    count: 150,
                    noise_sigma_px: 0.5,
                    ..Default::default()
                },
                &mut rng,
            )
            .pixel_pairs()
        }
    }

    fn images(cams: &[Camera]) -> Vec<GraphImage> {
        cams.iter()
            .map(|c| GraphImage {
                camera: c.clone(),
                prior_rotation: Some(c.rotation),
            })
            .collect()
    }

    #[test]
    fn without_a_grid_the_graph_matches_the_legacy_providers() {
        let cams = strip(5);
        let imgs = images(&cams);
        let legacy = build_match_graph(
            &imgs,
            &[&CaptureOrderProvider, &GimbalPriorProvider::default()],
            fetcher(&cams),
            &RobustOptions::default(),
        );
        assert_eq!(
            build_stitch_graph(&imgs, None, None, fetcher(&cams)),
            legacy
        );
    }

    #[test]
    fn a_grid_replaces_the_global_nominators() {
        let cams = strip(5);
        let imgs = images(&cams);
        let layout = GridLayout {
            rows: 1,
            cols: 5,
            order: GridOrder::Raster,
            diagonals: false,
        };
        let mut requested = Vec::new();
        let mut fetch = fetcher(&cams);
        let graph = build_stitch_graph(&imgs, Some(&layout), None, |a, b| {
            requested.push((a, b));
            fetch(a, b)
        });
        assert_eq!(
            requested,
            vec![(0, 1), (0, 2), (1, 2), (1, 3), (2, 3), (2, 4), (3, 4)],
            "gimbal priors would also nominate (0,3); the grid must not"
        );
        assert!(graph.is_connected());
    }
}
