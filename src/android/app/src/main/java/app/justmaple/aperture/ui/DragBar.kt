package app.justmaple.aperture.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.generated.AdjustmentField

@Composable
fun DragBar(
    field: AdjustmentField,
    value: Float,
    onChange: (Float) -> Unit,
    onCommit: () -> Unit,
    onReset: () -> Unit,
) {
    val change by rememberUpdatedState(onChange)
    val commit by rememberUpdatedState(onCommit)
    val current by rememberUpdatedState(value)
    var fine by remember { mutableStateOf(false) }
    var gestureValue by remember { mutableFloatStateOf(value) }
    val range = field.maximum - field.minimum
    val marker = ((value - field.minimum) / range).coerceIn(0f, 1f)
    Canvas(
        Modifier.fillMaxWidth()
            .height(44.dp)
            .padding(horizontal = 24.dp)
            .semantics {
                contentDescription = fieldLabel(field)
                progressBarRangeInfo = ProgressBarRangeInfo(value, field.minimum..field.maximum)
                setProgress { next ->
                    change(next.coerceIn(field.minimum, field.maximum))
                    commit()
                    true
                }
                customActions =
                    listOf(
                        CustomAccessibilityAction("Reset") {
                            onReset()
                            true
                        }
                    )
            }
            .pointerInput(field.name) {
                detectTapGestures(onDoubleTap = { onReset() }, onLongPress = { fine = true })
            }
            .pointerInput(field.name) {
                detectDragGestures(
                    onDragStart = { gestureValue = current },
                    onDragEnd = {
                        fine = false
                        commit()
                    },
                    onDragCancel = {
                        fine = false
                        commit()
                    },
                ) { event, distance ->
                    event.consume()
                    gestureValue =
                        (gestureValue + distance.x / size.width * range * if (fine) .25f else 1f)
                            .coerceIn(field.minimum, field.maximum)
                    change(gestureValue)
                }
            }
    ) {
        val middle = size.height / 2
        drawLine(MapleColors.border, Offset(0f, middle), Offset(size.width, middle), 1.dp.toPx())
        for (i in 0..20) {
            val height = if (i == 10) 14.dp.toPx() else 6.dp.toPx()
            val x = size.width * i / 20
            drawLine(
                if (i == 10) MapleColors.borderHi else MapleColors.border,
                Offset(x, middle - height / 2),
                Offset(x, middle + height / 2),
                1.dp.toPx(),
            )
        }
        val x = size.width * marker
        drawLine(
            MapleColors.primary,
            Offset(x, middle - 11.dp.toPx()),
            Offset(x, middle + 11.dp.toPx()),
            2.dp.toPx(),
        )
    }
}
