using System;
using System.Threading.Tasks;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services;

public sealed partial class RenderScheduler
{
    private Action? _beforeHistogramPublishForSmoke;

    // Explicit native lifecycle qualification only. Force replacement after
    // the real CPU call, where SetImage previously invalidated shared buffers.
    internal static async Task VerifyHistogramReplacementAsync(DecodedImage image, AdjustmentState state)
    {
        var scheduler = new RenderScheduler();
        var histograms = 0;
        var clips = 0;
        string? failure = null;
        scheduler.HistogramReady += bins =>
        {
            if (bins.Length != 1024) throw new InvalidOperationException("Invalid histogram bins");
            histograms++;
        };
        scheduler.ClipOverlayEnabled = true;
        scheduler.ClipSourceReady += (pixels, width, height) =>
        {
            if (width != image.Width || height != image.Height || pixels.Length != width * height * 4)
                throw new InvalidOperationException("Invalid histogram clipping frame");
            clips++;
        };
        scheduler.RenderFailed += message => failure = message;
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
        }
        finally { await scheduler.StopAsync(); }
    }
}
