package app.justmaple.aperture.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.justmaple.aperture.*
import app.justmaple.aperture.data.LinearMask
import app.justmaple.aperture.data.MaskGroup
import app.justmaple.aperture.data.MaskLayer
import app.justmaple.aperture.data.MaskShape
import app.justmaple.aperture.data.RadialMask
import app.justmaple.aperture.generated.AdjustmentField
import app.justmaple.aperture.generated.LocalMaskControl
import app.justmaple.aperture.generated.LocalMaskControls

private val FEATHER = LocalMaskControl("feather", "Feather", 0f, 1f, .01f)
private val OPACITY = LocalMaskControl("opacity", "Opacity", 0f, 1f, .01f)

internal fun shapeName(shape: MaskShape) =
    when (shape) {
        is LinearMask -> "Linear"
        is RadialMask -> "Radial"
        is MaskGroup -> "Mask group"
    }

internal fun maskLayerName(layer: MaskLayer, index: Int) = "${shapeName(layer.shape)} ${index + 1}"

/** `luminance_noise` → `luminanceNoise`, the identifier spelling Apple's panel uses. */
internal fun camel(name: String) =
    name.split('_').mapIndexed { i, part -> if (i == 0) part else part.replaceFirstChar(Char::uppercaseChar) }.joinToString("")

private fun subtitle(layer: MaskLayer): String? {
    val inverted = (layer.shape as? RadialMask)?.invert == true || (layer.shape as? MaskGroup)?.invert == true
    val parts = listOfNotNull("inverted".takeIf { inverted }, "${layer.edited} edited".takeIf { layer.edited > 0 })
    return parts.joinToString(" · ").ifEmpty { null }
}

/**
 * The Mask tool's panel (`mask-panel.md`): layers with add / select / delete, then the
 * selected layer's composition, shape, local controls, colour range and Reset.
 */
@Composable
internal fun MaskPanel(model: MapleViewModel, state: MapleState, modifier: Modifier = Modifier) {
    val read = remember(state.document) { runCatching { model.maskLayers(state.document) } }
    val layers = read.getOrDefault(emptyList())
    val selected = state.selectedMask(layers)
    val editable = state.canEdit && read.isSuccess
    DisposableEffect(model) { onDispose { model.armMaskPick(false) } }
    Column(
        modifier.fillMaxWidth().testTag("editor-mask-section").semantics { contentDescription = "Masks" },
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MaskButton("Linear", "Add linear mask", "editor-mask-add-linear", editable, Icons.Outlined.Add) {
                model.addMaskLayer(radial = false)
            }
            MaskButton("Radial", "Add radial mask", "editor-mask-add-radial", editable, Icons.Outlined.Add) {
                model.addMaskLayer(radial = true)
            }
        }
        read.exceptionOrNull()?.let {
            Text("Masks could not be read: ${it.message}", Modifier.testTag("editor-mask-message"),
                color = MapleColors.error, fontSize = 12.sp)
        }
        if (layers.isEmpty())
            Text("No masks yet — add a linear or radial mask to edit part of the image.",
                Modifier.testTag("editor-mask-empty"), color = MapleColors.muted, fontSize = 12.sp)
        else
            Column(Modifier.testTag("editor-mask-list")) {
                layers.forEachIndexed { index, layer ->
                    MaskRow(maskLayerName(layer, index), subtitle(layer), state.maskSelection == index, editable,
                        "editor-mask-row-$index", "editor-mask-delete-$index",
                        onSelect = { model.selectMaskLayer(index) }, onDelete = { model.removeMaskLayer(index) })
                }
            }
        if (selected != null) MaskLayerControls(model, state, selected, editable)
    }
}

@Composable
private fun MaskLayerControls(model: MapleViewModel, state: MapleState, layer: MaskLayer, editable: Boolean) {
    MaskComposition(model, state, layer, editable)
    val group = layer.shape as? MaskGroup
    if (group != null)
        MaskSliderRow(OPACITY, group.opacity, editable, "editor-mask-opacity", model::setMaskOpacity, model::commitGesture)
    MaskSliderRow(FEATHER, state.editedShape(layer).feather, editable, "editor-mask-feather", model::setMaskFeather,
        model::commitGesture)
    (layer.shape as? RadialMask)?.let { radial ->
        MaskSwitch("Invert", radial.invert, editable, "editor-mask-invert") { model.setMaskInverted(it) }
    }
    for (control in LocalMaskControls.adjustments)
        MaskSliderRow(control, layer.adjustments[control.name] ?: 0f, editable, "editor-mask-slider-${camel(control.name)}",
            { model.setMaskAdjustment(control.name, it) }, model::commitGesture)
    MaskRangeSection(model, state, layer, editable)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        TextButton(
            model::resetMaskAdjustments,
            Modifier.testTag("editor-mask-reset").semantics { contentDescription = "Reset mask adjustments" },
            enabled = editable && layer.adjustments.isNotEmpty(),
        ) { Text("Reset") }
    }
}

@Composable
internal fun MaskButton(
    text: String,
    label: String,
    tag: String,
    enabled: Boolean,
    icon: androidx.compose.ui.graphics.vector.ImageVector? = null,
    onClick: () -> Unit,
) {
    TextButton(onClick, Modifier.testTag(tag).semantics { contentDescription = label }, enabled = enabled) {
        if (icon != null) Icon(icon, null, Modifier.size(16.dp))
        Text(text, fontSize = 12.sp)
    }
}

/** A List Row: active fill and a primary left border when selected, trailing delete. */
@Composable
internal fun MaskRow(
    title: String,
    subtitle: String?,
    active: Boolean,
    enabled: Boolean,
    tag: String,
    deleteTag: String,
    deleteEnabled: Boolean = enabled,
    deleteLabel: String = "Delete $title",
    onSelect: () -> Unit,
    onDelete: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(6.dp))
            .background(if (active) MapleColors.raised else MapleColors.surface)
            .then(if (active) Modifier.border(.5.dp, MapleColors.primary, RoundedCornerShape(6.dp)) else Modifier),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(2.dp).height(44.dp).background(if (active) MapleColors.primary else MapleColors.surface))
        Column(
            Modifier.weight(1f)
                .clickable(enabled = enabled, role = Role.Button, onClick = onSelect)
                .padding(horizontal = 10.dp, vertical = 6.dp)
                .testTag(tag)
                .semantics(mergeDescendants = true) {
                    contentDescription = title
                    selected = active
                    subtitle?.let { stateDescription = it }
                },
        ) {
            Text(title, fontSize = 13.sp)
            subtitle?.let { Text(it, color = MapleColors.muted, fontSize = 11.sp) }
        }
        androidx.compose.material3.IconButton(
            onDelete,
            Modifier.testTag(deleteTag).semantics { contentDescription = deleteLabel },
            enabled = deleteEnabled,
        ) { Icon(Icons.Outlined.Delete, null, Modifier.size(18.dp)) }
    }
}

@Composable
internal fun MaskSwitch(label: String, checked: Boolean, enabled: Boolean, tag: String, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f), fontSize = 13.sp)
        Switch(checked, onChange, Modifier.testTag(tag).semantics { contentDescription = label }, enabled = enabled)
    }
}

/** A Living Slider over a raw-core domain: one undo entry per drag, closed on release. */
@Composable
internal fun MaskSliderRow(
    control: LocalMaskControl,
    value: Float,
    enabled: Boolean,
    tag: String,
    onChange: (Float) -> Unit,
    onCommit: () -> Unit,
) {
    val field = remember(control) { AdjustmentField(-1, control.name, control.minimum, control.maximum, 0f, "", true) }
    Column(Modifier.fillMaxWidth().testTag(tag)) {
        Row(Modifier.padding(horizontal = 4.dp)) {
            Text(control.label, Modifier.weight(1f), fontSize = 12.sp)
            Text(
                if (control.step < 1f) String.format(java.util.Locale.ROOT, "%.2f", value) else value.toInt().toString(),
                color = MapleColors.muted,
                fontFamily = FontFamily.Monospace,
                fontSize = 11.sp,
            )
        }
        AdjustmentSlider(field, value, enabled, onChange, onCommit, description = control.label)
    }
}
