using System;
using Maple.WinUI.Services;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel
    {
        /// <summary>Publish per-file calibration and WB only while the same
        /// decode generation and photo still own the UI.</summary>
        private void ApplyDecodedState(int generation, PhotoItem photo, DecodedImage decoded)
        {
            if (generation != _decodeGeneration || !ReferenceEquals(SelectedPhoto, photo)) return;
            photo.CameraSupport = decoded.CameraSupport;
            LensProfileFacts = decoded.LensProfileFacts;
            LensProfileInfo = decoded.LensProfileFacts?.Description ?? "Lens correction data could not be assessed.";
            if (decoded.DecodedTemperature > 0)
            {
                _asShotTemperature = decoded.DecodedTemperature;
                _asShotTint = decoded.DecodedTint;
            }
            // Untouched WB must use the decode-exported identity, otherwise
            // the delta-WB chain applies an unintended shift.
            var untouchedWb = Math.Abs(Adjustments.Temperature - 6500.0) < 1e-6
                && Math.Abs(Adjustments.Tint) < 1e-6;
            if (untouchedWb && decoded.DecodedTemperature > 0)
            {
                Adjustments.Temperature = decoded.DecodedTemperature;
                Adjustments.Tint = decoded.DecodedTint;
                SyncSlidersFromModel();
            }
            IsDecoding = false;
            DecodeStatus = string.Empty;
            Renderer.RequestRender(Adjustments.Clone());
        }
    }
}
