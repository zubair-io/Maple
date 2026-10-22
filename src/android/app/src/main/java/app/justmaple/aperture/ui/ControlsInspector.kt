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
import androidx.compose.ui.platform.testTag
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
    activeSubTool: String? = null,
    onSubToolChange: ((String) -> Unit)? = null,
) {
    var filmsOpen by remember { mutableStateOf(false) }
    val subTools = remember(group) { subToolsFor(group) }
    var internalSubTool by remember(group) { mutableStateOf(subTools.first().id) }
    val subTool = activeSubTool ?: internalSubTool
    val setSubTool: (String) -> Unit = {
        internalSubTool = it
        onSubToolChange?.invoke(it)
    }
    var band by remember(group) { mutableStateOf(HslBand.Red) }
    val filmId = state.document.attribute("papp:FilmLook").orEmpty()
    val bw = state.document.attribute("crs:ConvertToGrayscale")
    val monochrome = bw == "1" || bw.equals("True", ignoreCase = true)
    Column(modifier) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "ADJUSTMENTS",
                Modifier.weight(1f),
                style = MaterialTheme.typography.labelMedium,
                color = MapleColors.muted,
            )
            TextButton(
                { model.resetGroup(group) },
                enabled = state.canEdit,
            ) {
                Text("Reset ${group.label}")
            }
        }
        HorizontalDivider(color = MapleColors.border, thickness = .5.dp)
        Text(
            group.label.uppercase(),
            Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
            color = MapleColors.muted,
            style = MaterialTheme.typography.labelMedium,
        )

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
        if (subTools.size > 1)
            SubToolSelector(
                subTools,
                subTool,
                setSubTool,
                Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            )
        if (group == EditorGroup.Light && subTool == "curve")
            ParametricToneCurvePlot(state)
        if (group == EditorGroup.Color && subTool == "wb")
            WbPresetChips(
                wbPresets,
                model::applyWbPreset,
                state,
                Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            )
        if (group == EditorGroup.Color && subTool == "hsl")
            HslBandChips(band, { band = it }, Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        if (group == EditorGroup.Effects && subTool == "presets")
            BuiltInPresetsRow(
                model,
                state,
                Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            )
        if (group == EditorGroup.Detail && subTool == "crop")
            CropControlsSection(model, state, Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        val sliderFields =
            when {
                group == EditorGroup.Color && subTool == "hsl" -> hslBandFields(band)
                else -> fieldsForSubTool(group, subTool, fullInspector = true)
            }
        key(group, subTool, band) {
            LazyColumn(Modifier.weight(1f).testTag("adjustment-sliders")) {
                items(
                    sliderFields.filter {
                        state.supportsField(it) && (!it.name.startsWith("gray_mixer_") || monochrome)
                    },
                    key = { it.name },
                ) { field ->
                    AdjustmentSliderRow(
                        field,
                        state.values[field.name] ?: field.initial,
                        state.canEdit &&
                            (field.name != "film_strength" || filmId.isNotEmpty()) &&
                            (!field.name.startsWith("gray_mixer_") || monochrome),
                        onChange = { model.setField(field.name, it) },
                        onCommit = model::commitGesture,
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
