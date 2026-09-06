using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public class LensProfileTests
{
    [Theory]
    [InlineData("lcp1:")]
    [InlineData("lcp1-ack:")]
    public void ExactProfileSurvivesRealSidecarAndDecodeStripping(string prefix)
    {
        var reference = prefix + new string('a', 64);
        var directory = Path.Combine(Path.GetTempPath(), "maple-lcp-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var raw = Path.Combine(directory, "photo.dng");
            SidecarStore.Save(raw, new XmpSidecarDocument { Adjustments = new AdjustmentState { LensProfile = reference, Exposure = 2 } });
            var model = SidecarStore.Load(raw)!.Adjustments;
            Assert.Equal(reference, model.LensProfile);
            Assert.Equal(reference, RenderEngine.StripChainStages(model).LensProfile);
            Assert.Equal(2, model.Exposure);
            Assert.True(RenderEngine.DecodeInputsChanged(new AdjustmentState(), model));
        }
        finally { Directory.Delete(directory, true); }
    }

    [Fact]
    public void AllOpticalStrengthsInvalidateTheBaseAndDisabledSelectionNeedsNoCache()
    {
        var model = new AdjustmentState();
        Assert.True(RenderEngine.DecodeInputsChanged(model, new AdjustmentState { LensCorrectionCa = 50 }));
        Assert.True(RenderEngine.DecodeInputsChanged(model, new AdjustmentState { LensCorrectionVignetting = 50 }));
        LensProfileStore.RestoreForFile("missing.dng", new AdjustmentState { LensProfile = "lcp1:" + new string('b', 64), LensProfileEnable = ToggleMode.Off });
        LensProfileStore.RestoreForFile("missing.dng", new AdjustmentState { LensProfile = "lcp1:" + new string('b', 64), LensCorrectionDistortion = 0, LensCorrectionCa = 0, LensCorrectionVignetting = 0 });
    }

    [Theory]
    [InlineData("../profile.lcp")]
    [InlineData("lcp1:../profile.lcp")]
    [InlineData("lcp2:abc")]
    public void CacheReferenceCannotEscapeItsDirectory(string value) => Assert.Throws<InvalidOperationException>(() => LensProfileStore.Digest(value));
}
