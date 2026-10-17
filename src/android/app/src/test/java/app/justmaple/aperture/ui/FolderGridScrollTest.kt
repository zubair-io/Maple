package app.justmaple.aperture.ui

import android.net.Uri
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class FolderGridScrollTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun changingFolderStartsAtTopWhileSameFolderKeepsOffset() {
        val folder = mutableStateOf(Uri.parse("content://maple/tree/Portfolio"))
        val photos = mutableStateOf((0 until 200).toList())
        lateinit var grid: LazyGridState
        compose.setContent {
            grid = rememberFolderGridState(folder.value)
            LazyVerticalGrid(GridCells.Fixed(3), Modifier.fillMaxSize(), state = grid) {
                items(photos.value, key = { "${folder.value}:$it" }) {
                    Text("$it", Modifier.height(100.dp))
                }
            }
        }
        compose.runOnIdle { runBlocking { grid.scrollToItem(90) } }
        compose.runOnIdle { photos.value = (0 until 300).toList() }
        compose.runOnIdle { assertEquals(90, grid.firstVisibleItemIndex) }
        compose.runOnIdle { folder.value = Uri.parse("content://maple/tree/Iceland") }
        compose.runOnIdle {
            assertEquals(0, grid.firstVisibleItemIndex)
            assertEquals(0, grid.firstVisibleItemScrollOffset)
        }
    }
}
