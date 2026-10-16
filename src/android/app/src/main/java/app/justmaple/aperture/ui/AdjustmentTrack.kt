package app.justmaple.aperture.ui

import androidx.compose.ui.graphics.Brush
import app.justmaple.aperture.generated.AdjustmentField
import app.justmaple.aperture.generated.SliderGradients

/** Same primary/sub-parameter palettes as iOS GradientCatalog. */
internal fun adjustmentTrack(field: AdjustmentField, alpha: Float = 1f): Brush {
    val stops =
        when (field.name) {
            "exposure" -> SliderGradients.exposure
            "brightness" -> SliderGradients.brightness
            "contrast" -> SliderGradients.contrast
            "highlights" -> SliderGradients.highlights
            "shadows" -> SliderGradients.shadows
            "whites" -> SliderGradients.whites
            "blacks" -> SliderGradients.blacks
            "temperature" -> SliderGradients.temp
            "tint" -> SliderGradients.tint
            "vibrance" -> SliderGradients.vibrance
            "saturation" -> SliderGradients.saturation
            "clarity" -> SliderGradients.clarity
            "texture" -> SliderGradients.texture
            "dehaze" -> SliderGradients.dehaze
            "vignette_amount", "vignette_feather" -> SliderGradients.vignette
            "grain_amount", "grain_size", "grain_roughness" -> SliderGradients.grain
            "sharpen_amount", "sharpen_radius", "sharpen_detail", "sharpen_masking" ->
                SliderGradients.sharpen
            "nr_luminance", "deep_denoise", "chroma_prefilter" -> SliderGradients.noise
            "nr_color" -> SliderGradients.colorNR
            "capture_sharpening_amount" -> SliderGradients.captureSharpen
            "capture_sharpening_sigma" -> SliderGradients.captureSigma
            else -> arrayOf(0f to MapleColors.border, 1f to MapleColors.borderHi)
        }
    return Brush.horizontalGradient(*stops.map { (position, color) ->
        position to color.copy(alpha = alpha)
    }.toTypedArray())
}
