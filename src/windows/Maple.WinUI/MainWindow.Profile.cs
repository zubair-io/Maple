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
        private readonly MuiSegmentedToggle _profilePicker = new();
        private readonly TextBlock _profileDescription = new();

        private void BuildProfilePanel()
        {
            PanelProfileHost.Children.Add(new TextBlock
            {
                Text = "Profile", FontSize = 12,
                Foreground = (Brush)Application.Current.Resources["MapleTextMain"],
            });
            _profilePicker.Options = new[]
            {
                new MuiSegmentedToggleOption("Auto", "Auto render profile"),
                new MuiSegmentedToggleOption("Neutral", "Neutral render profile"),
            };
            AutomationProperties.SetName(_profilePicker, "Render profile");
            _profilePicker.SelectionChanged += (_, index) =>
                ViewModel.SelectProfile(index == 1 ? ProfileMode.Neutral : ProfileMode.Auto);
            PanelProfileHost.Children.Add(_profilePicker);
            _profileDescription.FontSize = 12;
            _profileDescription.TextWrapping = TextWrapping.Wrap;
            _profileDescription.Foreground = (Brush)Application.Current.Resources["MapleTextMuted"];
            PanelProfileHost.Children.Add(_profileDescription);
            SyncProfilePanel();
        }

        private void SyncProfilePanel()
        {
            var auto = ViewModel.Adjustments.Profile == ProfileMode.Auto;
            _profilePicker.SelectedIndex = auto ? 0 : 1;
            _profilePicker.IsEnabled = ViewModel.SelectedPhoto != null;
            _profileDescription.Text = auto
                ? "Fits color and contrast to the camera's embedded preview. Uses Neutral when no preview is available."
                : "Uses the fixed AgX view transform without matching the embedded preview.";
        }
    }
}
