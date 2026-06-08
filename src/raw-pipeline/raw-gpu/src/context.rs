//! `GpuContext` — the device/queue handle every GPU resource borrows.
//!
//! Wraps P0's instance/adapter/device/queue setup (epic #925) behind a reusable
//! type so `GpuImage`, `ChainRunner`, and the passes can share one device. The
//! exposure compute pipeline is compiled lazily and cached here (one WGSL
//! compile per context, not per pass) so the substrate P1b (#988) / P1c (#989)
//! consume is genuinely reusable rather than recompiling the kernel every
//! dispatch.

use std::cell::OnceCell;

/// Device/queue handle plus lazily-compiled, cached compute pipelines.
///
/// Construct once (`new_blocking` on native, `new_async` anywhere) and share by
/// reference. Not `Send`/`Sync` — the cached-pipeline `OnceCell` is single-
/// threaded; the headless harness and the P1b/P1c display owners are
/// single-threaded around the GPU, matching wgpu's per-thread submission model.
pub struct GpuContext {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    /// Lazily-compiled exposure compute pipeline (`exposure.wgsl`). Built on
    /// first use via [`GpuContext::exposure_pipeline`] and reused thereafter.
    pub(crate) exposure_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled vibrance compute pipeline (`vibrance.wgsl` + the
    /// generated color matrices). The P2 template (#990); built on first use
    /// via [`GpuContext::vibrance_pipeline`].
    pub(crate) vibrance_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled white-balance compute pipeline (`white_balance.wgsl`).
    /// A P2 scene-linear stage (#990); a pure per-pixel 3×3 matmul, so it needs
    /// no generated color matrices (the WB matrix is a per-pass uniform). Built
    /// on first use via [`GpuContext::white_balance_pipeline`].
    pub(crate) white_balance_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled scene-tone-controls compute pipeline
    /// (`scene_tone_controls.wgsl`). A P2 scene-linear stage (#990); five
    /// luma-coupled tone steps, no Oklab, so no generated color matrices. Built
    /// on first use via [`GpuContext::scene_tone_controls_pipeline`].
    pub(crate) scene_tone_controls_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled display-encode compute pipeline (`display_encode.wgsl` +
    /// the generated color matrices). A P2 view-transform stage (#990):
    /// Rec.2020 → sRGB + Oklab gamut compression, so it concats the generated
    /// matrices like vibrance. Built on first use via
    /// [`GpuContext::display_encode_pipeline`].
    pub(crate) display_encode_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled saturation compute pipeline (`saturation.wgsl` + the
    /// generated color matrices). A P2 scene-linear stage (#990): Oklab chroma
    /// scale + a gamut-hull bisection, so it concats the generated matrices like
    /// vibrance. Built on first use via [`GpuContext::saturation_pipeline`].
    pub(crate) saturation_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled Auto Profile curve compute pipeline
    /// (`auto_profile_curve.wgsl` + the generated color matrices). A P2
    /// view-transform stage (#990): the per-pixel fitted tone curve
    /// (`compress_input` + per-channel eval + matrix + Oklab corrections), NOT
    /// the residual 3D LUT. Concats the generated matrices like vibrance (the
    /// Oklab correction path). Built on first use via
    /// [`GpuContext::auto_profile_curve_pipeline`].
    pub(crate) auto_profile_curve_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled AgX view-transform compute pipeline (`agx.wgsl` + the
    /// generated color matrices + the generated AgX coeffs). A P2
    /// view-transform stage (#990): inset -> log encode -> ratio-preserving
    /// sigmoid (sampling the baked LUT) -> outset -> Oklab hue-preserving
    /// gamut compression. Concats BOTH generated WGSL modules (Oklab pair +
    /// AgX matrices/scalars) ahead of the kernel, and uses a 4-binding layout
    /// (params uniform + src/dst storage + the baked-LUT storage buffer).
    /// Built on first use via [`GpuContext::agx_pipeline`].
    pub(crate) agx_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled residual-LUT compute pipeline (`residual_lut.wgsl`). A P2
    /// view-transform stage (#990): the per-image residual 3D LUT (#924) sampled
    /// by trilinear interpolation. Pure lookup — no Oklab — so, like exposure /
    /// white_balance, the kernel compiles standalone with no generated-matrix
    /// concat. Uses a 4-binding layout (params uniform + src/dst storage + the
    /// per-image grid storage buffer). Built on first use via
    /// [`GpuContext::residual_lut_pipeline`].
    pub(crate) residual_lut_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled tone-curves compute pipeline (`tone_curves.wgsl`). A P2
    /// scene-linear stage (#990): the parametric region sliders + per-channel
    /// point curves, evaluated from CPU-prepared Fritsch-Carlson curves uploaded
    /// to a storage buffer. Luma coupling uses the inlined Rec.2020 weights, so —
    /// like exposure / white_balance — the kernel compiles standalone with no
    /// generated-color-matrix concat. 4-binding layout (params uniform + src/dst
    /// storage + the prepared-curve-slots storage buffer). Built on first use via
    /// [`GpuContext::tone_curves_pipeline`].
    pub(crate) tone_curves_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled separable box-blur compute pipeline (`box_blur.wgsl`). The
    /// P2 wave-3b SPATIAL primitive (#990): a one-axis-per-dispatch box blur of a
    /// scalar f32 plane, mirroring `raw_core::stages::blur::box_blur_channel`'s
    /// shrinking-window border policy. Reused by every guided-filter / spatial
    /// stage (clarity, texture, and the P3 spatial filters). Standalone kernel
    /// (no generated matrices). 3-binding layout (params uniform + in/out f32
    /// storage). Built on first use via [`GpuContext::box_blur_pipeline`].
    pub(crate) box_blur_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled guided-filter luma-extract pipeline (`guided_luma.wgsl`).
    /// A P2 wave-3b spatial helper (#990): RGBA → (luma, luma²) scalar planes for
    /// the self-guided base/detail decomposition shared by clarity / texture.
    /// 4-binding layout (params uniform + RGBA-in storage + two f32-out storage).
    pub(crate) guided_luma_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled guided-filter coefficient pipeline (`guided_ab.wgsl`). A
    /// P2 wave-3b spatial helper (#990): the self-guided `a`/`b` derivation from
    /// the box-blurred (mean_i, mean_ii) planes. 5-binding layout (params uniform
    /// + two f32-in storage + two f32-out storage).
    pub(crate) guided_ab_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled guided-filter combine pipeline (`guided_combine.wgsl`). A
    /// P2 wave-3b spatial helper (#990): the clarity/texture base/detail recombine
    /// (`out = orig * (boost / max(luma, floor))`). A MULTI-INPUT pass — the first
    /// kernel to read the original image AND derived planes simultaneously, the
    /// pattern dehaze + P3 reuse. 6-binding layout (params uniform + RGBA-orig +
    /// three f32-in + RGBA-out storage).
    pub(crate) guided_combine_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled dehaze min-filter pipeline (`dehaze_min.wgsl`). The P2
    /// wave-3b dehaze stage (#990): a DIRECT 2D 15×15 window min over the image,
    /// serving both the dark channel (mode 0) and the transmission map (mode 1,
    /// airlight in the uniform) — clamp-to-edge borders, distinct from the box
    /// blur's shrinking window. 3-binding layout (params uniform + RGBA-in + f32-out).
    pub(crate) dehaze_min_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled dehaze guided-filter products pipeline
    /// (`dehaze_products.wgsl`). A P2 wave-3b dehaze helper (#990): packs the four
    /// pre-blur quantities of the GENERAL guided filter (guide=luma, p=t) into two
    /// vec2 planes — m1=(luma, t), m2=(luma·t, luma²) — so the a/b kernel fits 4
    /// storage. 5-binding layout (params uniform + RGBA-in + t-in + two vec2-out).
    pub(crate) dehaze_products_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled vec2 separable box-blur pipeline (`box_blur_vec2.wgsl`).
    /// A P2 wave-3b dehaze helper (#990): the vec2 sibling of `box_blur.wgsl`,
    /// blurring dehaze's packed (i,p)/(ip,ii) mean-planes in half the dispatches.
    /// Same shrinking-window border policy. 3-binding layout (params uniform +
    /// vec2-in + vec2-out).
    pub(crate) box_blur_vec2_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled dehaze guided-filter coefficient pipeline
    /// (`dehaze_guided_ab.wgsl`). A P2 wave-3b dehaze helper (#990): the GENERAL
    /// (guide != p) a/b derivation from the packed blurred means, written packed
    /// as ab=(a,b). 4-binding layout (params uniform + two vec2-in + vec2-out).
    pub(crate) dehaze_guided_ab_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled dehaze sky-mask pipeline (`dehaze_sky_mask.wgsl`). A P2
    /// wave-3b dehaze helper (#990): the raw smoothstep sky/no-dark-pixel mask
    /// (issue #272) over the dark channel; the softening blur reuses the scalar
    /// box blur. 3-binding layout (params uniform + dc-in + mask-out).
    pub(crate) dehaze_sky_mask_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled dehaze recovery pipeline (`dehaze_recover.wgsl`). A P2
    /// wave-3b dehaze helper (#990): the final MULTI-INPUT scene recovery —
    /// reconstructs t_refined from the packed guided coefficients, applies
    /// `J=(I-A)/t_eff+A`, and blends by the sky mask. 5-binding layout (params
    /// uniform + RGBA-orig + ab-in + sky-in + RGBA-out).
    pub(crate) dehaze_recover_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled NLM noise-reduction pipelines (epic #925 P3 wave 1 /
    /// #991). All five entry points share one WGSL module
    /// (`noise_reduction.wgsl` + the generated color matrices, for the Oklab
    /// round-trip); each `OnceCell` caches the pipeline for one `@compute` entry.
    /// `extract_channel`: RGBA → one Oklab channel (L/a/b) plane (2 storage).
    pub(crate) nr_extract_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// `accumulate_shift`: the per-shift NLM core — direct patch-SSD → weight →
    /// acc/wsum/max_w (4 storage: plane + acc + wsum + max_w; no integral image,
    /// so it fits the `downlevel_defaults()` cap).
    pub(crate) nr_accumulate_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// `finalize`: `(acc + mw·plane) / (wsum + mw)` written in place to acc
    /// (4 storage: plane + acc + wsum + max_w).
    pub(crate) nr_finalize_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// `writeback_luma`: RGBA-src + denoised-L → RGBA-dst, a/b recomputed from
    /// src (3 storage).
    pub(crate) nr_writeback_luma_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// `writeback_color`: RGBA-src + denoised-a + denoised-b → RGBA-dst, L
    /// recomputed from src (4 storage).
    pub(crate) nr_writeback_color_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled sharpen pipelines (epic #925 P3 wave 2 / #991). Three
    /// standalone kernels mirroring `raw_core::stages::sharpen::apply` (luma-only
    /// USM — no Oklab, so no generated color matrices).
    /// `sharpen_luma`: RGBA → luma plane (BT.2020 weights). 2 storage.
    pub(crate) sharpen_luma_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// `sharpen_usm`: per-pixel luma USM scale (shadow guard + clamp) → the
    /// full-strength sharpened RGBA. 4 storage (src + luma + luma_blur + sharpened).
    pub(crate) sharpen_usm_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// `sharpen_mix`: the edge-aware amount/masking blend (central-difference
    /// gradient on the luma plane). 4 storage (observed + sharpened + luma + dst).
    pub(crate) sharpen_mix_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled capture-sharpening pipelines (epic #925 P3 wave 2 / #991).
    /// Richardson–Lucy deconvolution on a luma plane (Rec.709 weights — raw-core's
    /// deliberate approximation), TRUE Gaussian PSF with clamp-to-edge borders.
    /// All five entry points share one WGSL module (`capture_sharpening.wgsl`).
    /// `cs_extract`: RGBA → luma plane (Rec.709). 2 storage.
    pub(crate) cs_extract_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// `cs_gaussian`: separable true-Gaussian blur of a scalar plane (CPU-uploaded
    /// kernel weights, clamp-to-edge), one axis per dispatch. 3 storage
    /// (kernel + in + out). The RL inner blur — distinct from box_blur.wgsl.
    pub(crate) cs_gaussian_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// `cs_ratio`: `ratio = clamp(original / max(blur_est, 1e-6), 0, 100)`, the RL
    /// divide step. 3 storage (original + blur_est + ratio).
    pub(crate) cs_ratio_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// `cs_multiply`: `estimate *= blur_ratio`, the RL update step (in place to
    /// estimate). 2 storage (estimate + blur_ratio).
    pub(crate) cs_multiply_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// `cs_apply`: the highlight-faded per-channel scale `scale = y_target/y_old`,
    /// with both CPU skip-paths written as `dst = src`. 4 storage
    /// (original + estimate + src + dst).
    pub(crate) cs_apply_pipeline: OnceCell<wgpu::ComputePipeline>,
}

impl GpuContext {
    /// Async constructor shared by native (`new_blocking`) and wasm callers.
    /// Picks the default adapter (Metal on macOS, WebGPU in the browser).
    pub async fn new_async() -> Self {
        let instance = wgpu::Instance::default();
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions::default())
            .await
            .expect("no suitable GPU adapter");
        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("maple-gpu"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::downlevel_defaults(),
                    memory_hints: wgpu::MemoryHints::default(),
                },
                // wgpu 23.0.1 still takes the trace-path arg (the plan's note
                // assumed it was dropped in v22; this keeps it). `None` disables
                // API tracing.
                None,
            )
            .await
            .expect("device request failed");
        Self {
            device,
            queue,
            exposure_pipeline: OnceCell::new(),
            vibrance_pipeline: OnceCell::new(),
            white_balance_pipeline: OnceCell::new(),
            scene_tone_controls_pipeline: OnceCell::new(),
            display_encode_pipeline: OnceCell::new(),
            saturation_pipeline: OnceCell::new(),
            auto_profile_curve_pipeline: OnceCell::new(),
            agx_pipeline: OnceCell::new(),
            residual_lut_pipeline: OnceCell::new(),
            tone_curves_pipeline: OnceCell::new(),
            box_blur_pipeline: OnceCell::new(),
            guided_luma_pipeline: OnceCell::new(),
            guided_ab_pipeline: OnceCell::new(),
            guided_combine_pipeline: OnceCell::new(),
            dehaze_min_pipeline: OnceCell::new(),
            dehaze_products_pipeline: OnceCell::new(),
            box_blur_vec2_pipeline: OnceCell::new(),
            dehaze_guided_ab_pipeline: OnceCell::new(),
            dehaze_sky_mask_pipeline: OnceCell::new(),
            dehaze_recover_pipeline: OnceCell::new(),
            nr_extract_pipeline: OnceCell::new(),
            nr_accumulate_pipeline: OnceCell::new(),
            nr_finalize_pipeline: OnceCell::new(),
            nr_writeback_luma_pipeline: OnceCell::new(),
            nr_writeback_color_pipeline: OnceCell::new(),
            sharpen_luma_pipeline: OnceCell::new(),
            sharpen_usm_pipeline: OnceCell::new(),
            sharpen_mix_pipeline: OnceCell::new(),
            cs_extract_pipeline: OnceCell::new(),
            cs_gaussian_pipeline: OnceCell::new(),
            cs_ratio_pipeline: OnceCell::new(),
            cs_multiply_pipeline: OnceCell::new(),
            cs_apply_pipeline: OnceCell::new(),
        }
    }

    /// Native blocking constructor (drives the adapter/device request via
    /// pollster). Not compiled for wasm, which awaits [`GpuContext::new_async`].
    #[cfg(not(target_arch = "wasm32"))]
    pub fn new_blocking() -> Self {
        pollster::block_on(Self::new_async())
    }
}
