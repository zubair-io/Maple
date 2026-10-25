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
            var haze = hazeFrame != null && DehazeEngaged(model) ? RentHaze(hazeFrame, model, *p, curves) : null;
            try
            {
                var handle = haze?.DangerousGetHandle() ?? IntPtr.Zero;
                return string.IsNullOrEmpty(model.FilmLook)
                    ? RawFfi.ApplyWindow(input, (uint)image.Width, (uint)image.Height, p, curves,
                        IntPtr.Zero, 0, &window, handle, output)
                    : RawFfi.ApplyWindow(input, (uint)image.Width, (uint)image.Height, p, curves,
                        film!.NativeHandle!, (float)model.FilmStrength, &window, handle, output);
            }
            finally
            {
                haze?.DangerousRelease();
            }
        }

        private static bool DehazeEngaged(AdjustmentState model) =>
            Math.Abs(model.Dehaze) >= 1e-3
            || model.LocalAdjustments.Exists(layer => Math.Abs(layer.Adjustments.Dehaze ?? 0) >= 1e-3);

        /// <summary>The dehaze maps of <paramref name="frame"/> under the
        /// frame's own decode anchors and the tick's pinned curves and layers
        /// (#3287), from <see cref="NativeDetailHazeCache"/>: a pan or a dehaze
        /// move hashes the parameters only and never touches the frame.</summary>
        private static HazeMapHandle? RentHaze(DecodedImage frame, AdjustmentState model,
            MapleAdjustmentParams tick, MapleToneCurves* curves)
        {
            var p = MapleAdjustmentParams.From(
                model, frame.DecodedTemperature, frame.DecodedTint, frame.Iso, frame.WhitesAnchorEv, frame.NrSamplingScale);
            ApplyWbExports(ref p, frame);
            p.skip_agx = frame.IsRaster ? 1u : 0u;
            p.local_adjustments_ptr = tick.local_adjustments_ptr;
            p.local_adjustments_len = tick.local_adjustments_len;
            var key = RawFfi.maple_scene_linear_chain_haze_key(&p, curves);
            if (key == 0) return null;
            if (NativeDetailHazeCache.TryRent(frame, key, out var cached)) return cached;
            var measured = MeasureHaze(frame, &p, curves);
            return measured == null ? null : NativeDetailHazeCache.StoreAndRent(frame, key, measured);
        }

        private static HazeMapHandle? MeasureHaze(DecodedImage frame, MapleAdjustmentParams* p, MapleToneCurves* curves)
        {
            fixed (float* framePtr = frame.Pixels)
            {
                var rc = RawFfi.maple_scene_linear_chain_haze_map_f32(
                    framePtr, (uint)frame.Width, (uint)frame.Height, p, curves, out var haze);
                if (rc != 0)
                    throw new InvalidOperationException(
                        $"native-detail haze map failed (rc={rc}): {RawFfi.LastError() ?? "unknown"}");
                return haze == IntPtr.Zero ? null : new HazeMapHandle(haze);
            }
        }
    }
}
