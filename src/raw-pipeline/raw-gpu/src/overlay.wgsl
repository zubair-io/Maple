// overlay.wgsl — canvas overlay surface (#5715).
//
// A fullscreen triangle whose fragment shader evaluates the overlay's
// coverage primitives at the pixel and composites them source-over onto
// transparent, writing premultiplied RGBA. The surface is upright and
// viewport-sized; the platform compositor places it above the image.
//
// PARITY-CRITICAL: `coverage` and the fold in `fs_main` mirror
// `raw_core::canvas::overlay::{coverage, overlay_pixel}` expression for
// expression. The `raw-gpu` parity test holds the two within one 8-bit step.
//
// `generated/canvas_overlay.wgsl` (OVERLAY_CAPACITY, OVERLAY_KIND_*) is
// prepended at pipeline creation; WGSL has no `#include`.

struct Primitive {
    rect: vec4<f32>,
    clip: vec4<f32>,
    color: vec4<f32>,
    kind: vec4<u32>,
};

struct Overlay {
    count: vec4<u32>,
    primitives: array<Primitive, OVERLAY_CAPACITY>,
};

@group(0) @binding(0) var<uniform> overlay: Overlay;

struct VsOut {
    @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VsOut {
    var out: VsOut;
    let x = f32((vid << 1u) & 2u);
    let y = f32(vid & 2u);
    out.pos = vec4<f32>(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
    return out;
}

fn axis_coverage(p: f32, lo: f32, hi: f32) -> f32 {
    return clamp(min(p + 1.0, hi) - max(p, lo), 0.0, 1.0);
}

fn rect_coverage(px: f32, py: f32, r: vec4<f32>) -> f32 {
    return axis_coverage(px, r.x, r.z) * axis_coverage(py, r.y, r.w);
}

fn coverage(p: Primitive, px: f32, py: f32) -> f32 {
    switch p.kind.x {
        case OVERLAY_KIND_FILL: {
            return rect_coverage(px, py, p.rect);
        }
        case OVERLAY_KIND_FILL_OUTSIDE: {
            return max(rect_coverage(px, py, p.clip) - rect_coverage(px, py, p.rect), 0.0);
        }
        case OVERLAY_KIND_DISC: {
            let dx = px + 0.5 - p.rect.x;
            let dy = py + 0.5 - p.rect.y;
            return clamp(p.rect.z - sqrt(dx * dx + dy * dy) + 0.5, 0.0, 1.0);
        }
        default: {
            return 0.0;
        }
    }
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let px = floor(in.pos.x);
    let py = floor(in.pos.y);
    let count = min(overlay.count.x, OVERLAY_CAPACITY);
    var acc = vec4<f32>(0.0);
    for (var i = 0u; i < count; i = i + 1u) {
        let p = overlay.primitives[i];
        let src = p.color * coverage(p, px, py);
        acc = src + acc * (1.0 - src.a);
    }
    return acc;
}
