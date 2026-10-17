struct Params { width:u32, height:u32, groups:u32, shift:u32, strength:f32, pad0:u32, pad1:u32, pad2:u32 };
struct Rank { key:u32, residual:u32, pad0:u32, pad1:u32 };

fn key_value(key:u32)->f32 {
    return bitcast<f32>(select(~key,key ^ 0x80000000u,(key & 0x80000000u)!=0u));
}
