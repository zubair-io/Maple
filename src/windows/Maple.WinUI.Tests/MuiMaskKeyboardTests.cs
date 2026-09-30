using System;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests;

public class MuiMaskKeyboardTests
{
    [Fact]
    public void LinearBodyStepTranslatesBothEndpointsByDisplayDistance()
    {
        var shape = new MuiLinearMaskShape(new(.2, .3), new(.7, .8));
        var next = Assert.IsType<MuiLinearMaskShape>(MuiMaskOverlayMath.ApplyKeyboardStep(
            shape, MuiMaskHandle.LinearBody, 10, -1, 1000, 500));
        Assert.Equal(.21, next.Start.X, 12);
        Assert.Equal(.298, next.Start.Y, 12);
        Assert.Equal(.71, next.End.X, 12);
        Assert.Equal(.798, next.End.Y, 12);
    }

    [Fact]
    public void RotatedRadiusStepPreservesCenterAndOtherAxis()
    {
        var shape = new MuiRadialMaskShape(new(.5, .5), new(.2, .3), Math.PI / 2);
        var next = Assert.IsType<MuiRadialMaskShape>(MuiMaskOverlayMath.ApplyKeyboardStep(
            shape, MuiMaskHandle.RadialRadiusX, 0, 10, 1000, 500));
        Assert.Equal(.22, next.Radii.X, 12);
        Assert.Equal(shape.Radii.Y, next.Radii.Y);
        Assert.Equal(shape.Center, next.Center);
        Assert.Equal(shape.Angle, next.Angle);
    }

    [Theory]
    [InlineData(1, 0, 1)]
    [InlineData(0, -1, 1)]
    [InlineData(-10, 0, -10)]
    public void RotationStepsUseDegrees(double dx, double dy, double degrees)
    {
        var shape = new MuiRadialMaskShape(new(.5, .5), new(.2, .3), .4);
        var next = Assert.IsType<MuiRadialMaskShape>(MuiMaskOverlayMath.ApplyKeyboardStep(
            shape, MuiMaskHandle.RadialRotate, dx, dy, 1000, 500));
        Assert.Equal(.4 + degrees * Math.PI / 180, next.Angle, 12);
        Assert.Equal(shape.Center, next.Center);
        Assert.Equal(shape.Radii, next.Radii);
    }

    [Fact]
    public void UnmeasuredCanvasCannotMutateMask()
    {
        var shape = new MuiLinearMaskShape(new(.2, .3), new(.7, .8));
        Assert.Equal(shape, MuiMaskOverlayMath.ApplyKeyboardStep(
            shape, MuiMaskHandle.LinearStart, 10, 0, 0, 500));
    }
}
