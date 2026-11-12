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
            UpdateAutoProfileStatus(_autoProfileStatus.Publish(generation, decoded.AutoProfileOutcome));
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

        // Unresolved name-only Auto displays and renders As Shot until its pair lands (#4669).
        private static bool UntouchedWhiteBalance(AdjustmentState state) =>
            (state.ImportedWhiteBalance == null && state.WbSource == WbSource.AsShot
                || ImportedWhiteBalanceResolver.IsUnresolvedAuto(state))
            && Math.Abs(state.Temperature - 6500.0) < 1e-6 && Math.Abs(state.Tint) < 1e-6;

        /// <summary>Partial imports resolve before the decode; name-only Auto never
        /// delays the first frame and returns true to resolve after it (#4669).</summary>
        private static bool ResolveImportedWhiteBalanceBeforeDecode(PhotoItem photo, AdjustmentState model)
        {
            if (ImportedWhiteBalanceResolver.IsUnresolvedAuto(model)) return true;
            ImportedWhiteBalanceResolver.ResolveInPlace(photo.EditPath, model);
            return false;
        }

        /// <summary>Runs on the decode task after the first frame is published: one
        /// estimate from the shared decode, then one re-render with the pair. Failure
        /// leaves As Shot on screen; the next open retries (#4669).</summary>
        private void ResolveImportedAutoAfterFirstFrame(int generation, PhotoItem photo, AdjustmentState model)
        {
            try
            {
                ImportedWhiteBalanceResolver.ResolveInPlace(photo.EditPath, model);
            }
            catch (Exception)
            {
                return;
            }
            OnUi(() =>
            {
                if (_disposed || generation != _decodeGeneration) return;
                PublishImportedWhiteBalance(model);
                Renderer.RequestRender(Adjustments.Clone());
            });
        }

        private void PublishImportedWhiteBalance(AdjustmentState resolved)
        {
            foreach (var snapshot in new[] { Adjustments, _undoBaseline, _originalModel }
                .Concat(_undoStack).Concat(_redoStack))
            {
                if (snapshot != null) ImportedWhiteBalanceResolver.ApplyResolved(snapshot, resolved);
            }
            SyncSlidersFromModel();
        }

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
