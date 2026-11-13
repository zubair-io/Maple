package app.justmaple.aperture

import androidx.lifecycle.viewModelScope
import app.justmaple.aperture.data.LinearMask
import app.justmaple.aperture.data.MaskCombine
import app.justmaple.aperture.data.MaskComponent
import app.justmaple.aperture.data.MaskGroup
import app.justmaple.aperture.data.MaskLayer
import app.justmaple.aperture.data.MaskShape
import app.justmaple.aperture.data.RadialMask
import app.justmaple.aperture.data.XmpDocument
import app.justmaple.aperture.data.parseMaskLayers
import app.justmaple.aperture.data.toJson
import app.justmaple.aperture.generated.LocalMaskControls
import app.justmaple.aperture.ui.defaultLinearMask
import app.justmaple.aperture.ui.defaultRadialMask
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONObject

/*
 * Mask authoring (mask-panel.md, mask-overlay.md). Layers are raw-core's reading of
 * the sidecar and every write is raw-core's canonical form, both through the renderer
 * seam. Drags open one undo entry on their first movement and the caller commits it on
 * release; every discrete command commits its own entry; selection adds no history.
 */

/** raw-core's layers for [document]'s mask containers. */
fun MapleViewModel.maskLayers(document: XmpDocument = state.value.document): List<MaskLayer> =
    parseMaskLayers(renderer.readMasks(document.maskInput().toString()))

/** The selected layer of [layers], if the selection still addresses one. */
fun MapleState.selectedMask(layers: List<MaskLayer>): MaskLayer? = maskSelection?.let(layers::getOrNull)

/** The shape the canvas handles and feather address: the selected component of a group. */
fun MapleState.editedShape(layer: MaskLayer): MaskShape =
    when (val shape = layer.shape) {
        is MaskGroup -> shape.components[maskComponent.coerceIn(shape.components.indices)].shape
        else -> shape
    }

private fun MapleViewModel.writeLayers(commit: Boolean, transform: (List<MaskLayer>) -> List<MaskLayer>?): Boolean {
    val current = state.value
    if (!current.canEdit) return false
    val document = current.document
    val next =
        try {
            val layers = maskLayers(document)
            val edited = transform(layers)?.takeIf { it != layers } ?: return false
            val input = document.maskInput().put("layers", edited.toJson())
            document.withMaskOutput(JSONObject(renderer.writeMasks(input.toString())))
        } catch (failure: Exception) {
            updateMaskState { it.copy(maskMessage = "Could not write masks: ${failure.message}") }
            return false
        }
    updateMaskDocument(commit) { if (it == document) next else it }
    return true
}

/** One discrete command, one undo entry: any open drag closes first. */
private fun MapleViewModel.command(transform: (List<MaskLayer>) -> List<MaskLayer>?): Boolean {
    commitGesture()
    return writeLayers(commit = true, transform)
}

private fun MapleViewModel.editSelected(commit: Boolean, transform: (MaskLayer) -> MaskLayer) {
    val index = state.value.maskSelection ?: return
    val edit: (List<MaskLayer>) -> List<MaskLayer>? = { layers ->
        layers.getOrNull(index)?.let { layer -> layers.toMutableList().also { it[index] = transform(layer) } }
    }
    if (commit) command(edit) else writeLayers(commit = false, edit)
}

private fun MaskLayer.withEditedShape(component: Int, transform: (MaskShape) -> MaskShape): MaskLayer =
    when (val group = shape) {
        is MaskGroup -> {
            val index = component.coerceIn(group.components.indices)
            val parts = group.components.toMutableList()
            parts[index] = parts[index].copy(shape = transform(parts[index].shape))
            copy(shape = group.copy(components = parts))
        }
        else -> copy(shape = transform(shape))
    }

fun MapleViewModel.selectMaskLayer(index: Int?) {
    commitGesture()
    updateMaskState { it.copy(maskSelection = index, maskComponent = 0, maskPicking = false, maskMessage = null) }
}

fun MapleViewModel.addMaskLayer(radial: Boolean) {
    val aspect = state.value.values["_uncropped_aspect"] ?: 1f
    val shape = if (radial) defaultRadialMask(aspect) else defaultLinearMask()
    var added = -1
    if (command { layers -> (layers + MaskLayer(shape)).also { added = it.lastIndex } })
        updateMaskState { it.copy(maskSelection = added, maskComponent = 0, maskMessage = null) }
}

fun MapleViewModel.removeMaskLayer(index: Int) {
    var remaining = 0
    val removed: (List<MaskLayer>) -> List<MaskLayer>? = { layers ->
        layers.takeIf { index in it.indices }?.filterIndexed { i, _ -> i != index }?.also { remaining = it.size }
    }
    if (!command(removed))
        return
    updateMaskState {
        val selected = it.maskSelection
        it.copy(
            maskSelection = when {
                remaining == 0 || selected == null -> null
                selected > index -> selected - 1
                selected == index -> (index - 1).coerceAtLeast(0)
                else -> selected
            },
            maskComponent = if (selected == index) 0 else it.maskComponent,
            maskPicking = false,
        )
    }
}

/** A canvas handle drag: the caller commits the gesture on release. */
fun MapleViewModel.setMaskShape(shape: MaskShape) {
    val component = state.value.maskComponent
    editSelected(commit = false) { layer -> layer.withEditedShape(component) { shape } }
}

fun MapleViewModel.setMaskFeather(value: Float) {
    val component = state.value.maskComponent
    val feather = value.coerceIn(0f, 1f)
    editSelected(commit = false) { layer ->
        layer.withEditedShape(component) {
            when (it) {
                is LinearMask -> it.copy(feather = feather)
                is RadialMask -> it.copy(feather = feather)
                is MaskGroup -> it
            }
        }
    }
}

/** A radial layer's own inversion, or a group's final inversion. */
fun MapleViewModel.setMaskInverted(invert: Boolean) =
    editSelected(commit = true) { layer ->
        when (val shape = layer.shape) {
            is RadialMask -> layer.copy(shape = shape.copy(invert = invert))
            is MaskGroup -> layer.copy(shape = shape.copy(invert = invert))
            is LinearMask -> layer
        }
    }

fun MapleViewModel.setMaskOpacity(value: Float) =
    editSelected(commit = false) { layer ->
        (layer.shape as? MaskGroup)?.let { layer.copy(shape = it.copy(opacity = value.coerceIn(0f, 1f))) } ?: layer
    }

/** A slider drag; zero clears the control, so an untouched control stays unset. */
fun MapleViewModel.setMaskAdjustment(name: String, value: Float) {
    val control = LocalMaskControls.adjustments.firstOrNull { it.name == name } ?: return
    val next = value.coerceIn(control.minimum, control.maximum)
    editSelected(commit = false) { layer ->
        layer.copy(adjustments = if (next == 0f) layer.adjustments - name else layer.adjustments + (name to next))
    }
}

fun MapleViewModel.resetMaskAdjustments() = editSelected(commit = true) { it.copy(adjustments = emptyMap()) }

fun MapleViewModel.setMaskRangeEnabled(enabled: Boolean) {
    editSelected(commit = true) { layer ->
        layer.copy(range = if (!enabled) null else layer.range ?: LocalMaskControls.defaultRange)
    }
    if (!enabled) updateMaskState { it.copy(maskPicking = false) }
}

fun MapleViewModel.setMaskRangeField(name: String, value: Float) {
    val control = LocalMaskControls.range.firstOrNull { it.name == name } ?: return
    editSelected(commit = false) { layer ->
        layer.range?.let { layer.copy(range = it + (name to value.coerceIn(control.minimum, control.maximum))) } ?: layer
    }
}

fun MapleViewModel.addMaskComponent(radial: Boolean, combine: MaskCombine) {
    val aspect = state.value.values["_uncropped_aspect"] ?: 1f
    val shape = if (radial) defaultRadialMask(aspect) else defaultLinearMask()
    var component = 0
    editSelected(commit = true) { layer ->
        val group =
            layer.shape as? MaskGroup
                ?: MaskGroup(listOf(MaskComponent(layer.shape, MaskCombine.Add, false, layer.slot?.let { 0 })), 1f, false)
        component = group.components.size
        layer.copy(shape = group.copy(components = group.components + MaskComponent(shape, combine, false)))
    }
    updateMaskState { it.copy(maskComponent = component) }
}

fun MapleViewModel.selectMaskComponent(index: Int) {
    commitGesture()
    updateMaskState { it.copy(maskComponent = index) }
}

/** Edits the component the panel shows: a selection past the group (after an undo) is clamped, as there. */
private fun MapleViewModel.editComponent(transform: (MaskComponent) -> MaskComponent) {
    val component = state.value.maskComponent
    editSelected(commit = true) { layer ->
        val group = layer.shape as? MaskGroup ?: return@editSelected layer
        val index = component.coerceIn(group.components.indices)
        val parts = group.components.toMutableList()
        parts[index] = transform(parts[index])
        layer.copy(shape = group.copy(components = parts))
    }
}

fun MapleViewModel.setMaskComponentCombine(combine: MaskCombine) = editComponent { it.copy(combine = combine) }

fun MapleViewModel.setMaskComponentInverted(invert: Boolean) = editComponent { it.copy(invert = invert) }

/** The last component goes only with its layer. */
fun MapleViewModel.removeMaskComponent(index: Int) {
    var removed = false
    editSelected(commit = true) { layer ->
        val group = layer.shape as? MaskGroup ?: return@editSelected layer
        if (group.components.size <= 1 || index !in group.components.indices) layer
        else layer.copy(shape = group.copy(components = group.components.filterIndexed { i, _ -> i != index }))
            .also { removed = true }
    }
    if (removed) updateMaskState {
        val selected = it.maskComponent
        it.copy(maskComponent = if (selected >= index) (selected - 1).coerceAtLeast(0) else selected)
    }
}

fun MapleViewModel.armMaskPick(armed: Boolean) {
    updateMaskState { it.copy(maskPicking = armed && it.values["_raw"] == 1f, maskMessage = null) }
}

/**
 * Seeds the selected layer's colour range from raw-core's sample at the full-frame
 * point: one undo entry. A refused pick leaves the layer alone and replaces only the
 * panel's message line. A sample lands only on the edit it was developed under: any edit
 * meanwhile (a global adjustment, or a deleted or reordered layer moving what the selection
 * addresses) drops it.
 */
fun MapleViewModel.sampleMaskRangeAt(x: Float, y: Float) {
    val current = state.value
    val selection = current.maskSelection ?: return
    if (!current.canEdit || current.maskSampling) return
    val token = editGeneration
    val xml = current.document.serialize()
    updateMaskState { it.copy(maskPicking = false, maskSampling = true, maskMessage = null) }
    viewModelScope.launch {
        try {
            val result = JSONObject(renderer.sampleMaskRange(xml, x, y))
            if (token != editGeneration || state.value.maskSelection != selection) return@launch
            // A save swaps in the reparsed document, which serializes to the same edit.
            if (state.value.document.serialize() != xml) {
                updateMaskState { it.copy(maskMessage = "The photo changed while sampling. Pick the colour again.") }
                return@launch
            }
            val seed = result.optJSONObject("seed")
            if (seed == null) {
                updateMaskState { it.copy(maskMessage = result.optString("refused", "No colour to sample here")) }
                return@launch
            }
            val values = seed.keys().asSequence().associateWith { seed.getDouble(it).toFloat() }
            editSelected(commit = true) { layer ->
                layer.copy(range = (layer.range ?: LocalMaskControls.defaultRange) + values)
            }
        } catch (failure: Exception) {
            if (failure is CancellationException) throw failure
            if (token == editGeneration) updateMaskState { it.copy(maskMessage = "Could not sample a colour: ${failure.message}") }
        } finally {
            updateMaskState { it.copy(maskSampling = false) }
        }
    }
}
