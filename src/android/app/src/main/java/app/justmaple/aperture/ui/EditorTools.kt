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
                else -> emptyList()
            }

    val fields: List<AdjustmentField> by lazy {
        AdjustmentFields.all.filter { field ->
            if (field.xmp.isEmpty()) false
            else
                when (this) {
                    Light ->
                        field.name in tools.map { it.field } || field.name.startsWith("parametric_")
                    Color ->
                        field.name in tools.map { it.field } ||
                            field.name.contains("adjustment_") ||
                            field.name.startsWith("gray_mixer_")
                    Effects ->
                        field.name in tools.map { it.field } ||
                            field.name.startsWith("vignette_") ||
                            field.name.startsWith("grain_") ||
                            field.name.startsWith("color_grade_") ||
                            field.name.startsWith("split_ton") ||
                            field.name == "film_strength"
                    Detail ->
                        field.name !in Light.fields.map { it.name } &&
                            field.name !in Color.fields.map { it.name } &&
                            field.name !in Effects.fields.map { it.name } &&
                            !field.name.startsWith("wb_")
                }
        }
    }
}

fun fieldLabel(field: AdjustmentField): String =
    EditorGroup.entries.flatMap { it.tools }.find { it.field == field.name }?.label
        ?: field.name.split('_').joinToString(" ") { it.replaceFirstChar(Char::uppercaseChar) }

fun app.justmaple.aperture.MapleState.supportsField(field: AdjustmentField): Boolean =
    values["_raw"] != 0f || (field.rasterSupported && !field.name.startsWith("capture_sharpening_"))
