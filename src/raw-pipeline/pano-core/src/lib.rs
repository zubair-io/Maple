//! pano-core — panorama stitching pipeline.
//!
//! See `docs/tickets/04-maple-panorama-spec.md` for the design spec and
//! `docs/tasks/04-maple-panorama-spec.md` for the per-task work plan.

#![forbid(unsafe_code)]

pub mod ba;
pub mod backends;
pub mod blend;
pub mod color;
pub mod compensation;
pub mod error;
pub mod features;
pub mod ingest;
pub mod matching;
pub mod pipeline;
pub mod seam;
pub mod traits;
pub mod types;
pub mod util;
pub mod warp;

pub use ba::{
    solve_joint, solve_joint_with_priors, CameraPrior, JointRotationFocalBA, RotationOnlyBA,
};
pub use compensation::gain::{apply_gains, solve_per_image_gain};
pub use pipeline::stitch_images;
pub use blend::{MultiBandBlender, SimpleAlphaBlender};
pub use color::{ColorSpace, Primaries, Transfer, WhitePoint};
pub use error::PanoError;
pub use features::OrbDetector;
pub use features::AkazeDetector;
pub use ingest::{decode_bytes, decode_input, sniff_format, PanoFormat, PanoInput};
pub use matching::BruteForceMatcher;
pub use seam::{GraphCutSeamFinder, GraphCutMaxFlowSeamFinder};
pub use traits::{Blender, BundleAdjuster, FeatureDetector, FeatureMatcher, SeamFinder, Warper};
pub use types::{
    Camera, Distortion, Features, Keypoint, Match, Matches, PanoImage, ParallaxMode,
    PipelineOptions, Projection, SeamMask,
};
pub use warp::CpuWarper;
