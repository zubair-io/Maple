using System;
using System.Collections.Generic;
using System.Linq;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private readonly StackPanel _repairPanel = new() { Spacing = 10 };
    private readonly ComboBox _repairKind = new() { Header = "Repair type", ItemsSource = Enum.GetNames<RetouchKind>(), HorizontalAlignment = HorizontalAlignment.Stretch };
    private readonly ListView _repairList = new() { MaxHeight = 160, SelectionMode = ListViewSelectionMode.Single };
    private readonly Button _repairAdd = new() { Content = "Add repair" };
    private readonly Button _repairDelete = new() { Content = "Delete selected repair" };
    private readonly TextBlock _repairStatus = new() { TextWrapping = TextWrapping.Wrap, FontSize = 12 };
    private readonly List<NumberBox> _repairValues = new();
    private int _repairSelection = -1;
    private bool _repairSyncing;

    private void OnRetouchTools(object sender, RoutedEventArgs e) => ToggleGroupPanel("Heal");

    private void BuildRetouchPanel()
    {
        _repairPanel.Children.Add(_repairStatus);
        _repairPanel.Children.Add(_repairAdd);
        _repairPanel.Children.Add(_repairList);
        _repairPanel.Children.Add(_repairKind);
        AutomationProperties.SetName(_repairList, "Repair spots");
        AutomationProperties.SetName(_repairKind, "Heal or Clone");
        _repairAdd.Click += (_, _) =>
        {
            if (!CanEditRepairs) return;
            var state = XmpRetouch.Add(ViewModel.Adjustments.Retouch, new(RetouchKind.Heal, .5, .5, .6, .5, .02));
            _repairSelection = state.Spots.Count - 1;
            ApplyRepairs(state);
        };
        _repairDelete.Click += (_, _) =>
        {
            if (!CanEditRepairs || SelectedRepair == null) return;
            var state = XmpRetouch.Remove(ViewModel.Adjustments.Retouch, _repairSelection);
            _repairSelection = Math.Min(_repairSelection, state.Spots.Count - 1);
            ApplyRepairs(state);
        };
        _repairList.SelectionChanged += (_, _) =>
        {
            if (_repairSyncing) return;
            _repairSelection = _repairList.SelectedIndex;
            SyncRetouchPanel();
        };
        _repairKind.SelectionChanged += (_, _) =>
        {
            if (!_repairSyncing && Enum.TryParse<RetouchKind>(_repairKind.SelectedItem as string, out var kind))
                EditRepair(spot => spot with { Kind = kind });
        };
        AddRepairValue("Size (% of image width)", s => s.Radius * 100, (s, v) => s with { Radius = v / 100 }, .01);
        AddRepairValue("Feather (%)", s => s.Feather * 100, (s, v) => s with { Feather = v / 100 });
        AddRepairValue("Opacity (%)", s => s.Opacity * 100, (s, v) => s with { Opacity = v / 100 });
        AddRepairValue("Destination X (%)", s => s.X * 100, (s, v) => s with { X = v / 100 });
        AddRepairValue("Destination Y (%)", s => s.Y * 100, (s, v) => s with { Y = v / 100 });
        AddRepairValue("Source X (%)", s => s.SourceX * 100, (s, v) => s with { SourceX = v / 100 });
        AddRepairValue("Source Y (%)", s => s.SourceY * 100, (s, v) => s with { SourceY = v / 100 });
        _repairPanel.Children.Add(_repairDelete);
        PanelRetouchHost.Children.Add(_repairPanel);
        SyncRetouchPanel();
    }

    private bool CanEditRepairs => ViewModel.AdjustmentsReady && !ViewModel.IsRasterSource;
    private RetouchSpot? SelectedRepair => _repairSelection >= 0 && _repairSelection < ViewModel.Adjustments.Retouch.Spots.Count
        ? ViewModel.Adjustments.Retouch.Spots[_repairSelection].Spot : null;

    private void AddRepairValue(string label, Func<RetouchSpot, double> read,
        Func<RetouchSpot, double, RetouchSpot> write, double minimum = 0)
    {
        var box = new NumberBox { Header = label, Minimum = minimum, Maximum = 100,
            SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Hidden, HorizontalAlignment = HorizontalAlignment.Stretch, Tag = read };
        AutomationProperties.SetName(box, label);
        box.ValueChanged += (_, args) =>
        {
            if (!_repairSyncing && double.IsFinite(args.NewValue)) EditRepair(spot => write(spot, args.NewValue));
        };
        _repairValues.Add(box);
        _repairPanel.Children.Add(box);
    }

    private void EditRepair(Func<RetouchSpot, RetouchSpot> edit)
    {
        if (!CanEditRepairs || SelectedRepair is not { } selected) return;
        var updated = edit(selected);
        if (updated == selected) return;
        try { ApplyRepairs(XmpRetouch.Replace(ViewModel.Adjustments.Retouch, _repairSelection, updated)); }
        catch (ArgumentOutOfRangeException)
        {
            SyncRetouchPanel();
            _repairStatus.Text = "This imported repair has coordinates outside the editable image range. Its original data has been preserved.";
        }
    }

    private void ApplyRepairs(RetouchState state)
    {
        if (state.Xml == ViewModel.Adjustments.Retouch.Xml) return;
        // One committed field/gesture is one undo entry and one cancellable
        // decode. Ordinary slider rendering remains independent.
        ViewModel.ApplyDecodeFieldEdit(model => model.Retouch = state);
        SyncRetouchPanel();
    }

    private void SyncRetouchPanel()
    {
        _repairSyncing = true;
        try
        {
            var state = ViewModel.Adjustments.Retouch;
            _repairSelection = Math.Min(_repairSelection, state.Spots.Count - 1);
            _repairList.ItemsSource = state.Spots.Select((entry, index) => $"{index + 1}. {entry.Spot.Kind}").ToArray();
            _repairList.SelectedIndex = _repairSelection;
            var selected = SelectedRepair;
            _repairKind.SelectedItem = selected?.Kind.ToString();
            _repairKind.IsEnabled = _repairDelete.IsEnabled = CanEditRepairs && selected != null;
            _repairAdd.IsEnabled = CanEditRepairs;
            foreach (var box in _repairValues)
            {
                box.IsEnabled = CanEditRepairs && selected != null;
                box.Value = selected == null ? double.NaN : ((Func<RetouchSpot, double>)box.Tag)(selected);
            }
            _repairStatus.Text = ViewModel.IsRasterSource ? "Repair requires a RAW image. Existing repair data is preserved."
                : "Heal blends source detail with destination colour. Clone copies the source. Coordinates refer to the full image.";
        }
        finally { _repairSyncing = false; }
    }
}
