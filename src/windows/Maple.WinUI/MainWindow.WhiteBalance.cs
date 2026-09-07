using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;
using Maple.WinUI.Generated;
using Maple.WinUI.Services;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    /// <summary>
    /// White-balance row of the Color › Basic panel (#2434): the eyedropper
    /// (arm, click a neutral on the canvas, Esc cancels), the nine-choice
    /// preset picker and the provenance readout. Built in code onto
    /// PanelProfileHost so it shows and hides with the Color group; the
    /// canvas half listens on ZoomHost beside the pan handlers — a release
    /// that barely moved is a pick, a drag is still a pan. The decision
    /// halves live in <see cref="WhiteBalancePickLogic"/> (click →
    /// normalised point) and <see cref="EditSessionViewModel"/>'s
    /// WhiteBalance partial (what a pick or a choice writes).
    /// </summary>
    public sealed partial class MainWindow
    {
        private readonly StackPanel _wbHost = new() { Spacing = 6, Margin = new Thickness(0, 6, 0, 0) };
        private readonly MuiActionButton _wbPickButton = new()
        {
            IconName = "eyedrop",
            Label = "Pick",
            ButtonSize = MuiActionButtonSize.Sm,
            HorizontalAlignment = HorizontalAlignment.Right,
        };
        private readonly ComboBox _wbPresetBox = new() { FontSize = 12, HorizontalAlignment = HorizontalAlignment.Stretch };
        private readonly TextBlock _wbProvenance = new() { FontSize = 11, TextWrapping = TextWrapping.Wrap };
        private readonly TextBlock _wbMessage = new()
        {
            FontSize = 11,
            TextWrapping = TextWrapping.Wrap,
            Visibility = Visibility.Collapsed,
        };
        private bool _wbPickArmed;
        private bool _wbSyncing;
        private Windows.Foundation.Point? _wbPressPoint;

        /// <summary>Called from BuildProfilePanel: the row sits under the
        /// profile picker, directly above the Temp/Tint sliders.</summary>
        private void BuildWhiteBalancePanel()
        {
            var muted = (Brush)Application.Current.Resources["MapleTextMuted"];
            var header = new Grid();
            header.Children.Add(new TextBlock
            {
                Text = "White balance",
                FontSize = 12,
                VerticalAlignment = VerticalAlignment.Center,
                Foreground = (Brush)Application.Current.Resources["MapleTextMain"],
            });
            ToolTipService.SetToolTip(_wbPickButton,
                "Pick white balance: click a neutral grey or white area in the photo (Esc cancels)");
            AutomationProperties.SetName(_wbPickButton, "Pick white balance");
            _wbPickButton.Click += (_, _) =>
            {
                if (_wbPickArmed) CancelWhiteBalancePick();
                else ArmWhiteBalancePick();
            };
            header.Children.Add(_wbPickButton);

            _wbPresetBox.ItemsSource = WhiteBalancePresets.Names;
            AutomationProperties.SetName(_wbPresetBox, "White balance preset");
            _wbPresetBox.SelectionChanged += (_, _) =>
            {
                if (_wbSyncing || _wbPresetBox.SelectedItem is not string name)
                    return;
                if (name != ViewModel.SelectedWhiteBalancePreset || name == WhiteBalancePresets.Auto)
                    ViewModel.ApplyWhiteBalancePreset(name);
            };

            _wbProvenance.Foreground = muted;
            AutomationProperties.SetName(_wbProvenance, "White balance provenance");
            _wbMessage.Foreground = muted;
            AutomationProperties.SetName(_wbMessage, "White balance message");
            AutomationProperties.SetLiveSetting(_wbMessage, AutomationLiveSetting.Polite);

            _wbHost.Children.Add(header);
            _wbHost.Children.Add(_wbPresetBox);
            _wbHost.Children.Add(_wbProvenance);
            _wbHost.Children.Add(_wbMessage);
            PanelProfileHost.Children.Add(_wbHost);

            ZoomHost.PointerPressed += OnWhiteBalancePointerPressed;
            ZoomHost.PointerReleased += OnWhiteBalancePointerReleased;
            ZoomHost.PointerCanceled += (_, _) => _wbPressPoint = null;
            ViewModel.PropertyChanged += (_, e) =>
            {
                if (e.PropertyName is nameof(ViewModel.IsWhiteBalanceSampling) or nameof(ViewModel.WhiteBalanceMessage))
                    SyncWhiteBalancePanel();
                else if (e.PropertyName == nameof(ViewModel.SelectedPhoto))
                    CancelWhiteBalancePick();
            };
            ViewModel.WhiteBalanceSampled += () =>
            {
                _wbPickArmed = false;
                SyncWhiteBalancePanel();
            };
            ViewModel.ModelSynced += SyncWhiteBalancePanel;
            ViewModel.AdjustmentEdited += SyncWhiteBalancePanel;
            SyncWhiteBalancePanel();
        }

        /// <summary>Only the Basic tab carries the Temp/Tint sliders the row
        /// belongs with; HSL and B&amp;W hide it (and disarm the eyedropper).</summary>
        private void ShowWhiteBalanceRow(bool visible)
        {
            _wbHost.Visibility = visible ? Visibility.Visible : Visibility.Collapsed;
            if (!visible)
                CancelWhiteBalancePick();
        }

        private void ArmWhiteBalancePick()
        {
            if (!ViewModel.CanSampleWhiteBalance)
            {
                ViewModel.WhiteBalanceMessage =
                    WhiteBalanceSampler.MessageFor(WhiteBalanceSampleFailure.UnsupportedAsset);
                SyncWhiteBalancePanel();
                return;
            }
            ViewModel.CancelWhiteBalanceSample();
            _wbPickArmed = true;
            SyncWhiteBalancePanel();
        }

        private void CancelWhiteBalancePick()
        {
            if (!_wbPickArmed)
                return;
            _wbPickArmed = false;
            _wbPressPoint = null;
            ViewModel.CancelWhiteBalanceSample();
            SyncWhiteBalancePanel();
        }

        private void OnWhiteBalancePointerPressed(object sender, PointerRoutedEventArgs e)
        {
            _wbPressPoint = _wbPickArmed ? e.GetCurrentPoint(this.Content).Position : null;
        }

        private void OnWhiteBalancePointerReleased(object sender, PointerRoutedEventArgs e)
        {
            if (!_wbPickArmed || _wbPressPoint is not { } start)
                return;
            _wbPressPoint = null;
            var end = e.GetCurrentPoint(this.Content).Position;
            if (!WhiteBalancePickLogic.IsClick(start.X, start.Y, end.X, end.Y))
                return;                                   // a pan, not a pick
            // CropRotateHost's space has the straighten rotation, the
            // committed-crop transform and the zoom undone; the image sits on
            // the fit footprint inside it — the uncropped, oriented frame the
            // sampler addresses.
            var local = e.GetCurrentPoint(CropRotateHost).Position;
            var point = ContentFitRect() is { } f
                ? WhiteBalancePickLogic.Normalize(local.X, local.Y, f.X, f.Y, f.W, f.H)
                : null;
            e.Handled = true;
            if (point is not { } p)
            {
                ViewModel.WhiteBalanceMessage =
                    WhiteBalanceSampler.MessageFor(WhiteBalanceSampleFailure.OutsideImage);
                return;
            }
            ViewModel.SampleWhiteBalance(p.X, p.Y);
        }

        private void SyncWhiteBalancePanel()
        {
            _wbSyncing = true;
            var hasPhoto = ViewModel.SelectedPhoto != null;
            var busy = ViewModel.IsWhiteBalanceSampling;
            var selected = Array.IndexOf(WhiteBalancePresets.Names, ViewModel.SelectedWhiteBalancePreset);
            if (_wbPresetBox.SelectedIndex != selected)
                _wbPresetBox.SelectedIndex = selected;
            _wbPresetBox.IsEnabled = hasPhoto && !busy;
            _wbPickButton.Selected = _wbPickArmed;
            _wbPickButton.IsEnabled = hasPhoto && !busy;
            _wbProvenance.Text = ViewModel.WhiteBalanceProvenanceText;
            var message = busy
                ? "Sampling white balance…"
                : ViewModel.WhiteBalanceMessage
                    ?? (_wbPickArmed ? "Click a neutral grey or white area in the photo. Esc cancels." : null);
            _wbMessage.Text = message ?? string.Empty;
            _wbMessage.Visibility = message == null ? Visibility.Collapsed : Visibility.Visible;
            _wbSyncing = false;
        }
    }
}
