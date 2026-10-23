@group(0) @binding(1) var<storage, read> input: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> samples: array<u32>;
@group(0) @binding(3) var<storage, read_write> groups: array<u32>;
@group(0) @binding(4) var<storage,read_write> selected:array<atomic<u32>>;

var<workgroup> tile: array<f32, 676>;
var<workgroup> reference: array<f32, 64>;
var<workgroup> distances: array<f32, 512>;
var<workgroup> locations: array<u32, 512>;

fn guide_value(at: vec2<u32>) -> f32 {
    return input[at.y * p.dims.x + at.x].x;
}


@compute @workgroup_size(256)
fn match_groups(@builtin(workgroup_id) id: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    let g = group_index(id);
    if g >= p.dims.z * p.dims.w { return; }
    let xy = ref_xy(g);
    let half = u32(p.luma.w);
    let lo = vec2<u32>(max(vec2<i32>(xy) - vec2<i32>(i32(half)), vec2<i32>(0)));
    let hi = min(xy+vec2<u32>(half), p.dims.xy-vec2<u32>(8u));
    let extent=hi+vec2<u32>(8u)-lo;
    for (var i=lane;i<676u;i+=256u) {
        let at=vec2<u32>(i%26u,i/26u);
        var value=0.0;
        if all(at<extent) { value=guide_value(lo+at); }
        tile[i]=value;
    }
    workgroupBarrier();
    if lane<64u {
        let at=xy-lo+vec2<u32>(lane%8u,lane/8u);
        reference[lane]=tile[at.y*26u+at.x]-input[xy.y*p.dims.x+xy.x].y;
    }
    workgroupBarrier();
    let row_width = hi.x - lo.x + 1u;
    let candidates = row_width * (hi.y - lo.y + 1u);
    let sigma = p.scale.x * (max(bitcast<f32>(samples[2]), 0.0) + p.extra.x);
    let tau = p.scale.z * sigma * sigma;
    for (var c = lane; c < 512u; c += 256u) {
        locations[c] = c;
        distances[c] = bitcast<f32>(0x7f800000u);
        if c >= candidates { continue; }
        let at = lo + vec2<u32>(c % row_width, c / row_width);
        if all(at == xy) { continue; }
        let mean = input[at.y * p.dims.x + at.x].y;
        let offset=(at.y-lo.y)*26u+at.x-lo.x;
        var distance = 0.0;
        for (var i = 0u; i < 64u; i++) {
            let value = tile[offset+(i/8u)*26u+i%8u];
            let d = reference[i] - (value - mean);
            distance = fma(d, d, distance);
        }
        distance /= 64.0;
        if distance <= tau { distances[c] = distance; }
    }
    workgroupBarrier();
    sort_candidates(lane);
    if lane == 0u {
        if g == 0u { groups[0] = bitcast<u32>(sigma); }
        let base = 4u + g * 17u;
        groups[base + 1u] = pack_patch(xy);
        var n = 1u;
        for (var k = 0u; k < 15u; k++) {
            if distances[k] == bitcast<f32>(0x7f800000u) { break; }
            let selected = locations[k];
            let at = lo + vec2<u32>(selected % row_width, selected / row_width);
            groups[base + 1u + n] = pack_patch(at);
            n++;
        }
        let count=1u << u32(floor(log2(f32(n))));
        groups[base]=count;
        for (var k=0u;k<count;k++) {
            let origin=unpack_patch(groups[base+1u+k]);
            atomicStore(&selected[origin.y*p.dims.x+origin.x],1u);
        }
    }
}
