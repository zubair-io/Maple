package app.justmaple.aperture

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.generated.AdjustmentFields
import app.justmaple.aperture.ui.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class AdjustmentSliderTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun verticalSwipeAcrossSlidersScrollsWithoutEditing() {
        val values = mutableMapOf<String, Float>()
        var commits = 0
        val list = LazyListState()
        compose.setContent {
            MapleTheme {
                LazyColumn(Modifier.width(320.dp).height(220.dp), state = list) {
                    items(EditorGroup.Detail.fields.size) { index ->
                        val field = EditorGroup.Detail.fields[index]
                        AdjustmentSlider(field, field.initial, true,
                            { values[field.name] = it }, { commits++ })
                    }
                }
            }
        }
        compose.onNodeWithContentDescription("Sharpen Masking adjustment").performTouchInput {
            // Slight diagonal drift must still belong to vertical scrolling.
            swipe(center, center + Offset(4f, -120f), 500)
        }
        compose.runOnIdle {
            assertTrue("Swipe over a slider must scroll the list",
                list.firstVisibleItemIndex > 0 || list.firstVisibleItemScrollOffset > 0)
            assertTrue("Scrolling must not edit an adjustment", values.isEmpty())
            assertEquals(0, commits)
        }
    }

    @Test
    fun horizontalScrubStillChangesValueAndCommitsOnce() {
        val field = AdjustmentFields.byName.getValue("temperature")
        var value by mutableFloatStateOf(field.initial)
        var commits = 0
        compose.setContent {
            MapleTheme {
                Box(Modifier.width(320.dp)) {
                    AdjustmentSlider(field, value, true, { value = it }, { commits++ })
                }
            }
        }
        compose.onNodeWithContentDescription("Temp adjustment").performTouchInput {
            swipe(centerLeft + Offset(20f, 0f), centerRight - Offset(20f, 0f), 500)
        }
        compose.runOnIdle {
            assertTrue(value > field.initial)
            assertEquals(1, commits)
        }
    }

    @Test
    fun whiteBalanceTracksShowTheirColorsInInspectorAndPhoneBar() {
        compose.setContent {
            MapleTheme {
                Column(Modifier.width(320.dp)) {
                    for (name in listOf("temperature", "tint")) {
                        val field = AdjustmentFields.byName.getValue(name)
                        Box(Modifier.testTag("inspector-$name")) {
                            AdjustmentSlider(field, field.initial, true, {}, {})
                        }
                        Box(Modifier.testTag("phone-$name")) {
                            DragBar(field, field.initial, {}, {}, {})
                        }
                    }
                }
            }
        }
        for (surface in listOf("inspector", "phone")) {
            for (name in listOf("temperature", "tint")) {
                val pixels = compose.onNodeWithTag("$surface-$name").captureToImage().toPixelMap()
                val left = pixels[(pixels.width * .15f).toInt(), pixels.height / 2]
                val right = pixels[(pixels.width * .85f).toInt(), pixels.height / 2]
                if (name == "temperature") {
                    assertTrue("$surface temperature starts blue", left.blue > left.red)
                    assertTrue("$surface temperature ends warm", right.red > right.blue)
                } else {
                    assertTrue("$surface tint starts green", left.green > left.red)
                    assertTrue("$surface tint ends magenta", right.red > right.green)
                }
            }
        }
    }
}
