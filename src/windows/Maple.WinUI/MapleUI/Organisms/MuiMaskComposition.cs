using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    public readonly record struct MuiMaskComponentRow(string Name, string Combine, bool Inverted, bool Selected);

    /// <summary>Ordered component controls. All writes are events to the mask session.</summary>
    public sealed class MuiMaskComposition : ContentControl
    {
        public event EventHandler<(bool Linear, string Combine)>? AddRequested;
        private EventHandler<int>? _selected;
        public event EventHandler<int>? Selected
        {
            add { _selected += value; UpdateActions(); }
            remove { _selected -= value; UpdateActions(); }
        }

        private void OnRowPressed(object? sender, EventArgs e)
        {
            if (sender is MuiListRow { Tag: int index }) _selected?.Invoke(this, index);
        }

        private void UpdateActions()
        {
            foreach (var child in _list.Children)
            {
                if (child is not MuiListRow row) continue;
                row.Pressed -= OnRowPressed;
                if (_selected != null) row.Pressed += OnRowPressed;
            }
        }
        public event EventHandler<int>? DeleteRequested;
        public event EventHandler<string>? CombineChanged;
        public event EventHandler<bool>? ComponentInverted;
        public event EventHandler<double>? OpacityChanged;
        public event EventHandler<bool>? GroupInverted;
        public event EventHandler? GestureStarted;
        public event EventHandler? GestureEnded;

        private readonly StackPanel _root = new() { Spacing = 8 };
        private readonly StackPanel _group = new() { Spacing = 8 };
        private readonly StackPanel _list = new() { Spacing = 2 };
        private readonly StackPanel _component = new() { Spacing = 8 };
        private readonly MuiCheckbox _componentInvert = new() { Label = "Invert component" };
        private readonly MuiCheckbox _groupInvert = new() { Label = "Invert mask group" };
        private readonly MuiDragBar _opacity = new() { Label = "Mask opacity", Minimum = 0, Maximum = 100, Step = 1 };
        private readonly Dictionary<string, MuiButton> _combineButtons = new();
        private readonly MuiSyncGate _syncGate = new();
        private MuiMaskComponentRow[] _rows = Array.Empty<MuiMaskComponentRow>();

        public MuiMaskComposition()
        {
            foreach (var combine in new[] { "Add", "Subtract", "Intersect" })
            {
                var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
                foreach (var linear in new[] { true, false })
                {
                    var shape = linear ? "linear" : "radial";
                    var add = new MuiButton { Label = $"{combine} {shape}", Variant = MuiButtonVariant.Secondary, ButtonSize = MuiButtonSize.Sm };
                    AutomationProperties.SetName(add, $"{combine} {shape} component to selected mask");
                    AutomationProperties.SetAutomationId(add, $"editor-mask-component-{combine.ToLowerInvariant()}-{shape}");
                    add.Click += (_, _) => AddRequested?.Invoke(this, (linear, combine));
                    row.Children.Add(add);
                }
                _root.Children.Add(row);
            }
            _group.Children.Add(_list);
            var modes = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            foreach (var combine in new[] { "Add", "Subtract", "Intersect" })
            {
                var button = new MuiButton { Label = combine, Variant = MuiButtonVariant.Secondary, ButtonSize = MuiButtonSize.Sm };
                AutomationProperties.SetName(button, $"Set selected component to {combine.ToLowerInvariant()}");
                button.Click += (_, _) => CombineChanged?.Invoke(this, combine);
                _combineButtons.Add(combine, button);
                modes.Children.Add(button);
            }
            _component.Children.Add(modes);
            _component.Children.Add(_componentInvert);
            _group.Children.Add(_component);
            _group.Children.Add(_opacity);
            _group.Children.Add(_groupInvert);
            _root.Children.Add(_group);
            Content = _root;
            _componentInvert.Checked += (_, _) => RaiseComponentInvert(true);
            _componentInvert.Unchecked += (_, _) => RaiseComponentInvert(false);
            _groupInvert.Checked += (_, _) => RaiseGroupInvert(true);
            _groupInvert.Unchecked += (_, _) => RaiseGroupInvert(false);
            _opacity.ValueChanged += (_, value) => { if (!_syncGate.IsSyncing) OpacityChanged?.Invoke(this, value / 100); };
            _opacity.GestureStarted += (_, _) => GestureStarted?.Invoke(this, EventArgs.Empty);
            _opacity.GestureEnded += (_, _) => GestureEnded?.Invoke(this, EventArgs.Empty);
            AutomationProperties.SetName(this, "Mask composition");
            AutomationProperties.SetAutomationId(this, "editor-mask-composition");
            AutomationProperties.SetAutomationId(_componentInvert, "editor-mask-component-invert");
            AutomationProperties.SetAutomationId(_opacity, "editor-mask-opacity");
            AutomationProperties.SetAutomationId(_groupInvert, "editor-mask-group-invert");
            Sync(Array.Empty<MuiMaskComponentRow>(), 1, false);
        }

        private void RaiseComponentInvert(bool invert)
        { if (!_syncGate.IsSyncing) ComponentInverted?.Invoke(this, invert); }
        private void RaiseGroupInvert(bool invert)
        { if (!_syncGate.IsSyncing) GroupInverted?.Invoke(this, invert); }

        private void RebuildRows(IReadOnlyList<MuiMaskComponentRow> rows)
        {
            _list.Children.Clear();
            for (var index = 0; index < rows.Count; index++)
            {
                var item = rows[index];
                var selectedIndex = index;
                var delete = new MuiButton { IconName = "trash", Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm, IsEnabled = rows.Count > 1 };
                AutomationProperties.SetName(delete, $"Delete {item.Name} component");
                delete.Click += (_, _) => DeleteRequested?.Invoke(this, selectedIndex);
                var row = new MuiListRow { Label = item.Name, Active = item.Selected, TrailingContent = delete, Tag = index };
                AutomationProperties.SetName(row, $"{item.Name}, {item.Combine.ToLowerInvariant()}{(item.Inverted ? ", inverted" : "")}");
                AutomationProperties.SetAutomationId(row, $"editor-mask-component-{index}");
                if (_selected != null) row.Pressed += OnRowPressed;
                _list.Children.Add(row);
            }
        }

        public void Sync(IReadOnlyList<MuiMaskComponentRow> rows, double opacity, bool inverted)
        {
            _syncGate.RunSynced(() =>
            {
                _group.Visibility = rows.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
                if (!_rows.SequenceEqual(rows))
                {
                    _rows = rows.ToArray();
                    RebuildRows(_rows);
                }
                var active = rows.FirstOrDefault(row => row.Selected);
                _component.Visibility = rows.Any(row => row.Selected) ? Visibility.Visible : Visibility.Collapsed;
                foreach (var pair in _combineButtons)
                    pair.Value.Variant = pair.Key == active.Combine ? MuiButtonVariant.Primary : MuiButtonVariant.Secondary;
                _componentInvert.IsChecked = active.Inverted;
                _opacity.Value = opacity * 100;
                _groupInvert.IsChecked = inverted;
            });
        }
    }
}
