// Cache each potential patch's luma and tree-summed mean once, rather than
// recomputing its 64-value mean in every reference's search window.
@group(0) @binding(1) var<storage, read> input: array<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<vec2<f32>>;

@compute @workgroup_size(64)
fn prepare_luma(@builtin(global_invocation_id) id: vec3<u32>) {
    let i = index(id);
    if i >= p.dims.x * p.dims.y { return; }
    var y = input[4u * i];
    if p.control.y == 0u { y = luminance(vec3<f32>(input[4u*i], input[4u*i+1u], input[4u*i+2u])); }
    output[i] = vec2<f32>(y, 0.0);
}

fn tree_sum(v: array<f32, 8>) -> f32 {
    let a = v[0] + v[4];
    let b = v[1] + v[5];
    let c = v[2] + v[6];
    let d = v[3] + v[7];
    return fma(1.0, fma(1.0, a, c), fma(1.0, b, d));
}

@compute @workgroup_size(64)
fn vertical_mean(@builtin(global_invocation_id) id: vec3<u32>) {
    let i = index(id);
    if i >= p.dims.x * p.dims.y { return; }
    var sum = 0.0;
    if i / p.dims.x <= p.dims.y - 8u {
        var v: array<f32, 8>;
        for (var k = 0u; k < 8u; k++) { v[k] = input[2u * (i + k * p.dims.x)]; }
        sum = tree_sum(v);
    }
    output[i] = vec2<f32>(input[2u*i], sum);
}

@compute @workgroup_size(64)
fn horizontal_mean(@builtin(global_invocation_id) id: vec3<u32>) {
    let i = index(id);
    if i >= p.dims.x * p.dims.y { return; }
    var mean = 0.0;
    if i % p.dims.x <= p.dims.x - 8u {
        var v: array<f32, 8>;
        for (var k = 0u; k < 8u; k++) { v[k] = input[2u * (i + k) + 1u]; }
        mean = tree_sum(v) / 64.0;
    }
    output[i] = vec2<f32>(input[2u*i], mean);
}
