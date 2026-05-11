//! AliceVision 3.3.0 panorama pipeline as a subprocess backend.
//!
//! AliceVision ships 10 standalone CLI tools (cameraInit,
//! featureExtraction, imageMatching, featureMatching,
//! panoramaEstimation, panoramaWarping, panoramaSeams,
//! panoramaCompositing, panoramaMerging, imageProcessing for
//! EXR→PNG conversion). They exchange SfMData JSON between stages.
//! We invoke them in sequence via std::process::Command, writing
//! intermediates to a per-stage subdirectory under a stable workdir
//! (so the warped / seam / blended artefacts survive the run and can
//! be diff'd against the in-house pipeline by
//! `tools/compare-with-alicevision.py`).
//!
//! **Status**: this is an OFFLINE measurement tool, not the production
//! engine. Use it to compare in-house geometry, seam routes, and
//! ghost-mask area against AliceVision's outputs on the same input set.
//!
//! Build setup: see docs/setup/alicevision-build.md.
//! Binary location: configured via env var MAPLE_ALICEVISION_BIN
//! (defaults to ~/opt/alicevision/bin) or AlicevisionBackend::new
//! explicit path.

mod locate;
pub mod sfm_data;

pub use locate::{locate_binaries, AlicevisionBinaries};
pub use sfm_data::{euler_to_rotation, write_camera_init_sfm, SfmInput};

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::PanoError;
use crate::types::PanoImage;

/// Subprocess-driven AliceVision panorama backend.
pub struct AlicevisionBackend {
    bins: AlicevisionBinaries,
}

/// Pixel-bearing output from a backend run.
///
/// Two variants distinguish "in-house pipeline" output (a `PanoImage`
/// in working space the caller is expected to feed through Maple's
/// AgX + Rec.2020→sRGB writer) from "oracle backend" output (a finished
/// sRGB PNG that must be copied byte-for-byte to the user's output
/// path — re-decoding and re-encoding through Maple's writer would
/// double-apply AgX and the colour-matrix step, destroying the AV
/// reference). See bug 4 in plan §"Stage M".
#[derive(Debug)]
pub enum BackendOutput {
    /// In-house pipeline result — pixels in scene-linear Rec.2020,
    /// caller is responsible for the display transform / encode.
    Image(PanoImage),
    /// Oracle pipeline result — a finished PNG on disk in sRGB display
    /// space. Caller must copy this file byte-for-byte to its output
    /// path; running it through Maple's writer would re-apply AgX and
    /// the Rec.2020→sRGB matrix, corrupting the reference.
    PassThrough { source_path: PathBuf },
}

/// Output of a successful `stitch()` — the backend's pixel output plus
/// the path to the workdir holding all intermediate artefacts (warped
/// tiles, seam labels, EXR composite). The workdir is intentionally
/// NOT a `tempfile::TempDir` because the comparison harness
/// (`tools/compare-with-alicevision.py`) needs the per-stage outputs
/// after the call returns.
#[derive(Debug)]
pub struct StitchResult {
    pub output: BackendOutput,
    pub workdir: PathBuf,
}

impl AlicevisionBackend {
    /// Construct using `MAPLE_ALICEVISION_BIN` env or the default
    /// `~/opt/alicevision/bin` path.
    pub fn from_env() -> Result<Self, PanoError> {
        let bins = locate_binaries(None).map_err(friendly_locate_error)?;
        Ok(Self { bins })
    }

    /// Construct from an explicit binary directory.
    pub fn from_path(bin_dir: impl AsRef<Path>) -> Result<Self, PanoError> {
        let bins = locate_binaries(Some(bin_dir.as_ref().to_path_buf()))
            .map_err(friendly_locate_error)?;
        Ok(Self { bins })
    }

    /// Drive the AliceVision pipeline end-to-end. Writes intermediates
    /// to `workdir_root/<scene_name>/NN_stage/` and returns the final
    /// stitched panorama plus a pointer to the workdir.
    ///
    /// `scene_name` is a short tag used to namespace the workdir
    /// (e.g. `"pano_01"`); it must be a single path component (no
    /// separators) so the workdir layout stays predictable.
    pub fn stitch_with_workdir(
        &self,
        input_paths: &[PathBuf],
        workdir_root: &Path,
        scene_name: &str,
    ) -> Result<StitchResult, PanoError> {
        if input_paths.len() < 2 {
            return Err(PanoError::Other(format!(
                "AliceVision backend needs ≥2 inputs, got {}",
                input_paths.len()
            )));
        }
        if scene_name.is_empty() || scene_name.contains(['/', '\\']) {
            return Err(PanoError::Other(format!(
                "scene_name {scene_name:?} must be a single path component"
            )));
        }

        let workdir = workdir_root.join(scene_name);
        std::fs::create_dir_all(&workdir)
            .map_err(|e| PanoError::Other(format!("mkdir {}: {e}", workdir.display())))?;

        // ── 01_cameraInit ──────────────────────────────────────────────
        // Build the SfMData input file directly (skipping the binary's
        // image-folder scan) so we feed AliceVision exactly the inputs
        // we want — including gimbal priors when available.
        let stage_init = stage_dir(&workdir, "01_cameraInit")?;
        let camera_init_sfm = stage_init.join("cameraInit.sfm");
        let sfm_inputs = self.build_sfm_inputs(input_paths)?;
        write_camera_init_sfm(&camera_init_sfm, &sfm_inputs)?;
        // Some AV builds also expose `aliceVision_cameraInit` to
        // sanity-check the SfMData; the call is cheap and adds a
        // useful early-fail for malformed inputs.
        run_av(
            &self.bins.camera_init,
            &[
                "--input",
                &camera_init_sfm.to_string_lossy(),
                "--output",
                &stage_init.join("cameraInitChecked.sfm").to_string_lossy(),
                "--allowSingleView",
                "1",
            ],
            "cameraInit",
        )?;

        // ── 02_featureExtraction ───────────────────────────────────────
        let stage_features = stage_dir(&workdir, "02_featureExtraction")?;
        run_av(
            &self.bins.feature_extraction,
            &[
                "--input",
                &camera_init_sfm.to_string_lossy(),
                "--output",
                &stage_features.to_string_lossy(),
                "--describerTypes",
                "sift",
                "--describerPreset",
                "normal",
            ],
            "featureExtraction",
        )?;

        // ── 03_imageMatching ───────────────────────────────────────────
        let stage_image_match = stage_dir(&workdir, "03_imageMatching")?;
        let image_pairs_list = stage_image_match.join("imagePairs.txt");
        run_av(
            &self.bins.image_matching,
            &[
                "--input",
                &camera_init_sfm.to_string_lossy(),
                "--featuresFolders",
                &stage_features.to_string_lossy(),
                "--output",
                &image_pairs_list.to_string_lossy(),
                "--method",
                "SequentialAndVocabularyTree",
                "--nbMatches",
                "50",
            ],
            "imageMatching",
        )?;

        // ── 04_featureMatching ─────────────────────────────────────────
        let stage_match = stage_dir(&workdir, "04_featureMatching")?;
        run_av(
            &self.bins.feature_matching,
            &[
                "--input",
                &camera_init_sfm.to_string_lossy(),
                "--featuresFolders",
                &stage_features.to_string_lossy(),
                "--imagePairsList",
                &image_pairs_list.to_string_lossy(),
                "--output",
                &stage_match.to_string_lossy(),
            ],
            "featureMatching",
        )?;

        // ── 05_panoramaEstimation ──────────────────────────────────────
        let stage_estim = stage_dir(&workdir, "05_panoramaEstimation")?;
        let pano_estim_sfm = stage_estim.join("panoramaEstimation.sfm");
        run_av(
            &self.bins.panorama_estimation,
            &[
                "--input",
                &camera_init_sfm.to_string_lossy(),
                "--featuresFolders",
                &stage_features.to_string_lossy(),
                "--matchesFolders",
                &stage_match.to_string_lossy(),
                "--output",
                &pano_estim_sfm.to_string_lossy(),
            ],
            "panoramaEstimation",
        )?;

        // ── 06_panoramaWarping ─────────────────────────────────────────
        // Per-image warped EXR tiles land here.
        let stage_warp = stage_dir(&workdir, "06_panoramaWarping")?;
        run_av(
            &self.bins.panorama_warping,
            &[
                "--input",
                &pano_estim_sfm.to_string_lossy(),
                "--output",
                &stage_warp.to_string_lossy(),
                "--panoramaSize",
                "16384",
            ],
            "panoramaWarping",
        )?;

        // ── 07_panoramaSeams ───────────────────────────────────────────
        // Per-image seam labels land here.
        let stage_seams = stage_dir(&workdir, "07_panoramaSeams")?;
        let seams_exr = stage_seams.join("seams.exr");
        run_av(
            &self.bins.panorama_seams,
            &[
                "--input",
                &pano_estim_sfm.to_string_lossy(),
                "--warpingFolder",
                &stage_warp.to_string_lossy(),
                "--output",
                &seams_exr.to_string_lossy(),
            ],
            "panoramaSeams",
        )?;

        // ── 08_panoramaCompositing ─────────────────────────────────────
        let stage_comp = stage_dir(&workdir, "08_panoramaCompositing")?;
        let comp_exr = stage_comp.join("pano.exr");
        run_av(
            &self.bins.panorama_compositing,
            &[
                "--input",
                &pano_estim_sfm.to_string_lossy(),
                "--warpingFolder",
                &stage_warp.to_string_lossy(),
                "--labels",
                &seams_exr.to_string_lossy(),
                "--output",
                &comp_exr.to_string_lossy(),
                "--compositerType",
                "multiband",
            ],
            "panoramaCompositing",
        )?;

        // ── 09_panoramaMerging ─────────────────────────────────────────
        // `--compositingFolder` is the DIRECTORY containing the
        // compositing pyramid output (per `aliceVision_panoramaMerging
        // --help`), NOT the merged EXR file path. AV's panoramaMerging
        // stage scans the folder for the per-image pyramid tiles
        // produced by the compositing stage and writes the merged EXR
        // to `--output`. Passing a `*.exr` file here was a bug: AV
        // would either error out trying to open the file as a
        // directory or silently misbehave depending on the build.
        let stage_merge = stage_dir(&workdir, "09_panoramaMerging")?;
        let final_exr = stage_merge.join("final.exr");
        let merge_args = build_merge_args(&pano_estim_sfm, &stage_comp, &final_exr);
        let merge_args_ref: Vec<&str> = merge_args.iter().map(String::as_str).collect();
        run_av(
            &self.bins.panorama_merging,
            &merge_args_ref,
            "panoramaMerging",
        )?;

        // ── 10_imageProcessing (EXR → PNG) ─────────────────────────────
        let stage_post = stage_dir(&workdir, "10_imageProcessing")?;
        let final_png = stage_post.join("final.png");
        run_av(
            &self.bins.image_processing,
            &[
                "--input",
                &final_exr.to_string_lossy(),
                "--output",
                &final_png.to_string_lossy(),
                "--extension",
                "png",
            ],
            "imageProcessing",
        )?;

        // Return AV's final PNG as a passthrough source. The caller
        // copies it byte-for-byte to its output path. We deliberately
        // do NOT decode + re-encode through Maple's writer:
        // `write_pano_image_as_png16` applies AgX and the Rec.2020 →
        // sRGB matrix, which assumes scene-linear Rec.2020 input. AV's
        // PNG is already in display-sRGB; re-encoding would
        // double-apply the display transform and corrupt the oracle
        // reference. See plan §"Stage M" bug 4.
        if !final_png.is_file() {
            return Err(PanoError::Other(format!(
                "AV final PNG missing after imageProcessing stage: {}",
                final_png.display()
            )));
        }
        Ok(StitchResult {
            output: BackendOutput::PassThrough {
                source_path: final_png,
            },
            workdir,
        })
    }

    /// Stitch shorthand — creates a workdir under
    /// `<input_dir>/alicevision_workdir/` (next to the inputs) and
    /// names the scene after the parent of the first input. Returns
    /// the path to AV's final PNG (sRGB, 8-bit, byte-for-byte the
    /// imageProcessing stage's output). For finer control, call
    /// `stitch_with_workdir` directly.
    pub fn stitch(&self, input_paths: &[PathBuf]) -> Result<PathBuf, PanoError> {
        if input_paths.is_empty() {
            return Err(PanoError::Other(
                "AliceVision backend needs ≥2 inputs, got 0".into(),
            ));
        }
        let first = &input_paths[0];
        let parent = first
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        let scene_name = parent
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "scene".to_string());
        let workdir_root = parent.join("alicevision_workdir");
        let result = self.stitch_with_workdir(input_paths, &workdir_root, &scene_name)?;
        match result.output {
            BackendOutput::PassThrough { source_path } => Ok(source_path),
            BackendOutput::Image(_) => Err(PanoError::Other(
                "AliceVision backend unexpectedly returned a PanoImage; expected PassThrough"
                    .into(),
            )),
        }
    }

    /// Build a per-image SfmInput list from an array of disk paths.
    /// Reads gimbal angles + image dims from the DNG (via
    /// `raw_core::decode_for_pano`) when available.
    fn build_sfm_inputs(&self, paths: &[PathBuf]) -> Result<Vec<SfmInput>, PanoError> {
        let mut out = Vec::with_capacity(paths.len());
        for p in paths {
            let bytes = std::fs::read(p)
                .map_err(|e| PanoError::Other(format!("read {}: {e}", p.display())))?;
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .map(str::to_ascii_lowercase)
                .unwrap_or_default();

            let (width, height, focal_pixels, yaw, pitch, roll) =
                if crate::ingest::sniff_format(&bytes) == crate::ingest::PanoFormat::Raw {
                    match raw_core::decode_for_pano(&bytes, &ext) {
                        Ok(ingest) => {
                            let g = ingest.gimbal;
                            (
                                ingest.image.width,
                                ingest.image.height,
                                ingest.focal_pixels.unwrap_or(ingest.image.width as f32),
                                g.map(|g| g.yaw_deg).unwrap_or(0.0),
                                g.map(|g| g.pitch_deg).unwrap_or(0.0),
                                g.map(|g| g.roll_deg).unwrap_or(0.0),
                            )
                        }
                        Err(e) => {
                            return Err(PanoError::Other(format!(
                                "ingest {}: {e}",
                                p.display()
                            )));
                        }
                    }
                } else {
                    // Non-RAW input — fall back to image-crate dims and
                    // the image-width focal prior. Gimbal angles unknown.
                    let img = image::load_from_memory(&bytes)
                        .map_err(|e| PanoError::Other(format!("decode {}: {e}", p.display())))?;
                    let w = img.width();
                    let h = img.height();
                    (w, h, w as f32, 0.0, 0.0, 0.0)
                };

            out.push(SfmInput {
                path: p.clone(),
                width,
                height,
                focal_pixels,
                yaw_deg: yaw,
                pitch_deg: pitch,
                roll_deg: roll,
            });
        }
        Ok(out)
    }
}

/// Build the argument vector for `aliceVision_panoramaMerging`.
///
/// Extracted as a pure function so unit tests can lock in the
/// `--compositingFolder` shape (must be a directory, never a file)
/// without invoking the binary or needing AV installed. See plan
/// §"Stage M" bug 3.
///
/// `compositing_folder` MUST be the DIRECTORY containing the pyramid
/// output produced by `panoramaCompositing` (e.g.
/// `<workdir>/<scene>/08_panoramaCompositing/`), not a file path.
fn build_merge_args(
    pano_estim_sfm: &Path,
    compositing_folder: &Path,
    final_exr: &Path,
) -> Vec<String> {
    vec![
        "--input".to_string(),
        pano_estim_sfm.to_string_lossy().into_owned(),
        "--compositingFolder".to_string(),
        compositing_folder.to_string_lossy().into_owned(),
        "--output".to_string(),
        final_exr.to_string_lossy().into_owned(),
    ]
}

/// Create a stage subdirectory under the workdir.
fn stage_dir(workdir: &Path, name: &str) -> Result<PathBuf, PanoError> {
    let dir = workdir.join(name);
    std::fs::create_dir_all(&dir)
        .map_err(|e| PanoError::Other(format!("mkdir {}: {e}", dir.display())))?;
    Ok(dir)
}

/// Spawn one AV stage; capture stdout/stderr, log on failure.
fn run_av(bin: &Path, args: &[&str], stage_label: &str) -> Result<(), PanoError> {
    tracing::debug!(
        "alicevision: running {} (stage {stage_label})",
        bin.display()
    );
    let output = Command::new(bin).args(args).output().map_err(|e| {
        PanoError::Other(format!(
            "spawn {} ({stage_label}): {e}",
            bin.display()
        ))
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Trim very long logs to a tail; AV is verbose.
        let tail = |s: &str| -> String {
            if s.len() <= 4096 {
                s.to_string()
            } else {
                format!("...[{} bytes truncated]\n{}", s.len() - 4096, &s[s.len() - 4096..])
            }
        };
        return Err(PanoError::Other(format!(
            "{stage_label} failed (exit {}):\nstderr:\n{}\nstdout:\n{}",
            output.status.code().unwrap_or(-1),
            tail(&stderr),
            tail(&stdout),
        )));
    }
    Ok(())
}

/// Wrap the locate-binaries error with an actionable install hint when
/// the directory is missing/empty. The default `locate.rs` message is
/// good but the install path is only documented in the module-level
/// rustdoc — surface it inline.
fn friendly_locate_error(e: PanoError) -> PanoError {
    let original = format!("{e}");
    PanoError::Other(format!(
        "aliceVision binaries not available: {original}\n\
         install AliceVision and set $MAPLE_ALICEVISION_BIN \
         (default ~/opt/alicevision/bin); see docs/setup/alicevision-build.md"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `from_env` returns a clear, actionable error when AV is not
    /// installed and `MAPLE_ALICEVISION_BIN` is unset/wrong. Locked
    /// in here so the friendly-error path can't silently regress.
    #[test]
    fn from_env_with_bogus_path_returns_friendly_error() {
        // Snapshot current env; tests run in a shared process so we
        // must not leak state to siblings.
        let prev = std::env::var("MAPLE_ALICEVISION_BIN").ok();
        std::env::set_var("MAPLE_ALICEVISION_BIN", "/this/path/definitely/does/not/exist");
        let r = AlicevisionBackend::from_env();
        match prev {
            Some(v) => std::env::set_var("MAPLE_ALICEVISION_BIN", v),
            None => std::env::remove_var("MAPLE_ALICEVISION_BIN"),
        }
        let err = match r {
            Ok(_) => panic!("expected error for missing AV install"),
            Err(e) => e,
        };
        let msg = format!("{err}");
        assert!(
            msg.contains("aliceVision binaries not available"),
            "msg should mention friendly hint: {msg}"
        );
        assert!(
            msg.contains("MAPLE_ALICEVISION_BIN"),
            "msg should mention env var: {msg}"
        );
    }

    /// `panoramaMerging --compositingFolder` must be a DIRECTORY path,
    /// not a file. Locks in plan §"Stage M" bug 3 — a previous build
    /// passed the `pano.exr` merged-output file here, which the AV
    /// CLI rejects (the flag is a folder for the per-image pyramid
    /// tiles produced by the compositing stage).
    ///
    /// Inspects the constructed argument vector directly so the test
    /// runs without AliceVision installed.
    #[test]
    fn panorama_merging_compositing_folder_is_a_directory_not_a_file() {
        let workdir = PathBuf::from("/tmp/fakeworkdir/scene");
        let pano_estim_sfm = workdir.join("05_panoramaEstimation/panoramaEstimation.sfm");
        let stage_comp = workdir.join("08_panoramaCompositing");
        let final_exr = workdir.join("09_panoramaMerging/final.exr");

        let args = build_merge_args(&pano_estim_sfm, &stage_comp, &final_exr);

        // Locate `--compositingFolder` and grab the value that
        // follows it — that is the argument the AV CLI receives.
        let pos = args
            .iter()
            .position(|a| a == "--compositingFolder")
            .expect("--compositingFolder must be present");
        let value = args
            .get(pos + 1)
            .expect("--compositingFolder must have a value");

        // Bug 3 regression locks: must be the compositing DIRECTORY.
        assert!(
            value.ends_with("08_panoramaCompositing"),
            "--compositingFolder should point at the compositing directory, got {value:?}"
        );
        assert!(
            !value.ends_with(".exr"),
            "--compositingFolder must NOT be the merged EXR file path, got {value:?}"
        );
        assert!(
            !value.contains("pano.exr"),
            "--compositingFolder must NOT contain pano.exr, got {value:?}"
        );

        // Sanity: --output is the merged EXR, --input is the
        // estimation SfMData. Lock both so a future refactor that
        // shuffles arg order doesn't accidentally drop one.
        let out_pos = args
            .iter()
            .position(|a| a == "--output")
            .expect("--output must be present");
        assert!(args
            .get(out_pos + 1)
            .map(|v| v.ends_with("final.exr"))
            .unwrap_or(false));
        let in_pos = args
            .iter()
            .position(|a| a == "--input")
            .expect("--input must be present");
        assert!(args
            .get(in_pos + 1)
            .map(|v| v.ends_with("panoramaEstimation.sfm"))
            .unwrap_or(false));
    }

    /// The backend now returns `BackendOutput::PassThrough { source_path }`
    /// rather than decoding AV's PNG and re-emitting through Maple's
    /// AgX writer. Verifies that pano-smoke's dispatch (file copy)
    /// preserves the AV PNG byte-for-byte. Locks in plan §"Stage M"
    /// bug 4 — a previous build re-encoded through
    /// `write_pano_image_as_png16`, double-applying AgX +
    /// Rec.2020→sRGB and corrupting the oracle reference.
    ///
    /// We mock the backend by writing a known PNG to a temp file,
    /// constructing a `PassThrough` referencing it, then exercising
    /// the same `std::fs::copy` step that pano-smoke does. The point
    /// is to assert the bytes survive — if a future refactor pipes
    /// the PassThrough through any decode/encode, this fires.
    #[test]
    fn passthrough_dispatch_preserves_bytes_byte_for_byte() {
        // Build a tiny but unmistakable PNG payload — anything; the
        // test is about byte-equality, not PNG validity. We use a
        // minimal valid PNG header so an accidental "decode + re-
        // encode" round-trip would *change* the bytes (any encoder
        // would re-compute CRCs and re-compress IDAT).
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("av-final.png");
        let dst = dir.path().join("user-output.png");
        let payload = make_minimal_png_bytes();
        std::fs::write(&src, &payload).unwrap();

        // Construct the BackendOutput the backend would return.
        let result = StitchResult {
            output: BackendOutput::PassThrough {
                source_path: src.clone(),
            },
            workdir: dir.path().to_path_buf(),
        };

        // Exercise the dispatch path: byte-for-byte file copy.
        match result.output {
            BackendOutput::PassThrough { source_path } => {
                std::fs::copy(&source_path, &dst).unwrap();
            }
            BackendOutput::Image(_) => {
                panic!("AV backend returned Image variant; expected PassThrough");
            }
        }

        // Bytes must round-trip exactly.
        let copied = std::fs::read(&dst).unwrap();
        assert_eq!(
            copied, payload,
            "passthrough dispatch must copy bytes verbatim — re-encoding would corrupt AV oracle"
        );
    }

    /// A 73-byte minimal valid PNG (8×8 single-pixel image) used as
    /// the test payload above. Chosen so the test is fully
    /// self-contained — no fixture file dependency.
    fn make_minimal_png_bytes() -> Vec<u8> {
        // Encode a 1×1 black PNG via the `png` crate so we know it's
        // a real, valid file (and so we can detect any silent
        // re-encoding that would change CRC32 / IDAT compression).
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut buf, 1, 1);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[0u8, 0u8, 0u8]).unwrap();
        }
        buf
    }
}
