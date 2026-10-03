using System;
using System.Collections.Generic;
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
                new PropertyMetadata(null, (d, _) => ((MuiFilmstripRail)d).RefreshItems()));

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

        public static readonly DependencyProperty ThumbnailAspectRatioProperty =
            DependencyProperty.Register(nameof(ThumbnailAspectRatio), typeof(double), typeof(MuiFilmstripRail),
                new PropertyMetadata(1.0, (d, _) => ((MuiFilmstripRail)d).RebuildCells()));

        public double ThumbnailAspectRatio
        {
            get => (double)GetValue(ThumbnailAspectRatioProperty);
            set => SetValue(ThumbnailAspectRatioProperty, value);
        }

        /// <summary>Preview toggles between a metadata list and compact rail;
        /// other hosts retain the original hide/show behavior.</summary>
        public static readonly DependencyProperty PreviewNavigationProperty =
            DependencyProperty.Register(nameof(PreviewNavigation), typeof(bool), typeof(MuiFilmstripRail),
                new PropertyMetadata(false, (d, _) => ((MuiFilmstripRail)d).Rebuild()));

        public bool PreviewNavigation
        {
            get => (bool)GetValue(PreviewNavigationProperty);
            set => SetValue(PreviewNavigationProperty, value);
        }

        private readonly TextBlock _count = new() { FontSize = 10, VerticalAlignment = VerticalAlignment.Center };
        private readonly List<Grid> _rows = new();
        private readonly List<StackPanel> _metadata = new();

        // A Grid, not a StackPanel: the scroll row needs a bounded height
        // to scroll at all, and a vertical StackPanel measures its children
        // against infinity.
        private readonly Grid _root = new() { RowSpacing = 6 };
        private readonly Border _surface = new();
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
        private bool _followAfterLayout;

        public MuiFilmstripRail()
        {
            _toggle.Content = _chevron;
            _toggle.Click += (_, _) => IsCollapsed = !IsCollapsed;
            _scroll.Content = _column;
            _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            _root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            var header = new Grid();
            _count.Foreground = (Brush)Application.Current.Resources["MapleTextMuted"];
            header.Children.Add(_count);
            _toggle.HorizontalAlignment = HorizontalAlignment.Right;
            header.Children.Add(_toggle);
            Grid.SetRow(_scroll, 1);
            _root.Children.Add(header);
            _root.Children.Add(_scroll);
            _surface.Child = _root;
            Content = _surface;
            IsTabStop = false;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;
            // Preview resizing must not override a user's manual scroll.
            _scroll.SizeChanged += (_, _) =>
            {
                if (_followAfterLayout || !PreviewNavigation) RequestFollow();
            };
            _column.LayoutUpdated += (_, _) =>
            {
                if (_followAfterLayout) _followAfterLayout = !FollowActive();
            };

            RebuildCells();
            Rebuild();
        }

        private void Select(string id)
        {
            ActiveId = id;
            Activated?.Invoke(this, id);
        }

        private IReadOnlyList<MuiFilmstripItem> _renderedItems = Array.Empty<MuiFilmstripItem>();

        private void RefreshItems()
        {
            var items = Items ?? Array.Empty<MuiFilmstripItem>();
            if (items.Count != _renderedItems.Count) { RebuildCells(); return; }
            for (var i = 0; i < items.Count; i++)
                if (items[i].Id != _renderedItems[i].Id) { RebuildCells(); return; }

            // Metadata-only updates preserve image instances, keyboard focus,
            // and the user's scroll position. Structural changes still rebuild.
            for (var i = 0; i < items.Count; i++)
            {
                var item = items[i];
                _cells[i].Source = item.Source;
                _cells[i].Alt = item.Alt;
                _cells[i].Badges = item.Badges;
                ((TextBlock)_metadata[i].Children[0]).Text = item.Alt;
                ((TextBlock)_metadata[i].Children[1]).Text = item.Metadata
                    ?? string.Join(" · ", item.Badges ?? Array.Empty<string>());
            }
            _renderedItems = items;
        }

        private void RebuildCells()
        {
            _column.Children.Clear();
            _cells.Clear();
            _rows.Clear();
            _metadata.Clear();
            _renderedItems = Items ?? Array.Empty<MuiFilmstripItem>();

            foreach (var item in Items ?? Array.Empty<MuiFilmstripItem>())
            {
                var cell = new MuiMediaCell
                {
                    CellSize = MuiMediaCellSize.Sm,
                    ThumbnailAspectRatio = ThumbnailAspectRatio,
                    Source = item.Source,
                    Alt = item.Alt,
                    Badges = item.Badges,
                    ShowMetadata = false,
                    Selected = item.Id == ActiveId,
                };
                cell.Pressed += (_, _) => Select(item.Id);
                cell.Tapped += (_, e) => e.Handled = true;
                _cells.Add(cell);
                var row = new Grid { ColumnSpacing = 8, CornerRadius = new CornerRadius(6) };
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                row.Children.Add(cell);
                var metadata = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Spacing = 6, IsHitTestVisible = false };
                metadata.Children.Add(new TextBlock
                {
                    Text = item.Alt,
                    FontSize = 12,
                    TextTrimming = TextTrimming.CharacterEllipsis,
                    Foreground = (Brush)Application.Current.Resources["MapleTextMain"]
                });
                metadata.Children.Add(new TextBlock
                {
                    Text = item.Metadata ?? string.Join(" · ", item.Badges ?? Array.Empty<string>()),
                    FontSize = 10,
                    TextTrimming = TextTrimming.CharacterEllipsis,
                    Foreground = (Brush)Application.Current.Resources["MapleTextMuted"]
                });
                Grid.SetColumn(metadata, 1);
                row.Children.Add(metadata);
                row.Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
                row.Tapped += (_, _) => Select(item.Id);
                _rows.Add(row);
                _metadata.Add(metadata);
                _column.Children.Add(row);
            }
            Rebuild();
            OnActiveIdChanged();
            RequestFollow();
        }

        private void OnActiveIdChanged(bool follow = true)
        {
            var items = Items ?? Array.Empty<MuiFilmstripItem>();
            for (var i = 0; i < _cells.Count && i < items.Count; i++)
            {
                _cells[i].Selected = items[i].Id == ActiveId;
                _rows[i].Background = items[i].Id == ActiveId && PreviewNavigation && !IsCollapsed
                    ? (Brush)Application.Current.Resources["MaplePrimaryDim"]
                    : new SolidColorBrush(Microsoft.UI.Colors.Transparent);
            }
            var selected = -1;
            for (var i = 0; i < items.Count; i++) if (items[i].Id == ActiveId) selected = i;
            _count.Text = $"{selected + 1:00} / {items.Count:00}";

            if (follow) RequestFollow();
        }

        private void RequestFollow() => _followAfterLayout = !FollowActive();

        private bool FollowActive()
        {
            var items = Items ?? Array.Empty<MuiFilmstripItem>();
            var index = -1;
            for (var i = 0; i < items.Count; i++)
                if (items[i].Id == ActiveId)
                {
                    index = i;
                    break;
                }
            if (index < 0) return true;
            if (_scroll.ViewportHeight <= 0 || _cells[index].ActualHeight <= 0) return false;

            var cell = _cells[index];
            var start = cell.TransformToVisual(_column).TransformPoint(new Windows.Foundation.Point()).Y;
            var offset = MuiFilmstripFollowLogic.FollowBounds(
                start, cell.ActualHeight,
                _scroll.ViewportHeight, _scroll.VerticalOffset);
            if (offset != _scroll.VerticalOffset)
                return _scroll.ChangeView(null, offset, null, disableAnimation: true);
            return true;
        }

        private void Rebuild()
        {
            var expanded = PreviewNavigation && !IsCollapsed;
            Width = expanded ? 300 : PreviewNavigation ? 88 : 80;
            _chevron.IconName = "sidebar";
            _surface.Background = (Brush)Application.Current.Resources["MapleSidebar"];
            _surface.CornerRadius = new CornerRadius(PreviewNavigation ? 0 : 12);
            _surface.Padding = new Thickness(6);
            _column.Spacing = PreviewNavigation ? 14 : 8;
            _scroll.Visibility = PreviewNavigation || !IsCollapsed ? Visibility.Visible : Visibility.Collapsed;
            foreach (var cell in _cells)
                cell.CellSize = PreviewNavigation ? MuiMediaCellSize.Sm : MuiMediaCellSize.Filmstrip;
            foreach (var metadata in _metadata) metadata.Visibility = expanded ? Visibility.Visible : Visibility.Collapsed;
            AutomationProperties.SetName(_toggle, PreviewNavigation
                ? (expanded ? "Collapse photo list" : "Expand photo list")
                : (IsCollapsed ? "Expand filmstrip" : "Collapse filmstrip"));
            OnActiveIdChanged(follow: false);
        }
    }
}
