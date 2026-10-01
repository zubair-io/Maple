using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Native;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Cloud;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    private sealed record CloudPreviewPublication(CloudClient Client, string ServerPath, string OriginalPath, string Xmp);
    private readonly PendingCloudSidecarWrites _cloudPreviewPublications = new();
    private Task _cloudPreviewPublication => _cloudPreviewPublications.DrainAsync();

    public async Task PrepareCloseAsync()
    {
        await PrepareMetadataAsync();
        PublishPendingCloudPreview();
        await _cloudPreviewPublications.DrainAsync(retryFailed: true);
    }

    private void QueueCloudPreviewPublication(CloudPreviewPublication publication)
    {
        // UI-thread enqueue order follows acknowledged saves. A slow older
        // render/upload cannot finish after and replace a newer publication.
        _cloudPreviewPublications.Enqueue(() => PublishCloudPreviewAsync(publication));
    }

    private async Task PublishCloudPreviewAsync(CloudPreviewPublication publication)
    {
        var xmp = Path.Combine(Path.GetTempPath(), $"maple-preview-{Guid.NewGuid():N}.xmp");
        var jpeg = Path.Combine(Path.GetTempPath(), $"maple-preview-{Guid.NewGuid():N}.jpg");
        try
        {
            await File.WriteAllTextAsync(xmp, publication.Xmp);
            var rc = RawFfi.maple_render_develop_jpeg_to_file(publication.OriginalPath, xmp, 1280, 82, jpeg);
            if (rc != 0) throw new IOException(RawFfi.LastError() ?? "Preview rendering failed.");
            if (!await publication.Client.PublishPreviewAsync(publication.ServerPath,
                await File.ReadAllBytesAsync(jpeg), CancellationToken.None))
                throw new IOException("Server rejected the developed preview.");
        }
        catch (Exception error)
        {
            DiagLog.Write($"[cloud] preview publish failed: {error.Message}");
            OnUi(() => { if (!_disposed) CloudStatus = $"Adjustments saved; preview upload failed: {error.Message}"; });
            throw;
        }
        finally
        {
            try { File.Delete(xmp); } catch (IOException) { }
            try { File.Delete(jpeg); } catch (IOException) { }
        }
    }
}
