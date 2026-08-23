using System;
using System.Collections.Generic;
using System.Linq;

namespace Maple.UI
{
    /// <summary>Plain, WinUI-free decision logic behind
    /// <c>MuiPageSearch</c>'s cross-organism wiring (#3012) — the Search
    /// organism's own facet-selection and query-commit events both narrow
    /// the same result set, so a folder facet plus typed text combine
    /// (AND, not OR) the same way the web page's own filtered-results
    /// computed does.</summary>
    public static class MuiSearchPageReducer
    {
        public static IReadOnlyList<string> Filter(
            IReadOnlyList<MuiMockAsset> assets, string query, IReadOnlyList<string> selectedFolderIds)
        {
            IEnumerable<MuiMockAsset> pool = assets;

            if (selectedFolderIds.Count > 0)
            {
                var set = new HashSet<string>(selectedFolderIds);
                pool = pool.Where(a => set.Contains(a.FolderId));
            }

            if (!string.IsNullOrWhiteSpace(query))
            {
                var q = query.Trim();
                pool = pool.Where(a => a.Filename.Contains(q, StringComparison.OrdinalIgnoreCase));
            }

            return pool.Select(a => a.Id).ToList();
        }
    }
}
