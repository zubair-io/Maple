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

        // A Grid, not a StackPanel: the scroll row needs a bounded height
        // to scroll at all, and a vertical StackPanel measures its children
        // against infinity.
        private readonly Grid _root = new() { RowSpacing = 6 };
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
        private readonly StackPanel _column = new() { Orientation = Orientation.Vertical, Spacing = MuiFilmstripFollowLogic.CellSpacing };
        private readonly List<MuiMediaCell> _cells = new();

        public MuiFilmstripRail()
        {
            _toggle.Content = _chevron;
            _toggle.Click += (_, _) => IsCollapsed = !IsCollapsed;
            _scroll.Content = _column;
            _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            _root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            Grid.SetRow(_toggle, 0);
            Grid.SetRow(_scroll, 1);
            _root.Children.Add(_toggle);
            _root.Children.Add(_scroll);
            Content = _root;
            IsTabStop = false;
            // ActiveId is often set before the rail has a viewport (it mounts
            // collapsed, or its list arrives first); re-follow once it does,
            // and again whenever the viewport changes size.
            _scroll.SizeChanged += (_, _) => FollowActive();

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

            FollowActive();
        }

        private void FollowActive()
        {
            var items = Items ?? Array.Empty<MuiFilmstripItem>();
            var index = MuiFilmstripFollowLogic.IndexOf(items.Select(item => item.Id).ToList(), ActiveId);
            if (index < 0 || _scroll.ViewportHeight <= 0) return;

            var offset = MuiFilmstripFollowLogic.FollowOffset(
                index, MuiFilmstripFollowLogic.CellExtent, MuiFilmstripFollowLogic.CellSpacing,
                _scroll.ViewportHeight, _scroll.VerticalOffset);
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
