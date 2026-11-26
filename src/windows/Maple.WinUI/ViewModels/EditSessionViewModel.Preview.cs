using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    private sealed record OwedThumbnails(CancellationTokenSource Cancellation, IReadOnlyList<PhotoItem> Photos);

    [ObservableProperty] private bool _hasDecodeError;
    private CancellationTokenSource? _previewRequest;
    private SavedPreviewDeferral<PhotoItem> _savedPreviews = SavedPreviewDeferral<PhotoItem>.Idle;
    private OwedThumbnails? _owedThumbnails;

    private void CancelPreviewRequest()
    {
        _previewRequest?.Cancel();
        _previewRequest = null;
    }

    private void CancelOwedThumbnails()
    {
        _owedThumbnails?.Cancellation.Cancel();
        _owedThumbnails = null;
    }

    /// <summary>The shell reports every mode change. In Edit the editor's
    /// decode comes first: running local saved-preview work is cancelled and
    /// none starts; each photo owed a refresh gets it on the way out (#4374).</summary>
    public void SetShellMode(ShellMode mode)
    {
        if (_disposed) return;
        var selected = SelectedPhoto;
        var requested = _previewRequest != null && selected is { IsCloud: false } local
            ? new[] { local }
            : Array.Empty<PhotoItem>();
        var change = _savedPreviews.Enter(
            mode, requested.Concat(_owedThumbnails?.Photos ?? Array.Empty<PhotoItem>()).ToArray());
        _savedPreviews = change.Next;
        if (change.Cancel)
        {
            if (requested.Length > 0) CancelPreviewRequest();
            CancelOwedThumbnails();
        }
        if (selected != null && change.Release.Contains(selected)) RefreshSelectedSavedPreview(selected);
        var unselected = change.Release
            .Where(photo => !photo.IsCloud && !ReferenceEquals(photo, selected) && AllPhotos.Contains(photo))
            .ToArray();
        // The old preview shows a superseded edit; the thumbnail stands in until reselection.
        foreach (var photo in unselected) photo.PreviewPath = null;
        if (unselected.Length > 0) RefreshOwedThumbnails(unselected);
    }

    private void MarkSavedPreviewStale()
    {
        if (_openPhoto is { IsCloud: false } photo) _savedPreviews = _savedPreviews.Edited(photo);
    }

    private void RefreshOwedThumbnails(IReadOnlyList<PhotoItem> photos)
    {
        var batch = new OwedThumbnails(new CancellationTokenSource(), photos);
        _owedThumbnails = batch;
        var cancellation = batch.Cancellation.Token;
        _ = Task.Run(async () =>
        {
            var outcomes = new List<(PhotoItem Photo, SavedPreviewRefreshOutcome Outcome)>();
            foreach (var photo in photos)
            {
                if (_disposed || cancellation.IsCancellationRequested)
                {
                    outcomes.Add((photo, SavedPreviewRefreshOutcome.Cancelled));
                    continue;
                }
                try
                {
                    await RefreshLocalThumbnailAsync(photo, cancellation);
                    outcomes.Add((photo, SavedPreviewRefreshOutcome.Refreshed));
                }
                catch (OperationCanceledException) { outcomes.Add((photo, SavedPreviewRefreshOutcome.Cancelled)); }
                catch (Exception error)
                {
                    DiagLog.Write($"[preview] owed thumbnail: {error.Message}");
                    outcomes.Add((photo, SavedPreviewRefreshOutcome.Failed));
                }
            }
            OnUi(() =>
            {
                // A batch cancelled by entering Edit was already re-owed in full by that change.
                if (ReferenceEquals(_owedThumbnails, batch))
                {
                    _owedThumbnails = null;
                    foreach (var (photo, outcome) in outcomes) _savedPreviews = _savedPreviews.Settle(photo, outcome);
                }
                batch.Cancellation.Dispose();
            });
        });
    }

    private void RefreshSelectedSavedPreview(PhotoItem photo)
    {
        if (!photo.IsCloud) RefreshLocalPreview();
        else if (!_disposed && AdjustmentsReady && _cloud is { } client)
            RequestSavedCloudPreview(photo, Adjustments.Clone(), client, _photoOpenVersion);
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
        _decodedImageSize = null;
        EnsureDecoded();
    }

    /// <summary>Develop saved local adjustments for Browse and Preview; use
    /// embedded pixels only for a photo without a sidecar. Only the develop
    /// waits for Edit to end: the embedded placeholder is cheap and is still
    /// extracted there.</summary>
    private void RequestEmbeddedPreview(PhotoItem photo)
    {
        CancelPreviewRequest();
        var hasSidecar = System.IO.File.Exists(SidecarStore.SidecarPathFor(photo.FilePath));
        if (hasSidecar)
        {
            var admission = _savedPreviews.Request(photo);
            _savedPreviews = admission.Next;
            if (!admission.Start) return;
        }
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
                if (hasSidecar && path != null) _savedPreviews = _savedPreviews.Settle(photo, SavedPreviewRefreshOutcome.Refreshed);
                photo.PreviewPath = path == null ? null : new Uri(path).AbsoluteUri;
                if (thumbnail != null) photo.ThumbnailPath = new Uri(thumbnail).AbsoluteUri;
                if (path == null) EnsureDecoded();
            });
        });
    }
}
