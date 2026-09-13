using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using Maple.WinUI.Models;
using Maple.WinUI.Services;

namespace Maple.WinUI.ViewModels
{
    /// <summary>Imported LCP (#2435 / #3480) and bundled Lensfun (#3564 /
    /// #3568) lens profiles: the selection, the master toggle, the profile
    /// dropdown's options, and what the last decode resolved for this photo.
    /// Every selection write here is DECODE-OWNED — the profile is applied in
    /// the scene-linear decode stage — so it goes through
    /// <see cref="ApplyDecodeFieldEdit"/> as one discrete, undoable edit
    /// followed by one re-decode, which in turn republishes
    /// <see cref="LensProfileResolution"/> and rebuilds the dropdown.</summary>
    public partial class EditSessionViewModel
    {
        private const string LensNotAssessed = "Lens corrections are assessed when the photo is decoded.";

        private static readonly LensProfileOption[] AutomaticOnlyOptions =
        {
            new(LensProfileChoiceLogic.AutomaticValue, "Automatic"),
        };

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

        /// <summary>The profile dropdown's options (#3568): Automatic first
        /// (labelled with the bundled Lensfun database's automatic match, or
        /// "no match"), every bundled lens this RAW's camera body can carry,
        /// and the imported profile the sidecar already names, if any.
        /// Rebuilt whenever the photo changes (a fresh
        /// <see cref="RefreshLensProfileChoices"/>) or the resolved selection
        /// changes (<see cref="PublishLensProfile"/>/<see cref="ResetLensProfileState"/>).</summary>
        [ObservableProperty]
        private IReadOnlyList<LensProfileOption> _lensProfileOptions = AutomaticOnlyOptions;

        /// <summary>The short source line under the dropdown — "Lensfun
        /// database &lt;version&gt; · CC BY-SA 3.0", "Imported profile",
        /// "Embedded corrections", or "No lens correction data". Mirrors
        /// Apple's `LensProfileChoice.sourceDescription`.</summary>
        [ObservableProperty]
        private string _lensProfileSourceLine = "No lens correction data";

        /// <summary>True while <see cref="RefreshLensProfileChoices"/> has an
        /// in-flight native round trip for the current photo — the dropdown
        /// disables itself the same way the white-balance preset combo does
        /// while sampling.</summary>
        [ObservableProperty]
        private bool _lensProfileChoicesLoading;

        /// <summary>True once there is something the master toggle can turn
        /// on — see <see cref="LensProfileChoiceLogic.IsAvailable"/>.</summary>
        public bool LensProfileIsAvailable =>
            LensProfileChoiceLogic.IsAvailable(LensProfileResolution, LensProfileOptions);

        /// <summary>Bumped by every reset/refresh so a compatible-lens/
        /// automatic-match round trip for an abandoned photo can never land
        /// on a newer one — the same generation-counter guard
        /// <see cref="DecodeCurrent"/> already uses for the decode itself.</summary>
        private int _lensChoicesGeneration;

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

        /// <summary>Select a dropdown option: Automatic (`""`), a bundled
        /// Lensfun pick (`lensfun1:&lt;slug&gt;`), or an imported profile
        /// (`lcp1:`/`lcp1-ack:`) the sidecar already names.</summary>
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
            RebuildLensProfileOptions();
        }

        private void PublishLensProfile(LensProfileResolution? resolution)
        {
            LensProfileResolution = resolution;
            LensProfileFailed = false;
            LensProfileMessage = resolution?.Describe()
                ?? "Lens corrections could not be assessed for this photo.";
            ApplyLensCoverage(resolution);
            RebuildLensProfileOptions();
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
            RebuildLensProfileOptions();
        }

        /// <summary>The last background compatible-lens/automatic-match
        /// round trip's result for the current photo — cached so a
        /// selection change (which only moves <see cref="LensProfileResolution"/>,
        /// via a re-decode) can rebuild the dropdown without a second native
        /// round trip. Reset in <see cref="RefreshLensProfileChoices"/>.</summary>
        private IReadOnlyList<CompatibleLens> _lensProfileCompatible = Array.Empty<CompatibleLens>();
        private LensProfileResolution? _lensProfileAutoMatch;

        /// <summary>Fetches the camera body's compatible-lens list and the
        /// automatic Lensfun match for <paramref name="photo"/> off the UI
        /// thread (both native calls resolve/decode-cache the RAW the same
        /// way <see cref="LensProfileStore.AssessForFile"/> does), then
        /// rebuilds the dropdown. Called from <see cref="DecodeCurrent"/> —
        /// keyed on the photo alone, not the selection: the compatible list
        /// and the automatic match depend only on the RAW's own camera/lens
        /// EXIF, never on which option is currently picked.</summary>
        private void RefreshLensProfileChoices(PhotoItem photo)
        {
            var generation = ++_lensChoicesGeneration;
            _lensProfileCompatible = Array.Empty<CompatibleLens>();
            _lensProfileAutoMatch = null;
            LensProfileChoicesLoading = true;
            RebuildLensProfileOptions();
            _ = Task.Run(() =>
            {
                var compatible = LensProfileStore.Compatible(photo.EditPath);
                var auto = LensProfileStore.AssessForFile(photo.EditPath, "");
                OnUi(() =>
                {
                    if (generation != _lensChoicesGeneration || !ReferenceEquals(SelectedPhoto, photo))
                        return;
                    _lensProfileCompatible = compatible;
                    _lensProfileAutoMatch = auto;
                    LensProfileChoicesLoading = false;
                    RebuildLensProfileOptions();
                });
            });
        }

        /// <summary>The pure recombination step
        /// (<see cref="LensProfileChoiceLogic.Build"/>) — no I/O, so every
        /// selection/resolution change can call it directly instead of
        /// re-fetching the compatible list or the automatic match.</summary>
        private void RebuildLensProfileOptions()
        {
            var built = LensProfileChoiceLogic.Build(
                Adjustments.LensProfile, _lensProfileAutoMatch, LensProfileResolution, _lensProfileCompatible);
            LensProfileOptions = built.Options;
            LensProfileSourceLine = built.SourceLine;
            OnPropertyChanged(nameof(LensProfileIsAvailable));
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
