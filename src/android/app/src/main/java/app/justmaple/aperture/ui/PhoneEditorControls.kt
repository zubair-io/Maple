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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.justmaple.aperture.MapleState
import app.justmaple.aperture.MapleViewModel
import app.justmaple.aperture.generated.AdjustmentFields

@Composable
internal fun PhoneEditorControls(
    model: MapleViewModel,
    state: MapleState,
    group: EditorGroup,
    armed: String,
    onGroup: (EditorGroup) -> Unit,
    onArmed: (String) -> Unit,
    onMore: () -> Unit,
) {
    val field =
        AdjustmentFields.byName[armed]?.takeIf(state::supportsField)
            ?: AdjustmentFields.byName.getValue("exposure")
    val value = state.values[field.name] ?: field.initial
    Column(Modifier.fillMaxWidth()) {
        DragBar(
            field,
            value,
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
        LazyRow(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            items(
                group.tools.filter { tool ->
                    AdjustmentFields.byName[tool.field]?.let {
                        state.supportsField(it)
                    } == true
                },
                key = { it.field },
            ) { tool ->
                Column(
                    Modifier.width(76.dp).clickable { onArmed(tool.field) },
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Box(
                        Modifier.size(40.dp)
                            .clip(CircleShape)
                            .background(
                                if (armed == tool.field) MapleColors.primary.copy(alpha = .15f)
                                else MapleColors.raised
                            )
                            .border(
                                .5.dp,
                                if (armed == tool.field) MapleColors.primary
                                else MapleColors.border,
                                CircleShape,
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            painterResource(toolGlyph(tool.field)),
                            tool.label,
                            Modifier.size(20.dp),
                            tint =
                                if (armed == tool.field) MapleColors.primary else MapleColors.text,
                        )
                    }
                    Text(
                        tool.label,
                        fontSize = 9.sp,
                        lineHeight = 12.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        color = if (armed == tool.field) MapleColors.primary else MapleColors.muted,
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
