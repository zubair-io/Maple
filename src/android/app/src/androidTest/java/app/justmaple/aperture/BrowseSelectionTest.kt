package app.justmaple.aperture

import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.*
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.CopiedSettings
import app.justmaple.aperture.data.Folder
import app.justmaple.aperture.data.Photo
import app.justmaple.aperture.data.PhotoLibrary
import app.justmaple.aperture.data.XmpDocument
import app.justmaple.aperture.generated.AdjustmentTransfer
import app.justmaple.aperture.ui.BrowseGrid
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class BrowseSelectionTest {
    @get:Rule val compose = mainThreadComposeRule<ComponentActivity>()

    @Test
    fun selectionUsesTheFilteredSetAndPastesOnlyReviewedGroupsToBothSidecars() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val bytes = instrumentation.context.assets.open("rgb-gradient.png").use { it.readBytes() }
        val directory = File.createTempFile("browse-selection-", "", instrumentation.targetContext.cacheDir)
        check(directory.delete() && directory.mkdir())
        val parent = Uri.fromFile(directory)
        val sidecars = mutableListOf<File>()
        fun sidecar(photo: Photo) =
            File(instrumentation.targetContext.filesDir, "sidecars/${PhotoLibrary.digest("private-sidecar-v3:${photo.key}")}.xmp")
        fun photo(name: String, xml: String): Photo {
            val file = File(directory, "$name.png").apply { writeBytes(bytes) }
            val photo = Photo(Uri.fromFile(file), file.name, file.length(), file.lastModified(), null)
            sidecar(photo).apply {
                parentFile!!.mkdirs()
                writeText(xml)
                sidecars += this
            }
            return photo
        }
        val foreign = "<f:keep xmlns:f=\"urn:browse-test\"><f:value>target &amp; bytes</f:value></f:keep>"
        val unsupported = "<papp:LocalAdjustments><rdf:Seq><rdf:li>opaque target mask</rdf:li></rdf:Seq></papp:LocalAdjustments>"
        fun packet(attributes: String, children: String = "") =
            """<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/" $attributes>$children</rdf:Description></rdf:RDF></x:xmpmeta>"""
        val source = photo("source", packet("crs:Exposure2012=\"1.25\" crs:Saturation=\"-30\""))
        val targets = listOf("first", "second").map { name ->
            photo(name, packet("crs:Exposure2012=\"-0.5\" crs:Contrast2012=\"17\" crs:Highlights2012=\"19\" crs:Saturation=\"10\" papp:Flag=\"pick\"", foreign + unsupported))
        }
        val excluded = photo("excluded", packet("crs:Exposure2012=\"-2\" crs:Saturation=\"22\""))
        val originals = (listOf(source, excluded) + targets).associateWith { File(it.uri.path!!).readBytes() }
        val before = (listOf(source, excluded) + targets).associateWith { sidecar(it).readBytes() }
        val model = ViewModelProvider(compose.activity)[MapleViewModel::class.java]
        try {
            val copied = runBlocking { CopiedSettings(source.name, model.library.loadSidecar(source).document) }
            val photos = targets + excluded
            var narrow by mutableStateOf(false)
            compose.setContent {
                MaterialTheme {
                    Box(Modifier.width(if (narrow) 360.dp else 1280.dp).fillMaxHeight()) {
                        BrowseGrid(
                            model = model,
                            state = MapleState(folder = Folder(parent, "Selection test"), photos = photos, copiedSettings = copied),
                            photos = photos,
                            folders = emptyList(),
                            folderPicker = {},
                        )
                    }
                }
            }
            fun tile(photo: Photo) = compose.onNodeWithTag("browse-photo-${photo.name}")
            fun select(photo: Photo) = tile(photo).performTouchInput { longClick() }

            tile(targets.first()).assertExists()
            select(targets.first())
            compose.onNodeWithTag("browse-selection-bar").assertExists()
            compose.onNodeWithText("1 selected").assertExists()
            compose.runOnIdle { narrow = true }
            compose.onNodeWithText("1 selected").assertExists()
            tile(targets.last()).performClick()
            compose.onNodeWithText("2 selected").assertExists()
            compose.runOnIdle { narrow = false }
            compose.onNodeWithText("2 selected").assertExists()
            tile(targets.first()).performClick()
            compose.onNodeWithText("1 selected").assertExists()
            compose.onNodeWithTag("browse-select-none").performClick()
            compose.onNodeWithText("0 selected").assertExists()
            compose.onNodeWithTag("browse-selection-cancel").performClick()
            compose.onNodeWithTag("browse-selection-bar").assertDoesNotExist()

            compose.onNodeWithTag("grid-filter-picks").performClick()
            compose.waitUntil(30_000) {
                compose.onAllNodesWithTag("browse-photo-${excluded.name}").fetchSemanticsNodes().isEmpty() &&
                    compose.onAllNodesWithTag("browse-photo-${targets.first().name}").fetchSemanticsNodes().size == 1
            }
            select(targets.first())
            compose.onNodeWithTag("browse-select-all").performClick()
            compose.onNodeWithText("2 selected").assertExists()
            compose.onNodeWithTag("browse-paste-settings").performClick()
            compose.waitUntil(30_000) {
                compose.onAllNodesWithTag("paste-settings-dialog").fetchSemanticsNodes().size == 1
            }
            for (group in AdjustmentTransfer.groups.filter { it.id != "tone" }) {
                compose.onNodeWithTag("paste-group-${group.id}").performScrollTo().performClick()
            }
            compose.onNodeWithTag("paste-settings-apply").performClick()
            compose.waitUntil(30_000) {
                targets.all { photo ->
                    runBlocking { model.library.loadSidecar(photo).document.attribute("crs:Exposure2012") == "1.25" }
                }
            }
            for (target in targets) {
                val xml = sidecar(target).readText()
                val saved = XmpDocument(xml)
                assertEquals("1.25", saved.attribute("crs:Exposure2012"))
                assertNull("An omitted supported Tone field must be removed", saved.attribute("crs:Highlights2012"))
                assertEquals("RAW-only contrast must stay on a raster target", "17", saved.attribute("crs:Contrast2012"))
                assertEquals("10", saved.attribute("crs:Saturation"))
                assertEquals("pick", saved.attribute("papp:Flag"))
                assertTrue("Foreign XML must retain its bytes", xml.contains(foreign))
                assertTrue("Unsupported adjustments must retain their bytes", xml.contains(unsupported))
            }
            for (photo in listOf(source, excluded)) {
                assertArrayEquals("Unselected sidecar ${photo.name}", before.getValue(photo), sidecar(photo).readBytes())
            }
            for ((photo, original) in originals) {
                assertArrayEquals("Original photo ${photo.name}", original, File(photo.uri.path!!).readBytes())
            }
        } finally {
            model.batchSettings.cancel()
            compose.waitUntil(30_000) { !model.batchSettings.state.value.running }
            runBlocking { model.batchSettings.discard() }
            compose.activityRule.scenario.close()
            sidecars.forEach { it.delete() }
            directory.deleteRecursively()
        }
    }
}
