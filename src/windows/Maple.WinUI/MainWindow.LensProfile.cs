using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;
using Maple.WinUI.Models;
using Maple.WinUI.Services;

namespace Maple.WinUI
{
    /// <summary>The Lens group's profile block (#2435 / #3480): master
    /// toggle, import / clear, the current selection and what the decode
    /// resolved. The three strength rows below it are ordinary
    /// commit-on-release slider rows (AdjustmentSections "Lens").</summary>
    public sealed partial class MainWindow
    {
        private readonly ToggleSwitch _lensProfileToggle = new()
        {
            OnContent = "Lens profile corrections", OffContent = "Lens profile corrections", FontSize = 11,
        };
        private readonly MuiButton _importLensProfile = new()
        {
            Label = "Import lens profile…", Variant = MuiButtonVariant.Secondary, ButtonSize = MuiButtonSize.Sm,
        };
        private readonly MuiButton _clearLensProfile = new()
        {
            Label = "Use embedded only", Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm,
        };
        private readonly MuiText _lensProfileSelection = new() { Variant = MuiTextVariant.Body };
        private readonly MuiText _lensProfileDescription = new()
        {
            Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted,
        };
        private readonly MuiStatusText _lensProfileStatus = new() { Visibility = Visibility.Collapsed };
        private bool _syncingLensPanel;

        private void BuildLensPanel()
        {
            PanelLensHost.Children.Add(new TextBlock
            {
                Text = "Lens profile", FontSize = 12,
                Foreground = (Brush)Application.Current.Resources["MapleTextMain"],
            });
            AutomationProperties.SetName(_lensProfileToggle, "Lens profile corrections toggle");
            _lensProfileToggle.Toggled += (_, _) =>
            {
                if (!_syncingLensPanel)
                    ViewModel.LensProfileEnabledOn = _lensProfileToggle.IsOn;
            };
            PanelLensHost.Children.Add(_lensProfileToggle);

            AutomationProperties.SetName(_importLensProfile, "Import lens profile");
            AutomationProperties.SetName(_clearLensProfile, "Use embedded lens corrections only");
            _importLensProfile.Click += async (_, _) => await ImportLensProfileAsync();
            _clearLensProfile.Click += (_, _) => ViewModel.SelectLensProfile("");
            var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
            buttons.Children.Add(_importLensProfile);
            buttons.Children.Add(_clearLensProfile);
            PanelLensHost.Children.Add(buttons);

            PanelLensHost.Children.Add(_lensProfileSelection);
            PanelLensHost.Children.Add(_lensProfileDescription);
            PanelLensHost.Children.Add(_lensProfileStatus);
            ViewModel.PropertyChanged += (_, e) =>
            {
                if (e.PropertyName is nameof(ViewModel.LensProfileResolution)
                    or nameof(ViewModel.LensProfileMessage) or nameof(ViewModel.LensProfileFailed))
                    SyncLensPanel();
            };
            SyncLensPanel();
        }

        private void SyncLensPanel()
        {
            var model = ViewModel.Adjustments;
            var hasPhoto = ViewModel.SelectedPhoto != null;
            _syncingLensPanel = true;
            try
            {
                _lensProfileToggle.IsOn = model.LensProfileEnable == ToggleMode.On;
                _lensProfileToggle.IsEnabled = hasPhoto;
                _importLensProfile.IsEnabled = hasPhoto;
                _clearLensProfile.IsEnabled = hasPhoto && !string.IsNullOrEmpty(model.LensProfile);
                _lensProfileSelection.Text = DescribeLensSelection(model.LensProfile);
                var failed = ViewModel.LensProfileFailed;
                _lensProfileDescription.Text = failed ? string.Empty : ViewModel.LensProfileMessage;
                _lensProfileDescription.Visibility = failed ? Visibility.Collapsed : Visibility.Visible;
                if (failed)
                {
                    _lensProfileStatus.State = MuiStatusTextState.Error;
                    _lensProfileStatus.Text = ViewModel.LensProfileMessage;
                    _lensProfileStatus.Visibility = Visibility.Visible;
                }
                else if (_lensProfileStatus.State == MuiStatusTextState.Error)
                {
                    _lensProfileStatus.Visibility = Visibility.Collapsed;
                }
            }
            finally { _syncingLensPanel = false; }
        }

        private static string DescribeLensSelection(string reference)
        {
            if (string.IsNullOrEmpty(reference))
                return "No imported profile — embedded DNG corrections only.";
            try
            {
                var digest = LensProfileStore.Digest(reference);
                return LensProfileStore.IsAcknowledged(reference)
                    ? $"Imported profile {digest[..12]}… (approximations accepted)"
                    : $"Imported profile {digest[..12]}…";
            }
            catch (LensProfileException)
            {
                // A foreign sidecar naming a reference version this build
                // cannot read: the decode reports the same thing as an error.
                return "Unsupported lens profile reference in the sidecar.";
            }
        }

        private async Task ImportLensProfileAsync()
        {
            var photo = ViewModel.SelectedPhoto;
            if (photo == null) return;
            var picker = new Windows.Storage.Pickers.FileOpenPicker();
            picker.FileTypeFilter.Add(".lcp");
            WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
            var file = await picker.PickSingleFileAsync();
            if (file == null || !ReferenceEquals(photo, ViewModel.SelectedPhoto)) return;
            _importLensProfile.IsLoading = true;
            _lensProfileStatus.State = MuiStatusTextState.Saving;
            _lensProfileStatus.Text = "Reading lens profile…";
            _lensProfileStatus.Visibility = Visibility.Visible;
            try
            {
                var imported = await Task.Run(() => LensProfileStore.Import(file.Path, photo.EditPath));
                if (!ReferenceEquals(photo, ViewModel.SelectedPhoto)) return;
                _lensProfileStatus.Visibility = Visibility.Collapsed;
                var reference = await ConfirmLensProfileAsync(imported);
                if (reference != null && ReferenceEquals(photo, ViewModel.SelectedPhoto))
                    ViewModel.SelectLensProfile(reference);
            }
            catch (Exception error) when (error is LensProfileException or IOException or UnauthorizedAccessException)
            {
                if (!ReferenceEquals(photo, ViewModel.SelectedPhoto)) return;
                _lensProfileStatus.State = MuiStatusTextState.Error;
                _lensProfileStatus.Text = error.Message;
                _lensProfileStatus.Visibility = Visibility.Visible;
            }
            finally { _importLensProfile.IsLoading = false; }
        }

        /// <summary>Show the resolver's evidence and let the user choose. An
        /// in-range match returns `lcp1:`; an approximate one returns
        /// `lcp1-ack:` only once the separate acceptance box is ticked. A
        /// camera/lens mismatch or unsupported model never reaches here —
        /// <see cref="LensProfileStore.Import"/> already threw — so
        /// acceptance can only ever cover approximation. Null = cancelled.</summary>
        private async Task<string?> ConfirmLensProfileAsync(ImportedLensProfile imported)
        {
            var resolution = imported.Resolution;
            var body = new StackPanel { Spacing = 8, MinWidth = 360 };
            void Row(string label, string value)
            {
                var grid = new Grid { ColumnSpacing = 12 };
                grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                grid.Children.Add(new MuiText { Text = label, Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted });
                var text = new MuiText { Text = value, Variant = MuiTextVariant.Body, HorizontalAlignment = HorizontalAlignment.Right };
                Grid.SetColumn(text, 1);
                grid.Children.Add(text);
                body.Children.Add(grid);
            }
            void Line(string text, MuiTextColorRole role) =>
                body.Children.Add(new MuiText { Text = text, Variant = MuiTextVariant.Body, ColorRole = role });

            Row("Profile", imported.Name);
            Row("Camera", string.Join(" ", new[] { imported.Make, imported.Camera }.Where(s => s.Length > 0)));
            Row("Lens", imported.Lens.Length > 0 ? imported.Lens : "—");
            Row("Calibrations", imported.SampleCount.ToString());
            Row("Match", resolution.Embedded ? "Embedded corrections take priority"
                : resolution.Approximate ? "Approximate (outside the calibrated range)"
                : "In range");
            if (resolution.Imported)
            {
                Row("Covers", string.Join(", ", new[]
                {
                    resolution.HasDistortion ? "distortion" : null,
                    resolution.HasCa ? "chromatic aberration" : null,
                    resolution.HasVignetting ? "vignetting" : null,
                }.Where(f => f != null)) is { Length: > 0 } covered ? covered : "no supported family");
                foreach (var sample in resolution.Samples)
                    Line(DescribeSample(sample), MuiTextColorRole.Muted);
            }
            foreach (var approximation in resolution.Approximations)
                Line("Approximation: " + approximation, MuiTextColorRole.Warning);
            foreach (var unsupported in resolution.Unsupported)
                Line("Unsupported: " + unsupported, MuiTextColorRole.Error);

            var applicable = resolution.Imported && resolution.CoversAnyFamily;
            if (resolution.Embedded)
                Line("This DNG carries its own lens corrections, which always win. The profile was stored but cannot apply here.", MuiTextColorRole.Muted);
            else if (!applicable)
                Line("None of this profile's calibration models are supported, so it cannot apply.", MuiTextColorRole.Error);

            var accept = new MuiCheckbox { Label = "Accept the reported approximations and use the profile anyway" };
            AutomationProperties.SetName(accept, "Accept lens profile approximations");
            accept.Visibility = applicable && resolution.Approximate ? Visibility.Visible : Visibility.Collapsed;
            body.Children.Add(accept);

            var dialog = new ContentDialog
            {
                XamlRoot = Content.XamlRoot,
                Title = "Use lens profile",
                Content = new ScrollViewer { Content = body, MaxHeight = 480 },
                PrimaryButtonText = "Use profile",
                CloseButtonText = applicable ? "Cancel" : "Close",
                IsPrimaryButtonEnabled = applicable && !resolution.Approximate,
            };
            accept.Checked += (_, _) => dialog.IsPrimaryButtonEnabled = applicable;
            accept.Unchecked += (_, _) => dialog.IsPrimaryButtonEnabled = applicable && !resolution.Approximate;
            accept.Indeterminate += (_, _) => dialog.IsPrimaryButtonEnabled = applicable && !resolution.Approximate;
            if (await dialog.ShowAsync() != ContentDialogResult.Primary || !applicable)
                return null;
            return resolution.Approximate && accept.IsChecked == true
                ? imported.AcknowledgedReference
                : resolution.Approximate ? null : imported.Reference;
        }

        private static string DescribeSample(LensProfileSample sample)
        {
            var family = sample.Family switch
            {
                "ca" => "Chromatic aberration",
                "vignetting" => "Vignetting",
                _ => "Distortion",
            };
            var parts = new List<string> { $"{sample.FocalMm:0.#} mm" };
            if (sample.ApertureApex is { } apex) parts.Add($"f/{Math.Pow(2, apex / 2):0.#}");
            if (sample.FocusM is { } focus) parts.Add($"{focus:0.##} m");
            return $"{family}: {string.Join(" · ", parts)} · weight {sample.Weight:0.###}";
        }
    }
}
