package app.justmaple.aperture.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.MapleViewModel
import app.justmaple.aperture.generated.AdjustmentField
import app.justmaple.aperture.generated.AdjustmentFields

enum class HslBand(val label: String, val key: String) {
    Red("Red", "red"),
    Orange("Orange", "orange"),
    Yellow("Yellow", "yellow"),
    Green("Green", "green"),
    Aqua("Aqua", "aqua"),
    Blue("Blue", "blue"),
    Purple("Purple", "purple"),
    Magenta("Magenta", "magenta"),
}

data class WbPreset(val label: String, val temperature: Float?, val tint: Float?)

val wbPresets = listOf(
    WbPreset("As Shot", null, null),
    WbPreset("Auto", null, null),
    WbPreset("Daylight 5500K", 5500f, 10f),
    WbPreset("Cloudy 6500K", 6500f, 10f),
    WbPreset("Shade 7500K", 7500f, 10f),
    WbPreset("Tungsten 2850K", 2850f, 0f),
    WbPreset("Fluorescent 3800K", 3800f, 20f),
    WbPreset("Flash 5500K", 5500f, 0f),
)

data class EditorSubTool(val id: String, val label: String)

val toneCurveFieldNames =
    listOf("parametric_shadows", "parametric_darks", "parametric_lights", "parametric_highlights")

val toneCurveFields: List<AdjustmentField>
    get() = toneCurveFieldNames.map(AdjustmentFields.byName::getValue)

fun subToolsFor(group: EditorGroup): List<EditorSubTool> =
    when (group) {
        EditorGroup.Light -> listOf(EditorSubTool("basic", "Basic"), EditorSubTool("curve", "Tone Curve"))
        EditorGroup.Color ->
            listOf(
                EditorSubTool("basic", "Basic"),
                EditorSubTool("wb", "WB Presets"),
                EditorSubTool("hsl", "HSL"),
            )
        EditorGroup.Detail ->
            listOf(EditorSubTool("basic", "Basic"), EditorSubTool("crop", "Crop"))
        else -> listOf(EditorSubTool("basic", "Basic"))
    }

fun fieldsForSubTool(
    group: EditorGroup,
    subToolId: String,
    fullInspector: Boolean = false,
): List<AdjustmentField> =
    when {
        group == EditorGroup.Light && subToolId == "curve" -> toneCurveFields
        fullInspector -> group.fields
        else -> group.tools.map { AdjustmentFields.byName.getValue(it.field) }
    }

fun hslBandFields(band: HslBand): List<AdjustmentField> =
    listOf("hue_adjustment_", "saturation_adjustment_", "luminance_adjustment_").map {
        AdjustmentFields.byName.getValue(it + band.key)
    }

fun wbPresetEdits(preset: WbPreset): Map<String, Float>? {
    val temperature = preset.temperature
    val tint = preset.tint
    if (temperature == null || tint == null) return null
    return mapOf("temperature" to temperature, "tint" to tint)
}

fun MapleViewModel.applyWbPreset(preset: WbPreset) {
    val edits = wbPresetEdits(preset)
    if (edits == null) {
        resetFields(listOf("temperature", "tint"))
    } else {
        edits.forEach { (name, value) -> setField(name, value) }
        commitGesture()
    }
}

@Composable
internal fun SubToolSelector(
    subTools: List<EditorSubTool>,
    activeId: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyRow(modifier.testTag("sub-tool-selector")) {
        items(subTools, key = { it.id }) { subTool ->
            FilterChip(
                subTool.id == activeId,
                { onSelect(subTool.id) },
                { Text(subTool.label) },
                Modifier.padding(end = 8.dp).testTag("sub-tool-${subTool.id}"),
            )
        }
    }
}

@Composable
internal fun WbPresetChips(
    presets: List<WbPreset>,
    onApply: (WbPreset) -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyRow(modifier.testTag("wb-presets")) {
        items(presets, key = { it.label }) { preset ->
            FilterChip(
                false,
                { onApply(preset) },
                { Text(preset.label) },
                Modifier.padding(end = 8.dp).testTag("wb-preset-${preset.label}"),
            )
        }
    }
}

@Composable
internal fun HslBandChips(
    band: HslBand,
    onBand: (HslBand) -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyRow(modifier.testTag("hsl-bands")) {
        items(HslBand.entries, key = { it.key }) { entry ->
            FilterChip(
                entry == band,
                { onBand(entry) },
                { Text(entry.label) },
                Modifier.padding(end = 8.dp).testTag("hsl-band-${entry.key}"),
            )
        }
    }
}

@Composable
internal fun AdjustmentSliderRow(
    field: AdjustmentField,
    value: Float,
    enabled: Boolean,
    onChange: (Float) -> Unit,
    onCommit: () -> Unit,
) {
    Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
        Row {
            Text(
                fieldLabel(field),
                Modifier.weight(1f),
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                displayValue(field, value),
                color = MapleColors.muted,
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.labelMedium,
            )
        }
        AdjustmentSlider(field, value, enabled, onChange, onCommit)
    }
}
