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
//! module to keep this file under the 600-LOC hard budget.

use crate::context::GpuContext;
use crate::context_pipelines_helpers::{
    compile_cs, compile_nr, compile_source, compile_standalone, compile_with_matrices,
};

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
            compile_with_matrices(&self.device, "color-grade", include_str!("color_grade.wgsl"))
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

    /// The cached AcrMatch view-transform compute pipeline (#1722, epic #1710 slice 2).
    ///
    /// The kernel is a pure trilinear 3D-LUT lookup with the AgX log2 shaper
    /// (no Oklab / matrices) — so, like `residual_lut.wgsl`, it compiles
    /// standalone with no generated-color-matrix concat. Uses a 4-binding layout
    /// (params uniform + src/dst storage + the baked-LUT storage buffer);
    /// `layout: None` derives it from the WGSL bindings.
    pub fn acr_match_pipeline(&self) -> &wgpu::ComputePipeline {
        self.acr_match_pipeline.get_or_init(|| {
            compile_standalone(&self.device, "acr-match", include_str!("acr_match.wgsl"))
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

    /// The cached tone-curves compute pipeline (epic #925 P2 / #990).
    ///
    /// Luma coupling uses the inlined Rec.2020 weights (not the codegen
    /// matrices), so — like `exposure.wgsl` / `white_balance.wgsl` — the kernel
    /// compiles standalone with no generated-color-matrix concat. The prepared
    /// curve slots + the branch flags ride per-pass buffers (storage + uniform);
    /// `layout: None` derives the 4-binding layout from the WGSL bindings.
    pub fn tone_curves_pipeline(&self) -> &wgpu::ComputePipeline {
        self.tone_curves_pipeline.get_or_init(|| {
            compile_standalone(
                &self.device,
                "tone-curves",
                include_str!("tone_curves.wgsl"),
            )
        })
    }

    /// The cached separable box-blur compute pipeline (epic #925 P2 wave 3b /
    /// #990). The spatial primitive: `box_blur.wgsl` runs one axis (horizontal or
    /// vertical) per dispatch over a scalar f32 plane, with the same
    /// shrinking-window border policy as `raw_core::stages::blur::box_blur_channel`.
    /// Standalone kernel (no generated-matrix concat), like `exposure.wgsl`.
    pub fn box_blur_pipeline(&self) -> &wgpu::ComputePipeline {
        self.box_blur_pipeline.get_or_init(|| {
            compile_standalone(&self.device, "box-blur", include_str!("box_blur.wgsl"))
        })
    }

    /// The cached guided-filter luma-extract pipeline (epic #925 P2 wave 3b /
    /// #990). `guided_luma.wgsl`: RGBA → (luma, luma²) scalar planes, the start of
    /// the self-guided base/detail decomposition. Standalone kernel (the Rec.2020
    /// luma weights are inlined, like `tone_curves.wgsl`).
    pub fn guided_luma_pipeline(&self) -> &wgpu::ComputePipeline {
        self.guided_luma_pipeline.get_or_init(|| {
            compile_standalone(
                &self.device,
                "guided-luma",
                include_str!("guided_luma.wgsl"),
            )
        })
    }

    /// The cached guided-filter coefficient pipeline (epic #925 P2 wave 3b /
    /// #990). `guided_ab.wgsl`: the self-guided `a`/`b` derivation from the
    /// box-blurred (mean_i, mean_ii) planes. Standalone kernel.
    pub fn guided_ab_pipeline(&self) -> &wgpu::ComputePipeline {
        self.guided_ab_pipeline.get_or_init(|| {
            compile_standalone(&self.device, "guided-ab", include_str!("guided_ab.wgsl"))
        })
    }

    /// The cached guided-filter combine pipeline (epic #925 P2 wave 3b / #990).
    /// `guided_combine.wgsl`: the clarity/texture base/detail recombine reading
    /// the original RGBA AND three derived planes at once — the MULTI-INPUT spatial
    /// pass pattern dehaze + P3 reuse. Standalone kernel.
    pub fn guided_combine_pipeline(&self) -> &wgpu::ComputePipeline {
        self.guided_combine_pipeline.get_or_init(|| {
            compile_standalone(
                &self.device,
                "guided-combine",
                include_str!("guided_combine.wgsl"),
            )
        })
    }

    /// The cached dehaze min-filter pipeline (epic #925 P2 wave 3b / #990).
    /// `dehaze_min.wgsl`: a direct 2D 15×15 window min serving the dark channel
    /// (mode 0) and the transmission map (mode 1), with clamp-to-edge borders.
    /// Standalone kernel.
    pub fn dehaze_min_pipeline(&self) -> &wgpu::ComputePipeline {
        self.dehaze_min_pipeline.get_or_init(|| {
            compile_standalone(&self.device, "dehaze-min", include_str!("dehaze_min.wgsl"))
        })
    }

    /// The cached dehaze guided-products pipeline (epic #925 P2 wave 3b / #990).
    /// `dehaze_products.wgsl`: packs the GENERAL guided filter's four pre-blur
    /// quantities into two vec2 planes. Standalone kernel.
    pub fn dehaze_products_pipeline(&self) -> &wgpu::ComputePipeline {
        self.dehaze_products_pipeline.get_or_init(|| {
            compile_standalone(
                &self.device,
                "dehaze-products",
                include_str!("dehaze_products.wgsl"),
            )
        })
    }

    /// The cached vec2 box-blur pipeline (epic #925 P2 wave 3b / #990).
    /// `box_blur_vec2.wgsl`: the vec2 sibling of `box_blur.wgsl`, same border
    /// policy, blurring dehaze's packed mean-planes. Standalone kernel.
    pub fn box_blur_vec2_pipeline(&self) -> &wgpu::ComputePipeline {
        self.box_blur_vec2_pipeline.get_or_init(|| {
            compile_standalone(
                &self.device,
                "box-blur-vec2",
                include_str!("box_blur_vec2.wgsl"),
            )
        })
    }

    /// The cached dehaze guided-coefficient pipeline (epic #925 P2 wave 3b /
    /// #990). `dehaze_guided_ab.wgsl`: the GENERAL (guide != p) a/b derivation
    /// from the packed blurred means. Standalone kernel.
    pub fn dehaze_guided_ab_pipeline(&self) -> &wgpu::ComputePipeline {
        self.dehaze_guided_ab_pipeline.get_or_init(|| {
            compile_standalone(
                &self.device,
                "dehaze-guided-ab",
                include_str!("dehaze_guided_ab.wgsl"),
            )
        })
    }

    /// The cached dehaze sky-mask pipeline (epic #925 P2 wave 3b / #990).
    /// `dehaze_sky_mask.wgsl`: the raw smoothstep sky mask (issue #272) over the
    /// dark channel. Standalone kernel.
    pub fn dehaze_sky_mask_pipeline(&self) -> &wgpu::ComputePipeline {
        self.dehaze_sky_mask_pipeline.get_or_init(|| {
            compile_standalone(
                &self.device,
                "dehaze-sky-mask",
                include_str!("dehaze_sky_mask.wgsl"),
            )
        })
    }

    /// The cached dehaze recovery pipeline (epic #925 P2 wave 3b / #990).
    /// `dehaze_recover.wgsl`: the MULTI-INPUT scene recovery (reconstruct
    /// t_refined, `J=(I-A)/t_eff+A`, sky-mask blend). The airlight rides a SECOND
    /// uniform binding (#1033), so storage stays at 4. Standalone kernel.
    pub fn dehaze_recover_pipeline(&self) -> &wgpu::ComputePipeline {
        self.dehaze_recover_pipeline.get_or_init(|| {
            compile_standalone(
                &self.device,
                "dehaze-recover",
                include_str!("dehaze_recover.wgsl"),
            )
        })
    }

    /// The cached on-GPU airlight histogram pipeline (epic #925 P4b / #1033).
    /// `airlight_hist.wgsl`: an atomic histogram of the dark channel — stage 1 of
    /// the C5b reduction that computes the dehaze atmospheric light A on-device
    /// (replacing the C5a GPU→CPU readback). Standalone kernel.
    pub fn airlight_hist_pipeline(&self) -> &wgpu::ComputePipeline {
        self.airlight_hist_pipeline.get_or_init(|| {
            compile_standalone(
                &self.device,
                "airlight-hist",
                include_str!("airlight_hist.wgsl"),
            )
        })
    }

    /// The cached on-GPU airlight reduce pipeline (epic #925 P4b / #1033).
    /// `airlight_reduce.wgsl`: a single-workgroup threshold scan + masked average
    /// over the brightest top-0.1% dark-channel pixels → the airlight vec4 — stage
    /// 2 of the C5b reduction. Dispatched as ONE workgroup. Standalone kernel.
    pub fn airlight_reduce_pipeline(&self) -> &wgpu::ComputePipeline {
        self.airlight_reduce_pipeline.get_or_init(|| {
            compile_standalone(
                &self.device,
                "airlight-reduce",
                include_str!("airlight_reduce.wgsl"),
            )
        })
    }

    // ── Noise-reduction (NLM) pipelines (epic #925 P3 wave 1 / #991) ──────────
    //
    // All five entry points live in ONE WGSL module (`noise_reduction.wgsl`) —
    // the extract / writeback kernels round pixels through Oklab, so the module
    // concats the generated color matrices (like `vibrance_pipeline`). Each
    // accessor compiles that shared source selecting its OWN `@compute` entry
    // point (naga supports multiple entry points per module; `layout: None`
    // derives the per-entry bind-group layout). The kernel proper recomputes the
    // patch-SSD directly (no integral image) so the accumulate kernel fits the
    // 4-storage cap — see `noise_reduction.wgsl`.

    /// `extract_channel`: RGBA → one Oklab channel (L/a/b) scalar plane.
    pub fn nr_extract_pipeline(&self) -> &wgpu::ComputePipeline {
        self.nr_extract_pipeline
            .get_or_init(|| compile_nr(&self.device, "nr-extract", "extract_channel"))
    }

    /// `accumulate_shift`: the per-shift NLM core (direct patch-SSD → weight →
    /// acc/wsum/max_w). 4 storage: plane + acc + wsum + max_w.
    pub fn nr_accumulate_pipeline(&self) -> &wgpu::ComputePipeline {
        self.nr_accumulate_pipeline
            .get_or_init(|| compile_nr(&self.device, "nr-accumulate", "accumulate_shift"))
    }

    /// `finalize`: `(acc + mw·plane) / (wsum + mw)`, written in place to acc.
    pub fn nr_finalize_pipeline(&self) -> &wgpu::ComputePipeline {
        self.nr_finalize_pipeline
            .get_or_init(|| compile_nr(&self.device, "nr-finalize", "finalize"))
    }

    /// `writeback_luma`: RGBA-src + denoised L → RGBA-dst (a/b recomputed).
    pub fn nr_writeback_luma_pipeline(&self) -> &wgpu::ComputePipeline {
        self.nr_writeback_luma_pipeline
            .get_or_init(|| compile_nr(&self.device, "nr-writeback-luma", "writeback_luma"))
    }

    /// `writeback_color`: RGBA-src + denoised a + denoised b → RGBA-dst (L recomputed).
    pub fn nr_writeback_color_pipeline(&self) -> &wgpu::ComputePipeline {
        self.nr_writeback_color_pipeline
            .get_or_init(|| compile_nr(&self.device, "nr-writeback-color", "writeback_color"))
    }

    // ── Sharpen (luma-only USM) pipelines (epic #925 P3 wave 2 / #991) ─────────
    //
    // Three standalone kernels: `sharpen_luma.wgsl` (RGBA → luma plane),
    // `sharpen_usm.wgsl` (per-pixel USM scale → full-strength sharpened RGBA), and
    // `sharpen_mix.wgsl` (the edge-aware amount/masking blend). All luma-only — no
    // Oklab — so each compiles standalone, like `exposure.wgsl`.

    /// `sharpen_luma`: RGBA → BT.2020 luma plane. 2 storage.
    pub fn sharpen_luma_pipeline(&self) -> &wgpu::ComputePipeline {
        self.sharpen_luma_pipeline.get_or_init(|| {
            compile_standalone(
                &self.device,
                "sharpen-luma",
                include_str!("sharpen_luma.wgsl"),
            )
        })
    }

    /// `sharpen_usm`: per-pixel luma USM scale (shadow guard + clamp) → the
    /// full-strength sharpened RGBA. 4 storage.
    pub fn sharpen_usm_pipeline(&self) -> &wgpu::ComputePipeline {
        self.sharpen_usm_pipeline.get_or_init(|| {
            compile_standalone(
                &self.device,
                "sharpen-usm",
                include_str!("sharpen_usm.wgsl"),
            )
        })
    }

    /// `sharpen_mix`: the edge-aware amount/masking blend (central-difference luma
    /// gradient). 4 storage.
    pub fn sharpen_mix_pipeline(&self) -> &wgpu::ComputePipeline {
        self.sharpen_mix_pipeline.get_or_init(|| {
            compile_standalone(
                &self.device,
                "sharpen-mix",
                include_str!("sharpen_mix.wgsl"),
            )
        })
    }

    // ── Capture-sharpening (Richardson–Lucy) pipelines (#925 P3 wave 2 / #991) ─
    //
    // Five entry points in ONE WGSL module (`capture_sharpening.wgsl`), selected
    // by `compile_source_entry` (naga supports multiple entry points per module),
    // mirroring `raw_core::stages::capture_sharpening`. The luma extract uses
    // Rec.709 weights (raw-core's deliberate approximation, NOT Rec.2020); the
    // blur is a TRUE Gaussian (CPU-uploaded kernel weights, clamp-to-edge),
    // distinct from `box_blur.wgsl`'s shrinking window. No Oklab, so standalone.

    /// `cs_extract`: RGBA → Rec.709 luma plane. 2 storage.
    pub fn cs_extract_pipeline(&self) -> &wgpu::ComputePipeline {
        self.cs_extract_pipeline
            .get_or_init(|| compile_cs(&self.device, "cs-extract", "extract_luma"))
    }

    /// `cs_gaussian`: separable true-Gaussian blur (one axis per dispatch,
    /// clamp-to-edge, CPU-uploaded weights). 3 storage.
    pub fn cs_gaussian_pipeline(&self) -> &wgpu::ComputePipeline {
        self.cs_gaussian_pipeline
            .get_or_init(|| compile_cs(&self.device, "cs-gaussian", "gaussian_blur"))
    }

    /// `cs_ratio`: `clamp(original / max(blur_est, 1e-6), 0, 100)`. 3 storage.
    pub fn cs_ratio_pipeline(&self) -> &wgpu::ComputePipeline {
        self.cs_ratio_pipeline
            .get_or_init(|| compile_cs(&self.device, "cs-ratio", "ratio_step"))
    }

    /// `cs_multiply`: `estimate *= blur_ratio` (in place). 2 storage.
    pub fn cs_multiply_pipeline(&self) -> &wgpu::ComputePipeline {
        self.cs_multiply_pipeline
            .get_or_init(|| compile_cs(&self.device, "cs-multiply", "multiply_step"))
    }

    /// `cs_apply`: the highlight-faded per-channel scale (both skip-paths write
    /// `dst = src`). 4 storage.
    pub fn cs_apply_pipeline(&self) -> &wgpu::ComputePipeline {
        self.cs_apply_pipeline
            .get_or_init(|| compile_cs(&self.device, "cs-apply", "apply_scale"))
    }

    /// The cached dither + quantize pipeline (epic #925 P4b-core / #1027). The
    /// TERMINAL display-output encode: f32-RGBA → packed-u8-RGB with an ordered
    /// Bayer ±0.5-LSB dither. Standalone kernel (no Oklab / matrices), like
    /// exposure / srgb_gamma — so no generated-color-matrix concat.
    pub fn dither_pipeline(&self) -> &wgpu::ComputePipeline {
        self.dither_pipeline
            .get_or_init(|| compile_standalone(&self.device, "dither", include_str!("dither.wgsl")))
    }
}
