using System.Collections.Generic;
using Maple.WinUI.Models;
using Maple.WinUI.Native;

namespace Maple.WinUI.Services
{
    /// <summary>
    /// Every point curve of a model flattened to the FFI wire form
    /// (<see cref="RenderEngine.FlattenCurve"/>), built once per tick for
    /// both the fused CPU chain and the GPU live present (#4740, #5041).
    /// </summary>
    public sealed unsafe record FlatToneCurves(
        float[] Luma, float[] Red, float[] Green, float[] Blue,
        float[] DisplayLuma, float[] DisplayRed, float[] DisplayGreen, float[] DisplayBlue,
        float[] ColorCurveHueVsHue, float[] ColorCurveHueVsSat, float[] ColorCurveHueVsLuma,
        float[] ColorCurveLumaVsSat, float[] ColorCurveSatVsSat, float[] ColorCurveSatVsLuma)
    {
        public static FlatToneCurves From(AdjustmentState model) => new(
            RenderEngine.FlattenCurve(model.ToneCurveLuma),
            RenderEngine.FlattenCurve(model.ToneCurveRed),
            RenderEngine.FlattenCurve(model.ToneCurveGreen),
            RenderEngine.FlattenCurve(model.ToneCurveBlue),
            RenderEngine.FlattenCurve(model.DisplayToneCurveLuma),
            RenderEngine.FlattenCurve(model.DisplayToneCurveRed),
            RenderEngine.FlattenCurve(model.DisplayToneCurveGreen),
            RenderEngine.FlattenCurve(model.DisplayToneCurveBlue),
            RenderEngine.FlattenCurve(model.ColorCurveHueVsHue),
            RenderEngine.FlattenCurve(model.ColorCurveHueVsSat),
            RenderEngine.FlattenCurve(model.ColorCurveHueVsLuma),
            RenderEngine.FlattenCurve(model.ColorCurveLumaVsSat),
            RenderEngine.FlattenCurve(model.ColorCurveSatVsSat),
            RenderEngine.FlattenCurve(model.ColorCurveSatVsLuma));

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
