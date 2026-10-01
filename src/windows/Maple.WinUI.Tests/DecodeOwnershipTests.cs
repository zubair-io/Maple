using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public class DecodeOwnershipTests
{
    [Theory]
    [InlineData("chroma")]
    [InlineData("hot-pixel")]
    [InlineData("lateral-ca")]
    public void SensorEditsPersistInDecodeAndInvalidateBothEditAndUndo(string stage)
    {
        var before = new AdjustmentState();
        var edited = before.Clone();
        switch (stage)
        {
            case "chroma": edited.ChromaPrefilter = 25; break;
            case "hot-pixel": edited.HotPixelSuppression = ToggleMode.On; break;
            case "lateral-ca": edited.AutoLateralCa = ToggleMode.On; break;
        }
        var reopened = XmpParser.Parse(XmpWriter.Serialize(new() { Adjustments = edited }))!.Adjustments;
        var decoded = RenderEngine.StripChainStages(reopened);
        Assert.True(RenderEngine.DecodeInputsChanged(before, decoded));
        Assert.True(RenderEngine.DecodeInputsChanged(decoded, before));
        Assert.False(RenderEngine.DecodeInputsChanged(edited, decoded));
        Assert.False(RenderEngine.DecodeInputsChanged(before, before.Clone()));
        Assert.Equal(edited.ChromaPrefilter, decoded.ChromaPrefilter);
        Assert.Equal(edited.HotPixelSuppression, decoded.HotPixelSuppression);
        Assert.Equal(edited.AutoLateralCa, decoded.AutoLateralCa);
    }
}
