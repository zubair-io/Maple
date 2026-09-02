using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Maple.WinUI.Native;

namespace Maple.WinUI.Services
{
    /// <summary>
    /// A decoded scene-linear f32 base image plus the decode-exported state the
    /// per-tick chain needs (WB slider frame, noise profile, ISO, AE gain).
    /// Pixels are copied into managed memory at decode time so the Rust buffer
    /// can be freed immediately.
    /// </summary>
    public sealed class DecodedImage
    {
        public required float[] Pixels { get; init; }        // RGBA f32, scene-linear
        public required int Width { get; init; }
        public required int Height { get; init; }
        public required float[] NoiseProfile { get; init; }  // empty when absent
        public required uint Iso { get; init; }
        public required float AeGain { get; init; }
        public required float DecodedTemperature { get; init; }
        public required float DecodedTint { get; init; }
        /// <summary>Raw copy of the wb_frame_* export block, in struct order,
        /// applied verbatim onto MapleAdjustmentParams for each tick.</summary>
        public required float[] WbFrame { get; init; }

        // --- Auto Profile tail (#550/#924): fitted per image from the embedded
        //     JPEG. Without it a Profile::Auto decode renders 2-3x darker and
        //     ΔE00 ≈ 19 off the camera look (measured). Null ⇒ no tail applies
        //     (Neutral profile, or no embedded JPEG) ⇒ plain AgX. ---
        /// <summary>ProfileCurve::to_flat() (220 floats) for the GPU live
        /// chain's curve pass; null when the fit produced no curve.</summary>
        public float[]? ProfileCurve { get; set; }
        /// <summary>Residual 3D LUT (n³×3 floats, R fastest) for the GPU live
        /// chain's residual pass; null when absent.</summary>
        public float[]? ResidualLut { get; set; }
        public uint ResidualLutSize { get; set; }
        /// <summary>The COMPOSED display-domain LUT (n³×3, R fastest) for the
        /// CPU fallback — applied post display-encode, the CIColorCube
        /// equivalent.</summary>
        public float[]? DisplayLut { get; set; }
        public int DisplayLutN { get; set; }
    }

    /// <summary>
    /// CPU render pipeline: decode once to a scene-linear f32 base via the
    /// stripped-XMP contract, then re-run the Rust per-tick chain
    /// (maple_apply_chain_and_encode_display_f32) on every adjustment change.
    /// The eventual DX12 SwapChainPanel path (#2561) replaces the presentation,
    /// not this decode/chain split.
    /// </summary>
    public static unsafe class RenderEngine
    {
        /// <summary>
        /// Fields the per-tick chain re-applies must be zeroed in the decode
        /// model or they bake into the base image and double-apply
        /// (mirror of RawCoreBridge.stripAppleGPUStages on Apple).
        /// Profile is forced Neutral: the CPU chain cannot apply the Auto
        /// Profile fitted tail, and a Neutral decode keeps output consistent.
        /// </summary>
        public static AdjustmentState StripChainStages(AdjustmentState model)
        {
            var d = new AdjustmentState();
            var m = model.Clone();
            m.Temperature = d.Temperature;
            m.Tint = d.Tint;
            m.Exposure = 0; m.Brightness = 0; m.Contrast = 0;
            m.Highlights = 0; m.Shadows = 0; m.Whites = 0; m.Blacks = 0;
            m.ParametricHighlights = 0; m.ParametricLights = 0;
            m.ParametricDarks = 0; m.ParametricShadows = 0;
            m.ToneCurveLuma.Clear(); m.ToneCurveRed.Clear();
            m.ToneCurveGreen.Clear(); m.ToneCurveBlue.Clear();
            m.DisplayToneCurveLuma.Clear(); m.DisplayToneCurveRed.Clear();
            m.DisplayToneCurveGreen.Clear(); m.DisplayToneCurveBlue.Clear();
            m.Crop = Models.CropState.Identity;   // display-side (#2582), never baked at decode
            m.Vibrance = 0; m.Saturation = 0; m.Clarity = 0; m.Texture = 0; m.Dehaze = 0;
            m.HueAdjustmentRed = 0; m.HueAdjustmentOrange = 0; m.HueAdjustmentYellow = 0;
            m.HueAdjustmentGreen = 0; m.HueAdjustmentAqua = 0; m.HueAdjustmentBlue = 0;
            m.HueAdjustmentPurple = 0; m.HueAdjustmentMagenta = 0;
            m.SaturationAdjustmentRed = 0; m.SaturationAdjustmentOrange = 0;
            m.SaturationAdjustmentYellow = 0; m.SaturationAdjustmentGreen = 0;
            m.SaturationAdjustmentAqua = 0; m.SaturationAdjustmentBlue = 0;
            m.SaturationAdjustmentPurple = 0; m.SaturationAdjustmentMagenta = 0;
            m.LuminanceAdjustmentRed = 0; m.LuminanceAdjustmentOrange = 0;
            m.LuminanceAdjustmentYellow = 0; m.LuminanceAdjustmentGreen = 0;
            m.LuminanceAdjustmentAqua = 0; m.LuminanceAdjustmentBlue = 0;
            m.LuminanceAdjustmentPurple = 0; m.LuminanceAdjustmentMagenta = 0;
            m.BlackWhite = ToggleMode.Off;
            m.GrayMixerRed = 0; m.GrayMixerOrange = 0; m.GrayMixerYellow = 0;
            m.GrayMixerGreen = 0; m.GrayMixerAqua = 0; m.GrayMixerBlue = 0;
            m.GrayMixerPurple = 0; m.GrayMixerMagenta = 0;
            m.SplitToneShadowHue = 0; m.SplitToneShadowSaturation = 0;
            m.SplitToneHighlightHue = 0; m.SplitToneHighlightSaturation = 0;
            m.SplitToneBalance = 0;
            m.ColorGradeShadowLuminance = 0; m.ColorGradeMidtoneHue = 0;
            m.ColorGradeMidtoneSaturation = 0; m.ColorGradeMidtoneLuminance = 0;
            m.ColorGradeHighlightLuminance = 0; m.ColorGradeGlobalHue = 0;
            m.ColorGradeGlobalSaturation = 0; m.ColorGradeGlobalLuminance = 0;
            m.VignetteAmount = 0; m.VignetteFeather = d.VignetteFeather;
            m.GrainAmount = 0; m.GrainSize = d.GrainSize; m.GrainRoughness = d.GrainRoughness;
            m.SharpenAmount = 0; m.SharpenRadius = d.SharpenRadius;
            m.SharpenDetail = d.SharpenDetail; m.SharpenMasking = 0;
            m.NrLuminance = 0; m.NrColor = 0;
            // Profile is PRESERVED (Auto by default): the decode owns the
            // AE-off anchor decision under Auto, and the fitted tail is applied
            // per tick (GPU curve/residual passes, CPU display LUT). Forcing
            // Neutral here measured mean ΔE00 ≈ 19 off the embedded JPEG.
            return m;
        }

        /// <summary>
        /// Decode a RAW into a scene-linear f32 base, honoring the sidecar's
        /// decode-owned fields (lens corrections, capture sharpening, AE, ...)
        /// with chain-owned fields stripped.
        /// </summary>
        public static DecodedImage Decode(
            string rawPath, AdjustmentState model, int maxLongEdge, IntPtr cancelFlag)
        {
            var stripped = StripChainStages(model);
            var strippedXmp = Xmp.XmpWriter.Serialize(
                new Xmp.XmpSidecarDocument { Adjustments = stripped });
            var tempXmpPath = Path.Combine(
                Path.GetTempPath(), $"maple-decode-{Guid.NewGuid():N}.xmp");
            File.WriteAllText(tempXmpPath, strippedXmp);
            try
            {
                var buffer = new MapleSceneLinearBufferF32();
                var rc = RawFfi.maple_render_file_scene_linear_sized_f32(
                    rawPath, tempXmpPath, (uint)maxLongEdge, 1, cancelFlag, &buffer);
                if (rc != 0)
                    throw new InvalidOperationException(
                        $"scene-linear decode failed (rc={rc}): {RawFfi.LastError() ?? "unknown"}");
                try
                {
                    var count = (int)(buffer.width * buffer.height * 4);
                    var pixels = new float[count];
                    new ReadOnlySpan<float>(buffer.f32_rgba, count).CopyTo(pixels);
                    var noise = new float[buffer.noise_profile_len];
                    if (buffer.noise_profile_len > 0)
                        new ReadOnlySpan<float>(buffer.noise_profile_data, (int)buffer.noise_profile_len)
                            .CopyTo(noise);
                    var framePresent = buffer.wb_frame_scene_cct > 0f;
                    var decoded = new DecodedImage
                    {
                        Pixels = pixels,
                        Width = (int)buffer.width,
                        Height = (int)buffer.height,
                        NoiseProfile = noise,
                        Iso = buffer.iso,
                        AeGain = buffer.ae_gain,
                        DecodedTemperature = framePresent ? buffer.wb_frame_scene_cct : 6500f,
                        DecodedTint = framePresent ? buffer.wb_frame_as_shot_tint : 0f,
                        WbFrame = CopyWbFrame(&buffer),
                    };
                    if (stripped.Profile == ProfileMode.Auto)
                        FitAutoProfile(decoded, rawPath, tempXmpPath);
                    DiagLog.Write(
                        $"[decode] {System.IO.Path.GetFileName(rawPath)} ae_gain={decoded.AeGain:0.###} " +
                        $"curve={(decoded.ProfileCurve != null ? "yes" : "no")} " +
                        $"residual_n={decoded.ResidualLutSize} displayLut={(decoded.DisplayLut != null ? "yes" : "no")}");
                    return decoded;
                }
                finally
                {
                    RawFfi.maple_free_scene_linear_buffer_f32(&buffer);
                }
            }
            finally
            {
                try { File.Delete(tempXmpPath); } catch (IOException) { }
            }
        }

        /// <summary>
        /// Run the per-tick chain over the decoded base and produce BGRA8
        /// bytes ready for a WriteableBitmap. Reuses caller-provided scratch
        /// buffers to keep the tick allocation-free after the first call.
        /// </summary>
        public static void RenderTick(
            DecodedImage image, AdjustmentState model,
            ref float[]? chainScratch, byte[] bgraOut)
        {
            var pixelCount = image.Width * image.Height;
            var floatCount = pixelCount * 4;
            if (bgraOut.Length < pixelCount * 4)
                throw new ArgumentException("bgraOut too small", nameof(bgraOut));
            if (chainScratch == null || chainScratch.Length < floatCount)
                chainScratch = new float[floatCount];

            var p = MapleAdjustmentParams.From(
                model, image.DecodedTemperature, image.DecodedTint, image.Iso);
            ApplyWbFrame(ref p, image.WbFrame);

            // Point tone curves (#2576) ride a sibling struct — the scalar
            // params ABI can't carry variable-length knot lists.
            var curveLuma = FlattenCurve(model.ToneCurveLuma);
            var curveRed = FlattenCurve(model.ToneCurveRed);
            var curveGreen = FlattenCurve(model.ToneCurveGreen);
            var curveBlue = FlattenCurve(model.ToneCurveBlue);
            // Display-referred point curves (#2232) — same flat wire shape,
            // riding the same sibling struct's appended tail fields. This
            // fused CPU entry has no GPU live session on Windows, so it is
            // where the per-tick chain picks up the new stage.
            var displayCurveLuma = FlattenCurve(model.DisplayToneCurveLuma);
            var displayCurveRed = FlattenCurve(model.DisplayToneCurveRed);
            var displayCurveGreen = FlattenCurve(model.DisplayToneCurveGreen);
            var displayCurveBlue = FlattenCurve(model.DisplayToneCurveBlue);

            fixed (float* inPtr = image.Pixels)
            fixed (float* outPtr = chainScratch)
            fixed (float* noisePtr = image.NoiseProfile)
            fixed (float* lumaPtr = curveLuma)
            fixed (float* redPtr = curveRed)
            fixed (float* greenPtr = curveGreen)
            fixed (float* bluePtr = curveBlue)
            fixed (float* displayLumaPtr = displayCurveLuma)
            fixed (float* displayRedPtr = displayCurveRed)
            fixed (float* displayGreenPtr = displayCurveGreen)
            fixed (float* displayBluePtr = displayCurveBlue)
            {
                if (image.NoiseProfile.Length > 0)
                {
                    p.noise_profile_ptr = noisePtr;
                    p.noise_profile_len = (uint)image.NoiseProfile.Length;
                }
                var curves = new MapleToneCurves
                {
                    luma_ptr = lumaPtr,
                    luma_len = (nuint)curveLuma.Length,
                    red_ptr = redPtr,
                    red_len = (nuint)curveRed.Length,
                    green_ptr = greenPtr,
                    green_len = (nuint)curveGreen.Length,
                    blue_ptr = bluePtr,
                    blue_len = (nuint)curveBlue.Length,
                    mode = model.ToneCurveMode == ToneCurveMode.RatioPreserving ? 1u : 0u,
                    display_luma_ptr = displayLumaPtr,
                    display_luma_len = (nuint)displayCurveLuma.Length,
                    display_red_ptr = displayRedPtr,
                    display_red_len = (nuint)displayCurveRed.Length,
                    display_green_ptr = displayGreenPtr,
                    display_green_len = (nuint)displayCurveGreen.Length,
                    display_blue_ptr = displayBluePtr,
                    display_blue_len = (nuint)displayCurveBlue.Length,
                };
                var rc = RawFfi.maple_apply_chain_and_encode_display_curves_f32(
                    inPtr, (uint)image.Width, (uint)image.Height, &p, &curves, outPtr);
                if (rc != 0)
                    throw new InvalidOperationException(
                        $"per-tick chain failed (rc={rc}): {RawFfi.LastError() ?? "unknown"}");
            }

            // Auto Profile tail on the CPU fallback path: the composed
            // display-domain LUT post-encode (the CIColorCube equivalent).
            if (image.DisplayLut != null)
                ApplyDisplayLut(chainScratch, floatCount, image.DisplayLut, image.DisplayLutN);

            var src = chainScratch;
            for (int i = 0, o = 0; i < floatCount; i += 4, o += 4)
            {
                bgraOut[o] = ToByte(src[i + 2]);
                bgraOut[o + 1] = ToByte(src[i + 1]);
                bgraOut[o + 2] = ToByte(src[i]);
                bgraOut[o + 3] = 255;
            }
        }

        /// <summary>Flatten a knot list to the FFI wire form: [x0,y0,x1,y1,...]
        /// f32 pairs. Empty list (the identity) flattens to an empty array,
        /// which both FFI surfaces read as "no curve".</summary>
        public static float[] FlattenCurve(List<CurvePoint> points)
        {
            if (points.Count == 0)
                return Array.Empty<float>();
            var flat = new float[points.Count * 2];
            for (var i = 0; i < points.Count; i++)
            {
                flat[i * 2] = (float)points[i].X;
                flat[i * 2 + 1] = (float)points[i].Y;
            }
            return flat;
        }

        /// <summary>Fit the per-image Auto Profile tail (cached natively per
        /// (path, mtime, quality)): the separate curve + residual artifacts for
        /// the GPU live chain, and the composed display-domain LUT for the CPU
        /// fallback. rc 1 = no tail applies (plain AgX) — not an error.</summary>
        private static void FitAutoProfile(DecodedImage decoded, string rawPath, string xmpPath)
        {
            const int curveLen = 220;                 // MAPLE_PROFILE_CURVE_FLAT_LEN
            const int lutCapacityEdge = 33;
            var curve = new float[curveLen];
            var residual = new float[lutCapacityEdge * lutCapacityEdge * lutCapacityEdge * 3];
            int curvePresent;
            uint lutSize;
            int rc;
            fixed (float* curvePtr = curve)
            fixed (float* lutPtr = residual)
            {
                rc = RawFfi.maple_gpu_fit_auto_profile(
                    rawPath, xmpPath, 1, curvePtr, &curvePresent,
                    lutPtr, (nuint)residual.Length, &lutSize);
                if (rc == -2 && lutSize > 0)
                {
                    // Residual larger than the default capacity — reallocate to
                    // the advertised edge and re-call (the fit is cached).
                    residual = new float[(int)lutSize * (int)lutSize * (int)lutSize * 3];
                    fixed (float* lutPtr2 = residual)
                    {
                        rc = RawFfi.maple_gpu_fit_auto_profile(
                            rawPath, xmpPath, 1, curvePtr, &curvePresent,
                            lutPtr2, (nuint)residual.Length, &lutSize);
                    }
                }
            }
            if (rc != 0)
            {
                if (rc != 1)
                    DiagLog.Write($"[profile] gpu fit rc={rc}: {RawFfi.LastError()}");
                return;
            }
            if (curvePresent != 0)
                decoded.ProfileCurve = curve;
            if (lutSize > 0)
            {
                var lutFloats = (int)lutSize * (int)lutSize * (int)lutSize * 3;
                decoded.ResidualLut = residual.AsSpan(0, lutFloats).ToArray();
                decoded.ResidualLutSize = lutSize;
            }

            // Composed display-domain LUT for the CPU fallback path.
            const int displayN = 33;
            var displayLut = new float[displayN * displayN * displayN * 3];
            fixed (float* displayPtr = displayLut)
            {
                var lutRc = RawFfi.maple_compute_auto_profile_lut(
                    rawPath, xmpPath, 1, displayN, displayPtr);
                if (lutRc == 0)
                {
                    decoded.DisplayLut = displayLut;
                    decoded.DisplayLutN = displayN;
                }
                else
                {
                    DiagLog.Write($"[profile] cpu lut rc={lutRc}: {RawFfi.LastError()}");
                }
            }
        }

        /// <summary>Trilinear 3D-LUT application over display-encoded RGB —
        /// the CPU-fallback equivalent of Apple's post-encode CIColorCube.
        /// Layout: data[((b*n+g)*n+r)*3+c], R fastest.</summary>
        public static void ApplyDisplayLut(float[] rgba, int floatCount, float[] lut, int n)
        {
            var maxIndex = n - 1;
            for (var i = 0; i < floatCount; i += 4)
            {
                var r = Math.Clamp(rgba[i], 0f, 1f) * maxIndex;
                var g = Math.Clamp(rgba[i + 1], 0f, 1f) * maxIndex;
                var b = Math.Clamp(rgba[i + 2], 0f, 1f) * maxIndex;
                int r0 = (int)r, g0 = (int)g, b0 = (int)b;
                int r1 = Math.Min(r0 + 1, maxIndex), g1 = Math.Min(g0 + 1, maxIndex), b1 = Math.Min(b0 + 1, maxIndex);
                float fr = r - r0, fg = g - g0, fb = b - b0;
                for (var c = 0; c < 3; c++)
                {
                    float At(int bi, int gi, int ri) => lut[(((bi * n) + gi) * n + ri) * 3 + c];
                    var c00 = At(b0, g0, r0) * (1 - fr) + At(b0, g0, r1) * fr;
                    var c01 = At(b0, g1, r0) * (1 - fr) + At(b0, g1, r1) * fr;
                    var c10 = At(b1, g0, r0) * (1 - fr) + At(b1, g0, r1) * fr;
                    var c11 = At(b1, g1, r0) * (1 - fr) + At(b1, g1, r1) * fr;
                    var c0 = c00 * (1 - fg) + c01 * fg;
                    var c1 = c10 * (1 - fg) + c11 * fg;
                    rgba[i + c] = c0 * (1 - fb) + c1 * fb;
                }
            }
        }

        private static byte ToByte(float v) =>
            (byte)Math.Clamp((int)(v * 255f + 0.5f), 0, 255);

        /// <summary>2×2 box-average downsample of the scene-linear base for the
        /// fast slider-tick pass (the refine pass uses the full preview).</summary>
        public static DecodedImage DownsampleHalf(DecodedImage src)
        {
            var w = Math.Max(1, src.Width / 2);
            var h = Math.Max(1, src.Height / 2);
            var pixels = new float[w * h * 4];
            for (var y = 0; y < h; y++)
            {
                var sy0 = y * 2;
                var sy1 = Math.Min(sy0 + 1, src.Height - 1);
                for (var x = 0; x < w; x++)
                {
                    var sx0 = x * 2;
                    var sx1 = Math.Min(sx0 + 1, src.Width - 1);
                    var o = (y * w + x) * 4;
                    var a = (sy0 * src.Width + sx0) * 4;
                    var b = (sy0 * src.Width + sx1) * 4;
                    var c = (sy1 * src.Width + sx0) * 4;
                    var d = (sy1 * src.Width + sx1) * 4;
                    for (var k = 0; k < 4; k++)
                        pixels[o + k] = (src.Pixels[a + k] + src.Pixels[b + k]
                                       + src.Pixels[c + k] + src.Pixels[d + k]) * 0.25f;
                }
            }
            return new DecodedImage
            {
                Pixels = pixels,
                Width = w,
                Height = h,
                NoiseProfile = src.NoiseProfile,
                Iso = src.Iso,
                AeGain = src.AeGain,
                DecodedTemperature = src.DecodedTemperature,
                DecodedTint = src.DecodedTint,
                WbFrame = src.WbFrame,
                ProfileCurve = src.ProfileCurve,
                ResidualLut = src.ResidualLut,
                ResidualLutSize = src.ResidualLutSize,
                DisplayLut = src.DisplayLut,
                DisplayLutN = src.DisplayLutN,
            };
        }

        /// <summary>The wb_frame block spans 82 floats in both the buffer
        /// export and the params struct, in identical field order
        /// (9+1+9+1+1+1+9+9+3+1+9+1+9+1+9+9).</summary>
        public const int WbFrameFloatCount = 82;

        private static float[] CopyWbFrame(MapleSceneLinearBufferF32* b)
        {
            var f = new float[WbFrameFloatCount];
            var i = 0;
            for (var k = 0; k < 9; k++) f[i++] = b->wb_frame_m_cold[k];
            f[i++] = b->wb_frame_cct_cold;
            for (var k = 0; k < 9; k++) f[i++] = b->wb_frame_m_warm[k];
            f[i++] = b->wb_frame_cct_warm;
            f[i++] = b->wb_frame_scene_cct;
            f[i++] = b->wb_frame_as_shot_tint;
            for (var k = 0; k < 9; k++) f[i++] = b->wb_frame_render_cm[k];
            for (var k = 0; k < 9; k++) f[i++] = b->wb_frame_render_forward_matrix[k];
            for (var k = 0; k < 3; k++) f[i++] = b->wb_frame_render_scene_white_xyz[k];
            f[i++] = b->wb_frame_render_wb_already_baked;
            for (var k = 0; k < 9; k++) f[i++] = b->wb_frame_render_cm_cold[k];
            f[i++] = b->wb_frame_render_cct_cold;
            for (var k = 0; k < 9; k++) f[i++] = b->wb_frame_render_cm_warm[k];
            f[i++] = b->wb_frame_render_cct_warm;
            for (var k = 0; k < 9; k++) f[i++] = b->wb_frame_render_fm_cold[k];
            for (var k = 0; k < 9; k++) f[i++] = b->wb_frame_render_fm_warm[k];
            return f;
        }

        private static void ApplyWbFrame(ref MapleAdjustmentParams p, float[] f)
        {
            var i = 0;
            fixed (MapleAdjustmentParams* pp = &p)
            {
                for (var k = 0; k < 9; k++) pp->wb_frame_m_cold[k] = f[i++];
                pp->wb_frame_cct_cold = f[i++];
                for (var k = 0; k < 9; k++) pp->wb_frame_m_warm[k] = f[i++];
                pp->wb_frame_cct_warm = f[i++];
                pp->wb_frame_scene_cct = f[i++];
                pp->wb_frame_as_shot_tint = f[i++];
                for (var k = 0; k < 9; k++) pp->wb_frame_render_cm[k] = f[i++];
                for (var k = 0; k < 9; k++) pp->wb_frame_render_forward_matrix[k] = f[i++];
                for (var k = 0; k < 3; k++) pp->wb_frame_render_scene_white_xyz[k] = f[i++];
                pp->wb_frame_render_wb_already_baked = f[i++];
                for (var k = 0; k < 9; k++) pp->wb_frame_render_cm_cold[k] = f[i++];
                pp->wb_frame_render_cct_cold = f[i++];
                for (var k = 0; k < 9; k++) pp->wb_frame_render_cm_warm[k] = f[i++];
                pp->wb_frame_render_cct_warm = f[i++];
                for (var k = 0; k < 9; k++) pp->wb_frame_render_fm_cold[k] = f[i++];
                for (var k = 0; k < 9; k++) pp->wb_frame_render_fm_warm[k] = f[i++];
            }
        }
    }
}
