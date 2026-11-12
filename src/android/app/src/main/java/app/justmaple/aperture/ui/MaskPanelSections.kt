package app.justmaple.aperture.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Colorize
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.justmaple.aperture.*
import app.justmaple.aperture.data.MaskCombine
import app.justmaple.aperture.data.MaskGroup
import app.justmaple.aperture.data.MaskLayer
import app.justmaple.aperture.generated.LocalMaskControls
import kotlin.math.roundToInt

/** Ordered compositions (#3408): add components, then select, combine, invert or delete them. */
@Composable
internal fun MaskComposition(model: MapleViewModel, state: MapleState, layer: MaskLayer, editable: Boolean) {
    Column(Modifier.fillMaxWidth().testTag("editor-mask-composition"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        for (combine in MaskCombine.entries)
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                for (radial in listOf(false, true)) {
                    val kind = if (radial) "radial" else "linear"
                    MaskButton(
                        "${combine.label} $kind",
                        "${combine.label} $kind component",
                        "editor-mask-${combine.name.lowercase()}-$kind-component",
                        editable,
                    ) { model.addMaskComponent(radial, combine) }
                }
            }
        val group = layer.shape as? MaskGroup ?: return@Column
        val selected = state.maskComponent.coerceIn(group.components.indices)
        Column(Modifier.testTag("editor-mask-components")) {
            group.components.forEachIndexed { index, component ->
                val title = "${shapeName(component.shape)} ${index + 1}"
                val operation = component.combine.label + if (component.invert) " · inverted" else ""
                MaskRow(
                    title,
                    operation,
                    index == selected,
                    editable,
                    "editor-mask-component-$index",
                    "editor-mask-component-delete-$index",
                    deleteEnabled = editable && group.components.size > 1,
                    deleteLabel = "Delete $title component",
                    onSelect = { model.selectMaskComponent(index) },
                    onDelete = { model.removeMaskComponent(index) },
                )
            }
        }
        val component = group.components[selected]
        Row(Modifier.testTag("editor-mask-component-combine"), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            for (combine in MaskCombine.entries)
                FilterChip(
                    component.combine == combine,
                    { if (component.combine != combine) model.setMaskComponentCombine(combine) },
                    { Text(combine.label, fontSize = 12.sp) },
                    Modifier.testTag("editor-mask-component-combine-${combine.name.lowercase()}")
                        .semantics { contentDescription = "Set component to ${combine.label}" },
                    enabled = editable,
                )
        }
        MaskSwitch("Invert component", component.invert, editable, "editor-mask-component-invert") {
            model.setMaskComponentInverted(it)
        }
        MaskSwitch("Invert mask", group.invert, editable, "editor-mask-group-invert") { model.setMaskInverted(it) }
    }
}

/** The band centre as people read a hue wheel: `[0, 360)`, not atan2's `(-180, 180]`. */
internal fun displayHue(hueDeg: Float): Int = (((hueDeg % 360f) + 360f) % 360f).roundToInt() % 360

/** Colour range (#362): enable, band centre, eyedropper, message line and five coordinates. */
@Composable
internal fun MaskRangeSection(model: MapleViewModel, state: MapleState, layer: MaskLayer, editable: Boolean) {
    val range = layer.range
    val raw = state.values["_raw"] == 1f
    Column(Modifier.fillMaxWidth().testTag("editor-mask-range-section"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) {
                MaskSwitch("Colour range", range != null, editable, "editor-mask-range-toggle") {
                    model.setMaskRangeEnabled(it)
                }
            }
            if (range != null) {
                Text("Hue ${displayHue(range["hue_deg"] ?: 0f)}°", Modifier.testTag("editor-mask-range-hue"),
                    color = MapleColors.muted, fontSize = 12.sp)
                IconButton(
                    { model.armMaskPick(!state.maskPicking) },
                    Modifier.testTag("editor-mask-range-eyedropper")
                        .semantics { contentDescription = "Sample a colour for the range" },
                    enabled = editable && raw && !state.maskSampling,
                ) {
                    Icon(Icons.Outlined.Colorize, null,
                        tint = if (state.maskPicking) MapleColors.primary else MapleColors.text)
                }
            }
        }
        if (range != null && !raw)
            Text("The eyedropper samples RAW photos only.", color = MapleColors.muted, fontSize = 11.sp)
        val message = when {
            state.maskSampling -> "Sampling…"
            state.maskPicking -> "Tap the photo to pick a colour."
            else -> state.maskMessage
        }
        message?.let { Text(it, Modifier.testTag("editor-mask-range-message"), color = MapleColors.muted, fontSize = 12.sp) }
        if (range != null)
            for (control in LocalMaskControls.range)
                MaskSliderRow(control, range[control.name] ?: control.minimum, editable,
                    "editor-mask-range-slider-${camel(control.name)}", { model.setMaskRangeField(control.name, it) },
                    model::commitGesture)
    }
}
