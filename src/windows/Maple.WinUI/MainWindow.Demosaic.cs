using System;
using System.Linq;
using Maple.WinUI.Models;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private readonly ComboBox _demosaicPicker = new() { HorizontalAlignment = HorizontalAlignment.Stretch, FontSize = 12 };
    private readonly TextBlock _demosaicStatus = new() { TextWrapping = TextWrapping.Wrap, FontSize = 12, Margin = new Thickness(0,4,0,8) };
    private bool _demosaicSyncing;

    private void BuildDemosaicPanel()
    {
        _demosaicPicker.Header = "Demosaic";
        _demosaicPicker.ItemsSource = Enum.GetNames<DemosaicChoice>();
        AutomationProperties.SetName(_demosaicPicker, "Full-resolution Bayer demosaic");
        _demosaicPicker.SelectionChanged += (_, _) =>
        {
            if (!_demosaicSyncing && _demosaicPicker.SelectedItem is string choice
                && ViewModel.SelectedPhoto?.CameraSupport?.SensorLayout == "bayer"
                && choice != ViewModel.Adjustments.Demosaic)
                ViewModel.ApplyDecodeFieldEdit(model => model.Demosaic = choice);
        };
        PanelDetailHeader.Children.Insert(0, _demosaicStatus);
        PanelDetailHeader.Children.Insert(0, _demosaicPicker);
        SyncDemosaicPanel();
    }

    private void SyncDemosaicPanel()
    {
        var choice = ViewModel.Adjustments.Demosaic;
        var known = Enum.GetNames<DemosaicChoice>().Contains(choice);
        var layout = ViewModel.SelectedPhoto?.CameraSupport?.SensorLayout;
        _demosaicSyncing = true;
        _demosaicPicker.SelectedItem = known ? choice : null;
        _demosaicPicker.IsEnabled = layout == "bayer";
        _demosaicStatus.Text = layout switch
        {
            "bayer" => "Applies to full-resolution detail and export. The fast fit-view preview uses a fixed binned kernel.",
            "xtrans" => "X-Trans uses its own demosaic; Bayer kernel selection does not apply.",
            "linear_rgb" => "LinearRaw is already demosaiced; no Bayer kernel is used.",
            _ => "Demosaic choices become available after a Bayer RAW is decoded.",
        };
        if (!known) _demosaicStatus.Text += $" Imported choice ‘{choice}’ is preserved. Choose a supported option to replace it.";
        _demosaicSyncing = false;
    }
}
