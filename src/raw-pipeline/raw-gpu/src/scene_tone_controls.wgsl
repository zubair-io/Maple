// scene_tone_controls.wgsl — scene-referred POINT tone steps (raw-core
// spec § 3.6 + tone-zoom design § 4.1).
//
// A P2 scene-linear stage (epic #925 / #990). Ports the point-op tone steps
// of `raw_core::stages::scene_tone_controls::apply`, in order:
//   1.  exposure   (linear gain 2^exposure)
//   1b. brightness (midtone-band gain, #1102 / tone-zoom design § 4.1)
//   4.  whites     (smoothstep-weighted gain near the diffuse-white endpoint)
//   5.  blacks     (smoothstep-weighted toe — sign-branched crush/lift)
//
// Highlights and shadows (steps 2–3) moved OUT of this kernel at #1103: they
// are spatial now (tonal detail mask over a blurred luma plane) and run as
// `scene_tone_sh.wgsl` dispatches between the two halves of this kernel. The
// `SceneToneControlsPass` host encodes:
//   this kernel (exposure + brightness, whites/blacks zeroed)
//   → [luma extract → 3× box blur → scene_tone_sh (highlights)]
//   → [luma extract → 3× box blur → scene_tone_sh (shadows)]
//   → this kernel (whites + blacks, exposure/brightness zeroed)
// and collapses to a SINGLE all-four-fields dispatch when neither highlights
// nor shadows is active (then 1 → 1b → 4 → 5 here ≡ the Rust loops, which
// run the same point steps in the same order).
//
// PARITY-CRITICAL invariants (mirrored verbatim from the Rust stage):
//
// * SEQUENTIAL, in-register: each step mutates the running pixel and the NEXT
//   step recomputes luma `Y = dot(LUMA_REC2020, p)` from the UPDATED pixel — NOT
//   from a single luma snapshot taken up front. Recomputing per step is what
//   makes the GPU output match the Rust loop bit-for-near-bit.
// * Per-field activation thresholds: exposure |·| ≥ 1e-6; brightness/whites/
//   blacks |·| ≥ 1e-3. A field below threshold is skipped (its branch does
//   not run), exactly as the Rust `apply_*` flags gate each block.
// * Blacks branches on sign (crush = multiplicative when `b_amount < 0`,
//   lift = additive otherwise).
//
// Contrast and the parametric/tone-curve steps are intentionally NOT here — the
// Rust stage applies neither (contrast modulates the AgX slope downstream). The
// whole-stage identity short-circuit lives in the chain (it simply doesn't
// enqueue the pass when all six fields are ~0), mirroring vibrance.
//
// This kernel uses no generated color matrices — LUMA_REC2020 is a stage-local
// const pinned to the raw-core source — so it compiles standalone (like
// exposure / white_balance), with no `color_matrices.wgsl` concat.

// Rec.2020 luma weights. Verbatim from
// raw_core::stages::scene_tone_controls::LUMA_REC2020 (= [0.2627, 0.6780, 0.0593]).
const LUMA_REC2020: vec3<f32> = vec3<f32>(0.2627, 0.6780, 0.0593);

// Whites/blacks monotonicity bounds (#1918). Pinned to the raw-core stage
// raw_core::stages::scene_tone_controls::{WHITES_MIN_GAIN, B_CRUSH_EDGE,
// B_LIFT_EDGE}; the parity test gates them against the real stage. See the
// per-constant derivations there — the whites negative gain is floored so the
// upper-end op stays monotone, and the blacks LIFT toe uses the WIDER 0.40 edge
// (the CRUSH toe keeps the 0.2 edge, already monotone).
const WHITES_MIN_GAIN: f32 = 0.32;
const B_CRUSH_EDGE: f32 = 0.2;
const B_LIFT_EDGE: f32 = 0.40;

struct Params {
    exposure: f32,    // EV; gain = 2^exposure
    brightness: f32,  // -100..100 (midtone-band gain, #1102)
    whites: f32,      // -100..100
    blacks: f32,      // -100..100
    count: u32,       // number of RGBA pixels
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;

fn luma(p: vec3<f32>) -> f32 {
    return dot(LUMA_REC2020, p);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let px = input_buf[i];
    var p = px.rgb;

    // Per-field activation flags + derived amounts — mirror the Rust stage's
    // `apply_*` gates and the amount preconditioning above the pixel loop.
    let apply_exposure = abs(params.exposure) >= 1e-6;
    let apply_brightness = abs(params.brightness) >= 1e-3;
    let apply_whites = abs(params.whites) >= 1e-3;
    let apply_blacks = abs(params.blacks) >= 1e-3;

    let exp_gain = exp2(params.exposure);

    // Brightness EV-per-unit-weight amount (raw-core B_STRENGTH = 0.7).
    let br_amount = 0.7 * params.brightness / 100.0;

    // Whites negative-gain floor (#1918): positive gain is unconditionally
    // monotone and passes through unclamped; the negative side saturates at
    // −WHITES_MIN_GAIN. Mirrors raw-core's `(whites/200).max(-WHITES_MIN_GAIN)`.
    let w_amount = max(params.whites / 200.0, -WHITES_MIN_GAIN);

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
        if (b_amount < 0.0) {
            // Crush: multiplicative, toe weight over the 0.2 edge (B_CRUSH_EDGE,
            // already monotone — unchanged, #1918).
            let w = 1.0 - smoothstep(0.0, B_CRUSH_EDGE, y_old);
            let factor = 1.0 + b_amount * w;
            p = p * factor;
        } else {
            // Lift: additive, toe weight over the WIDER 0.40 edge (B_LIFT_EDGE)
            // so the transfer stays monotone at the full +100 lift (#1918). The
            // Y=0 lift endpoint and the Y=0.40 midtone pin are preserved.
            let w = 1.0 - smoothstep(0.0, B_LIFT_EDGE, y_old);
            let delta = b_add_pos * w;
            let y_in = luma(p);
            if (y_in > 1e-6) {
                let y_out = y_in + delta;
                let scale = y_out / y_in;
                p = p * scale;
            } else {
                p = p + vec3<f32>(delta, delta, delta);
            }
        }
    }

    output_buf[i] = vec4<f32>(p, px.a);
}
