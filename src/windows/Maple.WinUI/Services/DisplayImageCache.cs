using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Native;

namespace Maple.WinUI.Services;

/// <summary>Keep portable AVIF derivatives intact, but present lossless PNGs
/// decoded by the shared core. Windows' AV1 WIC decoder can retain hundreds
/// of worker threads per live image (#3875). Never hand those files to XAML.</summary>
internal static class DisplayImageCache
{
    private static readonly SemaphoreSlim Gate = new(1);

    internal static async Task<string?> PrepareAsync(string? source, int maxPixels,
        CancellationToken cancellation, string? cacheDirectory = null)
    {
        cancellation.ThrowIfCancellationRequested();
        if (source == null || !string.Equals(Path.GetExtension(source), ".avif", StringComparison.OrdinalIgnoreCase))
            return source;
        if (maxPixels <= 0) throw new ArgumentOutOfRangeException(nameof(maxPixels));
        await Gate.WaitAsync(cancellation).ConfigureAwait(false);
        string? temporary = null;
        try
        {
            var info = new FileInfo(source);
            var key = $"display-v1|{info.FullName}|{info.Length}|{info.LastWriteTimeUtc.Ticks}|{maxPixels}";
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)));
            var directory = cacheDirectory ?? Path.Combine(Environment.GetFolderPath(
                Environment.SpecialFolder.LocalApplicationData), "Maple", "local-cache");
            Directory.CreateDirectory(directory);
            var target = Path.Combine(directory, hash + ".png");
            if (File.Exists(target)) return target;
            temporary = target + "." + Guid.NewGuid().ToString("N") + ".tmp";
            var result = await Task.Run(() => RawFfi.maple_raster_resize_to_file(
                source, temporary, (uint)maxPixels, (uint)maxPixels, 2, "png", 0), cancellation).ConfigureAwait(false);
            cancellation.ThrowIfCancellationRequested();
            if (result != 0) throw new InvalidDataException(RawFfi.LastError() ?? "Display image decode failed.");
            File.Move(temporary, target, overwrite: true);
            return target;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidDataException)
        {
            DiagLog.Write($"[display-image] {error.Message}");
            return null;
        }
        finally
        {
            if (temporary != null)
            {
                try { File.Delete(temporary); }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException)
                { DiagLog.Write($"[display-image] temporary cleanup: {error.Message}"); }
            }
            Gate.Release();
        }
    }
}
