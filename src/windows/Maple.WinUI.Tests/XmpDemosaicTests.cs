using System;
using System.Linq;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Export;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public class XmpDemosaicTests
{
    [Theory]
    [InlineData("Auto")]
    [InlineData("Amaze")]
    [InlineData("Rcd")]
    [InlineData("DualAmaze")]
    [InlineData("DualRcd")]
    [InlineData("Lmmse")]
    [InlineData("Future & kernel")]
    public void ChoiceSurvivesCloneDecodeAndExportSnapshot(string choice)
    {
        var model = new AdjustmentState { Demosaic = choice, Exposure = 1.2 };
        var xml = XmpWriter.Serialize(new() { Adjustments = model });
        var loaded = XmpParser.Parse(xml)!;
        Assert.Equal(choice, loaded.Adjustments.Demosaic);
        Assert.DoesNotContain(loaded.PassthroughAttributes, a => a.Name == "papp:Demosaic");
        var decode = RenderEngine.StripChainStages(loaded.Adjustments);
        Assert.Equal(choice, decode.Demosaic);
        Assert.Equal(0, decode.Exposure);
        Assert.False(RenderEngine.DecodeInputsChanged(model, decode));
        var edited = model.Clone();
        edited.Demosaic = choice == "Rcd" ? "Auto" : "Rcd";
        Assert.True(RenderEngine.DecodeInputsChanged(model, edited));
        var frozen = ExportSnapshot.Serialize(xml, edited);
        var expected = edited.Demosaic;
        edited.Demosaic = "Amaze";
        Assert.Equal(expected, XmpParser.Parse(frozen)!.Adjustments.Demosaic);
    }

    [Fact]
    public void DefaultIsOmittedAndKnownImportedCaseIsCanonicalized()
    {
        var xml = XmpWriter.Serialize(new());
        Assert.DoesNotContain("papp:Demosaic", xml);
        Assert.Equal("Auto", XmpParser.Parse(xml)!.Adjustments.Demosaic);
        foreach (var name in Enum.GetNames<DemosaicChoice>())
        {
            var imported = XmpWriter.Serialize(new() { Adjustments = new() { Demosaic = name.ToLowerInvariant() } });
            Assert.Equal(name, XmpParser.Parse(imported)!.Adjustments.Demosaic);
        }
    }
}
