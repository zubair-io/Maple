using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async void OnEditSliderValue(object sender, RoutedEventArgs e)
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
        AutomationProperties.SetName(number, slider.Label);
        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot,
            Title = slider.Label,
            Content = number,
            PrimaryButtonText = "Apply",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Primary
        };
        if (await dialog.ShowAsync() == ContentDialogResult.Primary && ReferenceEquals(photo, ViewModel.SelectedPhoto) && double.IsFinite(number.Value))
        {
            slider.Value = Math.Clamp(number.Value, slider.Minimum, slider.Maximum);
            slider.CommitDeferred();
        }
    }
}
