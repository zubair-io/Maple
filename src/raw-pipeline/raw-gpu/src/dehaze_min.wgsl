// dehaze_min.wgsl — the dark-channel / transmission MIN-FILTER for dehaze (epic
// #925 P2 wave 3b / #990). A direct 2D window min over a 15×15 neighbourhood
// (radius 7), serving BOTH dehaze min-filters via a `mode` flag:
//
//   mode 0 (dark channel) — out = min over the window of min(r, g, b).
//   mode 1 (transmission) — out = 1 - OMEGA * (min over the window of
//                           min(r/A_r, g/A_g, b/A_b)), with each A clamped to
//                           >= 1e-6 (the transmission-only clamp).
//
// PARITY-CRITICAL — mirrors `raw_core::stages::dehaze::{dark_channel,transmission}`:
//   * Border policy is CLAMP-TO-EDGE: the window is ALWAYS the full
//     (2r+1)×(2r+1) and out-of-range samples replicate the nearest edge pixel
//     (`(x+dx).clamp(0, w-1)`), NOT the shrinking partial window the box blur
//     uses. So this is a DIRECT 2D loop, not the separable box-blur primitive.
//   * `min` carries no float-summation-order error, so the 2D window matches
//     raw-core's nested-loop min bit-for-bit.
//   * DARK_RADIUS = 7 (15×15), OMEGA = 0.95 — raw-core's constants.
//   * The per-channel ratio in mode 1 divides by `max(A, 1e-6)` (the
//     `a[c].max(1e-6)` guard raw-core applies INSIDE transmission only). The
//     raw, unclamped A is used later in recovery — that is a separate kernel.
//
// AIRLIGHT (epic #925 P4b / #1033): the atmospheric light A rides a SEPARATE
// uniform binding (binding 3), not the `Params` struct, so the SAME binding
// serves whether A was computed CPU-side (written via `queue.write_buffer`) or
// on-GPU (copied GPU→GPU from the airlight-reduce output into this uniform — no
// readback). Mode 0 (dark channel) ignores it.

struct Params {
    width: u32,
    height: u32,
    mode: u32,        // 0 = dark channel, 1 = transmission
    _pad0: u32,
};

// Atmospheric light (mode 1 only). vec4 for 16-byte alignment; .a unused. A
// SECOND uniform (#1033) so the airlight source — CPU `write_buffer` or an
// on-GPU `copy_buffer_to_buffer` — is transparent to the kernel.
struct Airlight {
    value: vec4<f32>,
};

const DARK_RADIUS: i32 = 7;   // 15×15 neighbourhood — raw-core's DARK_RADIUS.
const OMEGA: f32 = 0.95;      // transmission strength — raw-core's OMEGA.
const A_FLOOR: f32 = 1e-6;    // transmission-only per-channel A guard.

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<f32>;
@group(0) @binding(3) var<uniform> airlight: Airlight;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let w = i32(params.width);
    let h = i32(params.height);
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= u32(w * h)) {
        return;
    }
    let x = i32(i % params.width);
    let y = i32(i / params.width);

    // Per-channel reciprocal of the (clamped) airlight for mode 1. Computed once
    // per pixel; `max(A, A_FLOOR)` mirrors raw-core's `a[c].max(1e-6)`.
    let a = airlight.value;
    let inv_a = vec3<f32>(
        1.0 / max(a.r, A_FLOOR),
        1.0 / max(a.g, A_FLOOR),
        1.0 / max(a.b, A_FLOOR),
    );

    var m: f32 = 3.402823e38; // f32::INFINITY proxy; first sample overwrites it.
    for (var dy: i32 = -DARK_RADIUS; dy <= DARK_RADIUS; dy = dy + 1) {
        for (var dx: i32 = -DARK_RADIUS; dx <= DARK_RADIUS; dx = dx + 1) {
            // Clamp-to-edge: replicate the nearest in-range pixel.
            let ux = clamp(x + dx, 0, w - 1);
            let uy = clamp(y + dy, 0, h - 1);
            let p = input_buf[u32(uy * w + ux)];
            var local_min: f32;
            if (params.mode == 0u) {
                local_min = min(p.r, min(p.g, p.b));
            } else {
                let s = p.rgb * inv_a;
                local_min = min(s.r, min(s.g, s.b));
            }
            m = min(m, local_min);
        }
    }

    if (params.mode == 0u) {
        output_buf[i] = m;
    } else {
        output_buf[i] = 1.0 - OMEGA * m;
    }
}
