using System;
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
            }
            // Untouched WB must use the decode-exported identity, otherwise
            // the delta-WB chain applies an unintended shift.
            if (UntouchedWhiteBalance(Adjustments) && decoded.DecodedTemperature > 0)
            {
                // As-shot normalization is file metadata, not an adjustment.
                // Keep untouched opening/undo snapshots at the same identity
                // so the first real edit cannot create a spurious WB boundary.
                foreach (var snapshot in new[] { Adjustments, _undoBaseline, _originalModel })
                {
                    if (snapshot == null || !UntouchedWhiteBalance(snapshot)) continue;
                    snapshot.Temperature = decoded.DecodedTemperature;
                    snapshot.Tint = decoded.DecodedTint;
                }
                SyncSlidersFromModel();
            }
            foreach (var section in Sections)
                foreach (var slider in section.Sliders) slider.RefreshDefaultValue();
            IsDecoding = false;
            DecodeStatus = string.Empty;
            Renderer.RequestRender(Adjustments.Clone());
        }

        private static bool UntouchedWhiteBalance(AdjustmentState state) =>
            Math.Abs(state.Temperature - 6500.0) < 1e-6 && Math.Abs(state.Tint) < 1e-6;
    }
}
