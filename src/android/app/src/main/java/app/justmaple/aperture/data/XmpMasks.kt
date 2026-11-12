package app.justmaple.aperture.data

/** The local-adjustment containers raw-core reads; Android hands all four to the native writer. */
internal val MASK_CONTAINERS =
    setOf(
        "crs:GradientBasedCorrections",
        "crs:CircularGradientBasedCorrections",
        "papp:BrushCorrections",
        "crs:MaskGroupBasedCorrections",
    )
