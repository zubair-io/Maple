using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Search Results organism (unified-component-catalog.md
    /// §4.1, "Search Results" row: "Paginated result grid with states",
    /// built from Collection Grid, Empty State, Progress) — a
    /// <see cref="MuiCollectionGrid"/> with a result-count line, a
    /// determinate <see cref="MuiProgress"/> while a page loads, and
    /// Prev/Next paging controls. Empty state and the loading spinner for
    /// an EMPTY page are the grid's own (it already composes Empty State
    /// and Spinner) — this organism's own Progress is specifically the
    /// "loading page N of M, results already on screen" state a plain
    /// spinner-on-empty doesn't cover.
    /// </summary>
    public sealed class MuiSearchResults : ContentControl
    {
        public static readonly DependencyProperty ItemsProperty =
            DependencyProperty.Register(nameof(Items), typeof(IReadOnlyList<MuiCollectionGridItem>), typeof(MuiSearchResults),
                new PropertyMetadata(null, (d, _) => ((MuiSearchResults)d).Rebuild()));

        public static readonly DependencyProperty SelectedIdsProperty =
            DependencyProperty.Register(nameof(SelectedIds), typeof(IReadOnlyList<string>), typeof(MuiSearchResults),
                new PropertyMetadata(null, (d, _) => ((MuiSearchResults)d).Rebuild()));

        public static readonly DependencyProperty TotalCountProperty =
            DependencyProperty.Register(nameof(TotalCount), typeof(int), typeof(MuiSearchResults),
                new PropertyMetadata(0, (d, _) => ((MuiSearchResults)d).Rebuild()));

        public static readonly DependencyProperty PageProperty =
            DependencyProperty.Register(nameof(Page), typeof(int), typeof(MuiSearchResults),
                new PropertyMetadata(1, (d, _) => ((MuiSearchResults)d).Rebuild()));

        public static readonly DependencyProperty PageCountProperty =
            DependencyProperty.Register(nameof(PageCount), typeof(int), typeof(MuiSearchResults),
                new PropertyMetadata(1, (d, _) => ((MuiSearchResults)d).Rebuild()));

        public static readonly DependencyProperty IsLoadingPageProperty =
            DependencyProperty.Register(nameof(IsLoadingPage), typeof(bool), typeof(MuiSearchResults),
                new PropertyMetadata(false, (d, _) => ((MuiSearchResults)d).Rebuild()));

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

        public int TotalCount { get => (int)GetValue(TotalCountProperty); set => SetValue(TotalCountProperty, value); }
        public int Page { get => (int)GetValue(PageProperty); set => SetValue(PageProperty, value); }
        public int PageCount { get => (int)GetValue(PageCountProperty); set => SetValue(PageCountProperty, value); }
        public bool IsLoadingPage { get => (bool)GetValue(IsLoadingPageProperty); set => SetValue(IsLoadingPageProperty, value); }

        public event EventHandler<IReadOnlyList<string>>? SelectionChanged;
        public event EventHandler<string>? ItemActivated;
        public event EventHandler<int>? PageRequested;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 12 };
        private readonly MuiText _countText = new() { Variant = MuiTextVariant.Eyebrow, ColorRole = MuiTextColorRole.Muted };
        private readonly MuiProgress _pageProgress = new() { IsIndeterminate = true, Visibility = Visibility.Collapsed };
        private readonly MuiCollectionGrid _grid = new() { EmptyTitle = "No results", EmptyMessage = "Try a different search or filter." };
        private readonly StackPanel _pager = new() { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Center };
        private readonly MuiButton _prev = new() { Variant = MuiButtonVariant.Secondary, Label = "Previous" };
        private readonly MuiText _pageText = new() { Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted };
        private readonly MuiButton _next = new() { Variant = MuiButtonVariant.Secondary, Label = "Next" };

        public MuiSearchResults()
        {
            _root.Children.Add(_countText);
            _root.Children.Add(_pageProgress);
            _root.Children.Add(_grid);
            _pager.Children.Add(_prev);
            _pager.Children.Add(_pageText);
            _pager.Children.Add(_next);
            _root.Children.Add(_pager);
            Content = _root;

            _grid.SelectionChanged += (_, ids) => SelectionChanged?.Invoke(this, ids);
            _grid.ItemActivated += (_, id) => ItemActivated?.Invoke(this, id);
            _prev.Click += (_, _) => PageRequested?.Invoke(this, Page - 1);
            _next.Click += (_, _) => PageRequested?.Invoke(this, Page + 1);

            Rebuild();
        }

        private void Rebuild()
        {
            var items = Items ?? Array.Empty<MuiCollectionGridItem>();
            _countText.Text = TotalCount == 1 ? "1 result" : $"{TotalCount:N0} results";
            _pageProgress.Visibility = IsLoadingPage && items.Count > 0 ? Visibility.Visible : Visibility.Collapsed;

            _grid.Items = items;
            _grid.SelectedIds = SelectedIds;
            _grid.IsLoading = IsLoadingPage && items.Count == 0;

            _pager.Visibility = PageCount > 1 ? Visibility.Visible : Visibility.Collapsed;
            _prev.IsEnabled = Page > 1;
            _next.IsEnabled = Page < PageCount;
            _pageText.Text = $"Page {Page} of {PageCount}";
        }
    }
}
