using System;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Cloud;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    private sealed record AckedCloudSave(CloudClient Client, AdjustmentState Model, string? Original);

    private readonly ConcurrentDictionary<PhotoItem, AckedCloudSave> _ackedCloudSaves = new();

    private void RequestSavedCloudPreviewAfterSave(PhotoItem photo, AdjustmentState model, CloudClient client, int version)
    {
        var admission = _savedPreviews.Request(photo);
        _savedPreviews = admission.Next;
        if (admission.Start) RequestSavedCloudPreview(photo, model, client, version);
        else _ackedCloudSaves[photo] = new AckedCloudSave(client, model, photo.LocalCachePath);
    }

    private bool CanRefreshCloudThumbnail(PhotoItem photo) =>
        _ackedCloudSaves.TryGetValue(photo, out var saved) && ReferenceEquals(saved.Client, _cloud) && saved.Original != null;

    private async Task<bool> RefreshCloudThumbnailAsync(PhotoItem photo, CancellationToken ct)
    {
        if (!_ackedCloudSaves.TryGetValue(photo, out var saved) || saved.Original == null) return false;
        var preview = await _thumbnails.GetOrCreateAdjustedPreviewAsync(saved.Original, saved.Model, ct);
        var thumbnail = await _thumbnails.GetOrCreateAdjustedThumbnailAsync(saved.Original, saved.Model, ct);
        if (preview == null || thumbnail == null) return false;
        var published = false;
        await OnUiAcknowledgedAsync(() =>
        {
            published = !_disposed && !ct.IsCancellationRequested && ReferenceEquals(saved.Client, _cloud)
                && AllPhotos.Contains(photo);
            if (!published) return;
            photo.PreviewPath = new Uri(preview).AbsoluteUri;
            photo.ThumbnailPath = new Uri(thumbnail).AbsoluteUri;
            _ackedCloudSaves.TryRemove(photo, out _);
        });
        return published;
    }

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
                if (cancelled && !_disposed) RetryOwedAfterSelectionMoved(photo);
                if (_disposed || cancelled || !current || version != _photoOpenVersion
                    || !ReferenceEquals(client, _cloud) || !ReferenceEquals(photo, SelectedPhoto)) return;
                if (preview != null && thumbnail != null)
                {
                    _savedPreviews = _savedPreviews.Settle(photo, SavedPreviewRefreshOutcome.Refreshed);
                    _ackedCloudSaves.TryRemove(photo, out _);
                }
                if (preview != null) photo.PreviewPath = new Uri(preview).AbsoluteUri;
                if (thumbnail != null) photo.ThumbnailPath = new Uri(thumbnail).AbsoluteUri;
            });
        });
    }
}
