using System;
using System.Collections.Generic;
using System.Linq;

namespace Maple.UI
{
    /// <summary>Plain, WinUI-free decision logic behind
    /// <c>MuiPageBrowse</c>'s cross-organism wiring (Windows Pages wave,
    /// #3012) — same "math/logic file sits beside its WinUI-dependent
    /// control" split N6's organisms already use. Picking a Sidebar folder
    /// filters the Collection Grid to that folder AND its descendants (a
    /// "Ridgeline Farm Wedding" root also shows its Ceremony/Reception
    /// children's photos); a live Map Surface cluster selection narrows
    /// the result further, matching the web page's own sidebar-then-map
    /// intersection.</summary>
    public static class MuiBrowsePageReducer
    {
        /// <summary>Ids of the assets that should be visible given the
        /// active Sidebar folder (null/"all" = every folder) and an
        /// optional Map Surface cluster selection (null/empty = no map
        /// narrowing).</summary>
        public static IReadOnlyList<string> VisibleAssetIds(
            IReadOnlyList<MuiMockAsset> assets, string? activeFolderId, IReadOnlyList<string>? mapClusterIds)
        {
            IEnumerable<MuiMockAsset> pool = assets;
            if (!string.IsNullOrEmpty(activeFolderId) && activeFolderId != "all")
                pool = pool.Where(a => a.FolderId == activeFolderId || IsDescendantOf(a.FolderId, activeFolderId));

            if (mapClusterIds is { Count: > 0 })
            {
                var set = new HashSet<string>(mapClusterIds);
                pool = pool.Where(a => set.Contains(a.Id));
            }

            return pool.Select(a => a.Id).ToList();
        }

        /// <summary>Applies the Timeline strip's own recency range on top
        /// of an already-computed visible set — "recent" keeps only
        /// assets captured within the last 14 days of
        /// <paramref name="today"/>; any other range id (including "all")
        /// passes every id through untouched.</summary>
        public static IReadOnlyList<string> ApplyRecency(
            IReadOnlyList<string> visibleIds, IReadOnlyList<MuiMockAsset> assets, string rangeId, DateOnly today)
        {
            if (rangeId != "recent") return visibleIds;

            var cutoff = today.AddDays(-14);
            var byId = assets.ToDictionary(a => a.Id);
            return visibleIds.Where(id => byId.TryGetValue(id, out var a) && a.CapturedOn >= cutoff).ToList();
        }

        /// <summary>True when <paramref name="folderId"/> is
        /// <paramref name="ancestorId"/> itself or nested under it,
        /// walking <see cref="MuiMockFolder.ParentId"/> up to the root.</summary>
        private static bool IsDescendantOf(string folderId, string ancestorId)
        {
            if (folderId == ancestorId) return true;
            var current = MuiPageMockLibrary.Folders.FirstOrDefault(f => f.Id == folderId);
            while (current?.ParentId is not null)
            {
                if (current.ParentId == ancestorId) return true;
                current = MuiPageMockLibrary.Folders.FirstOrDefault(f => f.Id == current.ParentId);
            }
            return false;
        }
    }
}
