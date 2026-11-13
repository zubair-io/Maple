using System.Collections.Generic;
using Maple.WinUI.Models;
using Maple.WinUI.Native;

namespace Maple.WinUI.Services
{
    /// <summary>
    /// Every point curve of a model flattened to the FFI wire form
    /// (<see cref="RenderEngine.FlattenCurve"/>), retained until its points change for
    /// both the fused CPU chain and the GPU live present (#4740, #5041).
    /// </summary>
    public sealed unsafe record FlatToneCurves(
        float[] Luma, float[] Red, float[] Green, float[] Blue,
        float[] DisplayLuma, float[] DisplayRed, float[] DisplayGreen, float[] DisplayBlue,
        float[] ColorCurveHueVsHue, float[] ColorCurveHueVsSat, float[] ColorCurveHueVsLuma,
        float[] ColorCurveLumaVsSat, float[] ColorCurveSatVsSat, float[] ColorCurveSatVsLuma)
    {
        // Rendering is serialized per worker; each thread retains one bounded wire snapshot.
        [System.ThreadStatic] private static FlatToneCurves? _cached;

        public static FlatToneCurves From(AdjustmentState model)
        {
            var previous = _cached;
            if (previous != null
                && Matches(model.ToneCurveLuma, previous.Luma)
                && Matches(model.ToneCurveRed, previous.Red)
                && Matches(model.ToneCurveGreen, previous.Green)
                && Matches(model.ToneCurveBlue, previous.Blue)
                && Matches(model.DisplayToneCurveLuma, previous.DisplayLuma)
                && Matches(model.DisplayToneCurveRed, previous.DisplayRed)
                && Matches(model.DisplayToneCurveGreen, previous.DisplayGreen)
                && Matches(model.DisplayToneCurveBlue, previous.DisplayBlue)
                && Matches(model.ColorCurveHueVsHue, previous.ColorCurveHueVsHue)
                && Matches(model.ColorCurveHueVsSat, previous.ColorCurveHueVsSat)
                && Matches(model.ColorCurveHueVsLuma, previous.ColorCurveHueVsLuma)
                && Matches(model.ColorCurveLumaVsSat, previous.ColorCurveLumaVsSat)
                && Matches(model.ColorCurveSatVsSat, previous.ColorCurveSatVsSat)
                && Matches(model.ColorCurveSatVsLuma, previous.ColorCurveSatVsLuma)
            ) return previous;
            return _cached = new(
                Reuse(model.ToneCurveLuma, previous?.Luma),
                Reuse(model.ToneCurveRed, previous?.Red),
                Reuse(model.ToneCurveGreen, previous?.Green),
                Reuse(model.ToneCurveBlue, previous?.Blue),
                Reuse(model.DisplayToneCurveLuma, previous?.DisplayLuma),
                Reuse(model.DisplayToneCurveRed, previous?.DisplayRed),
                Reuse(model.DisplayToneCurveGreen, previous?.DisplayGreen),
                Reuse(model.DisplayToneCurveBlue, previous?.DisplayBlue),
                Reuse(model.ColorCurveHueVsHue, previous?.ColorCurveHueVsHue),
                Reuse(model.ColorCurveHueVsSat, previous?.ColorCurveHueVsSat),
                Reuse(model.ColorCurveHueVsLuma, previous?.ColorCurveHueVsLuma),
                Reuse(model.ColorCurveLumaVsSat, previous?.ColorCurveLumaVsSat),
                Reuse(model.ColorCurveSatVsSat, previous?.ColorCurveSatVsSat),
                Reuse(model.ColorCurveSatVsLuma, previous?.ColorCurveSatVsLuma));
        }

        private static float[] Reuse(List<CurvePoint> points, float[]? existing) =>
            existing != null && Matches(points, existing) ? existing : RenderEngine.FlattenCurve(points);

        private static bool Matches(List<CurvePoint> points, float[] flat)
        {
            if (points.Count * 2 != flat.Length) return false;
            for (var i = 0; i < points.Count; i++)
                if ((float)points[i].X != flat[i * 2] || (float)points[i].Y != flat[i * 2 + 1]) return false;
            return true;
        }

        public void BindColorCurves(
            ref MapleToneCurves c,
            float* hh, float* hs, float* hl, float* ls, float* ss, float* sl)
        {
            c.color_curve_hue_vs_hue_ptr = hh; c.color_curve_hue_vs_hue_len = (nuint)ColorCurveHueVsHue.Length;
            c.color_curve_hue_vs_sat_ptr = hs; c.color_curve_hue_vs_sat_len = (nuint)ColorCurveHueVsSat.Length;
            c.color_curve_hue_vs_luma_ptr = hl; c.color_curve_hue_vs_luma_len = (nuint)ColorCurveHueVsLuma.Length;
            c.color_curve_luma_vs_sat_ptr = ls; c.color_curve_luma_vs_sat_len = (nuint)ColorCurveLumaVsSat.Length;
            c.color_curve_sat_vs_sat_ptr = ss; c.color_curve_sat_vs_sat_len = (nuint)ColorCurveSatVsSat.Length;
            c.color_curve_sat_vs_luma_ptr = sl; c.color_curve_sat_vs_luma_len = (nuint)ColorCurveSatVsLuma.Length;
        }

        public void BindColorCurves(
            ref MapleGpuLiveParams p,
            float* hh, float* hs, float* hl, float* ls, float* ss, float* sl)
        {
            p.color_curve_hue_vs_hue_ptr = hh; p.color_curve_hue_vs_hue_len = (nuint)ColorCurveHueVsHue.Length;
            p.color_curve_hue_vs_sat_ptr = hs; p.color_curve_hue_vs_sat_len = (nuint)ColorCurveHueVsSat.Length;
            p.color_curve_hue_vs_luma_ptr = hl; p.color_curve_hue_vs_luma_len = (nuint)ColorCurveHueVsLuma.Length;
            p.color_curve_luma_vs_sat_ptr = ls; p.color_curve_luma_vs_sat_len = (nuint)ColorCurveLumaVsSat.Length;
            p.color_curve_sat_vs_sat_ptr = ss; p.color_curve_sat_vs_sat_len = (nuint)ColorCurveSatVsSat.Length;
            p.color_curve_sat_vs_luma_ptr = sl; p.color_curve_sat_vs_luma_len = (nuint)ColorCurveSatVsLuma.Length;
        }
    }
}
