using System;
using System.Threading;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel
    {
        // --- Adjustment edits ---
        private object? _adjustmentGesture;
        public event Action? AdjustmentSettled;

        public void BeginAdjustmentGesture(object owner)
        {
            if (!AdjustmentsReady || ReferenceEquals(_adjustmentGesture, owner)) return;
            _undoTimer?.Dispose();
            _undoTimer = null;
            CommitUndoBoundary();
            _adjustmentGesture = owner;
        }

        public void EndAdjustmentGesture(object owner)
        {
            if (!ReferenceEquals(_adjustmentGesture, owner)) return;
            _adjustmentGesture = null;
            CommitUndoBoundary();
        }

        /// <summary>Called by every slider on value change: re-render, debounce
        /// the sidecar write (750ms per spec), debounce the undo commit.</summary>
        public void NotifyAdjustmentEdited()
        {
            if (!AdjustmentsReady) return;
            Renderer.RequestRender(Adjustments.Clone());
            ScheduleSidecarWrite();
            _undoTimer?.Dispose();
            _undoTimer = null;
            if (_adjustmentGesture != null)
            {
                AdjustmentEdited?.Invoke();
                return;
            }
            Timer? timer = null;
            timer = new Timer(_ => OnUi(() =>
            {
                // A disposed timer can already have a dispatcher callback
                // queued. It must not append a boundary after Undo or navigation.
                if (ReferenceEquals(_undoTimer, timer)) CommitUndoBoundary();
            }), null, UndoCommitQuietMs, Timeout.Infinite);
            _undoTimer = timer;
            AdjustmentEdited?.Invoke();
        }

        private void CommitUndoBoundary()
        {
            AdjustmentSettled?.Invoke();
            UndoHistoryLogic.CommitBoundary(_undoStack, _redoStack, ref _undoBaseline, Adjustments, UndoDepth);
        }

        /// <summary>Separate discrete mask operations from a pending slider/handle drag.</summary>
        public void CommitPendingAdjustmentGesture()
        {
            _undoTimer?.Dispose();
            _undoTimer = null;
            if (_undoBaseline is not null && XmpWriter.Fingerprint(_undoBaseline) !=
                XmpWriter.Fingerprint(Adjustments)) CommitUndoBoundary();
        }

        public void EndAdjustmentGesture()
        {
            if (_adjustmentGesture is null) return;
            _adjustmentGesture = null;
            CommitPendingAdjustmentGesture();
        }

        public void Undo()
        {
            if (!AdjustmentsReady) return;
            _adjustmentGesture = null;
            _undoTimer?.Dispose();
            _undoTimer = null;
            if (_undoBaseline != null && XmpWriter.Fingerprint(_undoBaseline) !=
                XmpWriter.Fingerprint(Adjustments))
                CommitUndoBoundary();
            if (_undoStack.Count == 0)
                return;
            var before = Adjustments;
            _redoStack.Add(Adjustments.Clone());
            Adjustments = _undoStack[^1];
            _undoStack.RemoveAt(_undoStack.Count - 1);
            _undoBaseline = Adjustments.Clone();
            AfterModelReplaced(before);
        }

        public void Redo()
        {
            if (!AdjustmentsReady) return;
            _adjustmentGesture = null;
            _undoTimer?.Dispose();
            _undoTimer = null;
            CommitUndoBoundary();
            if (_redoStack.Count == 0)
                return;
            var before = Adjustments;
            var next = _redoStack[^1];
            _redoStack.RemoveAt(_redoStack.Count - 1);
            // Push clears Redo, so the remaining entries are kept aside.
            var remainingRedo = _redoStack.ToArray();
            UndoHistoryLogic.Push(_undoStack, _redoStack, Adjustments.Clone(), UndoDepth);
            _redoStack.AddRange(remainingRedo);
            Adjustments = next;
            _undoBaseline = Adjustments.Clone();
            AfterModelReplaced(before);
        }

        /// <summary>RESET: back to canonical defaults with WB at the as-shot
        /// identity, as one discrete undoable step on top of whatever slider
        /// edit was still pending (#4764). A no-op on an unedited photo.</summary>
        public void ResetToDefaults()
        {
            if (!AdjustmentsReady) return;
            var before = Adjustments;
            if (!BeginModelReplacement(DefaultAdjustments()))
                return;
            if (before.LocalAdjustments.Any(layer => layer.Mask is BrushMask) && SelectedPhoto is { } photo)
            {
                var source = photo.IsCloud ? _cloudDoc : SidecarStore.Load(photo.FilePath);
                var containers = XmpBrushCorrections.PassthroughContainers(source);
                if (containers is not null)
                    _brushCorrectionsRemovedByReset[photo.FilePath] = containers;
            }
            SetBrushCorrectionDiscardPath(before.LocalAdjustments.Any(layer => layer.Mask is BrushMask)
                ? SelectedPhoto?.FilePath
                : null);
            Adjustments = _undoBaseline!.Clone();
            AfterModelReplaced(before);
        }

        /// <summary>Revert is not undo: restores the model loaded at open as
        /// one discrete undoable step (#4764). A no-op when already there.</summary>
        public void RevertToOriginal()
        {
            if (!AdjustmentsReady) return;
            if (_originalModel == null)
                return;
            var before = Adjustments;
            if (!BeginModelReplacement(_originalModel.Clone()))
                return;
            Adjustments = _undoBaseline!.Clone();
            AfterModelReplaced(before);
        }

        /// <summary>Shared Reset/Revert prologue: ends any live gesture and
        /// its quiet timer, commits the pending edit, then records the
        /// current model under the depth cap. On success the new baseline is
        /// <paramref name="next"/>; false means nothing changed.</summary>
        private bool BeginModelReplacement(AdjustmentState next)
        {
            _adjustmentGesture = null;
            _undoTimer?.Dispose();
            _undoTimer = null;
            AdjustmentSettled?.Invoke();
            return UndoHistoryLogic.ReplaceModel(
                _undoStack, _redoStack, ref _undoBaseline, Adjustments, next, UndoDepth);
        }

    }
}
