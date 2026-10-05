using System;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services;

public sealed partial class RenderScheduler
{
    // The background render loop owns this reference. Refine uses the same
    // immutable snapshot, so it does not serialize/validate the model twice.
    private AdjustmentState? _validatedRasterState;

    private bool ValidateRasterState(AdjustmentState snapshot)
    {
        if (ReferenceEquals(snapshot, _validatedRasterState)) return true;
        try
        {
            RenderEngine.ValidateRasterAdjustments(snapshot);
            _validatedRasterState = snapshot;
            return true;
        }
        catch (Exception error)
        {
            RenderFailed?.Invoke(error.Message);
            return false;
        }
    }

    private void EmitClipSource(byte[] pixels, int width, int height)
    {
        if (!ClipOverlayEnabled || ClipSourceReady == null)
            return;
        var copy = new byte[pixels.Length];
        Buffer.BlockCopy(pixels, 0, copy, 0, pixels.Length);
        ClipSourceReady.Invoke(copy, width, height);
    }

    private static uint[] ComputeHistogram(byte[] bgra)
    {
        // [0..767] R/G/B (HistogramView), [768..1023] Rec.709 luma — the
        // tone-curve plot's backdrop (#2576), truncated-int per pixel like
        // the web's computeRgbHistograms.
        var bins = new uint[1024];
        for (var i = 0; i < bgra.Length; i += 4)
        {
            var r = bgra[i + 2];
            var g = bgra[i + 1];
            var b = bgra[i];
            bins[r]++;
            bins[256 + g]++;
            bins[512 + b]++;
            bins[768 + (int)(0.2126 * r + 0.7152 * g + 0.0722 * b)]++;
        }
        return bins;
    }
}
