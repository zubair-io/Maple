package app.justmaple.aperture

import android.net.Uri
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class WhiteBalanceResetTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun colorAndSingleControlResetRestoreCameraWhiteBalanceWithUndoAndRedo() {
        val i = InstrumentationRegistry.getInstrumentation()
        val bytes = i.context.assets.open("source.dng").use { it.readBytes() }
        // Change only this disposable fixture's AsShotNeutral to a D50 camera reading.
        val buffer =
            ByteBuffer.wrap(bytes)
                .order(
                    if (bytes[0] == 73.toByte()) ByteOrder.LITTLE_ENDIAN else ByteOrder.BIG_ENDIAN
                )
        val ifd = buffer.getInt(4)
        val tag =
            (0 until buffer.getShort(ifd).toInt())
                .map { ifd + 2 + it * 12 }
                .single { buffer.getShort(it).toInt() and 65535 == 50728 }
        assertEquals(5, buffer.getShort(tag + 2).toInt())
        assertEquals(3, buffer.getInt(tag + 4))
        val offset = buffer.getInt(tag + 8)
        listOf(9642, 10000, 1, 1, 8251, 10000).forEachIndexed { index, value ->
            buffer.putInt(offset + index * 4, value)
        }
        val original =
            File.createTempFile("camera-wb-", ".dng", i.targetContext.filesDir).apply {
                writeBytes(bytes)
            }
        val model = ViewModelProvider(compose.activity)[MapleViewModel::class.java]
        try {
            compose.runOnIdle { model.openSingle(Uri.fromFile(original)) }
            compose.waitUntil(30_000) { model.state.value.canChangeMetadata }
            compose.onNodeWithContentDescription("Edit").performClick()
            compose.waitUntil(120_000) { model.state.value.canEdit }
            compose.waitForIdle()
            compose.waitUntil(30_000) { model.state.value.canEdit }
            val shot = model.state.value.values
            assertTrue(shot.getValue("temperature") != 6500f || shot.getValue("tint") != 0f)
            compose.runOnIdle {
                model.setField("temperature", 6500f)
                model.setField("tint", 0f)
                model.setField("vibrance", 20f)
                model.setField("exposure", .7f)
                model.commitGesture()
            }
            compose.waitUntil(30_000) { !model.state.value.dirty && !model.state.value.saving }
            compose.runOnIdle { model.resetFields(listOf("temperature", "tint", "vibrance")) }
            fun awaitSaved() =
                compose.waitUntil(30_000) {
                    model.state.value.canEdit &&
                        !model.state.value.dirty &&
                        !model.state.value.saving
                }
            fun assertAsShot() {
                awaitSaved()
                assertEquals(
                    shot.getValue("temperature"),
                    model.state.value.values.getValue("temperature"),
                    .01f,
                )
                assertEquals(shot.getValue("tint"), model.state.value.values.getValue("tint"), .01f)
                assertEquals(.7f, model.state.value.values.getValue("exposure"), .001f)
                val saved = runBlocking {
                    model.library.loadSidecar(model.state.value.selected!!)
                }.document
                for (key in
                    listOf(
                        "crs:Temperature",
                        "crs:Tint",
                        "crs:WhiteBalance",
                        "papp:WbScaleVersion",
                        "papp:WbSource",
                    )) assertNull(key, saved.attribute(key))
                assertArrayEquals(bytes, original.readBytes())
            }
            assertAsShot()
            assertEquals(0f, model.state.value.values.getValue("vibrance"), .001f)
            compose.runOnIdle { model.undo() }
            awaitSaved()
            assertEquals(6500f, model.state.value.values.getValue("temperature"), .01f)
            assertEquals(20f, model.state.value.values.getValue("vibrance"), .001f)
            compose.runOnIdle { model.redo() }
            assertAsShot()
            compose.runOnIdle {
                model.setField("tint", 20f)
                model.commitGesture()
                model.resetField("temperature")
            }
            assertAsShot()
        } finally {
            original.delete()
        }
    }
}
