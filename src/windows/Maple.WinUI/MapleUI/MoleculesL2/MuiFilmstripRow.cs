using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One thumbnail in a Filmstrip Row/Rail.</summary>
    public sealed record MuiFilmstripItem(
        string Id, ImageSource? Source, string Alt, IReadOnlyList<string>? Badges = null);

    /// <summary>
    /// Maple.UI Filmstrip Row molecule (unified-component-catalog.md §3,
    /// "Filmstrip Row" row: "Horizontal scrolling thumbnails", built from
    /// Media Cell) — a horizontally scrolling strip of Sm
    /// <see cref="MuiMediaCell"/>s whose selection follows
    /// <see cref="ActiveId"/>, auto-scrolling the minimum distance to keep
    /// the active cell fully in view via
    /// <see cref="MuiFilmstripFollowLogic.FollowBounds"/> — the pure math
    /// this control feeds real <see cref="ScrollViewer"/> geometry into.
    /// </summary>
    public sealed class MuiFilmstripRow : ContentControl
    {
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
        private readonly StackPanel _row = new() { Orientation = Orientation.Horizontal, Spacing = MuiFilmstripFollowLogic.CellSpacing };
        private readonly List<MuiMediaCell> _cells = new();
        private bool _followAfterLayout;

        public MuiFilmstripRow()
        {
            _scroll.Content = _row;
            Content = _scroll;
            IsTabStop = false;
            AutomationProperties.SetName(this, "Filmstrip");
            _scroll.SizeChanged += (_, _) => RequestFollow();
            _row.LayoutUpdated += (_, _) =>
            {
                if (_followAfterLayout) _followAfterLayout = !FollowActive();
            };

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
                    Badges = item.Badges,
                    ShowMetadata = false,
                    Selected = item.Id == ActiveId,
                };
                cell.Pressed += (_, _) => Select(item.Id);
                _cells.Add(cell);
                _row.Children.Add(cell);
            }
            RequestFollow();
        }

        private void OnActiveIdChanged()
        {
            var items = Items ?? Array.Empty<MuiFilmstripItem>();
            for (var i = 0; i < _cells.Count && i < items.Count; i++)
                _cells[i].Selected = items[i].Id == ActiveId;

            RequestFollow();
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
            if (_scroll.ViewportWidth <= 0 || _cells[index].ActualWidth <= 0) return false;

            var cell = _cells[index];
            var start = cell.TransformToVisual(_row).TransformPoint(new Windows.Foundation.Point()).X;
            var offset = MuiFilmstripFollowLogic.FollowBounds(
                start, cell.ActualWidth,
                _scroll.ViewportWidth, _scroll.HorizontalOffset);
            if (offset != _scroll.HorizontalOffset)
                return _scroll.ChangeView(offset, null, null, disableAnimation: true);
            return true;
        }
    }
}
