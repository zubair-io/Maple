using System;
using CommunityToolkit.Mvvm.ComponentModel;
using Maple.WinUI.Models;
using Maple.WinUI.Services;

namespace Maple.WinUI.ViewModels
{
    /// <summary>Imported lens profiles (#2435 / #3480): the selection, the
    /// master toggle and what the last decode resolved for this photo. Every
    /// write here is DECODE-OWNED — the profile is applied in the scene-linear
    /// decode stage — so it goes through <see cref="ApplyDecodeFieldEdit"/> as
    /// one discrete, undoable edit followed by one re-decode.</summary>
    public partial class EditSessionViewModel
    {
        private const string LensNotAssessed = "Lens corrections are assessed when the photo is decoded.";

        /// <summary>The core's verdict for the current sidecar selection on
        /// this RAW, published by the generation-guarded decode; null until
        /// then, after a failed decode, or when the core could not be asked.</summary>
        [ObservableProperty]
        private LensProfileResolution? _lensProfileResolution;

        /// <summary>The Lens panel's description line — the resolution's
        /// inventory, or the exact failure the decode reported.</summary>
        [ObservableProperty]
        private string _lensProfileMessage = LensNotAssessed;

        /// <summary>True when <see cref="LensProfileMessage"/> is an error the
        /// user has to act on (missing profile, mismatch, unsupported model)
        /// rather than an inventory.</summary>
        [ObservableProperty]
        private bool _lensProfileFailed;

        /// <summary>`crs:LensProfileEnable` — one undoable edit, one re-decode.</summary>
        public bool LensProfileEnabledOn
        {
            get => Adjustments.LensProfileEnable == ToggleMode.On;
            set
            {
                if (LensProfileEnabledOn == value)
                    return;
                ApplyDecodeFieldEdit(model =>
                    model.LensProfileEnable = value ? ToggleMode.On : ToggleMode.Off);
            }
        }

        /// <summary>Select an imported profile (`lcp1:` or `lcp1-ack:`), or
        /// pass "" to fall back to the DNG's embedded corrections only.</summary>
        public void SelectLensProfile(string reference)
        {
            if (SelectedPhoto == null || Adjustments.LensProfile == reference)
                return;
            ApplyDecodeFieldEdit(model => model.LensProfile = reference);
        }

        private void ResetLensProfileState()
        {
            LensProfileResolution = null;
            LensProfileFailed = false;
            LensProfileMessage = LensNotAssessed;
            ApplyLensCoverage(null);
        }

        private void PublishLensProfile(LensProfileResolution? resolution)
        {
            LensProfileResolution = resolution;
            LensProfileFailed = false;
            LensProfileMessage = resolution?.Describe()
                ?? "Lens corrections could not be assessed for this photo.";
            ApplyLensCoverage(resolution);
        }

        /// <summary>A decode that failed BECAUSE of the lens selection — the
        /// profile is not on this device, the camera or lens does not match,
        /// the model is unsupported — is the Lens panel's message, verbatim.
        /// Any other decode failure is DecodeStatus's alone.</summary>
        private void ReportLensProfileFailure(Exception error)
        {
            if (error is not LensProfileException)
                return;
            LensProfileResolution = null;
            LensProfileFailed = true;
            LensProfileMessage = error.Message;
            ApplyLensCoverage(null);
        }

        /// <summary>Enable each strength row for exactly the families the
        /// resolved calibration covers; nothing resolved = every row inert.</summary>
        private void ApplyLensCoverage(LensProfileResolution? resolution)
        {
            foreach (var slider in AdjustmentSections.Section(Sections, "Lens").Sliders)
            {
                slider.IsEnabled = slider.Label switch
                {
                    "Distortion" => resolution?.HasDistortion == true,
                    "Chromatic Aberration" => resolution?.HasCa == true,
                    _ => resolution?.HasVignetting == true,
                };
            }
        }
    }
}
