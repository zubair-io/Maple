// Passthrough display proof (epic #925 / P1b, #988).
//
// A fullscreen triangle (3 vertices synthesized from @builtin(vertex_index),
// no vertex/index buffer) whose fragment shader emits a deterministic
// FOUR-QUADRANT test pattern: red (top-left), green (top-right),
// blue (bottom-left), white (bottom-right). Distinct primaries make a channel
// swap or gross colour-space shift instantly visible to a human on-device —
// the device logs aren't capturable, so the eyeball check IS the proof.
//
// The fragment emits NORMALIZED float RGBA, so wgpu maps it onto whatever
// surface format the CAMetalLayer hands us (typically Bgra8Unorm) without us
// having to care about channel byte-order. This is a PLUMBING proof, not a
// colour-correct render — the real display encode (Rec.2020→display, AgX) is
// P2.

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VsOut {
    // Oversized triangle covering the whole clip volume. UVs run 0..1 across
    // the visible [-1,1] square so the fragment shader can pick quadrants.
    var out: VsOut;
    let x = f32((vid << 1u) & 2u); // 0, 2, 0
    let y = f32(vid & 2u);         // 0, 0, 2
    out.pos = vec4<f32>(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
    out.uv = vec2<f32>(x, 1.0 - y); // flip Y so red lands top-left on screen
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let left = in.uv.x < 0.5;
    let top = in.uv.y < 0.5;
    if (top && left) {
        return vec4<f32>(1.0, 0.0, 0.0, 1.0); // red — top-left
    } else if (top && !left) {
        return vec4<f32>(0.0, 1.0, 0.0, 1.0); // green — top-right
    } else if (!top && left) {
        return vec4<f32>(0.0, 0.0, 1.0, 1.0); // blue — bottom-left
    }
    return vec4<f32>(1.0, 1.0, 1.0, 1.0);     // white — bottom-right
}
