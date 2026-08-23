using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;

namespace Maple.UI.Pages
{
    /// <summary>
    /// Maple.UI Search page (unified-component-catalog.md §6 — App Shell
    /// template hosting a single Search organism). Windows Pages wave
    /// (#3012).
    ///
    /// Real wiring, all funneled through <see cref="MuiSearchPageReducer"/>:
    /// typing updates live filename suggestions without touching the
    /// result grid (a query only actually filters once committed — Enter
    /// or a suggestion pick); the folder facet ANDs with whatever text
    /// query is active, matching a real search's "narrow, don't
    /// replace" facet behavior.
    /// </summary>
    public sealed class MuiPageSearch : ContentControl
    {
        private static readonly (string Id, string Label, int Count)[] FolderFacetOptions =
        {
            ("wedding-ceremony", "Ceremony", 3),
            ("wedding-reception", "Reception", 3),
            ("iceland", "Iceland Roadtrip", 4),
            ("studio", "Studio Portraits", 2),
        };

        private readonly MuiSearch _search = new();
        private readonly List<string> _recentQueries = new() { "iceland", "ceremony" };
        private string _query = string.Empty;
        private IReadOnlyList<string> _selectedFolderIds = Array.Empty<string>();

        public MuiPageSearch()
        {
            _search.Facets = new[]
            {
                new MuiFilterFacet("folder", "Folder", FolderFacetOptions
                    .Select(f => new MuiFilterOption(f.Id, f.Label, f.Count)).ToList()),
            };

            _search.QueryChanged += (_, query) =>
            {
                _query = query;
                var suggestions = MuiPageMockLibrary.Assets
                    .Where(a => !string.IsNullOrWhiteSpace(query) && a.Filename.Contains(query, StringComparison.OrdinalIgnoreCase))
                    .Take(5)
                    .Select(a => new MuiSuggestionItem(a.Id, a.Filename, "photos", a.FolderId))
                    .ToList();
                _search.Suggestions = suggestions;
                _search.ShowSuggestions = suggestions.Count > 0;
            };
            _search.QueryCommitted += (_, query) => { _query = query; _search.ShowSuggestions = false; Recompute(); };
            _search.SuggestionSelected += (_, id) =>
            {
                var asset = MuiPageMockLibrary.Assets.FirstOrDefault(a => a.Id == id);
                _query = asset?.Filename ?? _query;
                _search.Query = _query;
                _search.ShowSuggestions = false;
                Recompute();
            };
            _search.FacetSelectionChanged += (_, ids) => { _selectedFolderIds = ids; _search.SelectedOptionIds = ids; Recompute(); };
            _search.RecentQueryRemoved += (_, query) =>
            {
                _recentQueries.Remove(query);
                _search.RecentChips = _recentQueries.Select(q => new MuiChip(q, q)).ToList();
            };

            _search.RecentChips = _recentQueries.Select(q => new MuiChip(q, q)).ToList();

            var shell = new MuiAppShell { MainContent = _search };
            Content = shell;
            HorizontalContentAlignment = Microsoft.UI.Xaml.HorizontalAlignment.Stretch;
            VerticalContentAlignment = Microsoft.UI.Xaml.VerticalAlignment.Stretch;

            Recompute();
        }

        private void Recompute()
        {
            var ids = MuiSearchPageReducer.Filter(MuiPageMockLibrary.Assets, _query, _selectedFolderIds);
            var set = new HashSet<string>(ids);
            var results = MuiPageMockLibrary.Assets
                .Where(a => set.Contains(a.Id))
                .Select(a => new MuiCollectionGridItem(a.Id, MuiPageBitmap.ForAsset(a), a.Filename, a.Filename, Rating: a.Rating))
                .ToList();

            _search.Results = results;
            _search.ResultTotalCount = results.Count;
        }
    }
}
