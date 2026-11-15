package app.justmaple.aperture

import android.app.Application
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.*
import androidx.lifecycle.viewModelScope
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.*
import app.justmaple.aperture.generated.AdjustmentTransfer
import app.justmaple.aperture.ui.BrowseGrid
import app.justmaple.aperture.ui.MapleTheme
import java.io.File
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class BrowseBatchThumbnailTest {
    @get:Rule val compose = mainThreadComposeRule<ComponentActivity>()

    @Test fun confirmedBatchWritesRefreshAlreadyVisibleThumbnailPixels() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val directory = File.createTempFile("batch-thumbnail-", "", context.cacheDir)
        check(directory.delete() && directory.mkdir())
        val originalBytes = instrumentation.context.assets.open("rgb-gradient.png").use { it.readBytes() }
        val original = File(directory, "target.png").apply { writeBytes(originalBytes) }
        val photo = Photo(Uri.fromFile(original), original.name, original.length(), original.lastModified(), null)
        val library = PhotoLibrary(context)
        val batch = BatchSettingsTransfer(File(directory, "queue.json"), library::loadSidecar, library::save)
        val model = MapleViewModel(context.applicationContext as Application, library, null, batch)
        val tile = compose.onNodeWithTag("browse-photo-${photo.name}")
        fun brightness(): Float {
            val pixels = tile.captureToImage().toPixelMap()
            var total = 0f
            for (y in 1..8) for (x in 1..8) {
                val color = pixels[pixels.width * x / 9, pixels.height * y / 9]
                total += color.red + color.green + color.blue
            }
            return total / (64 * 3)
        }
        try {
            runBlocking { library.save(photo, XmpDocument().withAttribute("crs:Exposure2012", "-2"), null) }
            compose.setContent {
                MapleTheme {
                    BrowseGrid(model, MapleState(folder = Folder(Uri.fromFile(directory), "Photos"), photos = listOf(photo)),
                        listOf(photo), emptyList(), folderPicker = {})
                }
            }
            compose.waitUntil(30_000) {
                compose.onAllNodes(hasContentDescription(photo.name), useUnmergedTree = true).fetchSemanticsNodes().size >= 2
            }
            val before = brightness()
            runBlocking {
                batch.prepare(listOf(photo), CopiedSettings("source.png",
                    XmpDocument().withAttribute("crs:Exposure2012", "2")),
                    listOf(AdjustmentTransfer.groups.single { it.id == "tone" }))
                batch.run()
            }
            assertEquals(1, batch.state.value.completed)
            compose.waitUntil(30_000) { brightness() > before + 0.05f }
            assertArrayEquals(originalBytes, original.readBytes())
        } finally {
            model.viewModelScope.cancel()
            model.renderer.close()
            compose.activityRule.scenario.close()
            File(context.filesDir, "sidecars/${PhotoLibrary.digest("private-sidecar-v3:${photo.key}")}.xmp").delete()
            directory.deleteRecursively()
        }
    }
}
