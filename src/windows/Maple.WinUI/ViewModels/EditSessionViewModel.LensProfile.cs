using System;
using Maple.WinUI.Services;
using Maple.WinUI.Models;
using CommunityToolkit.Mvvm.ComponentModel;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel
    {
        [ObservableProperty] private string _lensProfileInfo = "Lens correction data has not been assessed.";
        [ObservableProperty] private LensProfileFacts? _lensProfileFacts;

        public void SelectLensProfile(string reference)
        {
            if (SelectedPhoto == null || Adjustments.LensProfile == reference) return;
            CommitLensCorrection(model => model.LensProfile = reference);
        }

        public void CommitLensCorrection(Action<AdjustmentState> edit)
        {
            if (SelectedPhoto == null) return;
            _undoTimer?.Dispose();
            _undoTimer = null;
            var before = Adjustments.Clone();
            if (_undoBaseline != null && XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = _undoBaseline })
                != XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = before })) CommitUndoBoundary();
            edit(Adjustments);
            CommitUndoBoundary();
            AfterModelReplaced(before);
        }
    }
}
