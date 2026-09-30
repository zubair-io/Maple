using System.Text.Json;
using Maple.WinUI.Generated;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class AdjustmentTransferTests
{
    [Fact]
    public void EveryGeneratedGroupBuildsAndSourceSnapshotIsIndependent()
    {
        var source = new AdjustmentState { Contrast = 35 };
        source.ToneCurveLuma.Add(new(.3, .4));
        var clipboard = new AdjustmentTransferSource(source, 5, new(6500, 0));
        source.Contrast = 99;
        source.ToneCurveLuma.Clear();
        var patch = AdjustmentTransfer.Build(clipboard, AdjustmentFields.Groups.Select(g => g.Id));
        var target = new XmpSidecarDocument();
        AdjustmentTransfer.Apply(target, patch);
        Assert.Equal(35, target.Adjustments.Contrast);
        Assert.Equal(new CurvePoint(.3, .4), Assert.Single(target.Adjustments.ToneCurveLuma));
        Assert.DoesNotContain("lens_profile", patch.Fields.Keys);
        Assert.DoesNotContain("local_adjustments", patch.Fields.Keys);
        Assert.Equal("AssetRelative", AdjustmentFields.TransferModes["crop"]);
        Assert.Contains("temperature_seen", patch.Excluded);
    }

    [Fact]
    public void DenseDefaultTransferResetsOnlySelectedGroupsAndPreservesTargetXmp()
    {
        var target = new XmpSidecarDocument { Rating = 4, ColorLabel = "blue", Adjustments = new() { Exposure = 2, Saturation = 30, WbSampleX = .7 } };
        target.PassthroughNamespaces.Add(new("vendor", "urn:vendor"));
        target.PassthroughAttributes.Add(new("vendor:kept", "yes"));
        target.PassthroughNodes.Add("<vendor:Repair x=\"7\" />");
        var patch = AdjustmentTransfer.Build(new(new(), 5, null), new[] { "tone" });
        AdjustmentTransfer.Apply(target, patch);
        Assert.Equal(0, target.Adjustments.Exposure);
        Assert.Equal(30, target.Adjustments.Saturation);
        Assert.Equal(.7, target.Adjustments.WbSampleX);
        var saved = XmpWriter.Serialize(target);
        Assert.Contains("vendor:kept=\"yes\"", saved);
        Assert.Contains("<vendor:Repair x=\"7\" />", saved);
        Assert.Equal(4, XmpParser.Parse(saved)!.Rating);
    }

    [Fact]
    public void RelativeWhiteBalanceUsesEachCameraAndClearsSamplingProvenance()
    {
        var source = new AdjustmentState { Temperature = 6500, Tint = -15, WbSource = WbSource.Sampled, WbSampleX = .7, WbSampleY = .5, WbAlgorithmVersion = 3 };
        var clipboard = new AdjustmentTransferSource(source, 5, new(6000, -10));
        foreach (var baseline in new[] { new WhiteBalanceBaseline(4000, 20), new WhiteBalanceBaseline(11800, -149) })
        {
            var patch = AdjustmentTransfer.Build(clipboard, new[] { "white_balance" }, true, baseline);
            var target = new XmpSidecarDocument { Adjustments = new() { WbSampleX = .2, WbSampleY = .3, WbAlgorithmVersion = 2 } };
            AdjustmentTransfer.Apply(target, patch);
            Assert.Equal(Math.Min(12000, baseline.Temperature + 500), target.Adjustments.Temperature);
            Assert.Equal(Math.Max(-150, baseline.Tint - 5), target.Adjustments.Tint);
            Assert.Equal(WbSource.Manual, target.Adjustments.WbSource);
            Assert.Equal(WhiteBalancePresets.Custom, target.Adjustments.WhiteBalancePreset);
            Assert.Equal(0, target.Adjustments.WbSampleX);
            Assert.Equal(0, target.Adjustments.WbSampleY);
            Assert.Equal(0, target.Adjustments.WbAlgorithmVersion);
            Assert.Equal(5, target.WbScaleVersion);
        }
    }

    [Fact]
    public void AsShotHasZeroCorrectionAndAbsolutePreservesScale()
    {
        var source = new AdjustmentState { Temperature = 6500, Tint = 10, WbSource = WbSource.AsShot, WhiteBalancePreset = WhiteBalancePresets.AsShot };
        var clipboard = new AdjustmentTransferSource(source, 5, new(4800, -4));
        Assert.Equal(new WhiteBalanceBaseline(0, 0), AdjustmentTransfer.Correction(clipboard));
        var target = new XmpSidecarDocument();
        AdjustmentTransfer.Apply(target, AdjustmentTransfer.Build(clipboard, new[] { "white_balance" }, true, new(3800, 11)));
        Assert.Equal(3800, target.Adjustments.Temperature);
        Assert.Equal(11, target.Adjustments.Tint);
        var legacy = new AdjustmentTransferSource(source, 1, new(4800, -4));
        Assert.Throws<InvalidDataException>(() => AdjustmentTransfer.Build(legacy, new[] { "white_balance" }, true, new(3800, 11)));
        AdjustmentTransfer.Apply(target, AdjustmentTransfer.Build(legacy, new[] { "white_balance" }));
        Assert.Equal(1, target.WbScaleVersion);
        Assert.Equal(WbSource.AsShot, target.Adjustments.WbSource);
        Assert.Equal(new WhiteBalanceBaseline(4850, -5), new WhiteBalanceBaseline(4825, -4.5).Snap());
    }

    [Fact]
    public void MissingBaselineAndInvalidPatchCannotPartiallyModifyTarget()
    {
        var source = new AdjustmentTransferSource(new(), 5, null);
        Assert.Throws<InvalidDataException>(() => AdjustmentTransfer.Build(source, new[] { "white_balance" }, true, new(4000, 0)));
        Assert.Throws<InvalidDataException>(() => AdjustmentTransfer.Build(source, new[] { "future" }));
        var target = new XmpSidecarDocument { Adjustments = new() { Exposure = 1 } };
        var patch = new AdjustmentTransferPatch(new Dictionary<string, JsonElement>
        {
            ["exposure"] = JsonSerializer.SerializeToElement(2),
            ["wb_sample_x"] = JsonSerializer.SerializeToElement(.5)
        }, 5, Array.Empty<string>());
        Assert.Throws<InvalidDataException>(() => AdjustmentTransfer.Apply(target, patch));
        Assert.Equal(1, target.Adjustments.Exposure);
    }

    [Fact]
    public void GeometryUsesNormalizedCropWithoutTargetAliasing()
    {
        var state = new AdjustmentState { Crop = new(.1, .2, .8, .9, 12), PerspectiveVertical = 10 };
        var patch = AdjustmentTransfer.Build(new(state, 5, null), new[] { "geometry" });
        var target = new XmpSidecarDocument();
        AdjustmentTransfer.Apply(target, patch);
        Assert.Equal(state.Crop, target.Adjustments.Crop);
        Assert.Equal(10, target.Adjustments.PerspectiveVertical);
        Assert.Equal(state.Crop, XmpParser.Parse(XmpWriter.Serialize(target))!.Adjustments.Crop);
    }
}
