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
    /// <summary>One selectable row in a Context Menu.</summary>
    public sealed record MuiContextMenuItem(
        string Id, string Label, string? IconName = null, bool Disabled = false, bool Destructive = false);

    /// <summary>One entry in a Context Menu's list — either an item or a
    /// divider marker (a null <see cref="Item"/>).</summary>
    public readonly record struct MuiContextMenuEntry(MuiContextMenuItem? Item)
    {
        public bool IsDivider => Item is null;
        public static MuiContextMenuEntry Divider() => new(null);
        public static MuiContextMenuEntry For(MuiContextMenuItem item) => new(item);
    }

    /// <summary>
    /// Maple.UI Context Menu molecule (unified-component-catalog.md §2.4,
    /// "Context Menu" row: "Keyboard-navigable action list", built from
    /// Popover, Icon, Text, Divider) — composes <see cref="MuiPopover"/> for
    /// anchoring/dismiss and layers a roving-highlight, arrow-key-navigable
    /// row list on top via <see cref="MuiMenuNavMath"/>.
    ///
    /// Ports `mui-context-menu.component.ts` 1:1: the active row resets to
    /// none on every (re)open, Up/Down skip disabled rows and dividers, and
    /// Enter activates whichever row currently carries the highlight.
    /// </summary>
    public sealed class MuiContextMenu : ContentControl
    {
        public static readonly DependencyProperty IsOpenProperty =
            DependencyProperty.Register(nameof(IsOpen), typeof(bool), typeof(MuiContextMenu),
                new PropertyMetadata(false, (d, _) => ((MuiContextMenu)d).OnIsOpenChanged()));

        public static readonly DependencyProperty PlacementProperty =
            DependencyProperty.Register(nameof(Placement), typeof(MuiPopoverPlacement), typeof(MuiContextMenu),
                new PropertyMetadata(MuiPopoverPlacement.Bottom, (d, e) => ((MuiContextMenu)d)._popover.Placement = (MuiPopoverPlacement)e.NewValue));

        public static readonly DependencyProperty EntriesProperty =
            DependencyProperty.Register(nameof(Entries), typeof(IReadOnlyList<MuiContextMenuEntry>), typeof(MuiContextMenu),
                new PropertyMetadata(null, (d, _) => ((MuiContextMenu)d).Rebuild()));

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

        public IReadOnlyList<MuiContextMenuEntry>? Entries
        {
            get => (IReadOnlyList<MuiContextMenuEntry>?)GetValue(EntriesProperty);
            set => SetValue(EntriesProperty, value);
        }

        public event EventHandler<string>? ItemSelected;
        public event EventHandler? CloseRequested;

        private readonly MuiPopover _popover = new();
        private readonly StackPanel _list = new() { Orientation = Orientation.Vertical, Spacing = 2, MinWidth = 180 };
        private int _activeIndex = -1;

        public MuiContextMenu()
        {
            Content = _popover;
            IsTabStop = false;
            IsHitTestVisible = false;

            _popover.PanelContent = _list;
            _popover.CloseRequested += (_, _) => CloseRequested?.Invoke(this, EventArgs.Empty);
            _list.KeyDown += OnKeyDown;

            Rebuild();
        }

        private void OnIsOpenChanged()
        {
            if (IsOpen) _activeIndex = -1; // a freshly (re)opened menu starts with no keyboard-active row
            _popover.IsOpen = IsOpen;
            RebuildHighlights();
        }

        private List<int> SelectableIndexes()
        {
            var result = new List<int>();
            var entries = Entries ?? Array.Empty<MuiContextMenuEntry>();
            for (var i = 0; i < entries.Count; i++)
                if (!entries[i].IsDivider && entries[i].Item!.Disabled == false)
                    result.Add(i);
            return result;
        }

        private void OnKeyDown(object sender, KeyRoutedEventArgs e)
        {
            var selectable = SelectableIndexes();
            if (e.Key == VirtualKey.Down)
            {
                e.Handled = true;
                if (selectable.Count > 0) SetActive(MuiMenuNavMath.MoveActive(_activeIndex, 1, selectable));
            }
            else if (e.Key == VirtualKey.Up)
            {
                e.Handled = true;
                if (selectable.Count > 0) SetActive(MuiMenuNavMath.MoveActive(_activeIndex, -1, selectable));
            }
            else if (e.Key == VirtualKey.Enter)
            {
                e.Handled = true;
                var entries = Entries ?? Array.Empty<MuiContextMenuEntry>();
                if (_activeIndex >= 0 && _activeIndex < entries.Count && !entries[_activeIndex].IsDivider)
                    SelectItem(entries[_activeIndex].Item!);
            }
        }

        private void SetActive(int index)
        {
            _activeIndex = index;
            RebuildHighlights();
        }

        private void SelectItem(MuiContextMenuItem item)
        {
            if (item.Disabled) return;
            ItemSelected?.Invoke(this, item.Id);
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Rebuild()
        {
            _list.Children.Clear();
            var entries = Entries ?? Array.Empty<MuiContextMenuEntry>();
            for (var i = 0; i < entries.Count; i++)
            {
                var entry = entries[i];
                if (entry.IsDivider)
                {
                    _list.Children.Add(new MuiDivider { Margin = new Thickness(0, 4, 0, 4) });
                    continue;
                }

                var item = entry.Item!;
                var row = BuildRow(item);
                _list.Children.Add(row);
            }
            RebuildHighlights();
        }

        private Border BuildRow(MuiContextMenuItem item)
        {
            var content = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            if (!string.IsNullOrEmpty(item.IconName))
                content.Children.Add(new MuiIcon
                {
                    IconName = item.IconName,
                    Size = MuiIconSize.Sm16,
                    IconColor = item.Destructive ? R("MapleErrorText") : null,
                });
            content.Children.Add(new MuiText
            {
                Text = item.Label,
                Variant = MuiTextVariant.RowLabel,
                ColorRole = item.Destructive ? MuiTextColorRole.Error : MuiTextColorRole.Main,
            });

            var row = new Border
            {
                CornerRadius = new CornerRadius(6),
                Padding = new Thickness(10, 7, 10, 7),
                Child = content,
                Opacity = item.Disabled ? 0.45 : 1.0,
            };
            row.PointerPressed += (_, _) => SelectItem(item);
            return row;
        }

        private void RebuildHighlights()
        {
            // Every entry adds exactly one child (a divider or a row) in
            // order, so the child index always matches the entry index —
            // no separate row-only counter needed.
            var entries = Entries ?? Array.Empty<MuiContextMenuEntry>();
            for (var i = 0; i < entries.Count && i < _list.Children.Count; i++)
            {
                if (entries[i].IsDivider) continue;
                if (_list.Children[i] is Border row)
                    row.Background = i == _activeIndex ? R("MapleSurfaceHover") : new SolidColorBrush(Microsoft.UI.Colors.Transparent);
            }
        }
    }
}
