package app.justmaple.aperture

import android.net.Uri
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.XmpDocument
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class FailedSidecarLoadTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun failedLoadsCannotReuseAnotherPhotosMatchingBaseline() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val model = ViewModelProvider(compose.activity)[MapleViewModel::class.java]
        val first = File.createTempFile("baseline-first-", ".png", context.filesDir)
        val second = File.createTempFile("baseline-second-", ".png", context.filesDir)
        instrumentation.context.assets.open("rgb-gradient.png").use { input ->
            first.outputStream().use { input.copyTo(it) }
        }
        second.writeBytes(first.readBytes())
        val bytes = first.readBytes()
        val preset =
            XmpDocument()
                .withAttribute("crs:Exposure2012", "0.75")
                .withAttribute("xmp:Label", "Same preset")
        val a = runBlocking { model.library.single(Uri.fromFile(first)) }
        val b = runBlocking { model.library.single(Uri.fromFile(second)) }
        val sidecars = File(context.filesDir, "sidecars")
        runBlocking { model.library.save(a, preset, null) }
        val before = sidecars.listFiles().orEmpty().toSet()
        runBlocking { model.library.save(b, preset, null) }
        val target = sidecars.listFiles().orEmpty().single { it !in before }
        val xml = target.readBytes()
        try {
            compose.runOnIdle { model.open(a) }
            compose.waitUntil(30_000) {
                !model.state.value.loading && model.state.value.selected == a
            }
            assertEquals("0.75", model.state.value.document.attribute("crs:Exposure2012"))
            for (reload in listOf(false, true)) {
                target.writeText("<broken>")
                compose.runOnIdle { if (reload) model.reloadSavedEdits() else model.open(b) }
                compose.waitUntil(30_000) {
                    !model.state.value.loading && model.state.value.error != null
                }
                assertEquals(b, model.state.value.selected)
                // The provider recovers and returns the same preset as the prior photo.
                target.writeBytes(xml)
                compose.runOnIdle {
                    model.clearError()
                    model.attribute("xmp:Rating", "5")
                    model.attribute("papp:Flag", "pick")
                    model.edit()
                    assertFalse(
                        "Failed sidecar loads must block metadata writes",
                        model.state.value.dirty,
                    )
                    assertEquals(PhotoMode.Preview, model.state.value.mode)
                }
                compose.onNodeWithContentDescription("Rate 5 stars").assertIsNotEnabled()
                compose.onNodeWithContentDescription("Pick photo").assertIsNotEnabled()
                compose.onNodeWithContentDescription("Edit").assertIsNotEnabled()
                compose.onNodeWithContentDescription("More photo actions").performClick()
                compose.onNodeWithText("Photo Info").performClick()
                compose.onNodeWithText("Export XMP sidecar…").assertIsNotEnabled()
                val destination = File(context.cacheDir, "failed-load-export.xmp")
                assertTrue(
                    runCatching { runBlocking { model.export(Uri.fromFile(destination), true) } }
                        .isFailure
                )
                assertFalse(destination.exists())
                assertTrue(runBlocking { model.flush() })
                assertArrayEquals(xml, target.readBytes())
                compose.runOnIdle { model.reloadSavedEdits() }
                compose.waitUntil(30_000) {
                    !model.state.value.loading && model.state.value.error == null
                }
                assertEquals("0.75", model.state.value.document.attribute("crs:Exposure2012"))
                assertEquals("Same preset", model.state.value.document.attribute("xmp:Label"))
                compose.onNodeWithText("Export XMP sidecar…").assertIsEnabled()
                compose.onNodeWithContentDescription("More photo actions").performClick()
                compose.onNodeWithText("Photo Info").performClick()
            }
            compose.runOnIdle { model.attribute("xmp:Rating", "4") }
            assertTrue(runBlocking { model.flush() })
            val saved = runBlocking { model.library.loadSidecar(b) }.document
            assertEquals(4, saved.rating)
            assertEquals("0.75", saved.attribute("crs:Exposure2012"))
            assertEquals("Same preset", saved.attribute("xmp:Label"))
            assertEquals(
                "0.75",
                runBlocking { model.library.loadSidecar(a) }.document.attribute("crs:Exposure2012"),
            )
            assertArrayEquals(bytes, first.readBytes())
            assertArrayEquals(bytes, second.readBytes())
        } finally {
            first.delete()
            second.delete()
            target.delete()
        }
    }
}
