//! `GpuContext`'s lazily-compiled compute-pipeline accessors (epic #925).
//!
//! Split out of `context.rs` (which keeps the struct + device/queue
//! construction) purely for the file-size budget — the accessor list grew past
//! 600 LOC once the P2 stages + the wave-3b spatial / dehaze kernels landed.
//! Every accessor `get_or_init`s its `OnceCell` so each WGSL kernel compiles at
//! most once per context and is reused thereafter (the reuse the substrate
//! depends on). All use `layout: None`, deriving the bind-group layout from the
//! WGSL bindings.
//!
//! The private compile helpers live in the sibling `context_pipelines_helpers`
//! module to keep this file under the 600-LOC hard budget. The spatial /
//! dehaze / NLM / sharpen / capture-sharpening / dither accessors (everything
//! from `tone_curves_pipeline` on) live in the further sibling
//! `context_pipelines_spatial` module (#2311 headroom split) — this file
//! keeps the simpler per-pixel point-op accessors.

use crate::context::GpuContext;
use crate::context_pipelines_helpers::{compile_source, compile_standalone, compile_with_matrices};

impl GpuContext {
    /// The cached exposure compute pipeline, compiling `exposure.wgsl` on first
    /// call. The auto bind-group layout (`layout: None`) is shared by every
    /// `ExposurePass` bind group via `pipeline.get_bind_group_layout(0)`.
    pub fn exposure_pipeline(&self) -> &wgpu::ComputePipeline {
        self.exposure_pipeline.get_or_init(|| {
            compile_standalone(&self.device, "exposure", include_str!("exposure.wgsl"))
        })
    }

    /// The cached vibrance compute pipeline (epic #925 P2 / #990).
    ///
    /// WGSL has no `#include`, so the shader source is built by concatenating
    /// the **generated** color-matrix module (`generated/color_matrices.wgsl`,
    /// emitted by `codegen --schema color-matrices --target wgsl`) ahead of the
    /// `vibrance.wgsl` kernel. The kernel calls the generated `mul_*` helpers;
    /// `include_str!` of the committed generated file keeps raw-gpu free of a
    /// build-time dependency on the `codegen` crate (the file rides the
    /// codegen-drift CI gate instead). This concat-at-compile pattern is what
    /// every Oklab/matrix fan-out stage reuses.
    pub fn vibrance_pipeline(&self) -> &wgpu::ComputePipeline {
        self.vibrance_pipeline.get_or_init(|| {
            compile_with_matrices(&self.device, "vibrance", include_str!("vibrance.wgsl"))
        })
    }

    /// The cached white-balance compute pipeline (epic #925 P2 / #990).
    ///
    /// Unlike vibrance, this kernel does NOT concat the generated color
    /// matrices: white balance is a pure per-pixel 3×3 matmul whose matrix is
    /// supplied as a per-pass uniform (CPU-derived once via CAT16 / diagonal
    /// gains). So `white_balance.wgsl` compiles standalone, like `exposure.wgsl`.
    pub fn white_balance_pipeline(&self) -> &wgpu::ComputePipeline {
        self.white_balance_pipeline.get_or_init(|| {
            compile_standalone(
                &self.device,
                "white-balance",
                include_str!("white_balance.wgsl"),
            )
        })
    }

    /// The cached scene-tone-controls POINT compute pipeline (epic #925 P2 /
    /// #990, reshaped at #1103).
    ///
    /// Point tone steps (exposure / brightness / whites / blacks), no Oklab —
    /// so, like exposure / white_balance, the kernel compiles standalone with
    /// no generated-color-matrix concat. Highlights/shadows live in
    /// [`GpuContext::scene_tone_sh_pipeline`] since #1103.
    pub fn scene_tone_controls_pipeline(&self) -> &wgpu::ComputePipeline {
        self.scene_tone_controls_pipeline.get_or_init(|| {
            compile_standalone(
                &self.device,
                "scene-tone-controls",
                include_str!("scene_tone_controls.wgsl"),
            )
        })
    }

    /// The cached vignette compute pipeline (#1109, tone/zoom design § 10.1).
    ///
    /// A windowed point op (radial EV gain from the tile origin + full dims
    /// in the params uniform) — no Oklab, so the kernel compiles standalone
    /// like exposure / scene_tone_controls.
    pub fn vignette_pipeline(&self) -> &wgpu::ComputePipeline {
        self.vignette_pipeline.get_or_init(|| {
            compile_standalone(&self.device, "vignette", include_str!("vignette.wgsl"))
        })
    }

    /// The cached local-adjustments compute pipeline (#1698).
    ///
    /// The kernel rasterizes each layer's vector mask and applies that layer's
    /// nine controls weighted by the mask value, looping the whole layer stack
    /// in registers so the stage stays one dispatch. Its saturation / vibrance
    /// steps round pixels through Oklab, so the generated color-matrix module
    /// is prepended (`compile_with_matrices`) — the same concat pattern
    /// vibrance / saturation / colour grading use. Four bindings (params
    /// uniform + src/dst storage + the flat layer-stack storage buffer);
    /// `layout: None` derives the layout from the WGSL bindings.
    pub fn local_adjustments_pipeline(&self) -> &wgpu::ComputePipeline {
        self.local_adjustments_pipeline.get_or_init(|| {
            compile_with_matrices(
                &self.device,
                "local-adjustments",
                include_str!("local_adjustments.wgsl"),
            )
        })
    }

    /// The cached film-grain compute pipeline (#1110, tone/zoom design § 10.2).
    ///
    /// A windowed point op (deterministic hash noise from the absolute pixel
    /// coordinate; tile origin + window in the params uniform) — no Oklab, so
    /// the kernel compiles standalone. The hash constants are duplicated
    /// verbatim from `raw_core::stages::grain` (the determinism contract);
    /// the parity gate pins them.
    pub fn grain_pipeline(&self) -> &wgpu::ComputePipeline {
        self.grain_pipeline
            .get_or_init(|| compile_standalone(&self.device, "grain", include_str!("grain.wgsl")))
    }

    /// The cached colour-grading compute pipeline (#275).
    ///
    /// The kernel rounds pixels through Oklab, so the generated color-matrix
    /// module is prepended (`compile_with_matrices`) — same concat pattern as
    /// vibrance / saturation. A pure point op; 2 storage buffers.
    pub fn color_grade_pipeline(&self) -> &wgpu::ComputePipeline {
        self.color_grade_pipeline.get_or_init(|| {
            compile_with_matrices(
                &self.device,
                "color-grade",
                include_str!("color_grade.wgsl"),
            )
        })
    }

    /// The cached 8-band HSL compute pipeline (#1112, tone/zoom design § 10.4).
    ///
    /// The kernel rounds pixels through Oklab, so the generated color-matrix
    /// module is prepended (`compile_with_matrices`) — same concat pattern as
    /// vibrance / saturation / color_grade. A pure point op; 2 storage buffers.
    /// The 24 slider-derived values (hue_rad / sat_delta / lum_shift) fit in
    /// the Params uniform — no extra storage buffer needed.
    pub fn hsl_pipeline(&self) -> &wgpu::ComputePipeline {
        self.hsl_pipeline
            .get_or_init(|| compile_with_matrices(&self.device, "hsl", include_str!("hsl.wgsl")))
    }

    /// The cached masked shadows/highlights compute pipeline (#1103, tone/zoom
    /// design § 4.2): one reworked tone step (mode-selected) through the tonal
    /// detail mask, reading the blurred luma plane the host prepares with
    /// [`crate::spatial::box_blur_encode`]. Compiles standalone.
    pub fn scene_tone_sh_pipeline(&self) -> &wgpu::ComputePipeline {
        self.scene_tone_sh_pipeline.get_or_init(|| {
            compile_standalone(
                &self.device,
                "scene-tone-sh",
                include_str!("scene_tone_sh.wgsl"),
            )
        })
    }

    /// The cached display-encode compute pipeline (epic #925 P2 / #990).
    ///
    /// Rec.2020 → sRGB + hue-preserving Oklab gamut compression, so the kernel
    /// needs the generated color-matrix helpers (the sRGB↔LMS↔Lab + Rec.2020→sRGB
    /// `mul_*` functions). Same concat-at-compile pattern as `vibrance_pipeline`:
    /// the generated `color_matrices.wgsl` is prepended to `display_encode.wgsl`
    /// (WGSL has no `#include`).
    pub fn display_encode_pipeline(&self) -> &wgpu::ComputePipeline {
        self.display_encode_pipeline.get_or_init(|| {
            compile_with_matrices(
                &self.device,
                "display-encode",
                include_str!("display_encode.wgsl"),
            )
        })
    }

    /// The cached sRGB gamma-encode compute pipeline (epic #925 P4a / #992-pre).
    ///
    /// A pure per-channel IEC 61966-2-1 transfer (no Oklab, no matrices) — so,
    /// like exposure / scene_tone_controls, the kernel compiles standalone with
    /// no generated-color-matrix concat.
    pub fn srgb_gamma_pipeline(&self) -> &wgpu::ComputePipeline {
        self.srgb_gamma_pipeline.get_or_init(|| {
            compile_standalone(&self.device, "srgb-gamma", include_str!("srgb_gamma.wgsl"))
        })
    }

    /// The cached saturation compute pipeline (epic #925 P2 / #990).
    ///
    /// Saturation rounds each pixel through Oklab (chroma scale + a gamut-hull
    /// bisection), so the kernel needs the generated color-matrix helpers — same
    /// concat-at-compile pattern as `vibrance_pipeline` / `display_encode_pipeline`:
    /// the generated `color_matrices.wgsl` is prepended to `saturation.wgsl`
    /// (WGSL has no `#include`). The gamut constants are inlined in the kernel,
    /// not codegen'd.
    pub fn saturation_pipeline(&self) -> &wgpu::ComputePipeline {
        self.saturation_pipeline.get_or_init(|| {
            compile_with_matrices(&self.device, "saturation", include_str!("saturation.wgsl"))
        })
    }

    /// The cached Auto Profile curve compute pipeline (epic #925 P2 / #990).
    ///
    /// The kernel's Oklab correction path uses the generated color-matrix
    /// helpers, so — like `vibrance_pipeline` / `saturation_pipeline` — the
    /// generated `color_matrices.wgsl` is prepended to `auto_profile_curve.wgsl`
    /// at module creation (WGSL has no `#include`). The kernel uses a 4-binding
    /// layout (meta uniform + src/dst storage + the flat-curve storage buffer);
    /// `layout: None` derives it from the WGSL bindings.
    pub fn auto_profile_curve_pipeline(&self) -> &wgpu::ComputePipeline {
        self.auto_profile_curve_pipeline.get_or_init(|| {
            compile_with_matrices(
                &self.device,
                "auto-profile-curve",
                include_str!("auto_profile_curve.wgsl"),
            )
        })
    }

    /// The cached AgX view-transform compute pipeline (epic #925 P2 / #990).
    ///
    /// The kernel needs BOTH generated WGSL modules: the Oklab + Rec.2020/sRGB
    /// matrices (`color_matrices.wgsl`, for the gamut-compress round-trip) and
    /// the AgX inset/outset matrices + log-encode scalars (`agx_coeffs.wgsl`,
    /// emitted by `derive_agx_lut.py --wgsl`). Both are prepended to `agx.wgsl`
    /// at module creation (WGSL has no `#include`) — same concat-at-compile
    /// pattern as `vibrance_pipeline`, extended to two generated headers. The
    /// kernel uses a 4-binding layout (params uniform + src/dst storage + the
    /// baked-LUT storage buffer); `layout: None` derives it from the bindings.
    pub fn agx_pipeline(&self) -> &wgpu::ComputePipeline {
        self.agx_pipeline.get_or_init(|| {
            let source = format!(
                "{}\n{}\n{}",
                include_str!("generated/color_matrices.wgsl"),
                include_str!("generated/agx_coeffs.wgsl"),
                include_str!("agx.wgsl"),
            );
            compile_source(&self.device, "agx", &source)
        })
    }

    /// The cached residual-LUT compute pipeline (epic #925 P2 / #990).
    ///
    /// The kernel is a pure trilinear 3D-LUT lookup (no Oklab), so — like
    /// `exposure.wgsl` / `white_balance.wgsl` — it compiles standalone with no
    /// generated-color-matrix concat. The per-image grid and its node count ride
    /// per-pass buffers (storage + uniform); `layout: None` derives the 4-binding
    /// layout from the WGSL bindings.
    pub fn residual_lut_pipeline(&self) -> &wgpu::ComputePipeline {
        self.residual_lut_pipeline.get_or_init(|| {
            compile_standalone(
                &self.device,
                "residual-lut",
                include_str!("residual_lut.wgsl"),
            )
        })
    }

    /// The cached film-look compute pipeline (epic #2683, Task 7).
    ///
    /// The kernel round-trips display-linear Rec.2020 through linear sRGB
    /// (rec2020→srgb, srgb→rec2020) to sample a baked `.mlut` grid in encoded
    /// sRGB space, so it needs the generated color-matrix helpers — same
    /// concat-at-compile pattern as `vibrance_pipeline` / `display_encode_pipeline`:
    /// the generated `color_matrices.wgsl` is prepended to `film_lut.wgsl`
    /// (WGSL has no `#include`). 4-binding layout (params uniform + src/dst
    /// storage + the per-look grid storage buffer); `layout: None` derives it
    /// from the WGSL bindings.
    pub fn film_lut_pipeline(&self) -> &wgpu::ComputePipeline {
        self.film_lut_pipeline.get_or_init(|| {
            compile_with_matrices(&self.device, "film-lut", include_str!("film_lut.wgsl"))
        })
    }

    /// The cached vectorscope-scope compute pipeline (#3272, spec §5.4). A
    /// mask-weighted Rec.709 Cb/Cr histogram of the display-encoded chain
    /// buffer — plain YCbCr coefficients, no Oklab, so the kernel compiles
    /// standalone like `grain_pipeline` / `dither_pipeline`. 3-binding
    /// layout (params uniform + src storage + the histogram storage
    /// buffer, read_write for its integer atomics); `layout: None` derives
    /// it from the WGSL bindings.
    pub fn vectorscope_pipeline(&self) -> &wgpu::ComputePipeline {
        self.vectorscope_pipeline.get_or_init(|| {
            compile_standalone(
                &self.device,
                "vectorscope",
                include_str!("scope_vectorscope.wgsl"),
            )
        })
    }
}
