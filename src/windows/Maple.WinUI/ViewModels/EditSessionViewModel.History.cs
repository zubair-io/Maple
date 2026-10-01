using System;
using System.Threading;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel
    {
        private bool _adjustmentGestureActive;
        // --- Adjustment edits ---

        /// <summary>Called by every slider on value change: re-render, debounce
        /// the sidecar write (750ms per spec), debounce the undo commit.</summary>
        public void NotifyAdjustmentEdited()
        {
            Renderer.RequestRender(Adjustments.Clone());
            ScheduleSidecarWrite();
            _undoTimer?.Dispose();
            _undoTimer = null;
            if (_adjustmentGestureActive)
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
            if (_undoBaseline == null)
                return;
            _undoStack.Add(_undoBaseline);
            if (_undoStack.Count > UndoDepth)
                _undoStack.RemoveAt(0);
            _redoStack.Clear();
            _undoBaseline = Adjustments.Clone();
        }

        /// <summary>Separate discrete mask operations from a pending slider/handle drag.</summary>
        public void CommitPendingAdjustmentGesture()
        {
            _undoTimer?.Dispose();
            _undoTimer = null;
            if (_undoBaseline is not null && XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = _undoBaseline }) !=
                XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = Adjustments })) CommitUndoBoundary();
        }

        public void BeginAdjustmentGesture()
        {
            if (_adjustmentGestureActive) return;
            CommitPendingAdjustmentGesture();
            _adjustmentGestureActive = true;
        }

        public void EndAdjustmentGesture()
        {
            if (!_adjustmentGestureActive) return;
            _adjustmentGestureActive = false;
            CommitPendingAdjustmentGesture();
        }

        public void Undo()
        {
            _adjustmentGestureActive = false;
            _undoTimer?.Dispose();
            _undoTimer = null;
            if (_undoBaseline != null && XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = _undoBaseline }) !=
                XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = Adjustments }))
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
            _adjustmentGestureActive = false;
            if (_redoStack.Count == 0)
                return;
            var before = Adjustments;
            _undoStack.Add(Adjustments.Clone());
            Adjustments = _redoStack[^1];
            _redoStack.RemoveAt(_redoStack.Count - 1);
            _undoBaseline = Adjustments.Clone();
            AfterModelReplaced(before);
        }

        /// <summary>RESET: back to canonical defaults with WB at the as-shot
        /// identity. Pushes the current state so it is undoable.</summary>
        public void ResetToDefaults()
        {
            var before = Adjustments;
            _undoStack.Add(Adjustments.Clone());
            Adjustments = new AdjustmentState
            {
                Temperature = _asShotTemperature,
                Tint = _asShotTint,
            };
            _undoBaseline = Adjustments.Clone();
            AfterModelReplaced(before);
        }

        /// <summary>Revert is not undo: pushes current onto the undo stack then
        /// restores the model loaded at open.</summary>
        public void RevertToOriginal()
        {
            if (_originalModel == null)
                return;
            var before = Adjustments;
            _undoStack.Add(Adjustments.Clone());
            Adjustments = _originalModel.Clone();
            _undoBaseline = Adjustments.Clone();
            AfterModelReplaced(before);
        }

    }
}
