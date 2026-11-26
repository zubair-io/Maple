using System.Collections.Concurrent;
using Maple.WinUI.Services.Pano;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests;

/// <summary>Runs the real maple-cli (#5992). It is the binary beside the
/// core CI builds (`MAPLE_RAW_FFI_DLL`), or `MAPLE_PANO_CLI` on a machine
/// that names one; with neither set the tests skip-pass, and a named binary
/// that is missing fails. The refusals need no RAW because the shared core
/// rejects them before decoding. A constrained preview that completes needs
/// overlapping frames, named by `MAPLE_PANO_TEST_RAWS`.</summary>
public sealed class PanoSeamNativeTests(ITestOutputHelper output) : IDisposable
{
    private static readonly TimeSpan Limit = TimeSpan.FromMinutes(10);
    private static readonly PanoSeamRect Small = new(16, 16, 16, 16);

    private readonly string _root = Path.Combine(Path.GetTempPath(), "maple-pano-seam-native-" + Guid.NewGuid().ToString("N"));
    private readonly ConcurrentQueue<string> _lines = new();

    public void Dispose()
    {
        if (Directory.Exists(_root))
            Directory.Delete(_root, recursive: true);
    }

    private PanoCliHost? Host()
    {
        var named = Environment.GetEnvironmentVariable("MAPLE_PANO_CLI");
        var core = Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL");
        var cli = !string.IsNullOrEmpty(named) ? named
            : !string.IsNullOrEmpty(core) ? Path.Combine(Path.GetDirectoryName(core)!, "maple-cli.exe")
            : null;
        if (cli is null)
        {
            output.WriteLine("SKIP-PASS: neither MAPLE_PANO_CLI nor MAPLE_RAW_FFI_DLL is set; maple-cli was not run.");
            return null;
        }
        Assert.True(File.Exists(cli), $"maple-cli is missing: {cli} (build it with --features pano,pano-classical)");
        Directory.CreateDirectory(_root);
        return new PanoCliHost(cli, PanoFeatureEngine.Classical, _root, _root);
    }

    private PanoPreviewRun Run(string strategy, PanoSeamRequest? seams, string? alignmentIn = null)
    {
        var id = Guid.NewGuid().ToString("N");
        var files = new PanoPreviewFiles(Path.Combine(_root, $"preview-{id}.png"), Path.Combine(_root, $"alignment-{id}.json"));
        return new PanoPreviewRun(new PanoPreviewOptions("keep", "mesh", strategy), files, alignmentIn, seams);
    }

    private async Task<PanoPreviewOutcome> PreviewAsync(PanoCliHost host, IReadOnlyList<string> frames, PanoPreviewRun run)
    {
        using var timeout = new CancellationTokenSource(Limit);
        var outcome = await PanoCliRuns.PreviewAsync(host, frames, run, _lines.Enqueue, timeout.Token);
        output.WriteLine($"preview {run.Options.Strategy}: ok={outcome.Ok} error={outcome.Error}");
        return outcome;
    }

    private static PanoSeamRequest Regions(PanoSeamCanvas canvas, params PanoSeamRegion[] regions) => new(canvas, regions);

    private string[] AbsentFrames() => new[] { Path.Combine(_root, "frame-a.dng"), Path.Combine(_root, "frame-b.dng") };

    [Fact]
    public async Task TileRefusesAConstrainedPreviewByNameBeforeAnyDecode()
    {
        if (Host() is not { } host)
            return;
        var request = Regions(new PanoSeamCanvas(64, 64), new PanoSeamRegion(PanoSeamKind.Include, 1, Small));
        var run = Run("tile", request);

        var outcome = await PreviewAsync(host, AbsentFrames(), run);

        Assert.False(outcome.Ok);
        Assert.StartsWith("invalid_seam_constraints: ", outcome.Error);
        Assert.DoesNotContain("maple-cli exited", outcome.Error);
        Assert.Equal(request.ToJson(), File.ReadAllText(run.Files.SeamConstraintsJson));
        Assert.NotNull(PanoCliReport.Refusal(File.ReadAllText(run.Files.ReportJson)));
        Assert.False(File.Exists(run.Files.PreviewPng));
        Assert.DoesNotContain(_lines, line => line.StartsWith("pano: progress", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ARegionNamingAFrameThatIsNotThereIsRefusedByName()
    {
        if (Host() is not { } host)
            return;
        var run = Run("rotation", Regions(new PanoSeamCanvas(64, 64), new PanoSeamRegion(PanoSeamKind.Exclude, 2, Small)));

        var outcome = await PreviewAsync(host, AbsentFrames(), run);

        Assert.False(outcome.Ok);
        Assert.StartsWith("invalid_seam_constraints: ", outcome.Error);
        Assert.False(File.Exists(run.Files.PreviewPng));
    }

    [Fact]
    public async Task TileRefusesAConstrainedStitchByNameAndWritesNoPanorama()
    {
        if (Host() is not { } host)
            return;
        var request = Regions(new PanoSeamCanvas(64, 64), new PanoSeamRegion(PanoSeamKind.Exclude, 0, Small));
        var stitch = new PanoStitchRun(AbsentFrames(), Path.Combine(_root, "out-master.png"), Path.Combine(_root, "out.png"),
            "keep", "mesh", "tile", null,
            new PanoSeamStitch(request, Path.Combine(_root, "stitch.seams.json"), Path.Combine(_root, "stitch.report.json")));
        using var timeout = new CancellationTokenSource(Limit);

        var outcome = await PanoCliRuns.StitchAsync(host, stitch, _lines.Enqueue, timeout.Token);

        Assert.False(outcome.Ok);
        Assert.StartsWith("invalid_seam_constraints: ", outcome.Error);
        Assert.False(File.Exists(stitch.OutPath));
        Assert.False(File.Exists(stitch.DisplayPath));
    }

    [Fact]
    public async Task AValidRequestPassesTheSharedValidatorAndReachesDecode()
    {
        if (Host() is not { } host)
            return;
        var frames = new[] { "frame-a.dng", "frame-b.dng" }.Select(name => Path.Combine(_root, name)).ToArray();
        foreach (var frame in frames)
            File.Copy(Path.Combine(AppContext.BaseDirectory, "Fixtures", "grey-l018-rggb.dng"), frame);
        var request = Regions(new PanoSeamCanvas(64, 64), new PanoSeamRegion(PanoSeamKind.Exclude, 1, Small));

        var outcome = await PreviewAsync(host, frames, Run("rotation", request));

        Assert.Contains(_lines, line => line.StartsWith("pano: progress 0 decode", StringComparison.Ordinal));
        Assert.DoesNotContain("unexpected argument", outcome.Error ?? string.Empty);
        if (outcome.Ok)
            Assert.True(request.Matches(outcome.Report!.SeamConstraints));
        else
            output.WriteLine("Two copies of one flat grey frame cannot be aligned; the request was accepted and the run stopped later.");
    }

    [Fact]
    public async Task AConstrainedPreviewOfRealFramesReusesTheAlignmentAndEchoesTheRegions()
    {
        if (Host() is not { } host)
            return;
        var folder = Environment.GetEnvironmentVariable("MAPLE_PANO_TEST_RAWS");
        if (string.IsNullOrEmpty(folder))
        {
            output.WriteLine("SKIP-PASS: MAPLE_PANO_TEST_RAWS is not set; no constrained preview was composited.");
            return;
        }
        var frames = PanoFrameOrder.Sort(Directory.EnumerateFiles(folder).Where(path =>
            Path.GetExtension(path).ToLowerInvariant() is ".dng" or ".cr2" or ".cr3" or ".nef" or ".arw" or ".raf"));
        Assert.True(frames.Count >= 2, $"MAPLE_PANO_TEST_RAWS needs two or more overlapping RAW frames: {folder}");

        var plain = Run("rotation", null);
        var first = await PreviewAsync(host, frames, plain);
        Assert.True(first.Ok, first.Error);
        Assert.Null(first.Report!.SeamConstraints);
        var canvas = first.Report.Canvas;
        var centre = new PanoSeamRect(canvas.Width / 2 - 8, canvas.Height / 2 - 8, 16, 16);

        // Whichever frame covers the canvas centre can be forced there; the
        // frames before it cannot, and must be refused by name.
        var attempts = new List<(PanoSeamRequest Request, PanoPreviewRun Run, PanoPreviewOutcome Outcome)>();
        foreach (var frame in Enumerable.Range(0, frames.Count))
        {
            var request = Regions(canvas, new PanoSeamRegion(PanoSeamKind.Include, frame, centre));
            var run = Run("rotation", request, plain.Files.AlignmentJson);
            attempts.Add((request, run, await PreviewAsync(host, frames, run)));
            if (attempts[^1].Outcome.Ok)
                break;
        }

        var honoured = attempts[^1];
        Assert.True(honoured.Outcome.Ok, "no frame could be included at the canvas centre");
        Assert.True(honoured.Request.Matches(honoured.Outcome.Report!.SeamConstraints));
        Assert.Equal(canvas, honoured.Outcome.Report.Canvas);
        Assert.Equal("reused", honoured.Outcome.Report.AlignmentStatus);
        Assert.True(new FileInfo(honoured.Run.Files.PreviewPng).Length > 0);
        Assert.All(attempts.SkipLast(1), item =>
            Assert.StartsWith("invalid_seam_constraints: ", item.Outcome.Error));
    }
}
