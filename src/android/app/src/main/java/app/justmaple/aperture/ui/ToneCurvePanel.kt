package app.justmaple.aperture.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.justmaple.aperture.MapleState
import app.justmaple.aperture.MapleViewModel
import app.justmaple.aperture.data.CurveKnot
import app.justmaple.aperture.data.NativeBridge
import java.util.Locale
import kotlin.math.pow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray

private const val CURVE_SAMPLES = 128
/** Knot hit radius in authoring units, as on iPad (≈ 8 pt on a 220 pt plot). */
private const val HIT_RADIUS = 0.05f

internal fun nativeCurveSamples(knots: List<CurveKnot>): FloatArray =
    NativeBridge.pointCurve(FloatArray(knots.size * 2) { if (it % 2 == 0) knots[it / 2].x else knots[it / 2].y }, CURVE_SAMPLES)

private fun channelColor(index: Int) =
    listOf(MapleColors.primary, MapleColors.curveRed, MapleColors.curveGreen, MapleColors.curveBlue)[index]

/**
 * The iPhone/iPad Tone Curve section: family, mode and channel rows over the
 * knot plot. Every drag, delete, reset and mode change is one undo entry.
 */
@Composable
internal fun ToneCurvePanel(
    model: MapleViewModel,
    state: MapleState,
    family: ToneCurveFamily,
    onFamily: (ToneCurveFamily) -> Unit,
    modifier: Modifier = Modifier,
    plotSize: Dp = 200.dp,
    sampler: (List<CurveKnot>) -> FloatArray = ::nativeCurveSamples,
) {
    var channel by remember(family) { mutableIntStateOf(0) }
    var selectedKnot by remember(family, channel) { mutableStateOf<Int?>(null) }
    val curve = family.curves[channel]
    val knots = state.document.curve(curve)
    Column(modifier.fillMaxWidth().testTag("editor-tone-curve-section"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            for (option in ToneCurveFamily.entries)
                CurveChip(option.label, option == family, false, MapleColors.primary, "tone-curve-family-${option.name.lowercase()}") {
                    onFamily(option)
                }
        }
        if (family == ToneCurveFamily.Scene) {
            val ratio = state.document.attribute("papp:ToneCurveMode") == "RatioPreserving"
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Mode", fontSize = 10.sp, color = MapleColors.muted, modifier = Modifier.padding(end = 4.dp))
                CurveChip("Per-Channel", !ratio, false, MapleColors.primary, "tone-curve-mode-per-channel") {
                    if (ratio && state.canEdit) model.attribute("papp:ToneCurveMode", null)
                }
                CurveChip("Ratio-Preserving", ratio, false, MapleColors.primary, "tone-curve-mode-ratio") {
                    if (!ratio && state.canEdit) model.attribute("papp:ToneCurveMode", "RatioPreserving")
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            family.curves.forEachIndexed { index, channelCurve ->
                val label = family.channelLabel(index)
                CurveChip(
                    label,
                    index == channel,
                    state.document.curve(channelCurve).isNotEmpty(),
                    channelColor(index),
                    "tone-curve-channel-${label.lowercase()}",
                    Modifier.weight(1f),
                ) { channel = index }
            }
            TextButton(
                {
                    selectedKnot = null
                    model.setCurve(curve, emptyList())
                    model.commitGesture()
                },
                Modifier.testTag("tone-curve-reset").semantics { contentDescription = "Reset ${family.channelLabel(channel)} curve" },
                enabled = state.canEdit && knots.isNotEmpty(),
            ) { Text("Reset curve", fontSize = 10.sp) }
        }
        ToneCurvePlot(
            knots,
            channelColor(channel),
            family.channelLabel(channel),
            state.canEdit,
            selectedKnot,
            onSelect = { selectedKnot = it },
            onChange = { model.setCurve(curve, it) },
            onCommit = model::commitGesture,
            sampler = sampler,
            parametric = if (family == ToneCurveFamily.Scene) state else null,
            modifier = Modifier.align(Alignment.CenterHorizontally).size(plotSize),
        )
        val shown = ToneCurveEditing.materialize(knots)
        selectedKnot?.takeIf { it in shown.indices }?.let { index ->
            val knot = shown[index]
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    String.format(Locale.US, "Input %.0f  ·  Output %.0f", knot.x * 255f, knot.y * 255f),
                    Modifier.weight(1f).testTag("tone-curve-knot-readout"),
                    fontSize = 11.sp,
                    color = MapleColors.muted,
                )
                TextButton(
                    {
                        selectedKnot = null
                        model.setCurve(curve, ToneCurveEditing.remove(knots, index))
                        model.commitGesture()
                    },
                    Modifier.testTag("tone-curve-delete-knot"),
                    enabled = state.canEdit && index != 0 && index != shown.lastIndex,
                ) { Text("Delete point", fontSize = 11.sp) }
            }
        }
    }
}

@Composable
private fun CurveChip(
    label: String,
    selected: Boolean,
    modified: Boolean,
    tint: Color,
    tag: String,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Column(
        modifier
            .clip(RoundedCornerShape(4.dp))
            .background(if (selected) MapleColors.primary.copy(alpha = .16f) else Color.Transparent)
            .border(.5.dp, if (selected) tint else Color.Transparent, RoundedCornerShape(4.dp))
            .clickable(role = Role.Tab, onClick = onClick)
            .semantics { this.selected = selected }
            .testTag(tag)
            .padding(horizontal = 8.dp, vertical = 3.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(label, fontSize = 10.sp, color = if (selected) tint else MapleColors.muted, maxLines = 1)
        Box(Modifier.padding(top = 2.dp).size(3.dp).background(if (modified) tint else Color.Transparent, CircleShape))
    }
}

@Composable
private fun ToneCurvePlot(
    knots: List<CurveKnot>,
    stroke: Color,
    channelName: String,
    enabled: Boolean,
    selectedKnot: Int?,
    onSelect: (Int?) -> Unit,
    onChange: (List<CurveKnot>) -> Unit,
    onCommit: () -> Unit,
    sampler: (List<CurveKnot>) -> FloatArray,
    parametric: MapleState?,
    modifier: Modifier,
) {
    val currentKnots by rememberUpdatedState(knots)
    val currentEnabled by rememberUpdatedState(enabled)
    val select by rememberUpdatedState(onSelect)
    val change by rememberUpdatedState(onChange)
    val commit by rememberUpdatedState(onCommit)
    val samples by produceState<FloatArray?>(null, knots) {
        value = withContext(Dispatchers.Default) { runCatching { sampler(knots) }.getOrNull() }
    }
    val parametricXml = parametric?.let { remember(it.values) { it.document.serialize() } }
    val parametricShape by produceState<List<Offset>?>(null, parametricXml) {
        value = parametricXml?.let { xml ->
            withContext(Dispatchers.Default) {
                runCatching {
                    val points = JSONArray(NativeBridge.parametricCurve(xml))
                    List(points.length()) {
                        val point = points.getJSONArray(it)
                        Offset(point.getDouble(0).toFloat(), point.getDouble(1).toFloat())
                    }
                }.getOrNull()
            }
        }
    }
    val shown = ToneCurveEditing.materialize(knots)
    Box(
        modifier
            .testTag("tone-curve-plot")
            .semantics {
                contentDescription =
                    "$channelName tone curve, ${if (knots.isEmpty()) "identity" else "${shown.size} points"}"
            }
            .pointerInput(Unit) {
                awaitEachGesture {
                    val down = awaitFirstDown()
                    if (!currentEnabled) return@awaitEachGesture
                    fun authoring(position: Offset) =
                        (position.x / size.width).coerceIn(0f, 1f) to (1f - position.y / size.height).coerceIn(0f, 1f)
                    val (x, y) = authoring(down.position)
                    val start = currentKnots
                    val existing = ToneCurveEditing.hitTest(start, x, y, HIT_RADIUS)
                    var working =
                        if (existing != null) ToneCurveEditing.materialize(start)
                        else ToneCurveEditing.insert(start, x, y)
                    val index = existing ?: ToneCurveEditing.hitTest(working, x, y, HIT_RADIUS) ?: return@awaitEachGesture
                    down.consume()
                    select(index)
                    if (working != ToneCurveEditing.materialize(start)) change(working)
                    try {
                        do {
                            val event = awaitPointerEvent()
                            val pointer = event.changes.firstOrNull { it.id == down.id } ?: break
                            if (pointer.positionChange() != Offset.Zero) {
                                val (nx, ny) = authoring(pointer.position)
                                working = ToneCurveEditing.move(working, index, nx, ny)
                                change(working)
                                pointer.consume()
                            }
                        } while (pointer.pressed)
                    } finally {
                        commit()
                    }
                }
            },
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val w = size.width
            val h = size.height
            drawRect(Color.White.copy(alpha = .04f))
            for (i in 1..3) {
                val f = i / 4f
                drawLine(Color.White.copy(alpha = .12f), Offset(w * f, 0f), Offset(w * f, h), 1.dp.toPx())
                drawLine(Color.White.copy(alpha = .12f), Offset(0f, h * f), Offset(w, h * f), 1.dp.toPx())
            }
            drawLine(Color.White.copy(alpha = .28f), Offset(0f, h), Offset(w, 0f), 1.dp.toPx())
            parametric?.values?.let { values ->
                val (shadow, midtone, highlight) =
                    orderedParametricSplits(
                        values["parametric_shadow_split"] ?: 25f,
                        values["parametric_midtone_split"] ?: 50f,
                        values["parametric_highlight_split"] ?: 75f,
                    )
                for (split in listOf(shadow, midtone, highlight)) {
                    val x = parametricAxisToAuthoringX(split) * w
                    drawLine(MapleColors.primary.copy(alpha = .25f), Offset(x, 0f), Offset(x, h), 1.dp.toPx())
                }
            }
            parametricShape?.let { points ->
                val path = Path()
                points.forEachIndexed { i, p ->
                    if (i == 0) path.moveTo(p.x * w, (1f - p.y) * h) else path.lineTo(p.x * w, (1f - p.y) * h)
                }
                drawPath(path, MapleColors.muted.copy(alpha = .6f), style = Stroke(1.dp.toPx()))
            }
            samples?.let { ys ->
                val path = Path()
                ys.forEachIndexed { i, yv ->
                    val px = i.toFloat() / (ys.size - 1) * w
                    if (i == 0) path.moveTo(px, (1f - yv) * h) else path.lineTo(px, (1f - yv) * h)
                }
                drawPath(path, stroke, style = Stroke(2.dp.toPx()))
            }
            shown.forEachIndexed { i, knot ->
                val center = Offset(knot.x * w, (1f - knot.y) * h)
                if (i == selectedKnot) drawCircle(MapleColors.primary, 8.5.dp.toPx(), center, style = Stroke(2.dp.toPx()))
                drawCircle(stroke, 4.5.dp.toPx(), center)
            }
        }
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
