using System.Collections.Concurrent;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

/// <summary>The editor's imported Auto estimates (#4669) on real threads: the native resolve is
/// replaced by a recorder that blocks until released, as an uncancellable estimate does.</summary>
public sealed class ImportedAutoEstimatesTests
{
    private sealed class Recorder
    {
        public readonly ConcurrentQueue<string> Started = new();
        public readonly SemaphoreSlim Running = new(0);
        public readonly ManualResetEventSlim Release = new(false);

        public void Resolve(string path, AdjustmentState model)
        {
            Started.Enqueue(path);
            Running.Release();
            Assert.True(Release.Wait(TimeSpan.FromSeconds(10)));
            if (path.EndsWith("broken.dng")) throw new InvalidOperationException("estimate failed");
            model.ImportedWhiteBalance = model.ImportedWhiteBalance! with { Resolved = new(5100, 9) };
            model.Temperature = 5100;
            model.Tint = 9;
        }
    }

    private static AdjustmentState NameOnly() => XmpParser.Parse(
        "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\" crs:WhiteBalance=\"Auto\"/></rdf:RDF></x:xmpmeta>")!.Adjustments;

    [Fact]
    public async Task ARedecodeOfTheSamePhotoJoinsTheEstimateInFlight()
    {
        var recorder = new Recorder();
        var estimates = new ImportedAutoEstimates(recorder.Resolve);
        var model = NameOnly();
        estimates.Focus("a.dng");
        var first = estimates.ResolveAsync("a.dng", model);
        Assert.True(await recorder.Running.WaitAsync(TimeSpan.FromSeconds(10)));
        // A Profile/AutoExposure/lens re-decode refocuses the same photo.
        estimates.Focus("a.dng");
        var redecode = estimates.ResolveAsync("a.dng", model);
        Assert.Same(first, redecode);
        recorder.Release.Set();
        var resolved = await redecode;
        Assert.Equal((5100, 9), (resolved!.Temperature, resolved.Tint));
        Assert.Equal(new[] { "a.dng" }, recorder.Started.ToArray());
        // The caller's model is never mutated off the UI thread.
        Assert.True(ImportedWhiteBalanceResolver.IsUnresolvedAuto(model));
    }

    [Fact]
    public async Task OneEstimateRunsAtATimeAndNavigationDropsAQueuedOneBeforeItStarts()
    {
        var recorder = new Recorder();
        var estimates = new ImportedAutoEstimates(recorder.Resolve);
        estimates.Focus("a.dng");
        var a = estimates.ResolveAsync("a.dng", NameOnly());
        Assert.True(await recorder.Running.WaitAsync(TimeSpan.FromSeconds(10)));
        estimates.Focus("b.dng");
        var b = estimates.ResolveAsync("b.dng", NameOnly());
        // B waits behind A's uncancellable estimate instead of decoding a second RAW.
        Assert.False(await recorder.Running.WaitAsync(TimeSpan.FromMilliseconds(200)));
        estimates.Focus("c.dng");
        recorder.Release.Set();
        Assert.NotNull(await a);
        Assert.Null(await b);
        Assert.Equal(new[] { "a.dng" }, recorder.Started.ToArray());
        // A photo that lost focus never starts or shares an estimate.
        Assert.Null(await estimates.ResolveAsync("a.dng", NameOnly()));
        Assert.Equal(new[] { "a.dng" }, recorder.Started.ToArray());
    }

    [Fact]
    public async Task AFailedEstimateKeepsAsShotAndTheNextOpenEstimatesAgain()
    {
        var recorder = new Recorder();
        recorder.Release.Set();
        var estimates = new ImportedAutoEstimates(recorder.Resolve);
        estimates.Focus("broken.dng");
        Assert.Null(await estimates.ResolveAsync("broken.dng", NameOnly()));
        estimates.Focus(null);
        estimates.Focus("broken.dng");
        Assert.Null(await estimates.ResolveAsync("broken.dng", NameOnly()));
        Assert.Equal(new[] { "broken.dng", "broken.dng" }, recorder.Started.ToArray());
    }

    [Fact]
    public void UnresolvedAutoBecomingActiveWithoutADecodeStartsTheEstimate()
    {
        // A WB-only paste (or undo/redo, sidecar reload) of name-only Auto re-decodes nothing.
        var before = new AdjustmentState { Temperature = 4800, Tint = 3 };
        var pasted = NameOnly();
        before.AutoExposure = pasted.AutoExposure;
        before.Profile = pasted.Profile;
        Assert.True(ImportedAutoEstimates.StartsWithoutDecode(before, pasted));
        // A decode-owned change re-decodes, and the decode path starts it instead.
        var redecode = pasted.Clone();
        redecode.AutoExposure = pasted.AutoExposure == ToggleMode.On ? ToggleMode.Off : ToggleMode.On;
        Assert.False(ImportedAutoEstimates.StartsWithoutDecode(before, redecode));
        // A photo that already holds a pair, or numeric WB, is never estimated again.
        var landed = pasted.Clone();
        landed.ImportedWhiteBalance = landed.ImportedWhiteBalance! with { Resolved = new(5100, 9) };
        Assert.False(ImportedAutoEstimates.StartsWithoutDecode(before, landed));
        Assert.False(ImportedAutoEstimates.StartsWithoutDecode(pasted, before));
    }

    [Fact]
    public async Task ARepeatedRequestReusesItsPairAndADifferentRequestEstimatesItsOwn()
    {
        var recorder = new Recorder();
        recorder.Release.Set();
        var estimates = new ImportedAutoEstimates(recorder.Resolve);
        estimates.Focus("a.dng");
        var opened = await estimates.ResolveAsync("a.dng", NameOnly());
        // Undo/redo or a re-paste of the same request on the decoded photo: no second estimate.
        Assert.Same(opened, await estimates.ResolveAsync("a.dng", NameOnly()));
        Assert.Equal(new[] { "a.dng" }, recorder.Started.ToArray());
        // A pasted request in another scale must not take the opened request's pair.
        var pasted = NameOnly();
        pasted.ImportedWhiteBalance = pasted.ImportedWhiteBalance! with { Version = 2 };
        var resolved = await estimates.ResolveAsync("a.dng", pasted);
        Assert.NotSame(opened, resolved);
        Assert.Equal(2, resolved!.ImportedWhiteBalance!.Version);
        Assert.Equal(new[] { "a.dng", "a.dng" }, recorder.Started.ToArray());
    }
}
