//! Integration smoke test for SuperPoint+LightGlue end-to-end matching.
//!
//! Skip-passes (eprintln + early return) when the cargo feature isn't
//! compiled in, the ONNX models aren't present locally, or the test
//! DNGs aren't present. Same pattern as the rest of the
//! integration-test directory — CI without fixtures stays green.
//!
//! Target: pair (1, 2) of pano_01 should produce ≥ 200 RANSAC inliers
//! with LightGlue, vs the AKAZE+GMS baseline of 73. The exact count
//! depends on the model quantisation; we conservatively gate at 200.

#![cfg(feature = "ml-lightglue")]

use std::path::{Path, PathBuf};

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn pano_01_dngs() -> Vec<PathBuf> {
    // The pano_01 frames live alongside the rest of the gitignored
    // RAW fixtures. We skip-pass when the directory is missing.
    let root = fixture_root().join("test-fixtures").join("raws").join("pano_01");
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        let mut dngs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("dng")))
            .collect();
        dngs.sort();
        out = dngs;
    }
    out
}

fn locate_model(env_var: &str, default_filename: &str) -> Option<PathBuf> {
    if let Ok(p) = std::env::var(env_var) {
        let path = PathBuf::from(p);
        if path.exists() {
            return Some(path);
        }
    }
    // Try `pano-core/resources/ml/<filename>` next to the source.
    let resource = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("ml")
        .join(default_filename);
    if resource.exists() {
        return Some(resource);
    }
    // Try `<repo-root>/resources/ml/<filename>`.
    let repo_resource = fixture_root().join("resources").join("ml").join(default_filename);
    if repo_resource.exists() {
        return Some(repo_resource);
    }
    None
}

fn skip_unless_present(label: &str, p: &Path) -> bool {
    if p.exists() {
        true
    } else {
        eprintln!("{label}: skipping — not present at {}", p.display());
        false
    }
}

#[test]
fn pano_01_pair_1_2_lightglue_yields_target_inlier_count() {
    let dngs = pano_01_dngs();
    if dngs.len() < 3 {
        eprintln!(
            "pano_01_pair_1_2_lightglue_yields_target_inlier_count: \
             skipping — need ≥3 DNGs in test-fixtures/raws/pano_01/, got {}",
            dngs.len()
        );
        return;
    }
    let img1_path = &dngs[1];
    let img2_path = &dngs[2];
    if !skip_unless_present("pano_01[1]", img1_path)
        || !skip_unless_present("pano_01[2]", img2_path)
    {
        return;
    }

    let superpoint = match locate_model("MAPLE_SUPERPOINT_ONNX", "superpoint.onnx") {
        Some(p) => p,
        None => {
            eprintln!(
                "pano_01_pair_1_2_lightglue_yields_target_inlier_count: \
                 skipping — SuperPoint model not found (set $MAPLE_SUPERPOINT_ONNX or \
                 place at pano-core/resources/ml/superpoint.onnx)"
            );
            return;
        }
    };
    let lightglue_model = match locate_model("MAPLE_LIGHTGLUE_ONNX", "lightglue.onnx") {
        Some(p) => p,
        None => {
            eprintln!(
                "pano_01_pair_1_2_lightglue_yields_target_inlier_count: \
                 skipping — LightGlue model not found (set $MAPLE_LIGHTGLUE_ONNX or \
                 place at pano-core/resources/ml/lightglue.onnx)"
            );
            return;
        }
    };

    // Decode both DNGs.
    let img_a_bytes = std::fs::read(img1_path).expect("read pano_01[1]");
    let img_b_bytes = std::fs::read(img2_path).expect("read pano_01[2]");
    let img_a = pano_core::decode_bytes(&img_a_bytes).expect("decode pano_01[1]");
    let img_b = pano_core::decode_bytes(&img_b_bytes).expect("decode pano_01[2]");

    // Run LightGlue end-to-end.
    let mut matcher =
        pano_core::features::lightglue::LightGlueMatcher::from_paths(superpoint, lightglue_model)
            .expect("LightGlueMatcher construction");
    let (feats_a, feats_b, matches) = matcher
        .match_pair(&img_a, &img_b)
        .expect("LightGlue match_pair");

    eprintln!(
        "pano_01[1,2] LightGlue: {} kps_a, {} kps_b, {} matches",
        feats_a.keypoints.len(),
        feats_b.keypoints.len(),
        matches.inliers.len()
    );

    // Run RANSAC on the LightGlue matches to get the geometric inlier
    // count — this is the metric the plan target (≥ 200) refers to.
    let ransac = pano_core::ba::homography::ransac_homography(
        &feats_a.keypoints,
        &feats_b.keypoints,
        &matches.inliers,
        3.0,
        2000,
        42,
    );
    let inliers = ransac.map(|(_, idx)| idx.len()).unwrap_or(0);
    eprintln!("pano_01[1,2] RANSAC inliers: {inliers}");
    assert!(
        inliers >= 200,
        "expected ≥ 200 RANSAC inliers from LightGlue on pano_01 pair (1, 2), got {inliers}"
    );
}
