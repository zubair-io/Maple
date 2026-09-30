using System;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.Transfer;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
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
            if (_disposed || version != _photoOpenVersion || !ReferenceEquals(SelectedPhoto, photo)) return;
            if (_sidecarDirty) throw new InvalidOperationException("Newer edits are pending; reload the photo after saving them.");
            var before = Adjustments;
            var doc = snapshot.Document;
            var changed = XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = before }) !=
                XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = doc.Adjustments });
            var recordUndo = undoBefore != null && XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = undoBefore }) !=
                XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = doc.Adjustments });
            if (recordUndo)
            {
                _undoStack.Add(undoBefore!.Clone());
                if (_undoStack.Count > UndoDepth) _undoStack.RemoveAt(0);
                _redoStack.Clear();
                _undoBaseline = doc.Adjustments.Clone();
            }
            if (!changed)
            {
                if (photo.IsCloud) _cloudDoc = doc;
                return;
            }
            _undoTimer?.Dispose(); _undoTimer = null;
            Adjustments = doc.Adjustments;
            if (!recordUndo) { _undoStack.Clear(); _redoStack.Clear(); }
            _undoBaseline = Adjustments.Clone();
            if (photo.IsCloud) _cloudDoc = doc;
            photo.Rating = doc.Rating ?? 0; photo.FlagStatus = doc.Flag ?? "none"; photo.ColorLabel = doc.ColorLabel;
            SyncSlidersFromModel();
            RefreshRenderAfterModelChange(before);
        });
    }
}
