// Shared exact-rank AE storage contract (#4629). Constants are code-generated.
struct Params { count: u32, groups: u32, shift: u32, pad: u32, };
struct Rank { key: u32, residual: u32, multiplicity: u32, pad: u32, };
struct State { length: u32, end: u32, pad0: u32, pad1: u32, ranks: array<Rank, 3>, };
struct Partial { sum: vec2<f32>, count: u32, pad: u32, };

fn key_value(key: u32) -> f32 {
    return bitcast<f32>(select(~key, key ^ 0x80000000u, (key & 0x80000000u) != 0u));
}

// Neumaier accumulation retains small partials without f64 support on WebGPU.
fn add_sum(pair: vec2<f32>, term: f32) -> vec2<f32> {
    let sum = pair.x + term;
    let error = select((term - sum) + pair.x, (pair.x - sum) + term, abs(pair.x) >= abs(term));
    return vec2<f32>(sum, pair.y + error);
}

// Center near-black bands on the floor. Subtracting two ~-14 logarithms
// destroys the adjacent-float distinctions that select identity versus 8x.
fn log_luminance(value: f32, centered: bool) -> f32 {
    if !centered { return log(value); }
    let relative = (value - AE_FLOOR) / AE_FLOOR;
    if abs(relative) <= 0.25 {
        // log(1+x) = 2 atanh(x/(2+x)); the odd series avoids cancellation.
        let z = relative / (2.0 + relative);
        let z2 = z * z;
        return 2.0 * z * (1.0 + z2 * (1.0/3.0 + z2 * (1.0/5.0 +
            z2 * (1.0/7.0 + z2 * (1.0/9.0 + z2 * (1.0/11.0 + z2/13.0))))));
    }
    return log(value) - log(AE_FLOOR);
}

fn mean_luminance(log_mean: f32, centered: bool) -> f32 {
    if !centered { return exp(log_mean); }
    if abs(log_mean) < 0.001 {
        // Preserve the final f32 rounding boundary at AE_FLOOR itself.
        let delta = log_mean * (1.0 + log_mean * (0.5 + log_mean/6.0));
        return AE_FLOOR + AE_FLOOR * delta;
    }
    return AE_FLOOR * exp(log_mean);
}
