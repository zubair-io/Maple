@group(0) @binding(1) var<storage,read_write> blocks:array<u32>;
@group(0) @binding(2) var<storage,read_write> indirect:array<u32>;
@group(0) @binding(3) var<storage,read_write> worklist:array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) lane:u32) {
    if lane!=0u { return; }
    let count=(p.cache.z*p.cache.w+p.stream.z-1u)/p.stream.z;
    var sum=0u;
    for (var i=0u;i<count;i++) { let v=blocks[i];blocks[i]=sum;sum+=v; }
    let groups=(sum+p.stream.w-1u)/p.stream.w;
    let x=min(groups,65535u);
    indirect[0]=x;
    var y=0u;if x!=0u { y=(groups+x-1u)/x; }
    indirect[1]=y;indirect[2]=1u;indirect[3]=sum;
    worklist[0]=sum;
}
