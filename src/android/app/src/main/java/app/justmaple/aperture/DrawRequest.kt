package app.justmaple.aperture

internal data class DrawRequest(
    val generation: Int,
    val revision: Int,
    val values: Map<String, Float>,
    val xml: String,
)
