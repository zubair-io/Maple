using System;
using System.Threading.Tasks;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services;

public sealed partial class RenderScheduler
{
    private Action? _beforeHistogramPublishForSmoke;
    private Action<Exception>? _histogramFailureForSmoke;

    // Explicit native lifecycle qualification only. Force replacement after
    // the real CPU call, where SetImage previously invalidated shared buffers.
    internal static async Task VerifyHistogramReplacementAsync(DecodedImage image, AdjustmentState state)
    {
        var scheduler = new RenderScheduler();
        var histograms = 0;
        var clips = 0;
        var frames = 0;
        var scopes = 0;
        string? failure = null;
        void VerifyCheckedOut()
        {
            lock (scheduler._gate)
                if (scheduler._bgra != null || scheduler._chainScratch != null)
                    throw new InvalidOperationException("Render buffers returned before their readers finished");
        }
        scheduler.HistogramReady += bins =>
        {
            VerifyCheckedOut();
            if (bins.Length != 1024) throw new InvalidOperationException("Invalid histogram bins");
            for (var channel = 0; channel < 4; channel++)
            {
                long total = 0;
                for (var bin = 0; bin < 256; bin++) total += bins[channel * 256 + bin];
                if (total != image.Width * image.Height)
                    throw new InvalidOperationException("Histogram lost pixels");
            }
            histograms++;
        };
        scheduler.ClipOverlayEnabled = true;
        scheduler.ClipSourceReady += (pixels, width, height) =>
        {
            VerifyCheckedOut();
            if (width != image.Width || height != image.Height || pixels.Length != width * height * 4)
                throw new InvalidOperationException("Invalid histogram clipping frame");
            clips++;
        };
        scheduler.RenderFailed += message => failure = message;
        scheduler.ScopeFailed += (_, message) => failure = message;
        scheduler.FrameReady += (_, pixels, width, height, bins, _) =>
        {
            VerifyCheckedOut();
            if (width != image.Width || height != image.Height || pixels.Length != width * height * 4 || bins.Length != 1024)
                throw new InvalidOperationException("Invalid CPU publication frame");
            frames++;
        };
        scheduler.ScopeReady += sample =>
        {
            VerifyCheckedOut();
            if (sample.Values.Length != 448 || sample.ChromaBins.Length != 128 * 128)
                throw new InvalidOperationException("Invalid CPU scope publication");
            scopes++;
        };
        // Observe exceptions even when stale-frame error publication is rejected.
        scheduler._histogramFailureForSmoke = error => failure = error.ToString();
        try
        {
            scheduler.SetImage(image);
            scheduler._beforeHistogramPublishForSmoke = () => scheduler.SetImage(null);
            await Task.Run(() => scheduler.EmitHistogram(image, state));
            if (failure != null || histograms != 0 || clips != 0 || scheduler.DetailSource != null)
                throw new InvalidOperationException($"Superseded histogram published: {failure}, histograms={histograms}, clips={clips}");

            scheduler._beforeHistogramPublishForSmoke = null;
            scheduler.SetImage(image);
            await Task.Run(() => scheduler.EmitHistogram(image, state));
            if (failure != null || histograms != 1 || clips != 1)
                throw new InvalidOperationException($"Current histogram failed: {failure}, histograms={histograms}, clips={clips}");
            lock (scheduler._gate)
            {
                scheduler._lastRendered = state;
                scheduler._scopes.SetEnabled(true);
            }
            var rendered = await Task.Run(() => scheduler.CpuRender(image, state, emitFrame: true, sampleScopes: true));
            if (!rendered || failure != null || frames != 1 || clips != 2 || scopes != 1)
                throw new InvalidOperationException($"CPU publication failed: {failure}, frames={frames}, clips={clips}, scopes={scopes}");
        }
        finally { await scheduler.StopAsync(); }
    }
}
