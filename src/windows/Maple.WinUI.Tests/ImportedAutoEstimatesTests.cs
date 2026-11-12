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
}
