package app.justmaple.aperture

import android.app.Application
import android.provider.DocumentsContract
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.*
import app.justmaple.aperture.ui.BrowseGrid
import app.justmaple.aperture.ui.MapleTheme
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test

/**
 * The real `BrowseGrid` over a warm folder of 2,000 photos, each with a rated sidecar: how fast tiles and
 * culling badges appear on first view, on returning to the grid, and for tiles that scroll back in.
 * A tile shows its image when its subtree holds a second node described by the photo name (the image
 * beside the tile itself); a placeholder is a tile without one.
 */
@TimingBenchmark
class GridTimingTest {
    @get:Rule val compose = mainThreadComposeRule<ComponentActivity>()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private val named =
        SemanticsMatcher("described by a photo name") {
            it.config.getOrNull(SemanticsProperties.ContentDescription)?.firstOrNull()?.startsWith("IMG_") == true
        }
    private val tile = SemanticsMatcher("grid tile") { node ->
        node.config.getOrNull(SemanticsProperties.TestTag)?.startsWith("browse-photo-IMG_") == true
    }
    private val badge =
        SemanticsMatcher("rating badge") {
            it.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text?.startsWith("★") == true
        }

    private fun tiles() = compose.onAllNodes(tile, useUnmergedTree = true).fetchSemanticsNodes().size

    private fun described() = compose.onAllNodes(named, useUnmergedTree = true).fetchSemanticsNodes().size

    private fun badges() = compose.onAllNodes(badge, useUnmergedTree = true).fetchSemanticsNodes().size

    private fun placeholders() = 2 * tiles() - described()

    private fun millisUntil(limit: Long = 120_000, done: () -> Boolean): Double {
        val start = System.nanoTime()
        while (!done()) {
            check((System.nanoTime() - start) / 1e6 < limit) { "Timed out" }
            Thread.sleep(2)
        }
        return (System.nanoTime() - start) / 1e6
    }

    @Test
    fun tilesAndBadgesInAFolderOf2000Photos() {
        val count = 2_000
        val folders = TimingFolders()
        try {
            val directory = folders.populate("", count)
            val bytes = XmpEncoding.encode(XmpDocument().withAttribute("xmp:Rating", "3").serialize())
            for (index in 1..count) File(directory, "IMG_%05d.xmp".format(index)).writeBytes(bytes)
            val library = PhotoLibrary(context)
            val folder = DocumentsContract.buildDocumentUriUsingTree(folders.tree, "root")
            val photos = runBlocking { library.list(folder) }.photos
            val first = photos.first { it.name == "IMG_00001.dng" }
            runBlocking { library.withThumbnail(first, 512) { _, _ -> } }
            val thumbs = File(directory, ".maple/thumbs")
            val seed = File(thumbs, "${first.name}.avif")
            val warmAt = System.currentTimeMillis()
            for (photo in photos) File(thumbs, "${photo.name}.avif").also {
                if (!it.exists()) seed.copyTo(it)
                it.setLastModified(warmAt)
            }
            val state = MapleState(folder = Folder(folder, "Photos"), photos = photos)
            var shown by mutableStateOf(false)
            var model: MapleViewModel? = null
            compose.setContent { MapleTheme { if (shown) BrowseGrid(checkNotNull(model), state, photos, emptyList(), folderPicker = {}) } }
            val showGrid = { compose.runOnIdle { shown = true } }
            val hideGrid = {
                compose.runOnIdle { shown = false }
                compose.waitForIdle()
            }

            val firstTiles = mutableListOf<Double>()
            val firstBadges = mutableListOf<Double>()
            val returnTiles = mutableListOf<Double>()
            val returnBadges = mutableListOf<Double>()
            val placeholdersAfterScroll = mutableListOf<Double>()
            val reEntryAllShown = mutableListOf<Double>()
            var visible = 0
            fun sinceMillis(start: Long) = (System.nanoTime() - start) / 1e6
            repeat(Timing.rounds) {
                val roundLibrary = PhotoLibrary(context)
                model = MapleViewModel(
                    context.applicationContext as Application, roundLibrary, null,
                    BatchSettingsTransfer(File(directory.parentFile, "timing-queue.json"), roundLibrary::loadSidecar, roundLibrary::save),
                )
                var start = System.nanoTime()
                showGrid()
                compose.waitForIdle()
                visible = tiles()
                check(visible > 0) { "The grid composed no tile" }
                millisUntil { placeholders() == 0 }
                firstTiles += sinceMillis(start)
                millisUntil { badges() >= visible }
                firstBadges += sinceMillis(start)

                val grid = compose.onNode(hasScrollToIndexAction())
                grid.performScrollToIndex(2 * visible)
                millisUntil { placeholders() == 0 }
                grid.performScrollToIndex(0)
                start = System.nanoTime()
                placeholdersAfterScroll += placeholders().toDouble()
                millisUntil { placeholders() == 0 }
                reEntryAllShown += sinceMillis(start)

                hideGrid()
                start = System.nanoTime()
                showGrid()
                compose.waitForIdle()
                check(tiles() > 0) { "The grid composed no tile on return" }
                millisUntil { placeholders() == 0 }
                returnTiles += sinceMillis(start)
                millisUntil { badges() >= tiles() }
                returnBadges += sinceMillis(start)
                hideGrid()
            }
            Timing.fact("grid.setup", "photos=${photos.size} visibleTiles=$visible ratedSidecars=$count")
            Timing.reportFirstAndLater("grid.first-view.tiles-all-shown", "ms", firstTiles, "from showing the grid (fresh library and view model each round) until no visible tile is a placeholder")
            Timing.reportFirstAndLater("grid.first-view.badges-all-shown", "ms", firstBadges, "from showing the grid (fresh library and view model each round) until every visible tile shows its rating badge")
            Timing.reportFirstAndLater("grid.return-to-grid.tiles-all-shown", "ms", returnTiles, "grid disposed and composed again with the same view model, until no visible tile is a placeholder")
            Timing.reportFirstAndLater("grid.return-to-grid.badges-all-shown", "ms", returnBadges, "same, until every visible tile shows its rating badge, counted from the recomposition")
            Timing.reportFirstAndLater("grid.scroll-back.placeholders-after-scroll", "tiles", placeholdersAfterScroll, "once scrolling two screens down and back to the top has returned (the scroll call waits for idle, so this is not the first composed frame): tiles with no image, of $visible visible")
            Timing.reportFirstAndLater("grid.scroll-back.all-shown", "ms", reEntryAllShown, "from when the scroll back to the top has returned (it waits for idle) until no visible tile is a placeholder")
        } finally {
            folders.fixture.close()
        }
    }
}
