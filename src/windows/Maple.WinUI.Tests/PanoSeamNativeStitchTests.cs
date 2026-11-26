using Maple.WinUI.Services.Pano;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests;

/// <summary>Overlapping frames, a plain preview of them, and a region the
/// shared core accepts, prepared once for the runs below (#5992).</summary>
public sealed class PanoSeamFrames : IAsyncLifetime
{
    private static readonly TimeSpan Limit = TimeSpan.FromMinutes(10);

    public string Root { get; } = Path.Combine(Path.GetTempPath(), "maple-pano-seam-stitch-" + Guid.NewGuid().ToString("N"));

    public PanoCliHost Host { get; private set; } = null!;

    public IReadOnlyList<string> Listed { get; private set; } = Array.Empty<string>();

    public PanoPreviewRun Plain { get; private set; } = null!;

    public PanoPreviewReport PlainReport { get; private set; } = null!;

    public PanoSeamRequest Honoured { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        Host = PanoNativeTools.Host(Root);
        Listed = await PanoNativeTools.FramesAsync(Path.Combine(Root, "frames"));
        Assert.True(Listed.Count >= 2, $"there are not two or more overlapping frames: {Root}");

        Plain = PanoNativeTools.PreviewRun(Root, "rotation", null, null);
        var first = await PreviewAsync(Plain);
        Assert.True(first.Ok, first.Error);
        PlainReport = first.Report!;
        var centre = new PanoSeamRect(PlainReport.Canvas.Width / 2 - 8, PlainReport.Canvas.Height / 2 - 8, 16, 16);

        // Whichever frame covers the canvas centre can be forced there; the
        // frames before it cannot, and are refused by name.
        foreach (var frame in Enumerable.Range(0, Listed.Count))
        {
            var request = new PanoSeamRequest(PlainReport.Canvas, new[] { new PanoSeamRegion(PanoSeamKind.Include, frame, centre) });
            if ((await PreviewAsync(PanoNativeTools.PreviewRun(Root, "rotation", request, Plain.Files.AlignmentJson))).Ok)
            {
                Honoured = request;
                return;
            }
        }
        throw new InvalidOperationException("no frame could be included at the canvas centre");
    }

    public Task DisposeAsync()
    {
        if (Directory.Exists(Root))
            Directory.Delete(Root, recursive: true);
        return Task.CompletedTask;
    }

    public async Task<PanoPreviewOutcome> PreviewAsync(PanoPreviewRun run, IReadOnlyList<string>? frames = null)
    {
        using var timeout = new CancellationTokenSource(Limit);
        return await PanoCliRuns.PreviewAsync(Host, frames ?? Listed, run, _ => { }, timeout.Token);
    }

    public async Task<PanoStitchOutcome> StitchAsync(string name, string? alignmentIn, IReadOnlyList<string>? frames = null)
    {
        var run = new PanoStitchRun(frames ?? Listed, Path.Combine(Root, $"{name}-master.png"), Path.Combine(Root, $"{name}.png"),
            "keep", "mesh", "rotation", alignmentIn,
            new PanoSeamStitch(Honoured, Path.Combine(Root, $"{name}.seams.json"), Path.Combine(Root, $"{name}.report.json")));
        using var timeout = new CancellationTokenSource(Limit);
        var outcome = await PanoCliRuns.StitchAsync(Host, run, _ => { }, timeout.Token);
        Outputs[name] = run;
        return outcome;
    }

    public Dictionary<string, PanoStitchRun> Outputs { get; } = new();
}

public sealed class PanoSeamNativeStitchTests(PanoSeamFrames frames, ITestOutputHelper output) : IClassFixture<PanoSeamFrames>
{
    [PanoFramesFact]
    public void TheCliListsItsFramesInTheOrderItSortedThem()
    {
        var expected = frames.Listed.OrderBy(path => path, StringComparer.Ordinal).ToList();
        Assert.Equal(expected, frames.PlainReport.Inputs);
        output.WriteLine(string.Join("\n", frames.PlainReport.Inputs!));
    }

    [PanoFramesFact]
    public async Task AConstrainedPreviewEchoesTheRegionsAndReusesTheAlignment()
    {
        var run = PanoNativeTools.PreviewRun(frames.Root, "rotation", frames.Honoured, frames.Plain.Files.AlignmentJson);

        var outcome = await frames.PreviewAsync(run);

        Assert.True(outcome.Ok, outcome.Error);
        Assert.True(frames.Honoured.Matches(outcome.Report!.SeamConstraints));
        Assert.Equal(frames.PlainReport.Canvas, outcome.Report.Canvas);
        Assert.Equal("reused", outcome.Report.AlignmentStatus);
        Assert.True(new FileInfo(run.Files.PreviewPng).Length > 0);
    }

    [PanoFramesFact]
    public async Task AConstrainedStitchFromTheCurrentAlignmentSucceedsAndItsReportSaysReused()
    {
        var outcome = await frames.StitchAsync("fresh", frames.Plain.Files.AlignmentJson);

        Assert.True(outcome.Ok, outcome.Error);
        Assert.Equal("reused", outcome.AlignmentStatus);
        var run = frames.Outputs["fresh"];
        Assert.True(File.Exists(run.OutPath) && File.Exists(run.DisplayPath));
    }

    [PanoFramesFact]
    public async Task AConstrainedStitchAfterAnInputChangedIsRefusedAsStale()
    {
        // Copies, so changing one never disturbs the frames the other runs share.
        var copies = frames.Listed.Select(path =>
        {
            var copy = Path.Combine(frames.Root, "stale-frames", Path.GetFileName(path));
            Directory.CreateDirectory(Path.GetDirectoryName(copy)!);
            File.Copy(path, copy);
            return copy;
        }).ToList();
        var preview = PanoNativeTools.PreviewRun(frames.Root, "rotation", null, null);
        Assert.True((await frames.PreviewAsync(preview, copies)).Ok);

        File.SetLastWriteTimeUtc(copies[0], File.GetLastWriteTimeUtc(copies[0]).AddMinutes(7));
        var outcome = await frames.StitchAsync("stale", preview.Files.AlignmentJson, copies);

        Assert.False(outcome.Ok);
        Assert.Equal("stale", outcome.AlignmentStatus);
        Assert.Equal(PanoSeamAuthoring.StaleGeometry, outcome.Error);
    }
}
