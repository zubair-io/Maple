package app.justmaple.aperture.ui

import android.view.KeyEvent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.staticCompositionLocalOf
import app.justmaple.aperture.MapleViewModel
import app.justmaple.aperture.PhotoMode

internal sealed interface PhotoKeyCommand {
    data class Rate(val stars: Int) : PhotoKeyCommand
    data class Flag(val value: String?) : PhotoKeyCommand
    data object Undo : PhotoKeyCommand
    data object Redo : PhotoKeyCommand
    data class Zoom(val command: CanvasZoomCommand) : PhotoKeyCommand
    data object ResetVisibleGroup : PhotoKeyCommand
}

/**
 * What the composed photo surface offers the keyboard: the visible canvas's zoom (unset while
 * the crop tool holds it at fit) and the editor group on screen. The activity owns one.
 */
internal class PhotoKeyTargets {
    internal var zoom: ((CanvasZoomCommand) -> Unit)? = null
    internal var visibleGroup: EditorGroup? = null
}

internal val LocalPhotoKeyTargets = staticCompositionLocalOf { PhotoKeyTargets() }

/**
 * Offers [zoomState] to the keyboard while this canvas is composed; [locked] (the crop tool)
 * withdraws it. Image and viewport sizes are read when the key arrives, as a gesture reads them.
 */
@Composable
internal fun CanvasZoomKeys(
    zoomState: CanvasZoomState,
    locked: Boolean,
    imageDimensions: () -> Pair<Int, Int>,
    viewportWidth: Float,
    viewportHeight: Float,
) {
    val targets = LocalPhotoKeyTargets.current
    val image by rememberUpdatedState(imageDimensions)
    val viewport by rememberUpdatedState(viewportWidth to viewportHeight)
    DisposableEffect(targets, zoomState, locked) {
        val zoom: ((CanvasZoomCommand) -> Unit)? =
            if (locked) null
            else { command ->
                val (width, height) = image()
                zoomState.command(command, width, height, viewport.first, viewport.second)
            }
        targets.zoom = zoom
        onDispose { if (targets.zoom === zoom) targets.zoom = null }
    }
}

/** Offers [group] to ⌘/Ctrl+Shift+R while the editor shows it. */
@Composable
internal fun VisibleGroupKeys(group: EditorGroup?) {
    val targets = LocalPhotoKeyTargets.current
    DisposableEffect(targets, group) {
        targets.visibleGroup = group
        onDispose { if (targets.visibleGroup == group) targets.visibleGroup = null }
    }
}

/**
 * The culling keys shared with Apple, web and Windows, ⌘/Ctrl+Z and ⌘/Ctrl+Shift+Z, the zoom
 * keys of `docs/zoom.md`, and R or ⌘/Ctrl+Shift+R (Apple's Reset Visible Group; web's R).
 */
internal fun photoKeyCommand(event: KeyEvent): PhotoKeyCommand? {
    if (event.action != KeyEvent.ACTION_DOWN || event.isAltPressed) return null
    if (event.isCtrlPressed || event.isMetaPressed) return commandKey(event.keyCode, event.isShiftPressed)
    if (event.isShiftPressed) return null
    return when (event.keyCode) {
        in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_5 -> PhotoKeyCommand.Rate(event.keyCode - KeyEvent.KEYCODE_0)
        in KeyEvent.KEYCODE_NUMPAD_0..KeyEvent.KEYCODE_NUMPAD_5 ->
            PhotoKeyCommand.Rate(event.keyCode - KeyEvent.KEYCODE_NUMPAD_0)
        KeyEvent.KEYCODE_P -> PhotoKeyCommand.Flag("pick")
        KeyEvent.KEYCODE_X -> PhotoKeyCommand.Flag("reject")
        KeyEvent.KEYCODE_U -> PhotoKeyCommand.Flag(null)
        KeyEvent.KEYCODE_F -> PhotoKeyCommand.Zoom(CanvasZoomCommand.Fit)
        KeyEvent.KEYCODE_Z -> PhotoKeyCommand.Zoom(CanvasZoomCommand.ActualSize)
        KeyEvent.KEYCODE_R -> PhotoKeyCommand.ResetVisibleGroup
        else -> null
    }
}

/** ⌘/Ctrl shortcuts; `+` is Shift+`=` on most layouts, so zoom in takes either. */
private fun commandKey(keyCode: Int, shift: Boolean): PhotoKeyCommand? =
    when (keyCode) {
        KeyEvent.KEYCODE_Z -> if (shift) PhotoKeyCommand.Redo else PhotoKeyCommand.Undo
        KeyEvent.KEYCODE_R -> PhotoKeyCommand.ResetVisibleGroup.takeIf { shift }
        KeyEvent.KEYCODE_EQUALS, KeyEvent.KEYCODE_PLUS, KeyEvent.KEYCODE_NUMPAD_ADD ->
            PhotoKeyCommand.Zoom(CanvasZoomCommand.ZoomIn)
        else ->
            if (shift) null
            else when (keyCode) {
                KeyEvent.KEYCODE_0, KeyEvent.KEYCODE_NUMPAD_0 -> PhotoKeyCommand.Zoom(CanvasZoomCommand.Fit)
                KeyEvent.KEYCODE_1, KeyEvent.KEYCODE_NUMPAD_1 ->
                    PhotoKeyCommand.Zoom(CanvasZoomCommand.ActualSize)
                KeyEvent.KEYCODE_MINUS, KeyEvent.KEYCODE_NUMPAD_SUBTRACT ->
                    PhotoKeyCommand.Zoom(CanvasZoomCommand.ZoomOut)
                else -> null
            }
    }

internal fun MapleViewModel.handlePhotoKey(event: KeyEvent, targets: PhotoKeyTargets): Boolean {
    val command = photoKeyCommand(event) ?: return false
    val current = state.value
    if (current.mode == PhotoMode.Browse || current.selected == null) return false
    when (command) {
        is PhotoKeyCommand.Rate -> attribute("xmp:Rating", command.stars.takeIf { it > 0 }?.toString())
        is PhotoKeyCommand.Flag -> attribute("papp:Flag", command.value)
        PhotoKeyCommand.Undo -> undo()
        PhotoKeyCommand.Redo -> redo()
        is PhotoKeyCommand.Zoom -> targets.zoom?.invoke(command.command) ?: return false
        PhotoKeyCommand.ResetVisibleGroup -> {
            val group = targets.visibleGroup
            if (current.mode != PhotoMode.Edit || group == null) return false
            resetGroup(group)
        }
    }
    return true
}
