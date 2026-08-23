namespace Maple.UI
{
    /// <summary>Plain, WinUI-free decision logic behind
    /// <c>MuiPageTVMap</c>'s cross-organism wiring (#3012) — past a
    /// pin-count threshold, individual pins stop being legible from a
    /// couch-distance TV screen, so the Map Surface switches to its
    /// heatmap density layer instead of discrete pins.</summary>
    public static class MuiTvMapPageReducer
    {
        public const int HeatmapThreshold = 6;

        public static bool ShouldShowHeatmap(int visibleAssetCount) => visibleAssetCount >= HeatmapThreshold;
    }
}
