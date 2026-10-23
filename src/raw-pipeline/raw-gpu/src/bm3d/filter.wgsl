@group(0) @binding(1) var<storage, read> noisy: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> guide: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> groups: array<u32>;
@group(0) @binding(4) var<storage, read_write> accum: array<vec2<f32>>;

// Four group members travel in registers together. Alternating workspaces
// prevent a writer racing a preceding transform axis's reads.
var<workgroup> work_a: array<vec4<f32>, 256>;
var<workgroup> work_b: array<vec4<f32>, 256>;
var<workgroup> means: array<f32, 16>;
var<workgroup> guide_means: array<f32, 16>;
var<workgroup> stats: array<f32, 64>;
var<workgroup> weight: f32;

fn patch_means(value: vec4<f32>, lane: u32, is_guide: bool, n: u32) {
    let coefficient = lane % 64u;
    let slot = lane / 64u;
    var sum = value;
    var phase = 0u;
    for (var step = 32u; step > 0u; step /= 2u) {
        if phase % 2u == 0u { work_a[lane] = sum; } else { work_b[lane] = sum; }
        workgroupBarrier();
        if coefficient < step {
            if phase % 2u == 0u { sum += work_a[lane+step]; } else { sum += work_b[lane+step]; }
        }
        phase++;
    }
    if coefficient == 0u {
        for (var q = 0u; q < 4u; q++) {
            let k = slot+4u*q;
            if k < n {
                if is_guide { guide_means[k] = sum[q]/64.0; } else { means[k] = sum[q]/64.0; }
            }
        }
    }
    workgroupBarrier();
}

fn spatial_transform(value: vec4<f32>, lane: u32, inverse: bool) -> vec4<f32> {
    let coefficient = lane%64u;
    let slot = lane/64u;
    let row = coefficient/8u;
    let col = coefficient%8u;
    var v = value;
    for (var axis = 0u; axis < 2u; axis++) {
        if axis == 0u { work_a[lane] = v; } else { work_b[lane] = v; }
        workgroupBarrier();
        let vertical = (axis == 1u) != inverse;
        let at = select(col, row, vertical);
        var sum = vec4<f32>(0.0);
        for (var j = 0u; j < 8u; j++) {
            var i = slot*64u+row*8u+j;
            if vertical { i = slot*64u+j*8u+col; }
            var a = work_a[i];
            if axis == 1u { a = work_b[i]; }
            var b = basis(at,j);
            if inverse { b = basis(j,at); }
            sum += a*b;
        }
        v = sum;
    }
    return v;
}

fn group_transform(value: vec4<f32>, lane: u32, n: u32) -> vec4<f32> {
    let coefficient = lane%64u;
    let slot = lane/64u;
    var v = value;
    for (var h = 1u; h <= 2u; h *= 2u) {
        if h == 1u { work_a[lane] = v; } else { work_b[lane] = v; }
        workgroupBarrier();
        if h < n {
            let other = (slot^h)*64u+coefficient;
            var neighbor = work_a[other];
            if h == 2u { neighbor = work_b[other]; }
            v = select(neighbor-v, v+neighbor, vec4<bool>((slot&h)==0u))*0.7071067811865476;
        }
    }
    if n > 4u { v = vec4<f32>(v.x+v.y,v.x-v.y,v.z+v.w,v.z-v.w)*0.7071067811865476; }
    if n > 8u { v = vec4<f32>(v.x+v.z,v.y+v.w,v.x-v.z,v.y-v.w)*0.7071067811865476; }
    return v;
}

// Lane zero evaluates the small means vector in the CPU's scan order.
fn mean_wht(n: u32, is_guide: bool) {
    for (var h = 1u; h < n; h *= 2u) {
        for (var i = 0u; i < n; i += 2u*h) {
            for (var j = i; j < i+h; j++) {
                var a = means[j]; var b = means[j+h];
                if is_guide { a = guide_means[j]; b = guide_means[j+h]; }
                let sum = (a+b)*0.7071067811865476;
                let difference = (a-b)*0.7071067811865476;
                if is_guide { guide_means[j]=sum; guide_means[j+h]=difference; }
                else { means[j]=sum; means[j+h]=difference; }
            }
        }
    }
}

fn finish_means(lane:u32,n:u32,wiener:bool,sigma:f32) {
    if lane == 0u {
        let anchor=means[0]; let guide_anchor=guide_means[0];
        for (var k=0u;k<n;k++) { means[k]-=anchor; if wiener { guide_means[k]-=guide_anchor; } }
        mean_wht(n,false);
        if wiener { mean_wht(n,true); }
        var total=0.0;
        for (var i=0u;i<64u;i++) { total+=stats[i]; }
        for (var k=0u;k<n;k++) {
            if wiener {
                let b2=guide_means[k]*guide_means[k];
                let gain=b2/(b2+(sigma/8.0)*(sigma/8.0));
                means[k]*=gain; total+=gain*gain;
            } else {
                if abs(means[k])<p.scale.w*(sigma/8.0) { means[k]=0.0; } else { total+=1.0; }
            }
        }
        mean_wht(n,false);
        for (var k=0u;k<n;k++) { means[k]+=anchor; }
        weight=1.0/(select(1.0,1e-8,wiener)+total);
    }
    workgroupBarrier();
}

@compute @workgroup_size(256)
fn filter_groups(@builtin(workgroup_id) id: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    let cols = (p.dims.z-p.control.z+5u)/6u;
    let rows = (p.dims.w-p.control.w+5u)/6u;
    let dispatched = group_index(id);
    if dispatched >= cols*rows*3u { return; }
    let local_group = dispatched%(cols*rows);
    let channel = dispatched/(cols*rows);
    let gx = p.control.z+(local_group%cols)*6u;
    let gy = p.control.w+(local_group/cols)*6u;
    let base = 4u+(gy*p.dims.z+gx)*17u;
    let n = groups[base];
    let coefficient = lane%64u;
    let slot = lane/64u;
    let wiener = p.control.y!=0u;
    let sigma = bitcast<f32>(groups[0])*select(p.scale.y,1.0,channel==0u);
    var v = vec4<f32>(0.0);
    var b = vec4<f32>(0.0);
    for (var q = 0u; q < 4u; q++) {
        let k = slot+q*4u;
        if k < n {
            let at = groups[base+1u+k]+(coefficient/8u)*p.dims.x+coefficient%8u;
            v[q] = opponent(noisy[at].rgb,channel);
            if wiener { b[q] = guide[at][channel]; }
        }
    }
    patch_means(v,lane,false,n);
    if wiener { patch_means(b,lane,true,n); }
    for (var q = 0u; q < 4u; q++) {
        let k = slot+q*4u;
        if k < n { v[q]-=means[k]; if wiener { b[q]-=guide_means[k]; } }
    }
    v = spatial_transform(v,lane,false);
    if wiener { b = spatial_transform(b,lane,false); }
    v = group_transform(v,lane,n);
    if wiener { b = group_transform(b,lane,n); }
    var contribution = vec4<f32>(0.0);
    if wiener {
        let gain = b*b/(b*b+vec4<f32>(sigma*sigma));
        v *= gain;
        contribution = gain*gain;
    } else {
        let retained = abs(v)>=vec4<f32>(p.scale.w*sigma);
        v = select(vec4<f32>(0.0),v,retained);
        contribution = select(vec4<f32>(0.0),vec4<f32>(1.0),retained);
    }
    for (var q = 0u; q < 4u; q++) { if slot+q*4u>=n { contribution[q]=0.0; } }
    work_a[lane] = contribution;
    workgroupBarrier();
    if slot == 0u {
        var total = 0.0;
        for (var k = 0u; k < n; k++) { total += work_a[(k%4u)*64u+coefficient][k/4u]; }
        stats[coefficient] = total;
    }
    workgroupBarrier();
    finish_means(lane,n,wiener,sigma);
    v = group_transform(v,lane,n);
    v = spatial_transform(v,lane,true);
    for (var q=0u;q<4u;q++) { if slot+q*4u<n { v[q]+=means[slot+q*4u]; } }
    for (var k=0u;k<16u;k++) {
        if k<n && slot==k%4u {
            let pixel=groups[base+1u+k]+(coefficient/8u)*p.dims.x+coefficient%8u;
            let original=opponent(noisy[pixel].rgb,channel);
            let at=channel*p.dims.x*p.dims.y+pixel;
            accum[at]+=vec2<f32>(weight*(v[k/4u]-original),weight);
        }
        storageBarrier();
    }
}
