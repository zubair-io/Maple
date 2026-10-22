package app.justmaple.aperture.ui

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.ui.graphics.vector.ImageVector
import app.justmaple.aperture.generated.AdjustmentField
import app.justmaple.aperture.generated.AdjustmentFields

data class EditorTool(val label: String, val field: String, val icon: ImageVector)

enum class EditorGroup(val label: String, val tools: List<EditorTool>) {
    Light(
        "Light",
        listOf(
            EditorTool("Exposure", "exposure", Icons.Outlined.Exposure),
            EditorTool("Brightness", "brightness", Icons.Outlined.BrightnessMedium),
            EditorTool("Contrast", "contrast", Icons.Outlined.Contrast),
            EditorTool("Highlights", "highlights", Icons.Outlined.LightMode),
            EditorTool("Shadows", "shadows", Icons.Outlined.Tonality),
            EditorTool("Whites", "whites", Icons.Outlined.RadioButtonUnchecked),
            EditorTool("Blacks", "blacks", Icons.Outlined.Circle),
        ),
    ),
    Color(
        "Color",
        listOf(
            EditorTool("Temp", "temperature", Icons.Outlined.Thermostat),
            EditorTool("Tint", "tint", Icons.Outlined.Tune),
            EditorTool("Vibrance", "vibrance", Icons.Outlined.FilterVintage),
            EditorTool("Saturation", "saturation", Icons.Outlined.Palette),
        ),
    ),
    Effects(
        "Effects",
        listOf(
            EditorTool("Clarity", "clarity", Icons.Outlined.BlurOn),
            EditorTool("Texture", "texture", Icons.Outlined.Texture),
            EditorTool("Dehaze", "dehaze", Icons.Outlined.Dehaze),
            EditorTool("Vignette", "vignette_amount", Icons.Outlined.Vignette),
            EditorTool("Grain", "grain_amount", Icons.Outlined.Grain),
        ),
    ),
    Detail(
        "Detail",
        listOf(
            EditorTool("Sharpen", "sharpen_amount", Icons.Outlined.Details),
            EditorTool("Noise", "nr_luminance", Icons.Outlined.BlurOff),
            EditorTool("Color NR", "nr_color", Icons.Outlined.FilterBAndW),
            EditorTool("Deconv", "capture_sharpening_amount", Icons.Outlined.CenterFocusStrong),
            EditorTool("Deconv σ", "capture_sharpening_sigma", Icons.Outlined.Adjust),
        ),
    );

    val resetAttributes: List<String>
        get() =
            when (this) {
                Color -> listOf("crs:ConvertToGrayscale")
                Effects -> listOf("papp:FilmLook")
                Detail ->
                    listOf(
                        "crs:HasCrop",
                        "crs:CropTop",
                        "crs:CropLeft",
                        "crs:CropBottom",
                        "crs:CropRight",
                        "crs:CropAngle",
                    )
                else -> emptyList()
            }

    // Audited against iOS ToolModel / ToolSubParam (#4662). Curve and HSL
    // scalar rows are deliberately excluded; pipeline schema growth must
    // never automatically add inspector sliders.
    val fields: List<AdjustmentField> by lazy {
        val names =
            when (this) {
                Light -> tools.map { it.field }
                Color -> tools.map { it.field } + listOf(
                    "gray_mixer_red", "gray_mixer_orange", "gray_mixer_yellow", "gray_mixer_green",
                    "gray_mixer_aqua", "gray_mixer_blue", "gray_mixer_purple", "gray_mixer_magenta",
                )
                Effects -> listOf(
                    "clarity", "texture", "dehaze", "vignette_amount", "vignette_feather",
                    "grain_amount", "grain_size", "grain_roughness", "film_strength",
                    "split_tone_shadow_hue", "split_tone_shadow_saturation",
                    "split_tone_highlight_hue", "split_tone_highlight_saturation", "split_tone_balance",
                    "color_grade_shadow_luminance", "color_grade_midtone_hue",
                    "color_grade_midtone_saturation", "color_grade_midtone_luminance",
                    "color_grade_highlight_luminance", "color_grade_global_hue",
                    "color_grade_global_saturation", "color_grade_global_luminance",
                )
                Detail -> listOf(
                    "sharpen_amount", "sharpen_radius", "sharpen_detail", "sharpen_masking",
                    "nr_luminance", "nr_color", "deep_denoise", "chroma_prefilter",
                    "capture_sharpening_amount", "capture_sharpening_sigma",
                    "lens_correction_distortion", "lens_correction_ca", "lens_correction_vignetting",
                    "perspective_vertical", "perspective_horizontal", "perspective_rotate",
                    "perspective_scale", "perspective_aspect", "perspective_x", "perspective_y",
                    "defringe_purple_amount", "defringe_purple_hue_lo", "defringe_purple_hue_hi",
                    "defringe_green_amount", "defringe_green_hue_lo", "defringe_green_hue_hi",
                )
            }
        names.map(AdjustmentFields.byName::getValue)
    }
}

fun fieldLabel(field: AdjustmentField): String =
    EditorGroup.entries.flatMap { it.tools }.find { it.field == field.name }?.label
        ?: field.name.split('_').joinToString(" ") { it.replaceFirstChar(Char::uppercaseChar) }

fun app.justmaple.aperture.MapleState.supportsField(field: AdjustmentField): Boolean =
    values["_raw"] != 0f || (field.rasterSupported && !field.name.startsWith("capture_sharpening_"))
