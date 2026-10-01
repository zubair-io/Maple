using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.Transfer;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    public async Task RefreshCloudTransferThumbnailsAsync(Services.Cloud.CloudClient client, string[] applied)
    {
        var ids = applied.ToHashSet(StringComparer.Ordinal);
        var photos = AllPhotos.Where(photo => photo.IsCloud && photo.CloudAddress != null
            && ids.Contains(photo.CloudAddress ?? photo.FilePath)).ToArray();
        foreach (var photo in photos)
        {
            if (_disposed || !ReferenceEquals(client, _cloud)) return;
            if (!AllPhotos.Contains(photo) || ReferenceEquals(photo, SelectedPhoto)) continue;
            var address = photo.CloudAddress!;
            var before = photo.ThumbnailPath;
            var path = await client.FetchImageAsync("thumb", address, CancellationToken.None);
            path = await Services.DisplayImageCache.PrepareAsync(path, Services.ThumbnailService.ThumbnailMaxPx, CancellationToken.None);
            if (path == null) throw new InvalidOperationException($"The transfer was saved, but the thumbnail for {photo.FileName} could not be refreshed. Refresh the job status to retry.");
            await OnUiAcknowledgedAsync(() =>
            {
                if (_disposed || !ReferenceEquals(client, _cloud) || !AllPhotos.Contains(photo)
                    || ReferenceEquals(photo, SelectedPhoto) || photo.CloudAddress != address || photo.ThumbnailPath != before) return;
                photo.ThumbnailPath = new Uri(path).AbsoluteUri;
            });
        }
    }

    public async Task RefreshLocalTransferThumbnailsAsync(Services.Transfer.LocalTransferJob job)
    {
        var visible = AllPhotos.Where(photo => !photo.IsCloud)
            .ToLookup(photo => photo.FilePath, StringComparer.OrdinalIgnoreCase);
        await foreach (var path in job.CurrentAppliedPathsAsync())
        {
            if (_disposed) return;
            foreach (var photo in visible[path])
            {
                if (!AllPhotos.Contains(photo) || ReferenceEquals(photo, SelectedPhoto)) continue;
                await RefreshLocalThumbnailAsync(photo, CancellationToken.None);
            }
        }
    }

    /// <summary>Reload acknowledged sidecars after external batch delivery. The
    /// batch journal owns recovery. A transfer initiated in this window retains
    /// one undo boundary even when the sidecar watcher wins the reload race.</summary>
    public async Task RefreshAfterTransferAsync(PhotoItem photo, Models.AdjustmentState? undoBefore = null)
    {
        var version = _photoOpenVersion;
        var cloud = photo.IsCloud ? _cloud ?? throw new InvalidOperationException("Reconnect to refresh the transferred photo.") : null;
        var snapshot = await TransferSnapshot.ReadAsync(photo.FilePath, cloud, CancellationToken.None);
        await OnUiAcknowledgedAsync(() =>
        {
            if (_disposed || version != _photoOpenVersion || !ReferenceEquals(SelectedPhoto, photo)
                || (cloud != null && !ReferenceEquals(cloud, _cloud))) return;
            if (_sidecarDirty) throw new InvalidOperationException("Newer edits are pending; reload the photo after saving them.");
            var before = Adjustments;
            var doc = snapshot.Document;
            photo.Rating = doc.Rating ?? 0; photo.FlagStatus = doc.Flag ?? "none"; photo.ColorLabel = doc.ColorLabel;
            if (cloud != null)
            {
                _cloudDoc = doc;
                RequestSavedCloudPreview(photo, doc.Adjustments.Clone(), cloud, version);
            }
            var changed = XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = before }) !=
                XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = doc.Adjustments });
            var recordUndo = undoBefore != null && XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = undoBefore }) !=
                XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = doc.Adjustments });
            if (recordUndo)
            {
                _undoTimer?.Dispose(); _undoTimer = null;
                _undoStack.Add(undoBefore!.Clone());
                if (_undoStack.Count > UndoDepth) _undoStack.RemoveAt(0);
                _redoStack.Clear();
                _undoBaseline = doc.Adjustments.Clone();
            }
            if (!changed)
            {
                return;
            }
            _undoTimer?.Dispose(); _undoTimer = null;
            Adjustments = doc.Adjustments;
            if (!recordUndo) { _undoStack.Clear(); _redoStack.Clear(); }
            _undoBaseline = Adjustments.Clone();
            SyncSlidersFromModel();
            RefreshRenderAfterModelChange(before);
            RefreshLocalPreview();
        });
    }
}
