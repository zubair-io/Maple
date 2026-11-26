using System.Linq;
using System.Text.Json;
using Maple.WinUI.Services.Pano;
using Xunit;

namespace Maple.WinUI.Tests;

public class PanoSeamRequestTests
{
    private static readonly PanoSeamRequest Request = new(
        new PanoSeamCanvas(2048, 1024),
        new[]
        {
            new PanoSeamRegion(PanoSeamKind.Include, 1, new PanoSeamRect(100, 200, 80, 60)),
            new PanoSeamRegion(PanoSeamKind.Exclude, 2, new PanoSeamRect(700, 300, 40, 50)),
        });

    [Fact]
    public void WritesTheVersionedCoreContractExactly() =>
        Assert.Equal(
            "{\"version\":1,\"canvas\":{\"width\":2048,\"height\":1024},\"regions\":["
            + "{\"kind\":\"include\",\"frame\":1,\"x\":100,\"y\":200,\"width\":80,\"height\":60},"
            + "{\"kind\":\"exclude\",\"frame\":2,\"x\":700,\"y\":300,\"width\":40,\"height\":50}]}",
            Request.ToJson());

    [Fact]
    public void WritesOnlyTheFieldsTheCoreAccepts()
    {
        using var document = JsonDocument.Parse(Request.ToJson());
        Assert.Equal(new[] { "version", "canvas", "regions" }, document.RootElement.EnumerateObject().Select(p => p.Name));
        Assert.Equal(new[] { "width", "height" },
            document.RootElement.GetProperty("canvas").EnumerateObject().Select(p => p.Name));
        Assert.All(document.RootElement.GetProperty("regions").EnumerateArray(), region =>
            Assert.Equal(new[] { "kind", "frame", "x", "y", "width", "height" },
                region.EnumerateObject().Select(p => p.Name)));
    }

    [Fact]
    public void AReportEchoReadsBackAsTheSameRequest()
    {
        using var document = JsonDocument.Parse(Request.ToJson());
        var echo = PanoSeamRequest.Parse(document.RootElement);
        Assert.True(Request.Matches(echo));
        Assert.Equal(Request.ToJson(), echo!.ToJson());
    }

    [Theory]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("{\"version\":2,\"canvas\":{\"width\":8,\"height\":8},\"regions\":[]}")]
    [InlineData("{\"version\":1,\"canvas\":{\"width\":8},\"regions\":[]}")]
    [InlineData("{\"version\":1,\"canvas\":{\"width\":8,\"height\":8},\"regions\":[{\"kind\":\"paint\",\"frame\":0,\"x\":0,\"y\":0,\"width\":1,\"height\":1}]}")]
    [InlineData("{\"version\":1,\"canvas\":{\"width\":8,\"height\":8},\"regions\":[{\"kind\":\"include\",\"frame\":0.5,\"x\":0,\"y\":0,\"width\":1,\"height\":1}]}")]
    public void AnEchoOfAnotherShapeIsNotARequest(string json)
    {
        using var document = JsonDocument.Parse(json);
        Assert.Null(PanoSeamRequest.Parse(document.RootElement));
    }

    [Fact]
    public void ADifferentCanvasKindFrameOrRectangleDoesNotMatch()
    {
        PanoSeamRequest With(PanoSeamRegion first) => new(Request.Canvas, new[] { first, Request.Regions[1] });
        var first = Request.Regions[0];
        Assert.False(Request.Matches(null));
        Assert.False(Request.Matches(new PanoSeamRequest(new PanoSeamCanvas(2048, 1023), Request.Regions)));
        Assert.False(Request.Matches(With(first with { Kind = PanoSeamKind.Exclude })));
        Assert.False(Request.Matches(With(first with { Frame = 0 })));
        Assert.False(Request.Matches(With(first with { Rect = first.Rect with { Width = 81 } })));
        Assert.False(Request.Matches(new PanoSeamRequest(Request.Canvas, Request.Regions.Take(1).ToList())));
        Assert.False(Request.Matches(new PanoSeamRequest(Request.Canvas, Request.Regions.Reverse().ToList())));
        Assert.True(Request.Matches(With(first with { })));
    }
}

public class PanoFrameOrderTests
{
    [Fact]
    public void UppercaseNamesComeFirstAsInTheCliSort() =>
        Assert.Equal(
            new[] { @"C:\p\IMG_2.DNG", @"C:\p\Zed.dng", @"C:\p\img_1.dng" },
            PanoFrameOrder.Sort(new[] { @"C:\p\img_1.dng", @"C:\p\Zed.dng", @"C:\p\IMG_2.DNG" }));

    [Fact]
    public void FoldersCompareComponentByComponent() =>
        Assert.Equal(
            new[] { @"C:\p\a\z.dng", @"C:\p\a-b\c.dng", @"C:\p\a.dng" },
            PanoFrameOrder.Sort(new[] { @"C:\p\a.dng", @"C:\p\a-b\c.dng", @"C:\p\a\z.dng" }));

    [Fact]
    public void AShorterPathPrecedesTheOnesInsideIt() =>
        Assert.Equal(
            new[] { @"C:\p\a.dng", @"C:\p\a.dng\b.dng" },
            PanoFrameOrder.Sort(new[] { @"C:\p\a.dng\b.dng", @"C:\p\a.dng" }));

    [Fact]
    public void DriveLettersIgnoreCaseAndSharesPrecedeDrives() =>
        Assert.Equal(
            new[] { @"\\nas\photos\b.dng", @"c:\p\a.dng", @"D:\p\a.dng" },
            PanoFrameOrder.Sort(new[] { @"D:\p\a.dng", @"c:\p\a.dng", @"\\nas\photos\b.dng" }));

    [Fact]
    public void NamesCompareAsUtf8BytesNotUtf16Units() =>
        Assert.Equal(
            new[] { "C:\\p\\\uFF21.dng", "C:\\p\\\U0001F600.dng" },
            PanoFrameOrder.Sort(new[] { "C:\\p\\\U0001F600.dng", "C:\\p\\\uFF21.dng" }));

    [Fact]
    public void EitherSeparatorSplitsComponents() =>
        Assert.Equal(
            new[] { "C:/p/a/z.dng", @"C:\p\a-b\c.dng" },
            PanoFrameOrder.Sort(new[] { @"C:\p\a-b\c.dng", "C:/p/a/z.dng" }));
}

public class PanoSeamGeometryTests
{
    private static readonly PanoSeamCanvas Canvas = new(2048, 1024);

    [Theory]
    [InlineData(0, 0, 2048, 1024, true)]
    [InlineData(2047, 1023, 1, 1, true)]
    [InlineData(0, 0, 2049, 1, false)]
    [InlineData(2048, 0, 1, 1, false)]
    [InlineData(-1, 0, 4, 4, false)]
    [InlineData(0, 0, 0, 4, false)]
    [InlineData(0, 0, 4, 0, false)]
    [InlineData(int.MaxValue, 0, int.MaxValue, 1, false)]
    public void ARectangleMustLieWhollyInsideTheCanvas(int x, int y, int width, int height, bool inside) =>
        Assert.Equal(inside, PanoSeamGeometry.Contains(Canvas, new PanoSeamRect(x, y, width, height)));

    [Fact]
    public void TheCanvasFitsItsBoxKeepingItsShape()
    {
        Assert.Equal((400.0, 200.0), PanoSeamGeometry.Fit(Canvas, 460, 200));
        Assert.Equal((100.0, 200.0), PanoSeamGeometry.Fit(new PanoSeamCanvas(512, 1024), 460, 200));
        Assert.Equal((0.0, 0.0), PanoSeamGeometry.Fit(Canvas, 0, 200));
        Assert.Equal((0.0, 0.0), PanoSeamGeometry.Fit(new PanoSeamCanvas(0, 0), 460, 200));
    }

    [Fact]
    public void APointerPositionScalesToReferencePixelsAndClampsToTheCanvas()
    {
        Assert.Equal((1024.0, 512.0), PanoSeamGeometry.ToCanvas(200, 100, 400, 200, Canvas));
        Assert.Equal((0.0, 1024.0), PanoSeamGeometry.ToCanvas(-30, 900, 400, 200, Canvas));
        Assert.Null(PanoSeamGeometry.ToCanvas(10, 10, 0, 200, Canvas));
    }

    [Fact]
    public void ADragCoversWholePixelsInEitherDirection()
    {
        var expected = new PanoSeamRect(10, 20, 31, 21);
        Assert.Equal(expected, PanoSeamGeometry.DragRect((10.4, 20.9), (40.2, 40.1), Canvas));
        Assert.Equal(expected, PanoSeamGeometry.DragRect((40.2, 40.1), (10.4, 20.9), Canvas));
    }

    [Fact]
    public void ADragWithNoAreaDrawsNothing()
    {
        Assert.Null(PanoSeamGeometry.DragRect((10, 20), (10, 90), Canvas));
        Assert.Null(PanoSeamGeometry.DragRect((10, 20), (90, 20), Canvas));
    }

    [Fact]
    public void ARegionIsDrawnWhereItSitsOnThePreview() =>
        Assert.Equal((100.0, 50.0, 20.0, 10.0),
            PanoSeamGeometry.OnSurface(new PanoSeamRect(512, 256, 102, 51), Canvas, 400, 200) switch
            {
                var (x, y, width, height) => (x, y, System.Math.Round(width), System.Math.Round(height)),
            });
}
