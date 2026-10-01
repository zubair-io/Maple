using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services;

public sealed partial class ThumbnailService
{
    public async Task<string?> GetOrCreateLibraryThumbnailAsync(string path, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var sidecar = SidecarStore.Load(path);
        return sidecar == null
            ? await GetOrCreateAsync(path, ct)
            : await GetOrCreateAdjustedThumbnailAsync(path, sidecar.Adjustments, ct);
    }

    public async Task<string?> GetOrCreateAdjustedThumbnailAsync(
        string path, AdjustmentState model, CancellationToken ct)
    {
        // Resize the developed preview rather than developing at thumbnail
        // resolution: resolution-dependent stages must agree with Browse.
        var preview = await GetOrCreateAdjustedPreviewAsync(path, model, ct);
        if (preview == null) return null;
        var thumbnail = preview + ".thumb.png";
        ct.ThrowIfCancellationRequested();
        if (File.Exists(thumbnail)) return thumbnail;
        var temporary = thumbnail + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await Task.Run(() =>
            {
                if (RawFfi.maple_raster_resize_to_file(preview, temporary,
                    ThumbnailMaxPx, ThumbnailMaxPx, 2, "png", 0) != 0)
                    throw new IOException(RawFfi.LastError());
            }, ct);
            ct.ThrowIfCancellationRequested();
            File.Move(temporary, thumbnail, overwrite: true);
            return thumbnail;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            ct.ThrowIfCancellationRequested();
            DiagLog.Write($"[thumb] adjusted resize failed: {error.Message}");
            return null;
        }
        finally
        {
            try { File.Delete(temporary); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            { DiagLog.Write($"[thumb] adjusted temporary cleanup failed: {error.Message}"); }
        }
    }
}
