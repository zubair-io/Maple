# AliceVision Panorama Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-rolled panorama pipeline with AliceVision's 10-stage stitching pipeline, driven from Rust as a subprocess workflow. Produces a real spherical panorama from DJI Mavic 3 Pro pano_01 fixtures (21 DNGs, 263° yaw + ±23° pitch coverage) where our hand-rolled BA fails.

**Architecture:** AliceVision ships as 10 standalone CLI tools that exchange SfMData JSON between stages — exactly how Meshroom drives them. We integrate via `std::process::Command` from a new `pano-core::backends::alicevision` module. No FFI, no C++ linking, no vcpkg in our build. The pipeline reads `PanoImage` inputs + DJI XMP metadata, writes intermediate SfMData files to a temp directory, and reads the final stitched EXR/JPG back into a `PanoImage`.

**Tech Stack:**
- AliceVision 3.3.0 (MPL-2.0) — pano stitching engine. Self-built from source via vcpkg on the dev macOS machine; bundled binary is added later (Phase 4).
- Existing `pano-core` Rust crate — host module + trait surface
- `std::process::Command` — subprocess invocation
- `serde_json` — SfMData JSON read/write (added as new dep)
- `tempfile` — already in workspace dev-deps; promoted to runtime dep here
- `image` + `png` — already used; reads AliceVision's EXR/JPG/PNG output

---

## Phase 1 — Build AliceVision locally + manual smoke test

This phase is human-driven (one-time setup), but the steps below let any engineer reproduce the dev environment. The point is to prove that AliceVision's CLI pipeline actually stitches our pano_01 fixture before we commit to wiring it into Rust. If Phase 1 fails, the entire plan is wrong and we cut losses immediately.

### Task 1.1: Build AliceVision 3.3.0 on macOS

**Files:**
- No code changes in this task. Documents the build under `docs/setup/alicevision-build.md`.

- [ ] **Step 1.1.1: Install build prerequisites via Homebrew**

```bash
brew install cmake ninja python@3.11 git
brew install --cask powershell    # only if vcpkg complains about PowerShell on first bootstrap
```

Verify: `cmake --version` ≥ 3.20, `ninja --version` works.

- [ ] **Step 1.1.2: Clone AliceVision + checkout the v3.3.0 tag**

```bash
mkdir -p ~/src && cd ~/src
git clone --recursive https://github.com/alicevision/AliceVision.git
cd AliceVision && git checkout v3.3.0 && git submodule update --init --recursive
```

Expected: ~150 MB clone. Submodules include vcpkg.

- [ ] **Step 1.1.3: Bootstrap vcpkg + build dependencies**

```bash
cd ~/src/AliceVision
./bootstrap-vcpkg.sh    # if AliceVision provides one — otherwise:
./vcpkg/bootstrap-vcpkg.sh -disableMetrics
./vcpkg/vcpkg install --triplet=arm64-osx
```

Expected: 30–120 minutes for the full dep build (Boost, OpenCV, Ceres, OpenImageIO, OpenMesh, Eigen, Alembic, Geogram, ...). On Apple Silicon this is ~6 GB of build artifacts.

If a specific dep fails (common: OpenImageIO ↔ libjpeg-turbo version conflict on macOS 14+), document the workaround inline in `docs/setup/alicevision-build.md` rather than papering over.

- [ ] **Step 1.1.4: Configure + build AliceVision itself**

```bash
mkdir build && cd build
cmake -GNinja \
  -DCMAKE_TOOLCHAIN_FILE=../vcpkg/scripts/buildsystems/vcpkg.cmake \
  -DVCPKG_TARGET_TRIPLET=arm64-osx \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX=~/opt/alicevision \
  -DALICEVISION_USE_CCTAG=OFF \
  -DALICEVISION_USE_OPENGV=OFF \
  -DALICEVISION_USE_POPSIFT=OFF \
  -DALICEVISION_BUILD_DOC=OFF \
  -DALICEVISION_BUILD_EXAMPLES=OFF \
  ..
ninja -j8
ninja install
```

Expected: 15–45 minutes after deps are built. Installs to `~/opt/alicevision/bin/aliceVision_*`.

- [ ] **Step 1.1.5: Verify the panorama binaries exist**

```bash
ls ~/opt/alicevision/bin/aliceVision_panorama* | sort
```

Expected output (10 binaries):
```
aliceVision_panoramaCompositing
aliceVision_panoramaEstimation
aliceVision_panoramaInit
aliceVision_panoramaMerging
aliceVision_panoramaPostProcessing
aliceVision_panoramaPrepareImages
aliceVision_panoramaRefining
aliceVision_panoramaRigging
aliceVision_panoramaSeams
aliceVision_panoramaWarping
```

If any binary is missing, the cmake config above had a feature flag that excluded it — re-check the flags.

- [ ] **Step 1.1.6: Document the build in the repo**

Create `docs/setup/alicevision-build.md` with the exact commands above + a "common errors" appendix for whatever the engineer hit.

- [ ] **Step 1.1.7: Commit the build doc**

```bash
git add docs/setup/alicevision-build.md
git commit -m "docs(pano): document AliceVision 3.3.0 macOS build"
```

### Task 1.2: Manually stitch pano_01 with AliceVision CLI

**Files:** Documents the workflow under `docs/setup/alicevision-build.md` (appended).

- [ ] **Step 1.2.1: Set up a workdir + symlink the fixtures**

```bash
mkdir -p /tmp/av-pano01/input /tmp/av-pano01/work
ln -sf /Users/riabuz/Projects/_Maple/test-fixtures/raws/pano_01/PANO*.DNG /tmp/av-pano01/input/
ls /tmp/av-pano01/input/
```

Expected: 21 PANO0001..PANO0021.DNG symlinks.

- [ ] **Step 1.2.2: Run `aliceVision_panoramaInit` to ingest images + EXIF**

```bash
export AV=~/opt/alicevision/bin
$AV/aliceVision_cameraInit \
  --imageFolder /tmp/av-pano01/input \
  --output /tmp/av-pano01/work/cameraInit.sfm \
  --useInternalWhiteBalance true
```

Expected: Writes `cameraInit.sfm` (JSON) listing all 21 images with EXIF-derived focal lengths, sensor sizes, and gimbal-derived initial poses (AliceVision reads the DJI XMP `GimbalYaw/Pitch/Roll` and writes them as initial camera rotations — verify by grepping the JSON for "rotation").

If `cameraInit` doesn't pick up the gimbal data, switch to `aliceVision_panoramaInit` which is panorama-specific and known to use it.

- [ ] **Step 1.2.3: Run feature extraction + matching**

```bash
$AV/aliceVision_featureExtraction \
  --input /tmp/av-pano01/work/cameraInit.sfm \
  --output /tmp/av-pano01/work/features \
  --describerTypes sift \
  --describerPreset normal
$AV/aliceVision_imageMatching \
  --input /tmp/av-pano01/work/cameraInit.sfm \
  --featuresFolders /tmp/av-pano01/work/features \
  --output /tmp/av-pano01/work/imageMatches.txt \
  --method SequentialAndVocabularyTree \
  --nbMatches 50
$AV/aliceVision_featureMatching \
  --input /tmp/av-pano01/work/cameraInit.sfm \
  --featuresFolders /tmp/av-pano01/work/features \
  --imagePairsList /tmp/av-pano01/work/imageMatches.txt \
  --output /tmp/av-pano01/work/matches
```

Expected: Tens of thousands of feature matches across the image pairs.

- [ ] **Step 1.2.4: Run panorama estimation (BA)**

```bash
$AV/aliceVision_panoramaEstimation \
  --input /tmp/av-pano01/work/cameraInit.sfm \
  --featuresFolders /tmp/av-pano01/work/features \
  --matchesFolders /tmp/av-pano01/work/matches \
  --output /tmp/av-pano01/work/panoramaEstimation.sfm
```

Expected: SfMData with refined per-image rotations + focal lengths. Bundle adjustment runs Ceres internally — if it fails ("not enough valid views"), the matching step probably didn't find correspondences. Inspect the matches output.

- [ ] **Step 1.2.5: Run warp + composite to produce the stitched output**

```bash
$AV/aliceVision_panoramaWarping \
  --input /tmp/av-pano01/work/panoramaEstimation.sfm \
  --output /tmp/av-pano01/work/warped \
  --panoramaSize 16384
$AV/aliceVision_panoramaSeams \
  --input /tmp/av-pano01/work/panoramaEstimation.sfm \
  --warpingFolder /tmp/av-pano01/work/warped \
  --output /tmp/av-pano01/work/seams.exr
$AV/aliceVision_panoramaCompositing \
  --input /tmp/av-pano01/work/panoramaEstimation.sfm \
  --warpingFolder /tmp/av-pano01/work/warped \
  --labels /tmp/av-pano01/work/seams.exr \
  --output /tmp/av-pano01/work/pano.exr \
  --compositerType multiband
$AV/aliceVision_panoramaMerging \
  --input /tmp/av-pano01/work/panoramaEstimation.sfm \
  --compositingFolder /tmp/av-pano01/work/pano.exr \
  --output /tmp/av-pano01/work/final.exr
```

Expected: `/tmp/av-pano01/work/final.exr` is a 16384×8192 (or similar) equirectangular EXR.

- [ ] **Step 1.2.6: View the result**

```bash
open /tmp/av-pano01/work/final.exr      # macOS Preview opens EXR via ImageIO
# or convert for casual viewing:
$AV/aliceVision_imageProcessing \
  --input /tmp/av-pano01/work/final.exr \
  --output /tmp/av-pano01/work/final.jpg \
  --extension jpg
```

**This is the gate.** If the JPG looks like a real spherical panorama, proceed to Phase 2. If it doesn't, stop and re-examine — the CLI tools may need different flags for DJI input, or the lens distortion model may be wrong, or the metadata import may need a specific flag (`--useGpsRotations`, `--useExifCameraOrientation`, etc.).

- [ ] **Step 1.2.7: Append the working CLI invocation to the build doc**

Add the exact commands that worked (with any flags discovered during Phase 1) to `docs/setup/alicevision-build.md` § "Manual pano_01 stitch" so the engineer doing Phase 2 has a reference.

- [ ] **Step 1.2.8: Commit**

```bash
git add docs/setup/alicevision-build.md
git commit -m "docs(pano): record AliceVision CLI invocation that stitches pano_01"
```

---

## Phase 2 — Rust subprocess backend

Now wraps the Phase 1 CLI invocations behind a Rust API. The new module lives at `src/raw-pipeline/pano-core/src/backends/alicevision/`.

### Task 2.1: Scaffold `pano-core::backends::alicevision` module

**Files:**
- Create: `src/raw-pipeline/pano-core/src/backends/mod.rs`
- Create: `src/raw-pipeline/pano-core/src/backends/alicevision/mod.rs`
- Create: `src/raw-pipeline/pano-core/src/backends/alicevision/locate.rs`
- Create: `src/raw-pipeline/pano-core/tests/alicevision_backend.rs`
- Modify: `src/raw-pipeline/pano-core/src/lib.rs:1-30` (add `pub mod backends`)
- Modify: `src/raw-pipeline/pano-core/Cargo.toml` (add `tempfile = "3"` to `[dependencies]`)

- [ ] **Step 2.1.1: Add `tempfile = "3"` to pano-core's Cargo.toml `[dependencies]`**

It's already in workspace dev-deps; we promote to runtime here because the pipeline writes intermediate files even in production.

- [ ] **Step 2.1.2: Add `pub mod backends;` to pano-core/src/lib.rs (alphabetically with the other `pub mod`s)**

- [ ] **Step 2.1.3: Create `backends/mod.rs`**

```rust
//! Pluggable panorama backends.
//!
//! The crate's default classical pipeline (ORB + arrsac + LM-BA + CPU
//! warp + Dijkstra seam + multi-band blend) is in the `pipeline` module
//! and the per-stage trait implementations. Each `backends/<name>/`
//! submodule wraps an alternative engine — currently AliceVision via
//! subprocess.

pub mod alicevision;
```

- [ ] **Step 2.1.4: Create `backends/alicevision/mod.rs` skeleton**

```rust
//! AliceVision 3.3.0 panorama pipeline as a subprocess backend.
//!
//! AliceVision ships 10 standalone CLI tools (cameraInit,
//! featureExtraction, imageMatching, featureMatching,
//! panoramaEstimation, panoramaWarping, panoramaSeams,
//! panoramaCompositing, panoramaMerging, imageProcessing for
//! EXR→PNG conversion). They exchange SfMData JSON between stages.
//! We invoke them in sequence via std::process::Command, writing
//! intermediates to a tempdir.
//!
//! Build setup: see docs/setup/alicevision-build.md.
//! Binary location: configured via env var MAPLE_ALICEVISION_BIN
//! (defaults to ~/opt/alicevision/bin) or AlicevisionBackend::new
//! explicit path.

mod locate;

pub use locate::{locate_binaries, AlicevisionBinaries};

use std::path::{Path, PathBuf};

use crate::error::PanoError;
use crate::types::PanoImage;

/// Subprocess-driven AliceVision panorama backend.
pub struct AlicevisionBackend {
    bins: AlicevisionBinaries,
}

impl AlicevisionBackend {
    /// Construct using `MAPLE_ALICEVISION_BIN` env or the default
    /// `~/opt/alicevision/bin` path.
    pub fn from_env() -> Result<Self, PanoError> {
        let bins = locate_binaries(None)?;
        Ok(Self { bins })
    }

    /// Construct from an explicit binary directory.
    pub fn from_path(bin_dir: impl AsRef<Path>) -> Result<Self, PanoError> {
        let bins = locate_binaries(Some(bin_dir.as_ref().to_path_buf()))?;
        Ok(Self { bins })
    }

    /// Stitch — implementation lands in Task 2.4.
    pub fn stitch(
        &self,
        _input_paths: &[PathBuf],
    ) -> Result<PanoImage, PanoError> {
        Err(PanoError::Other("not yet implemented (Task 2.4)".into()))
    }
}
```

- [ ] **Step 2.1.5: Create `backends/alicevision/locate.rs`**

```rust
//! Locate the AliceVision binaries on disk.
//!
//! Resolution order:
//! 1. Explicit path passed to `locate_binaries(Some(path))`.
//! 2. `MAPLE_ALICEVISION_BIN` environment variable.
//! 3. `~/opt/alicevision/bin` (the default install prefix from
//!    docs/setup/alicevision-build.md).

use std::path::PathBuf;

use crate::error::PanoError;

/// Resolved paths to the 10 panorama-pipeline binaries we drive.
#[derive(Debug, Clone)]
pub struct AlicevisionBinaries {
    pub camera_init: PathBuf,
    pub feature_extraction: PathBuf,
    pub image_matching: PathBuf,
    pub feature_matching: PathBuf,
    pub panorama_estimation: PathBuf,
    pub panorama_warping: PathBuf,
    pub panorama_seams: PathBuf,
    pub panorama_compositing: PathBuf,
    pub panorama_merging: PathBuf,
    pub image_processing: PathBuf,
}

const REQUIRED: &[&str] = &[
    "aliceVision_cameraInit",
    "aliceVision_featureExtraction",
    "aliceVision_imageMatching",
    "aliceVision_featureMatching",
    "aliceVision_panoramaEstimation",
    "aliceVision_panoramaWarping",
    "aliceVision_panoramaSeams",
    "aliceVision_panoramaCompositing",
    "aliceVision_panoramaMerging",
    "aliceVision_imageProcessing",
];

pub fn locate_binaries(explicit_dir: Option<PathBuf>) -> Result<AlicevisionBinaries, PanoError> {
    let dir = explicit_dir
        .or_else(|| std::env::var("MAPLE_ALICEVISION_BIN").ok().map(PathBuf::from))
        .or_else(|| dirs_home().map(|h| h.join("opt/alicevision/bin")))
        .ok_or_else(|| {
            PanoError::Other(
                "AliceVision binary directory not found; set MAPLE_ALICEVISION_BIN".into(),
            )
        })?;

    if !dir.is_dir() {
        return Err(PanoError::Other(format!(
            "AliceVision binary directory does not exist: {}",
            dir.display()
        )));
    }

    let mut paths = Vec::with_capacity(REQUIRED.len());
    for name in REQUIRED {
        let p = dir.join(name);
        if !p.is_file() {
            return Err(PanoError::Other(format!(
                "AliceVision binary missing: {}",
                p.display()
            )));
        }
        paths.push(p);
    }

    Ok(AlicevisionBinaries {
        camera_init: paths[0].clone(),
        feature_extraction: paths[1].clone(),
        image_matching: paths[2].clone(),
        feature_matching: paths[3].clone(),
        panorama_estimation: paths[4].clone(),
        panorama_warping: paths[5].clone(),
        panorama_seams: paths[6].clone(),
        panorama_compositing: paths[7].clone(),
        panorama_merging: paths[8].clone(),
        image_processing: paths[9].clone(),
    })
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(PathBuf::from)
}
```

- [ ] **Step 2.1.6: Create `tests/alicevision_backend.rs` with the locate test**

```rust
//! Integration tests for the AliceVision subprocess backend.
//!
//! Tests are skip-passed if the binaries can't be located (e.g. in CI
//! without an AliceVision install). Mirrors the test_pano_pipeline.sh
//! "no fixtures, skipping" pattern.

use pano_core::backends::alicevision::{locate_binaries, AlicevisionBackend};

#[test]
fn locate_binaries_skips_when_absent() {
    // If MAPLE_ALICEVISION_BIN points at a nonsense path, we should
    // get a clear error rather than panicking.
    std::env::set_var("MAPLE_ALICEVISION_BIN", "/nonexistent/av/bin");
    let result = locate_binaries(None);
    assert!(result.is_err(), "expected error for missing dir");
    let msg = format!("{}", result.unwrap_err());
    assert!(msg.contains("does not exist"), "msg={msg}");
    std::env::remove_var("MAPLE_ALICEVISION_BIN");
}

#[test]
fn backend_from_env_skips_cleanly_when_unset() {
    // With no env + no default install, expect a clear error not panic.
    std::env::remove_var("MAPLE_ALICEVISION_BIN");
    if std::path::PathBuf::from(format!(
        "{}/opt/alicevision/bin",
        std::env::var("HOME").unwrap_or_default()
    ))
    .exists()
    {
        // Skip — engineer has AV installed; the happy-path test covers this.
        return;
    }
    let result = AlicevisionBackend::from_env();
    assert!(result.is_err(), "expected error when AV is not installed");
}
```

- [ ] **Step 2.1.7: Run the unit tests**

```bash
cd src/raw-pipeline && cargo test -p pano-core --test alicevision_backend
```

Expected: 2/2 pass.

- [ ] **Step 2.1.8: Run the regression suite**

```bash
cd src/raw-pipeline && cargo test -p pano-core
```

Expected: previous tests still pass; total = 115 + 2 = 117.

- [ ] **Step 2.1.9: Commit**

```bash
git add src/raw-pipeline/pano-core/Cargo.toml \
        src/raw-pipeline/pano-core/src/lib.rs \
        src/raw-pipeline/pano-core/src/backends \
        src/raw-pipeline/pano-core/tests/alicevision_backend.rs
git commit -m "feat(pano): scaffold AliceVision subprocess backend (locate + skeleton)"
```

### Task 2.2: SfMData JSON writer for the input set

**Files:**
- Create: `src/raw-pipeline/pano-core/src/backends/alicevision/sfm_data.rs`
- Modify: `src/raw-pipeline/pano-core/Cargo.toml` (add `serde_json = { workspace = true }`)
- Modify: `src/raw-pipeline/pano-core/src/backends/alicevision/mod.rs` (add `mod sfm_data;`)
- Modify: `src/raw-pipeline/pano-core/tests/alicevision_backend.rs` (add tests for the writer)

The SfMData v1.2.7 schema is documented at `https://github.com/alicevision/AliceVision/blob/v3.3.0/src/aliceVision/sfmDataIO/jsonIO.cpp`. We don't need to support the full schema — only what the panorama pipeline reads. The minimum is `version`, `views[]` (per image: viewId, intrinsicId, poseId, path, width, height), `intrinsics[]` (sensor model + focal), `poses[]` (initial rotation from gimbal), `featureFolder`, `matchingFolder`. We produce just `views`, `intrinsics`, `poses`; the matching pipeline produces the rest.

- [ ] **Step 2.2.1: Add serde_json + serde to pano-core deps (workspace versions)**

`serde_json` is in workspace deps; `serde` derives are too. Add `serde_json = { workspace = true }` and `serde = { workspace = true, features = ["derive"] }` to `pano-core/Cargo.toml`.

- [ ] **Step 2.2.2: Write the failing test for `write_camera_init_sfm`**

In `tests/alicevision_backend.rs`:

```rust
use pano_core::backends::alicevision::sfm_data::{write_camera_init_sfm, SfmInput};
use std::path::PathBuf;

#[test]
fn write_camera_init_sfm_produces_valid_json() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("cameraInit.sfm");
    let inputs = vec![
        SfmInput {
            path: PathBuf::from("/tmp/img1.dng"),
            width: 5376,
            height: 3956,
            focal_pixels: 5376.0,
            yaw_deg: 87.9,
            pitch_deg: -1.3,
            roll_deg: 0.0,
        },
        SfmInput {
            path: PathBuf::from("/tmp/img2.dng"),
            width: 5376,
            height: 3956,
            focal_pixels: 5376.0,
            yaw_deg: 55.6,
            pitch_deg: 19.8,
            roll_deg: 0.0,
        },
    ];
    write_camera_init_sfm(&out, &inputs).unwrap();
    let text = std::fs::read_to_string(&out).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed["version"], serde_json::json!(["1", "2", "7"]));
    assert_eq!(parsed["views"].as_array().unwrap().len(), 2);
    assert_eq!(parsed["intrinsics"].as_array().unwrap().len(), 2);
    assert_eq!(parsed["poses"].as_array().unwrap().len(), 2);
}
```

- [ ] **Step 2.2.3: Run the test to verify it fails**

```bash
cd src/raw-pipeline && cargo test -p pano-core --test alicevision_backend write_camera_init_sfm_produces_valid_json
```

Expected: compile error — `sfm_data` module doesn't exist yet.

- [ ] **Step 2.2.4: Implement `sfm_data.rs`**

```rust
//! Minimum SfMData v1.2.7 JSON writer for AliceVision pano init.
//!
//! We only emit the fields the panorama pipeline reads:
//! - top-level `version` triple
//! - per-image `views[]`
//! - per-image `intrinsics[]` (assumes one intrinsic per image —
//!   correct for DJI panos where every frame is from the same lens)
//! - per-image `poses[]` (initial rotation from gimbal Euler angles).
//!
//! The Euler→rotation convention follows AliceVision's:
//! R = Rz(roll) · Rx(pitch) · Ry(yaw) — verify against
//! `aliceVision_cameraInit --useExifCameraOrientation` output on a
//! known fixture during Phase 1.

use std::path::{Path, PathBuf};

use nalgebra::Matrix3;
use serde::Serialize;

use crate::error::PanoError;

/// One image's worth of SfMData input.
#[derive(Debug, Clone)]
pub struct SfmInput {
    pub path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub focal_pixels: f32,
    pub yaw_deg: f32,
    pub pitch_deg: f32,
    pub roll_deg: f32,
}

/// Convert DJI Euler angles (yaw around Y, pitch around X, roll
/// around Z) to a 3×3 rotation matrix in AliceVision's convention.
pub fn euler_to_rotation(yaw_deg: f32, pitch_deg: f32, roll_deg: f32) -> Matrix3<f64> {
    let yaw = (yaw_deg as f64).to_radians();
    let pitch = (pitch_deg as f64).to_radians();
    let roll = (roll_deg as f64).to_radians();
    let rz = Matrix3::new(
        roll.cos(), -roll.sin(), 0.0,
        roll.sin(),  roll.cos(), 0.0,
        0.0,         0.0,        1.0,
    );
    let rx = Matrix3::new(
        1.0, 0.0,           0.0,
        0.0, pitch.cos(), -pitch.sin(),
        0.0, pitch.sin(),  pitch.cos(),
    );
    let ry = Matrix3::new(
         yaw.cos(), 0.0, yaw.sin(),
         0.0,       1.0, 0.0,
        -yaw.sin(), 0.0, yaw.cos(),
    );
    rz * rx * ry
}

#[derive(Serialize)]
struct SfmDataDoc {
    version: [&'static str; 3],
    views: Vec<View>,
    intrinsics: Vec<Intrinsic>,
    poses: Vec<Pose>,
    #[serde(rename = "featuresFolders")]
    features_folders: Vec<String>,
    #[serde(rename = "matchesFolders")]
    matches_folders: Vec<String>,
}

#[derive(Serialize)]
struct View {
    #[serde(rename = "viewId")]
    view_id: String,
    #[serde(rename = "poseId")]
    pose_id: String,
    #[serde(rename = "intrinsicId")]
    intrinsic_id: String,
    width: String,
    height: String,
    path: String,
}

#[derive(Serialize)]
struct Intrinsic {
    #[serde(rename = "intrinsicId")]
    intrinsic_id: String,
    width: String,
    height: String,
    #[serde(rename = "sensorWidth")]
    sensor_width: String,
    #[serde(rename = "sensorHeight")]
    sensor_height: String,
    #[serde(rename = "type")]
    intrinsic_type: String,
    #[serde(rename = "pxInitialFocalLength")]
    px_initial_focal_length: String,
    #[serde(rename = "pxFocalLength")]
    px_focal_length: String,
    #[serde(rename = "principalPoint")]
    principal_point: [String; 2],
    #[serde(rename = "distortionParams")]
    distortion_params: Vec<String>,
}

#[derive(Serialize)]
struct Pose {
    #[serde(rename = "poseId")]
    pose_id: String,
    pose: PoseInner,
}

#[derive(Serialize)]
struct PoseInner {
    transform: PoseTransform,
    locked: String,
}

#[derive(Serialize)]
struct PoseTransform {
    rotation: [String; 9],
    center: [String; 3],
}

pub fn write_camera_init_sfm(out: &Path, inputs: &[SfmInput]) -> Result<(), PanoError> {
    let mut views = Vec::with_capacity(inputs.len());
    let mut intrinsics = Vec::with_capacity(inputs.len());
    let mut poses = Vec::with_capacity(inputs.len());

    for (i, input) in inputs.iter().enumerate() {
        let id = (i as u64 + 1).to_string();
        let path = input
            .path
            .canonicalize()
            .unwrap_or_else(|_| input.path.clone())
            .to_string_lossy()
            .into_owned();

        views.push(View {
            view_id: id.clone(),
            pose_id: id.clone(),
            intrinsic_id: id.clone(),
            width: input.width.to_string(),
            height: input.height.to_string(),
            path,
        });

        // Sensor size: DJI L2D-20c 4/3" sensor is ~17.3 × 13 mm.
        // Use a placeholder; AliceVision recomputes from focal pixels +
        // image width if `pxFocalLength` is set.
        intrinsics.push(Intrinsic {
            intrinsic_id: id.clone(),
            width: input.width.to_string(),
            height: input.height.to_string(),
            sensor_width: "36.0".into(),
            sensor_height: "24.0".into(),
            intrinsic_type: "pinhole".into(),
            px_initial_focal_length: input.focal_pixels.to_string(),
            px_focal_length: input.focal_pixels.to_string(),
            principal_point: [
                (input.width as f32 / 2.0).to_string(),
                (input.height as f32 / 2.0).to_string(),
            ],
            distortion_params: vec![],
        });

        let r = euler_to_rotation(input.yaw_deg, input.pitch_deg, input.roll_deg);
        let rotation = [
            r[(0, 0)].to_string(), r[(0, 1)].to_string(), r[(0, 2)].to_string(),
            r[(1, 0)].to_string(), r[(1, 1)].to_string(), r[(1, 2)].to_string(),
            r[(2, 0)].to_string(), r[(2, 1)].to_string(), r[(2, 2)].to_string(),
        ];
        poses.push(Pose {
            pose_id: id,
            pose: PoseInner {
                transform: PoseTransform {
                    rotation,
                    center: ["0".into(), "0".into(), "0".into()],
                },
                locked: "0".into(),
            },
        });
    }

    let doc = SfmDataDoc {
        version: ["1", "2", "7"],
        views,
        intrinsics,
        poses,
        features_folders: vec![],
        matches_folders: vec![],
    };

    let json = serde_json::to_string_pretty(&doc)
        .map_err(|e| PanoError::Other(format!("SfMData serialise: {e}")))?;
    std::fs::write(out, json)
        .map_err(|e| PanoError::Other(format!("write {}: {e}", out.display())))?;
    Ok(())
}
```

- [ ] **Step 2.2.5: Add `mod sfm_data; pub use sfm_data::{write_camera_init_sfm, SfmInput, euler_to_rotation};` to backends/alicevision/mod.rs**

- [ ] **Step 2.2.6: Run the test**

```bash
cd src/raw-pipeline && cargo test -p pano-core --test alicevision_backend write_camera_init_sfm_produces_valid_json
```

Expected: PASS.

- [ ] **Step 2.2.7: Add a test for `euler_to_rotation` (zero angles → identity, 90° yaw → known matrix)**

```rust
#[test]
fn euler_zero_angles_is_identity() {
    let r = pano_core::backends::alicevision::euler_to_rotation(0.0, 0.0, 0.0);
    let i = nalgebra::Matrix3::<f64>::identity();
    let max_diff = (r - i).abs().max();
    assert!(max_diff < 1e-9, "expected identity, got {r}");
}

#[test]
fn euler_90_yaw_rotates_x_to_minus_z() {
    let r = pano_core::backends::alicevision::euler_to_rotation(90.0, 0.0, 0.0);
    let v = nalgebra::Vector3::new(1.0, 0.0, 0.0);
    let v2 = r * v;
    // R_y(90) maps (1,0,0) -> (cos90, 0, -sin90) = (0, 0, -1)
    assert!((v2.x - 0.0).abs() < 1e-9, "x={}", v2.x);
    assert!((v2.y - 0.0).abs() < 1e-9, "y={}", v2.y);
    assert!((v2.z + 1.0).abs() < 1e-9, "z={}", v2.z);
}
```

- [ ] **Step 2.2.8: Run all tests**

```bash
cd src/raw-pipeline && cargo test -p pano-core
```

Expected: 117 + 3 = 120 pass.

- [ ] **Step 2.2.9: Commit**

```bash
git add src/raw-pipeline/pano-core/Cargo.toml \
        src/raw-pipeline/pano-core/src/backends/alicevision/sfm_data.rs \
        src/raw-pipeline/pano-core/src/backends/alicevision/mod.rs \
        src/raw-pipeline/pano-core/tests/alicevision_backend.rs
git commit -m "feat(pano): SfMData JSON writer with DJI gimbal Euler→rotation"
```

### Task 2.3: DJI XMP gimbal-angle reader

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/pano.rs` (extend `PanoIngest` with optional gimbal fields)
- Modify: `src/raw-pipeline/raw-core/src/pano.rs` (parse `drone-dji:Gimbal*Degree` from XMP)
- Modify: `src/raw-pipeline/raw-core/tests/` (add a fixture-gated test)

The `rawler` crate can extract XMP from DNG. Verify this is exposed; if not, fall back to reading the DNG TIFF tags directly (XMP is in tag 0x02BC). Document either way.

- [ ] **Step 2.3.1: Add gimbal fields to `PanoIngest`**

```rust
// in raw-core/src/pano.rs
pub struct PanoIngest {
    pub image: Image,
    pub orientation: ExifOrientation,
    pub camera_make: String,
    pub camera_model: String,
    /// Drone gimbal angles in degrees, when the source image is from
    /// a DJI drone (or any device that writes drone-dji XMP). `None`
    /// otherwise.
    pub gimbal: Option<GimbalAngles>,
}

#[derive(Debug, Clone, Copy)]
pub struct GimbalAngles {
    pub yaw_deg: f32,
    pub pitch_deg: f32,
    pub roll_deg: f32,
}
```

- [ ] **Step 2.3.2: Write the failing test**

In `raw-core/src/pano.rs` `#[cfg(test)] mod tests`:

```rust
#[test]
#[ignore] // fixture-gated — requires test-fixtures/raws/pano_01/
fn pano_01_dng_exposes_gimbal_angles() {
    let path = std::path::Path::new(
        "/Users/riabuz/Projects/_Maple/test-fixtures/raws/pano_01/PANO0001.DNG",
    );
    if !path.exists() { return; }
    let bytes = std::fs::read(path).unwrap();
    let ingest = decode_for_pano(&bytes, "dng").unwrap();
    let gimbal = ingest.gimbal.expect("expected gimbal angles in DJI DNG");
    assert!((gimbal.yaw_deg - 87.9).abs() < 0.5, "yaw={}", gimbal.yaw_deg);
    assert!((gimbal.pitch_deg + 1.3).abs() < 0.5, "pitch={}", gimbal.pitch_deg);
    assert!((gimbal.roll_deg - 0.0).abs() < 0.5, "roll={}", gimbal.roll_deg);
}
```

- [ ] **Step 2.3.3: Run the test (will fail at compile time first, then with #[ignore] it's a no-op)**

```bash
cd src/raw-pipeline && cargo test -p raw-core --lib pano::tests::pano_01_dng_exposes_gimbal_angles -- --ignored
```

Expected: FAIL with "expected gimbal angles in DJI DNG" (Option is None because we haven't implemented parsing yet).

- [ ] **Step 2.3.4: Implement XMP parse in `decode_for_pano`**

Use rawler's XMP accessor if it exists; otherwise read TIFF tag 0x02BC manually with the `tiff` crate (already a workspace dep). Find the `drone-dji:` namespace in the XMP packet and parse `GimbalYawDegree`, `GimbalPitchDegree`, `GimbalRollDegree` as f32. Use `quick-xml` (already a workspace dep) for the parse.

```rust
fn extract_gimbal_from_xmp(xmp: &str) -> Option<GimbalAngles> {
    let yaw = grep_dji_attr(xmp, "GimbalYawDegree")?;
    let pitch = grep_dji_attr(xmp, "GimbalPitchDegree")?;
    let roll = grep_dji_attr(xmp, "GimbalRollDegree")?;
    Some(GimbalAngles {
        yaw_deg: yaw,
        pitch_deg: pitch,
        roll_deg: roll,
    })
}

fn grep_dji_attr(xmp: &str, key: &str) -> Option<f32> {
    // DJI writes both <drone-dji:GimbalYawDegree>+87.9</drone-dji:GimbalYawDegree>
    // and as XML attributes. Cover both. Tolerant grep is enough — the
    // key is unique to the drone-dji namespace and the value is always
    // a signed decimal.
    let needle = format!("{key}");
    let idx = xmp.find(&needle)?;
    let after = &xmp[idx + needle.len()..];
    // Find the next signed decimal token after the key.
    let mut chars = after.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c == '+' || c == '-' || c.is_ascii_digit() { break; }
        chars.next();
    }
    let mut buf = String::new();
    for c in chars {
        if c == '+' || c == '-' || c.is_ascii_digit() || c == '.' || c == 'e' || c == 'E' {
            buf.push(c);
        } else if !buf.is_empty() {
            break;
        }
    }
    buf.parse().ok()
}
```

Wire this into `decode_for_pano`: after `decode_bytes`, get the raw bytes of the embedded XMP packet (rawler exposes it; or fall back to a TIFF tag lookup). Pass to `extract_gimbal_from_xmp`. Set `ingest.gimbal = Some(...)` if found.

- [ ] **Step 2.3.5: Re-run the gimbal test**

```bash
cd src/raw-pipeline && cargo test -p raw-core --lib pano:: -- --ignored
```

Expected: PASS.

- [ ] **Step 2.3.6: Commit**

```bash
git add src/raw-pipeline/raw-core/src/pano.rs
git commit -m "feat(raw-core): expose DJI gimbal angles via PanoIngest.gimbal"
```

### Task 2.4: AlicevisionBackend.stitch — invoke the pipeline

**Files:**
- Modify: `src/raw-pipeline/pano-core/src/backends/alicevision/mod.rs` (implement `stitch`)
- Modify: `src/raw-pipeline/pano-core/tests/alicevision_backend.rs` (add fixture-gated end-to-end test)

The `stitch` method drives the same Phase 1 CLI sequence, with the workdir under a `tempfile::TempDir`. Inputs are paths on disk (not `PanoImage` — AliceVision wants files; copying to disk first is a documented downside).

- [ ] **Step 2.4.1: Implement `stitch`**

```rust
// in backends/alicevision/mod.rs

use std::process::Command;

impl AlicevisionBackend {
    pub fn stitch(&self, input_paths: &[PathBuf]) -> Result<PanoImage, PanoError> {
        if input_paths.len() < 2 {
            return Err(PanoError::Other(format!(
                "need ≥2 inputs, got {}",
                input_paths.len()
            )));
        }

        let work = tempfile::TempDir::new()
            .map_err(|e| PanoError::Other(format!("tempdir: {e}")))?;

        // Build SfMData with gimbal priors from each input.
        let sfm_inputs = self.build_sfm_inputs(input_paths)?;
        let camera_init_sfm = work.path().join("cameraInit.sfm");
        sfm_data::write_camera_init_sfm(&camera_init_sfm, &sfm_inputs)?;

        // Stage 1: feature extraction.
        run(&self.bins.feature_extraction, &[
            "--input", &camera_init_sfm.to_string_lossy(),
            "--output", &work.path().join("features").to_string_lossy(),
            "--describerTypes", "sift",
            "--describerPreset", "normal",
        ])?;

        // ... repeat for matching, panoramaEstimation, panoramaWarping,
        //     panoramaSeams, panoramaCompositing, panoramaMerging,
        //     imageProcessing (EXR→PNG).

        let final_png = work.path().join("final.png");
        // imageProcessing produces it.

        // Read result back as a PanoImage in working color space.
        load_png_as_pano_image(&final_png)
    }

    fn build_sfm_inputs(&self, paths: &[PathBuf]) -> Result<Vec<sfm_data::SfmInput>, PanoError> {
        // Read each DNG, extract gimbal + image dims, build SfmInput.
        // Uses raw_core::decode_for_pano which now exposes .gimbal
        // (Task 2.3).
        let mut out = Vec::with_capacity(paths.len());
        for p in paths {
            let bytes = std::fs::read(p)
                .map_err(|e| PanoError::Other(format!("read {}: {e}", p.display())))?;
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .map(str::to_ascii_lowercase)
                .unwrap_or_default();
            let ingest = raw_core::decode_for_pano(&bytes, &ext)
                .map_err(|e| PanoError::Other(format!("ingest {}: {e}", p.display())))?;
            let g = ingest.gimbal.ok_or_else(|| {
                PanoError::Other(format!(
                    "no gimbal angles in {} (not a DJI capture?)",
                    p.display()
                ))
            })?;
            out.push(sfm_data::SfmInput {
                path: p.clone(),
                width: ingest.image.width,
                height: ingest.image.height,
                // Pixel focal estimate: image width is a sane prior for
                // ~horizontal-FOV captures; AliceVision refines it.
                focal_pixels: ingest.image.width as f32,
                yaw_deg: g.yaw_deg,
                pitch_deg: g.pitch_deg,
                roll_deg: g.roll_deg,
            });
        }
        Ok(out)
    }
}

fn run(bin: &Path, args: &[&str]) -> Result<(), PanoError> {
    let output = Command::new(bin).args(args).output().map_err(|e| {
        PanoError::Other(format!("spawn {}: {e}", bin.display()))
    })?;
    if !output.status.success() {
        return Err(PanoError::Other(format!(
            "{} failed (exit {}): {}",
            bin.file_name().unwrap_or_default().to_string_lossy(),
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(())
}

fn load_png_as_pano_image(path: &Path) -> Result<PanoImage, PanoError> {
    let bytes = std::fs::read(path)
        .map_err(|e| PanoError::Other(format!("read {}: {e}", path.display())))?;
    crate::ingest::decode_bytes(&bytes)
}
```

The `// repeat for ...` comment is a placeholder — fill it in inline with each `run(...)` call before committing. Use the exact CLI flags from Phase 1 Step 1.2.3–1.2.6 once those are confirmed working.

- [ ] **Step 2.4.2: Add a fixture-gated end-to-end test**

```rust
#[test]
#[ignore]
fn alicevision_stitches_pano_01() {
    let av_dir = match std::env::var("MAPLE_ALICEVISION_BIN") {
        Ok(v) => std::path::PathBuf::from(v),
        Err(_) => {
            // Default install location.
            let home = std::env::var("HOME").unwrap_or_default();
            std::path::PathBuf::from(format!("{home}/opt/alicevision/bin"))
        }
    };
    if !av_dir.exists() {
        eprintln!("AliceVision not installed; skipping");
        return;
    }
    let pano01 = std::path::Path::new(
        "/Users/riabuz/Projects/_Maple/test-fixtures/raws/pano_01",
    );
    if !pano01.exists() {
        eprintln!("pano_01 fixture absent; skipping");
        return;
    }

    let inputs: Vec<_> = (1..=21)
        .map(|i| pano01.join(format!("PANO{:04}.DNG", i)))
        .collect();

    let backend =
        pano_core::backends::alicevision::AlicevisionBackend::from_path(&av_dir).unwrap();
    let result = backend.stitch(&inputs).expect("stitch should succeed");
    assert!(result.width > 8000, "expected wide pano, got {}×{}", result.width, result.height);
    assert!(result.height > 4000, "expected tall pano, got {}×{}", result.width, result.height);
    let valid_frac = result.validity.count_ones() as f32
        / (result.width * result.height) as f32;
    assert!(
        valid_frac > 0.5,
        "expected most pixels valid, got {valid_frac}"
    );
}
```

- [ ] **Step 2.4.3: Run the gated test (skips if AV missing)**

```bash
cd src/raw-pipeline && cargo test -p pano-core --test alicevision_backend alicevision_stitches_pano_01 -- --ignored --nocapture
```

Expected (with AV installed): finishes in 5–20 minutes; produces a stitched PanoImage. Without AV installed: skips with "AliceVision not installed; skipping".

- [ ] **Step 2.4.4: Save the stitched output to test-fixtures for visual inspection**

The test could optionally write `test-fixtures/pano/pano_01_alicevision.png` for the engineer to open in Preview. Add this when the test first passes.

- [ ] **Step 2.4.5: Commit**

```bash
git add src/raw-pipeline/pano-core/src/backends/alicevision/mod.rs \
        src/raw-pipeline/pano-core/tests/alicevision_backend.rs
git commit -m "feat(pano): AlicevisionBackend.stitch — full subprocess pipeline"
```

---

## Phase 3 — pano-smoke wiring + harness

### Task 3.1: Add `--backend alicevision` flag to pano-smoke

**Files:**
- Modify: `src/raw-pipeline/pano-core/src/bin/pano-smoke.rs` (add `--backend` arg, dispatch)

- [ ] **Step 3.1.1: Add `Backend` enum + CLI arg**

```rust
#[derive(Debug, Clone, Copy, ValueEnum)]
enum Backend {
    Classical,
    Alicevision,
}

#[derive(Parser)]
struct Cli {
    // ... existing fields ...
    /// Backend to use. `classical` is the hand-rolled pure-Rust
    /// pipeline; `alicevision` shells out to the AliceVision binaries
    /// (build via docs/setup/alicevision-build.md).
    #[arg(long, default_value = "classical")]
    backend: Backend,
}
```

- [ ] **Step 3.1.2: Dispatch in `main`**

```rust
let result = if let Some(dir) = &cli.gen_fixtures {
    gen_fixtures(dir)
} else {
    let inputs = ...; // existing
    let output = ...;
    match cli.backend {
        Backend::Classical => stitch(&inputs, output, cli.max_dim),
        Backend::Alicevision => stitch_alicevision(&inputs, output),
    }
};
```

- [ ] **Step 3.1.3: Implement `stitch_alicevision`**

```rust
fn stitch_alicevision(inputs: &[PathBuf], output: &Path) -> Result<(), String> {
    let backend = pano_core::backends::alicevision::AlicevisionBackend::from_env()
        .map_err(|e| format!("init AV backend: {e}"))?;
    let result = backend
        .stitch(inputs)
        .map_err(|e| format!("AV stitch: {e}"))?;
    write_stitch(&result, output)
}
```

- [ ] **Step 3.1.4: Build + run on pano_01 manually**

```bash
cd src/raw-pipeline && cargo build --release -p pano-core --bin pano-smoke
PANO01=/Users/riabuz/Projects/_Maple/test-fixtures/raws/pano_01
./target/release/pano-smoke --backend alicevision \
  $PANO01/PANO0001.DNG $PANO01/PANO0002.DNG ... $PANO01/PANO0021.DNG \
  -o ../../test-fixtures/pano/pano_01_av.png
```

Expected: produces a ≥8K-wide spherical panorama PNG.

- [ ] **Step 3.1.5: Commit**

```bash
git add src/raw-pipeline/pano-core/src/bin/pano-smoke.rs
git commit -m "feat(pano): pano-smoke --backend alicevision"
```

### Task 3.2: Extend the harness to test both backends

**Files:**
- Modify: `src/scripts/test_pano_pipeline.sh` (loop over backends; skip AV when absent)

- [ ] **Step 3.2.1: Add `--backend BACKEND` flag to the script**

Default: classical (current behavior). When `--backend alicevision` is passed, the script invokes pano-smoke with that backend. When AV is requested but not installed, skip-pass with a clear message.

- [ ] **Step 3.2.2: Add an `all-backends` mode that runs both and compares ΔE**

```bash
src/scripts/test_pano_pipeline.sh --backend classical --max-delta-e 15
src/scripts/test_pano_pipeline.sh --backend alicevision --max-delta-e 5  # tighter — AV is the reference
```

- [ ] **Step 3.2.3: Commit**

```bash
git add src/scripts/test_pano_pipeline.sh
git commit -m "feat(pano): harness supports --backend (classical | alicevision)"
```

---

## Phase 4 — Apple bundling strategy (planning only, no code)

### Task 4.1: Document the macOS bundling path

**Files:**
- Create: `docs/superpowers/specs/2026-04-28-pano-alicevision-apple-bundling.md`

- [ ] **Step 4.1.1: Write the design doc**

Cover:
- macOS .app bundling: ship the 10 AliceVision binaries inside `Maple.app/Contents/Helpers/AliceVision/`. The app's panorama feature invokes them via `Bundle.main.url(forAuxiliaryExecutable:)`. Embedded binaries link against vendored vcpkg-built libraries also inside the bundle (or use `@rpath/@executable_path` linkage).
- Code signing: each binary needs a Developer ID signature with the team-id Maple is signed under. Hardened runtime entitlements: `com.apple.security.cs.allow-jit` should NOT be needed for AliceVision; check whether `disable-library-validation` is needed for the vendored OpenCV/Boost.
- Notarization: the binaries are notarised together with the app. AliceVision binaries use TBB / OpenMP — document any notarisation gotchas.
- iOS: AliceVision has not been ported to iOS. The dependency tree (Boost, OpenCV, Ceres, OpenMVG, OpenImageIO, Alembic) is largely portable but no one has done the work. Three options:
  1. Defer iOS panorama feature; ship Mac-first
  2. Server-side rendering (iOS app uploads images, server stitches, returns)
  3. Native port (multi-month effort)
- WASM: even less feasible than iOS. Document as out-of-scope.

- [ ] **Step 4.1.2: Commit**

```bash
git add docs/superpowers/specs/2026-04-28-pano-alicevision-apple-bundling.md
git commit -m "docs(pano): Apple bundling strategy for AliceVision backend"
```

---

## Phase 5 — Update the task plan + retire hand-rolled tech debt

### Task 5.1: Update task plan v0.3 status snapshot

**Files:**
- Modify: `docs/tasks/04-maple-panorama-spec.md`

- [ ] **Step 5.1.1: Add a new top-level note**

> "AliceVision integration ships as the production panorama backend on
> macOS (subprocess CLI pipeline, see commits ...). The hand-rolled
> Rust pipeline (P1–P3 work in `pano-core`) is retained as a fallback
> for synthetic tests and as the path forward for iOS / WASM where
> AliceVision can't be bundled. Status points #11 (BA rotation-only)
> and the iterative-chain note become moot for the macOS production
> path; they remain relevant for the Rust fallback path."

- [ ] **Step 5.1.2: Commit**

```bash
git add docs/tasks/04-maple-panorama-spec.md
git commit -m "docs(pano): task plan v0.3 — AliceVision is the production macOS backend"
```

---

## Self-review checklist (run before handing off)

- **Spec coverage:** every step in Phase 1 produces a verifiable artifact. Phase 2 has tests that gate on AV being installed. Phase 3 has manual + harness verification. Phase 4 is planning-only and explicitly avoids code. Phase 5 is documentation hygiene.
- **Placeholder scan:** the only "TBD" is the `// repeat for ...` comment in Step 2.4.1 — that's intentional because the exact AliceVision CLI flags must be locked in by Phase 1's Step 1.2.3–1.2.6. The plan calls this out explicitly.
- **Type consistency:** `SfmInput`, `GimbalAngles`, `AlicevisionBackend`, `AlicevisionBinaries` are defined once and referenced by the same names throughout.

## Risks worth calling out

- **Phase 1 may fail outright.** AliceVision's macOS build via vcpkg is known to be flaky on Apple Silicon. If Step 1.1.3 (vcpkg dependency build) takes more than a day or hits unrecoverable errors, the engineer should escalate before continuing — there's no point writing a Rust wrapper if the binaries won't build.
- **AliceVision may not handle DJI metadata as expected.** Phase 1 Step 1.2.6 (the visual gate) will catch this. If the output isn't a real panorama, the fix may be a different `--useExifCameraOrientation` flag, or pre-processing to normalise XMP, or building with `ALICEVISION_HAVE_OPENCV=ON` for additional intrinsics support.
- **Subprocess overhead.** Each pipeline invocation takes seconds for AliceVision to start (loading shared libraries). For the 21-image pano_01 set, total stitch time is likely 10–30 minutes. Acceptable for a one-shot batch process; not interactive. If Maple's UX expects "click → see preview in seconds," this won't fit and the architecture needs to change (e.g., the new Python bindings might allow a single in-process call).
- **Apple bundling pulls in 200+ MB of dependencies.** AliceVision + OpenCV + Boost + Ceres + OpenMVG + OIIO is heavy. Phase 4 surfaces this as a documented trade-off.
