package app.justmaple.aperture.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
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
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
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
import kotlin.math.pow
import kotlin.math.roundToInt
import app.justmaple.aperture.data.NativeBridge
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/**
 * Source-specific fields from `NON_COPYABLE_FIELDS` in `raw-core` that must not be captured
 * or applied in user presets (`src/raw-pipeline/raw-core/src/types/adjustment/schema/groups/mod.rs`).
 */
val nonCopyablePresetFields: Set<String> =
    setOf("capture_sharpening_radius", "wb_sample_x", "wb_sample_y", "wb_algorithm_version")

/**
 * Android-exposed non-numeric XMP attributes that participate in saved user presets.
 */
val copyablePresetAttributes: Set<String> =
    setOf("crs:ConvertToGrayscale", "papp:FilmLook")

/**
 * Built-in presets matching Apple's `builtin-presets.json` (#5193).
 */
data class BuiltInPreset(
    val id: String,
    val name: String,
    val fields: Map<String, Float>,
    val attributes: Map<String, String> = emptyMap(),
    val userCreated: Boolean = false,
)

val builtInPresets: List<BuiltInPreset> =
    listOf(
        BuiltInPreset("builtin-flat", "Flat", mapOf("contrast" to -50f)),
        BuiltInPreset("builtin-high-contrast", "High Contrast", mapOf("contrast" to 50f)),
        BuiltInPreset("builtin-monochrome", "Monochrome", mapOf("saturation" to -100f)),
        BuiltInPreset("builtin-no-sharpening", "No Sharpening", mapOf("sharpen_amount" to 0f)),
        BuiltInPreset("builtin-no-color-nr", "No Color NR", mapOf("nr_color" to 0f)),
    )

fun encodeUserPresetsJson(presets: List<BuiltInPreset>): String {
    val array = JSONArray()
    for (preset in presets) {
        val fieldsObj = JSONObject()
        for ((k, v) in preset.fields) fieldsObj.put(k, v.toDouble())
        val attrsObj = JSONObject()
        for ((k, v) in preset.attributes) attrsObj.put(k, v)
        array.put(
            JSONObject()
                .put("id", preset.id)
                .put("name", preset.name)
                .put("fields", fieldsObj)
                .put("attributes", attrsObj)
        )
    }
    return array.toString()
}

fun decodeUserPresetsJson(raw: String?): List<BuiltInPreset> {
    if (raw.isNullOrBlank()) return emptyList()
    return runCatching {
        val array = JSONArray(raw)
        buildList {
            for (i in 0 until array.length()) {
                val obj = array.getJSONObject(i)
                val id = obj.optString("id").takeIf { it.isNotBlank() } ?: continue
                val name = obj.optString("name").takeIf { it.isNotBlank() } ?: continue
                val fieldsObj = obj.optJSONObject("fields")
                val fields = mutableMapOf<String, Float>()
                if (fieldsObj != null) {
                    val keys = fieldsObj.keys()
                    while (keys.hasNext()) {
                        val key = keys.next()
                        if (key in AdjustmentFields.byName && key !in nonCopyablePresetFields) {
                            val v = fieldsObj.optDouble(key)
                            if (v.isFinite()) fields[key] = v.toFloat()
                        }
                    }
                }
                val attrsObj = obj.optJSONObject("attributes")
                val attributes = mutableMapOf<String, String>()
                if (attrsObj != null) {
                    val attrKeys = attrsObj.keys()
                    while (attrKeys.hasNext()) {
                        val key = attrKeys.next()
                        if (key in copyablePresetAttributes) {
                            val v = attrsObj.optString(key).takeIf { it.isNotBlank() }
                            if (v != null) attributes[key] = v
                        }
                    }
                }
                if (fields.isNotEmpty() || attributes.isNotEmpty()) {
                    add(
                        BuiltInPreset(
                            id = id,
                            name = name,
                            fields = fields,
                            attributes = attributes,
                            userCreated = true,
                        )
                    )
                }
            }
        }
    }.getOrDefault(emptyList())
}

fun MapleState.savablePresetFields(): Map<String, Float> {
    val currentValues = this.values
    return buildMap {
        for ((name, value) in currentValues) {
            if (name in nonCopyablePresetFields) continue
            val spec = AdjustmentFields.byName[name] ?: continue
            val baseline =
                when (name) {
                    "temperature" -> currentValues["_shot_temperature"] ?: spec.initial
                    "tint" -> currentValues["_shot_tint"] ?: spec.initial
                    else -> spec.initial
                }
            if (abs(value - baseline) > 1e-4f) {
                put(name, value)
            }
        }
    }
}

fun MapleState.savablePresetAttributes(): Map<String, String> = buildMap {
    val bw = document.attribute("crs:ConvertToGrayscale")
    if (bw == "1" || bw.equals("True", ignoreCase = true)) {
        put("crs:ConvertToGrayscale", "True")
    }
    val film = document.attribute("papp:FilmLook").orEmpty()
    if (film.isNotEmpty()) {
        put("papp:FilmLook", film)
    }
}

fun MapleViewModel.applyBuiltInPreset(preset: BuiltInPreset) {
    preset.fields.forEach { (name, value) -> setField(name, value) }
    if (preset.attributes.isNotEmpty()) {
        setAttributes(preset.attributes, commit = false)
    }
    commitGesture()
}

fun MapleState.isPresetActive(preset: BuiltInPreset): Boolean =
    (preset.fields.isNotEmpty() || preset.attributes.isNotEmpty()) &&
        preset.fields.all { (name, target) ->
            val current = values[name] ?: return@all false
            abs(current - target) <= 1e-3f
        } &&
        preset.attributes.all { (name, target) ->
            val current = document.attribute(name)
            when (name) {
                "crs:ConvertToGrayscale" -> {
                    val isMono = current == "1" || current.equals("True", ignoreCase = true)
                    val targetMono = target == "1" || target.equals("True", ignoreCase = true)
                    isMono == targetMono
                }
                else -> current == target
            }
        }

@Composable
internal fun BuiltInPresetsRow(
    model: MapleViewModel,
    state: MapleState,
    modifier: Modifier = Modifier,
) {
    var saveDialogOpen by remember { mutableStateOf(false) }
    var presetName by remember { mutableStateOf("") }
    val savableFields = remember(state.values) { state.savablePresetFields() }
    val savableAttributes = remember(state.document) { state.savablePresetAttributes() }
    val hasSavableEdits = savableFields.isNotEmpty() || savableAttributes.isNotEmpty()
    val allPresets = remember(state.userPresets) { builtInPresets + state.userPresets }

    Column(modifier.fillMaxWidth().testTag("editor-presets-section")) {
        LazyRow(
            Modifier.fillMaxWidth().testTag("editor-presets-row"),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            items(allPresets, key = { it.id }) { preset ->
                val active = state.isPresetActive(preset)
                val supported =
                    preset.fields.keys.all {
                        AdjustmentFields.byName[it]?.let(state::supportsField) == true
                    }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    FilterChip(
                        selected = active,
                        onClick = { model.applyBuiltInPreset(preset) },
                        enabled = state.canEdit && supported,
                        label = { Text(preset.name, fontSize = 12.sp) },
                        modifier =
                            Modifier.semantics { contentDescription = "Preset ${preset.name}" }
                                .testTag("preset-chip-${preset.id}"),
                    )
                    if (preset.userCreated) {
                        TextButton(
                            onClick = { model.deleteUserPreset(preset.id) },
                            contentPadding = PaddingValues(horizontal = 4.dp, vertical = 0.dp),
                            modifier =
                                Modifier.semantics {
                                        contentDescription = "Delete preset ${preset.name}"
                                    }
                                    .testTag("delete-preset-${preset.id}"),
                        ) {
                            Text("×", fontSize = 14.sp, color = MapleColors.muted)
                        }
                    }
                }
            }
            item(key = "save-user-preset") {
                AssistChip(
                    onClick = {
                        presetName = "Preset ${state.userPresets.size + 1}"
                        saveDialogOpen = true
                    },
                    enabled = state.canEdit && hasSavableEdits,
                    label = { Text("+ Save Preset", fontSize = 12.sp) },
                    modifier =
                        Modifier.semantics { contentDescription = "Save current edits as preset" }
                            .testTag("save-user-preset-chip"),
                )
            }
        }
    }

    if (saveDialogOpen) {
        AlertDialog(
            onDismissRequest = { saveDialogOpen = false },
            title = { Text("Save User Preset") },
            text = {
                OutlinedTextField(
                    value = presetName,
                    onValueChange = { presetName = it },
                    label = { Text("Preset name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().testTag("save-preset-name-input"),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        model.saveUserPreset(presetName)
                        saveDialogOpen = false
                    },
                    enabled = presetName.isNotBlank() && hasSavableEdits,
                    modifier = Modifier.testTag("confirm-save-preset-button"),
                ) {
                    Text("Save")
                }
            },
            dismissButton = {
                TextButton(onClick = { saveDialogOpen = false }) { Text("Cancel") }
            },
        )
    }
}

private const val PARAMETRIC_MIDGREY = 0.18f
private const val PARAMETRIC_AXIS_MIDTONE = 50.0f
private const val PARAMETRIC_AXIS_UNITS_PER_STOP = 12.5f
private const val PARAMETRIC_REF_MAX = 4.0f
private const val PARAMETRIC_AXIS_MAX = 100.0f
private const val PARAMETRIC_MIN_SPLIT_GAP = 1.0f

/**
 *Enforces ordered parametric splits with at least 1 axis unit gap, matching
 * `ordered_splits` in `src/raw-pipeline/raw-core/src/stages/tone_curves/parametric.rs`.
 */
fun orderedParametricSplits(
    shadowSplit: Float = 25f,
    midtoneSplit: Float = 50f,
    highlightSplit: Float = 75f,
): Triple<Float, Float, Float> {
    val midtone =
        midtoneSplit.coerceIn(
            2f * PARAMETRIC_MIN_SPLIT_GAP,
            PARAMETRIC_AXIS_MAX - 2f * PARAMETRIC_MIN_SPLIT_GAP,
        )
    val shadow = shadowSplit.coerceIn(PARAMETRIC_MIN_SPLIT_GAP, midtone - PARAMETRIC_MIN_SPLIT_GAP)
    val highlight =
        highlightSplit.coerceIn(
            midtone + PARAMETRIC_MIN_SPLIT_GAP,
            PARAMETRIC_AXIS_MAX - PARAMETRIC_MIN_SPLIT_GAP,
        )
    return Triple(shadow, midtone, highlight)
}

/**
 * Maps a parametric exposure-axis position `p` in `[0, 100]` to the normalized `[0, 1]`
 * authoring coordinate `x` (where `1.0` = `REF_MAX = 4.0`), matching `axis_to_authoring_x`
 * in `src/raw-pipeline/raw-core/src/stages/tone_curves/parametric.rs`.
 */
fun parametricAxisToAuthoringX(p: Float): Float {
    val stops = (p - PARAMETRIC_AXIS_MIDTONE) / PARAMETRIC_AXIS_UNITS_PER_STOP
    val luma = PARAMETRIC_MIDGREY * 2.0.pow(stops.toDouble()).toFloat()
    return (luma / PARAMETRIC_REF_MAX).coerceIn(0f, 1f)
}

/**
 * Maps a normalized horizontal position `nx` in `[0, 1]` on the parametric tone curve plot
 * to the corresponding parametric zone field name (`parametric_shadows`, `parametric_darks`,
 * `parametric_lights`, or `parametric_highlights`) using the core's logarithmic split transform.
 */
fun toneCurveZoneFieldForX(
    nx: Float,
    shadowSplit: Float = 25f,
    midtoneSplit: Float = 50f,
    highlightSplit: Float = 75f,
): String {
    val (sAxis, mAxis, hAxis) = orderedParametricSplits(shadowSplit, midtoneSplit, highlightSplit)
    val s = parametricAxisToAuthoringX(sAxis)
    val m = parametricAxisToAuthoringX(mAxis)
    val h = parametricAxisToAuthoringX(hAxis)
    return when {
        nx < s -> "parametric_shadows"
        nx < m -> "parametric_darks"
        nx < h -> "parametric_lights"
        else -> "parametric_highlights"
    }
}

/**
 * Maps a relative vertical drag from `startNy` to `currentNy` (both in `[0, 1]`, top = 0,
 * bottom = 1) onto the starting parametric zone slider value in `[-100, +100]`.
 * Dragging up (`currentNy < startNy`) raises the zone; dragging down lowers it, without
 * jumping the slider on initial touch-down.
 */
fun toneCurveValueForDrag(startValue: Float, startNy: Float, currentNy: Float): Float {
    val delta = ((startNy - currentNy) * 200f).coerceIn(-200f, 200f)
    return (startValue + delta).roundToInt().toFloat().coerceIn(-100f, 100f)
}

@Composable
internal fun ParametricToneCurvePlot(
    state: MapleState,
    modifier: Modifier = Modifier,
    model: MapleViewModel? = null,
) {
    val shadows = state.values["parametric_shadows"] ?: 0f
    val darks = state.values["parametric_darks"] ?: 0f
    val lights = state.values["parametric_lights"] ?: 0f
    val highlights = state.values["parametric_highlights"] ?: 0f
    val sSplit = state.values["parametric_shadow_split"] ?: 25f
    val mSplit = state.values["parametric_midtone_split"] ?: 50f
    val hSplit = state.values["parametric_highlight_split"] ?: 75f
    val currentSplits by rememberUpdatedState(Triple(sSplit, mSplit, hSplit))
    val currentValues by rememberUpdatedState(state.values)
    val currentCanEdit by rememberUpdatedState(state.canEdit)
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
                .pointerInput(model) {
                    if (model == null) return@pointerInput
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false)
                        if (!currentCanEdit) return@awaitEachGesture
                        val w = size.width.toFloat().coerceAtLeast(1f)
                        val h = size.height.toFloat().coerceAtLeast(1f)
                        val (s, m, hl) = currentSplits
                        val startNx = (down.position.x / w).coerceIn(0f, 1f)
                        val startNy = (down.position.y / h).coerceIn(0f, 1f)
                        val zoneField = toneCurveZoneFieldForX(startNx, s, m, hl)
                        val startValue = currentValues[zoneField] ?: 0f
                        var moved = false
                        var committed = false
                        try {
                            do {
                                val event = awaitPointerEvent()
                                val change = event.changes.firstOrNull { it.pressed } ?: break
                                if (change.positionChanged()) {
                                    val ny = (change.position.y / h).coerceIn(0f, 1f)
                                    val nextValue = toneCurveValueForDrag(startValue, startNy, ny)
                                    model.setField(zoneField, nextValue)
                                    moved = true
                                    change.consume()
                                }
                            } while (event.changes.any { it.pressed })
                            if (moved) model.commitGesture()
                            committed = true
                        } finally {
                            if (moved && !committed) model.commitGesture()
                        }
                    }
                }
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
                }
                .testTag("tone-curve-canvas"),
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
                // Split point vertical markers mapped to authoring x
                val (sAxis, mAxis, hAxis) = orderedParametricSplits(sSplit, mSplit, hSplit)
                for (splitAxis in listOf(sAxis, mAxis, hAxis)) {
                    val sx = parametricAxisToAuthoringX(splitAxis) * w
                    drawLine(
                        color = MapleColors.primary.copy(alpha = 0.25f),
                        start = Offset(sx, 0f),
                        end = Offset(sx, h),
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
