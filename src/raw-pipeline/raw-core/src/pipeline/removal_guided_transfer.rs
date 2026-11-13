//! Bounded native-source texture transfer guided by a coarse inpaint prediction.
//!
//! This ports the Mac research variant from #3941: the coarse guide supplies
//! patch correspondences, while generated pixels are copied only from known
//! native source blocks. The method is experimental and does not infer scene
//! geometry; callers must keep the result reviewable and non-destructive.

use crate::cancel::CancelToken;

const STRIDE: usize = 4;
const SEARCH_RADIUS: usize = 1;
const ITERATIONS: usize = 5;
const SEED: u64 = 0x3941_2026_1006;
const FEATURES: usize = 27;

/// Copy native pixels from known source regions using RGB structure in a
/// bilinearly enlarged coarse model guide. Pixels outside `hole` are preserved
/// bit-for-bit. `guide` is display-referred RGB in [0, 1]; `source` is the
/// native linear-light donor plane and may contain negative or HDR samples.
pub fn guided_native_texture_transfer(
    source: &[[f32; 3]],
    guide: &[[f32; 3]],
    hole: &[u8],
    width: u32,
    height: u32,
    cancel: CancelToken<'_>,
) -> Result<Vec<[f32; 3]>, String> {
    let (width, height) = (width as usize, height as usize);
    let count = width
        .checked_mul(height)
        .ok_or_else(|| "guided removal: context dimensions overflow".to_string())?;
    if width < 3
        || height < 3
        || width > 2048
        || height > 2048
        || source.len() != count
        || guide.len() != count
        || hole.len() != count
    {
        return Err("guided removal: expected matching 3..2048 contexts".into());
    }
    // Tiny synthetic RAW fixtures (and genuinely small crops) still need a
    // donor interior. Use pixel-level blocks there; full-size RAW contexts keep
    // the bounded 4 px grid so search state remains practical.
    let stride = if width.min(height) < 16 { 1 } else { STRIDE };
    if hole.iter().all(|value| *value == 0) || hole.iter().any(|value| *value > 1) {
        return Err("guided removal: expected a nonempty binary hole".into());
    }
    if source.iter().flatten().any(|value| !value.is_finite()) {
        return Err("guided removal: native source must be finite".into());
    }
    if guide
        .iter()
        .flatten()
        .any(|value| !value.is_finite() || !(0.0..=1.0).contains(value))
    {
        return Err("guided removal: guide RGB must be finite and in [0, 1]".into());
    }

    let (grid_width, grid_height) = (width.div_ceil(stride), height.div_ceil(stride));
    let grid_count = grid_width * grid_height;
    let mut selected = vec![false; grid_count];
    for y in 0..height {
        if y % 32 == 0 && cancel.is_cancelled() {
            return Err("guided removal: cancelled".into());
        }
        for x in 0..width {
            let pixel = y * width + x;
            if hole[pixel] == 1 {
                selected[(y / stride) * grid_width + x / stride] = true;
            }
        }
    }

    let mut valid_donor = vec![true; grid_count];
    for y in 0..grid_height {
        for x in 0..grid_width {
            if y == 0 || x == 0 || y + 1 == grid_height || x + 1 == grid_width {
                valid_donor[y * grid_width + x] = false;
            }
            if !selected[y * grid_width + x] {
                continue;
            }
            for dy in -(SEARCH_RADIUS as isize)..=SEARCH_RADIUS as isize {
                for dx in -(SEARCH_RADIUS as isize)..=SEARCH_RADIUS as isize {
                    let ny = y as isize + dy;
                    let nx = x as isize + dx;
                    if (0..grid_height as isize).contains(&ny)
                        && (0..grid_width as isize).contains(&nx)
                    {
                        valid_donor[ny as usize * grid_width + nx as usize] = false;
                    }
                }
            }
        }
    }
    let donors: Vec<usize> = valid_donor
        .iter()
        .enumerate()
        .filter_map(|(index, valid)| valid.then_some(index))
        .collect();
    if donors.is_empty() {
        return Err("guided removal: no known native donor support".into());
    }

    let guide_grid = block_means(guide, width, height, grid_width, grid_height, stride);
    let features = descriptors(&guide_grid, grid_width, grid_height);
    let targets: Vec<usize> = selected
        .iter()
        .enumerate()
        .filter_map(|(index, chosen)| chosen.then_some(index))
        .collect();
    let mut field = vec![usize::MAX; grid_count];
    let mut errors = vec![f32::INFINITY; grid_count];
    let mut rng = DeterministicRng(SEED);
    for &target in &targets {
        field[target] = donors[rng.index(donors.len())];
        errors[target] = descriptor_error(&features, target, field[target]);
    }

    for iteration in 0..ITERATIONS {
        if cancel.is_cancelled() {
            return Err("guided removal: cancelled".into());
        }
        let direction = if iteration % 2 == 0 { 1isize } else { -1 };
        for (index, &target) in targets.iter().enumerate() {
            if index % 1024 == 0 && cancel.is_cancelled() {
                return Err("guided removal: cancelled".into());
            }
            let y = target / grid_width;
            let x = target % grid_width;
            for (dy, dx) in [
                (0, direction),
                (direction, 0),
                (0, -direction),
                (-direction, 0),
            ] {
                let ny = (y as isize + dy).clamp(0, grid_height as isize - 1) as usize;
                let nx = (x as isize + dx).clamp(0, grid_width as isize - 1) as usize;
                let neighbor = field[ny * grid_width + nx];
                if neighbor != usize::MAX {
                    let donor_y = (neighbor / grid_width) as isize - dy;
                    let donor_x = (neighbor % grid_width) as isize - dx;
                    consider(
                        &features,
                        &valid_donor,
                        grid_width,
                        grid_height,
                        target,
                        donor_y,
                        donor_x,
                        &mut field,
                        &mut errors,
                    );
                }
            }
            let mut search_radius = grid_width.max(grid_height);
            while search_radius > 0 {
                let current = field[target];
                let current_y = (current / grid_width) as isize;
                let current_x = (current % grid_width) as isize;
                let radius = search_radius as isize;
                let donor_y = current_y + rng.range(-radius, radius);
                let donor_x = current_x + rng.range(-radius, radius);
                consider(
                    &features,
                    &valid_donor,
                    grid_width,
                    grid_height,
                    target,
                    donor_y,
                    donor_x,
                    &mut field,
                    &mut errors,
                );
                search_radius /= 2;
            }
        }
    }

    let mut totals = vec![[0.0f32; 3]; count];
    let mut weights = vec![0.0f32; grid_count];
    for &target in &targets {
        if cancel.is_cancelled() {
            return Err("guided removal: cancelled".into());
        }
        let (target_y, target_x) = (target / grid_width, target % grid_width);
        let donor = field[target];
        let (donor_y, donor_x) = (donor / grid_width, donor % grid_width);
        for dy in -(SEARCH_RADIUS as isize)..=SEARCH_RADIUS as isize {
            for dx in -(SEARCH_RADIUS as isize)..=SEARCH_RADIUS as isize {
                let (dest_y, dest_x) = (target_y as isize + dy, target_x as isize + dx);
                if !(0..grid_height as isize).contains(&dest_y)
                    || !(0..grid_width as isize).contains(&dest_x)
                {
                    continue;
                }
                let donor_y = (donor_y as isize + dy) as usize;
                let donor_x = (donor_x as isize + dx) as usize;
                let dest = dest_y as usize * grid_width + dest_x as usize;
                let weight = 1.0 / (1.0 + dy.unsigned_abs() as f32 + dx.unsigned_abs() as f32);
                weights[dest] += weight;
                for by in 0..stride {
                    for bx in 0..stride {
                        let (dst_y, dst_x) =
                            (dest_y as usize * stride + by, dest_x as usize * stride + bx);
                        if dst_y >= height || dst_x >= width {
                            continue;
                        }
                        let src_y = (donor_y * stride + by).min(height - 1);
                        let src_x = (donor_x * stride + bx).min(width - 1);
                        let dst = dst_y * width + dst_x;
                        let src = src_y * width + src_x;
                        for channel in 0..3 {
                            totals[dst][channel] += source[src][channel] * weight;
                        }
                    }
                }
            }
        }
    }

    let mut result = source.to_vec();
    for pixel in 0..count {
        if hole[pixel] == 0 {
            continue;
        }
        let grid = (pixel / width / stride) * grid_width + pixel % width / stride;
        let weight = weights[grid];
        if weight <= 0.0 {
            return Err("guided removal: selected pixel has no native votes".into());
        }
        result[pixel] = totals[pixel].map(|value| value / weight);
    }
    Ok(result)
}

fn block_means(
    image: &[[f32; 3]],
    width: usize,
    height: usize,
    grid_width: usize,
    grid_height: usize,
    stride: usize,
) -> Vec<[f32; 3]> {
    let mut result = vec![[0.0; 3]; grid_width * grid_height];
    for y in 0..grid_height {
        for x in 0..grid_width {
            let target = &mut result[y * grid_width + x];
            let mut count = 0.0;
            for by in 0..stride {
                for bx in 0..stride {
                    let (source_y, source_x) = (y * stride + by, x * stride + bx);
                    if source_y >= height || source_x >= width {
                        continue;
                    }
                    let pixel = image[source_y * width + source_x];
                    for channel in 0..3 {
                        target[channel] += pixel[channel];
                    }
                    count += 1.0;
                }
            }
            for channel in 0..3 {
                target[channel] /= count;
            }
        }
    }
    result
}

fn descriptors(image: &[[f32; 3]], width: usize, height: usize) -> Vec<[f32; FEATURES]> {
    let mut result = vec![[0.0; FEATURES]; width * height];
    for y in 0..height {
        for x in 0..width {
            let mut channel = 0;
            for dy in -1isize..=1 {
                for dx in -1isize..=1 {
                    let ny = reflect(y as isize + dy, height);
                    let nx = reflect(x as isize + dx, width);
                    for value in image[ny * width + nx] {
                        result[y * width + x][channel] = value;
                        channel += 1;
                    }
                }
            }
        }
    }
    result
}

fn reflect(value: isize, length: usize) -> usize {
    if value < 0 {
        (-value) as usize
    } else if value >= length as isize {
        (2 * length as isize - value - 2) as usize
    } else {
        value as usize
    }
}

fn descriptor_error(features: &[[f32; FEATURES]], target: usize, candidate: usize) -> f32 {
    features[target]
        .iter()
        .zip(features[candidate])
        .map(|(left, right)| (left - right).powi(2))
        .sum::<f32>()
        / FEATURES as f32
}

#[allow(clippy::too_many_arguments)]
fn consider(
    features: &[[f32; FEATURES]],
    valid: &[bool],
    width: usize,
    height: usize,
    target: usize,
    y: isize,
    x: isize,
    field: &mut [usize],
    errors: &mut [f32],
) {
    let y = y.clamp(0, height as isize - 1) as usize;
    let x = x.clamp(0, width as isize - 1) as usize;
    let candidate = y * width + x;
    if !valid[candidate] {
        return;
    }
    let error = descriptor_error(features, target, candidate);
    if error < errors[target] {
        field[target] = candidate;
        errors[target] = error;
    }
}

struct DeterministicRng(u64);

impl DeterministicRng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn index(&mut self, length: usize) -> usize {
        self.next() as usize % length
    }

    fn range(&mut self, low: isize, high: isize) -> isize {
        low + (self.next() % (high - low + 1) as u64) as isize
    }
}

#[cfg(test)]
#[path = "removal_guided_transfer_tests.rs"]
mod tests;
