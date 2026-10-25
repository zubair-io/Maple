package app.justmaple.aperture.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.lazy.grid.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class GridPinchAnchorTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun rightColumnPhotoStaysUnderTheFingersAcrossTwoColumnChanges() {
        val state = LazyGridState(firstVisibleItemIndex = 60)
        var columns by mutableIntStateOf(3)
        compose.setContent {
            Box(Modifier.size(360.dp, 500.dp).testTag("pinch-viewport")) {
                LazyVerticalGrid(GridCells.Fixed(columns), Modifier.gridPinch(state, columns) { columns = it },
                    state = state, contentPadding = PaddingValues(4.dp),
                    horizontalArrangement = Arrangement.spacedBy(3.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    items(150, key = { "photo:$it" }) { Box(Modifier.aspectRatio(1f).testTag("photo:$it")) }
                }
            }
        }
        var center = Offset.Zero
        compose.runOnIdle {
            val item = compose.onNodeWithTag("photo:62").fetchSemanticsNode()
            val origin = compose.onNodeWithTag("pinch-viewport").fetchSemanticsNode().positionInRoot
            center = item.positionInRoot - origin + Offset(item.size.width * 0.5f, item.size.height * 0.5f)
        }
        val viewport = compose.onNodeWithTag("pinch-viewport")
        viewport.performTouchInput {
            down(0, center - Offset(20f, 0f)); down(1, center + Offset(20f, 0f))
            updatePointerTo(0, center - Offset(35f, 0f)); updatePointerTo(1, center + Offset(35f, 0f)); move()
        }
        fun assertAnchor(expectedColumns: Int) {
            compose.runOnIdle {
                assertEquals(expectedColumns, columns)
                val item = compose.onNodeWithTag("photo:62").fetchSemanticsNode()
                val origin = viewport.fetchSemanticsNode().positionInRoot
                assertEquals(center.x, item.positionInRoot.x - origin.x + item.size.width * 0.5f, 2f)
                assertEquals(center.y, item.positionInRoot.y - origin.y + item.size.height * 0.5f, 2f)
            }
        }
        assertAnchor(2)
        viewport.performTouchInput {
            updatePointerTo(0, center - Offset(60f, 0f)); updatePointerTo(1, center + Offset(60f, 0f)); move()
        }
        assertAnchor(1)
        viewport.performTouchInput { up(0); up(1) }
        compose.waitForIdle()
    }

    @Test
    fun changingColumnsKeepsTheCentroidPhotoAtItsVerticalAnchor() {
        val state = LazyGridState(firstVisibleItemIndex = 60)
        var columns by mutableIntStateOf(3)
        compose.setContent {
            LazyVerticalGrid(
                GridCells.Fixed(columns),
                Modifier.size(360.dp, 500.dp).gridPinch(state, columns) { columns = it }.testTag("anchored-grid"),
                state = state,
                contentPadding = PaddingValues(4.dp),
                horizontalArrangement = Arrangement.spacedBy(3.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                items(150, key = { "photo:$it" }) {
                    Box(Modifier.aspectRatio(1f).testTag("photo:$it"))
                }
            }
        }
        lateinit var key: Any
        var center = Offset.Zero
        compose.runOnIdle {
            val anchor = state.layoutInfo.visibleItemsInfo.first { it.index == 67 }
            key = anchor.key
            center = Offset(anchor.offset.x + anchor.size.width * 0.5f, anchor.offset.y + anchor.size.height * 0.5f)
        }
        compose.onNodeWithTag("anchored-grid").performTouchInput {
            down(0, center - Offset(30f, 0f))
            down(1, center + Offset(30f, 0f))
            updatePointerTo(0, center - Offset(20f, 0f))
            updatePointerTo(1, center + Offset(20f, 0f))
            move()
            up(0)
            up(1)
        }
        compose.runOnIdle {
            assertEquals(4, columns)
            val anchor = state.layoutInfo.visibleItemsInfo.firstOrNull { it.key == key }
            assertNotNull("The centroid photo must stay visible", anchor)
            assertEquals(center.y, anchor!!.offset.y + anchor.size.height * 0.5f, 2f)
        }
    }
}
