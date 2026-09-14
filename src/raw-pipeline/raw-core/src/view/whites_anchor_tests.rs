use super::{agx, agx_whites, whites_anchor};
use crate::image::{ColorSpace, Image};

#[test]
fn scene_statistic_is_bounded_and_rejects_nonfinite_pixels() {
    assert_eq!(whites_anchor::measure(1, |_| [0.18; 3]), 0.0);
    let ev = whites_anchor::measure(1000, |i| {
        if i == 0 {
            [f32::NAN; 3]
        } else if i < 990 {
            [0.18; 3]
        } else {
            [1.8; 3]
        }
    });
    assert!(
        ev.abs() < 1e-5,
        "small specular population should not set white: {ev}"
    );
    let calls = std::cell::Cell::new(0);
    let ev = whites_anchor::measure(100_000_000, |_| {
        calls.set(calls.get() + 1);
        [0.36; 3]
    });
    assert!((ev - 1.0).abs() < 1e-5);
    assert!(calls.get() <= 16384);
}

#[test]
fn image_amplitudes_preserve_order_and_inverse() {
    for ev in [-100.0, 0.0, 2.0, 4.0, 100.0, f32::NAN] {
        for w in [-100.0, -50.0, 0.0, 25.0, 50.0, 100.0] {
            let resolved = whites_anchor::resolve(w, ev);
            assert!(resolved.is_finite());
            if w <= 0.0 {
                assert_eq!(resolved, w);
            }
            let mut prev = agx_whites::remap_norm(-0.1, resolved);
            for i in 1..=4096 {
                let n = -0.1 + 1.3 * i as f32 / 4096.0;
                let v = agx_whites::remap_norm(n, resolved);
                assert!(v > prev, "ev={ev} w={w} n={n}");
                assert!((agx_whites::unremap_norm(v, resolved) - n).abs() < 1e-5);
                prev = v;
            }
        }
    }
}

#[test]
fn detail_uses_full_frame_anchor_even_when_tile_distribution_differs() {
    let mut frame = Image::new(64, 1, ColorSpace::SceneLinearRec2020);
    frame.pixels = (0..64).map(|i| [0.02 * (i + 1) as f32; 3]).collect();
    frame.whites_anchor_ev = Some(whites_anchor::measure(frame.pixels.len(), |i| {
        frame.pixels[i]
    }));
    let mut tile = Image::new(8, 1, ColorSpace::SceneLinearRec2020);
    tile.pixels = frame.pixels[0..8].to_vec();
    tile.whites_anchor_ev = frame.whites_anchor_ev;
    let mut explicit = tile.clone();
    agx::apply_with_resolved_whites(
        &mut explicit,
        0.0,
        whites_anchor::resolve(100.0, frame.whites_anchor_ev.unwrap()),
    );
    agx::apply(&mut frame, 0.0, 100.0);
    agx::apply(&mut tile, 0.0, 100.0);
    assert_eq!(tile.pixels, frame.pixels[0..8]);
    assert_eq!(tile.pixels, explicit.pixels);
}

#[test]
fn stratified_samples_preserve_bright_bands_across_sizes_and_translations() {
    // Exact area-resizable 80/4096-wide stripe: >1% of the frame, so the
    // 99th percentile must find it. Midpoint sampling missed it at 1024.
    for start in [0, 64, 480, 512, 1000, 1536, 2048, 3000, 4000] {
        for width in [1024, 2048, 4096] {
            let left = start * width / 4096;
            let right = (start + 80) * width / 4096;
            let ev = whites_anchor::measure(width * width, |i| {
                let x = i % width;
                [if (left..right).contains(&x) {
                    2.88
                } else {
                    0.18
                }; 3]
            });
            assert!(
                (ev - 4.0).abs() < 1e-5,
                "width={width} start={start} ev={ev}"
            );
        }
    }
}

#[test]
fn sampling_is_repeatable_in_bounds_and_bounded_for_large_inputs() {
    for count in [0, 1, 1000, 16384, 16385, 100_000_000, usize::MAX] {
        let sample = || {
            let calls = std::cell::Cell::new(0usize);
            let fingerprint = std::cell::Cell::new(0u64);
            let previous = std::cell::Cell::new(None);
            let ev = whites_anchor::measure(count, |i| {
                assert!(i < count);
                if let Some(prev) = previous.get() {
                    assert!(i > prev);
                }
                previous.set(Some(i));
                calls.set(calls.get() + 1);
                fingerprint.set(fingerprint.get().wrapping_mul(31).wrapping_add(i as u64));
                [0.36; 3]
            });
            assert_eq!(calls.get(), count.min(16384));
            (ev.to_bits(), fingerprint.get())
        };
        assert_eq!(sample(), sample());
    }
    for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, -1.0, 0.0] {
        assert!(whites_anchor::measure(100_000, |_| [value; 3]).is_finite());
    }
}
