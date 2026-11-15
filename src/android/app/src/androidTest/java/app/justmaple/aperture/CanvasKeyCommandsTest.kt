package app.justmaple.aperture

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.net.Uri
import android.view.KeyEvent
import android.view.ViewGroup
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performSemanticsAction
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Keyboard zoom and Reset Visible Group through the window and the real zoom binding (#5945). */
class CanvasKeyCommandsTest {
    @get:Rule val compose = mainThreadComposeRule<MainActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    @Test
    fun zoomKeysDriveTheCanvasAndResetVisibleGroupResetsTheShownGroup() {
        val original = File.createTempFile("zoom-keys-", ".png", instrumentation.targetContext.filesDir)
        val bitmap = Bitmap.createBitmap(3000, 2000, Bitmap.Config.ARGB_8888)
        Canvas(bitmap).drawPaint(Paint().apply {
            shader = LinearGradient(0f, 0f, 3000f, 2000f, Color.rgb(20, 90, 160), Color.rgb(240, 200, 60),
                Shader.TileMode.CLAMP)
        })
        original.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        val bytes = original.readBytes()
        try {
            val model = ViewModelProvider(compose.activity)[MapleViewModel::class.java]
            compose.runOnIdle { model.openSingle(Uri.fromFile(original)) }
            model.await("photo opens") { it.canChangeMetadata && it.mode == PhotoMode.Preview }
            // The canvas enters the photo's zoom scope (at fit) in an effect; keys follow it.
            compose.waitUntil(30_000) {
                runCatching { badge().getOrNull(SemanticsProperties.StateDescription) }.getOrNull() == "FIT"
            }
            compose.waitForIdle()
            press(KeyEvent.KEYCODE_Z)
            awaitBadge("100%") { it == 100 }
            press(KeyEvent.KEYCODE_EQUALS, CTRL)
            awaitBadge("a step in") { it == 125 }
            press(KeyEvent.KEYCODE_MINUS, CTRL)
            awaitBadge("a step back") { it == 100 }
            press(KeyEvent.KEYCODE_F)
            compose.waitUntil(30_000) { badgeAction() != "Zoom to Fit" }
            val fit = badgePercent()!!
            assertTrue("a 3000 px photo fits below 100% on this screen", fit < 100)
            press(KeyEvent.KEYCODE_MINUS, CTRL)
            awaitBadge("below fit") { it < fit }
            press(KeyEvent.KEYCODE_EQUALS, CTRL)
            awaitBadge("zooming in stops at fit") { it == fit }
            assertNotEquals("Zoom to Fit", badgeAction())
            press(KeyEvent.KEYCODE_1, CTRL)
            awaitBadge("⌘1") { it == 100 }
            press(KeyEvent.KEYCODE_0, CTRL)
            awaitBadge("⌘0") { it == fit }

            // A text field keeps F and Z as text: F typed at 100% must not fit, Z typed at fit
            // must not zoom (the soft keyboard may resize the viewport, so fit's percentage moves).
            press(KeyEvent.KEYCODE_Z)
            awaitBadge("Z before typing") { it == 100 }
            typeIntoAFocusedTextField(KeyEvent.KEYCODE_F, "f")
            assertEquals(100, badgePercent())
            press(KeyEvent.KEYCODE_F)
            compose.waitUntil(30_000) { badgeAction() != "Zoom to Fit" }
            typeIntoAFocusedTextField(KeyEvent.KEYCODE_Z, "z")
            assertNotEquals("Zoom to Fit", badgeAction())

            compose.runOnIdle { model.edit() }
            model.await("editor ready") { it.canEdit }
            compose.waitForIdle()
            val slider = compose.onNode(
                (hasContentDescription("Exposure adjustment") or hasContentDescription("Exposure")) and
                    SemanticsMatcher.keyIsDefined(SemanticsProperties.ProgressBarRangeInfo)
            )
            slider.performSemanticsAction(SemanticsActions.RequestFocus)
            slider.assertIsFocused()
            press(KeyEvent.KEYCODE_DPAD_RIGHT)
            model.await("the focused slider steps") { it.values.getValue("exposure") > .05f }
            val stepped = model.state.value.values.getValue("exposure")
            press(KeyEvent.KEYCODE_Z)
            awaitBadge("100% with the slider focused") { it == 100 }
            slider.assertIsFocused()
            press(KeyEvent.KEYCODE_DPAD_RIGHT)
            model.await("the slider keeps its keys") { it.values.getValue("exposure") > stepped + .05f }

            compose.runOnIdle { model.setField("vibrance", 20f); model.commitGesture() }
            model.await("saved") { !it.dirty && !it.saving }
            press(KeyEvent.KEYCODE_R, CTRL or SHIFT)
            model.await("Light reset") { it.values.getValue("exposure") == 0f && !it.dirty && !it.saving }
            assertEquals("Color is not the visible group", 20f, model.state.value.values.getValue("vibrance"), .001f)
            press(KeyEvent.KEYCODE_Z, CTRL)
            model.await("one undo restores Light") {
                it.values.getValue("exposure") > stepped + .05f && !it.dirty && !it.saving
            }
            val saved = runBlocking { model.library.loadSidecar(model.state.value.selected!!) }.document
            assertEquals(model.state.value.values.getValue("exposure"),
                saved.attribute("crs:Exposure2012")!!.toFloat(), .001f)
            press(KeyEvent.KEYCODE_R)
            model.await("R resets Light too") { it.values.getValue("exposure") == 0f && !it.dirty && !it.saving }
            assertEquals(20f, model.state.value.values.getValue("vibrance"), .001f)
            assertArrayEquals(bytes, original.readBytes())
            assertNull(model.state.value.error)
        } finally {
            original.delete()
        }
    }

    private fun typeIntoAFocusedTextField(code: Int, typed: String) {
        var text by mutableStateOf("")
        val field = ComposeView(compose.activity)
        compose.runOnIdle {
            field.setContent {
                BasicTextField(text, { text = it }, Modifier.testTag("key-test-field"), singleLine = true)
            }
            compose.activity.addContentView(field, ViewGroup.LayoutParams(600, 160))
        }
        try {
            compose.onNodeWithTag("key-test-field").performSemanticsAction(SemanticsActions.RequestFocus)
            compose.onNodeWithTag("key-test-field").assertIsFocused()
            press(code)
            compose.waitUntil(10_000) { text == typed }
            compose.waitForIdle()
        } finally {
            compose.runOnIdle { (field.parent as ViewGroup).removeView(field) }
        }
    }

    private fun badgePercent(): Int? =
        badge().getOrNull(SemanticsProperties.StateDescription)
            ?.let { Regex("""^(\d+)%""").find(it)?.groupValues?.get(1)?.toInt() }

    private fun badge() = compose.onNodeWithTag("canvas-zoom-indicator").fetchSemanticsNode().config

    private fun badgeAction(): String? = badge().getOrNull(SemanticsProperties.ContentDescription)?.firstOrNull()

    private fun awaitBadge(what: String, percent: (Int) -> Boolean) {
        try {
            compose.waitUntil(60_000) { badgePercent()?.let(percent) == true }
        } catch (timeout: Throwable) {
            throw AssertionError("Badge for $what: ${badge().getOrNull(SemanticsProperties.StateDescription)}", timeout)
        }
    }

    private fun press(code: Int, meta: Int = 0) = instrumentation.press(code, meta)

    private fun MapleViewModel.await(what: String, condition: (MapleState) -> Boolean) {
        compose.waitUntil(120_000) {
            assertNull("While waiting for $what", state.value.error)
            condition(state.value)
        }
    }
}
