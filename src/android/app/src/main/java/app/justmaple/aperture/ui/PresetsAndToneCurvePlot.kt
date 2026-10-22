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

/**
 * Evaluates the normalized parametric tone curve `y(x)` in `[0, 1]` for `x` in `[0, 1]`
 * given the four parametric region adjustments (`[-100, 100]`) and split points (`[0, 100]`).
 */
fun evaluateParametricCurveAt(
    x: Float,
    shadows: Float = 0f,
    darks: Float = 0f,
    lights: Float = 0f,
    highlights: Float = 0f,
    shadowSplit: Float = 25f,
    midtoneSplit: Float = 50f,
    highlightSplit: Float = 75f,
): Float {
    val t = x.coerceIn(0f, 1f)
    if (t <= 0f) return 0f
    if (t >= 1f) return 1f
    val s1 = (shadowSplit / 100f).coerceIn(0.05f, 0.90f)
    val s2 = (midtoneSplit / 100f).coerceIn(s1 + 0.02f, 0.95f)
    val s3 = (highlightSplit / 100f).coerceIn(s2 + 0.02f, 0.98f)

    // Smooth bell weights for each of the 4 tonal zones anchored at 0 and 1
    val envelope = 4f * t * (1f - t)
    val wShadows = ((1f - (t / s2).coerceIn(0f, 1f)).let { it * it }) * envelope
    val wDarks =
        (1f - abs((t - s1) / (s2 - 0f).coerceAtLeast(0.05f)).coerceIn(0f, 1f)).let { it * it } *
            envelope
    val wLights =
        (1f - abs((t - s3) / (1f - s2).coerceAtLeast(0.05f)).coerceIn(0f, 1f)).let { it * it } *
            envelope
    val wHighlights = (((t - s2) / (1f - s2).coerceAtLeast(0.05f)).coerceIn(0f, 1f).let { it * it }) *
        envelope

    val delta =
        (shadows / 100f) * 0.22f * wShadows +
            (darks / 100f) * 0.22f * wDarks +
            (lights / 100f) * 0.22f * wLights +
            (highlights / 100f) * 0.22f * wHighlights
    return (t + delta).coerceIn(0f, 1f)
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
                // Evaluated tone curve path
                val steps = 48
                val path = Path()
                for (step in 0..steps) {
                    val xNorm = step.toFloat() / steps.toFloat()
                    val yNorm =
                        evaluateParametricCurveAt(
                            x = xNorm,
                            shadows = shadows,
                            darks = darks,
                            lights = lights,
                            highlights = highlights,
                            shadowSplit = sSplit,
                            midtoneSplit = mSplit,
                            highlightSplit = hSplit,
                        )
                    val px = xNorm * w
                    val py = (1f - yNorm) * h
                    if (step == 0) path.moveTo(px, py) else path.lineTo(px, py)
                }
                drawPath(
                    path = path,
                    color = MapleColors.primary,
                    style = Stroke(width = 2.dp.toPx()),
                )
            }
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
