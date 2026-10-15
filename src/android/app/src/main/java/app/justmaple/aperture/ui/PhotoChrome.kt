package app.justmaple.aperture.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Redo
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.justmaple.aperture.*

@Composable
internal fun MapleGlass(
    modifier: Modifier = Modifier,
    shape: Shape = RoundedCornerShape(24.dp),
    content: @Composable () -> Unit,
) {
    Surface(
        modifier,
        shape = shape,
        color = MapleColors.surface.copy(alpha = .88f),
        border = BorderStroke(.5.dp, MapleColors.borderHi.copy(alpha = .5f)),
        content = content,
    )
}

@Composable
internal fun FloatingPhotoHeader(
    model: MapleViewModel,
    state: MapleState,
    histogram: Result<RgbHistogram>?,
    adjustments: Boolean,
    onAdjustments: () -> Unit,
    onInfo: () -> Unit,
    onExport: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var menu by remember { mutableStateOf(false) }
    val editing = state.mode == PhotoMode.Edit
    Row(
        modifier
            .widthIn(max = 600.dp)
            .fillMaxWidth()
            .padding(horizontal = 20.dp)
            .testTag("photo-header"),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        MapleGlass(shape = CircleShape) {
            MuiIconButton("Back", Icons.AutoMirrored.Outlined.ArrowBack, onClick = model::back)
        }
        MapleGlass(Modifier.weight(1f).height(44.dp), CircleShape) {
            if (editing) HistogramChip(histogram)
            else
                Box(Modifier.padding(horizontal = 16.dp), contentAlignment = Alignment.Center) {
                    Text(
                        state.selected?.name.orEmpty(),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        fontSize = 14.sp,
                    )
                }
        }
        MapleGlass(shape = CircleShape) {
            Row(Modifier.padding(horizontal = 4.dp)) {
                if (editing)
                    MuiIconButton(
                        "Undo",
                        Icons.AutoMirrored.Outlined.Undo,
                        enabled = state.canUndo,
                        onClick = model::undo,
                    )
                else
                    MuiIconButton(
                        "Edit",
                        Icons.Outlined.Edit,
                        enabled = !state.loading,
                        onClick = model::edit,
                    )
                Box {
                    MuiIconButton("More photo actions", Icons.Outlined.MoreHoriz) { menu = true }
                    DropdownMenu(menu, { menu = false }) {
                        if (editing && state.values["_raw"] != 0f) {
                            val profile =
                                state.document.attribute("papp:Profile")
                                    ?: if (state.document.attribute("papp:Look") == "Neutral")
                                        "Neutral"
                                    else "Auto"
                            for (option in listOf("Auto", "Neutral")) DropdownMenuItem(
                                text = { Text("Profile · $option") },
                                modifier = Modifier.semantics { selected = profile == option },
                                onClick = {
                                    menu = false
                                    model.attribute("papp:Profile", option)
                                },
                            )
                        }
                        if (editing)
                            DropdownMenuItem(
                                text = { Text("Redo") },
                                leadingIcon = { Icon(Icons.AutoMirrored.Outlined.Redo, null) },
                                enabled = state.canRedo,
                                onClick = {
                                    menu = false
                                    model.redo()
                                },
                            )
                        DropdownMenuItem(
                            text = { Text("Photo Info") },
                            leadingIcon = { Icon(Icons.Outlined.Info, null) },
                            modifier = Modifier.semantics { contentDescription = "Info" },
                            onClick = {
                                menu = false
                                onInfo()
                            },
                        )
                        DropdownMenuItem(
                            text = { Text("Export photo") },
                            leadingIcon = { Icon(Icons.Outlined.IosShare, null) },
                            enabled = !state.loading && !state.rendering,
                            onClick = {
                                menu = false
                                onExport()
                            },
                        )
                        DropdownMenuItem(
                            text = {
                                Text(
                                    if (state.showFilmstrip) "Hide filmstrip" else "Show filmstrip"
                                )
                            },
                            leadingIcon = { Icon(Icons.Outlined.ViewCarousel, null) },
                            onClick = {
                                menu = false
                                model.setFilmstrip(!state.showFilmstrip)
                            },
                        )
                        if (editing)
                            DropdownMenuItem(
                                text = {
                                    Text(
                                        if (adjustments) "Hide adjustments" else "Show adjustments"
                                    )
                                },
                                leadingIcon = { Icon(Icons.Outlined.Tune, null) },
                                onClick = {
                                    menu = false
                                    onAdjustments()
                                },
                            )
                    }
                }
            }
        }
    }
}
