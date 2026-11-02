using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public class RepairCanvasMapTests
{
    [Fact]
    public void PerspectiveUsesCoreOrderAndAspectCorrectRotation()
    {
        // Horizontal keystone at +100: x=.5 centred projects to .4,
        // so the uncentred .75 point lands at .7.
        var map = new RepairCanvasMap(2, new() { PerspectiveHorizontal = 100 });
        Assert.Equal(.7, map.ToDisplay(new(.75, .5))!.Value.X, 10);
        // On a 2:1 image a quarter-width displacement rotated 90 degrees
        // becomes a half-height displacement, not a quarter-height one.
        map = new(2, new() { PerspectiveRotate = 90 });
        var rotated = map.ToDisplay(new(.75, .5))!.Value;
        Assert.Equal(.5, rotated.X, 10);
        Assert.Equal(1, rotated.Y, 10);
        map = new(2, new() { PerspectiveScale = 200, PerspectiveX = 20 });
        Assert.Equal(1.1, map.ToDisplay(new(.75, .5))!.Value.X, 10);
    }

    [Fact]
    public void ComposedTransformRoundTripsAcrossAspectRatios()
    {
        var model = new AdjustmentState { PerspectiveHorizontal = 31, PerspectiveVertical = -44,
            PerspectiveRotate = 17, PerspectiveScale = 115, PerspectiveAspect = 23, PerspectiveX = -12, PerspectiveY = 8 };
        foreach (var aspect in new[] { 1d, 1.5, 2d / 3 })
        foreach (var x in new[] { .01, .2, .5, .85, .99 })
        foreach (var y in new[] { .01, .3, .5, .75, .99 })
        {
            var map = new RepairCanvasMap(aspect, model);
            var result = map.ToFrame(map.ToDisplay(new(x, y))!.Value)!.Value;
            Assert.Equal(x, result.X, 9);
            Assert.Equal(y, result.Y, 9);
            Assert.Equal(aspect, map.FrameAspect, 9);
        }
    }

    [Fact]
    public void InvalidMappingDoesNotProduceEditableCoordinates()
    {
        var map = new RepairCanvasMap(1.5, new() { PerspectiveScale = 0 });
        Assert.Null(map.ToFrame(new(.5, .5)));
        Assert.Null(map.ToDisplay(new(.5, .5)));
        map = new(1, new() { PerspectiveHorizontal = 100, PerspectiveVertical = 100 });
        Assert.Null(map.ToDisplay(new(0, 0)));
        Assert.Throws<ArgumentOutOfRangeException>(() => new RepairCanvasMap(0, new()));
    }
}
