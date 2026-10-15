package app.justmaple.aperture.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.*
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.generated.AdjustmentField

/** Maple's fine neutral track and circular thumb, with a full 44dp hit target. */
@Composable
internal fun AdjustmentSlider(
    field: AdjustmentField,
    value: Float,
    enabled: Boolean,
    onChange: (Float) -> Unit,
    onCommit: () -> Unit,
) {
    val change by rememberUpdatedState(onChange)
    val commit by rememberUpdatedState(onCommit)
    val current by rememberUpdatedState(value)
    val range = field.maximum - field.minimum
    Canvas(
        Modifier.fillMaxWidth()
            .height(44.dp)
            .padding(horizontal = 8.dp)
            .semantics {
                contentDescription = "${fieldLabel(field)} adjustment"
                progressBarRangeInfo = ProgressBarRangeInfo(value, field.minimum..field.maximum)
                if (!enabled) disabled()
                setProgress { next ->
                    if (enabled) {
                        change(next.coerceIn(field.minimum, field.maximum))
                        commit()
                    }
                    enabled
                }
            }
            .onKeyEvent {
                if (!enabled || it.type != KeyEventType.KeyDown) false
                else
                    when (it.key) {
                        Key.DirectionLeft,
                        Key.DirectionRight -> {
                            val step = range / 100f * if (it.key == Key.DirectionLeft) -1 else 1
                            change((current + step).coerceIn(field.minimum, field.maximum))
                            commit()
                            true
                        }
                        else -> false
                    }
            }
            .focusable(enabled)
            .pointerInput(field.name, enabled) {
                if (!enabled) return@pointerInput
                detectTapGestures(
                    onTap = { point ->
                        change(field.minimum + (point.x / size.width).coerceIn(0f, 1f) * range)
                        commit()
                    }
                )
            }
            .pointerInput(field.name, enabled) {
                if (!enabled) return@pointerInput
                fun scrub(point: Offset) {
                    change(field.minimum + (point.x / size.width).coerceIn(0f, 1f) * range)
                }
                detectDragGestures(
                    onDragStart = ::scrub,
                    onDragEnd = { commit() },
                    onDragCancel = { commit() },
                ) { event, _ ->
                    event.consume()
                    scrub(event.position)
                }
            }
    ) {
        val middle = size.height / 2
        val alpha = if (enabled) 1f else .35f
        drawRoundRect(
            brush =
                Brush.horizontalGradient(
                    listOf(
                        Color.Black.copy(alpha = alpha),
                        MapleColors.muted.copy(alpha = alpha),
                        MapleColors.text.copy(alpha = alpha),
                    )
                ),
            topLeft = Offset(0f, middle - 2.dp.toPx()),
            size = androidx.compose.ui.geometry.Size(size.width, 4.dp.toPx()),
            cornerRadius = CornerRadius(2.dp.toPx()),
        )
        drawCircle(
            MapleColors.text.copy(alpha = alpha),
            7.dp.toPx(),
            Offset(((value - field.minimum) / range).coerceIn(0f, 1f) * size.width, middle),
        )
    }
}
