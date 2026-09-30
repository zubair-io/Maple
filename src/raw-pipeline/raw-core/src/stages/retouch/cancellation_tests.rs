use super::*;
use crate::stages::blur::{gaussian_blur_plane_sigma, gaussian_blur_plane_sigma_cancellable};
use crate::types::{local_adjustment::Point2, retouch::RetouchKind};
use std::sync::atomic::{AtomicBool, Ordering};

#[test]
fn cancelled_repairs_leave_the_input_untouched() {
    let flag = AtomicBool::new(true);
    for kind in [RetouchKind::Clone, RetouchKind::Heal] {
        let mut image = Image::new(64, 48, ColorSpace::SceneLinearRec2020);
        image.pixels.fill([0.2, 0.3, 0.4]);
        let before = image.pixels.clone();
        let spot = RetouchSpot {
            kind,
            center: Point2::new(0.3, 0.5),
            source: Point2::new(0.7, 0.5),
            radius: 0.1,
            feather: 0.5,
            opacity: 1.0,
        };
        assert!(matches!(
            apply_cancellable(&mut image, &[spot], CancelToken::new(&flag)),
            Err(Error::Cancelled)
        ));
        assert_eq!(image.pixels, before);
    }
}

#[test]
fn unsignalled_blur_matches_serial_pixel_order() {
    let (w, h) = (31, 23);
    let input: Vec<f32> = (0..w * h)
        .map(|i| ((i * 73 % 101) as f32 - 20.0) / 37.0)
        .collect();
    // Independent serial convolution pins the arithmetic and border sampling
    // from before cancellation was introduced, including HDR and negative input.
    let sigma = 2.3;
    let kernel = crate::stages::blur::gaussian_kernel_1d(sigma);
    let half = kernel.len() as isize / 2;
    let mut tmp = vec![0.0; input.len()];
    let mut expected = tmp.clone();
    for y in 0..h {
        for x in 0..w {
            for (k, weight) in kernel.iter().enumerate() {
                let sx = (x as isize + k as isize - half).clamp(0, w as isize - 1) as usize;
                tmp[y * w + x] += weight * input[y * w + sx];
            }
        }
    }
    for y in 0..h {
        for x in 0..w {
            for (k, weight) in kernel.iter().enumerate() {
                let sy = (y as isize + k as isize - half).clamp(0, h as isize - 1) as usize;
                expected[y * w + x] += weight * tmp[sy * w + x];
            }
        }
    }
    let flag = AtomicBool::new(false);
    assert_eq!(
        expected,
        gaussian_blur_plane_sigma_cancellable(&input, w, h, sigma, CancelToken::new(&flag))
            .unwrap()
    );
    assert_eq!(expected, gaussian_blur_plane_sigma(&input, w, h, sigma));
}

#[test]
fn expensive_heal_blur_observes_a_host_cancellation() {
    let input = vec![0.5; 1024 * 1024];
    let flag = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let worker = scope.spawn(|| {
            gaussian_blur_plane_sigma_cancellable(&input, 1024, 1024, 40.0, CancelToken::new(&flag))
        });
        std::thread::sleep(std::time::Duration::from_millis(2));
        flag.store(true, Ordering::Relaxed);
        assert!(matches!(worker.join().unwrap(), Err(Error::Cancelled)));
    });
}
