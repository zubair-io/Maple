using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async void OnEditSliderValue(object sender, RoutedEventArgs e)
        => await RunModalFlowGuardedAsync(async () =>
    {
        if (sender is not FrameworkElement { DataContext: AdjustmentSliderViewModel slider }) return;
        var photo = ViewModel.SelectedPhoto;
        var number = new NumberBox
        {
            Value = slider.Value,
            Minimum = slider.Minimum,
            Maximum = slider.Maximum,
            SmallChange = slider.StepFrequency,
            SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Inline
        };
        AutomationProperties.SetName(number, slider.AccessibleName);
        number.Resources["TextControlBorderBrushFocused"] = Application.Current.Resources["MaplePrimary"];
        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot,
            Title = slider.AccessibleName,
            Content = number,
            PrimaryButtonText = "Apply",
            CloseButtonText = "Cancel",
            PrimaryButtonStyle = (Style)Application.Current.Resources["MuiButtonPrimaryStyle"],
            DefaultButton = ContentDialogButton.Primary
        };
        // ContentDialog applies its accent template to the default button,
        // including visual states that override PrimaryButtonStyle setters.
        foreach (var state in new[] { "", "PointerOver", "Pressed" })
        {
            dialog.Resources["AccentButtonBackground" + state] = Application.Current.Resources["MaplePrimary"];
            dialog.Resources["AccentButtonForeground" + state] = Application.Current.Resources["MapleTextMain"];
            dialog.Resources["AccentButtonBorderBrush" + state] = Application.Current.Resources["MaplePrimary"];
        }
        if (await dialog.ShowAsync() == ContentDialogResult.Primary && ReferenceEquals(photo, ViewModel.SelectedPhoto) && double.IsFinite(number.Value))
        {
            slider.Value = Math.Clamp(number.Value, slider.Minimum, slider.Maximum);
            slider.CommitDeferred();
        }
    });
}
