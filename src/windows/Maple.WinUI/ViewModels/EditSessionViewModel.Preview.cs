using System;
using System.Threading;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    [ObservableProperty] private bool _hasDecodeError;
    private CancellationTokenSource? _previewRequest;

    private void CancelPreviewRequest()
    {
        _previewRequest?.Cancel();
        _previewRequest = null;
    }

    private void RefreshLocalPreview()
    {
        if (!_disposed && SelectedPhoto is { IsCloud: false } photo && AdjustmentsReady)
            RequestEmbeddedPreview(photo);
    }

    public void RetryPreview()
    {
        if (_disposed || IsDecoding) return;
        _decodedPhoto = null;
        _decodedImage = null;
        EnsureDecoded();
    }

    /// <summary>Develop saved local adjustments for Browse and Preview; use
    /// embedded pixels only for a photo without a sidecar.</summary>
    private void RequestEmbeddedPreview(PhotoItem photo)
    {
        CancelPreviewRequest();
        var request = new CancellationTokenSource();
        _previewRequest = request;
        var model = Adjustments.Clone();
        var version = _photoOpenVersion;
        _ = Task.Run(async () =>
        {
            string? path = null;
            string? thumbnail = null;
            try
            {
                var hasSidecar = System.IO.File.Exists(SidecarStore.SidecarPathFor(photo.FilePath));
                path = hasSidecar
                    ? await _thumbnails.GetOrCreateAdjustedPreviewAsync(photo.FilePath, model, request.Token)
                    : await _thumbnails.GetOrCreateAsync(photo.FilePath, request.Token, ThumbnailService.PreviewMaxPx);
                thumbnail = hasSidecar
                    ? await _thumbnails.GetOrCreateAdjustedThumbnailAsync(photo.FilePath, model, request.Token)
                    : await _thumbnails.GetOrCreateAsync(photo.FilePath, request.Token);
                thumbnail = await DisplayImageCache.PrepareAsync(thumbnail, ThumbnailService.ThumbnailMaxPx, request.Token);
            }
            catch (OperationCanceledException) { }
            catch (Exception error) { DiagLog.Write($"[preview] {error.Message}"); }
            OnUi(() =>
            {
                var current = ReferenceEquals(_previewRequest, request);
                if (current) _previewRequest = null;
                var cancelled = request.IsCancellationRequested;
                request.Dispose();
                if (_disposed || cancelled || !current || version != _photoOpenVersion || !ReferenceEquals(photo, SelectedPhoto)) return;
                photo.PreviewPath = path == null ? null : new Uri(path).AbsoluteUri;
                if (thumbnail != null) photo.ThumbnailPath = new Uri(thumbnail).AbsoluteUri;
                if (path == null) EnsureDecoded();
            });
        });
    }
}
