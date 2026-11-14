package app.justmaple.aperture.ui

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PhotoKeyCommandsTest {
    private fun key(code: Int, meta: Int = 0, action: Int = KeyEvent.ACTION_DOWN) =
        photoKeyCommand(KeyEvent(0, 0, action, code, 0, meta))

    @Test
    fun cullingKeysSetTheRatingAndFlagWithoutModifiers() {
        for (stars in 0..5) {
            assertEquals(PhotoKeyCommand.Rate(stars), key(KeyEvent.KEYCODE_0 + stars))
            assertEquals(PhotoKeyCommand.Rate(stars), key(KeyEvent.KEYCODE_NUMPAD_0 + stars))
        }
        assertEquals(PhotoKeyCommand.Flag("pick"), key(KeyEvent.KEYCODE_P))
        assertEquals(PhotoKeyCommand.Flag("reject"), key(KeyEvent.KEYCODE_X))
        assertEquals(PhotoKeyCommand.Flag(null), key(KeyEvent.KEYCODE_U))
        assertNull(key(KeyEvent.KEYCODE_6))
        assertNull(key(KeyEvent.KEYCODE_NUMPAD_6))
        assertNull(key(KeyEvent.KEYCODE_R))
        assertNull(key(KeyEvent.KEYCODE_P, KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON))
        assertNull(key(KeyEvent.KEYCODE_3, KeyEvent.META_ALT_ON or KeyEvent.META_ALT_LEFT_ON))
        assertNull(key(KeyEvent.KEYCODE_P, KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON))
        assertNull(key(KeyEvent.KEYCODE_P, action = KeyEvent.ACTION_UP))
    }

    @Test
    fun commandZUndoesAndCommandShiftZRedoesWithCtrlOrMeta() {
        val ctrl = KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON
        val meta = KeyEvent.META_META_ON or KeyEvent.META_META_LEFT_ON
        val shift = KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON
        for (modifier in listOf(ctrl, meta)) {
            assertEquals(PhotoKeyCommand.Undo, key(KeyEvent.KEYCODE_Z, modifier))
            assertEquals(PhotoKeyCommand.Redo, key(KeyEvent.KEYCODE_Z, modifier or shift))
        }
        assertNull(key(KeyEvent.KEYCODE_Z))
        assertNull(key(KeyEvent.KEYCODE_Y, ctrl))
        assertNull(key(KeyEvent.KEYCODE_Z, ctrl or KeyEvent.META_ALT_ON or KeyEvent.META_ALT_LEFT_ON))
    }
}
