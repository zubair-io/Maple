using System.Collections.Concurrent;
using Maple.WinUI.Services.Pano;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests;

/// <summary>Runs the real maple-cli (#5992): the binary beside the core CI
/// builds (`MAPLE_RAW_FFI_DLL`), or `MAPLE_PANO_CLI` on a machine that names
/// one. With neither set the tests are reported as skipped; a named binary
/// that is missing fails. The refusals need no RAW because the shared core
/// rejects them before decoding. The runs that complete are in
/// <see cref="PanoSeamNativeStitchTests"/>.</summary>
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

    private PanoCliHost Host() => PanoNativeTools.Host(_root);

    private PanoPreviewRun Run(string strategy, PanoSeamRequest? seams) => PanoNativeTools.PreviewRun(_root, strategy, seams, null);

    private async Task<PanoPreviewOutcome> PreviewAsync(PanoCliHost host, IReadOnlyList<string> frames, PanoPreviewRun run)
    {
        using var timeout = new CancellationTokenSource(Limit);
        var outcome = await PanoCliRuns.PreviewAsync(host, frames, run, _lines.Enqueue, timeout.Token);
        output.WriteLine($"preview {run.Options.Strategy}: ok={outcome.Ok} error={outcome.Error}");
        return outcome;
    }

    private static PanoSeamRequest Regions(PanoSeamCanvas canvas, params PanoSeamRegion[] regions) => new(canvas, regions);

    private string[] AbsentFrames() => new[] { Path.Combine(_root, "frame-a.dng"), Path.Combine(_root, "frame-b.dng") };

    [PanoCliFact]
    public async Task TileRefusesAConstrainedPreviewByNameBeforeAnyDecode()
    {
        var host = Host();
        var request = Regions(new PanoSeamCanvas(64, 64), new PanoSeamRegion(PanoSeamKind.Include, 1, Small));
        var run = Run("tile", request);

        var outcome = await PreviewAsync(host, AbsentFrames(), run);

        Assert.False(outcome.Ok);
        Assert.StartsWith("invalid_seam_constraints: ", outcome.Error);
        Assert.Contains("graph-cut", outcome.Error);
        Assert.DoesNotContain("maple-cli exited", outcome.Error);
        Assert.Equal(request.ToJson(), File.ReadAllText(run.Files.SeamConstraintsJson));
        Assert.NotNull(PanoCliReport.Refusal(File.ReadAllText(run.Files.ReportJson)));
        Assert.False(File.Exists(run.Files.PreviewPng));
        Assert.DoesNotContain(_lines, line => line.StartsWith("pano: progress", StringComparison.Ordinal));
    }

    [PanoCliFact]
    public async Task ARegionNamingAFrameThatIsNotThereIsRefusedByName()
    {
        var host = Host();
        var run = Run("rotation", Regions(new PanoSeamCanvas(64, 64), new PanoSeamRegion(PanoSeamKind.Exclude, 2, Small)));

        var outcome = await PreviewAsync(host, AbsentFrames(), run);

        Assert.False(outcome.Ok);
        Assert.StartsWith("invalid_seam_constraints: ", outcome.Error);
        Assert.Contains("frame 2", outcome.Error);
        Assert.False(File.Exists(run.Files.PreviewPng));
    }

    [PanoCliFact]
    public async Task TileRefusesAConstrainedStitchByNameAndWritesNoPanorama()
    {
        var host = Host();
        var request = Regions(new PanoSeamCanvas(64, 64), new PanoSeamRegion(PanoSeamKind.Exclude, 0, Small));
        var stitch = new PanoStitchRun(AbsentFrames(), Path.Combine(_root, "out-master.png"), Path.Combine(_root, "out.png"),
            "keep", "mesh", "tile", null,
            new PanoSeamStitch(request, Path.Combine(_root, "stitch.seams.json"), Path.Combine(_root, "stitch.report.json")));
        using var timeout = new CancellationTokenSource(Limit);

        var outcome = await PanoCliRuns.StitchAsync(host, stitch, _lines.Enqueue, timeout.Token);

        Assert.False(outcome.Ok);
        Assert.StartsWith("invalid_seam_constraints: ", outcome.Error);
        Assert.Contains("graph-cut", outcome.Error);
        Assert.False(File.Exists(stitch.OutPath));
        Assert.False(File.Exists(stitch.DisplayPath));
    }

    [PanoCliFact]
    public async Task AValidRequestPassesTheSharedValidatorAndReachesDecode()
    {
        var host = Host();
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
}
