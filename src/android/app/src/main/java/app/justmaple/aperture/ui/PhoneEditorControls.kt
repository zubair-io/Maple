package app.justmaple.aperture.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.justmaple.aperture.MapleState
import app.justmaple.aperture.MapleViewModel

@Composable
internal fun PhoneEditorControls(
    model: MapleViewModel,
    state: MapleState,
    group: EditorGroup,
    armed: String,
    onGroup: (EditorGroup) -> Unit,
    onArmed: (String) -> Unit,
    onMore: () -> Unit,
    activeSubTool: String? = null,
    onSubToolChange: ((String) -> Unit)? = null,
) {
    val subTools = remember(group) { subToolsFor(group) }
    var internalSubTool by remember(group) { mutableStateOf(subTools.first().id) }
    val subTool = activeSubTool ?: internalSubTool
    var band by remember(group) { mutableStateOf(HslBand.Red) }
    fun sliderFields(tool: String) =
        if (group == EditorGroup.Color && tool == "hsl") hslBandFields(band)
        else fieldsForSubTool(group, tool)
    val setSubTool: (String) -> Unit = { nextSubTool ->
        internalSubTool = nextSubTool
        onSubToolChange?.invoke(nextSubTool)
        onArmed(sliderFields(nextSubTool).firstOrNull(state::supportsField)?.name.orEmpty())
    }
    val dockFields = sliderFields(subTool).filter(state::supportsField)
    val field = dockFields.firstOrNull { it.name == armed } ?: dockFields.firstOrNull()
    LaunchedEffect(field?.name, armed) {
        val next = field?.name.orEmpty()
        if (next != armed) onArmed(next)
    }
    Column(Modifier.fillMaxWidth()) {
        if (field != null) DragBar(
            field,
            state.values[field.name] ?: field.initial,
            { model.setField(field.name, it) },
            model::commitGesture,
            { model.resetField(field.name) },
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
            for (next in EditorGroup.entries) TextButton(
                {
                    onGroup(next)
                },
                Modifier.weight(1f),
            ) {
                Text(
                    next.label,
                    color = if (group == next) MapleColors.primary else MapleColors.muted,
                )
            }
        }
        if (subTools.size > 1)
            SubToolSelector(
                subTools,
                subTool,
                setSubTool,
                Modifier.padding(horizontal = 8.dp),
            )
        if (group == EditorGroup.Color && subTool == "wb")
            WbPresetChips(
                wbPresets,
                model::applyWbPreset,
                state,
                Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            )
        if (group == EditorGroup.Color && subTool == "hsl")
            HslBandChips(
                band,
                { nextBand ->
                    band = nextBand
                    hslBandFields(nextBand).firstOrNull(state::supportsField)?.let {
                        onArmed(it.name)
                    }
                },
                Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            )
        if (group == EditorGroup.Effects && subTool == "presets")
            BuiltInPresetsRow(
                model,
                state,
                Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            )
        if (group == EditorGroup.Detail && subTool == "crop")
            CropControlsSection(model, state, Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
        if (dockFields.isNotEmpty()) LazyRow(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            items(
                dockFields,
                key = { it.name },
            ) { dockField ->
                val toolField = dockField.name
                val toolLabel = fieldLabel(dockField)
                Column(
                    Modifier.width(76.dp).clickable { onArmed(toolField) },
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Box(
                        Modifier.size(40.dp)
                            .clip(CircleShape)
                            .background(
                                if (armed == toolField) MapleColors.primary.copy(alpha = .15f)
                                else MapleColors.raised
                            )
                            .border(
                                .5.dp,
                                if (armed == toolField) MapleColors.primary
                                else MapleColors.border,
                                CircleShape,
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            painterResource(toolGlyph(toolField)),
                            toolLabel,
                            Modifier.size(20.dp),
                            tint =
                                if (armed == toolField) MapleColors.primary else MapleColors.text,
                        )
                    }
                    Text(
                        toolLabel,
                        fontSize = 9.sp,
                        lineHeight = 12.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        color = if (armed == toolField) MapleColors.primary else MapleColors.muted,
                    )
                }
            }
            item {
                Column(
                    Modifier.width(76.dp).clickable { onMore() },
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    MuiIconButton(
                        "All ${group.label} controls",
                        Icons.Outlined.Tune,
                    ) {
                        onMore()
                    }
                    Text("More", fontSize = 9.sp)
                }
            }
        }
    }
}
