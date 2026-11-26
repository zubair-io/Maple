using System.Collections.Generic;
using System.Linq;
using Maple.WinUI.Services.Pano;
using Xunit;

namespace Maple.WinUI.Tests;

public class PanoSeamCommandTests
{
    private static readonly PanoPreviewFiles Files = new(@"C:\t\preview-3.png", @"C:\t\alignment-3.json");
    private static readonly string[] Inputs = { @"C:\p\a.dng", @"C:\p\b.dng" };
    private static readonly PanoSeamStitch Seams = new(
        new PanoSeamRequest(new PanoSeamCanvas(2048, 1024),
            new[] { new PanoSeamRegion(PanoSeamKind.Include, 1, new PanoSeamRect(10, 10, 20, 20)) }),
        @"C:\t\stitch.seams.json", @"C:\t\stitch.report.json");

    private static string? ValueOf(IReadOnlyList<string> args, string flag)
    {
        var at = args.ToList().IndexOf(flag);
        return at < 0 ? null : args[at + 1];
    }

    private static IReadOnlyList<string> Preview(string strategy, bool constrained, string? alignmentIn = null) =>
        PanoPreviewCommand.Build(Inputs, Files, alignmentIn, new PanoPreviewOptions("keep", "mesh", strategy),
            PanoFeatureEngine.Classical, @"C:\m", @"C:\o", constrained).Arguments;

    private static IReadOnlyList<string> Stitch(string strategy, PanoSeamStitch? seams, string? alignmentIn = null) =>
        PanoStitchCommand.Build(Inputs, @"C:\p\out-master.png", @"C:\t\out.png", "keep", "mesh", strategy,
            alignmentIn, PanoFeatureEngine.Classical, @"C:\m", @"C:\o", seams).Arguments;

    [Fact]
    public void ThePreviewFilesSitBesideThePreviewImage()
    {
        Assert.Equal(@"C:\t\preview-3.report.json", Files.ReportJson);
        Assert.Equal(@"C:\t\preview-3.seams.json", Files.SeamConstraintsJson);
    }

    [Fact]
    public void EveryPreviewAsksForTheReportThatCarriesItsCanvasSize()
    {
        Assert.Equal(Files.ReportJson, ValueOf(Preview("auto", constrained: false), "--report"));
        Assert.Equal(Files.ReportJson, ValueOf(Preview("auto", constrained: true), "--report"));
    }

    [Fact]
    public void AnUnconstrainedPreviewKeepsTheDefaultSeamStrategyAndSendsNoRegions()
    {
        var args = Preview("auto", constrained: false);
        Assert.DoesNotContain("--seam-constraints", args);
        Assert.DoesNotContain("--seam-strategy", args);
    }

    [Theory]
    [InlineData("auto")]
    [InlineData("rotation")]
    [InlineData("tile")]
    public void AConstrainedPreviewSendsTheRegionsWithTheGraphCutSeamStrategy(string strategy)
    {
        var args = Preview(strategy, constrained: true, @"C:\t\alignment-2.json");
        Assert.Equal(Files.SeamConstraintsJson, ValueOf(args, "--seam-constraints"));
        Assert.Equal("graph-cut", ValueOf(args, "--seam-strategy"));
        Assert.Equal(strategy, ValueOf(args, "--strategy"));
        Assert.Equal(@"C:\t\alignment-2.json", ValueOf(args, "--alignment-in"));
        Assert.Equal(new[] { "--", Inputs[0], Inputs[1] }, args.TakeLast(3));
        Assert.True(args.ToList().IndexOf("--seam-constraints") < args.ToList().IndexOf("--"));
    }

    [Theory]
    [InlineData("auto")]
    [InlineData("rotation")]
    [InlineData("tile")]
    public void AConstrainedStitchSendsTheRegionsTheGraphCutStrategyAndAReport(string strategy)
    {
        var args = Stitch(strategy, Seams, @"C:\t\alignment-3.json");
        Assert.Equal(Seams.ConstraintsJson, ValueOf(args, "--seam-constraints"));
        Assert.Equal("graph-cut", ValueOf(args, "--seam-strategy"));
        Assert.Equal(Seams.ReportJson, ValueOf(args, "--report"));
        Assert.Equal(strategy, ValueOf(args, "--strategy"));
        Assert.Equal(@"C:\t\alignment-3.json", ValueOf(args, "--alignment-in"));
        Assert.Equal(new[] { "--", Inputs[0], Inputs[1] }, args.TakeLast(3));
        Assert.True(args.ToList().IndexOf("--seam-constraints") < args.ToList().IndexOf("--"));
    }

    [Fact]
    public void AStitchWithoutRegionsIsTheCommandItAlwaysWas() =>
        Assert.Equal(
            new[]
            {
                "pano", "stitch", "--out", @"C:\p\out-master.png", "--display", @"C:\t\out.png",
                "--retention", "keep", "--local-align", "mesh", "--strategy", "auto",
                "--features-engine", "classical", "--alignment-in", @"C:\t\alignment-3.json",
                "--", Inputs[0], Inputs[1],
            },
            Stitch("auto", null, @"C:\t\alignment-3.json"));

    [Fact]
    public void RegionsNeverTravelWithoutTheGraphCutStrategy()
    {
        Assert.Empty(PanoPreviewCommand.SeamConstraints(null));
        Assert.Equal(new[] { "--seam-strategy", "graph-cut", "--seam-constraints", "r.json" },
            PanoPreviewCommand.SeamConstraints("r.json"));
    }

    [Fact]
    public void TheStitchFilesStayInsideTheDialogScratchFolder()
    {
        var root = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "maple-pano-seam-scratch-" + System.Guid.NewGuid().ToString("N"));
        try
        {
            using var scratch = PanoScratch.Create(root, System.DateTime.UtcNow);
            var stitch = scratch.SeamStitch(Seams.Request);
            Assert.Same(Seams.Request, stitch.Request);
            Assert.Equal(scratch.Directory, System.IO.Path.GetDirectoryName(stitch.ConstraintsJson));
            Assert.Equal(scratch.Directory, System.IO.Path.GetDirectoryName(stitch.ReportJson));
            Assert.EndsWith(".report.json", stitch.ReportJson);
            Assert.NotEqual(stitch.ConstraintsJson, stitch.ReportJson);
            var preview = scratch.NextPreview();
            Assert.Equal(scratch.Directory, System.IO.Path.GetDirectoryName(preview.ReportJson));
            Assert.Equal(scratch.Directory, System.IO.Path.GetDirectoryName(preview.SeamConstraintsJson));
        }
        finally
        {
            if (System.IO.Directory.Exists(root))
                System.IO.Directory.Delete(root, recursive: true);
        }
    }
}
