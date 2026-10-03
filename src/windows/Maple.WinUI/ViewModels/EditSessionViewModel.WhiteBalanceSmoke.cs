using System;
using System.Linq;
using Maple.WinUI.Models;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    internal int VerifyEarlyWhiteBalanceHistory()
    {
        if (_asShotTemperature == 6500 && _asShotTint == 0) return 0;
        var model = Adjustments;
        var baseline = _undoBaseline;
        var opening = _originalModel;
        var undo = _undoStack.ToArray();
        var redo = _redoStack.ToArray();
        try
        {
            Prepare();
            ApplyDecodeFieldEdit(state => state.Exposure = .5);
            NormalizeWhiteBalanceHistory();
            Undo();
            AssertAsShot(Adjustments);
            if (Adjustments.Exposure != 0 || UndoCount != 0)
                throw new InvalidOperationException("Early Exposure Undo lost its original history boundary.");

            Prepare();
            ApplyDecodeFieldEdit(state => state.Exposure = .5);
            Undo();
            NormalizeWhiteBalanceHistory();
            Redo();
            AssertAsShot(Adjustments);
            if (Adjustments.Exposure != .5 || UndoCount != 1)
                throw new InvalidOperationException("Early Exposure Redo lost its edited history boundary.");

            foreach (var customTemperature in new[] { 7000d, 6500d })
            {
                Prepare();
                ApplyDecodeFieldEdit(state => WhiteBalanceProvenance.SetManualTemperature(state, customTemperature));
                NormalizeWhiteBalanceHistory();
                AssertManual();
                AssertAsShot(_originalModel!);
                Undo();
                AssertAsShot(Adjustments);
                Redo();
                AssertManual();

                void AssertManual()
                {
                    if (Adjustments.Temperature != customTemperature || Adjustments.Tint != 0 || Adjustments.WbSource != WbSource.Manual)
                        throw new InvalidOperationException("Late as-shot metadata or history overwrote early customized white balance.");
                }
            }
            return 4;
        }
        finally
        {
            _undoTimer?.Dispose();
            _undoTimer = null;
            Adjustments = model;
            _undoBaseline = baseline;
            _originalModel = opening;
            _undoStack.Clear();
            _undoStack.AddRange(undo);
            _redoStack.Clear();
            _redoStack.AddRange(redo);
            SyncSlidersFromModel();
            Renderer.RequestRender(Adjustments.Clone());
        }

        void Prepare()
        {
            _undoTimer?.Dispose();
            _undoTimer = null;
            Adjustments = new AdjustmentState();
            _undoBaseline = Adjustments.Clone();
            _originalModel = Adjustments.Clone();
            _undoStack.Clear();
            _redoStack.Clear();
            SyncSlidersFromModel();
        }

        void AssertAsShot(AdjustmentState state)
        {
            if (state.Temperature != _asShotTemperature || state.Tint != _asShotTint)
                throw new InvalidOperationException("Late as-shot metadata left stale white balance in history.");
        }
    }
}
