package app.justmaple.aperture.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.justmaple.aperture.MapleState
import app.justmaple.aperture.MapleViewModel
import app.justmaple.aperture.REPAIR_RADIUS_MAX
import app.justmaple.aperture.REPAIR_RADIUS_MIN
import app.justmaple.aperture.canHeal
import app.justmaple.aperture.data.RepairKind
import app.justmaple.aperture.removeRepair
import app.justmaple.aperture.repairSpots
import app.justmaple.aperture.resetRepairs
import app.justmaple.aperture.selectRepair
import app.justmaple.aperture.setRepairFeather
import app.justmaple.aperture.setRepairKind
import app.justmaple.aperture.setRepairOpacity
import app.justmaple.aperture.setRepairRadius
import app.justmaple.aperture.generated.LocalMaskControl
import kotlin.math.roundToInt

private val SIZE = LocalMaskControl("radius", "Size", REPAIR_RADIUS_MIN, REPAIR_RADIUS_MAX, .001f)
private val FEATHER = LocalMaskControl("feather", "Feather", 0f, 1f, .01f)
private val OPACITY = LocalMaskControl("opacity", "Opacity", 0f, 1f, .01f)

/**
 * The Heal tool's panel, the Android twin of Web's `RetouchPanelComponent` and Apple's Heal
 * panel: the brush (Heal / Clone, size, feather, opacity), which seeds the next spot and
 * rewrites the selected one, then the spot list with select / delete and Reset. The canvas
 * half is [HealOverlay].
 */
@Composable
internal fun HealPanel(model: MapleViewModel, state: MapleState, modifier: Modifier = Modifier) {
    val read = remember(state.document) { runCatching { model.repairSpots(state.document) } }
    val spots = read.getOrDefault(emptyList())
    val editable = state.canHeal && read.isSuccess
    val brush = state.healBrush
    Column(
        modifier.fillMaxWidth().testTag("editor-heal-section").semantics { contentDescription = "Heal" },
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (kind in RepairKind.entries) {
                val active = brush.kind == kind
                FilterChip(
                    active,
                    { model.setRepairKind(kind) },
                    { Text(kind.label, fontSize = 12.sp) },
                    Modifier.testTag("editor-heal-kind-${kind.wire}").semantics {
                        contentDescription = "${kind.label} mode"
                        selected = active
                    },
                    enabled = editable,
                )
            }
        }
        MaskSliderRow(SIZE, brush.radius, editable, "editor-heal-size", model::setRepairRadius, model::commitGesture)
        MaskSliderRow(FEATHER, brush.feather, editable, "editor-heal-feather", model::setRepairFeather, model::commitGesture)
        MaskSliderRow(OPACITY, brush.opacity, editable, "editor-heal-opacity", model::setRepairOpacity, model::commitGesture)
        (read.exceptionOrNull()?.let { "Repair spots could not be read: ${it.message}" } ?: state.healMessage)?.let {
            Text(it, Modifier.testTag("editor-heal-message"), color = MapleColors.error, fontSize = 12.sp)
        }
        if (spots.isEmpty())
            Text("No repair spots yet — tap the image to cover a blemish with pixels from somewhere else.",
                Modifier.testTag("editor-heal-empty"), color = MapleColors.muted, fontSize = 12.sp)
        else {
            Column(Modifier.testTag("editor-heal-list")) {
                spots.forEachIndexed { index, spot ->
                    MaskRow(repairSpotName(spot, index), "${(spot.opacity * 100).roundToInt()}%", state.healSelection == index,
                        editable, "editor-heal-row-$index", "editor-heal-delete-$index",
                        onSelect = { model.selectRepair(index) }, onDelete = { model.removeRepair(index) })
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(
                    model::resetRepairs,
                    Modifier.testTag("editor-heal-reset")
                        .semantics { contentDescription = "Remove every repair spot" },
                    enabled = editable,
                ) { Text("Reset") }
            }
        }
    }
}
