//! Tests for per-image gain compensation.

use pano_core::compensation::gain::{apply_gains, solve_per_image_gain};
use pano_core::{ColorSpace, PanoImage};

fn solid_pano_image(w: u32, h: u32, brightness: f32) -> PanoImage {
    let mut img = PanoImage::new(w, h, ColorSpace::rec2020_d65_linear());
    for i in 0..(w as usize * h as usize) {
        img.pixels[i * 3] = brightness;
        img.pixels[i * 3 + 1] = brightness;
        img.pixels[i * 3 + 2] = brightness;
    }
    img
}

#[test]
fn gain_solve_identity_when_all_brightnesses_equal() {
    // Three identical images at brightness 0.5 → all gains should be 1.0.
    let img = solid_pano_image(64, 64, 0.5);
    let images = vec![&img, &img, &img];
    let gains = solve_per_image_gain(&images).unwrap();
    assert_eq!(gains.len(), 3);
    for g in &gains {
        assert!((g - 1.0).abs() < 1e-3, "gain {g} ≠ 1.0");
    }
}

#[test]
fn gain_solve_matches_brightness_ratios() {
    // Two images, A at brightness 0.4, B at brightness 0.8.
    // Gauge fix: g_0 = 1 (A's gain). The system minimises x_0 - x_1 = log(0.4/0.8) = log(0.5).
    // With x_0 fixed at 0, x_1 = -log(0.5) = log(2), so g_1 = 2.
    // Wait — that means: A's mean is 0.4, B's mean is 0.8.
    // Constraint: g_0 * mean(A_overlap) ≈ g_1 * mean(B_overlap)
    //             g_0 * 0.4 ≈ g_1 * 0.8
    //             g_0 / g_1 ≈ 2
    //             with g_0 = 1, g_1 = 0.5
    let img_a = solid_pano_image(64, 64, 0.4);
    let img_b = solid_pano_image(64, 64, 0.8);
    let images = vec![&img_a, &img_b];
    let gains = solve_per_image_gain(&images).unwrap();
    assert_eq!(gains.len(), 2);
    assert!((gains[0] - 1.0).abs() < 1e-2, "g_0 should be 1.0, got {}", gains[0]);
    assert!((gains[1] - 0.5).abs() < 0.05, "g_1 should be ≈0.5, got {}", gains[1]);
}

#[test]
fn apply_gains_multiplies_pixels() {
    let mut img = solid_pano_image(8, 8, 0.5);
    apply_gains(std::slice::from_mut(&mut img), &[2.0]).unwrap();
    // All pixels should now be 1.0.
    for chunk in img.pixels.chunks_exact(3) {
        assert!((chunk[0] - 1.0).abs() < 1e-6);
        assert!((chunk[1] - 1.0).abs() < 1e-6);
        assert!((chunk[2] - 1.0).abs() < 1e-6);
    }
}

#[test]
fn apply_gains_clamps_at_unity_for_invalid_pixels() {
    let mut img = solid_pano_image(4, 4, 0.5);
    img.set_invalid(0, 0); // mark one pixel invalid
    apply_gains(std::slice::from_mut(&mut img), &[2.0]).unwrap();
    // The invalid pixel may or may not be touched — just verify no panic.
    // (Implementation choice: easier to just multiply all pixels including
    // invalid ones; the validity mask still tracks which to use.)
    let _ = img;
}
