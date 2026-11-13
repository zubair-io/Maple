package app.justmaple.aperture.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.justmaple.aperture.data.NativeImageSize
import app.justmaple.aperture.generated.CanvasZoomAbi.OP_ADOPT_IMAGE
import app.justmaple.aperture.generated.CanvasZoomAbi.OP_ADVANCE_STOP
import app.justmaple.aperture.generated.CanvasZoomAbi.OP_DOUBLE_TAP
import app.justmaple.aperture.generated.CanvasZoomAbi.OP_DRAG_CHANGED
import app.justmaple.aperture.generated.CanvasZoomAbi.OP_DRAG_ENDED
import app.justmaple.aperture.generated.CanvasZoomAbi.OP_PINCH_CHANGED
import app.justmaple.aperture.generated.CanvasZoomAbi.OP_PINCH_ENDED
import app.justmaple.aperture.generated.CanvasZoomAbi.OP_REBASE_DRAG
import app.justmaple.aperture.generated.CanvasZoomAbi.OP_REBASE_PINCH
import app.justmaple.aperture.generated.CanvasZoomAbi.OP_RECLAMP
import app.justmaple.aperture.generated.CanvasZoomAbi.OP_REFRAME_IMAGE
import app.justmaple.aperture.generated.CanvasZoomAbi.OP_SETTLE
import app.justmaple.aperture.generated.CanvasZoomAbi.QUERY_EFFECTIVE_SCALE
import app.justmaple.aperture.generated.CanvasZoomAbi.QUERY_FIT_SCALE
import app.justmaple.aperture.generated.CanvasZoomAbi.QUERY_NEXT_STOP
import app.justmaple.aperture.generated.CanvasZoomAbi.STATE_LEN
import app.justmaple.aperture.generated.CanvasZoomAbi.STOP_ACTUAL_SIZE
import app.justmaple.aperture.generated.CanvasZoomAbi.STOP_FILL
import kotlin.math.roundToInt

/**
 * Zoom & pan state for the Android Preview and Editor canvases. The rules are the shared
 * `raw_core::canvas::CanvasZoomModel` (#5714), reached through [CanvasZoomNative]: this
 * class owns the model as a plain `DoubleArray`, hands it to each transition, and mirrors the
 * scale and pan into Compose state. Canvas units are Compose pixels.
 * - [pixelScale] == 0f means Fit; 1.0f means 100% (one image pixel per screen pixel); max 8.0f.
 * - A live pinch follows the fingers down to half of fit; its release returns to fit from below
 *   fit and settles on fit or fill within 4%.
 * - Suppresses single-finger pan for [PINCH_COOLDOWN_MS] after a two-finger pinch ends
 *   so lifting one finger slightly before the other never jumps the canvas.
 */
@Stable
class CanvasZoomState internal constructor(private val native: CanvasZoomNative) {
    constructor() : this(JniCanvasZoom)

    private val model = DoubleArray(STATE_LEN)

    var pixelScale by mutableFloatStateOf(0f)
        private set

    var panX by mutableFloatStateOf(0f)
        private set

    var panY by mutableFloatStateOf(0f)
        private set

    private var pinchEndedAtMs: Long? = null
    private var anchorX = 0f
    private var anchorY = 0f

    internal var scope: CanvasZoomScope? = null
        private set

    private var frame by mutableStateOf<CanvasZoomFrame?>(null)

    val isZoomed: Boolean
        get() = pixelScale > 0f

    fun fitScale(imageWidth: Int, imageHeight: Int, viewportWidth: Float, viewportHeight: Float): Float =
        query(QUERY_FIT_SCALE, imageWidth, imageHeight, viewportWidth, viewportHeight).toFloat()

    fun effectiveScale(
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
    ): Float = query(QUERY_EFFECTIVE_SCALE, imageWidth, imageHeight, viewportWidth, viewportHeight).toFloat()

    fun zoomFactorOverFit(
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
    ): Float {
        if (!isZoomed) return 1f
        val fit = fitScale(imageWidth, imageHeight, viewportWidth, viewportHeight)
        return effectiveScale(imageWidth, imageHeight, viewportWidth, viewportHeight) / fit
    }

    fun percentage(
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
    ): Int =
        (effectiveScale(imageWidth, imageHeight, viewportWidth, viewportHeight) * 100f)
            .roundToInt()
            .coerceAtLeast(1)

    fun badgeLabel(
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
    ): String = "${percentage(imageWidth, imageHeight, viewportWidth, viewportHeight)}%"

    /** What a badge tap does: the next stop in fit → fill → 100%. */
    fun nextStopDescription(
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
    ): String =
        when (query(QUERY_NEXT_STOP, imageWidth, imageHeight, viewportWidth, viewportHeight).toInt()) {
            STOP_FILL -> "Zoom to Fill"
            STOP_ACTUAL_SIZE -> "Zoom to 100%"
            else -> "Zoom to Fit"
        }

    /** How many times [reset] ran, so a gesture in progress can restart from the reset state. */
    internal var resets = 0
        private set

    /** Fit: the shared model's fit state is all zeros (`CanvasZoomModel::default`). */
    fun reset() {
        resets += 1
        model.fill(0.0)
        pinchEndedAtMs = null
        publish()
    }

    /** One pinch frame; [magnification] is cumulative since the pinch began. */
    fun pinchChanged(
        magnification: Float,
        centroidX: Float,
        centroidY: Float,
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
    ) {
        anchorX = centroidX
        anchorY = centroidY
        transition(OP_PINCH_CHANGED, imageWidth, imageHeight, viewportWidth, viewportHeight,
            magnification.toDouble(), centroidX.toDouble(), centroidY.toDouble())
    }

    /**
     * The fingers in the pinch changed: it continues about their centroid ([centroidX],
     * [centroidY]) from the current zoom, so the next frame with the same magnification moves
     * nothing.
     */
    fun rebasePinch(
        centroidX: Float,
        centroidY: Float,
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
    ) {
        anchorX = centroidX
        anchorY = centroidY
        transition(OP_REBASE_PINCH, imageWidth, imageHeight, viewportWidth, viewportHeight,
            centroidX.toDouble(), centroidY.toDouble())
    }

    fun pinchEnded(
        magnification: Float,
        nowMs: Long,
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
    ) {
        transition(OP_PINCH_ENDED, imageWidth, imageHeight, viewportWidth, viewportHeight,
            magnification.toDouble())
        pinchEndedAtMs = nowMs
    }

    fun isInPinchCooldown(nowMs: Long): Boolean {
        val ended = pinchEndedAtMs ?: return false
        return nowMs - ended in 0 until PINCH_COOLDOWN_MS
    }

    /**
     * One drag frame; [translationX]/[translationY] are cumulative since the drag began. Returns
     * whether the drag panned the image. During the post-pinch cooldown the translation only
     * becomes the baseline, so the pan resumes without a jump.
     */
    fun dragChanged(
        translationX: Float,
        translationY: Float,
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
        nowMs: Long = Long.MAX_VALUE,
    ): Boolean {
        val op = if (isInPinchCooldown(nowMs)) OP_REBASE_DRAG else OP_DRAG_CHANGED
        val result = transition(op, imageWidth, imageHeight, viewportWidth, viewportHeight,
            translationX.toDouble(), translationY.toDouble())
        return op == OP_DRAG_CHANGED && result == 1
    }

    fun dragEnded() {
        transition(OP_DRAG_ENDED, 0, 0, 0f, 0f)
    }

    /** Fit ↔ 100%, zooming in anchored at the tap. */
    fun doubleTap(
        tapX: Float,
        tapY: Float,
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
    ) {
        anchorX = tapX
        anchorY = tapY
        pinchEndedAtMs = null
        transition(OP_DOUBLE_TAP, imageWidth, imageHeight, viewportWidth, viewportHeight,
            tapX.toDouble(), tapY.toDouble())
    }

    /** Badge tap: the next stop in fit → fill → 100%; a free scale returns to fit. */
    fun advanceStop(imageWidth: Int, imageHeight: Int, viewportWidth: Float, viewportHeight: Float) {
        anchorX = viewportWidth / 2f
        anchorY = viewportHeight / 2f
        transition(OP_ADVANCE_STOP, imageWidth, imageHeight, viewportWidth, viewportHeight)
    }

    /**
     * The canvas now shows [next]. Only a different photo, mode or crop tool returns to fit: a new
     * canvas instance for a rotation or fold posture keeps the zoom (#5748).
     */
    internal fun enterScope(next: CanvasZoomScope) {
        if (next == scope) return
        if (next.photoKey != scope?.photoKey) frame = null
        reset()
        scope = next
    }

    /** The extent the zoom is expressed in for [photoKey], once its original's size is known. */
    internal fun frameFor(photoKey: String?): CanvasZoomFrame? = frame?.takeIf { it.photoKey == photoKey }

    /**
     * The original of [photoKey] measures [size] under [crop]. The first size replaces the
     * placeholder the zoom started on; a later one (a crop or straighten applied or undone) keeps
     * the image point at the viewport centre there, instead of returning to fit (#5748).
     */
    internal fun adoptImage(photoKey: String?, size: NativeImageSize, crop: CropRect,
        placeholderWidth: Int, placeholderHeight: Int, viewportWidth: Float, viewportHeight: Float) {
        val previous = frameFor(photoKey)
        val next = CanvasZoomFrame(photoKey, size.width, size.height, crop)
        if (previous == next) return
        if (previous == null) {
            adoptNativeDimensions(placeholderWidth, placeholderHeight, size.width, size.height,
                viewportWidth, viewportHeight)
        } else {
            val (x, y, width, height) = previous.extentOf(crop)
            transition(OP_REFRAME_IMAGE, size.width, size.height, viewportWidth, viewportHeight,
                x, y, width, height)
        }
        frame = next
    }

    /**
     * Ends whatever a cancelled gesture left live (its canvas left the screen, or the activity was
     * recreated mid-pinch), so the gesture starting now continues from what is on screen.
     */
    internal fun settle(imageWidth: Int, imageHeight: Int, viewportWidth: Float, viewportHeight: Float) {
        transition(OP_SETTLE, imageWidth, imageHeight, viewportWidth, viewportHeight)
    }

    internal val anchor: Pair<Float, Float>
        get() = anchorX to anchorY

    internal fun slots(): DoubleArray = model.copyOf()

    internal fun restore(slots: DoubleArray, anchorX: Float, anchorY: Float,
        scope: CanvasZoomScope?, frame: CanvasZoomFrame?) {
        if (slots.size == STATE_LEN) slots.copyInto(model)
        this.anchorX = anchorX
        this.anchorY = anchorY
        this.scope = scope
        this.frame = frame
        publish()
    }

    /** Re-resolves against a new viewport: fill keeps covering it and the pan stays legal. */
    fun reclamp(imageWidth: Int, imageHeight: Int, viewportWidth: Float, viewportHeight: Float) {
        if (isZoomed) transition(OP_RECLAMP, imageWidth, imageHeight, viewportWidth, viewportHeight)
    }

    /**
     * The initial gesture can arrive while a cloud original's dimensions are loading: a free zoom
     * keeps its size on screen, 100% stays 1:1, and the last gesture's focal point stays put.
     */
    fun adoptNativeDimensions(oldWidth: Int, oldHeight: Int, width: Int, height: Int,
        viewportWidth: Float, viewportHeight: Float) {
        transition(OP_ADOPT_IMAGE, width, height, viewportWidth, viewportHeight, oldWidth.toDouble(),
            oldHeight.toDouble(), anchorX.toDouble(), anchorY.toDouble())
    }

    private fun transition(
        op: Int,
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
        a: Double = 0.0,
        b: Double = 0.0,
        c: Double = 0.0,
        d: Double = 0.0,
    ): Int {
        val result = native.transition(model, op, a, b, c, d, viewportWidth.toDouble(),
            viewportHeight.toDouble(), imageWidth.toDouble(), imageHeight.toDouble())
        publish()
        return result
    }

    private fun query(
        which: Int,
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
    ): Double =
        native.query(model, which, viewportWidth.toDouble(),
            viewportHeight.toDouble(), imageWidth.toDouble(), imageHeight.toDouble())

    private fun publish() {
        pixelScale = model[0].toFloat()
        panX = model[1].toFloat()
        panY = model[2].toFloat()
    }

    companion object {
        const val PINCH_COOLDOWN_MS = 300L
        const val DOUBLE_TAP_TIMEOUT_MS = 280L
        const val DOUBLE_TAP_SLOP_PX = 48f
        const val SWIPE_PAGE_THRESHOLD_PX = 96f
    }
}

@Composable
internal fun CanvasZoomBadge(
    label: String,
    isZoomed: Boolean,
    actionDescription: String,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier
            .defaultMinSize(minWidth = 44.dp, minHeight = 44.dp)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(8.dp)
            .semantics {
                contentDescription = actionDescription
                stateDescription = label
                role = Role.Button
            }
            .testTag("canvas-zoom-indicator"),
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            shape = RoundedCornerShape(6.dp),
            color = Color.Black.copy(alpha = 0.58f),
            border =
                BorderStroke(
                    0.5.dp,
                    if (isZoomed) MapleColors.primary.copy(alpha = 0.7f)
                    else MapleColors.borderHi.copy(alpha = 0.4f),
                ),
        ) {
            Text(
                text = label,
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                color = if (isZoomed) MapleColors.primary else Color.White,
                fontSize = 10.sp,
                fontWeight = FontWeight.Medium,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}
