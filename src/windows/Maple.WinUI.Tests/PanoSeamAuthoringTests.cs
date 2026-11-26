using Maple.WinUI.Services.Pano;
using Xunit;

namespace Maple.WinUI.Tests;

public class PanoSeamAuthoringTests
{
    private static readonly string[] Frames = { @"C:\p\a.dng", @"C:\p\b.dng", @"C:\p\c.dng" };
    private static readonly PanoSeamCanvas Canvas = new(2048, 1024);
    private static readonly PanoPreviewFiles Files = new(@"C:\t\preview-1.png", @"C:\t\alignment-1.json");
    private static readonly PanoSeamRect Rect = new(100, 200, 80, 60);

    private static PanoPreviewCompletion Done(
        PanoSeamRequest? seams = null, string alignment = "solved", PanoSeamCanvas? canvas = null,
        IReadOnlyList<string>? inputs = null) =>
        new(new PanoPreviewRun(new PanoPreviewOptions("keep", "mesh", "auto"), Files, null, seams),
            new PanoPreviewOutcome(true, false, null,
                new PanoPreviewReport(canvas ?? Canvas, "rotation", alignment, inputs ?? Frames, seams)));

    private static PanoPreviewCompletion Failed(PanoSeamRequest? seams, string error) =>
        new(new PanoPreviewRun(new PanoPreviewOptions("keep", "mesh", "auto"), Files, null, seams),
            new PanoPreviewOutcome(false, false, error));

    private static PanoSeamAuthoring WithCurrentPreview(string strategy = "auto")
    {
        var authoring = new PanoSeamAuthoring();
        authoring.GeometryChanged(strategy);
        authoring.PreviewRequested();
        authoring.PreviewCompleted(Done(), isLatest: true);
        return authoring;
    }

    [Fact]
    public void AuthoringIsClosedUntilAPreviewOfTheCurrentGeometryArrives()
    {
        var authoring = new PanoSeamAuthoring();
        Assert.Equal(PanoSeamAuthoring.WaitReason, authoring.DisabledReason);
        Assert.Equal(PanoSeamAuthoring.WaitReason, authoring.Add(PanoSeamKind.Include, 0, Rect));

        authoring.GeometryChanged("auto");
        authoring.PreviewRequested();
        Assert.Equal(PanoSeamAuthoring.WaitReason, authoring.DisabledReason);
        Assert.Null(authoring.Canvas);

        authoring.PreviewCompleted(Done(), isLatest: true);
        Assert.Null(authoring.DisabledReason);
        Assert.Equal(Canvas, authoring.Canvas);
        Assert.Null(authoring.Request);
        Assert.True(authoring.CanSubmit);
    }

    [Fact]
    public void FramesComeFromThePreviewReportAndAreEmptyBeforeOne()
    {
        var authoring = new PanoSeamAuthoring();
        Assert.Empty(authoring.Frames);

        authoring.GeometryChanged("auto");
        authoring.PreviewRequested();
        authoring.PreviewCompleted(Done(inputs: new[] { @"C:\p\z.dng", @"C:\p\y.dng" }), isLatest: true);

        Assert.Equal(new[] { @"C:\p\z.dng", @"C:\p\y.dng" }, authoring.Frames);
        Assert.Null(authoring.Add(PanoSeamKind.Include, 1, Rect));
        Assert.Equal(PanoSeamAuthoring.InvalidRegion, authoring.Add(PanoSeamKind.Include, 2, Rect));
    }

    [Fact]
    public void APreviewThatDoesNotListItsFramesKeepsAuthoringClosedWithThatReason()
    {
        var authoring = new PanoSeamAuthoring();
        authoring.GeometryChanged("auto");
        authoring.PreviewRequested();
        authoring.PreviewCompleted(new PanoPreviewCompletion(
            new PanoPreviewRun(new PanoPreviewOptions("keep", "mesh", "auto"), Files, null),
            new PanoPreviewOutcome(true, false, null,
                new PanoPreviewReport(Canvas, "rotation", "solved", null, null))), isLatest: true);

        Assert.Equal(PanoSeamAuthoring.FramesNotListedReason, authoring.DisabledReason);
        Assert.Equal(PanoSeamAuthoring.FramesNotListedReason, authoring.Add(PanoSeamKind.Include, 0, Rect));
        Assert.False(authoring.CanAuthor);
        Assert.True(authoring.CanSubmit);
    }

    [Fact]
    public void RegionsKeepTheirOrderKindFrameAndTheCanvasTheyWereDrawnOn()
    {
        var authoring = WithCurrentPreview();
        Assert.Null(authoring.Add(PanoSeamKind.Include, 1, Rect));
        Assert.Null(authoring.AddFromText(PanoSeamKind.Exclude, 2, " 700", "300 ", "40", "50"));

        var request = authoring.Request!;
        Assert.Equal(Canvas, request.Canvas);
        Assert.Equal(new[]
        {
            new PanoSeamRegion(PanoSeamKind.Include, 1, Rect),
            new PanoSeamRegion(PanoSeamKind.Exclude, 2, new PanoSeamRect(700, 300, 40, 50)),
        }, request.Regions);
        Assert.True(authoring.CanSubmit);
    }

    [Theory]
    [InlineData("", "0", "1", "1")]
    [InlineData("1.5", "0", "1", "1")]
    [InlineData("-1", "0", "1", "1")]
    [InlineData("ten", "0", "1", "1")]
    [InlineData("0", "0", "1", "99999999999")]
    public void TypedCoordinatesMustBeWholePixels(string x, string y, string width, string height)
    {
        var authoring = WithCurrentPreview();
        Assert.Equal(PanoSeamAuthoring.InvalidNumbers,
            authoring.AddFromText(PanoSeamKind.Include, 0, x, y, width, height));
        Assert.Empty(authoring.Regions);
    }

    [Theory]
    [InlineData(0, 0, 0, 0, 10)]
    [InlineData(0, 2040, 0, 10, 10)]
    [InlineData(0, 0, 1020, 10, 10)]
    [InlineData(3, 0, 0, 10, 10)]
    [InlineData(-1, 0, 0, 10, 10)]
    public void ARegionNeedsAKnownFrameAndARectangleInsideThePreview(int frame, int x, int y, int width, int height)
    {
        var authoring = WithCurrentPreview();
        Assert.Equal(PanoSeamAuthoring.InvalidRegion,
            authoring.Add(PanoSeamKind.Include, frame, new PanoSeamRect(x, y, width, height)));
        Assert.Empty(authoring.Regions);
    }

    [Fact]
    public void RemovingOneKeepsTheRestAndClearingRestoresAnUnconstrainedRequest()
    {
        var authoring = WithCurrentPreview();
        authoring.Add(PanoSeamKind.Include, 0, Rect);
        authoring.Add(PanoSeamKind.Exclude, 1, Rect);
        authoring.Add(PanoSeamKind.Include, 2, Rect);

        authoring.Remove(1);
        Assert.Equal(new[] { 0, 2 }, authoring.Regions.Select(region => region.Frame));
        authoring.Remove(7);
        Assert.Equal(2, authoring.Regions.Count);

        authoring.Clear();
        Assert.Empty(authoring.Regions);
        Assert.Null(authoring.Request);
        Assert.Null(authoring.DisabledReason);
        Assert.Equal(Canvas, authoring.Canvas);
    }

    [Fact]
    public void ChangingAnOptionDropsTheRegionsAndClosesAuthoringUntilTheNewPreview()
    {
        var authoring = WithCurrentPreview();
        authoring.Add(PanoSeamKind.Include, 0, Rect);

        authoring.GeometryChanged("rotation");
        Assert.Empty(authoring.Regions);
        Assert.Null(authoring.Canvas);
        Assert.Equal(PanoSeamAuthoring.WaitReason, authoring.DisabledReason);
        Assert.True(authoring.CanSubmit);

        authoring.PreviewRequested();
        authoring.PreviewCompleted(Done(canvas: new PanoSeamCanvas(1800, 900)), isLatest: true);
        Assert.Equal(new PanoSeamCanvas(1800, 900), authoring.Canvas);
        Assert.Null(authoring.DisabledReason);
    }

    [Fact]
    public void TileRefusesAuthoringEvenWithAPreview()
    {
        var authoring = WithCurrentPreview("tile");
        Assert.Equal(PanoSeamAuthoring.TileReason, authoring.DisabledReason);
        Assert.Equal(PanoSeamAuthoring.TileReason, authoring.Add(PanoSeamKind.Include, 0, Rect));
        Assert.Empty(authoring.Regions);
    }

    [Fact]
    public void APendingConstrainedPreviewBlocksEditsAndTheStitchButKeepsTheRegions()
    {
        var authoring = WithCurrentPreview();
        authoring.Add(PanoSeamKind.Include, 0, Rect);
        var request = authoring.Request!;

        authoring.PreviewRequested();
        Assert.Equal(PanoSeamAuthoring.WaitReason, authoring.DisabledReason);
        Assert.False(authoring.CanSubmit);
        Assert.Equal(Canvas, authoring.Canvas);
        Assert.Single(authoring.Regions);

        var verdict = authoring.PreviewCompleted(Done(request, "reused"), isLatest: true);
        Assert.Equal(new PanoSeamVerdict(null, false), verdict);
        Assert.Null(authoring.DisabledReason);
        Assert.True(authoring.CanSubmit);
        Assert.True(request.Matches(authoring.Request));
    }

    [Fact]
    public void AFailedConstrainedPreviewShowsItsRefusalAndLeavesTheRegionsEditable()
    {
        var authoring = WithCurrentPreview();
        authoring.Add(PanoSeamKind.Exclude, 0, Rect);
        var refusal = "invalid_seam_constraints: ForceExclude regions leave no frame to show near canvas pixel (3, 4)";

        authoring.PreviewRequested();
        var verdict = authoring.PreviewCompleted(Failed(authoring.Request, refusal), isLatest: true);

        Assert.Equal(new PanoSeamVerdict(refusal, false), verdict);
        Assert.Single(authoring.Regions);
        Assert.Null(authoring.DisabledReason);
        authoring.Remove(0);
        Assert.Null(authoring.Request);
    }

    [Fact]
    public void AFailedGeometryPreviewKeepsAuthoringClosedAndSaysNothingAboutRegions()
    {
        var authoring = new PanoSeamAuthoring();
        authoring.GeometryChanged("auto");
        authoring.PreviewRequested();

        var verdict = authoring.PreviewCompleted(Failed(null, "maple-cli exited 1:\nerror: no overlap"), isLatest: true);

        Assert.Equal(new PanoSeamVerdict(null, false), verdict);
        Assert.Equal(PanoSeamAuthoring.WaitReason, authoring.DisabledReason);
    }

    [Theory]
    [InlineData("stale", 2048, 1024)]
    [InlineData("reused", 2000, 1024)]
    public void AConstrainedPreviewOnAnotherGeometryDropsTheRegionsByName(string alignment, int width, int height)
    {
        var authoring = WithCurrentPreview();
        authoring.Add(PanoSeamKind.Include, 0, Rect);
        var request = authoring.Request!;

        authoring.PreviewRequested();
        var verdict = authoring.PreviewCompleted(
            Done(request, alignment, new PanoSeamCanvas(width, height)), isLatest: true);

        Assert.Equal(new PanoSeamVerdict(PanoSeamAuthoring.StaleGeometry, true), verdict);
        Assert.StartsWith("invalid_seam_constraints", verdict.Message);
        Assert.Empty(authoring.Regions);
        Assert.Null(authoring.Request);
        Assert.Equal(PanoSeamAuthoring.WaitReason, authoring.DisabledReason);
    }

    [Fact]
    public void AnUnconstrainedPreviewThatReSolvedIsSimplyTheNewGeometry()
    {
        var authoring = new PanoSeamAuthoring();
        authoring.GeometryChanged("auto");
        authoring.PreviewRequested();

        var verdict = authoring.PreviewCompleted(Done(alignment: "stale"), isLatest: true);

        Assert.Equal(new PanoSeamVerdict(null, false), verdict);
        Assert.Null(authoring.DisabledReason);
    }

    [Fact]
    public void AResultOvertakenByANewerRequestNeverBecomesCurrent()
    {
        var authoring = new PanoSeamAuthoring();
        authoring.GeometryChanged("auto");
        authoring.PreviewRequested();
        authoring.GeometryChanged("rotation");
        authoring.PreviewRequested();

        var verdict = authoring.PreviewCompleted(Done(), isLatest: false);

        Assert.Equal(new PanoSeamVerdict(null, false), verdict);
        Assert.Null(authoring.Canvas);
        Assert.Equal(PanoSeamAuthoring.WaitReason, authoring.DisabledReason);
    }

    [Fact]
    public void EveryStateChangeIsAnnounced()
    {
        var authoring = new PanoSeamAuthoring();
        var changes = 0;
        authoring.Changed += () => changes++;

        authoring.GeometryChanged("auto");
        authoring.PreviewRequested();
        authoring.PreviewCompleted(Done(), isLatest: true);
        authoring.Add(PanoSeamKind.Include, 0, Rect);
        authoring.Remove(0);
        authoring.Clear();
        authoring.PreviewCompleted(Done(), isLatest: false);
        authoring.Add(PanoSeamKind.Include, 9, Rect);

        Assert.Equal(6, changes);
    }

}

public class PanoSeamTextTests
{
    [Fact]
    public void FramesAreNumberedInIndexOrderByFileNameWithinOneFolder() =>
        Assert.Equal(new[] { "1: IMG_2.DNG", "2: img_1.dng" },
            PanoSeamText.FrameLabels(new[] { @"C:\p\IMG_2.DNG", @"C:\p\img_1.dng" }));

    [Fact]
    public void FramesFromSeveralFoldersShowTheirWholePath() =>
        Assert.Equal(new[] { @"1: C:\p\a\z.dng", @"2: C:\p\b\z.dng" },
            PanoSeamText.FrameLabels(new[] { @"C:\p\a\z.dng", @"C:\p\b\z.dng" }));

    [Fact]
    public void ARegionReadsAsItsNumberKindFrameAndBounds()
    {
        var include = new PanoSeamRegion(PanoSeamKind.Include, 1, new PanoSeamRect(100, 200, 80, 60));
        var exclude = include with { Kind = PanoSeamKind.Exclude, Frame = 0 };
        Assert.Equal("1. Include frame 2: X 100, Y 200, 80 × 60", PanoSeamText.Region(0, include));
        Assert.Equal("2. Exclude frame 1: X 100, Y 200, 80 × 60", PanoSeamText.Region(1, exclude));
        Assert.Equal("1 +", PanoSeamText.Badge(0, include));
        Assert.Equal("2 −", PanoSeamText.Badge(1, exclude));
        Assert.Equal("Remove seam region 2", PanoSeamText.Remove(1));
    }

    [Fact]
    public void TheCountAndCanvasAreSpelledOut()
    {
        Assert.Equal("0 seam regions", PanoSeamText.Count(0));
        Assert.Equal("1 seam region", PanoSeamText.Count(1));
        Assert.Equal("2 seam regions", PanoSeamText.Count(2));
        Assert.Equal("Uncropped panorama seam canvas, 2048 by 1024 pixels",
            PanoSeamText.CanvasName(new PanoSeamCanvas(2048, 1024)));
        Assert.Contains("Reference canvas: 2048 × 1024 preview pixels.", PanoSeamText.Guide(new PanoSeamCanvas(2048, 1024)));
        Assert.DoesNotContain("Reference canvas", PanoSeamText.Guide(null));
    }
}
