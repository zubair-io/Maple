using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;
using Windows.System;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Command Menu molecule (unified-component-catalog.md §2.4,
    /// "Command Menu" row: "Searchable command palette", built from
    /// Popover, Input, Icon, Text) — an <see cref="MuiInput"/> filter on top
    /// of an anchored <see cref="MuiPopover"/> result list, filtering by
    /// substring match against each command's label via
    /// <see cref="MuiCommandMenuMath"/>.
    ///
    /// Ports `mui-command-menu.component.ts`: every (re)open starts from a
    /// clean search — the previous query never survives a close.
    /// </summary>
    public sealed class MuiCommandMenu : ContentControl
    {
        public static readonly DependencyProperty IsOpenProperty =
            DependencyProperty.Register(nameof(IsOpen), typeof(bool), typeof(MuiCommandMenu),
                new PropertyMetadata(false, (d, _) => ((MuiCommandMenu)d).OnIsOpenChanged()));

        public static readonly DependencyProperty PlacementProperty =
            DependencyProperty.Register(nameof(Placement), typeof(MuiPopoverPlacement), typeof(MuiCommandMenu),
                new PropertyMetadata(MuiPopoverPlacement.Bottom, (d, e) => ((MuiCommandMenu)d)._popover.Placement = (MuiPopoverPlacement)e.NewValue));

        public static readonly DependencyProperty CommandsProperty =
            DependencyProperty.Register(nameof(Commands), typeof(IReadOnlyList<MuiCommandItem>), typeof(MuiCommandMenu),
                new PropertyMetadata(null, (d, _) => ((MuiCommandMenu)d).RebuildList()));

        public static readonly DependencyProperty PlaceholderProperty =
            DependencyProperty.Register(nameof(Placeholder), typeof(string), typeof(MuiCommandMenu),
                new PropertyMetadata("Type a command", (d, e) => ((MuiCommandMenu)d)._search.Placeholder = (string)e.NewValue));

        public bool IsOpen
        {
            get => (bool)GetValue(IsOpenProperty);
            set => SetValue(IsOpenProperty, value);
        }

        public MuiPopoverPlacement Placement
        {
            get => (MuiPopoverPlacement)GetValue(PlacementProperty);
            set => SetValue(PlacementProperty, value);
        }

        public IReadOnlyList<MuiCommandItem>? Commands
        {
            get => (IReadOnlyList<MuiCommandItem>?)GetValue(CommandsProperty);
            set => SetValue(CommandsProperty, value);
        }

        public string Placeholder
        {
            get => (string)GetValue(PlaceholderProperty);
            set => SetValue(PlaceholderProperty, value);
        }

        public event EventHandler<string>? ItemSelected;
        public event EventHandler? CloseRequested;

        private readonly MuiPopover _popover = new();
        private readonly StackPanel _panel = new() { Orientation = Orientation.Vertical, Spacing = 6, MinWidth = 260 };
        private readonly MuiInput _search = new() { Variant = MuiInputVariant.Search, Placeholder = "Type a command" };
        private readonly StackPanel _list = new() { Orientation = Orientation.Vertical, Spacing = 2 };
        private string _query = string.Empty;
        private int _activeIndex;

        public MuiCommandMenu()
        {
            Content = _popover;
            IsTabStop = false;
            IsHitTestVisible = false;

            _panel.Children.Add(_search);
            _panel.Children.Add(_list);
            _popover.PanelContent = _panel;
            _popover.CloseRequested += (_, _) => CloseRequested?.Invoke(this, EventArgs.Empty);

            _search.TextChanged += (_, text) =>
            {
                _query = text;
                _activeIndex = 0;
                RebuildList();
            };
            _panel.KeyDown += OnKeyDown;

            RebuildList();
        }

        private void OnIsOpenChanged()
        {
            if (IsOpen)
            {
                _query = string.Empty;
                _activeIndex = 0;
                _search.Text = string.Empty;
            }
            _popover.IsOpen = IsOpen;
            RebuildList();
        }

        private IReadOnlyList<MuiCommandItem> Filtered() =>
            MuiCommandMenuMath.Filter(Commands ?? Array.Empty<MuiCommandItem>(), _query);

        private void OnKeyDown(object sender, KeyRoutedEventArgs e)
        {
            var filtered = Filtered();
            var clamped = MuiCommandMenuMath.ClampActiveIndex(_activeIndex, filtered.Count);
            if (e.Key == VirtualKey.Down)
            {
                e.Handled = true;
                if (filtered.Count > 0) SetActive(MuiMenuNavMath.WrapIndex(clamped, 1, filtered.Count));
            }
            else if (e.Key == VirtualKey.Up)
            {
                e.Handled = true;
                if (filtered.Count > 0) SetActive(MuiMenuNavMath.WrapIndex(clamped, -1, filtered.Count));
            }
            else if (e.Key == VirtualKey.Enter)
            {
                e.Handled = true;
                if (clamped >= 0 && clamped < filtered.Count) SelectItem(filtered[clamped]);
            }
        }

        private void SetActive(int index)
        {
            _activeIndex = index;
            RebuildHighlights();
        }

        private void SelectItem(MuiCommandItem item) => ItemSelected?.Invoke(this, item.Id);

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void RebuildList()
        {
            _list.Children.Clear();
            foreach (var command in Filtered())
                _list.Children.Add(BuildRow(command));
            RebuildHighlights();
        }

        private Border BuildRow(MuiCommandItem command)
        {
            var content = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            if (!string.IsNullOrEmpty(command.IconName))
                content.Children.Add(new MuiIcon { IconName = command.IconName, Size = MuiIconSize.Sm16 });
            content.Children.Add(new MuiText { Text = command.Label, Variant = MuiTextVariant.RowLabel });
            if (!string.IsNullOrEmpty(command.Shortcut))
                content.Children.Add(new MuiText { Text = command.Shortcut, Variant = MuiTextVariant.ValueChip });

            var row = new Border
            {
                CornerRadius = new CornerRadius(6),
                Padding = new Thickness(10, 7, 10, 7),
                Child = content,
            };
            row.PointerPressed += (_, _) => SelectItem(command);
            return row;
        }

        private void RebuildHighlights()
        {
            var clamped = MuiCommandMenuMath.ClampActiveIndex(_activeIndex, _list.Children.Count);
            for (var i = 0; i < _list.Children.Count; i++)
                if (_list.Children[i] is Border row)
                    row.Background = i == clamped ? R("MapleSurfaceHover") : new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        }
    }
}
