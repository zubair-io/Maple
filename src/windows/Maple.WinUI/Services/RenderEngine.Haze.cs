using System;
using Maple.WinUI.Models;
using Maple.WinUI.Native;

namespace Maple.WinUI.Services
{
    /// <summary>
    /// The whole frame's dehaze maps a native-detail window recovers with
    /// (#3287). Split out of RenderEngine.cs for the file-size budget.
    /// </summary>
    public static unsafe partial class RenderEngine
    {
        /// <summary>The windowed tick (#3876), recovering dehaze with the maps
        /// of <paramref name="hazeFrame"/> when it is engaged.</summary>
        private static int ApplyWindow(DecodedImage image, AdjustmentState model, FilmLut? film,
            MapleChainWindow window, DecodedImage? hazeFrame, float* input, MapleAdjustmentParams* p,
            MapleToneCurves* curves, float* output)
        {
            var haze = hazeFrame != null && DehazeEngaged(model)
                ? MeasureHaze(hazeFrame, model, *p, curves)
                : IntPtr.Zero;
            try
            {
                return string.IsNullOrEmpty(model.FilmLook)
                    ? RawFfi.ApplyWindow(input, (uint)image.Width, (uint)image.Height, p, curves,
                        IntPtr.Zero, 0, &window, haze, output)
                    : RawFfi.ApplyWindow(input, (uint)image.Width, (uint)image.Height, p, curves,
                        film!.NativeHandle!, (float)model.FilmStrength, &window, haze, output);
            }
            finally
            {
                if (haze != IntPtr.Zero) RawFfi.maple_haze_map_free(haze);
            }
        }

        private static bool DehazeEngaged(AdjustmentState model) =>
            Math.Abs(model.Dehaze) >= 1e-3
            || model.LocalAdjustments.Exists(layer => Math.Abs(layer.Adjustments.Dehaze ?? 0) >= 1e-3);

        /// <summary>The dehaze maps of <paramref name="frame"/> under the
        /// frame's own decode anchors and the tick's pinned curves and layers
        /// (#3287). Rust memoises the last measurement, so pans and dehaze
        /// moves reuse it.</summary>
        private static IntPtr MeasureHaze(DecodedImage frame, AdjustmentState model,
            MapleAdjustmentParams tick, MapleToneCurves* curves)
        {
            var p = MapleAdjustmentParams.From(
                model, frame.DecodedTemperature, frame.DecodedTint, frame.Iso, frame.WhitesAnchorEv, frame.NrSamplingScale);
            ApplyWbExports(ref p, frame);
            p.skip_agx = frame.IsRaster ? 1u : 0u;
            p.local_adjustments_ptr = tick.local_adjustments_ptr;
            p.local_adjustments_len = tick.local_adjustments_len;
            fixed (float* framePtr = frame.Pixels)
            {
                var rc = RawFfi.maple_scene_linear_chain_haze_map_f32(
                    framePtr, (uint)frame.Width, (uint)frame.Height, &p, curves, out var haze);
                if (rc != 0)
                    throw new InvalidOperationException(
                        $"native-detail haze map failed (rc={rc}): {RawFfi.LastError() ?? "unknown"}");
                return haze;
            }
        }
    }
}
