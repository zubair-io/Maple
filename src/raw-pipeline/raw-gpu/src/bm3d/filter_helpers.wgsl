// Four group members travel in registers together. Alternating workspaces
// prevent a writer racing a preceding transform axis's reads.
var<workgroup> work_a: array<vec4<f32>, 256>;
var<workgroup> work_b: array<vec4<f32>, 256>;
var<workgroup> means: array<f32, 16>;
var<workgroup> guide_means: array<f32, 16>;
var<workgroup> stats: array<f32, 64>;
var<workgroup> weight: f32;

fn inverse_vertical_transpose(value:vec4<f32>,lane:u32)->vec4<f32> {
    let member=lane%16u;let block=lane/16u;
    let parity=block/8u;let col=block%8u;
    work_a[lane]=value;
    workgroupBarrier();
    let neighbor=work_a[lane^128u];
    let even=select(neighbor,value,vec4<bool>(parity==0u));
    let odd=select(value,neighbor,vec4<bool>(parity==0u));
    var out=vec4<f32>(0.0);
    {
        let row=parity+0u;
        var sum=0.0;
        sum+=even[0]*basis(0u,row);
        sum+=odd[0]*basis(1u,row);
        sum+=even[1]*basis(2u,row);
        sum+=odd[1]*basis(3u,row);
        sum+=even[2]*basis(4u,row);
        sum+=odd[2]*basis(5u,row);
        sum+=even[3]*basis(6u,row);
        sum+=odd[3]*basis(7u,row);
        out[0]=sum;
    }
    {
        let row=parity+2u;
        var sum=0.0;
        sum+=even[0]*basis(0u,row);
        sum+=odd[0]*basis(1u,row);
        sum+=even[1]*basis(2u,row);
        sum+=odd[1]*basis(3u,row);
        sum+=even[2]*basis(4u,row);
        sum+=odd[2]*basis(5u,row);
        sum+=even[3]*basis(6u,row);
        sum+=odd[3]*basis(7u,row);
        out[1]=sum;
    }
    {
        let row=parity+4u;
        var sum=0.0;
        sum+=even[0]*basis(0u,row);
        sum+=odd[0]*basis(1u,row);
        sum+=even[1]*basis(2u,row);
        sum+=odd[1]*basis(3u,row);
        sum+=even[2]*basis(4u,row);
        sum+=odd[2]*basis(5u,row);
        sum+=even[3]*basis(6u,row);
        sum+=odd[3]*basis(7u,row);
        out[2]=sum;
    }
    {
        let row=parity+6u;
        var sum=0.0;
        sum+=even[0]*basis(0u,row);
        sum+=odd[0]*basis(1u,row);
        sum+=even[1]*basis(2u,row);
        sum+=odd[1]*basis(3u,row);
        sum+=even[2]*basis(4u,row);
        sum+=odd[2]*basis(5u,row);
        sum+=even[3]*basis(6u,row);
        sum+=odd[3]*basis(7u,row);
        out[3]=sum;
    }
    work_b[lane]=out;
    workgroupBarrier();
    let coefficient=lane%64u;
    let row=coefficient/8u;
    let first=((row%2u)*8u+coefficient%8u)*16u+lane/64u;
    return vec4<f32>(work_b[first][row/2u],work_b[first+4u][row/2u],work_b[first+8u][row/2u],work_b[first+12u][row/2u]);
}
