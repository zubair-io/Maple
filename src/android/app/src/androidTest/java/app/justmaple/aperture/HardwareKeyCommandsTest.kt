package app.justmaple.aperture

import android.net.Uri
import android.os.SystemClock
import android.view.KeyEvent
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.abs
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Real key events reach the open photo through the window, not a focused Compose node. */
class HardwareKeyCommandsTest {
    @get:Rule val compose = mainThreadComposeRule<MainActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    @Test
    fun cullingAndHistoryKeysEditTheOpenPhotoAndItsSidecar() {
        val bytes = instrumentation.context.assets.open("rgb-gradient.png").use { it.readBytes() }
        val original =
            File.createTempFile("keys-", ".png", instrumentation.targetContext.filesDir).apply {
                writeBytes(bytes)
            }
        try {
            compose.activityRule.scenario.let { scenario ->
                val reference = AtomicReference<MapleViewModel>()
                scenario.onActivity { reference.set(ViewModelProvider(it)[MapleViewModel::class.java]) }
                val model = reference.get()
                scenario.onActivity { model.openSingle(Uri.fromFile(original)) }
                model.await("photo opens") { it.canChangeMetadata && it.mode == PhotoMode.Preview }

                press(KeyEvent.KEYCODE_3)
                model.await("rating 3") { it.document.rating == 3 }
                press(KeyEvent.KEYCODE_P)
                model.await("pick") { it.document.attribute("papp:Flag") == "pick" }
                press(KeyEvent.KEYCODE_X)
                model.await("reject") { it.document.attribute("papp:Flag") == "reject" }
                press(KeyEvent.KEYCODE_U)
                model.await("unflagged") { it.document.attribute("papp:Flag") == null }
                press(KeyEvent.KEYCODE_NUMPAD_5)
                model.await("rating 5") { it.document.rating == 5 }
                press(KeyEvent.KEYCODE_0)
                model.await("no rating") { it.document.attribute("xmp:Rating") == null }
                press(KeyEvent.KEYCODE_4)
                model.await("rating 4") { it.document.rating == 4 }

                scenario.onActivity { model.edit() }
                model.await("editor ready") { it.canEdit }
                compose.waitForIdle()
                model.await("editor layout ready") { it.canEdit }
                val before = model.state.value.values.getValue("exposure")
                scenario.onActivity {
                    assertTrue("Editor must accept the slider change", model.state.value.canEdit)
                    model.setField("exposure", before + .7f)
                    model.commitGesture()
                    assertEquals(before + .7f, model.state.value.values.getValue("exposure"), .001f)
                    assertTrue("Slider change must create undo history", model.state.value.canUndo)
                }
                fun exposureIs(value: Float) = { s: MapleState -> abs(s.values.getValue("exposure") - value) < .001f }
                compose.waitForIdle()
                model.await("edited frame ready") { it.canEdit && it.canUndo }
                val ctrl = KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON
                press(KeyEvent.KEYCODE_Z, ctrl)
                model.await("undo") { it.canEdit && exposureIs(before)(it) && it.canRedo }
                press(KeyEvent.KEYCODE_Z, ctrl or KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON)
                model.await("redo") { it.canEdit && exposureIs(before + .7f)(it) && !it.canRedo }
                model.await("saved") { !it.dirty && !it.saving }

                val saved = runBlocking { model.library.loadSidecar(model.state.value.selected!!) }.document
                assertEquals("4", saved.attribute("xmp:Rating"))
                assertNull(saved.attribute("papp:Flag"))
                assertEquals(before + .7f, saved.attribute("crs:Exposure2012")!!.toFloat(), .001f)
                assertArrayEquals(bytes, original.readBytes())
                assertNull(model.state.value.error)
            }
        } finally {
            original.delete()
        }
    }

    private fun press(code: Int, meta: Int = 0) {
        val modifiers = buildList {
            if (meta and KeyEvent.META_CTRL_ON != 0) add(KeyEvent.KEYCODE_CTRL_LEFT)
            if (meta and KeyEvent.META_META_ON != 0) add(KeyEvent.KEYCODE_META_LEFT)
            if (meta and KeyEvent.META_SHIFT_ON != 0) add(KeyEvent.KEYCODE_SHIFT_LEFT)
        }
        modifiers.forEach { instrumentation.sendKeySync(KeyEvent(KeyEvent.ACTION_DOWN, it)) }
        try {
            val now = SystemClock.uptimeMillis()
            instrumentation.sendKeySync(KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0, meta))
            instrumentation.sendKeySync(KeyEvent(now, now, KeyEvent.ACTION_UP, code, 0, meta))
        } finally {
            modifiers.asReversed().forEach {
                instrumentation.sendKeySync(KeyEvent(KeyEvent.ACTION_UP, it))
            }
        }
        instrumentation.waitForIdleSync()
    }

    private fun MapleViewModel.await(what: String, condition: (MapleState) -> Boolean) {
        compose.waitUntil(120_000) {
            assertNull("While waiting for $what", state.value.error)
            condition(state.value)
        }
    }
}
