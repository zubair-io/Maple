struct Params { width: u32, height: u32, wiener: u32, pad: u32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> noisy: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> basic: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> matches: array<Matches>;
@group(0) @binding(4) var<storage, read_write> output: array<Filtered>;

// 12.5 KiB, below the 16 KiB portable workgroup-storage limit.
var<workgroup> spectra: array<f32, GROUP_VALUES>;
var<workgroup> guide_spectra: array<f32, GROUP_VALUES>;
var<workgroup> scratch: array<f32, GROUP_VALUES>;
var<workgroup> means: array<f32, BM3D_GROUP_MAX>;
var<workgroup> guide_means: array<f32, BM3D_GROUP_MAX>;
var<workgroup> reference_mean: f32;
var<workgroup> reference_guide_mean: f32;
var<workgroup> member_count: u32;
var<workgroup> group_weight: f32;

fn read_spectrum(index: u32, guide: bool) -> f32 {
    if guide { return guide_spectra[index]; }
    return spectra[index];
}

fn write_spectrum(index: u32, value: f32, guide: bool) {
    if guide { guide_spectra[index] = value; }
    else { spectra[index] = value; }
}

fn dct(lane: u32, count: u32, guide: bool, inverse: bool) {
    let row = lane / BM3D_BLOCK;
    let col = lane % BM3D_BLOCK;
    for (var stage = 0u; stage < 2u; stage++) {
        for (var k = 0u; k < count; k++) {
            var products: array<f32, BM3D_BLOCK>;
            for (var n = 0u; n < BM3D_BLOCK; n++) {
                var value: f32;
                var basis_index: u32;
                if !inverse {
                    if stage == 0u {
                        value = read_spectrum(k * PATCH + row * BM3D_BLOCK + n, guide);
                        basis_index = col * BM3D_BLOCK + n;
                    } else {
                        value = scratch[k * PATCH + n * BM3D_BLOCK + col];
                        basis_index = row * BM3D_BLOCK + n;
                    }
                } else {
                    if stage == 0u {
                        value = read_spectrum(k * PATCH + n * BM3D_BLOCK + col, guide);
                        basis_index = n * BM3D_BLOCK + row;
                    } else {
                        value = scratch[k * PATCH + row * BM3D_BLOCK + n];
                        basis_index = n * BM3D_BLOCK + col;
                    }
                }
                products[n] = value * BM3D_DCT[basis_index];
            }
            var sum = 0.0;
            for (var n = 0u; n < BM3D_BLOCK; n++) { sum += products[n]; }
            if stage == 0u { scratch[k * PATCH + lane] = sum; }
            else { write_spectrum(k * PATCH + lane, sum, guide); }
        }
        workgroupBarrier();
    }
}

fn prepare(lane: u32, column: u32, channel: u32, count: u32, guide: bool) {
    for (var k = 0u; k < count; k++) {
        let p = matches[column].positions[k] + vec2<u32>(lane % BM3D_BLOCK, lane / BM3D_BLOCK);
        let index = p.y * params.width + p.x;
        var value = noisy[index][channel];
        if guide { value = basic[index][channel]; }
        write_spectrum(k * PATCH + lane, value, guide);
        scratch[k * PATCH + lane] = value;
    }
    workgroupBarrier();
    for (var n = PATCH / 2u; n > 0u; n /= 2u) {
        if lane < n {
            for (var k = 0u; k < count; k++) {
                scratch[k * PATCH + lane] += scratch[k * PATCH + lane + n];
            }
        }
        workgroupBarrier();
    }
    if lane == 0u {
        for (var k = 0u; k < count; k++) {
            let mean = scratch[k * PATCH] / f32(PATCH);
            if guide { guide_means[k] = mean; }
            else { means[k] = mean; }
        }
        if guide { reference_guide_mean = guide_means[0]; }
        else { reference_mean = means[0]; }
    }
    workgroupBarrier();
    for (var k = 0u; k < count; k++) {
        var mean = means[k];
        if guide { mean = guide_means[k]; }
        write_spectrum(k * PATCH + lane, read_spectrum(k * PATCH + lane, guide) - mean, guide);
    }
    workgroupBarrier();
    if lane == 0u {
        for (var k = 0u; k < count; k++) {
            if guide { guide_means[k] -= reference_guide_mean; }
            else { means[k] -= reference_mean; }
        }
    }
    dct(lane, count, guide, false);
}

fn wht(values: ptr<function, array<f32, BM3D_GROUP_MAX>>, count: u32) {
    for (var h = 1u; h < count; h *= 2u) {
        for (var i = 0u; i < count; i += h * 2u) {
            for (var j = i; j < i + h; j++) {
                let a = (*values)[j];
                let b = (*values)[j + h];
                (*values)[j] = (a + b) * BM3D_INV_SQRT2;
                (*values)[j + h] = (a - b) * BM3D_INV_SQRT2;
            }
        }
    }
}

struct Shrunk {
    values: array<f32, BM3D_GROUP_MAX>,
    weights: array<f32, BM3D_GROUP_MAX>,
};

fn shrink(values: array<f32, BM3D_GROUP_MAX>, guide: array<f32, BM3D_GROUP_MAX>, count: u32, sigma: f32) -> Shrunk {
    var v = values;
    var g = guide;
    var weights: array<f32, BM3D_GROUP_MAX>;
    wht(&v, count);
    if params.wiener != 0u { wht(&g, count); }
    for (var k = 0u; k < count; k++) {
        if params.wiener != 0u {
            let b2 = g[k] * g[k];
            let w = b2 / (b2 + sigma * sigma);
            v[k] *= w;
            weights[k] = w * w;
        } else {
            let retained = abs(v[k]) >= BM3D_LAMBDA_HT * sigma;
            v[k] = select(0.0, v[k], retained);
            weights[k] = select(0.0, 1.0, retained);
        }
    }
    wht(&v, count);
    return Shrunk(v, weights);
}

@compute @workgroup_size(PATCH)
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    if lane == 0u { member_count = matches[group.x].count; }
    let count = workgroupUniformLoad(&member_count);
    prepare(lane, group.x, group.y, count, false);
    if params.wiener != 0u { prepare(lane, group.x, group.y, count, true); }
    let sigmas = vec3<f32>(matches[group.x].sigma_y, matches[group.x].sigma_c1, matches[group.x].sigma_c2);
    let sigma = sigmas[group.y];
    var values: array<f32, BM3D_GROUP_MAX>;
    var guide: array<f32, BM3D_GROUP_MAX>;
    for (var k = 0u; k < count; k++) {
        values[k] = spectra[k * PATCH + lane];
        guide[k] = guide_spectra[k * PATCH + lane];
    }
    let result = shrink(values, guide, count, sigma);
    for (var k = 0u; k < count; k++) {
        spectra[k * PATCH + lane] = result.values[k];
        // The guide is no longer needed. Reuse its storage for weight terms.
        guide_spectra[k * PATCH + lane] = result.weights[k];
    }
    if lane == 0u {
        let filtered_means = shrink(means, guide_means, count, sigma / f32(BM3D_BLOCK));
        means = filtered_means.values;
        guide_means = filtered_means.weights;
    }
    workgroupBarrier();
    let record = group.x * 3u + group.y;
    if lane == 0u {
        var sum = 0.0;
        // CPU order: coefficient first, group member second, means last.
        for (var j = 0u; j < PATCH; j++) {
            for (var k = 0u; k < count; k++) { sum += guide_spectra[k * PATCH + j]; }
        }
        for (var k = 0u; k < count; k++) { sum += guide_means[k]; }
        let epsilon = select(1.0, 1e-8, params.wiener != 0u);
        group_weight = 1.0 / (epsilon + sum);
        output[record].weight = group_weight;
        output[record].pad = array<u32, 3>(0u, 0u, 0u);
    }
    dct(lane, count, false, true);
    for (var k = 0u; k < count; k++) {
        let p = matches[group.x].positions[k] + vec2<u32>(lane % BM3D_BLOCK, lane / BM3D_BLOCK);
        let estimate = spectra[k * PATCH + lane] + (reference_mean + means[k]);
        scratch[k * PATCH + lane] = estimate - noisy[p.y * params.width + p.x][group.y];
    }
    workgroupBarrier();
    for (var k = 0u; k < BM3D_GROUP_MAX; k++) {
        var value = 0.0;
        if k < count { value = group_weight * scratch[k * PATCH + lane]; }
        // Store the rounded product before aggregation's additions, preventing
        // FMA contraction from changing the CPU accumulation order/rounding.
        output[record].weighted_deltas[k * PATCH + lane] = value;
    }
}
