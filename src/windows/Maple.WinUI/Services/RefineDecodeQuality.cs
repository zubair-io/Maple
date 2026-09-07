namespace Maple.WinUI.Services
{
    /// <summary>
    /// Decode-quality escalation rule for the sized scene-linear FFI request
    /// (#3417), mirroring Apple's <c>ImageEditPipeline.refineDecodeQuality</c>
    /// (#2143). <c>maple_render_file_scene_linear_sized_f32</c>'s Preview
    /// quality (a half-res 2×2-binned demosaic) caps its OWN output at
    /// roughly half the sensor's native long edge no matter what
    /// <c>maxLongEdge</c> the caller requests — a request beyond that cap
    /// silently returns the half-res buffer anyway, which the canvas then
    /// has to upscale: on screen that reads as binned pixels at high zoom.
    /// Escalating to AMaZE (the full-resolution demosaic — the same quality
    /// the export path already uses) whenever the request genuinely needs
    /// more than half-res detail removes that shortfall. Below the
    /// threshold, Preview already delivers exactly the requested target (no
    /// cap ever engages), so no escalation is needed.
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
        /// The quality to request for a decode targeting
        /// <paramref name="targetLongEdge"/> px on a sensor whose native long
        /// edge is <paramref name="nativeLongEdge"/> px. Escalates to AMaZE
        /// once the target exceeds half the sensor's native long edge —
        /// below that threshold Preview's own cap never engages, so Preview
        /// already delivers precisely the requested target. A non-positive
        /// or non-finite <paramref name="nativeLongEdge"/> or
        /// <paramref name="targetLongEdge"/> (native size not yet known —
        /// e.g. EXIF could not be read) keeps Preview: there is no native
        /// reference to size the escalation decision against.
        /// </summary>
        public static int ForTarget(double nativeLongEdge, double targetLongEdge)
        {
            if (!double.IsFinite(nativeLongEdge) || nativeLongEdge <= 0)
                return Preview;
            if (!double.IsFinite(targetLongEdge) || targetLongEdge <= 0)
                return Preview;
            return targetLongEdge > nativeLongEdge / 2.0 ? Amaze : Preview;
        }
    }
}
