// scene_tone_controls.wgsl — scene-referred tone controls (raw-core spec § 3.6).
//
// A P2 scene-linear stage (epic #925 / #990). Ports the six luma-coupled
// tone steps of `raw_core::stages::scene_tone_controls::apply`, in order:
//   1.  exposure   (linear gain 2^exposure)
//   1b. brightness (midtone-band gain, #1102 / tone-zoom design § 4.1)
//   2.  highlights (luma-coupled soft compression above knee = 1.0)
//   3.  shadows    (luma-masked multiplicative lift of deep values)
//   4.  whites     (smoothstep-weighted gain near the diffuse-white endpoint)
//   5.  blacks     (smoothstep-weighted toe — sign-branched crush/lift)
//
// PARITY-CRITICAL invariants (mirrored verbatim from the Rust stage):
//
// * SEQUENTIAL, in-register: each step mutates the running pixel and the NEXT
//   step recomputes luma `Y = dot(LUMA_REC2020, p)` from the UPDATED pixel — NOT
//   from a single luma snapshot taken up front. Recomputing per step is what
//   makes the GPU output match the Rust loop bit-for-near-bit.
// * Per-field activation thresholds: exposure |·| ≥ 1e-6; brightness/highlights/
//   shadows/whites/blacks |·| ≥ 1e-3. A field below threshold is skipped (its
//   branch does not run), exactly as the Rust `apply_*` flags gate each block.
// * Nested guards preserved: highlights only acts when `h_denom.abs() > 1e-6`
//   AND `y_old > 1.0`; blacks branches on sign (crush = multiplicative when
//   `b_amount < 0`, lift = additive otherwise).
//
// Contrast and the parametric/tone-curve steps are intentionally NOT here — the
// Rust stage applies neither (contrast modulates the AgX slope downstream). The
// whole-stage identity short-circuit lives in the chain (it simply doesn't
// enqueue the pass when all five fields are ~0), mirroring vibrance.
//
// This kernel uses no generated color matrices — LUMA_REC2020 is a stage-local
// const pinned to the raw-core source — so it compiles standalone (like
// exposure / white_balance), with no `color_matrices.wgsl` concat.

// Rec.2020 luma weights. Verbatim from
// raw_core::stages::scene_tone_controls::LUMA_REC2020 (= [0.2627, 0.6780, 0.0593]).
const LUMA_REC2020: vec3<f32> = vec3<f32>(0.2627, 0.6780, 0.0593);

struct Params {
    exposure: f32,    // EV; gain = 2^exposure
    brightness: f32,  // -100..100 (midtone-band gain, #1102)
    highlights: f32,  // -100..100
    shadows: f32,     // -100..100
    whites: f32,      // -100..100
    blacks: f32,      // -100..100
    count: u32,       // number of RGBA pixels
    _pad0: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;

fn luma(p: vec3<f32>) -> f32 {
    return dot(LUMA_REC2020, p);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= params.count) {
        return;
    }
    let px = input_buf[i];
    var p = px.rgb;

    // Per-field activation flags + derived amounts — mirror the Rust stage's
    // `apply_*` gates and the amount preconditioning above the pixel loop.
    let apply_exposure = abs(params.exposure) >= 1e-6;
    let apply_brightness = abs(params.brightness) >= 1e-3;
    let apply_highlights = abs(params.highlights) >= 1e-3;
    let apply_shadows = abs(params.shadows) >= 1e-3;
    let apply_whites = abs(params.whites) >= 1e-3;
    let apply_blacks = abs(params.blacks) >= 1e-3;

    let exp_gain = exp2(params.exposure);

    // Brightness EV-per-unit-weight amount (raw-core B_STRENGTH = 0.7).
    let br_amount = 0.7 * params.brightness / 100.0;

    let h_amount = params.highlights / 100.0;
    let h_denom = 1.0 + h_amount * 2.0;

    let s_amount = params.shadows / 100.0;
    let s_factor = s_amount * 0.5;

    let w_amount = params.whites / 200.0;

    let b_amount = params.blacks / 100.0;   // -1..+1
    let b_add_pos = params.blacks / 400.0;  // additive lift amount, positive branch only

    // 1. Exposure — linear gain.
    if (apply_exposure) {
        p = p * exp_gain;
    }

    // 1b. Brightness — midtone-band gain (#1102, tone-zoom design § 4.1).
    //     w(Y) = smoothstep(0.05, 0.25, Y) · (1 − smoothstep(1.0, 4.0, Y));
    //     gain = exp2(0.7 · b/100 · w). Exactly 1.0 at Y ≤ 0.05 and Y ≥ 4.0
    //     (band ends pinned). Uniform scalar multiply → hue-preserving.
    //     Constants pinned to raw-core's B_LO0/B_LO1/B_HI0/B_HI1/B_STRENGTH.
    if (apply_brightness) {
        let y = luma(p);
        let w = smoothstep(0.05, 0.25, y) * (1.0 - smoothstep(1.0, 4.0, y));
        let gain = exp2(br_amount * w);
        p = p * gain;
    }

    // 2. Highlights — luminance-coupled soft compression above knee = 1.0.
    //    Below the knee (Y ≤ 1.0) the pixel passes through unchanged. Hue is
    //    preserved: the only operation on RGB is a uniform scalar multiply.
    if (apply_highlights && abs(h_denom) > 1e-6) {
        let y_old = luma(p);
        if (y_old > 1.0) {
            let y_new = 1.0 + (y_old - 1.0) / h_denom;
            let scale = y_new / y_old;
            p = p * scale;
        }
    }

    // 3. Shadows — luminance-masked lift of deep values.
    if (apply_shadows) {
        let l = luma(p);
        let mask = 1.0 - smoothstep(0.0, 0.1, l);
        let lift = mask * s_factor;
        p = p + p * lift;
    }

    // 4. Whites — smoothstep-weighted gain near the diffuse-white endpoint.
    if (apply_whites) {
        let y_old = luma(p);
        let w = smoothstep(0.5, 1.0, y_old);
        let w_gain = 1.0 + w_amount * w;
        p = p * w_gain;
    }

    // 5. Blacks — smoothstep-weighted toe. Sign-branched:
    //    < 0  → multiplicative crush  (factor = 1 + (blacks/100) * w)
    //    ≥ 0  → additive lift         (delta  = (blacks/400) * w)
    //    The asymmetry is intentional (a multiplicative lift would no-op p=0).
    if (apply_blacks) {
        let y_old = luma(p);
        let w = 1.0 - smoothstep(0.0, 0.2, y_old);
        if (b_amount < 0.0) {
            let factor = 1.0 + b_amount * w;
            p = p * factor;
        } else {
            let delta = b_add_pos * w;
            p = p + vec3<f32>(delta, delta, delta);
        }
    }

    output_buf[i] = vec4<f32>(p, px.a);
}
