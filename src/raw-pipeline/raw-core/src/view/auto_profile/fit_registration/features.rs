#[derive(Clone)]
pub(super) struct Gray {
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<f64>,
}

fn reflect(index: isize, length: usize) -> usize {
    if length == 1 {
        return 0;
    }
    let period = (2 * (length - 1)) as isize;
    let position = index.rem_euclid(period) as usize;
    if position < length {
        position
    } else {
        period as usize - position
    }
}

impl Gray {
    fn resize(&self, width: usize, height: usize) -> Self {
        let mut pixels = Vec::with_capacity(width * height);
        let sx = self.width as f64 / width as f64;
        let sy = self.height as f64 / height as f64;
        for y in 0..height {
            let (top, bottom) = (y as f64 * sy, (y + 1) as f64 * sy);
            for x in 0..width {
                let (left, right) = (x as f64 * sx, (x + 1) as f64 * sx);
                let mut sum = 0.;
                for j in top.floor() as usize..(bottom.ceil() as usize).min(self.height) {
                    let wy = (bottom.min((j + 1) as f64) - top.max(j as f64)).max(0.);
                    for i in left.floor() as usize..(right.ceil() as usize).min(self.width) {
                        let wx = (right.min((i + 1) as f64) - left.max(i as f64)).max(0.);
                        sum += wx * wy * self.pixels[j * self.width + i];
                    }
                }
                pixels.push(sum / (sx * sy));
            }
        }
        Self {
            width,
            height,
            pixels,
        }
    }

    fn blur(&self) -> Self {
        let mut kernel: Vec<_> = (-12i32..=12)
            .map(|i| (-(i * i) as f64 / 18.).exp())
            .collect();
        let mass: f64 = kernel.iter().sum();
        for value in &mut kernel {
            *value /= mass;
        }
        let mut horizontal = vec![0.; self.pixels.len()];
        let mut pixels = vec![0.; self.pixels.len()];
        for y in 0..self.height {
            for x in 0..self.width {
                horizontal[y * self.width + x] = kernel
                    .iter()
                    .enumerate()
                    .map(|(k, w)| {
                        w * self.pixels
                            [y * self.width + reflect(x as isize + k as isize - 12, self.width)]
                    })
                    .sum();
            }
        }
        for y in 0..self.height {
            for x in 0..self.width {
                pixels[y * self.width + x] = kernel
                    .iter()
                    .enumerate()
                    .map(|(k, w)| {
                        w * horizontal
                            [reflect(y as isize + k as isize - 12, self.height) * self.width + x]
                    })
                    .sum();
            }
        }
        Self {
            width: self.width,
            height: self.height,
            pixels,
        }
    }

    pub(super) fn normalized(&self, edge: usize) -> Self {
        let scale = edge as f64 / self.width.max(self.height) as f64;
        let image = self.resize(
            (self.width as f64 * scale).round_ties_even().max(16.) as usize,
            (self.height as f64 * scale).round_ties_even().max(16.) as usize,
        );
        let mean = image.blur();
        let square = Self {
            pixels: image.pixels.iter().map(|v| v * v).collect(),
            ..image.clone()
        }
        .blur();
        let pixels = image
            .pixels
            .iter()
            .zip(mean.pixels)
            .zip(square.pixels)
            .map(|((&value, average), square)| {
                (value - average) / ((square - average * average).max(0.) + 1e-4).sqrt()
            })
            .collect();
        Self { pixels, ..image }
    }

    pub(super) fn sample(&self, x: f64, y: f64) -> Option<[f64; 3]> {
        if !x.is_finite()
            || !y.is_finite()
            || x < 1.
            || y < 1.
            || x > (self.width - 2) as f64
            || y > (self.height - 2) as f64
        {
            return None;
        }
        let (ix, iy) = (x.floor() as usize, y.floor() as usize);
        let (fx, fy) = (x - ix as f64, y - iy as f64);
        let [a, b, c, d] = [
            self.pixels[iy * self.width + ix],
            self.pixels[iy * self.width + ix + 1],
            self.pixels[(iy + 1) * self.width + ix],
            self.pixels[(iy + 1) * self.width + ix + 1],
        ];
        Some([
            (a * (1. - fx) + b * fx) * (1. - fy) + (c * (1. - fx) + d * fx) * fy,
            (b - a) * (1. - fy) + (d - c) * fy,
            (c - a) * (1. - fx) + (d - b) * fx,
        ])
    }
}
