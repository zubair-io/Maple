using System;
using System.IO;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Windows.Graphics.Imaging;

namespace Maple.WinUI.Services;

public sealed partial class ThumbnailService
{
    // Embedded extraction remains concurrent. A missing embedded preview must
    // not start four simultaneous sensor decodes while browsing a large folder.
    private static readonly SemaphoreSlim DevelopGate = new(1);
    private static readonly Lazy<string> DevelopIdentity = new(() =>
    {
        using var dll = File.OpenRead(Path.Combine(AppContext.BaseDirectory, "raw_ffi.dll"));
        return typeof(RenderEngine).Module.ModuleVersionId.ToString("N") + "-"
            + Convert.ToHexString(SHA256.HashData(dll))[..16];
    });

    private string DevelopedThumbPath(string rawPath) =>
        LocalCachePathFor(rawPath, ThumbnailMaxPx, $"developed-{DevelopIdentity.Value}.png");

    private async Task<string?> GetOrCreateDevelopedThumbAsync(string rawPath, CancellationToken ct)
    {
        await DevelopGate.WaitAsync(ct);
        string? temporary = null;
        try
        {
            // PNG fallback pixels use a separate local slot from shared AVIF.
            // Invalidate on either renderer binary change, not only RAW mtime.
            var path = DevelopedThumbPath(rawPath);
            if (File.Exists(path)) return path;
            var frame = await Task.Run(() => RenderThumb(rawPath, ct), ct);
            ct.ThrowIfCancellationRequested();
            temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            using (var stream = File.Create(temporary))
            {
                var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream.AsRandomAccessStream());
                encoder.SetPixelData(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore,
                    (uint)frame.Width, (uint)frame.Height, 96, 96, frame.Pixels);
                await encoder.FlushAsync();
            }
            ct.ThrowIfCancellationRequested();
            File.Move(temporary, path, overwrite: true);
            return path;
        }
        catch (Exception error)
        {
            ct.ThrowIfCancellationRequested();
            DiagLog.Write($"[thumb] developed fallback failed: {error.Message}");
            return null;
        }
        finally
        {
            if (temporary != null)
            {
                try { File.Delete(temporary); }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException)
                { DiagLog.Write($"[thumb] temporary cleanup failed: {error.Message}"); }
            }
            DevelopGate.Release();
        }
    }

    private static (int Width, int Height, byte[] Pixels) RenderThumb(string path, CancellationToken ct)
    {
        var flag = RawFfi.maple_cancel_flag_new();
        try
        {
            // Dispose the registration before freeing its native flag, including
            // when cancellation races the end of the decode.
            using var registration = ct.Register(() => RawFfi.maple_cancel_flag_set(flag));
            ct.ThrowIfCancellationRequested();
            var model = new AdjustmentState();
            var image = RenderEngine.Decode(path, model, ThumbnailMaxPx, RefineDecodeQuality.Preview, flag);
            ct.ThrowIfCancellationRequested();
            if (model.Temperature == 6500 && model.Tint == 0 && image.DecodedTemperature > 0)
            { model.Temperature = image.DecodedTemperature; model.Tint = image.DecodedTint; }
            var pixels = new byte[checked(image.Width * image.Height * 4)];
            float[]? scratch = null;
            RenderEngine.RenderTick(image, model, ref scratch, pixels);
            ct.ThrowIfCancellationRequested();
            return (image.Width, image.Height, pixels);
        }
        finally { RawFfi.maple_cancel_flag_free(flag); }
    }
}
