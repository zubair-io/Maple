using System;
using System.Linq;
using Maple.WinUI.Models;
using Maple.WinUI.Services;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel
    {
        internal AdjustmentState DefaultAdjustments() => new()
        {
            Temperature = _asShotTemperature,
            Tint = _asShotTint
        };

        /// <summary>Publish per-file calibration and WB only while the same
        /// decode generation and photo still own the UI.</summary>
        private void ApplyDecodedState(int generation, PhotoItem photo, DecodedImage decoded)
        {
            if (generation != _decodeGeneration || !ReferenceEquals(SelectedPhoto, photo)) return;
            PublishRasterCapabilities(decoded.IsRaster);
            photo.CameraSupport = decoded.CameraSupport;
            PublishLensProfile(decoded.LensProfile);   // #3480
            if (decoded.DecodedTemperature > 0)
            {
                _asShotTemperature = decoded.DecodedTemperature;
                _asShotTint = decoded.DecodedTint;
                NormalizeWhiteBalanceHistory();
            }
            foreach (var section in Sections)
                foreach (var slider in section.Sliders) slider.RefreshDefaultValue();
            IsDecoding = false;
            DecodeStatus = string.Empty;
            Renderer.RequestRender(Adjustments.Clone());
        }

        private static bool UntouchedWhiteBalance(AdjustmentState state) =>
            state.WbSource == WbSource.AsShot && Math.Abs(state.Temperature - 6500.0) < 1e-6 && Math.Abs(state.Tint) < 1e-6;

        private void NormalizeWhiteBalanceHistory()
        {
            var syncNeeded = UntouchedWhiteBalance(Adjustments);
            // Decode can finish after an edit has already entered either history stack.
            foreach (var snapshot in new[] { Adjustments, _undoBaseline, _originalModel }
                .Concat(_undoStack).Concat(_redoStack))
            {
                if (snapshot == null || !UntouchedWhiteBalance(snapshot)) continue;
                snapshot.Temperature = _asShotTemperature;
                snapshot.Tint = _asShotTint;
            }
            if (syncNeeded) SyncSlidersFromModel();
        }
    }
}
