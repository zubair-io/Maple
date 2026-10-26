using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;
using Maple.WinUI.Models;
using Maple.WinUI.Services;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        private readonly ComboBox _profilePicker = new() { MinWidth = 126, FontSize = 12, HorizontalAlignment = HorizontalAlignment.Right };
        private readonly TextBlock _profileStatus = new() { FontSize = 11, TextWrapping = TextWrapping.Wrap, Visibility = Visibility.Collapsed };
        private bool _profileSyncing;

        private void BuildProfilePanel()
        {
            var row = new Grid();
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.Children.Add(new TextBlock
            {
                Text = "Profile",
                FontSize = 12,
                VerticalAlignment = VerticalAlignment.Center,
                Foreground = (Brush)Application.Current.Resources["MapleTextMuted"],
            });
            _profilePicker.ItemsSource = new[] { "Auto", "Neutral" };
            AutomationProperties.SetName(_profilePicker, "Render profile");
            _profilePicker.SelectionChanged += (_, _) =>
            {
                if (!_profileSyncing)
                    ViewModel.SelectProfile(_profilePicker.SelectedIndex == 1 ? ProfileMode.Neutral : ProfileMode.Auto);
            };
            Grid.SetColumn(_profilePicker, 1);
            row.Children.Add(_profilePicker);
            _profileStatus.Foreground = (Brush)Application.Current.Resources["MapleTextMuted"];
            AutomationProperties.SetLiveSetting(_profileStatus, AutomationLiveSetting.Polite);
            PanelProfileHost.Children.Add(row);
            PanelProfileHost.Children.Add(_profileStatus);
            ViewModel.PropertyChanged += (_, e) =>
            {
                if (!_closing && e.PropertyName is nameof(ViewModel.IsRasterSource) or nameof(ViewModel.AutoProfileOutcome))
                    SyncProfilePanel();
            };
            SyncProfilePanel();
            BuildWhiteBalancePanel();   // #2434 — MainWindow.WhiteBalance.cs
        }

        private void SyncProfilePanel()
        {
            var profile = ViewModel.Adjustments.Profile;
            var auto = profile == ProfileMode.Auto;
            _profileSyncing = true;
            _profilePicker.SelectedIndex = auto ? 0 : 1;
            _profileSyncing = false;
            _profilePicker.IsEnabled = ViewModel.SelectedPhoto != null && !ViewModel.IsRasterSource;
            ToolTipService.SetToolTip(_profilePicker, ViewModel.IsRasterSource
                ? "JPEG and TIFF keep their existing tone mapping and embedded color profile."
                : auto
                ? "Fits color and contrast to the camera's embedded preview. Uses Neutral when no preview is available."
                : "Uses the fixed AgX view transform without matching the embedded preview.");
            var outcome = ViewModel.IsRasterSource ? null : ViewModel.AutoProfileOutcome;
            AutomationProperties.SetHelpText(_profilePicker, AutoProfileStatus.Describe(profile, outcome));
            SyncProfileStatusLine(AutoProfileStatus.VisibleLine(profile, outcome));
        }

        private void SyncProfileStatusLine(string line)
        {
            if (_profileStatus.Text == line) return;
            _profileStatus.Text = line;
            AutomationProperties.SetName(_profileStatus, line);
            _profileStatus.Visibility = line.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
            if (line.Length > 0)
                FrameworkElementAutomationPeer.FromElement(_profileStatus)?.RaiseAutomationEvent(AutomationEvents.LiveRegionChanged);
        }
    }
}
