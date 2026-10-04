using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
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
        var id = Guid.NewGuid().ToString("N");
        var snapshot = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(publication.Xmp)));
        var elapsed = Stopwatch.StartNew();
        DiagLog.Write($"[cloud-publication] {id} queued xmp={snapshot}");
        _cloudPreviewPublications.Enqueue(() => PublishCloudPreviewAsync(publication, id, elapsed));
    }

    private async Task PublishCloudPreviewAsync(CloudPreviewPublication publication, string id, Stopwatch elapsed)
    {
        var xmp = Path.Combine(Path.GetTempPath(), $"maple-preview-{Guid.NewGuid():N}.xmp");
        var jpeg = Path.Combine(Path.GetTempPath(), $"maple-preview-{Guid.NewGuid():N}.jpg");
        try
        {
            DiagLog.Write($"[cloud-publication] {id} started elapsedMs={elapsed.ElapsedMilliseconds}");
            await File.WriteAllTextAsync(xmp, publication.Xmp);
            DiagLog.Write($"[cloud-publication] {id} render-start elapsedMs={elapsed.ElapsedMilliseconds}");
            var rc = RawFfi.maple_render_develop_jpeg_to_file(publication.OriginalPath, xmp, 1280, 82, jpeg);
            DiagLog.Write($"[cloud-publication] {id} render-end rc={rc} elapsedMs={elapsed.ElapsedMilliseconds}");
            if (rc != 0) throw new IOException(RawFfi.LastError() ?? "Preview rendering failed.");
            DiagLog.Write($"[cloud-publication] {id} upload-start elapsedMs={elapsed.ElapsedMilliseconds}");
            if (!await publication.Client.PublishPreviewAsync(publication.ServerPath,
                await File.ReadAllBytesAsync(jpeg), CancellationToken.None))
                throw new IOException("Server rejected the developed preview.");
            DiagLog.Write($"[cloud-publication] {id} acknowledged elapsedMs={elapsed.ElapsedMilliseconds}");
        }
        catch (Exception error)
        {
            DiagLog.Write($"[cloud-publication] {id} failed elapsedMs={elapsed.ElapsedMilliseconds}");
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
