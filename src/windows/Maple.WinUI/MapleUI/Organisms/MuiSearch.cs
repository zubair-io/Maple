using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Search organism (unified-component-catalog.md §4.2,
    /// "Search" row: "Query, filters, and results together", built from
    /// Search Bar, Chip Row, Suggestion Menu, Search Results, Filter
    /// Panel) — the full search surface: a query bar with a live
    /// <see cref="MuiSuggestionMenu"/> anchored beneath it, a removable
    /// <see cref="MuiChipRow"/> of recent queries, and a
    /// <see cref="MuiFilterPanel"/>/<see cref="MuiSearchResults"/> split
    /// below. Every child keeps its own controlled-prop contract; this
    /// organism only wires their events together and forwards state down.
    /// </summary>
    public sealed class MuiSearch : ContentControl
    {
        public static readonly DependencyProperty QueryProperty =
            DependencyProperty.Register(nameof(Query), typeof(string), typeof(MuiSearch),
                new PropertyMetadata(string.Empty, (d, e) =>
                {
                    var self = (MuiSearch)d;
                    var value = (string)e.NewValue;
                    if (self._searchBar.Value != value) self._searchBar.Value = value;
                }));

        public static readonly DependencyProperty SuggestionsProperty =
            DependencyProperty.Register(nameof(Suggestions), typeof(IReadOnlyList<MuiSuggestionItem>), typeof(MuiSearch),
                new PropertyMetadata(null, (d, e) => ((MuiSearch)d)._suggestions.Items = (IReadOnlyList<MuiSuggestionItem>?)e.NewValue));

        public static readonly DependencyProperty ShowSuggestionsProperty =
            DependencyProperty.Register(nameof(ShowSuggestions), typeof(bool), typeof(MuiSearch),
                new PropertyMetadata(false, (d, e) => ((MuiSearch)d)._suggestions.IsOpen = (bool)e.NewValue));

        public static readonly DependencyProperty RecentChipsProperty =
            DependencyProperty.Register(nameof(RecentChips), typeof(IReadOnlyList<MuiChip>), typeof(MuiSearch),
                new PropertyMetadata(null, (d, e) =>
                {
                    var self = (MuiSearch)d;
                    var chips = (IReadOnlyList<MuiChip>?)e.NewValue;
                    self._recentChips.Chips = chips;
                    self._recentChips.Visibility = chips is { Count: > 0 } ? Visibility.Visible : Visibility.Collapsed;
                }));

        public static readonly DependencyProperty FacetsProperty =
            DependencyProperty.Register(nameof(Facets), typeof(IReadOnlyList<MuiFilterFacet>), typeof(MuiSearch),
                new PropertyMetadata(null, (d, e) => ((MuiSearch)d)._filterPanel.Facets = (IReadOnlyList<MuiFilterFacet>?)e.NewValue));

        public static readonly DependencyProperty SelectedOptionIdsProperty =
            DependencyProperty.Register(nameof(SelectedOptionIds), typeof(IReadOnlyList<string>), typeof(MuiSearch),
                new PropertyMetadata(null, (d, e) => ((MuiSearch)d)._filterPanel.SelectedOptionIds = (IReadOnlyList<string>?)e.NewValue));

        public static readonly DependencyProperty ResultsProperty =
            DependencyProperty.Register(nameof(Results), typeof(IReadOnlyList<MuiCollectionGridItem>), typeof(MuiSearch),
                new PropertyMetadata(null, (d, e) => ((MuiSearch)d)._results.Items = (IReadOnlyList<MuiCollectionGridItem>?)e.NewValue));

        public static readonly DependencyProperty ResultTotalCountProperty =
            DependencyProperty.Register(nameof(ResultTotalCount), typeof(int), typeof(MuiSearch),
                new PropertyMetadata(0, (d, e) => ((MuiSearch)d)._results.TotalCount = (int)e.NewValue));

        public static readonly DependencyProperty IsLoadingResultsProperty =
            DependencyProperty.Register(nameof(IsLoadingResults), typeof(bool), typeof(MuiSearch),
                new PropertyMetadata(false, (d, e) => ((MuiSearch)d)._results.IsLoadingPage = (bool)e.NewValue));

        public string Query { get => (string)GetValue(QueryProperty); set => SetValue(QueryProperty, value); }
        public IReadOnlyList<MuiSuggestionItem>? Suggestions { get => (IReadOnlyList<MuiSuggestionItem>?)GetValue(SuggestionsProperty); set => SetValue(SuggestionsProperty, value); }
        public bool ShowSuggestions { get => (bool)GetValue(ShowSuggestionsProperty); set => SetValue(ShowSuggestionsProperty, value); }
        public IReadOnlyList<MuiChip>? RecentChips { get => (IReadOnlyList<MuiChip>?)GetValue(RecentChipsProperty); set => SetValue(RecentChipsProperty, value); }
        public IReadOnlyList<MuiFilterFacet>? Facets { get => (IReadOnlyList<MuiFilterFacet>?)GetValue(FacetsProperty); set => SetValue(FacetsProperty, value); }
        public IReadOnlyList<string>? SelectedOptionIds { get => (IReadOnlyList<string>?)GetValue(SelectedOptionIdsProperty); set => SetValue(SelectedOptionIdsProperty, value); }
        public IReadOnlyList<MuiCollectionGridItem>? Results { get => (IReadOnlyList<MuiCollectionGridItem>?)GetValue(ResultsProperty); set => SetValue(ResultsProperty, value); }
        public int ResultTotalCount { get => (int)GetValue(ResultTotalCountProperty); set => SetValue(ResultTotalCountProperty, value); }
        public bool IsLoadingResults { get => (bool)GetValue(IsLoadingResultsProperty); set => SetValue(IsLoadingResultsProperty, value); }

        public event EventHandler<string>? QueryChanged;
        public event EventHandler<string>? QueryCommitted;
        public event EventHandler<string>? SuggestionSelected;
        public event EventHandler<string>? RecentQueryRemoved;
        public event EventHandler<IReadOnlyList<string>>? FacetSelectionChanged;
        public event EventHandler<IReadOnlyList<string>>? ResultSelectionChanged;
        public event EventHandler<string>? ResultActivated;

        private readonly Grid _root = new();
        private readonly StackPanel _column = new() { Orientation = Orientation.Vertical, Spacing = 12 };
        private readonly MuiSearchBar _searchBar = new() { Placeholder = "Search photos, people, places…" };
        private readonly MuiSuggestionMenu _suggestions = new();
        private readonly MuiChipRow _recentChips = new() { Mode = MuiChipRowMode.Removable, Visibility = Visibility.Collapsed };
        private readonly Grid _body = new();
        private readonly MuiFilterPanel _filterPanel = new();
        private readonly MuiSearchResults _results = new();

        public MuiSearch()
        {
            var searchAnchor = new Grid();
            searchAnchor.Children.Add(_searchBar);
            searchAnchor.Children.Add(_suggestions);

            _body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(220) });
            _body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            Grid.SetColumn(_filterPanel, 0);
            Grid.SetColumn(_results, 1);
            _filterPanel.Margin = new Thickness(0, 0, 16, 0);
            _body.Children.Add(_filterPanel);
            _body.Children.Add(_results);

            _column.Children.Add(searchAnchor);
            _column.Children.Add(_recentChips);
            _column.Children.Add(_body);
            _root.Children.Add(_column);
            Content = _root;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            _searchBar.RegisterPropertyChangedCallback(MuiSearchBar.ValueProperty, (_, _) =>
            {
                Query = _searchBar.Value;
                QueryChanged?.Invoke(this, _searchBar.Value);
            });
            _searchBar.Committed += (_, text) => QueryCommitted?.Invoke(this, text);
            _suggestions.ItemSelected += (_, id) => { ShowSuggestions = false; SuggestionSelected?.Invoke(this, id); };
            _suggestions.CloseRequested += (_, _) => ShowSuggestions = false;
            _recentChips.Removed += (_, id) => RecentQueryRemoved?.Invoke(this, id);
            _filterPanel.SelectionChanged += (_, ids) => FacetSelectionChanged?.Invoke(this, ids);
            _results.SelectionChanged += (_, ids) => ResultSelectionChanged?.Invoke(this, ids);
            _results.ItemActivated += (_, id) => ResultActivated?.Invoke(this, id);
        }
    }
}
