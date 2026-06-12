//! `maple-cli pano stitch` (#1182) — the end-to-end panorama pipeline:
//! decode → priors → proxy → ALIKED+LightGlue → match graph → global BA
//! → leveling → composite → 16-bit linear PNG (+ optional sRGB preview)
//! + a `StitchReport`-shaped JSON.
//!
//! This subcommand is the **operator surface** the regression harness
//! probes for (`src/scripts/test_pano_pipeline.sh`'s activation
//! contract): unlike the harness it never skip-passes — a missing ML
//! environment is a hard, actionable error.
//!
//! The PNG output is the *linear* composite (scene-linear Rec.2020 —
//! the values the linear-DNG writer of spec step 9 will carry);
//! `--display` additionally writes an sRGB-encoded preview for
//! eyeballing.

use std::path::{Path, PathBuf};
use std::time::Instant;

use clap::{Args, Subcommand};

use maple_pano::ba::{self, BaOptions};
use maple_pano::camera::Camera;
use maple_pano::canvas::{CanvasOptions, ProjectionMode};
use maple_pano::composite::{composite, CompositeOptions};
use maple_pano::features::{AlikedDetector, DetectorOptions, FeatureSet, LinearRgbFrame};
use maple_pano::glue::{ml_matches_to_correspondences, DEFAULT_MIN_SCORE};
use maple_pano::graph::{build_match_graph, CaptureOrderProvider, GimbalPriorProvider, GraphImage};
use maple_pano::ingest::{ingest_file, proxy_to_long_edge, IngestedFrame, PlanarImage};
use maple_pano::leveling;
use maple_pano::matching::LightGlueMatcher;
use maple_pano::models::ModelDir;
use maple_pano::render::write_frame_png;
use maple_pano::robust::RobustOptions;
use maple_pano::twoview::PixelCorrespondence;

#[derive(Subcommand)]
pub enum PanoCmd {
    /// Stitch a panorama from RAW frames.
    Stitch(StitchArgs),
}

#[derive(Args)]
pub struct StitchArgs {
    /// Input RAW frames (2+). Sorted by file name = capture order.
    #[arg(required = true, num_args = 2..)]
    inputs: Vec<PathBuf>,
    /// Output PNG path (16-bit, scene-linear).
    #[arg(long)]
    out: PathBuf,
    /// Also write an sRGB-encoded 16-bit preview PNG here.
    #[arg(long)]
    display: Option<PathBuf>,
    /// Write the stitch report JSON here (always printed to stderr).
    #[arg(long)]
    report: Option<PathBuf>,
    /// Long-edge cap for the feature-extraction proxy. The ALIKED
    /// export letterboxes to 1280² internally; larger proxies only
    /// cost decode time.
    #[arg(long, default_value_t = 1600)]
    proxy_long_edge: u32,
    /// Total canvas pixel cap (uniform downscale to fit).
    #[arg(long, default_value_t = 256_000_000)]
    max_canvas_px: usize,
    /// Per-frame mean reprojection-error budget (px). The spec §5.3 gate
    /// is 1.5; relax it for input with uncorrected lens distortion (DJI
    /// `WarpRectilinear` opcodes raw-core does not yet apply, #1159),
    /// which inflates residuals the k1/k2 model only partly absorbs.
    #[arg(long, default_value_t = 1.5)]
    max_mean_px: f64,
    /// Per-frame max reprojection-error budget (px). Spec §5.3 gate is 6.
    #[arg(long, default_value_t = 6.0)]
    max_residual_px: f64,
    /// Models directory (defaults to $MAPLE_PANO_MODELS).
    #[arg(long)]
    models_dir: Option<PathBuf>,
}

pub fn run(cmd: PanoCmd) -> Result<(), String> {
    match cmd {
        PanoCmd::Stitch(args) => stitch(args),
    }
}

fn stitch(args: StitchArgs) -> Result<(), String> {
    let t0 = Instant::now();

    // ---- ML environment (hard requirement — see module docs) -----------
    let models = ModelDir::resolve(args.models_dir.as_deref()).map_err(|e| {
        format!(
            "ML environment unavailable: {e}\n\
             The pano pipeline needs the ALIKED + LightGlue models and an \
             ONNX Runtime dylib:\n\
             set MAPLE_PANO_MODELS to the models directory (SHA-pinned in \
             maple-pano/models.toml)\n\
             and ORT_DYLIB_PATH to libonnxruntime (>= 1.23)."
        )
    })?;
    let mut detector = AlikedDetector::load(&models, DetectorOptions::default())
        .map_err(|e| format!("ALIKED load failed: {e}"))?;
    let mut matcher = LightGlueMatcher::load(&models, Default::default())
        .map_err(|e| format!("LightGlue load failed: {e}"))?;

    // ---- Decode + priors ------------------------------------------------
    let mut inputs = args.inputs.clone();
    inputs.sort();
    let t_decode = Instant::now();
    let mut frames: Vec<IngestedFrame> = Vec::with_capacity(inputs.len());
    for path in &inputs {
        eprintln!("pano: decoding {}", path.display());
        frames.push(ingest_file(path).map_err(|e| format!("{}: {e}", path.display()))?);
    }
    let decode_s = t_decode.elapsed().as_secs_f64();

    // ---- Features on proxies ---------------------------------------------
    // The whole geometry stage (verification, BA, its px-denominated
    // gates) runs in PROXY coordinates: that is the resolution the
    // matches actually carry their accuracy at — scaling coordinates up
    // first would multiply match noise by the proxy factor and blow the
    // spec budgets spuriously. Solved cameras are lifted to full
    // resolution afterwards (rotation and k1/k2 are scale-invariant;
    // focal scales by the proxy factor).
    let t_feat = Instant::now();
    let mut feature_sets: Vec<FeatureSet> = Vec::with_capacity(frames.len());
    let mut proxy_scale: Vec<f64> = Vec::with_capacity(frames.len());
    let mut proxy_dims: Vec<(u32, u32)> = Vec::with_capacity(frames.len());
    for (frame, path) in frames.iter().zip(&inputs) {
        let proxy = proxy_to_long_edge(&frame.image, args.proxy_long_edge);
        proxy_scale.push(frame.image.width() as f64 / proxy.width() as f64);
        proxy_dims.push((proxy.width(), proxy.height()));
        let rgb = interleave(&proxy);
        let lin = LinearRgbFrame::new(proxy.width(), proxy.height(), rgb)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        let fs = detector
            .detect(&lin)
            .map_err(|e| format!("{}: detect: {e}", path.display()))?;
        eprintln!(
            "pano: {} — {} keypoints on {}x{} proxy",
            path.display(),
            fs.len(),
            proxy.width(),
            proxy.height()
        );
        feature_sets.push(fs);
    }
    let features_s = t_feat.elapsed().as_secs_f64();

    let images: Vec<GraphImage> = frames
        .iter()
        .zip(&inputs)
        .enumerate()
        .map(|(i, (f, path))| {
            let focal_px = f.priors.focal_px.ok_or_else(|| {
                format!(
                    "{}: no EXIF 35mm-equivalent focal length — cannot seed \
                     the camera model (spec §5.3 initialization)",
                    path.display()
                )
            })?;
            Ok(GraphImage {
                camera: Camera::new(
                    [0.0; 3],
                    focal_px / proxy_scale[i],
                    0.0,
                    0.0,
                    proxy_dims[i].0,
                    proxy_dims[i].1,
                ),
                prior_rotation: f.priors.gimbal.as_ref().map(ba::init::rotation_from_gimbal),
            })
        })
        .collect::<Result<_, String>>()?;

    // ---- Match graph (capture order + gimbal prior candidates) ----------
    let t_graph = Instant::now();
    let mut match_failures: Vec<String> = Vec::new();
    let graph = build_match_graph(
        &images,
        &[&CaptureOrderProvider, &GimbalPriorProvider::default()],
        |a, b| -> Vec<PixelCorrespondence> {
            match matcher.match_features(&feature_sets[a], &feature_sets[b]) {
                Ok(ml) => ml_matches_to_correspondences(&ml, DEFAULT_MIN_SCORE),
                Err(e) => {
                    match_failures.push(format!("pair ({a},{b}): {e}"));
                    Vec::new()
                }
            }
        },
        &RobustOptions::default(),
    );
    let graph_s = t_graph.elapsed().as_secs_f64();
    if !match_failures.is_empty() {
        return Err(format!(
            "LightGlue failed on {} pair(s):\n{}",
            match_failures.len(),
            match_failures.join("\n")
        ));
    }
    eprintln!(
        "pano: graph — {} verified edges, components {:?}, orphans {:?}",
        graph.edges.len(),
        graph.components.iter().map(|c| c.len()).collect::<Vec<_>>(),
        graph.orphans
    );

    // ---- Global solve + leveling ----------------------------------------
    let t_solve = Instant::now();
    let mut solution = ba::solve(
        &images,
        &graph,
        &BaOptions {
            mean_budget_px: args.max_mean_px,
            max_budget_px: args.max_residual_px,
            ..Default::default()
        },
    )
    .map_err(|e| e.to_string())?;
    let leveled = leveling::apply(&mut solution);
    let solve_s = t_solve.elapsed().as_secs_f64();
    eprintln!(
        "pano: solve — mean {:.3}px max {:.3}px over {} rounds ({} LM iters), focal {:.1}px, dropped {:?}, leveled={leveled}",
        solution.mean_reproj_px,
        solution.max_reproj_px,
        solution.solve_rounds,
        solution.lm_iterations,
        solution.shared_focal_px,
        solution.dropped
    );

    // ---- Composite --------------------------------------------------------
    // Lift the proxy-space solve to full resolution: rotation and the
    // normalized-coordinate k1/k2 are scale-invariant; focal scales by
    // each frame's proxy factor.
    let kept: Vec<(PlanarImage, Camera)> = frames
        .iter()
        .zip(&solution.cameras)
        .zip(&proxy_scale)
        .filter_map(|((f, cam), &scale)| {
            cam.as_ref().map(|c| {
                let full = Camera::new(
                    c.axis_angle,
                    c.focal_px * scale,
                    c.k1,
                    c.k2,
                    f.image.width(),
                    f.image.height(),
                );
                (f.image.clone(), full)
            })
        })
        .collect();
    if kept.len() < 2 {
        return Err(format!(
            "only {} frame(s) survived the solve — nothing to composite \
             (drops: {:?})",
            kept.len(),
            solution.dropped
        ));
    }
    let t_comp = Instant::now();
    let (kept_frames, kept_cams): (Vec<_>, Vec<_>) = kept.into_iter().unzip();
    let (out_img, comp_report) = composite(
        &kept_frames,
        &kept_cams,
        &CompositeOptions {
            canvas: CanvasOptions {
                projection: ProjectionMode::Auto,
                max_pixels: args.max_canvas_px,
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .map_err(|e| e.to_string())?;
    let composite_s = t_comp.elapsed().as_secs_f64();

    // ---- Outputs ----------------------------------------------------------
    let t_out = Instant::now();
    write_png16(&args.out, &out_img, false)?;
    if let Some(display) = &args.display {
        write_png16(display, &out_img, true)?;
    }
    let write_s = t_out.elapsed().as_secs_f64();

    let report = serde_json::json!({
        "inputs": inputs.iter().map(|p| p.display().to_string()).collect::<Vec<_>>(),
        "cameras": solution.cameras.iter().map(|c| c.as_ref().map(|c| serde_json::json!({
            "axis_angle": c.axis_angle,
            "focal_px": c.focal_px,
            "k1": c.k1,
            "k2": c.k2,
        }))).collect::<Vec<_>>(),
        "mean_reproj_error_px": solution.mean_reproj_px,
        "max_reproj_error_px": solution.max_reproj_px,
        "shared_focal_px": solution.shared_focal_px,
        "k1": solution.k1,
        "k2": solution.k2,
        "dropped_images": solution.dropped.iter().map(|d| format!("{d:?}")).collect::<Vec<_>>(),
        "leveled": leveled,
        "projection": format!("{:?}", comp_report.projection),
        "canvas": { "width": comp_report.canvas.width, "height": comp_report.canvas.height },
        "gains": comp_report.gains,
        "blend_levels": comp_report.blend_levels,
        "min_overlap_width_px": comp_report.min_overlap_width_px,
        "timings_s": {
            "decode": decode_s,
            "features": features_s,
            "match_graph": graph_s,
            "solve": solve_s,
            "composite": composite_s,
            "write": write_s,
            "total": t0.elapsed().as_secs_f64(),
        },
    });
    let pretty = serde_json::to_string_pretty(&report).expect("report serializes");
    eprintln!("{pretty}");
    if let Some(path) = &args.report {
        std::fs::write(path, &pretty).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    eprintln!(
        "pano: wrote {} ({}x{}) in {:.1}s",
        args.out.display(),
        out_img.width(),
        out_img.height(),
        t0.elapsed().as_secs_f64()
    );
    Ok(())
}

/// Interleave a planar image into the detector's RGB f32 layout.
fn interleave(img: &PlanarImage) -> Vec<f32> {
    let n = img.pixel_count();
    let mut out = Vec::with_capacity(n * 3);
    for i in 0..n {
        out.push(img.r[i]);
        out.push(img.g[i]);
        out.push(img.b[i]);
    }
    out
}

/// Quantize the composite to 16-bit PNG. `srgb` applies the IEC 61966
/// transfer for an eyeball-able preview; otherwise values stay linear
/// (clamped to [0, 1] — the PNG carries the display-range slice of the
/// scene; the DNG writer of spec step 9 is the full-range carrier).
fn write_png16(path: &Path, img: &PlanarImage, srgb: bool) -> Result<(), String> {
    let n = img.pixel_count();
    let mut data = Vec::with_capacity(n * 3);
    for i in 0..n {
        for plane in [&img.r, &img.g, &img.b] {
            let v = plane[i].clamp(0.0, 1.0);
            let v = if srgb { srgb_encode(v) } else { v };
            data.push((v * 65535.0).round() as u16);
        }
    }
    write_frame_png(path, img.width(), img.height(), &data)
        .map_err(|e| format!("{}: {e}", path.display()))
}

fn srgb_encode(v: f32) -> f32 {
    if v <= 0.003_130_8 {
        12.92 * v
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}
