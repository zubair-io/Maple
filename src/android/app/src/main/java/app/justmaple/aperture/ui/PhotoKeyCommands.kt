package app.justmaple.aperture.ui

import android.view.KeyEvent
import app.justmaple.aperture.MapleViewModel
import app.justmaple.aperture.PhotoMode

internal sealed interface PhotoKeyCommand {
    data class Rate(val stars: Int) : PhotoKeyCommand
    data class Flag(val value: String?) : PhotoKeyCommand
    data object Undo : PhotoKeyCommand
    data object Redo : PhotoKeyCommand
}

/** The culling keys shared with Apple, web and Windows, plus ⌘/Ctrl+Z and ⌘/Ctrl+Shift+Z. */
internal fun photoKeyCommand(event: KeyEvent): PhotoKeyCommand? {
    if (event.action != KeyEvent.ACTION_DOWN || event.isAltPressed) return null
    val command = event.isCtrlPressed || event.isMetaPressed
    if (command) {
        return when {
            event.keyCode != KeyEvent.KEYCODE_Z -> null
            event.isShiftPressed -> PhotoKeyCommand.Redo
            else -> PhotoKeyCommand.Undo
        }
    }
    if (event.isShiftPressed) return null
    return when (event.keyCode) {
        in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_5 -> PhotoKeyCommand.Rate(event.keyCode - KeyEvent.KEYCODE_0)
        in KeyEvent.KEYCODE_NUMPAD_0..KeyEvent.KEYCODE_NUMPAD_5 ->
            PhotoKeyCommand.Rate(event.keyCode - KeyEvent.KEYCODE_NUMPAD_0)
        KeyEvent.KEYCODE_P -> PhotoKeyCommand.Flag("pick")
        KeyEvent.KEYCODE_X -> PhotoKeyCommand.Flag("reject")
        KeyEvent.KEYCODE_U -> PhotoKeyCommand.Flag(null)
        else -> null
    }
}

/** Applies [event] to the open photo; Browse has no keyboard target until it has a selection. */
internal fun MapleViewModel.handlePhotoKey(event: KeyEvent): Boolean {
    val command = photoKeyCommand(event) ?: return false
    if (state.value.mode == PhotoMode.Browse || state.value.selected == null) return false
    when (command) {
        is PhotoKeyCommand.Rate -> attribute("xmp:Rating", command.stars.takeIf { it > 0 }?.toString())
        is PhotoKeyCommand.Flag -> attribute("papp:Flag", command.value)
        PhotoKeyCommand.Undo -> undo()
        PhotoKeyCommand.Redo -> redo()
    }
    return true
}
