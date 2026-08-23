namespace Maple.UI
{
    /// <summary>Frame-time budget status (unified-component-catalog.md
    /// §2.3, "Frame-time HUD" row).</summary>
    public enum MuiFrameTimeStatus { Good, Warn, Bad }

    /// <summary>
    /// Plain, WinUI-free budget classification behind the Maple.UI
    /// Frame-time HUD molecule (unified-component-catalog.md §2.3). Same
    /// split as <see cref="MuiSliderMath"/> — linkable into
    /// Maple.WinUI.Tests without a live Window.
    ///
    /// Ports `mui-frame-time-hud.component.ts`'s `status`/`displayFps`
    /// computeds, color-coding against Maple's own perf invariants
    /// (CLAUDE.md "Performance invariants": 16ms slider-tick target, 50ms
    /// hard limit) so the HUD flags a budget breach rather than just
    /// reporting a bare number.
    /// </summary>
    public static class MuiFrameTimeClassifier
    {
        public const double DefaultBudgetMs = 16;
        public const double DefaultHardLimitMs = 50;

        /// <summary>At/under <paramref name="budgetMs"/> is Good; over that
        /// but at/under <paramref name="hardLimitMs"/> is Warn; over the
        /// hard limit is Bad.</summary>
        public static MuiFrameTimeStatus Classify(
            double frameMs, double budgetMs = DefaultBudgetMs, double hardLimitMs = DefaultHardLimitMs)
        {
            if (frameMs > hardLimitMs) return MuiFrameTimeStatus.Bad;
            if (frameMs > budgetMs) return MuiFrameTimeStatus.Warn;
            return MuiFrameTimeStatus.Good;
        }

        /// <summary>Frames per second for a given frame time, or
        /// <paramref name="explicitFps"/> when the caller already has a
        /// measured value to display instead of deriving one. A
        /// non-positive frame time reports 0 fps rather than dividing by
        /// zero.</summary>
        public static double ComputeFps(double frameMs, double? explicitFps)
        {
            if (explicitFps is { } fps) return fps;
            return frameMs > 0 ? System.Math.Round(1000.0 / frameMs) : 0;
        }
    }
}
