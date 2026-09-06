using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Maple.UI;
using Maple.WinUI.Models;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        private readonly ToggleSwitch _lensEnabled = new() { Header = "Lens profile corrections" };
        private readonly MuiLivingSlider _lensDistortion = new() { Label = "Distortion", Minimum = 0, Maximum = 100, Step = 1, Unit = "%" };
        private readonly MuiLivingSlider _lensCa = new() { Label = "Chromatic aberration", Minimum = 0, Maximum = 100, Step = 1, Unit = "%" };
        private readonly MuiLivingSlider _lensVignetting = new() { Label = "Vignetting", Minimum = 0, Maximum = 100, Step = 1, Unit = "%" };
        private readonly Dictionary<MuiLivingSlider, PhotoItem?> _lensGestures = new();
        private PhotoItem? _lensPanelPhoto;
        private bool _syncingLensControls;

        private void BuildLensControls()
        {
            AutomationProperties.SetName(_lensEnabled, "Lens profile corrections");
            _lensEnabled.Toggled += (_, _) =>
            {
                if (!_syncingLensControls) ViewModel.CommitLensCorrection(model =>
                    model.LensProfileEnable = _lensEnabled.IsOn ? ToggleMode.On : ToggleMode.Off);
            };
            PanelLensProfileHost.Children.Add(_lensEnabled);
            AddLensSlider(_lensDistortion, (model, value) => model.LensCorrectionDistortion = value);
            AddLensSlider(_lensCa, (model, value) => model.LensCorrectionCa = value);
            AddLensSlider(_lensVignetting, (model, value) => model.LensCorrectionVignetting = value);
            SyncLensProfilePanel();
        }

        private void AddLensSlider(MuiLivingSlider slider, Action<AdjustmentState, double> write)
        {
            AutomationProperties.SetName(slider, slider.Label);
            // The slider retains its own in-progress value. Decode and XMP change
            // once on release, including keyboard, reset, and lost-capture paths.
            slider.ValueChanged += (_, _) => _lensGestures[slider] = ViewModel.SelectedPhoto;
            void Commit()
            {
                if (!_lensGestures.Remove(slider, out var photo) || photo == null
                    || !ReferenceEquals(photo, ViewModel.SelectedPhoto)) return;
                var value = slider.Value;
                ViewModel.CommitLensCorrection(model => write(model, value));
            }
            slider.AddHandler(UIElement.PointerReleasedEvent, new PointerEventHandler((_, _) => Commit()), true);
            slider.AddHandler(UIElement.PointerCaptureLostEvent, new PointerEventHandler((_, _) => Commit()), true);
            slider.AddHandler(UIElement.KeyUpEvent, new KeyEventHandler((_, _) => Commit()), true);
            slider.AddHandler(UIElement.DoubleTappedEvent, new DoubleTappedEventHandler((_, _) => Commit()), true);
            slider.LostFocus += (_, _) => Commit();
            PanelLensProfileHost.Children.Add(slider);
        }

        private void SyncLensProfilePanel()
        {
            if (!ReferenceEquals(_lensPanelPhoto, ViewModel.SelectedPhoto))
            {
                _lensPanelPhoto = ViewModel.SelectedPhoto;
                _lensGestures.Clear();
                _lensProfileMessage.Text = "";
            }
            var model = ViewModel.Adjustments;
            var facts = ViewModel.LensProfileFacts;
            _syncingLensControls = true;
            try
            {
                _lensEnabled.IsOn = model.LensProfileEnable == ToggleMode.On;
                _lensEnabled.IsEnabled = facts != null && (facts.Distortion || facts.Ca || facts.Vignetting);
                _lensDistortion.Value = model.LensCorrectionDistortion;
                _lensCa.Value = model.LensCorrectionCa;
                _lensVignetting.Value = model.LensCorrectionVignetting;
                _lensDistortion.IsEnabled = facts?.Distortion == true;
                _lensCa.IsEnabled = facts?.Ca == true;
                _lensVignetting.IsEnabled = facts?.Vignetting == true;
                _clearLensProfile.IsEnabled = !string.IsNullOrEmpty(model.LensProfile);
            }
            finally { _syncingLensControls = false; }
        }
    }
}
