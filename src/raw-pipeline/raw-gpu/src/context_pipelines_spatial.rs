//! `GpuContext`'s lazily-compiled SPATIAL compute-pipeline accessors (epic #925
//! P2 wave 3b / P3 / P4b).
//!
//! Split out of `context_pipelines.rs` purely for the file-size budget (#2311's
//! headroom gate: adding `film_lut_pipeline` there pushed it to 582 lines,
//! past the 570 headroom threshold; this split lands both files with real
//! margin instead of the cheapest "just under 600" fix). Everything from
//! `tone_curves_pipeline` onward — the spatial primitives (box blur, guided
//! filter), dehaze's DAG, the NLM / sharpen / capture-sharpening multi-entry
//! modules, and the terminal `dither_pipeline` — lives here; the earlier,
//! simpler per-pixel point-op accessors stay in `context_pipelines.rs`. Same
//! `impl GpuContext` pattern split across two files/modules (legal in Rust —
//! inherent impls may be spread across any number of modules in the same
//! crate); every accessor still `get_or_init`s its own `OnceCell` on the same
//! `GpuContext` struct defined in `context.rs`.

use crate::context::GpuContext;
use crate::context_pipelines_helpers::{compile_cs, compile_nr, compile_standalone};

impl GpuContext {
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

    /// The cached display-referred tone-curves compute pipeline (#2232).
    ///
    /// Same shape as [`Self::tone_curves_pipeline`] one line up — a fixed
    /// 4-binding standalone kernel with the prepared curve slots riding a
    /// storage buffer — just 4 slots (master/R/G/B) instead of 5, and no
    /// `REF_MAX` scene-linear rescale (this stage runs post-AgX on a buffer
    /// already bounded to `[0, 1]`).
    pub fn display_tone_curve_pipeline(&self) -> &wgpu::ComputePipeline {
        self.display_tone_curve_pipeline.get_or_init(|| {
            compile_standalone(
                &self.device,
                "display-tone-curve",
                include_str!("display_tone_curve.wgsl"),
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

    /// `prepare_scale`: the per-pixel noise-profile modulation plane (#1714).
    /// 2 storage: the Oklab L plane + the packed (max_w, scale) plane.
    pub fn nr_prepare_pipeline(&self) -> &wgpu::ComputePipeline {
        self.nr_prepare_pipeline
            .get_or_init(|| compile_nr(&self.device, "nr-prepare-scale", "prepare_scale"))
    }

    /// `accumulate_shift`: the per-shift NLM core (direct patch-SSD → weight →
    /// acc/wsum/max_w). 4 storage: plane + acc + wsum + (max_w, scale).
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
