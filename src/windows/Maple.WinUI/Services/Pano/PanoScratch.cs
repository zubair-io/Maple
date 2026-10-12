using System;
using System.IO;
using System.Threading;

namespace Maple.WinUI.Services.Pano;

public sealed record PanoPreviewFiles(string PreviewPng, string AlignmentJson);

/// <summary>One stitch dialog's temp folder (#4581) under
/// %TEMP%\Maple\Pano: preview PNGs and alignment files live here and go
/// when the dialog's work ends. Folders a crashed session left behind are
/// swept on the next open.</summary>
public sealed class PanoScratch : IDisposable
{
    public static readonly TimeSpan StaleAfter = TimeSpan.FromDays(1);

    private int _runCount;

    public string Directory { get; }

    private PanoScratch(string directory) => Directory = directory;

    public static string DefaultRoot => Path.Combine(Path.GetTempPath(), "Maple", "Pano");

    public static PanoScratch Create() => Create(DefaultRoot, DateTime.UtcNow);

    public static PanoScratch Create(string root, DateTime nowUtc)
    {
        System.IO.Directory.CreateDirectory(root);
        SweepStale(root, nowUtc);
        var directory = Path.Combine(root, Guid.NewGuid().ToString("N"));
        System.IO.Directory.CreateDirectory(directory);
        return new PanoScratch(directory);
    }

    public PanoPreviewFiles NextPreview()
    {
        var run = Interlocked.Increment(ref _runCount);
        return new PanoPreviewFiles(
            Path.Combine(Directory, $"preview-{run}.png"),
            Path.Combine(Directory, $"alignment-{run}.json"));
    }

    public void Dispose() => TryDelete(Directory);

    private static void SweepStale(string root, DateTime nowUtc)
    {
        foreach (var directory in System.IO.Directory.EnumerateDirectories(root))
        {
            if (nowUtc - System.IO.Directory.GetLastWriteTimeUtc(directory) > StaleAfter)
                TryDelete(directory);
        }
    }

    private static void TryDelete(string directory)
    {
        try
        {
            System.IO.Directory.Delete(directory, recursive: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            DiagLog.Write($"[pano] could not remove {directory}: {ex.Message}");
        }
    }
}
