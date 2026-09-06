using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public class GeometryIntentTests
{
    [Fact]
    public void ManualGeometryIsAppliedPerTickWithoutChangingTheDecodedBase()
    {
        var original = new AdjustmentState();
        var edited = new AdjustmentState
        {
            GeoPerspectiveH = 0.2, GeoPerspectiveV = -0.1,
            GeoRotation = 14, GeoAspect = 1.3, GeoScale = 0.8,
        };
        Assert.False(RenderEngine.DecodeInputsChanged(original, edited));
        var prefix = RenderEngine.StripChainStages(edited);
        Assert.Equal(0, prefix.GeoPerspectiveH);
        Assert.Equal(0, prefix.GeoPerspectiveV);
        Assert.Equal(0, prefix.GeoRotation);
        Assert.Equal(1, prefix.GeoAspect);
        Assert.Equal(1, prefix.GeoScale);
        Assert.Equal(14, edited.GeoRotation);
        Assert.Equal(0.8, edited.GeoScale);
    }
}
