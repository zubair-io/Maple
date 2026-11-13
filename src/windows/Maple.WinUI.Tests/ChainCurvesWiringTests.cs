// ChainCurvesWiringTests — #4740: the Windows CPU/tile/histogram chain
// carries the WB method and the parametric tone curve regions + splits
// the #4738 ABI added, so it agrees with the GPU live present.

using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public class ChainCurvesWiringTests
{
    [Fact]
    public void CpuParamsCarryTheWbMethod()
    {
        var model = new AdjustmentState();
        Assert.Equal(0u, MapleAdjustmentParams.From(model, 6500, 0, 100, float.NaN).wb_method);
        model.WbMethod = WbMethod.DiagonalRec2020;
        Assert.Equal(1u, MapleAdjustmentParams.From(model, 6500, 0, 100, float.NaN).wb_method);
    }

    [Fact]
    public void CpuParamsWbMethodMatchesTheGpuLiveParams()
    {
        var image = new DecodedImage
        {
            Pixels = new float[4], Width = 1, Height = 1, NoiseProfile = [], Iso = 100, AeGain = 1, WhitesAnchorEv = float.NaN,
            DecodedTemperature = 6500, DecodedTint = 0,
        };
        var model = new AdjustmentState { WbMethod = WbMethod.DiagonalRec2020 };
        var cpu = MapleAdjustmentParams.From(model, 6500, 0, 100, float.NaN);
        Assert.Equal(MapleGpuLiveParams.From(model, image).wb_method, cpu.wb_method);
    }

    [Fact]
    public void ToneCurvesCarryTheParametricRegionsAndSplits()
    {
        var model = new AdjustmentState
        {
            ParametricHighlights = 12, ParametricLights = -8, ParametricDarks = 30, ParametricShadows = -45,
            ParametricShadowSplit = 20, ParametricMidtoneSplit = 55, ParametricHighlightSplit = 80,
            ToneCurveMode = ToneCurveMode.RatioPreserving,
        };
        var curves = RenderEngine.ToneCurvesFrom(model);
        Assert.Equal(12f, curves.parametric_highlights);
        Assert.Equal(-8f, curves.parametric_lights);
        Assert.Equal(30f, curves.parametric_darks);
        Assert.Equal(-45f, curves.parametric_shadows);
        Assert.Equal(20f, curves.parametric_shadow_split);
        Assert.Equal(55f, curves.parametric_midtone_split);
        Assert.Equal(80f, curves.parametric_highlight_split);
        Assert.Equal(1u, curves.mode);
    }

    [Fact]
    public void DefaultModelToneCurvesMatchTheGpuLiveSplits()
    {
        var image = new DecodedImage
        {
            Pixels = new float[4], Width = 1, Height = 1, NoiseProfile = [], Iso = 100, AeGain = 1, WhitesAnchorEv = float.NaN,
            DecodedTemperature = 6500, DecodedTint = 0,
        };
        var model = new AdjustmentState();
        var curves = RenderEngine.ToneCurvesFrom(model);
        var gpu = MapleGpuLiveParams.From(model, image);
        Assert.Equal(gpu.parametric_shadow_split, curves.parametric_shadow_split);
        Assert.Equal(gpu.parametric_midtone_split, curves.parametric_midtone_split);
        Assert.Equal(gpu.parametric_highlight_split, curves.parametric_highlight_split);
        Assert.Equal(0u, curves.mode);
    }
}
