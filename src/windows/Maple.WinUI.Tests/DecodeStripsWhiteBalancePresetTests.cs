// DecodeStripsWhiteBalancePresetTests — the decode model handed to raw-core
// must carry no white-balance provenance (#4739). StripChainStages reset
// Temperature/Tint (chain-owned, so the per-tick chain re-applies them) but
// left `crs:WhiteBalance` in place; raw-core's reader turns a named preset
// (Daylight, Tungsten, ...) back into a temperature/tint pair and bakes it
// into the scene-linear base, so the preset was applied twice.

using Maple.WinUI.Generated;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public class DecodeStripsWhiteBalancePresetTests
{
    [Theory]
    [InlineData("Daylight")]
    [InlineData("Cloudy")]
    [InlineData("Tungsten")]
    [InlineData("Shade")]
    [InlineData("Flash")]
    [InlineData("Fluorescent")]
    public void NamedPreset_DoesNotReachTheDecodeXmp(string preset)
    {
        var edited = new AdjustmentState();
        Assert.True(WhiteBalanceProvenance.ApplyNamedPreset(edited, preset));

        var decodeXmp = XmpWriter.Serialize(new() { Adjustments = RenderEngine.StripChainStages(edited) });

        Assert.DoesNotContain(XmpWhiteBalance.PresetKey, decodeXmp);
        Assert.DoesNotContain(XmpWhiteBalance.SourceKey, decodeXmp);
        Assert.DoesNotContain("crs:Temperature", decodeXmp);
        Assert.DoesNotContain("crs:Tint", decodeXmp);
    }

    [Fact]
    public void SampledAndAutoProvenance_DoNotReachTheDecodeXmp()
    {
        var sampled = new AdjustmentState
        {
            WhiteBalancePreset = WhiteBalancePresets.Custom,
            WbSource = WbSource.Sampled,
            WbSampleX = 0.25,
            WbSampleY = 0.75,
            WbAlgorithmVersion = WhiteBalancePresets.AutoWhiteBalanceAlgorithmVersion,
            Temperature = 4200,
            Tint = 12,
        };
        var auto = new AdjustmentState();
        auto.Temperature = 5100; auto.Tint = -4; WhiteBalanceProvenance.MarkAuto(auto);

        foreach (var state in new[] { sampled, auto })
        {
            var stripped = RenderEngine.StripChainStages(state);
            var decodeXmp = XmpWriter.Serialize(new() { Adjustments = stripped });
            Assert.DoesNotContain(XmpWhiteBalance.PresetKey, decodeXmp);
            Assert.DoesNotContain(XmpWhiteBalance.SourceKey, decodeXmp);
            Assert.DoesNotContain(XmpWhiteBalance.SampleXKey, decodeXmp);
            Assert.DoesNotContain(XmpWhiteBalance.AlgorithmVersionKey, decodeXmp);
            Assert.Equal(new AdjustmentState().Temperature, stripped.Temperature);
            Assert.Equal(new AdjustmentState().Tint, stripped.Tint);
        }
    }

    [Fact]
    public void WhiteBalanceIsChainOwned_SoAPresetChangeDoesNotInvalidateTheDecodedBase()
    {
        var before = new AdjustmentState();
        var after = before.Clone();
        Assert.True(WhiteBalanceProvenance.ApplyNamedPreset(after, "Tungsten"));

        Assert.False(RenderEngine.DecodeInputsChanged(before, after));
        Assert.False(RenderEngine.DecodeInputsChanged(
            RenderEngine.StripChainStages(before), RenderEngine.StripChainStages(after)));
    }
}
