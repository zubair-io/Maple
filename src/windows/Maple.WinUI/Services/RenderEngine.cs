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
            m.Profile = ProfileMode.Neutral;
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
            var strippedXmp = Xmp.XmpWriter.Serialize(
                new Xmp.XmpSidecarDocument { Adjustments = StripChainStages(model) });
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
                    return new DecodedImage
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

            fixed (float* inPtr = image.Pixels)
            fixed (float* outPtr = chainScratch)
            fixed (float* noisePtr = image.NoiseProfile)
            {
                if (image.NoiseProfile.Length > 0)
                {
                    p.noise_profile_ptr = noisePtr;
                    p.noise_profile_len = (uint)image.NoiseProfile.Length;
                }
                var rc = RawFfi.maple_apply_chain_and_encode_display_f32(
                    inPtr, (uint)image.Width, (uint)image.Height, &p, outPtr);
                if (rc != 0)
                    throw new InvalidOperationException(
                        $"per-tick chain failed (rc={rc}): {RawFfi.LastError() ?? "unknown"}");
            }

            var src = chainScratch;
            for (int i = 0, o = 0; i < floatCount; i += 4, o += 4)
            {
                bgraOut[o] = ToByte(src[i + 2]);
                bgraOut[o + 1] = ToByte(src[i + 1]);
                bgraOut[o + 2] = ToByte(src[i]);
                bgraOut[o + 3] = 255;
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
