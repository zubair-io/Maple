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
    /// <summary>
    /// Maple.UI Kanban Board organism (unified-component-catalog.md §4.1,
    /// "Kanban Board" row: "Drag-and-drop column board", built from Card,
    /// Text, Button).
    ///
    /// Drag-between-columns via plain pointer events (no precedent for
    /// WinUI's DragDrop APIs exists elsewhere in this control library —
    /// this wave's brief calls for checking first, and there's none): a
    /// press-drag on a <see cref="MuiCard"/> past a small threshold shows
    /// a floating ghost card following the pointer; on release, the
    /// pointer position is hit-tested against each column's own measured
    /// bounds (captured via each column panel's own <c>SizeChanged</c> +
    /// <see cref="UIElement.TransformToVisual"/>) to find the target
    /// column, and against that column's card Y-positions to find the
    /// insertion index. The actual reordering is
    /// <see cref="MuiKanbanBoardLogic.MoveCard"/>, unit-tested standalone.
    /// This control does not mutate <see cref="Cards"/> itself — it fires
    /// <see cref="BoardChanged"/> with the new list and leaves committing
    /// it to the caller, the same controlled-component contract every
    /// other organism in this wave uses.
    /// </summary>
    public sealed class MuiKanbanBoard : ContentControl
    {
        private const double DragThreshold = 6;

        public static readonly DependencyProperty ColumnsProperty =
            DependencyProperty.Register(nameof(Columns), typeof(IReadOnlyList<MuiKanbanColumn>), typeof(MuiKanbanBoard),
                new PropertyMetadata(null, (d, _) => ((MuiKanbanBoard)d).Rebuild()));

        public static readonly DependencyProperty CardsProperty =
            DependencyProperty.Register(nameof(Cards), typeof(IReadOnlyList<MuiKanbanCard>), typeof(MuiKanbanBoard),
                new PropertyMetadata(null, (d, _) => ((MuiKanbanBoard)d).Rebuild()));

        public IReadOnlyList<MuiKanbanColumn>? Columns
        {
            get => (IReadOnlyList<MuiKanbanColumn>?)GetValue(ColumnsProperty);
            set => SetValue(ColumnsProperty, value);
        }

        public IReadOnlyList<MuiKanbanCard>? Cards
        {
            get => (IReadOnlyList<MuiKanbanCard>?)GetValue(CardsProperty);
            set => SetValue(CardsProperty, value);
        }

        /// <summary>Fires with the full recomputed card list once a drag
        /// lands on a valid column. The caller re-assigns
        /// <see cref="Cards"/> to commit it.</summary>
        public event EventHandler<IReadOnlyList<MuiKanbanCard>>? BoardChanged;

        /// <summary>Fires when a card is pressed (not dragged) — "open
        /// this card".</summary>
        public event EventHandler<string>? CardActivated;

        private readonly Grid _host = new();
        private readonly ScrollViewer _scroll = new() { HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, VerticalScrollBarVisibility = ScrollBarVisibility.Disabled };
        private readonly StackPanel _columnsPanel = new() { Orientation = Orientation.Horizontal, Spacing = 16 };
        private readonly Border _ghost = new()
        {
            Width = 220,
            Opacity = 0.85,
            CornerRadius = new CornerRadius(10),
            BorderThickness = new Thickness(1),
            Visibility = Visibility.Collapsed,
            IsHitTestVisible = false,
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Top,
        };
        private readonly MuiText _ghostText = new() { Variant = MuiTextVariant.RowLabel };
        private readonly Dictionary<string, StackPanel> _columnBodies = new();

        private string? _draggingCardId;
        private Point _pressOrigin;
        private bool _dragging;

        public MuiKanbanBoard()
        {
            _ghost.Child = _ghostText;
            _scroll.Content = _columnsPanel;
            _host.Children.Add(_scroll);
            _host.Children.Add(_ghost);
            Content = _host;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            PointerMoved += OnPointerMoved;
            PointerReleased += OnPointerReleased;

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Rebuild()
        {
            _columnsPanel.Children.Clear();
            _columnBodies.Clear();
            var columns = Columns ?? Array.Empty<MuiKanbanColumn>();
            var cards = Cards ?? Array.Empty<MuiKanbanCard>();

            foreach (var column in columns)
            {
                var wrapper = new StackPanel { Orientation = Orientation.Vertical, Spacing = 10, Width = 240 };
                wrapper.Children.Add(new StackPanel
                {
                    Orientation = Orientation.Horizontal,
                    Spacing = 8,
                    Children =
                    {
                        new MuiText { Text = column.Title, Variant = MuiTextVariant.RowLabel },
                        new MuiBadge { Variant = MuiBadgeVariant.Count, Value = MuiKanbanBoardLogic.CardsInColumn(cards, column.Id).Count.ToString() },
                    },
                });

                var body = new StackPanel { Orientation = Orientation.Vertical, Spacing = 8, Tag = column.Id, MinHeight = 60 };
                foreach (var card in MuiKanbanBoardLogic.CardsInColumn(cards, column.Id))
                {
                    var cardControl = new MuiCard { Title = card.Title, Subtitle = card.Subtitle, Tag = card.Id };
                    cardControl.Pressed += (_, _) => { if (!_dragging) CardActivated?.Invoke(this, card.Id); };
                    cardControl.PointerPressed += (_, e) => OnCardPressed(card.Id, e);
                    body.Children.Add(cardControl);
                }
                _columnBodies[column.Id] = body;

                var columnBorder = new Border
                {
                    Background = R("MapleSurfaceAlt"),
                    BorderBrush = R("MapleBorder"),
                    BorderThickness = new Thickness(1),
                    CornerRadius = new CornerRadius(10),
                    Padding = new Thickness(10),
                    Child = body,
                };
                wrapper.Children.Add(columnBorder);
                _columnsPanel.Children.Add(wrapper);
            }

            _ghost.Background = R("MapleSurface");
            _ghost.BorderBrush = R("MaplePrimary");
        }

        private void OnCardPressed(string cardId, PointerRoutedEventArgs e)
        {
            _draggingCardId = cardId;
            _pressOrigin = e.GetCurrentPoint(this).Position;
            _dragging = false;
        }

        private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
        {
            if (_draggingCardId is null) return;
            var pos = e.GetCurrentPoint(this).Position;

            if (!_dragging)
            {
                var dx = pos.X - _pressOrigin.X;
                var dy = pos.Y - _pressOrigin.Y;
                if (dx * dx + dy * dy < DragThreshold * DragThreshold) return;
                _dragging = true;
                var card = (Cards ?? Array.Empty<MuiKanbanCard>()).FirstOrDefault(c => c.Id == _draggingCardId);
                _ghostText.Text = card?.Title ?? string.Empty;
                _ghost.Visibility = Visibility.Visible;
            }

            _ghost.Margin = new Thickness(pos.X + 10, pos.Y + 10, 0, 0);
        }

        private void OnPointerReleased(object sender, PointerRoutedEventArgs e)
        {
            if (_dragging && _draggingCardId is not null)
            {
                var pos = e.GetCurrentPoint(this).Position;
                var (targetColumnId, targetIndex) = HitTest(pos);
                if (targetColumnId is not null)
                {
                    var cards = Cards ?? Array.Empty<MuiKanbanCard>();
                    var next = MuiKanbanBoardLogic.MoveCard(cards, _draggingCardId, targetColumnId, targetIndex);
                    BoardChanged?.Invoke(this, next);
                }
            }

            _ghost.Visibility = Visibility.Collapsed;
            _draggingCardId = null;
            _dragging = false;
        }

        /// <summary>Finds which column body contains the drop point and
        /// the index within that column's cards the point falls closest
        /// to, using each body's live layout rect via
        /// <see cref="UIElement.TransformToVisual"/>.</summary>
        private (string? ColumnId, int Index) HitTest(Point pointInHost)
        {
            foreach (var (columnId, body) in _columnBodies)
            {
                var transform = body.TransformToVisual(this);
                var origin = transform.TransformPoint(new Point(0, 0));
                var rect = new Rect(origin.X, origin.Y, body.ActualWidth, Math.Max(body.ActualHeight, 60));
                if (!rect.Contains(pointInHost)) continue;

                var index = 0;
                foreach (var child in body.Children)
                {
                    if (child is not FrameworkElement fe) continue;
                    var childTransform = fe.TransformToVisual(this);
                    var childOrigin = childTransform.TransformPoint(new Point(0, 0));
                    var midY = childOrigin.Y + fe.ActualHeight / 2;
                    if (pointInHost.Y > midY) index++;
                }
                return (columnId, index);
            }
            return (null, 0);
        }
    }
}
