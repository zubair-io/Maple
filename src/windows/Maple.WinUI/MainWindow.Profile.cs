using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;
using Maple.WinUI.Models;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        private readonly ComboBox _profilePicker = new() { MinWidth = 126, FontSize = 12, HorizontalAlignment = HorizontalAlignment.Right };
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
            PanelProfileHost.Children.Add(row);
            SyncProfilePanel();
            BuildWhiteBalancePanel();   // #2434 — MainWindow.WhiteBalance.cs
        }

        private void SyncProfilePanel()
        {
            var auto = ViewModel.Adjustments.Profile == ProfileMode.Auto;
            _profileSyncing = true;
            _profilePicker.SelectedIndex = auto ? 0 : 1;
            _profileSyncing = false;
            _profilePicker.IsEnabled = ViewModel.SelectedPhoto != null;
            ToolTipService.SetToolTip(_profilePicker, auto
                ? "Fits color and contrast to the camera's embedded preview. Uses Neutral when no preview is available."
                : "Uses the fixed AgX view transform without matching the embedded preview.");
        }
    }
}
