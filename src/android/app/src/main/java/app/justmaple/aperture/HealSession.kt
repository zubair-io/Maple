package app.justmaple.aperture

import app.justmaple.aperture.data.DEFAULT_REPAIR_FEATHER
import app.justmaple.aperture.data.DEFAULT_REPAIR_RADIUS
import app.justmaple.aperture.data.MaskPoint
import app.justmaple.aperture.data.RepairKind
import app.justmaple.aperture.data.RepairSpot
import app.justmaple.aperture.data.XmpDocument
import app.justmaple.aperture.data.parseRepairSpots
import app.justmaple.aperture.data.toJson
import app.justmaple.aperture.ui.defaultRepairSource
import app.justmaple.aperture.ui.uncroppedAspect
import org.json.JSONObject

/*
 * Clone / heal authoring (`docs/features.md` § Clone / heal brush), the Android twin of
 * Apple's `RetouchSession` and Web's `RetouchSessionService`. Spots are raw-core's reading
 * of the sidecar and every write is raw-core's canonical form, both through the renderer
 * seam. A placement, a mode change, a delete and Reset each commit one undo entry; a drag
 * (canvas handle or slider) opens one entry on its first movement and the caller commits it
 * on release; selection adds no history. Repair spots run in raw-core's decode product, so
 * the document change reloads the native model and its preparation re-decodes.
 */

/** The brush the panel edits: it seeds the next spot and rewrites the selected one. */
data class RepairBrush(
    val kind: RepairKind = RepairKind.Heal,
    val radius: Float = DEFAULT_REPAIR_RADIUS,
    val feather: Float = DEFAULT_REPAIR_FEATHER,
    val opacity: Float = 1f,
)

/** Brush size bounds as fractions of the frame width, Web's and Apple's range. */
const val REPAIR_RADIUS_MIN = .002f
const val REPAIR_RADIUS_MAX = .2f

/**
 * [document]'s repair containers for the codec. A list raw-core reads in the legacy sensor
 * frame carries the RAW's orientation, so the codec lists it upright and rewrites it upright
 * under the stamp every write adds (`docs/xmp-canonical-format.md` § "Frame stamp").
 */
private fun MapleViewModel.repairInput(document: XmpDocument): JSONObject {
    val input = document.repairInput()
    if (!document.repairsInSensorFrame) return input
    val current = state.value
    val frame = JSONObject().put("orientation", current.values.getValue("_orientation").toInt())
    return input.put("frame", frame.put("aspect", current.uncroppedAspect()))
}

/** raw-core's repair spots for [document]'s repair containers, over the upright image. */
fun MapleViewModel.repairSpots(document: XmpDocument = state.value.document): List<RepairSpot> =
    parseRepairSpots(renderer.readRepairs(repairInput(document).toString()))

/** The selected spot of [spots], if the selection still addresses one. */
fun MapleState.selectedRepair(spots: List<RepairSpot>): RepairSpot? = healSelection?.let(spots::getOrNull)

/** Repair spots are raster-restricted (`AdjustmentFields.rasterRestricted`): RAW sources only. */
val MapleState.canHeal: Boolean
    get() = canEdit && values["_raw"] == 1f

private fun MapleViewModel.writeSpots(commit: Boolean, transform: (List<RepairSpot>) -> List<RepairSpot>?): Boolean {
    val current = state.value
    if (!current.canHeal) return false
    val document = current.document
    val next =
        try {
            val spots = repairSpots(document)
            val edited = transform(spots)?.takeIf { it != spots } ?: return false
            val input = repairInput(document).put("spots", edited.toJson())
            val output = JSONObject(renderer.writeRepairs(input.toString()))
            // Spots Android does not list may still render: the stamp follows the written list.
            document.withRepairOutput(output, output.getBoolean("spots"))
        } catch (failure: Exception) {
            updateMaskState { it.copy(healMessage = "Could not write repair spots: ${failure.message}") }
            return false
        }
    updateMaskDocument(commit) { if (it == document) next else it }
    updateMaskState { it.copy(healMessage = null) }
    return true
}

/** One discrete command, one undo entry: any open drag closes first. */
private fun MapleViewModel.repairCommand(transform: (List<RepairSpot>) -> List<RepairSpot>?): Boolean {
    commitGesture()
    return writeSpots(commit = true, transform)
}

private fun MapleViewModel.editSelectedRepair(commit: Boolean, transform: (RepairSpot) -> RepairSpot) {
    val index = state.value.healSelection ?: return
    val edit: (List<RepairSpot>) -> List<RepairSpot>? = { spots ->
        spots.getOrNull(index)?.let { spot -> spots.toMutableList().also { it[index] = transform(spot) } }
    }
    if (commit) repairCommand(edit) else writeSpots(commit = false, edit)
}

private val RepairSpot.brush get() = RepairBrush(kind, radius, feather, opacity)

/** Selects a spot and loads it into the brush, so the panel describes what is on screen. */
fun MapleViewModel.selectRepair(index: Int?) {
    commitGesture()
    val spot = index?.let { runCatching { repairSpots().getOrNull(it) }.getOrNull() }
    updateMaskState { it.copy(healSelection = spot?.let { index }, healBrush = spot?.brush ?: it.healBrush) }
}

/** After undo/redo the brush describes the selected spot as the restored document has it. */
internal fun MapleViewModel.reloadSelectedRepair() {
    val index = state.value.healSelection ?: return
    val spot = runCatching { repairSpots().getOrNull(index) }.getOrNull() ?: return
    updateMaskState { it.copy(healBrush = spot.brush) }
}

/** Places a spot with the brush, centred on the full-frame [center], and selects it. */
fun MapleViewModel.placeRepair(center: MaskPoint): RepairSpot? {
    val brush = state.value.healBrush
    val at = MaskPoint(center.x.coerceIn(0f, 1f), center.y.coerceIn(0f, 1f))
    val spot =
        RepairSpot(brush.kind, at, defaultRepairSource(at, brush.radius), brush.radius, brush.feather, brush.opacity)
    var placed = -1
    if (!repairCommand { spots -> (spots + spot).also { placed = it.lastIndex } }) return null
    updateMaskState { it.copy(healSelection = placed) }
    return spot
}

/** A canvas drag of the selected spot: the caller commits the gesture on release. */
fun MapleViewModel.setRepairSpot(spot: RepairSpot) = editSelectedRepair(commit = false) { spot.copy(slot = it.slot) }

fun MapleViewModel.setRepairKind(kind: RepairKind) {
    updateMaskState { it.copy(healBrush = it.healBrush.copy(kind = kind)) }
    editSelectedRepair(commit = true) { it.copy(kind = kind) }
}

/** A slider drag; the slider commits the gesture on release. */
fun MapleViewModel.setRepairRadius(value: Float) {
    val radius = value.coerceIn(REPAIR_RADIUS_MIN, REPAIR_RADIUS_MAX)
    updateMaskState { it.copy(healBrush = it.healBrush.copy(radius = radius)) }
    editSelectedRepair(commit = false) { it.copy(radius = radius) }
}

fun MapleViewModel.setRepairFeather(value: Float) {
    val feather = value.coerceIn(0f, 1f)
    updateMaskState { it.copy(healBrush = it.healBrush.copy(feather = feather)) }
    editSelectedRepair(commit = false) { it.copy(feather = feather) }
}

fun MapleViewModel.setRepairOpacity(value: Float) {
    val opacity = value.coerceIn(0f, 1f)
    updateMaskState { it.copy(healBrush = it.healBrush.copy(opacity = opacity)) }
    editSelectedRepair(commit = false) { it.copy(opacity = opacity) }
}

fun MapleViewModel.removeRepair(index: Int) {
    var remaining = emptyList<RepairSpot>()
    val removed: (List<RepairSpot>) -> List<RepairSpot>? = { spots ->
        spots.takeIf { index in it.indices }?.filterIndexed { i, _ -> i != index }?.also { remaining = it }
    }
    if (!repairCommand(removed)) return
    updateMaskState {
        val selected = it.healSelection
        val next =
            when {
                remaining.isEmpty() || selected == null -> null
                selected > index -> selected - 1
                selected == index -> index.coerceAtMost(remaining.lastIndex)
                else -> selected
            }
        // A deleted selection hands over to a neighbour: the panel shows that spot's settings.
        val brush = if (selected == index && next != null) remaining[next].brush else it.healBrush
        it.copy(healSelection = next, healBrush = brush)
    }
}

/** Drops every spot Android lists: one undo entry. */
fun MapleViewModel.resetRepairs() {
    if (repairCommand { spots -> emptyList<RepairSpot>().takeIf { spots.isNotEmpty() } })
        updateMaskState { it.copy(healSelection = null) }
}
