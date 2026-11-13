using System;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public class FlatToneCurvesCacheTests
{
    [Fact]
    public void WarmMarshallingDoesNotAllocateAndEditedCurvesKeepOtherBuffers()
    {
        var model = new AdjustmentState();
        model.ColorCurveHueVsHue.Add(new CurvePoint(0.2, 0.3));
        model.ColorCurveHueVsSat.Add(new CurvePoint(0.3, 0.4));
        var first = FlatToneCurves.From(model);
        for (var i = 0; i < 100; i++) FlatToneCurves.From(model);
        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < 100; i++) FlatToneCurves.From(model);
        Assert.Equal(0, GC.GetAllocatedBytesForCurrentThread() - before);
        Assert.Same(first, FlatToneCurves.From(model));
        model.ColorCurveHueVsHue[0] = new CurvePoint(0.2, 0.5);
        var updated = FlatToneCurves.From(model);
        Assert.NotSame(first.ColorCurveHueVsHue, updated.ColorCurveHueVsHue);
        Assert.Same(first.ColorCurveHueVsSat, updated.ColorCurveHueVsSat);
        Assert.Equal(0.3f, first.ColorCurveHueVsHue[1]);
        Assert.Equal(0.5f, updated.ColorCurveHueVsHue[1]);
    }
}
