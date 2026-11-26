using System.Collections.Concurrent;
using Maple.WinUI.Services.Pano;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class PanoCliReportTests : IDisposable
{
    private const string TileRefusal =
        "{\n  \"refused\": {\n    \"message\": \"seam constraints need the graph-cut seam strategy on the rotation path\",\n"
        + "    \"resource\": \"seam_constraints\"\n  }\n}";
    private static readonly PanoSeamRequest Request = new(
        new PanoSeamCanvas(2048, 1024),
        new[] { new PanoSeamRegion(PanoSeamKind.Exclude, 1, new PanoSeamRect(700, 300, 40, 50)) });
    private static readonly PanoCliExit Failed = new(false, 1, "pano: progress 0 decode 0%\nerror: boom");
    private static readonly PanoCliExit Succeeded = new(false, 0, string.Empty);

    private readonly string _root = Path.Combine(Path.GetTempPath(), "maple-pano-report-test-" + Guid.NewGuid().ToString("N"));

    public PanoCliReportTests() => Directory.CreateDirectory(_root);

    public void Dispose() => Directory.Delete(_root, recursive: true);

    private static string PreviewReport(string alignment, string seams) =>
        "{\"mode\":\"preview\",\"frames\":3,\"strategy\":\"rotation\",\"width\":2048,\"height\":1024,"
        + "\"alignment\":{\"status\":\"" + alignment + "\",\"stale_reason\":null},"
        + "\"edges\":{},\"seam_constraints\":" + seams + ",\"timings_s\":{\"total\":1.5}}";

    private string FreshFolder() => Directory.CreateDirectory(Path.Combine(_root, Guid.NewGuid().ToString("N"))).FullName;

    private PanoPreviewRun PreviewRun(PanoSeamRequest? seams, string? report, bool outputs = true)
    {
        var folder = FreshFolder();
        var files = new PanoPreviewFiles(Path.Combine(folder, "preview-1.png"), Path.Combine(folder, "alignment-1.json"));
        if (outputs)
        {
            File.WriteAllText(files.PreviewPng, "png");
            File.WriteAllText(files.AlignmentJson, "{}");
        }
        if (report is not null)
            File.WriteAllText(files.ReportJson, report);
        return new PanoPreviewRun(new PanoPreviewOptions("keep", "mesh", "auto"), files, null, seams);
    }

    private PanoStitchRun StitchRun(PanoSeamRequest? seams, string? report, bool outputs = true)
    {
        var folder = FreshFolder();
        var stitch = seams is null
            ? null
            : new PanoSeamStitch(seams, Path.Combine(folder, "stitch.seams.json"), Path.Combine(folder, "stitch.report.json"));
        var run = new PanoStitchRun(new[] { "a.dng", "b.dng" }, Path.Combine(folder, "out-master.png"),
            Path.Combine(folder, "out.png"), "keep", "mesh", "auto", null, stitch);
        if (outputs)
        {
            File.WriteAllText(run.OutPath, "png");
            File.WriteAllText(run.DisplayPath, "png");
        }
        if (report is not null && stitch is not null)
            File.WriteAllText(stitch.ReportJson, report);
        return run;
    }

    [Fact]
    public void ASeamRefusalIsReadByItsName()
    {
        var refusal = PanoCliReport.Refusal(TileRefusal);
        Assert.Equal(new PanoCliRefusal("invalid_seam_constraints",
            "seam constraints need the graph-cut seam strategy on the rotation path"), refusal);
        Assert.Equal(
            "invalid_seam_constraints: seam constraints need the graph-cut seam strategy on the rotation path",
            refusal!.Text);
    }

    [Fact]
    public void ARefusalAlreadyLedByItsNameIsNotNamedTwice() =>
        Assert.Equal("invalid_seam_constraints: canvas dimensions must be positive",
            PanoCliReport.Refusal(
                "{\"refused\":{\"resource\":\"seam_constraints\",\"message\":\"invalid_seam_constraints: canvas dimensions must be positive\"}}")!.Text);

    [Theory]
    [InlineData("{")]
    [InlineData("[]")]
    [InlineData("{\"mode\":\"preview\"}")]
    [InlineData("{\"refused\":{\"reason\":\"memory\",\"needed_bytes\":3,\"available_bytes\":2}}")]
    [InlineData("{\"refused\":{\"resource\":\"seam_constraints\"}}")]
    [InlineData("{\"refused\":{\"resource\":\"seam_constraints\",\"message\":7}}")]
    public void AnythingElseIsNotASeamRefusal(string json) => Assert.Null(PanoCliReport.Refusal(json));

    [Fact]
    public void APreviewReportCarriesTheUncroppedCanvasTheVerdictAndTheEcho()
    {
        var report = PanoCliReport.Preview(PreviewReport("reused", Request.ToJson()))!;
        Assert.Equal(new PanoSeamCanvas(2048, 1024), report.Canvas);
        Assert.Equal("rotation", report.Strategy);
        Assert.Equal("reused", report.AlignmentStatus);
        Assert.True(Request.Matches(report.SeamConstraints));
        Assert.Null(PanoCliReport.Preview(PreviewReport("solved", "null"))!.SeamConstraints);
    }

    [Theory]
    [InlineData("{")]
    [InlineData("{\"strategy\":\"rotation\",\"width\":0,\"height\":8,\"alignment\":{\"status\":\"solved\"}}")]
    [InlineData("{\"strategy\":\"rotation\",\"width\":8,\"alignment\":{\"status\":\"solved\"}}")]
    [InlineData("{\"strategy\":\"rotation\",\"width\":8,\"height\":8}")]
    [InlineData("{\"width\":8,\"height\":8,\"alignment\":{\"status\":\"solved\"}}")]
    public void AnIncompletePreviewReportIsNotOne(string json) => Assert.Null(PanoCliReport.Preview(json));

    [Fact]
    public void AFailureIsTheNamedRefusalWhenTheReportHasOne()
    {
        var path = Path.Combine(_root, "refused.report.json");
        File.WriteAllText(path, TileRefusal);
        Assert.Equal(
            "invalid_seam_constraints: seam constraints need the graph-cut seam strategy on the rotation path",
            PanoCliReport.Failure(Failed, path));
    }

    [Fact]
    public void AFailureWithoutARefusalKeepsTheExitCodeAndTheStderrTail()
    {
        var expected = "maple-cli exited 1:\npano: progress 0 decode 0%\nerror: boom";
        Assert.Equal(expected, PanoCliReport.Failure(Failed, null));
        Assert.Equal(expected, PanoCliReport.Failure(Failed, Path.Combine(_root, "missing.report.json")));
        var other = Path.Combine(_root, "memory.report.json");
        File.WriteAllText(other, "{\"refused\":{\"reason\":\"memory\",\"needed_bytes\":3,\"available_bytes\":2}}");
        Assert.Equal(expected, PanoCliReport.Failure(Failed, other));
    }

    [Fact]
    public void ARefusedConstrainedPreviewFailsByName()
    {
        var outcome = PanoCliRuns.PreviewOutcome(Failed, PreviewRun(Request, TileRefusal, outputs: false));
        Assert.False(outcome.Ok);
        Assert.False(outcome.Cancelled);
        Assert.StartsWith("invalid_seam_constraints: ", outcome.Error);
        Assert.Null(outcome.Report);
    }

    [Fact]
    public void AConstrainedPreviewSucceedsOnlyWhenTheReportEchoesTheRequest()
    {
        var confirmed = PanoCliRuns.PreviewOutcome(Succeeded, PreviewRun(Request, PreviewReport("reused", Request.ToJson())));
        Assert.True(confirmed.Ok);
        Assert.Equal(new PanoSeamCanvas(2048, 1024), confirmed.Report!.Canvas);

        var other = new PanoSeamRequest(Request.Canvas,
            new[] { Request.Regions[0] with { Kind = PanoSeamKind.Include } });
        foreach (var echo in new[] { "null", other.ToJson() })
        {
            var dropped = PanoCliRuns.PreviewOutcome(Succeeded, PreviewRun(Request, PreviewReport("reused", echo)));
            Assert.False(dropped.Ok);
            Assert.Equal(PanoCliRuns.UnconfirmedSeams, dropped.Error);
        }
    }

    [Fact]
    public void AnUnconstrainedPreviewNeedsItsImageAlignmentAndReport()
    {
        Assert.True(PanoCliRuns.PreviewOutcome(Succeeded, PreviewRun(null, PreviewReport("solved", "null"))).Ok);
        Assert.Contains("did not write the image and alignment",
            PanoCliRuns.PreviewOutcome(Succeeded, PreviewRun(null, PreviewReport("solved", "null"), outputs: false)).Error);
        Assert.Contains("readable report", PanoCliRuns.PreviewOutcome(Succeeded, PreviewRun(null, null)).Error);
        Assert.True(PanoCliRuns.PreviewOutcome(new PanoCliExit(true, -1, "cancelled"), PreviewRun(null, null)).Cancelled);
    }

    [Fact]
    public void AConstrainedStitchSucceedsOnlyWhenItsReportEchoesTheRequest()
    {
        var echoed = "{\"frames\":2,\"seam_constraints\":" + Request.ToJson() + "}";
        Assert.Equal(new PanoStitchOutcome(true, false, null),
            PanoCliRuns.StitchOutcome(Succeeded, StitchRun(Request, echoed)));
        Assert.Equal(new PanoStitchOutcome(false, false, PanoCliRuns.UnconfirmedSeams),
            PanoCliRuns.StitchOutcome(Succeeded, StitchRun(Request, "{\"frames\":2,\"seam_constraints\":null}")));
        Assert.Equal(new PanoStitchOutcome(false, false, PanoCliRuns.UnconfirmedSeams),
            PanoCliRuns.StitchOutcome(Succeeded, StitchRun(Request, null)));
    }

    [Fact]
    public void ARefusedConstrainedStitchFailsByNameAndAnUnconstrainedOneKeepsItsOldMessage()
    {
        Assert.Equal(
            "invalid_seam_constraints: seam constraints need the graph-cut seam strategy on the rotation path",
            PanoCliRuns.StitchOutcome(Failed, StitchRun(Request, TileRefusal, outputs: false)).Error);
        Assert.Equal("maple-cli exited 1:\npano: progress 0 decode 0%\nerror: boom",
            PanoCliRuns.StitchOutcome(Failed, StitchRun(null, null, outputs: false)).Error);
        Assert.Equal(new PanoStitchOutcome(true, false, null),
            PanoCliRuns.StitchOutcome(Succeeded, StitchRun(null, null)));
        Assert.Equal(new PanoStitchOutcome(false, true, "cancelled"),
            PanoCliRuns.StitchOutcome(new PanoCliExit(true, -1, "cancelled"), StitchRun(null, null)));
        Assert.Contains("did not write both outputs",
            PanoCliRuns.StitchOutcome(Succeeded, StitchRun(null, null, outputs: false)).Error);
    }
}

public sealed class PanoSeamPreviewSessionTests : IDisposable
{
    private static readonly TimeSpan Debounce = TimeSpan.FromMilliseconds(40);
    private static readonly TimeSpan Wait = TimeSpan.FromSeconds(10);
    private static readonly PanoPreviewOptions Options = new("keep", "mesh", "auto");
    private static readonly PanoSeamRequest Request = new(
        new PanoSeamCanvas(2048, 1024),
        new[] { new PanoSeamRegion(PanoSeamKind.Include, 0, new PanoSeamRect(1, 2, 3, 4)) });
    private static readonly PanoPreviewReport Report = new(new PanoSeamCanvas(2048, 1024), "rotation", "reused", null);

    private readonly string _root = Path.Combine(Path.GetTempPath(), "maple-pano-seam-session-test-" + Guid.NewGuid().ToString("N"));
    private readonly PanoScratch _scratch;

    public PanoSeamPreviewSessionTests() => _scratch = PanoScratch.Create(_root, DateTime.UtcNow);

    public void Dispose()
    {
        _scratch.Dispose();
        if (Directory.Exists(_root))
            Directory.Delete(_root, recursive: true);
    }

    private static async Task<PanoPreviewCompletion> NextAsync(PanoPreviewSession session, Action request)
    {
        var done = new TaskCompletionSource<PanoPreviewCompletion>(TaskCreationOptions.RunContinuationsAsynchronously);
        void Handler(PanoPreviewCompletion completion) => done.TrySetResult(completion);
        session.Completed += Handler;
        request();
        var completion = await done.Task.WaitAsync(Wait);
        session.Completed -= Handler;
        return completion;
    }

    [Fact]
    public async Task AConstrainedPreviewCarriesItsRegionsReusesTheAlignmentAndReportsItsCanvas()
    {
        var runs = new ConcurrentQueue<PanoPreviewRun>();
        var session = new PanoPreviewSession(_scratch, (run, _) =>
        {
            runs.Enqueue(run);
            return Task.FromResult(new PanoPreviewOutcome(true, false, null, Report));
        }, Debounce);

        var first = await NextAsync(session, () => session.Request(Options));
        var second = await NextAsync(session, () => session.Request(Options, Request));
        await session.StopAsync();

        Assert.Null(first.Run.Seams);
        Assert.Null(first.Run.AlignmentIn);
        Assert.Same(Request, second.Run.Seams);
        Assert.Equal(first.Run.Files.AlignmentJson, second.Run.AlignmentIn);
        Assert.Equal(second.Run.Files.AlignmentJson, session.LatestAlignment);
        Assert.Same(Report, second.Outcome.Report);
        Assert.Equal(new long[] { 1, 2 }, runs.Select(run => run.Sequence));
        Assert.Equal(2, session.LatestSequence);
    }

    [Fact]
    public async Task AFailedConstrainedPreviewCompletesWithItsErrorAndKeepsTheAlignment()
    {
        var calls = 0;
        var session = new PanoPreviewSession(_scratch, (_, _) => Task.FromResult(
            Interlocked.Increment(ref calls) == 1
                ? new PanoPreviewOutcome(true, false, null, Report)
                : new PanoPreviewOutcome(false, false, "invalid_seam_constraints: no frame left")), Debounce);

        var first = await NextAsync(session, () => session.Request(Options));
        var second = await NextAsync(session, () => session.Request(Options, Request));
        await session.StopAsync();

        Assert.False(second.Outcome.Ok);
        Assert.Equal("invalid_seam_constraints: no frame left", second.Outcome.Error);
        Assert.Same(Request, second.Run.Seams);
        Assert.Equal(first.Run.Files.AlignmentJson, session.LatestAlignment);
    }

    [Fact]
    public async Task ARequestThatOvertakesARunningPreviewLeavesOnlyTheNewestSequenceCurrent()
    {
        var firstStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var completions = new ConcurrentQueue<PanoPreviewCompletion>();
        var calls = 0;
        var session = new PanoPreviewSession(_scratch, async (_, ct) =>
        {
            if (Interlocked.Increment(ref calls) > 1)
                return new PanoPreviewOutcome(true, false, null, Report);
            firstStarted.SetResult();
            await Task.Delay(Timeout.Infinite, ct).ContinueWith(_ => { });
            return new PanoPreviewOutcome(false, true, null);
        }, Debounce);
        session.Completed += completions.Enqueue;

        session.Request(Options, Request);
        await firstStarted.Task.WaitAsync(Wait);
        var newest = await NextAsync(session, () => session.Request(Options));
        await session.StopAsync();

        Assert.Equal(2, newest.Run.Sequence);
        Assert.Equal(session.LatestSequence, newest.Run.Sequence);
        Assert.Null(newest.Run.Seams);
        Assert.Equal(new long[] { 2 }, completions.Select(completion => completion.Run.Sequence));
    }

    [Fact]
    public async Task StoppingWhileAConstrainedPreviewRunsCompletesNothing()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var session = new PanoPreviewSession(_scratch, async (_, ct) =>
        {
            started.SetResult();
            await Task.Delay(Timeout.Infinite, ct).ContinueWith(_ => { });
            return new PanoPreviewOutcome(false, true, null);
        }, Debounce);
        var completed = false;
        session.Completed += _ => completed = true;

        session.Request(Options, Request);
        await started.Task.WaitAsync(Wait);
        await session.StopAsync().WaitAsync(Wait);

        Assert.False(completed);
        Assert.Null(session.LatestAlignment);
    }
}
