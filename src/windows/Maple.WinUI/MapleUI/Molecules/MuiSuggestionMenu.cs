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
    /// <summary>One row in a Suggestion Menu (e.g. an @-mention candidate).</summary>
    public sealed record MuiSuggestionItem(string Id, string Label, string? IconName = null, string? Meta = null);

    /// <summary>
    /// Maple.UI Suggestion Menu molecule (unified-component-catalog.md
    /// §2.4, "Suggestion Menu" row: "Query-driven autocomplete list", built
    /// from Popover, Icon, Text) — composes <see cref="MuiPopover"/>; the
    /// caller already filters <see cref="Items"/> by the live query text
    /// (this owns only the anchored presentation and keyboard/mouse
    /// selection, matching `mui-suggestion-menu.component.ts`'s own split).
    ///
    /// Every (re)open or re-filter highlights row 0 — "Enter picks the top
    /// match" per the usual @-mention/autocomplete convention — without the
    /// caller having to manage that state itself.
    /// </summary>
    public sealed class MuiSuggestionMenu : ContentControl
    {
        public static readonly DependencyProperty IsOpenProperty =
            DependencyProperty.Register(nameof(IsOpen), typeof(bool), typeof(MuiSuggestionMenu),
                new PropertyMetadata(false, (d, _) => ((MuiSuggestionMenu)d).OnIsOpenChanged()));

        public static readonly DependencyProperty PlacementProperty =
            DependencyProperty.Register(nameof(Placement), typeof(MuiPopoverPlacement), typeof(MuiSuggestionMenu),
                new PropertyMetadata(MuiPopoverPlacement.Bottom, (d, e) => ((MuiSuggestionMenu)d)._popover.Placement = (MuiPopoverPlacement)e.NewValue));

        public static readonly DependencyProperty ItemsProperty =
            DependencyProperty.Register(nameof(Items), typeof(IReadOnlyList<MuiSuggestionItem>), typeof(MuiSuggestionMenu),
                new PropertyMetadata(null, (d, _) => ((MuiSuggestionMenu)d).OnItemsChanged()));

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

        public IReadOnlyList<MuiSuggestionItem>? Items
        {
            get => (IReadOnlyList<MuiSuggestionItem>?)GetValue(ItemsProperty);
            set => SetValue(ItemsProperty, value);
        }

        public event EventHandler<string>? ItemSelected;
        public event EventHandler? CloseRequested;

        private readonly MuiPopover _popover = new();
        private readonly StackPanel _list = new() { Orientation = Orientation.Vertical, Spacing = 2, MinWidth = 200 };
        private int _activeIndex;

        public MuiSuggestionMenu()
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
            if (IsOpen) _activeIndex = 0;
            _popover.IsOpen = IsOpen;
            RebuildHighlights();
        }

        private void OnItemsChanged()
        {
            if (IsOpen) _activeIndex = 0;
            Rebuild();
        }

        private int Count => Items?.Count ?? 0;

        private void OnKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (Count == 0) return;
            if (e.Key == VirtualKey.Down)
            {
                e.Handled = true;
                SetActive(MuiMenuNavMath.WrapIndex(_activeIndex, 1, Count));
            }
            else if (e.Key == VirtualKey.Up)
            {
                e.Handled = true;
                SetActive(MuiMenuNavMath.WrapIndex(_activeIndex, -1, Count));
            }
            else if (e.Key == VirtualKey.Enter)
            {
                e.Handled = true;
                if (_activeIndex < Count) SelectItem(Items![_activeIndex]);
            }
        }

        private void SetActive(int index)
        {
            _activeIndex = index;
            RebuildHighlights();
        }

        private void SelectItem(MuiSuggestionItem item) => ItemSelected?.Invoke(this, item.Id);

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Rebuild()
        {
            _list.Children.Clear();
            foreach (var item in Items ?? Array.Empty<MuiSuggestionItem>())
                _list.Children.Add(BuildRow(item));
            RebuildHighlights();
        }

        private Border BuildRow(MuiSuggestionItem item)
        {
            var content = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            if (!string.IsNullOrEmpty(item.IconName))
                content.Children.Add(new MuiIcon { IconName = item.IconName, Size = MuiIconSize.Sm16 });
            content.Children.Add(new MuiText { Text = item.Label, Variant = MuiTextVariant.RowLabel });
            if (!string.IsNullOrEmpty(item.Meta))
                content.Children.Add(new MuiText { Text = item.Meta, Variant = MuiTextVariant.ValueChip });

            var row = new Border
            {
                CornerRadius = new CornerRadius(6),
                Padding = new Thickness(10, 7, 10, 7),
                Child = content,
            };
            row.PointerPressed += (_, _) => SelectItem(item);
            return row;
        }

        private void RebuildHighlights()
        {
            for (var i = 0; i < _list.Children.Count; i++)
                if (_list.Children[i] is Border row)
                    row.Background = i == _activeIndex ? R("MapleSurfaceHover") : new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        }
    }
}
