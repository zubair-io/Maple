package app.justmaple.aperture.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.justmaple.aperture.MapleState
import app.justmaple.aperture.MapleViewModel
import app.justmaple.aperture.generated.AdjustmentFields
import java.util.Locale
import kotlin.math.abs
import app.justmaple.aperture.data.NativeBridge
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray

/**
 * Built-in presets matching Apple's `builtin-presets.json` (#5193).
 */
data class BuiltInPreset(
    val id: String,
    val name: String,
    val fields: Map<String, Float>,
)

val builtInPresets: List<BuiltInPreset> =
    listOf(
        BuiltInPreset("builtin-flat", "Flat", mapOf("contrast" to -50f)),
        BuiltInPreset("builtin-high-contrast", "High Contrast", mapOf("contrast" to 50f)),
        BuiltInPreset("builtin-monochrome", "Monochrome", mapOf("saturation" to -100f)),
        BuiltInPreset("builtin-no-sharpening", "No Sharpening", mapOf("sharpen_amount" to 0f)),
        BuiltInPreset("builtin-no-color-nr", "No Color NR", mapOf("nr_color" to 0f)),
    )

fun MapleViewModel.applyBuiltInPreset(preset: BuiltInPreset) {
    preset.fields.forEach { (name, value) -> setField(name, value) }
    commitGesture()
}

fun MapleState.isPresetActive(preset: BuiltInPreset): Boolean =
    preset.fields.isNotEmpty() &&
        preset.fields.all { (name, target) ->
            val current = values[name] ?: return@all false
            abs(current - target) <= 1e-3f
        }

@Composable
internal fun BuiltInPresetsRow(
    model: MapleViewModel,
    state: MapleState,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxWidth().testTag("editor-presets-section")) {
        LazyRow(
            Modifier.fillMaxWidth().testTag("editor-presets-row"),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(builtInPresets, key = { it.id }) { preset ->
                val active = state.isPresetActive(preset)
                val supported =
                    preset.fields.keys.all {
                        AdjustmentFields.byName[it]?.let(state::supportsField) == true
                    }
                FilterChip(
                    selected = active,
                    onClick = { model.applyBuiltInPreset(preset) },
                    enabled = state.canEdit && supported,
                    label = { Text(preset.name, fontSize = 12.sp) },
                    modifier =
                        Modifier.semantics { contentDescription = "Preset ${preset.name}" }
                            .testTag("preset-chip-${preset.id}"),
                )
            }
        }
    }
}

@Composable
internal fun ParametricToneCurvePlot(
    state: MapleState,
    modifier: Modifier = Modifier,
) {
    val shadows = state.values["parametric_shadows"] ?: 0f
    val darks = state.values["parametric_darks"] ?: 0f
    val lights = state.values["parametric_lights"] ?: 0f
    val highlights = state.values["parametric_highlights"] ?: 0f
    val sSplit = state.values["parametric_shadow_split"] ?: 25f
    val mSplit = state.values["parametric_midtone_split"] ?: 50f
    val hSplit = state.values["parametric_highlight_split"] ?: 75f
    val xml = remember(shadows, darks, lights, highlights, sSplit, mSplit, hSplit) {
        state.document.serialize()
    }
    val curve by produceState<Result<List<Offset>>?>(null, xml) {
        value = null
        value = withContext(Dispatchers.Default) {
            runCatching {
                val points = JSONArray(NativeBridge.parametricCurve(xml))
                List(points.length()) { index ->
                    val point = points.getJSONArray(index)
                    Offset(point.getDouble(0).toFloat(), point.getDouble(1).toFloat())
                }
            }
        }
    }

    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp)
            .testTag("editor-tone-curve-plot"),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier.size(180.dp)
                .semantics {
                    contentDescription =
                        String.format(
                            Locale.US,
                            "Tone curve plot (S %.0f, D %.0f, L %.0f, H %.0f)",
                            shadows,
                            darks,
                            lights,
                            highlights,
                        )
                },
        ) {
            Canvas(Modifier.fillMaxSize()) {
                val w = size.width
                val h = size.height
                // Grid lines at 25%, 50%, 75%
                for (i in 1..3) {
                    val frac = i / 4f
                    drawLine(
                        color = Color.White.copy(alpha = 0.12f),
                        start = Offset(w * frac, 0f),
                        end = Offset(w * frac, h),
                        strokeWidth = 1.dp.toPx(),
                    )
                    drawLine(
                        color = Color.White.copy(alpha = 0.12f),
                        start = Offset(0f, h * frac),
                        end = Offset(w, h * frac),
                        strokeWidth = 1.dp.toPx(),
                    )
                }
                // Identity diagonal
                drawLine(
                    color = Color.White.copy(alpha = 0.28f),
                    start = Offset(0f, h),
                    end = Offset(w, 0f),
                    strokeWidth = 1.dp.toPx(),
                )
                curve?.getOrNull()?.let { points ->
                    val path = Path()
                    points.forEachIndexed { index, point ->
                        val px = point.x * w
                        val py = (1f - point.y) * h
                        if (index == 0) path.moveTo(px, py) else path.lineTo(px, py)
                    }
                    drawPath(path, MapleColors.primary, style = Stroke(width = 2.dp.toPx()))
                }
            }
        }
        if (curve?.isFailure == true) {
            Text("Curve preview unavailable", color = MapleColors.muted, fontSize = 10.sp)
        }
        Row(
            Modifier.fillMaxWidth().padding(top = 4.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            for ((zone, v) in
                listOf("S" to shadows, "D" to darks, "L" to lights, "H" to highlights)) {
                Text(
                    String.format(Locale.US, "%s %+.0f", zone, v),
                    fontSize = 10.sp,
                    color = MapleColors.muted,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }
    }
}
