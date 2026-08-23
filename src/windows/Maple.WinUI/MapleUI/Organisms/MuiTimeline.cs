using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One dated item on a Timeline.</summary>
    public sealed record MuiTimelineItem(DateOnly Date, MuiCollectionGridItem Media);

    /// <summary>
    /// Maple.UI Timeline organism (unified-component-catalog.md §4.1,
    /// "Timeline" row: "Date-grouped infinite scroll", built from
    /// Collection Grid, Text, Chip Row) — groups <see cref="Items"/> by
    /// day (most recent first), rendering one heading + one nested
    /// <see cref="MuiCollectionGrid"/> per day, with a Chip Row above the
    /// whole scroll for a day-range filter. "Infinite scroll" is a
    /// <see cref="LoadMoreRequested"/> event fired once the ScrollViewer
    /// nears its bottom edge — the caller owns fetching and appending the
    /// next page to <see cref="Items"/>.
    /// </summary>
    public sealed class MuiTimeline : ContentControl
    {
        private const double LoadMoreThresholdPx = 400;

        public static readonly DependencyProperty ItemsProperty =
            DependencyProperty.Register(nameof(Items), typeof(IReadOnlyList<MuiTimelineItem>), typeof(MuiTimeline),
                new PropertyMetadata(null, (d, _) => ((MuiTimeline)d).Rebuild()));

        public static readonly DependencyProperty RangeChipsProperty =
            DependencyProperty.Register(nameof(RangeChips), typeof(IReadOnlyList<MuiChip>), typeof(MuiTimeline),
                new PropertyMetadata(null, (d, _) => ((MuiTimeline)d).Rebuild()));

        public static readonly DependencyProperty SelectedRangeIdProperty =
            DependencyProperty.Register(nameof(SelectedRangeId), typeof(string), typeof(MuiTimeline),
                new PropertyMetadata(null, (d, e) => ((MuiTimeline)d)._rangeChips.SelectedId = (string?)e.NewValue));

        public static readonly DependencyProperty IsLoadingMoreProperty =
            DependencyProperty.Register(nameof(IsLoadingMore), typeof(bool), typeof(MuiTimeline),
                new PropertyMetadata(false, (d, _) => ((MuiTimeline)d).Rebuild()));

        public IReadOnlyList<MuiTimelineItem>? Items
        {
            get => (IReadOnlyList<MuiTimelineItem>?)GetValue(ItemsProperty);
            set => SetValue(ItemsProperty, value);
        }

        public IReadOnlyList<MuiChip>? RangeChips
        {
            get => (IReadOnlyList<MuiChip>?)GetValue(RangeChipsProperty);
            set => SetValue(RangeChipsProperty, value);
        }

        public string? SelectedRangeId
        {
            get => (string?)GetValue(SelectedRangeIdProperty);
            set => SetValue(SelectedRangeIdProperty, value);
        }

        public bool IsLoadingMore
        {
            get => (bool)GetValue(IsLoadingMoreProperty);
            set => SetValue(IsLoadingMoreProperty, value);
        }

        public event EventHandler<string>? RangeSelected;
        public event EventHandler<string>? ItemActivated;
        public event EventHandler? LoadMoreRequested;

        private readonly Grid _host = new();
        private readonly ScrollViewer _scroll = new() { VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 20 };
        private readonly MuiChipRow _rangeChips = new() { Mode = MuiChipRowMode.Select };
        private readonly StackPanel _groups = new() { Orientation = Orientation.Vertical, Spacing = 20 };
        private readonly MuiSpinner _footerSpinner = new() { IsSpinning = true, SpinnerSize = MuiSpinnerSize.Sm, DelayMs = 0, HorizontalAlignment = HorizontalAlignment.Center };

        public MuiTimeline()
        {
            _root.Children.Add(_rangeChips);
            _root.Children.Add(_groups);
            _root.Children.Add(_footerSpinner);
            _scroll.Content = _root;
            _host.Children.Add(_scroll);
            Content = _host;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            _rangeChips.SelectionChanged += (_, id) => RangeSelected?.Invoke(this, id);
            _scroll.ViewChanged += OnViewChanged;

            Rebuild();
        }

        private void OnViewChanged(object? sender, ScrollViewerViewChangedEventArgs e)
        {
            if (IsLoadingMore) return;
            var remaining = _scroll.ExtentHeight - _scroll.VerticalOffset - _scroll.ViewportHeight;
            if (remaining <= LoadMoreThresholdPx) LoadMoreRequested?.Invoke(this, EventArgs.Empty);
        }

        private void Rebuild()
        {
            _rangeChips.Chips = RangeChips;
            _rangeChips.SelectedId = SelectedRangeId;
            _footerSpinner.Visibility = IsLoadingMore ? Visibility.Visible : Visibility.Collapsed;

            _groups.Children.Clear();
            var items = Items ?? Array.Empty<MuiTimelineItem>();
            foreach (var day in items.GroupBy(i => i.Date).OrderByDescending(g => g.Key))
            {
                var section = new StackPanel { Orientation = Orientation.Vertical, Spacing = 10 };
                section.Children.Add(new MuiText
                {
                    Text = day.Key.ToString("dddd, MMMM d, yyyy"),
                    Variant = MuiTextVariant.RowLabel,
                });
                var grid = new MuiCollectionGrid { Items = day.Select(d => d.Media).ToList() };
                grid.ItemActivated += (_, id) => ItemActivated?.Invoke(this, id);
                section.Children.Add(grid);
                _groups.Children.Add(section);
            }
        }
    }
}
