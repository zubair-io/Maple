using System;
using System.Collections.Concurrent;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.Pano;
using Xunit;

namespace Maple.WinUI.Tests;

public class PanoProgressLineTests
{
    [Fact]
    public void ParsesTheCliProgressLine()
    {
        var progress = PanoProgressLine.TryParse("pano: progress 2 match_graph 0%");
        Assert.Equal(new PanoStageProgress(2, "match_graph", 0), progress);
        Assert.False(progress!.HasPartialFraction);
        Assert.Equal("Matching frames — step 3 of 6", progress.Description);
    }

    [Fact]
    public void AMidStagePercentIsAPartialFraction() =>
        Assert.True(PanoProgressLine.TryParse("pano: progress 0 decode 42%")!.HasPartialFraction);

    [Theory]
    [InlineData("pano: alignment — reused")]
    [InlineData("pano: progress two decode 5%")]
    [InlineData("pano: progress 1 features 5")]
    [InlineData("{")]
    public void OtherLinesAreNotProgress(string line) => Assert.Null(PanoProgressLine.TryParse(line));

    [Fact]
    public void DescribeKeepsNonProgressLinesVerbatim()
    {
        Assert.Equal("pano: wrote x.png", PanoProgressLine.Describe("pano: wrote x.png"));
        Assert.Equal("Blending — step 6 of 6", PanoProgressLine.Describe("pano: progress 5 composite 100%"));
    }

    [Theory]
    [InlineData("pano: alignment — solved", "solved")]
    [InlineData("pano: alignment — reused", "reused")]
    [InlineData("pano: alignment — stale (geometry options changed: strategy auto → tile); matching re-ran", "stale")]
    [InlineData("pano: progress 2 match_graph 0%", null)]
    public void ReadsTheAlignmentVerdict(string line, string? status) =>
        Assert.Equal(status, PanoProgressLine.AlignmentStatus(line));
}

public class PanoPreviewCommandTests
{
    private static readonly PanoPreviewFiles Files = new(@"C:\t\preview-1.png", @"C:\t\alignment-1.json");
    private static readonly PanoPreviewOptions Options = new("keep", "mesh", "auto");

    private static string ValueOf(System.Collections.Generic.IReadOnlyList<string> args, string flag) =>
        args[args.ToList().IndexOf(flag) + 1];

    [Fact]
    public void FirstPreviewWritesImageAndAlignmentWithoutOfferingOne()
    {
        var args = PanoPreviewCommand.Build(new[] { @"C:\p\a.dng", @"C:\p\b.dng" }, Files, null, Options, PanoFeatureEngine.Classical, @"C:\m", @"C:\o").Arguments;
        Assert.Equal(new[] { "pano", "stitch" }, args.Take(2));
        Assert.Equal(Files.PreviewPng, ValueOf(args, "--preview-out"));
        Assert.Equal(Files.AlignmentJson, ValueOf(args, "--alignment-out"));
        Assert.DoesNotContain("--alignment-in", args);
        Assert.DoesNotContain("--out", args);
        Assert.DoesNotContain("--display", args);
        Assert.Equal("classical", ValueOf(args, "--features-engine"));
        Assert.DoesNotContain("--models-dir", args);
    }

    [Fact]
    public void RePreviewOffersThePreviousAlignment()
    {
        var args = PanoPreviewCommand.Build(new[] { @"C:\p\a.dng" }, Files, @"C:\t\alignment-0.json",
            new PanoPreviewOptions("strict", "off", "tile"), PanoFeatureEngine.Ml, @"C:\m", @"C:\o").Arguments;
        Assert.Equal(@"C:\t\alignment-0.json", ValueOf(args, "--alignment-in"));
        Assert.Equal("strict", ValueOf(args, "--retention"));
        Assert.Equal("off", ValueOf(args, "--local-align"));
        Assert.Equal("tile", ValueOf(args, "--strategy"));
        Assert.Equal("ml", ValueOf(args, "--features-engine"));
        Assert.Equal(@"C:\m", ValueOf(args, "--models-dir"));
    }

    [Fact]
    public void FramePathsFollowTheOptionTerminator()
    {
        var args = PanoPreviewCommand.Build(new[] { @"C:\p\a.dng", "--strategy" }, Files, "x.json", Options, PanoFeatureEngine.Classical, @"C:\m", @"C:\o").Arguments;
        Assert.Equal(new[] { "--", @"C:\p\a.dng", "--strategy" }, args.TakeLast(3));
        Assert.Equal(1, args.Count(a => a == "--"));
    }

    [Fact]
    public void AlignmentInIsEmptyWithoutAFile()
    {
        Assert.Empty(PanoPreviewCommand.AlignmentIn(null));
        Assert.Equal(new[] { "--alignment-in", "a.json" }, PanoPreviewCommand.AlignmentIn("a.json"));
    }
}

public sealed class PanoScratchTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "maple-pano-scratch-test-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_root))
            Directory.Delete(_root, recursive: true);
    }

    [Fact]
    public void PreviewFilesAreUniqueAndInsideTheSessionFolder()
    {
        using var scratch = PanoScratch.Create(_root, DateTime.UtcNow);
        var first = scratch.NextPreview();
        var second = scratch.NextPreview();
        Assert.True(Directory.Exists(scratch.Directory));
        Assert.Equal(_root, Path.GetDirectoryName(scratch.Directory));
        Assert.All(new[] { first.PreviewPng, first.AlignmentJson, second.PreviewPng, second.AlignmentJson },
            path => Assert.Equal(scratch.Directory, Path.GetDirectoryName(path)));
        Assert.NotEqual(first.AlignmentJson, second.AlignmentJson);
        Assert.NotEqual(first.PreviewPng, second.PreviewPng);
    }

    [Fact]
    public void DisposeRemovesTheSessionFolderAndItsFiles()
    {
        var scratch = PanoScratch.Create(_root, DateTime.UtcNow);
        File.WriteAllText(scratch.NextPreview().AlignmentJson, "{}");
        scratch.Dispose();
        Assert.False(Directory.Exists(scratch.Directory));
    }

    [Fact]
    public void OpeningSweepsFoldersACrashedSessionLeftBehind()
    {
        var now = DateTime.UtcNow;
        var abandoned = Directory.CreateDirectory(Path.Combine(_root, "abandoned")).FullName;
        File.WriteAllText(Path.Combine(abandoned, "preview-1.png"), "x");
        Directory.SetLastWriteTimeUtc(abandoned, now - PanoScratch.StaleAfter - TimeSpan.FromHours(1));
        var live = Directory.CreateDirectory(Path.Combine(_root, "live")).FullName;

        using var scratch = PanoScratch.Create(_root, now);

        Assert.False(Directory.Exists(abandoned));
        Assert.True(Directory.Exists(live));
    }
}

public sealed class PanoPreviewSessionTests : IDisposable
{
    private static readonly TimeSpan Debounce = TimeSpan.FromMilliseconds(40);
    private static readonly TimeSpan Wait = TimeSpan.FromSeconds(10);
    private readonly string _root = Path.Combine(Path.GetTempPath(), "maple-pano-session-test-" + Guid.NewGuid().ToString("N"));
    private readonly PanoScratch _scratch;

    public PanoPreviewSessionTests() => _scratch = PanoScratch.Create(_root, DateTime.UtcNow);

    public void Dispose()
    {
        _scratch.Dispose();
        if (Directory.Exists(_root))
            Directory.Delete(_root, recursive: true);
    }

    private static PanoPreviewOptions Strategy(string strategy) => new("keep", "mesh", strategy);

    private static PanoPreviewSession.Runner Succeeding(ConcurrentQueue<PanoPreviewRun> runs) => (run, _) =>
    {
        runs.Enqueue(run);
        return Task.FromResult(new PanoPreviewOutcome(true, false, null));
    };

    [Fact]
    public async Task RapidOptionChangesRunOnlyTheLastOne()
    {
        var runs = new ConcurrentQueue<PanoPreviewRun>();
        var session = new PanoPreviewSession(_scratch, Succeeding(runs), Debounce);
        var succeeded = new TaskCompletionSource<PanoPreviewRun>();
        session.Succeeded += run => succeeded.TrySetResult(run);

        session.Request(Strategy("auto"));
        session.Request(Strategy("rotation"));
        session.Request(Strategy("tile"));
        await succeeded.Task.WaitAsync(Wait);
        await session.StopAsync();

        Assert.Equal("tile", Assert.Single(runs).Options.Strategy);
    }

    [Fact]
    public async Task ANewRequestCancelsTheRunningPreviewBeforeStartingItsOwn()
    {
        var firstStarted = new TaskCompletionSource();
        var firstCancelled = new TaskCompletionSource();
        var secondStarted = new TaskCompletionSource<PanoPreviewRun>();
        var calls = 0;
        PanoPreviewSession.Runner runner = async (run, ct) =>
        {
            if (Interlocked.Increment(ref calls) > 1)
            {
                Assert.True(firstCancelled.Task.IsCompleted);
                secondStarted.TrySetResult(run);
                return new PanoPreviewOutcome(true, false, null);
            }
            firstStarted.SetResult();
            await Task.Delay(Timeout.Infinite, ct).ContinueWith(_ => { });
            firstCancelled.SetResult();
            return new PanoPreviewOutcome(false, true, null);
        };
        var session = new PanoPreviewSession(_scratch, runner, Debounce);

        session.Request(Strategy("auto"));
        await firstStarted.Task.WaitAsync(Wait);
        session.Request(Strategy("tile"));
        var second = await secondStarted.Task.WaitAsync(Wait);

        Assert.Equal("tile", second.Options.Strategy);
        Assert.Null(second.AlignmentIn);
    }

    [Fact]
    public async Task ASuccessfulPreviewsAlignmentIsOfferedToTheNextAndToTheStitch()
    {
        var runs = new ConcurrentQueue<PanoPreviewRun>();
        var session = new PanoPreviewSession(_scratch, Succeeding(runs), Debounce);
        var succeeded = new ConcurrentQueue<TaskCompletionSource<PanoPreviewRun>>(
            new[] { new TaskCompletionSource<PanoPreviewRun>(), new TaskCompletionSource<PanoPreviewRun>() });
        session.Succeeded += run =>
        {
            if (succeeded.TryDequeue(out var next))
                next.SetResult(run);
        };
        var firstDone = succeeded.First().Task;
        var secondDone = succeeded.Last().Task;

        session.Request(Strategy("auto"));
        var first = await firstDone.WaitAsync(Wait);
        Assert.Equal(first.Files.AlignmentJson, session.LatestAlignment);

        session.Request(new PanoPreviewOptions("keep", "off", "auto"));
        var second = await secondDone.WaitAsync(Wait);
        await session.StopAsync();

        Assert.Equal(first.Files.AlignmentJson, second.AlignmentIn);
        Assert.Equal(second.Files.AlignmentJson, session.LatestAlignment);
    }

    [Fact]
    public async Task AFailedPreviewReportsAndKeepsThePreviousAlignment()
    {
        var calls = 0;
        PanoPreviewSession.Runner runner = (_, _) => Interlocked.Increment(ref calls) == 1
            ? Task.FromResult(new PanoPreviewOutcome(true, false, null))
            : throw new System.ComponentModel.Win32Exception("maple-cli.exe could not start");
        var session = new PanoPreviewSession(_scratch, runner, Debounce);
        var succeeded = new TaskCompletionSource<PanoPreviewRun>();
        var failed = new TaskCompletionSource<string>();
        session.Succeeded += run => succeeded.TrySetResult(run);
        session.Failed += error => failed.TrySetResult(error);

        session.Request(Strategy("auto"));
        var first = await succeeded.Task.WaitAsync(Wait);
        session.Request(Strategy("tile"));

        Assert.Contains("could not start", await failed.Task.WaitAsync(Wait));
        Assert.Equal(first.Files.AlignmentJson, session.LatestAlignment);
    }

    [Fact]
    public async Task StopWaitsForTheRunningPreviewToEndAndReportsNothing()
    {
        var started = new TaskCompletionSource();
        var ended = false;
        PanoPreviewSession.Runner runner = async (_, ct) =>
        {
            started.SetResult();
            await Task.Delay(Timeout.Infinite, ct).ContinueWith(_ => { });
            ended = true;
            return new PanoPreviewOutcome(false, true, null);
        };
        var session = new PanoPreviewSession(_scratch, runner, Debounce);
        var reported = false;
        session.Succeeded += _ => reported = true;
        session.Failed += _ => reported = true;

        session.Request(Strategy("auto"));
        await started.Task.WaitAsync(Wait);
        await session.StopAsync().WaitAsync(Wait);

        Assert.True(ended);
        Assert.False(reported);
        Assert.Null(session.LatestAlignment);
    }
}
