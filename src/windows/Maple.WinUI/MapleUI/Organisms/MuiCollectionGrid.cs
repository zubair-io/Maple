using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.Foundation;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One thumbnail in a Collection Grid.</summary>
    public sealed record MuiCollectionGridItem(
        string Id, ImageSource? Source, string Alt, string Filename,
        IReadOnlyList<string>? Badges = null, int Rating = 0, MuiRatingFlagState Flag = MuiRatingFlagState.None);

    /// <summary>
    /// Maple.UI Collection Grid organism (unified-component-catalog.md
    /// §4.1, "Collection Grid" row: "Virtualized selectable thumbnail
    /// grid", built from Media Cell, Empty State, Spinner, Drag Preview).
    ///
    /// Not virtualized (no GridView/ItemsRepeater — wave brief calls for
    /// the simplest compile-safe option): a hand-rolled wrap layout that
    /// re-flows <see cref="MuiMediaCell"/> rows on <c>SizeChanged</c>,
    /// same shape MuiGalleryWindow's own <c>WrapPanelLike</c> already
    /// uses for a fixed token list. Real virtualization is a follow-up
    /// once a library ships with thousands of items — YAGNI for a
    /// presentational demo surface today.
    ///
    /// Click/Ctrl-click/Shift-click selection is
    /// <see cref="MuiCollectionGridSelection"/>, unit-tested standalone.
    /// A press-and-drag past a small threshold on an already-selected
    /// cell shows a floating <see cref="MuiDragPreview"/> that follows the
    /// pointer and fires <see cref="DragCompleted"/> with the dragged ids
    /// on release — this control has no drop target of its own.
    /// </summary>
    public sealed class MuiCollectionGrid : ContentControl
    {
        private const double DragThreshold = 6;

        public static readonly DependencyProperty ItemsProperty =
            DependencyProperty.Register(nameof(Items), typeof(IReadOnlyList<MuiCollectionGridItem>), typeof(MuiCollectionGrid),
                new PropertyMetadata(null, (d, _) => ((MuiCollectionGrid)d).Rebuild()));

        public static readonly DependencyProperty SelectedIdsProperty =
            DependencyProperty.Register(nameof(SelectedIds), typeof(IReadOnlyList<string>), typeof(MuiCollectionGrid),
                new PropertyMetadata(null, (d, _) => ((MuiCollectionGrid)d).RebuildSelectionVisuals()));

        public static readonly DependencyProperty CellSizeProperty =
            DependencyProperty.Register(nameof(CellSize), typeof(MuiMediaCellSize), typeof(MuiCollectionGrid),
                new PropertyMetadata(MuiMediaCellSize.Md, (d, _) => ((MuiCollectionGrid)d).Rebuild()));

        public static readonly DependencyProperty IsLoadingProperty =
            DependencyProperty.Register(nameof(IsLoading), typeof(bool), typeof(MuiCollectionGrid),
                new PropertyMetadata(false, (d, _) => ((MuiCollectionGrid)d).Rebuild()));

        public static readonly DependencyProperty EmptyTitleProperty =
            DependencyProperty.Register(nameof(EmptyTitle), typeof(string), typeof(MuiCollectionGrid),
                new PropertyMetadata("No photos", (d, _) => ((MuiCollectionGrid)d).Rebuild()));

        public static readonly DependencyProperty EmptyMessageProperty =
            DependencyProperty.Register(nameof(EmptyMessage), typeof(string), typeof(MuiCollectionGrid),
                new PropertyMetadata(null, (d, _) => ((MuiCollectionGrid)d).Rebuild()));

        public IReadOnlyList<MuiCollectionGridItem>? Items
        {
            get => (IReadOnlyList<MuiCollectionGridItem>?)GetValue(ItemsProperty);
            set => SetValue(ItemsProperty, value);
        }

        public IReadOnlyList<string>? SelectedIds
        {
            get => (IReadOnlyList<string>?)GetValue(SelectedIdsProperty);
            set => SetValue(SelectedIdsProperty, value);
        }

        public MuiMediaCellSize CellSize
        {
            get => (MuiMediaCellSize)GetValue(CellSizeProperty);
            set => SetValue(CellSizeProperty, value);
        }

        public bool IsLoading
        {
            get => (bool)GetValue(IsLoadingProperty);
            set => SetValue(IsLoadingProperty, value);
        }

        public string EmptyTitle
        {
            get => (string)GetValue(EmptyTitleProperty);
            set => SetValue(EmptyTitleProperty, value);
        }

        public string? EmptyMessage
        {
            get => (string?)GetValue(EmptyMessageProperty);
            set => SetValue(EmptyMessageProperty, value);
        }

        /// <summary>Fires whenever a click/Ctrl-click/Shift-click changes
        /// the selection. The caller owns <see cref="SelectedIds"/> —
        /// this control does not mutate it itself.</summary>
        public event EventHandler<IReadOnlyList<string>>? SelectionChanged;

        /// <summary>Fires on a double-tap — "open this item".</summary>
        public event EventHandler<string>? ItemActivated;

        /// <summary>Fires when a press-drag on a selected cell is
        /// released, with the full set of dragged ids.</summary>
        public event EventHandler<IReadOnlyList<string>>? DragCompleted;

        private readonly Grid _host = new();
        private readonly ScrollViewer _scroll = new();
        private readonly StackPanel _rows = new() { Orientation = Orientation.Vertical, Spacing = 8 };
        private readonly MuiEmptyState _empty = new() { IconName = "photos" };
        private readonly MuiSpinner _spinner = new() { IsSpinning = true, SpinnerSize = MuiSpinnerSize.Md, DelayMs = 0, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        private readonly MuiDragPreview _dragGhost = new() { IsHitTestVisible = false, Visibility = Visibility.Collapsed };
        private readonly Dictionary<string, MuiMediaCell> _cells = new();
        private string? _anchorId;
        private string? _pressedId;
        private Point _pressOrigin;
        private bool _dragging;

        public MuiCollectionGrid()
        {
            _scroll.Content = _rows;
            _host.Children.Add(_scroll);
            _host.Children.Add(_empty);
            _host.Children.Add(_spinner);
            _host.Children.Add(_dragGhost);
            Content = _host;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            SizeChanged += (_, _) => LayoutRows();
            PointerMoved += OnPointerMoved;
            PointerReleased += OnPointerReleased;

            Rebuild();
        }

        private double CellColumnWidth => CellSize == MuiMediaCellSize.Sm ? 100 : 156;

        private void Rebuild()
        {
            var items = Items ?? Array.Empty<MuiCollectionGridItem>();
            _empty.Visibility = !IsLoading && items.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            _empty.Title = EmptyTitle;
            _empty.Message = EmptyMessage;
            _spinner.Visibility = IsLoading && items.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            _scroll.Visibility = items.Count > 0 ? Visibility.Visible : Visibility.Collapsed;

            _cells.Clear();
            foreach (var item in items)
            {
                var cell = new MuiMediaCell
                {
                    Source = item.Source,
                    Alt = item.Alt,
                    Filename = item.Filename,
                    Badges = item.Badges,
                    Rating = item.Rating,
                    Flag = item.Flag,
                    CellSize = CellSize,
                };
                cell.PointerPressed += (_, e) => OnCellPressed(item.Id, e);
                cell.DoubleTapped += (_, _) => ItemActivated?.Invoke(this, item.Id);
                cell.Pressed += (_, _) => Select(item.Id, MuiPointerModifierReader.CurrentModifier());
                _cells[item.Id] = cell;
            }
            LayoutRows();
            RebuildSelectionVisuals();
        }

        private void LayoutRows()
        {
            _rows.Children.Clear();
            var items = Items ?? Array.Empty<MuiCollectionGridItem>();
            if (items.Count == 0) return;

            var available = ActualWidth > 0 ? ActualWidth : 640;
            var perRow = Math.Max(1, (int)(available / CellColumnWidth));
            StackPanel? row = null;
            for (var i = 0; i < items.Count; i++)
            {
                if (i % perRow == 0)
                {
                    row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
                    _rows.Children.Add(row);
                }
                row!.Children.Add(_cells[items[i].Id]);
            }
        }

        private void RebuildSelectionVisuals()
        {
            var selected = SelectedIds is null ? new HashSet<string>() : new HashSet<string>(SelectedIds);
            foreach (var (id, cell) in _cells)
                cell.Selected = selected.Contains(id);
        }

        private void OnCellPressed(string id, PointerRoutedEventArgs e)
        {
            _pressedId = id;
            _pressOrigin = e.GetCurrentPoint(this).Position;
            _dragging = false;
        }

        private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
        {
            if (_pressedId is null || _dragging) return;
            var selected = SelectedIds is { Count: > 0 } && SelectedIds.Contains(_pressedId);
            if (!selected) return;

            var pos = e.GetCurrentPoint(this).Position;
            var dx = pos.X - _pressOrigin.X;
            var dy = pos.Y - _pressOrigin.Y;
            if (dx * dx + dy * dy < DragThreshold * DragThreshold) return;

            _dragging = true;
            _dragGhost.Count = SelectedIds!.Count;
            _dragGhost.Source = _cells.TryGetValue(_pressedId, out var cell) ? cell.Source : null;
            _dragGhost.Visibility = Visibility.Visible;
            PositionGhost(pos);
        }

        private void OnPointerReleased(object sender, PointerRoutedEventArgs e)
        {
            if (_dragging)
            {
                _dragGhost.Visibility = Visibility.Collapsed;
                DragCompleted?.Invoke(this, SelectedIds ?? Array.Empty<string>());
            }
            _pressedId = null;
            _dragging = false;
        }

        private void PositionGhost(Point pos)
        {
            _dragGhost.Margin = new Thickness(pos.X + 12, pos.Y + 12, 0, 0);
            _dragGhost.HorizontalAlignment = HorizontalAlignment.Left;
            _dragGhost.VerticalAlignment = VerticalAlignment.Top;
        }

        private void Select(string id, MuiSelectionModifier modifier)
        {
            var orderedIds = (Items ?? Array.Empty<MuiCollectionGridItem>()).Select(i => i.Id).ToList();
            var current = SelectedIds is null ? new HashSet<string>() : new HashSet<string>(SelectedIds);
            var next = MuiCollectionGridSelection.Apply(orderedIds, current, _anchorId, id, modifier);
            _anchorId = MuiCollectionGridSelection.NextAnchor(_anchorId, id, modifier);
            SelectionChanged?.Invoke(this, next.ToList());
        }
    }
}
