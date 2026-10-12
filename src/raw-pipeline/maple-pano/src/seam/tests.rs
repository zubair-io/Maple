use crate::camera::Camera;
use crate::canvas::{auto_canvas, CanvasOptions};
use crate::ingest::{PlanarImage, ValidityMask};
use crate::local_align::LocalCorrection;
use crate::prng::SplitMix64;
use crate::render::{build_camera_set, CameraSetOptions, Pattern};

use super::labels::compute_labels;
use super::masks::build_from_frames;

fn fnv1a(bytes: impl IntoIterator<Item = u8>) -> u64 {
    bytes.into_iter().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
        (h ^ b as u64).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

fn textured(w: u32, h: u32, valid: impl Fn(u32, u32) -> bool, seed: u32) -> PlanarImage {
    let n = (w as usize) * (h as usize);
    let mut mask = ValidityMask::new_filled(w, h, false);
    let mut r = vec![0.0_f32; n];
    for y in 0..h {
        for x in 0..w {
            mask.set(x, y, valid(x, y));
            let idx = (y * w + x) as usize;
            let base = 0.3 + 0.2 * ((x as f32) * 0.37).sin() * ((y as f32) * 0.21).cos();
            let blob = (20..28).contains(&x) && (8..16).contains(&y) && seed == 1;
            r[idx] = if blob {
                0.9 - 0.8 * (((x + y) % 2) as f32)
            } else {
                base
            };
        }
    }
    let g = r.iter().map(|v| v * 0.9).collect();
    let b = r.iter().map(|v| v * 0.7).collect();
    PlanarImage::from_planes(w, h, r, g, b, mask)
}

pub(super) fn three_band_layers() -> Vec<PlanarImage> {
    let (w, h) = (48, 24);
    vec![
        textured(w, h, |x, _| x < 22, 0),
        textured(w, h, |x, _| (14..34).contains(&x), 1),
        textured(w, h, |x, _| x >= 26, 2),
    ]
}

fn ring_cameras(count: u32) -> Vec<Camera> {
    let opts = CameraSetOptions {
        count,
        pattern: Pattern::Ring { full: false },
        fov_deg: 60.0,
        overlap: 0.4,
        pitch_deg: 0.0,
        jitter_deg: 0.0,
        k1: 0.0,
        k2: 0.0,
        width: 64,
        height: 48,
    };
    build_camera_set(&opts, &mut SplitMix64::new(7))
        .expect("valid ring")
        .iter()
        .map(|c| c.to_camera())
        .collect()
}

fn frame_from_scene(cam: &Camera, blob: bool) -> PlanarImage {
    let (w, h) = (cam.width, cam.height);
    let n = (w as usize) * (h as usize);
    let (mut r, mut g, mut b) = (vec![0.0; n], vec![0.0; n], vec![0.0; n]);
    for y in 0..h {
        for x in 0..w {
            let d = cam
                .pixel_to_world_dir(x as f64 + 0.5, y as f64 + 0.5)
                .expect("invertible");
            let v = (0.5 + 0.3 * (5.0 * d.x).sin() * (3.0 * d.y).cos()) as f32;
            let v = if blob && (x / 3 + y / 3) % 2 == 0 && x < w / 3 {
                0.95
            } else {
                v
            };
            let i = (y * w + x) as usize;
            r[i] = v;
            g[i] = v * 0.9;
            b[i] = v * 0.8;
        }
    }
    PlanarImage::from_planes(w, h, r, g, b, ValidityMask::new_filled(w, h, true))
}

#[test]
fn unconstrained_labels_match_pre_constraint_golden() {
    let labels = compute_labels(&three_band_layers());
    let hash = fnv1a(labels.iter().flat_map(|l| l.to_le_bytes()));
    assert_eq!(hash, 0x0453_179b_0a4f_44a5);
}

#[test]
fn unconstrained_seam_masks_match_pre_constraint_golden() {
    let cams = ring_cameras(3);
    let frames: Vec<PlanarImage> = cams
        .iter()
        .enumerate()
        .map(|(i, c)| frame_from_scene(c, i == 1))
        .collect();
    let canvas = auto_canvas(&cams, &CanvasOptions::default()).expect("canvas");
    let gains = vec![[1.0, 1.0, 1.0]; cams.len()];
    let no_lc: Vec<Option<LocalCorrection>> = vec![None; cams.len()];
    let seam = build_from_frames(&frames, &cams, &gains, &no_lc, &canvas);
    let weights = (0..canvas.height)
        .flat_map(|y| (0..canvas.width).flat_map(move |x| (0..3).map(move |i| (i, x, y))));
    let hash = fnv1a(weights.flat_map(|(i, x, y)| {
        seam.weight(i, x as f64 + 0.5, y as f64 + 0.5)
            .to_bits()
            .to_le_bytes()
    }));
    assert_eq!(hash, 0x87e3_b328_80b0_98ea);
}
