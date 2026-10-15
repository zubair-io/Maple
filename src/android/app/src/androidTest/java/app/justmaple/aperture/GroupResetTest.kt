package app.justmaple.aperture

import android.net.Uri
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.generated.FilmCatalog
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class GroupResetTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun groupResetClearsItsToggleAndSlidersAsOneSavedUndoTransaction() {
        val i = InstrumentationRegistry.getInstrumentation()
        val bytes = i.context.assets.open("rgb-gradient.png").use { it.readBytes() }
        val original =
            File.createTempFile("group-reset-", ".png", i.targetContext.filesDir).apply {
                writeBytes(bytes)
            }
        val model = ViewModelProvider(compose.activity)[MapleViewModel::class.java]
        fun awaitSaved() =
            compose.waitUntil(30_000) {
                model.state.value.canEdit && !model.state.value.dirty && !model.state.value.saving
            }
        fun assertSaved(attribute: String, expected: String?, field: String, value: Float) {
            awaitSaved()
            val current = model.state.value
            val document = runBlocking { model.library.loadSidecar(current.selected!!) }.document
            assertEquals(expected, document.attribute(attribute))
            assertEquals(value, current.values.getValue(field), .001f)
            assertEquals(.7f, current.values.getValue("exposure"), .001f)
            assertEquals("3", document.attribute("xmp:Rating"))
            assertArrayEquals(bytes, original.readBytes())
            assertNull(current.error)
        }
        try {
            compose.runOnIdle { model.openSingle(Uri.fromFile(original)) }
            compose.waitUntil(30_000) { model.state.value.canChangeMetadata }
            compose.onNodeWithContentDescription("Edit").performClick()
            compose.waitUntil(120_000) { model.state.value.canEdit }
            compose.waitForIdle()
            compose.waitUntil(30_000) { model.state.value.canEdit }
            compose.runOnIdle {
                assertTrue(
                    "Initial canvas must be ready before authoring edits",
                    model.state.value.canEdit,
                )
                model.attribute("xmp:Rating", "3")
                model.attribute("crs:ConvertToGrayscale", "True")
                model.setField("exposure", .7f)
                model.setField("vibrance", 20f)
                model.commitGesture()
                assertEquals(.7f, model.state.value.values.getValue("exposure"), .001f)
                assertEquals(20f, model.state.value.values.getValue("vibrance"), .001f)
            }
            awaitSaved()
            compose.onNodeWithText("Color").performClick()
            compose.onNodeWithText("Reset Color").performClick()
            assertSaved("crs:ConvertToGrayscale", null, "vibrance", 0f)
            compose.runOnIdle { model.undo() }
            assertSaved("crs:ConvertToGrayscale", "True", "vibrance", 20f)
            compose.runOnIdle { model.redo() }
            assertSaved("crs:ConvertToGrayscale", null, "vibrance", 0f)

            val film = FilmCatalog.all.first().id
            compose.runOnIdle {
                model.attribute("papp:FilmLook", film)
                model.setField("film_strength", 35f)
                model.setField("grain_amount", 10f)
                model.commitGesture()
            }
            awaitSaved()
            compose.onNodeWithText("Effects").performClick()
            compose.onNodeWithText("Reset Effects").performClick()
            assertSaved("papp:FilmLook", null, "film_strength", 100f)
            assertEquals(0f, model.state.value.values.getValue("grain_amount"), .001f)
            compose.runOnIdle { model.undo() }
            assertSaved("papp:FilmLook", film, "film_strength", 35f)
            assertEquals(10f, model.state.value.values.getValue("grain_amount"), .001f)
            compose.runOnIdle { model.redo() }
            assertSaved("papp:FilmLook", null, "film_strength", 100f)
            assertEquals(0f, model.state.value.values.getValue("grain_amount"), .001f)
        } finally {
            original.delete()
        }
    }
}
