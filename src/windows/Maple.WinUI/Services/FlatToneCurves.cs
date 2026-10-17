using System.Collections.Generic;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services
{
    /// <summary>
    /// Every point curve of a model flattened to the FFI wire form
    /// (<see cref="RenderEngine.FlattenCurve"/>), built once per tick for
    /// both the fused CPU chain and the GPU live present (#4740).
    /// </summary>
    public sealed record FlatToneCurves(
        float[] Luma, float[] Red, float[] Green, float[] Blue,
        float[] DisplayLuma, float[] DisplayRed, float[] DisplayGreen, float[] DisplayBlue)
    {
        public static FlatToneCurves From(AdjustmentState model) => new(
            RenderEngine.FlattenCurve(model.ToneCurveLuma),
            RenderEngine.FlattenCurve(model.ToneCurveRed),
            RenderEngine.FlattenCurve(model.ToneCurveGreen),
            RenderEngine.FlattenCurve(model.ToneCurveBlue),
            RenderEngine.FlattenCurve(model.DisplayToneCurveLuma),
            RenderEngine.FlattenCurve(model.DisplayToneCurveRed),
            RenderEngine.FlattenCurve(model.DisplayToneCurveGreen),
            RenderEngine.FlattenCurve(model.DisplayToneCurveBlue));
    }
}
