package app.justmaple.aperture

import android.app.Instrumentation
import android.os.SystemClock
import android.view.KeyEvent

internal const val CTRL = KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON
internal const val SHIFT = KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON

/** One hardware key press through the window, with its modifier keys held down around it. */
internal fun Instrumentation.press(code: Int, meta: Int = 0) {
    val modifiers = buildList {
        if (meta and KeyEvent.META_CTRL_ON != 0) add(KeyEvent.KEYCODE_CTRL_LEFT)
        if (meta and KeyEvent.META_META_ON != 0) add(KeyEvent.KEYCODE_META_LEFT)
        if (meta and KeyEvent.META_SHIFT_ON != 0) add(KeyEvent.KEYCODE_SHIFT_LEFT)
    }
    modifiers.forEach { sendKeySync(KeyEvent(KeyEvent.ACTION_DOWN, it)) }
    try {
        val now = SystemClock.uptimeMillis()
        sendKeySync(KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0, meta))
        sendKeySync(KeyEvent(now, now, KeyEvent.ACTION_UP, code, 0, meta))
    } finally {
        modifiers.asReversed().forEach { sendKeySync(KeyEvent(KeyEvent.ACTION_UP, it)) }
    }
    waitForIdleSync()
}
