namespace Maple.WinUI.Services
{
    /// <summary>
    /// Refine-phase decode-quality plan for the sized scene-linear FFI
    /// request (#3417 + review), mirroring Apple's
    /// <c>ImageEditPipeline.refineDecodeQuality</c> (#2143). Pure decision
    /// logic — no I/O, no FFI, no WinUI — so it is unit-testable without a
    /// live decode.
    ///
    /// <c>maple_render_file_scene_linear_sized_f32</c>'s Preview quality (a
    /// half-res 2×2-binned demosaic) caps its OWN output at roughly half the
    /// sensor's native long edge no matter what <c>maxLongEdge</c> the
    /// caller requests — a request beyond that cap silently returns the
    /// half-res buffer anyway, which the canvas then has to upscale: on
    /// screen that reads as binned pixels at high zoom. AMaZE (the
    /// full-resolution demosaic — the same quality the export path already
    /// uses) removes that shortfall, but costs materially more time than
    /// Preview on a large sensor, so it is never the FIRST decode: cold open
    /// always decodes at Preview (CLAUDE.md's 250–1000ms uncached-open
    /// budget), and an AMaZE upgrade — cancellable, generation-guarded — is
    /// scheduled only afterward, swapping the base in once it lands.
    /// </summary>
    public static class RefineDecodeQuality
    {
        /// <summary>FFI <c>quality_preview</c> values
        /// (raw-ffi/src/scene_linear_f32.rs): 0 = Full (bilinear),
        /// 1 = Preview (half-res 2×2 binning), 2 = Amaze.</summary>
        public const int Full = 0;
        public const int Preview = 1;
        public const int Amaze = 2;

        /// <summary>
        /// The quality a decode targeting <paramref name="targetLongEdge"/>
        /// px on a sensor whose native long edge is
        /// <paramref name="nativeLongEdge"/> px would need to deliver that
        /// target without Preview's own cap engaging. Below the threshold,
        /// Preview already delivers precisely the requested target (no cap
        /// ever engages). A non-positive or non-finite
        /// <paramref name="nativeLongEdge"/> or <paramref name="targetLongEdge"/>
        /// (native size not yet known — e.g. EXIF could not be read) keeps
        /// Preview: there is no native reference to size the decision
        /// against.
        /// </summary>
        public static int ForTarget(double nativeLongEdge, double targetLongEdge)
        {
            if (!double.IsFinite(nativeLongEdge) || nativeLongEdge <= 0)
                return Preview;
            if (!double.IsFinite(targetLongEdge) || targetLongEdge <= 0)
                return Preview;
            return targetLongEdge > nativeLongEdge / 2.0 ? Amaze : Preview;
        }

        /// <summary>
        /// Whether a second, cancellable AMaZE decode should be scheduled
        /// AFTER the initial Preview decode has already landed and is on
        /// screen. Preview always runs first regardless of this answer —
        /// this only decides whether a follow-up upgrade is worth the extra
        /// demosaic time, never which quality the first (cold-open) decode
        /// requests.
        /// </summary>
        public static bool ShouldScheduleAmazeUpgrade(double nativeLongEdge, double targetLongEdge) =>
            ForTarget(nativeLongEdge, targetLongEdge) == Amaze;

        /// <summary>
        /// Whether an AMaZE upgrade decode that started for
        /// <paramref name="startedForGeneration"/> should still be applied,
        /// given the session is now on
        /// <paramref name="currentGeneration"/>. A newer decode (photo
        /// switch, a decode-owned field change) bumps the generation
        /// counter — an in-flight AMaZE result for a stale generation must
        /// be discarded, never swapped in on top of a newer base.
        /// </summary>
        public static bool IsStillCurrent(int startedForGeneration, int currentGeneration) =>
            startedForGeneration == currentGeneration;
    }
}
