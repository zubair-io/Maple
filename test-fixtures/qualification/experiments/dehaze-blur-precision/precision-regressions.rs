#[test]
fn box_blur_preserves_nonbinary_hdr_constants_on_long_rows() {
    let (w, h) = (4096, 17);
    for value in [0.1234567_f32, 123.4567, 10_000.125] {
        let input = vec![value; w * h];
        let out = box_blur(&input, w, h, 60);
        let worst = out
            .iter()
            .map(|v| v.to_bits().abs_diff(value.to_bits()))
            .max()
            .unwrap();
        assert!(worst <= 1, "value={value}, worst={worst} ulps");
    }
}

#[test]
fn box_blur_long_hdr_rows_match_independent_f64_windows() {
    let (w, h, radius) = (2048, 3, 60);
    let input: Vec<f32> = (0..w * h)
        .map(|i| {
            let x = i % w;
            if x < 800 {
                8000.0 + (i % 37) as f32 * 0.013
            } else {
                0.13 + (i % 31) as f32 * 0.001
            }
        })
        .collect();
    let mut horizontal = vec![0.0_f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let lo = x.saturating_sub(radius);
            let hi = (x + radius + 1).min(w);
            let sum: f64 = input[y * w + lo..y * w + hi]
                .iter()
                .map(|&v| v as f64)
                .sum();
            horizontal[y * w + x] = (sum / (hi - lo) as f64) as f32;
        }
    }
    let out = box_blur(&input, w, h, radius);
    let mut worst = 0;
    for y in 0..h {
        for x in 0..w {
            let lo = y.saturating_sub(radius);
            let hi = (y + radius + 1).min(h);
            let sum: f64 = (lo..hi).map(|row| horizontal[row * w + x] as f64).sum();
            let expected = (sum / (hi - lo) as f64) as f32;
            worst = worst.max(out[y * w + x].to_bits().abs_diff(expected.to_bits()));
        }
    }
    assert!(worst <= 1, "separable f64 oracle differs by {worst} ulps");
}
