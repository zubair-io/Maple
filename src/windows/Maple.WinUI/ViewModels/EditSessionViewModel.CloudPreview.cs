using System;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Cloud;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    private void RequestSavedCloudPreview(PhotoItem photo, AdjustmentState model, CloudClient client, int version)
    {
        if (_disposed || version != _photoOpenVersion || !ReferenceEquals(photo, SelectedPhoto)
            || !ReferenceEquals(client, _cloud) || photo.LocalCachePath is not { } original) return;
        CancelPreviewRequest();
        var request = new CancellationTokenSource();
        _previewRequest = request;
        _ = Task.Run(async () =>
        {
            string? preview = null, thumbnail = null;
            try
            {
                preview = await _thumbnails.GetOrCreateAdjustedPreviewAsync(original, model, request.Token);
                thumbnail = await _thumbnails.GetOrCreateAdjustedThumbnailAsync(original, model, request.Token);
            }
            catch (OperationCanceledException) { }
            catch (Exception error) { DiagLog.Write($"[cloud] saved preview failed: {error.Message}"); }
            OnUi(() =>
            {
                var current = ReferenceEquals(_previewRequest, request);
                if (current) _previewRequest = null;
                var cancelled = request.IsCancellationRequested;
                request.Dispose();
                if (_disposed || cancelled || !current || version != _photoOpenVersion
                    || !ReferenceEquals(client, _cloud) || !ReferenceEquals(photo, SelectedPhoto)) return;
                if (preview != null) photo.PreviewPath = new Uri(preview).AbsoluteUri;
                if (thumbnail != null) photo.ThumbnailPath = new Uri(thumbnail).AbsoluteUri;
            });
        });
    }
}
