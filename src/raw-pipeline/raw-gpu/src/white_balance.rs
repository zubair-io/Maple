//! White-balance stage — a P2 scene-linear WGSL port (epic #925 / #990).
//!
//! Mirrors the vibrance template. The defining property of this stage is that
//! its whole derivation is **CPU-side and runtime**: `raw_core::stages::
//! white_balance::apply` turns `(temperature, tint, method)` into ONE
//! linear-Rec.2020 → linear-Rec.2020 3×3 matrix (CAT16 cone-space adaptation,
//! or a diagonal built from per-channel `wb_gains`) and then applies that matrix
//! per pixel via a single matmul. So the GPU stage carries the **already-derived
//! 3×3 matrix** and the kernel is a plain per-pixel row-major matmul — the
//! diagonal path is just a diagonal matrix, covered by the same kernel.
//!
//! Three pieces (the per-stage template):
//! 1. [`apply_white_balance`] — the CPU oracle: a row-major 3×3 matmul over a
//!    flat RGBA f32 buffer (alpha carried through), matching
//!    `raw_core::math::Matrix3::mul_vec` exactly.
//! 2. [`WhiteBalancePass`] — the GPU-resident [`Pass`]; carries the 3×3 matrix
//!    and uploads it as three `vec4` rows (NOT a `mat3x3`, which WGSL stores
//!    column-major and would transpose).
//! 3. The headless parity test (in `#[cfg(test)] mod tests`) — GPU vs
//!    `raw_core::stages::white_balance::apply` (the real stage, via the
//!    test-only `raw-core` dev-dep) `< 1e-4`, deriving the Pass matrix with
//!    raw-core's own `wb_cat16_matrix` / `wb_gains` so the GPU path and the
//!    reference are single-sourced on the WB math.

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::{encode_simple, pool_data_storage};

/// `repr(C)` params uniform shared by the WGSL kernel (`white_balance.wgsl`).
/// The 3×3 WB matrix is stored as three `[f32; 4]` rows (xyz = the matrix row,
/// w = padding) so the uniform keeps 16-byte row alignment and the kernel reads
/// it row-major (`dot(row, rgb)`) — matching `Matrix3::mul_vec`. A `mat3x3`
/// uniform would be column-major and silently transpose.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    row0: [f32; 4],
    row1: [f32; 4],
    row2: [f32; 4],
    count: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

/// Apply a linear-Rec.2020 → linear-Rec.2020 white-balance matrix to an
/// interleaved RGBA f32 buffer (alpha untouched). This is the CPU oracle — a
/// row-major 3×3 matmul, byte-for-byte the operation
/// `raw_core::stages::white_balance::apply` performs per pixel
/// (`apply_matrix_inplace` → `Matrix3::mul_vec`). The matrix is supplied
/// already-derived; the CCT/tint → matrix derivation is raw-core's job (CAT16 or
/// the diagonal-gain build) and the parity test single-sources it from there.
///
/// The whole-image identity short-circuit (`(temp, tint) == (6500, 0)`) lives in
/// raw-core's `apply`; on the GPU the chain simply doesn't enqueue a pass for a
/// neutral WB, mirroring how vibrance's near-zero slider is skipped by the chain.
pub fn apply_white_balance(buf: &mut [f32], matrix: [[f32; 3]; 3]) {
    for px in buf.chunks_exact_mut(4) {
        let (r, g, b) = (px[0], px[1], px[2]);
        // Row-major mul_vec — identical to raw_core::math::Matrix3::mul_vec.
        px[0] = matrix[0][0] * r + matrix[0][1] * g + matrix[0][2] * b;
        px[1] = matrix[1][0] * r + matrix[1][1] * g + matrix[1][2] * b;
        px[2] = matrix[2][0] * r + matrix[2][1] * g + matrix[2][2] * b;
        // px[3] (alpha) untouched
    }
}

/// The white-balance-retargeted HueSatMap of a dual-illuminant profile on the
/// live drag (#5099): the per-tick constants of raw-core's
/// `wb_camera::HsmRetargetView::live_delta` plus the session-constant
/// endpoint tables. With it the WB pass runs `white_balance_hsm.wgsl`
/// instead of the plain matmul.
#[derive(Clone, Debug)]
pub struct WbHsmInputs<'a> {
    /// `[hue_divs, sat_divs, val_divs]` of each table.
    pub dims: [u32; 3],
    /// The value axis is indexed sRGB-encoded (`HsmEncoding::Srgb`).
    pub srgb: bool,
    /// Cold table then warm table, each laid out as `HsmTable::data`.
    pub tables: WbHsmTables<'a>,
    /// Rec.2020 → linear ProPhoto D50.
    pub to_pro: [[f32; 3]; 3],
    /// The WB delta in ProPhoto.
    pub delta_pro: [[f32; 3]; 3],
    /// Linear ProPhoto D50 → Rec.2020.
    pub from_pro: [[f32; 3]; 3],
    /// Table blend weight at the slider target and at the buffer's anchor.
    pub w_target: f32,
    pub w_anchor: f32,
    /// Fixed-point steps of the anchor-table inverse (raw-core's
    /// `HsmLiveDelta::inverse_iterations`, the one source of the count).
    pub inverse_iterations: u32,
}

/// The endpoint tables, borrowed from an FFI host for one call or shared
/// with a session that owns them (the WASM live session keeps its chain
/// inputs `'static`), so neither copies the tables per tick.
#[derive(Clone, Debug)]
pub enum WbHsmTables<'a> {
    Borrowed(&'a [f32]),
    Shared(std::sync::Arc<[f32]>),
}

impl WbHsmTables<'_> {
    pub fn as_slice(&self) -> &[f32] {
        match self {
            WbHsmTables::Borrowed(tables) => tables,
            WbHsmTables::Shared(tables) => tables,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct HsmParams {
    to_pro: [[f32; 4]; 3],
    delta_pro: [[f32; 4]; 3],
    from_pro: [[f32; 4]; 3],
    count: u32,
    hue_divs: u32,
    sat_divs: u32,
    val_divs: u32,
    srgb: u32,
    table_len: u32,
    w_target: f32,
    w_anchor: f32,
    inverse_iterations: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

const _: () = assert!(
    std::mem::size_of::<HsmParams>() == 192,
    "HsmParams must match white_balance_hsm.wgsl's Params"
);

fn rows(m: &[[f32; 3]; 3]) -> [[f32; 4]; 3] {
    m.map(|r| [r[0], r[1], r[2], 0.0])
}

/// A GPU-resident white-balance stage. Carries the **already-derived** 3×3
/// linear-Rec.2020 WB matrix (CAT16 or diagonal — both collapse to a single
/// matmul), and on a dual-HueSatMap profile the retargeted-HueSatMap inputs.
/// The device, pipeline, and ping-pong buffers come from the [`GpuContext`] /
/// [`ChainRunner`]; the matrix is uploaded as three `vec4` rows inside `encode`.
pub struct WhiteBalancePass<'a> {
    /// Row-major 3×3 WB matrix (the output of raw-core's `wb_cat16_matrix`, or a
    /// diagonal built from `wb_gains`).
    pub matrix: [[f32; 3]; 3],
    /// `Some` routes the pass through `white_balance_hsm.wgsl`; `matrix` is
    /// then unused (the delta rides `hsm.delta_pro`).
    pub hsm: Option<&'a WbHsmInputs<'a>>,
}

impl Pass for WhiteBalancePass<'_> {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        let (width, height) = dims;
        let pixel_count = width * height;

        if let Some(hsm) = self.hsm {
            let params = HsmParams {
                to_pro: rows(&hsm.to_pro),
                delta_pro: rows(&hsm.delta_pro),
                from_pro: rows(&hsm.from_pro),
                count: pixel_count,
                hue_divs: hsm.dims[0],
                sat_divs: hsm.dims[1],
                val_divs: hsm.dims[2],
                srgb: hsm.srgb as u32,
                table_len: (hsm.tables.as_slice().len() / 2) as u32,
                w_target: hsm.w_target,
                w_anchor: hsm.w_anchor,
                inverse_iterations: hsm.inverse_iterations,
                _pad0: 0,
                _pad1: 0,
                _pad2: 0,
            };
            // Session-constant tables: pooled by content, uploaded once.
            let tables = pool_data_storage(
                ctx,
                bytemuck::cast_slice(hsm.tables.as_slice()),
                "wb-hsm-tables",
            );
            encode_simple(
                ctx,
                encoder,
                ctx.white_balance_hsm_pipeline(),
                bytemuck::bytes_of(&params),
                &[src, dst, tables.as_ref()],
                pixel_count,
                "white-balance-hsm",
            );
            return;
        }

        let m = &self.matrix;
        let params = Params {
            row0: [m[0][0], m[0][1], m[0][2], 0.0],
            row1: [m[1][0], m[1][1], m[1][2], 0.0],
            row2: [m[2][0], m[2][1], m[2][2], 0.0],
            count: pixel_count,
            _pad0: 0,
            _pad1: 0,
            _pad2: 0,
        };
        // Pooled per-pixel dispatch (P4b-core C3): params @0, src @1, dst @2.
        encode_simple(
            ctx,
            encoder,
            ctx.white_balance_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst],
            pixel_count,
            "white-balance",
        );
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "white_balance_hsm_tests.rs"]
mod hsm_tests;

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::chain::ChainRunner;
    use crate::image::GpuImage;
    use raw_core::types::WbMethod;

    /// A buffer spanning neutral, saturated, HDR-headroom (> 1), and a tiny
    /// negative channel — so the matmul is exercised across the scene-linear
    /// range (WB is a pure linear matrix, so there is no special branch to hit;
    /// the spread just guards against any channel-coupling sign error).
    fn wb_buffer() -> Vec<f32> {
        vec![
            // r,    g,    b,    a
            0.18, 0.18, 0.18, 1.0, // neutral mid-gray
            0.80, 0.10, 0.10, 1.0, // saturated red
            0.10, 0.80, 0.10, 0.7, // saturated green
            0.10, 0.10, 0.80, 1.0, // saturated blue
            5.00, 3.00, 1.50, 1.0, // HDR scene-headroom (> 1)
            -0.02, 0.30, 0.40, 0.5, // slightly-negative channel
            0.40, 0.40, 0.40, 1.0, // mid neutral
            0.02, 0.02, 0.02, 1.0, // deep shadow
        ]
    }

    /// Run `raw_core::stages::white_balance::apply` on a flat interleaved RGBA
    /// f32 buffer for `(temperature, tint, method)`, returning a new buffer
    /// (alpha carried through). This is the ticket's actual reference — the Rust
    /// stage itself.
    fn raw_core_white_balance(
        buf: &[f32],
        temperature: f32,
        tint: f32,
        method: WbMethod,
    ) -> Vec<f32> {
        use raw_core::image::{ColorSpace, Image};
        let count = buf.len() / 4;
        let mut img = Image::new(count as u32, 1, ColorSpace::SceneLinearRec2020);
        for (i, chunk) in buf.chunks_exact(4).enumerate() {
            img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
        }
        raw_core::stages::white_balance::apply(&mut img, temperature, tint, method);
        let mut out = Vec::with_capacity(buf.len());
        for (i, p) in img.pixels.iter().enumerate() {
            out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
        }
        out
    }

    /// Derive the same 3×3 matrix raw-core's `apply` uses for a given method,
    /// single-sourced from raw-core (`wb_cat16_matrix` for CAT16; a diagonal
    /// from `wb_gains` for the legacy path). The GPU [`WhiteBalancePass`]
    /// matmuls this matrix; gating it against `apply` with the SAME args proves
    /// the kernel reproduces the stage exactly — without re-typing the
    /// derivation in raw-gpu.
    fn wb_matrix(temperature: f32, tint: f32, method: WbMethod) -> [[f32; 3]; 3] {
        match method {
            WbMethod::Cat16 => {
                raw_core::stages::white_balance::wb_cat16_matrix(temperature, tint).0
            }
            WbMethod::DiagonalRec2020 => {
                let g = raw_core::stages::white_balance::wb_gains(temperature, tint);
                [[g[0], 0.0, 0.0], [0.0, g[1], 0.0], [0.0, 0.0, g[2]]]
            }
        }
    }

    /// THE PARITY GATE (the ticket's contract): the WGSL white-balance kernel
    /// matches `raw_core::stages::white_balance::apply` within 1e-4 across a
    /// spread of NON-DEFAULT `(temperature, tint)` values (dodging the
    /// `(6500, 0) ± 0.5` identity short-circuit in `apply`) for BOTH methods.
    /// The Pass matrix is derived by raw-core's own `wb_cat16_matrix` /
    /// `wb_gains`, so the GPU output is pinned to the canonical CPU stage.
    #[test]
    fn wgsl_white_balance_matches_raw_core_stage_within_1e_4() {
        let ctx = GpuContext::new_blocking().expect("gpu context");
        let input = wb_buffer();
        let count = (input.len() / 4) as u32;

        // (temperature, tint): warm/cool/extreme, all clear of the identity
        // short-circuit. Both WB methods.
        let cases: Vec<_> = [(3000.0_f32, 0.0_f32), (10000.0, 50.0), (2000.0, -50.0)]
            .into_iter()
            .chain(
                raw_core::types::adjustment::WhiteBalancePreset::ALL
                    .into_iter()
                    .filter_map(|preset| preset.pair()),
            )
            .collect();
        for method in [WbMethod::Cat16, WbMethod::DiagonalRec2020] {
            for &(temp, tint) in &cases {
                let reference = raw_core_white_balance(&input, temp, tint, method);
                let matrix = wb_matrix(temp, tint, method);

                let img = GpuImage::upload(&ctx, &input, count, 1);
                let runner = ChainRunner::new(&ctx, &img);
                let gpu = runner.run_blocking(&[&WhiteBalancePass { matrix, hsm: None }]);

                let max_diff = reference
                    .iter()
                    .zip(&gpu)
                    .map(|(a, b)| (a - b).abs())
                    .fold(0.0_f32, f32::max);
                eprintln!(
                    "PARITY vs raw-core white_balance ({method:?}, {temp}K, tint={tint}): \
                     max abs diff = {max_diff:e}"
                );
                assert!(
                    max_diff < 1e-4,
                    "{method:?} {temp}K tint={tint}: GPU vs raw-core stage max abs diff \
                     {max_diff} exceeds 1e-4"
                );
            }
        }
    }

    /// Pin the local CPU oracle (`apply_white_balance`) to raw-core's stage too,
    /// so the convenience oracle this crate exports can't silently drift. (The
    /// GPU gate above doesn't depend on the local oracle.)
    #[test]
    fn local_oracle_matches_raw_core_stage_within_1e_4() {
        let input = wb_buffer();
        for method in [WbMethod::Cat16, WbMethod::DiagonalRec2020] {
            for &(temp, tint) in &[(3000.0_f32, 0.0_f32), (10000.0, 50.0)] {
                let reference = raw_core_white_balance(&input, temp, tint, method);
                let mut local = input.clone();
                apply_white_balance(&mut local, wb_matrix(temp, tint, method));
                let max_diff = reference
                    .iter()
                    .zip(&local)
                    .map(|(a, b)| (a - b).abs())
                    .fold(0.0_f32, f32::max);
                assert!(
                    max_diff < 1e-4,
                    "{method:?} {temp}K tint={tint}: local oracle vs raw-core stage diff \
                     {max_diff} exceeds 1e-4"
                );
            }
        }
    }

    /// Identity matrix is a bit-exact passthrough on the GPU (alpha included).
    /// Pins that a neutral WB matrix doesn't perturb pixels — the GPU analogue
    /// of raw-core's `(6500, 0)` short-circuit (which the chain reproduces by
    /// not enqueuing a pass).
    #[test]
    fn identity_matrix_is_passthrough_on_gpu() {
        let ctx = GpuContext::new_blocking().expect("gpu context");
        let input = wb_buffer();
        let count = (input.len() / 4) as u32;
        let identity = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let img = GpuImage::upload(&ctx, &input, count, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&WhiteBalancePass {
            matrix: identity,
            hsm: None,
        }]);
        let max_diff = input
            .iter()
            .zip(&gpu)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        assert_eq!(
            max_diff, 0.0,
            "identity WB matrix must be a bit-exact passthrough"
        );
    }

    /// Row-major guard: a deliberately ASYMMETRIC matrix produces the row-major
    /// result, NOT its transpose. This is the explicit regression test for the
    /// `mat3x3` column-major transpose trap the kernel avoids by using vec4 rows.
    #[test]
    fn asymmetric_matrix_applies_row_major_not_transposed() {
        let ctx = GpuContext::new_blocking().expect("gpu context");
        // A matrix where M != Mᵀ so a transpose would give a different answer.
        let m = [[1.0, 2.0, 3.0], [0.1, 0.5, 0.2], [0.0, 0.3, 0.7]];
        let input = vec![0.2_f32, 0.4, 0.6, 1.0];
        let img = GpuImage::upload(&ctx, &input, 1, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&WhiteBalancePass {
            matrix: m,
            hsm: None,
        }]);

        // Expected = row-major M · rgb.
        let expected = [
            m[0][0] * 0.2 + m[0][1] * 0.4 + m[0][2] * 0.6,
            m[1][0] * 0.2 + m[1][1] * 0.4 + m[1][2] * 0.6,
            m[2][0] * 0.2 + m[2][1] * 0.4 + m[2][2] * 0.6,
        ];
        for c in 0..3 {
            assert!(
                (gpu[c] - expected[c]).abs() < 1e-5,
                "channel {c}: GPU {} != row-major expected {} (transpose bug?)",
                gpu[c],
                expected[c]
            );
        }
        assert_eq!(gpu[3], 1.0, "alpha untouched");
    }
}
