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
    /// <summary>One thumbnail in a Filmstrip Row/Rail.</summary>
    public sealed record MuiFilmstripItem(string Id, ImageSource? Source, string Alt);

    /// <summary>
    /// Maple.UI Filmstrip Row molecule (unified-component-catalog.md §3,
    /// "Filmstrip Row" row: "Horizontal scrolling thumbnails", built from
    /// Media Cell) — a horizontally scrolling strip of Sm
    /// <see cref="MuiMediaCell"/>s whose selection follows
    /// <see cref="ActiveId"/>, auto-scrolling the minimum distance to keep
    /// the active cell fully in view via
    /// <see cref="MuiFilmstripFollowLogic.FollowOffset"/> — the pure math
    /// this control feeds real <see cref="ScrollViewer"/> geometry into.
    /// </summary>
    public sealed class MuiFilmstripRow : ContentControl
    {
        private const double CellExtent = 72;
        private const double CellSpacing = 8;

        public static readonly DependencyProperty ItemsProperty =
            DependencyProperty.Register(nameof(Items), typeof(IReadOnlyList<MuiFilmstripItem>), typeof(MuiFilmstripRow),
                new PropertyMetadata(null, (d, _) => ((MuiFilmstripRow)d).RebuildCells()));

        public static readonly DependencyProperty ActiveIdProperty =
            DependencyProperty.Register(nameof(ActiveId), typeof(string), typeof(MuiFilmstripRow),
                new PropertyMetadata(null, (d, _) => ((MuiFilmstripRow)d).OnActiveIdChanged()));

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

        public event EventHandler<string>? Activated;

        private readonly ScrollViewer _scroll = new()
        {
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollMode = ScrollMode.Enabled,
            VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
            VerticalScrollMode = ScrollMode.Disabled,
        };
        private readonly StackPanel _row = new() { Orientation = Orientation.Horizontal, Spacing = CellSpacing };
        private readonly List<MuiMediaCell> _cells = new();

        public MuiFilmstripRow()
        {
            _scroll.Content = _row;
            Content = _scroll;
            IsTabStop = false;
            AutomationProperties.SetName(this, "Filmstrip");

            RebuildCells();
        }

        private void Select(string id)
        {
            ActiveId = id;
            Activated?.Invoke(this, id);
        }

        private void RebuildCells()
        {
            _row.Children.Clear();
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
                _row.Children.Add(cell);
            }
        }

        private void OnActiveIdChanged()
        {
            var items = Items ?? Array.Empty<MuiFilmstripItem>();
            for (var i = 0; i < _cells.Count && i < items.Count; i++)
                _cells[i].Selected = items[i].Id == ActiveId;

            var index = MuiFilmstripFollowLogic.IndexOf(items.Select(item => item.Id).ToList(), ActiveId);
            if (index < 0 || _scroll.ViewportWidth <= 0) return;

            var offset = MuiFilmstripFollowLogic.FollowOffset(
                index, CellExtent, CellSpacing, _scroll.ViewportWidth, _scroll.HorizontalOffset);
            if (offset != _scroll.HorizontalOffset)
                _scroll.ChangeView(offset, null, null);
        }
    }
}
