using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Toolbar molecule (unified-component-catalog.md §2.5,
    /// "Toolbar" row: "Row of actions with overflow", built from Action
    /// Button, Divider, Icon) — a row of <see cref="MuiActionButton"/>s;
    /// once the item entries exceed <see cref="MaxVisible"/> the rest
    /// collapse behind a trailing overflow button that opens an
    /// <see cref="MuiPopover"/> list, via <see cref="MuiToolbarMath"/>.
    ///
    /// Ports `mui-toolbar.component.ts`'s split contract. Toolbar entries
    /// carry no persisted "active" state (unlike a tool dock's own use of
    /// Action Button for the currently-armed tool) — each press is
    /// momentary, so the button's <see cref="MuiActionButton.Selected"/>
    /// toggle (inherited from wrapping a <see cref="Microsoft.UI.Xaml.Controls.Primitives.ToggleButton"/>)
    /// is reset immediately after firing <see cref="ItemSelected"/>.
    /// </summary>
    public sealed class MuiToolbar : ContentControl
    {
        public static readonly DependencyProperty EntriesProperty =
            DependencyProperty.Register(nameof(Entries), typeof(IReadOnlyList<MuiToolbarEntry>), typeof(MuiToolbar),
                new PropertyMetadata(null, (d, _) => ((MuiToolbar)d).Rebuild()));

        public static readonly DependencyProperty MaxVisibleProperty =
            DependencyProperty.Register(nameof(MaxVisible), typeof(int), typeof(MuiToolbar),
                new PropertyMetadata(int.MaxValue, (d, _) => ((MuiToolbar)d).Rebuild()));

        public IReadOnlyList<MuiToolbarEntry>? Entries
        {
            get => (IReadOnlyList<MuiToolbarEntry>?)GetValue(EntriesProperty);
            set => SetValue(EntriesProperty, value);
        }

        /// <summary>Item entries beyond this count move into the overflow
        /// popover. Dividers don't count against the budget.</summary>
        public int MaxVisible
        {
            get => (int)GetValue(MaxVisibleProperty);
            set => SetValue(MaxVisibleProperty, value);
        }

        public event EventHandler<string>? ItemSelected;

        private readonly StackPanel _root = new() { Orientation = Orientation.Horizontal, Spacing = 4 };
        private readonly StackPanel _visibleRow = new() { Orientation = Orientation.Horizontal, Spacing = 4 };
        private readonly Grid _overflowHost = new();
        private readonly MuiButton _overflowTrigger = new() { Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm, IconName = "ellipsis-horizontal" };
        private readonly MuiPopover _overflowPopover = new();
        private readonly StackPanel _overflowList = new() { Orientation = Orientation.Vertical, Spacing = 2, MinWidth = 180 };

        public MuiToolbar()
        {
            _overflowHost.Children.Add(_overflowTrigger);
            _overflowHost.Children.Add(_overflowPopover);

            _root.Children.Add(_visibleRow);
            _root.Children.Add(_overflowHost);
            Content = _root;
            IsTabStop = false;

            _overflowPopover.PanelContent = _overflowList;
            _overflowTrigger.Click += (_, _) => _overflowPopover.IsOpen = !_overflowPopover.IsOpen;
            _overflowPopover.CloseRequested += (_, _) => _overflowPopover.IsOpen = false;

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Press(MuiToolbarItem item)
        {
            if (item.Disabled) return;
            ItemSelected?.Invoke(this, item.Id);
        }

        private void SelectOverflow(MuiToolbarItem item)
        {
            if (item.Disabled) return;
            ItemSelected?.Invoke(this, item.Id);
            _overflowPopover.IsOpen = false;
        }

        private void Rebuild()
        {
            var split = MuiToolbarMath.Split(Entries ?? Array.Empty<MuiToolbarEntry>(), MaxVisible);

            _visibleRow.Children.Clear();
            foreach (var entry in split.Visible)
            {
                if (entry.IsDivider)
                {
                    _visibleRow.Children.Add(new MuiDivider { Orientation = MuiDividerOrientation.Vertical, Margin = new Thickness(2, 0, 2, 0) });
                    continue;
                }

                var item = entry.Item!;
                var button = new MuiActionButton { IconName = item.IconName, Label = item.Label, IsEnabled = !item.Disabled };
                button.Click += (_, _) =>
                {
                    button.Selected = false;
                    Press(item);
                };
                _visibleRow.Children.Add(button);
            }

            _overflowTrigger.Visibility = split.Overflow.Count > 0 ? Visibility.Visible : Visibility.Collapsed;

            _overflowList.Children.Clear();
            foreach (var item in split.Overflow)
                _overflowList.Children.Add(BuildOverflowRow(item));
        }

        private Border BuildOverflowRow(MuiToolbarItem item)
        {
            var content = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            content.Children.Add(new MuiIcon { IconName = item.IconName, Size = MuiIconSize.Sm16 });
            content.Children.Add(new MuiText { Text = item.Label, Variant = MuiTextVariant.RowLabel });

            var row = new Border
            {
                CornerRadius = new CornerRadius(6),
                Padding = new Thickness(10, 7, 10, 7),
                Child = content,
                Opacity = item.Disabled ? 0.45 : 1.0,
            };
            row.PointerPressed += (_, _) => SelectOverflow(item);
            row.PointerEntered += (_, _) => row.Background = R("MapleSurfaceHover");
            row.PointerExited += (_, _) => row.Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
            return row;
        }
    }
}
