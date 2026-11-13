// One writer per output pixel; reference groups and members use fixed order.
@group(0) @binding(1) var<storage,read> noisy:array<vec4<f32>>;
@group(0) @binding(2) var<storage,read> groups:array<u32>;
@group(0) @binding(3) var<storage,read> estimates:array<f32>;
@group(0) @binding(4) var<storage,read_write> accum:array<vec2<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id:vec3<u32>) {
    let i=index(id);
    let extent=p.cache.zw+vec2<u32>(7u);
    if i>=extent.x*extent.y { return; }
    let xy=p.cache.xy+vec2<u32>(i%extent.x,i/extent.x);
    let pixel=xy.y*p.dims.x+xy.x;
    let count=p.dims.x*p.dims.y;
    let original=vec3<f32>(opponent(noisy[pixel].rgb,0u),opponent(noisy[pixel].rgb,1u),opponent(noisy[pixel].rgb,2u));
    var num=vec3<f32>(accum[pixel].x,accum[count+pixel].x,accum[2u*count+pixel].x);
    var den=vec3<f32>(accum[pixel].y,accum[count+pixel].y,accum[2u*count+pixel].y);
    let half=u32(p.luma.w);let stride=p.sort.w;
    let lo=max((vec2<u32>(max(vec2<i32>(xy)-vec2<i32>(i32(half+7u)),vec2<i32>(0)))+vec2<u32>(stride-1u))/stride,p.batch.xy);
    var upper=(xy+vec2<u32>(half))/stride;
    if xy.x+half>=p.dims.x-8u { upper.x=p.dims.z-1u; }
    if xy.y+half>=p.dims.y-8u { upper.y=p.dims.w-1u; }
    let hi=min(upper,p.batch.xy+p.batch.zw-vec2<u32>(1u));
    for (var y=lo.y;y<=hi.y;y++) {
        for (var x=lo.x;x<=hi.x;x++) {
            let g=y*p.dims.z+x;
            let local_group=(y-p.batch.y)*p.batch.z+x-p.batch.x;
            let base=4u+g*17u;
            let er=local_group*1025u;
            let eg=(p.stream.y+local_group)*1025u;
            let eb=(2u*p.stream.y+local_group)*1025u;
            let weight=vec3<f32>(estimates[er],estimates[eg],estimates[eb]);
            for (var k=0u;k<groups[base];k++) {
                let position=groups[base+1u+k];
                let origin=unpack_patch(position);
                if any(xy<origin) || any(xy>=origin+vec2<u32>(8u)) { continue; }
                let at=xy-origin;
                let offset=1u+k*64u+at.y*8u+at.x;
                let filtered=vec3<f32>(estimates[er+offset],estimates[eg+offset],estimates[eb+offset]);
                num+=weight*(filtered-original);
                den+=weight;
            }
        }
    }
    accum[pixel]=vec2<f32>(num.x,den.x);
    accum[count+pixel]=vec2<f32>(num.y,den.y);
    accum[2u*count+pixel]=vec2<f32>(num.z,den.z);
}
