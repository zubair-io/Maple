using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Filmstrip Rail molecule (unified-component-catalog.md §3,
    /// "Filmstrip Rail" row: "Collapsible vertical thumbnails", built from
    /// Media Cell, Icon) — the vertical sibling of
    /// <see cref="MuiFilmstripRow"/>: same active-follow contract, same
    /// <see cref="MuiFilmstripFollowLogic"/> math applied to the vertical
    /// axis, plus a chevron toggle that collapses the whole cell strip.
    /// </summary>
    public sealed class MuiFilmstripRail : ContentControl
    {
        private const double CellExtent = 72;
        private const double CellSpacing = 8;

        public static readonly DependencyProperty ItemsProperty =
            DependencyProperty.Register(nameof(Items), typeof(IReadOnlyList<MuiFilmstripItem>), typeof(MuiFilmstripRail),
                new PropertyMetadata(null, (d, _) => ((MuiFilmstripRail)d).RebuildCells()));

        public static readonly DependencyProperty ActiveIdProperty =
            DependencyProperty.Register(nameof(ActiveId), typeof(string), typeof(MuiFilmstripRail),
                new PropertyMetadata(null, (d, _) => ((MuiFilmstripRail)d).OnActiveIdChanged()));

        public static readonly DependencyProperty IsCollapsedProperty =
            DependencyProperty.Register(nameof(IsCollapsed), typeof(bool), typeof(MuiFilmstripRail),
                new PropertyMetadata(false, (d, _) => ((MuiFilmstripRail)d).Rebuild()));

        public IReadOnlyList<MuiFilmstripItem>? Items
        {
            get => (IReadOnlyList<MuiFilmstripItem>?)GetValue(ItemsProperty);
            set => SetValue(ItemsProperty, value);
        }

        public string? ActiveId
        {
            get => (string?)GetValue(ActiveIdProperty);
            set => SetValue(ActiveIdProperty, value);
        }

        public bool IsCollapsed
        {
            get => (bool)GetValue(IsCollapsedProperty);
            set => SetValue(IsCollapsedProperty, value);
        }

        public event EventHandler<string>? Activated;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 6 };
        private readonly Button _toggle = new()
        {
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            BorderThickness = new Thickness(0),
            Padding = new Thickness(4),
            HorizontalAlignment = HorizontalAlignment.Left,
        };
        private readonly MuiIcon _chevron = new() { Size = MuiIconSize.Sm16 };
        private readonly ScrollViewer _scroll = new()
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            VerticalScrollMode = ScrollMode.Enabled,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            HorizontalScrollMode = ScrollMode.Disabled,
        };
        private readonly StackPanel _column = new() { Orientation = Orientation.Vertical, Spacing = CellSpacing };
        private readonly List<MuiMediaCell> _cells = new();

        public MuiFilmstripRail()
        {
            _toggle.Content = _chevron;
            _toggle.Click += (_, _) => IsCollapsed = !IsCollapsed;
            _scroll.Content = _column;
            _root.Children.Add(_toggle);
            _root.Children.Add(_scroll);
            Content = _root;
            IsTabStop = false;

            RebuildCells();
            Rebuild();
        }

        private void Select(string id)
        {
            ActiveId = id;
            Activated?.Invoke(this, id);
        }

        private void RebuildCells()
        {
            _column.Children.Clear();
            _cells.Clear();

            foreach (var item in Items ?? Array.Empty<MuiFilmstripItem>())
            {
                var cell = new MuiMediaCell
                {
                    CellSize = MuiMediaCellSize.Sm,
                    Source = item.Source,
                    Alt = item.Alt,
                    Selected = item.Id == ActiveId,
                };
                cell.Pressed += (_, _) => Select(item.Id);
                _cells.Add(cell);
                _column.Children.Add(cell);
            }
        }

        private void OnActiveIdChanged()
        {
            var items = Items ?? Array.Empty<MuiFilmstripItem>();
            for (var i = 0; i < _cells.Count && i < items.Count; i++)
                _cells[i].Selected = items[i].Id == ActiveId;

            var index = MuiFilmstripFollowLogic.IndexOf(items.Select(item => item.Id).ToList(), ActiveId);
            if (index < 0 || _scroll.ViewportHeight <= 0) return;

            var offset = MuiFilmstripFollowLogic.FollowOffset(
                index, CellExtent, CellSpacing, _scroll.ViewportHeight, _scroll.VerticalOffset);
            if (offset != _scroll.VerticalOffset)
                _scroll.ChangeView(null, offset, null);
        }

        private void Rebuild()
        {
            _chevron.IconName = IsCollapsed ? "chevron-right" : "chevron-down";
            _scroll.Visibility = IsCollapsed ? Visibility.Collapsed : Visibility.Visible;
            AutomationProperties.SetName(_toggle, IsCollapsed ? "Expand filmstrip" : "Collapse filmstrip");
        }
    }
}
