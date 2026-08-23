using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;
using Maple.UI.Atoms;

namespace Maple.UI.Pages
{
    /// <summary>
    /// Maple.UI Board page (unified-component-catalog.md §6 — App Shell
    /// template hosting a single Kanban Board). Windows Pages wave
    /// (#3012).
    ///
    /// Real wiring on top of the already-tested
    /// <see cref="MuiKanbanBoardLogic.MoveCard"/>: a drop that would push
    /// a column past its WIP limit (<see cref="MuiBoardPageReducer"/>) is
    /// rejected — the board snaps back to its prior state and a Banner
    /// explains why, rather than silently accepting an unbounded pile in
    /// "Editing". Column headers show a live "n / limit" count that
    /// updates with every accepted move.
    /// </summary>
    public sealed class MuiPageBoard : ContentControl
    {
        private static readonly MuiKanbanColumn[] Columns =
        {
            new("todo", "To Cull"),
            new("doing", "Editing"),
            new("review", "Client Review"),
            new("done", "Exported"),
        };

        private readonly MuiKanbanBoard _board = new();
        private readonly MuiBanner _banner = new() { Variant = MuiBannerVariant.Warning, Dismissible = true, Visibility = Visibility.Collapsed };
        private readonly Dictionary<string, MuiText> _columnCounts = new();
        private IReadOnlyList<MuiKanbanCard> _cards = new[]
        {
            new MuiKanbanCard("c1", "todo", "Wedding — Ceremony batch", "3 photos"),
            new MuiKanbanCard("c2", "todo", "Wedding — Reception batch", "3 photos"),
            new MuiKanbanCard("c3", "todo", "Iceland — Ring road day 3", "4 photos"),
            new MuiKanbanCard("c4", "doing", "Studio — Fall portraits", "2 photos"),
            new MuiKanbanCard("c5", "review", "Wedding — First look set", "6 photos"),
            new MuiKanbanCard("c6", "done", "Iceland — Black sand beach", "5 photos"),
        };

        public MuiPageBoard()
        {
            _board.Columns = Columns;
            _board.Cards = _cards;
            _board.BoardChanged += OnBoardChanged;

            _banner.Dismissed += (_, _) => _banner.Visibility = Visibility.Collapsed;
            _banner.ActionPressed += (_, _) => _banner.Visibility = Visibility.Collapsed;

            var header = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 24, Padding = new Thickness(16, 12, 16, 0) };
            foreach (var column in Columns)
            {
                var label = new MuiText { Variant = MuiTextVariant.RowLabel };
                _columnCounts[column.Id] = label;
                header.Children.Add(label);
            }

            var body = new StackPanel { Orientation = Orientation.Vertical, Spacing = 8 };
            body.Children.Add(header);
            body.Children.Add(_board);

            var shell = new MuiAppShell { MainContent = body, Overlay = _banner };
            Content = shell;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            RefreshCounts();
        }

        private void OnBoardChanged(object? sender, IReadOnlyList<MuiKanbanCard> proposed)
        {
            var moved = proposed.FirstOrDefault(p =>
                _cards.FirstOrDefault(c => c.Id == p.Id) is { } prior && prior.ColumnId != p.ColumnId);

            if (moved is not null && !MuiBoardPageReducer.CanMoveInto(_cards, moved.ColumnId, moved.Id))
            {
                _board.Cards = _cards; // reject the drop — snap back to the prior board state
                _banner.Message = $"\"{Columns.First(c => c.Id == moved.ColumnId).Title}\" is at its {MuiBoardPageReducer.WipLimit}-card limit.";
                _banner.Visibility = Visibility.Visible;
                return;
            }

            _cards = proposed;
            _board.Cards = _cards;
            RefreshCounts();
        }

        private void RefreshCounts()
        {
            foreach (var column in Columns)
            {
                var count = _cards.Count(c => c.ColumnId == column.Id);
                _columnCounts[column.Id].Text = $"{column.Title} · {count}/{MuiBoardPageReducer.WipLimit}";
            }
        }
    }
}
