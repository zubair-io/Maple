package app.justmaple.aperture.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.*
import app.justmaple.aperture.R
import app.justmaple.aperture.data.XmpDocument
import app.justmaple.aperture.generated.AdjustmentField
import app.justmaple.aperture.generated.FilmCatalog

@Composable
internal fun ControlsInspector(
    model: MapleViewModel,
    state: MapleState,
    group: EditorGroup,
    modifier: Modifier,
) {
    var filmsOpen by remember { mutableStateOf(false) }
    val filmId = state.document.attribute("papp:FilmLook").orEmpty()
    val bw = state.document.attribute("crs:ConvertToGrayscale")
    val monochrome = bw == "1" || bw.equals("True", ignoreCase = true)
    val effectiveProfile =
        state.document.attribute("papp:Profile")
            ?: if (state.document.attribute("papp:Look") == "Neutral") "Neutral" else "Auto"
    Column(modifier.background(MapleColors.surface)) {
        if (state.values["_raw"] != 0f)
            MuiSection("Profile") {
                Row {
                    for (profile in listOf("Auto", "Neutral")) FilterChip(
                        selected = effectiveProfile == profile,
                        onClick = { model.attribute("papp:Profile", profile) },
                        label = { Text(profile) },
                        modifier = Modifier.padding(end = 8.dp),
                    )
                }
            }
        if (group == EditorGroup.Color)
            Row(
                Modifier.padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Black & white", Modifier.weight(1f))
                Switch(
                    monochrome,
                    { model.attribute("crs:ConvertToGrayscale", if (it) "True" else null) },
                )
            }
        if (group == EditorGroup.Effects)
            Box(Modifier.padding(horizontal = 16.dp)) {
                TextButton({ filmsOpen = true }) {
                    Text(
                        "Film · ${FilmCatalog.all.find { it.id == filmId }?.label ?: filmId.ifEmpty { "None" }}"
                    )
                }
                DropdownMenu(
                    filmsOpen,
                    { filmsOpen = false },
                    modifier = Modifier.heightIn(max = 320.dp),
                ) {
                    DropdownMenuItem(
                        text = { Text("None") },
                        onClick = {
                            model.attribute("papp:FilmLook", null)
                            filmsOpen = false
                        },
                    )
                    FilmCatalog.all.forEach { film ->
                        DropdownMenuItem(
                            text = { Text(film.label) },
                            onClick = {
                                model.attribute("papp:FilmLook", film.id)
                                filmsOpen = false
                            },
                        )
                    }
                }
            }
        LazyColumn(Modifier.weight(1f)) {
            items(group.fields.filter(state::supportsField), key = { it.name }) { field ->
                Column(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
                    Row {
                        Text(fieldLabel(field), Modifier.weight(1f))
                        Text(
                            displayValue(field, state.values[field.name] ?: field.initial),
                            color = MapleColors.muted,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                    AdjustmentSlider(
                        field,
                        state.values[field.name] ?: field.initial,
                        onChange = { model.setField(field.name, it) },
                        onCommit = model::commitGesture,
                        enabled =
                            !state.rendering &&
                                (field.name != "film_strength" || filmId.isNotEmpty()) &&
                                (!field.name.startsWith("gray_mixer_") || monochrome),
                    )
                }
            }
        }
    }
}

internal fun displayValue(field: AdjustmentField, value: Float) =
    when (field.name) {
        "temperature" -> "${value.toInt()} K"
        "exposure" -> "${XmpDocument.format(value)} EV"
        else -> XmpDocument.format(value)
    }

internal fun toolGlyph(field: String): Int =
    when (field) {
        "exposure" -> R.drawable.tool_exposure
        "brightness" -> R.drawable.tool_brightness
        "contrast" -> R.drawable.tool_contrast
        "highlights" -> R.drawable.tool_highlights
        "shadows" -> R.drawable.tool_shadows
        "whites" -> R.drawable.tool_whites
        "blacks" -> R.drawable.tool_blacks
        "temperature" -> R.drawable.tool_temp
        "tint" -> R.drawable.tool_tint
        "vibrance" -> R.drawable.tool_vibrance
        "saturation" -> R.drawable.tool_saturation
        "clarity" -> R.drawable.tool_clarity
        "texture" -> R.drawable.tool_texture
        "dehaze" -> R.drawable.tool_dehaze
        "vignette_amount" -> R.drawable.tool_vignette
        "grain_amount" -> R.drawable.tool_grain
        "sharpen_amount" -> R.drawable.tool_sharpen
        "nr_luminance" -> R.drawable.tool_noise
        "nr_color" -> R.drawable.tool_color_nr
        "capture_sharpening_amount",
        "capture_sharpening_sigma" -> R.drawable.tool_capture_sharpen
        else -> R.drawable.tool_presets
    }
