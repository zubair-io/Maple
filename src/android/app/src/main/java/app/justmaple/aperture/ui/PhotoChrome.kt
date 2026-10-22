package app.justmaple.aperture.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.justmaple.aperture.*
import kotlinx.coroutines.withTimeoutOrNull

internal const val BEFORE_AFTER_HOLD_THRESHOLD_MS = 300L

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
    zoomState: CanvasZoomState? = null,
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
            Row(
                Modifier.padding(horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (editing) {
                    CompareBeforeAfterButton(
                        enabled = (state.hasActiveEdits || state.comparingBefore) && state.canEdit,
                        comparingBefore = state.comparingBefore,
                        onSetComparingBefore = model::setComparingBefore,
                    )
                    MuiIconButton(
                        "Undo",
                        Icons.AutoMirrored.Outlined.Undo,
                        enabled = state.canUndo && state.canEdit,
                        onClick = model::undo,
                    )
                } else
                    MuiIconButton(
                        "Edit",
                        Icons.Outlined.Edit,
                        enabled = state.documentLoaded && !state.loading,
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
                                enabled = state.canEdit,
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
                                enabled = state.canRedo && state.canEdit,
                                onClick = {
                                    menu = false
                                    model.redo()
                                },
                            )
                        if (zoomState != null)
                            DropdownMenuItem(
                                text = { Text("Zoom to fit") },
                                leadingIcon = { Icon(Icons.Outlined.FitScreen, null) },
                                enabled = zoomState.isZoomed,
                                onClick = {
                                    menu = false
                                    zoomState.reset()
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
                            enabled = state.canChangeMetadata,
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

@Composable
internal fun CompareBeforeAfterButton(
    enabled: Boolean,
    comparingBefore: Boolean,
    onSetComparingBefore: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val currentEnabled by rememberUpdatedState(enabled)
    val currentComparing by rememberUpdatedState(comparingBefore)
    val currentCallback by rememberUpdatedState(onSetComparingBefore)

    Box(
        modifier
            .size(44.dp)
            .clip(CircleShape)
            .background(if (comparingBefore) MapleColors.primaryDim else Color.Transparent)
            .pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    if (!currentEnabled) {
                        waitForUpOrCancellation()
                        return@awaitEachGesture
                    }
                    val latchedBefore = currentComparing
                    var finishedBeforeTimeout = false
                    val upBeforeHold =
                        withTimeoutOrNull(BEFORE_AFTER_HOLD_THRESHOLD_MS) {
                            val up = waitForUpOrCancellation()
                            finishedBeforeTimeout = true
                            up
                        }
                    if (finishedBeforeTimeout) {
                        if (upBeforeHold != null) {
                            // Short tap (<300ms): toggle latched Before state
                            currentCallback(!currentComparing)
                        }
                    } else {
                        // Press-and-hold (>=300ms): peek Before until finger lifts
                        currentCallback(true)
                        try {
                            waitForUpOrCancellation()
                        } finally {
                            currentCallback(latchedBefore)
                        }
                    }
                }
            }
            .semantics(mergeDescendants = true) {
                contentDescription = "Compare before and after"
                role = Role.Button
                selected = comparingBefore
                if (!enabled) disabled()
                onClick {
                    if (currentEnabled) {
                        currentCallback(!currentComparing)
                        true
                    } else false
                }
            }
            .testTag("before-after-button"),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            Icons.Outlined.Compare,
            contentDescription = null,
            modifier = Modifier.size(20.dp),
            tint =
                when {
                    !enabled -> MapleColors.muted.copy(alpha = 0.4f)
                    comparingBefore -> MapleColors.primary
                    else -> MapleColors.text
                },
        )
    }
}
