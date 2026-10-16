@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> state: State;
@group(0) @binding(2) var<storage, read> partials: array<Partial>;
@group(0) @binding(3) var<storage, read_write> output_gain: vec4<f32>;

@compute @workgroup_size(1)
fn main() {
    output_gain = vec4<f32>(1.0);
    if state.length == 0u { return; }
    let low = state.ranks[0];
    let high = state.ranks[1];
    let centered = key_value(high.key) <= 4.0 * AE_FLOOR;
    var sum = vec2<f32>(0.0);
    var count = 0u;
    for (var g = 0u; g < params.groups; g++) {
        sum = add_sum(add_sum(sum, partials[g].sum.x), partials[g].sum.y);
        count += partials[g].count;
    }
    let interior_count = count;
    if low.key == high.key {
        if key_value(low.key) > 0.0 {
            count = state.end - state.length / 4u;
            sum = vec2<f32>(f32(count) * log_luminance(key_value(low.key), centered), 0.0);
        }
    } else {
        let lo_count = low.multiplicity - low.residual;
        let hi_count = high.residual + 1u;
        if key_value(low.key) > 0.0 {
            sum = add_sum(sum, f32(lo_count) * log_luminance(key_value(low.key), centered));
            count += lo_count;
        }
        if key_value(high.key) > 0.0 {
            sum = add_sum(sum, f32(hi_count) * log_luminance(key_value(high.key), centered));
            count += hi_count;
        }
    }
    if count == 0u { return; }
    // A constant positive band has its exact input value as geometric mean.
    // log/exp roundoff near AE_FLOOR would otherwise flip identity to an 8x gain.
    let positive_constant = low.key == high.key ||
        (interior_count == 0u && key_value(low.key) <= 0.0);
    let midgrey = select(mean_luminance((sum.x + sum.y) / f32(count), centered), key_value(high.key), positive_constant);
    if midgrey < AE_FLOOR || (bitcast<u32>(midgrey) & 0x7f800000u) == 0x7f800000u { return; }
    let mid_gain = min(AE_MIDGRAY / midgrey, AE_MAX_GAIN);
    let p95 = key_value(state.ranks[2].key);
    var high_gain = mid_gain;
    if p95 > AE_FLOOR { high_gain = min(AE_HIGHLIGHT / p95, AE_MAX_GAIN); }
    let gain = max(mid_gain, high_gain);
    if gain > 0.0 { output_gain.x = min(gain, AE_MAX_GAIN); }
}
