using System.Collections.Generic;
using System.Linq;

namespace Maple.UI
{
    /// <summary>Plain, WinUI-free decision logic behind
    /// <c>MuiPageTVTimeline</c>'s cross-organism wiring (#3012) — a range
    /// Chip Row selection filters the SAME underlying asset list feeding
    /// both the Timeline and Collection Grid organisms (the Tab Shell
    /// just switches which of the two is visible), so switching tabs
    /// never loses the active range.</summary>
    public static class MuiTvTimelinePageReducer
    {
        public static IReadOnlyList<string> AssetIdsForRange(IReadOnlyList<MuiMockAsset> assets, string rangeId) =>
            rangeId switch
            {
                "iceland" => assets.Where(a => a.FolderId == "iceland").Select(a => a.Id).ToList(),
                "wedding" => assets.Where(a => a.FolderId.StartsWith("wedding")).Select(a => a.Id).ToList(),
                "studio" => assets.Where(a => a.FolderId == "studio").Select(a => a.Id).ToList(),
                _ => assets.Select(a => a.Id).ToList(),
            };
    }
}
