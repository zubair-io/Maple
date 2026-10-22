package app.justmaple.aperture.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.justmaple.aperture.*
import app.justmaple.aperture.generated.AdjustmentField

@Composable
internal fun BookSplitPhotoSurface(
    model: MapleViewModel,
    state: MapleState,
    posture: FoldablePosture,
    zoomState: CanvasZoomState,
    group: EditorGroup,
    subTool: String,
    onSubTool: (String) -> Unit,
    selectGroup: (EditorGroup) -> Unit,
    armedField: AdjustmentField?,
    armedValue: Float,
    hud: Boolean,
    histogram: Result<RgbHistogram>?,
    onHistogram: (Result<RgbHistogram>?) -> Unit,
    adjustments: Boolean,
    showInspector: Boolean,
    onToggleAdjustments: () -> Unit,
    onInfo: () -> Unit,
    onExport: () -> Unit,
    onExportSidecar: () -> Unit,
) {
    val editing = state.mode == PhotoMode.Edit
    val cropActive = editing && group == EditorGroup.Detail && subTool == "crop"
    Row(
        Modifier.fillMaxSize()
            .background(MapleColors.canvas)
            .testTag("foldable-book-surface"),
    ) {
        Box(
            Modifier.width(posture.primaryPaneSpanDp)
                .fillMaxHeight()
                .testTag("foldable-primary-pane"),
        ) {
            PhotoCanvas(
                model = model,
                state = state,
                onHistogram = onHistogram,
                modifier = Modifier.fillMaxSize(),
                zoomState = zoomState,
                badgeStartPadding = 12.dp,
                badgeBottomPadding = if (state.showFilmstrip) 76.dp else 12.dp,
                showCropOverlay = cropActive,
            )
            if (editing && armedField != null)
                androidx.compose.animation.AnimatedVisibility(hud, Modifier.align(Alignment.Center)) {
                    MapleGlass(shape = CircleShape) {
                        Text(
                            "${group.label.uppercase()}  │  ${fieldLabel(armedField).uppercase()}  ${displayValue(armedField, armedValue)}",
                            Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                            fontSize = 10.sp,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                }
            if (state.showFilmstrip)
                MapleGlass(
                    Modifier.align(Alignment.BottomCenter).fillMaxWidth(),
                    RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp),
                ) {
                    HorizontalFilmstrip(model, state)
                }
            FloatingPhotoHeader(
                model = model,
                state = state,
                histogram = histogram,
                adjustments = adjustments && showInspector,
                onAdjustments = onToggleAdjustments,
                onInfo = onInfo,
                onExport = onExport,
                modifier = Modifier.align(Alignment.TopCenter).padding(top = 8.dp),
                zoomState = zoomState,
            )
        }
        Spacer(
            Modifier.width(posture.hingeSpanDp)
                .fillMaxHeight()
                .testTag("foldable-hinge-spacer"),
        )
        Box(
            Modifier.width(posture.secondaryPaneSpanDp)
                .fillMaxHeight()
                .background(MapleColors.surface)
                .padding(12.dp)
                .testTag("foldable-secondary-pane"),
        ) {
            if (editing && showInspector && adjustments) {
                Row(
                    Modifier.fillMaxSize(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    MapleGlass(
                        Modifier.weight(1f).fillMaxHeight().testTag("adjustments-panel"),
                        RoundedCornerShape(16.dp),
                    ) {
                        ControlsInspector(
                            model,
                            state,
                            group,
                            Modifier.fillMaxSize(),
                            activeSubTool = subTool,
                            onSubToolChange = onSubTool,
                        )
                    }
                    ToolDock(group, selectGroup, Modifier.fillMaxHeight())
                }
            } else {
                Column(
                    Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.SpaceBetween,
                ) {
                    Box(Modifier.weight(1f).fillMaxWidth()) {
                        InfoPanel(state, model.library, onExportSidecar = onExportSidecar)
                    }
                    if (!editing)
                        MapleGlass(
                            Modifier.fillMaxWidth().padding(top = 8.dp),
                            CircleShape,
                        ) {
                            PreviewActions(model, state)
                        }
                }
            }
        }
    }
}

@Composable
internal fun TabletopSplitPhotoSurface(
    model: MapleViewModel,
    state: MapleState,
    posture: FoldablePosture,
    zoomState: CanvasZoomState,
    group: EditorGroup,
    subTool: String,
    onSubTool: (String) -> Unit,
    armed: String,
    selectGroup: (EditorGroup) -> Unit,
    onSelectArmed: (String) -> Unit,
    onMore: () -> Unit,
    armedField: AdjustmentField?,
    armedValue: Float,
    hud: Boolean,
    histogram: Result<RgbHistogram>?,
    onHistogram: (Result<RgbHistogram>?) -> Unit,
    adjustments: Boolean,
    showInspector: Boolean,
    onToggleAdjustments: () -> Unit,
    onInfo: () -> Unit,
    onExport: () -> Unit,
    onExportSidecar: () -> Unit,
) {
    val editing = state.mode == PhotoMode.Edit
    val cropActive = editing && group == EditorGroup.Detail && subTool == "crop"
    Column(
        Modifier.fillMaxSize()
            .background(MapleColors.canvas)
            .testTag("foldable-tabletop-surface"),
    ) {
        Box(
            Modifier.height(posture.primaryPaneSpanDp)
                .fillMaxWidth()
                .testTag("tabletop-top-pane"),
        ) {
            PhotoCanvas(
                model = model,
                state = state,
                onHistogram = onHistogram,
                modifier = Modifier.fillMaxSize(),
                zoomState = zoomState,
                showCropOverlay = cropActive,
            )
            if (editing && armedField != null)
                androidx.compose.animation.AnimatedVisibility(hud, Modifier.align(Alignment.Center)) {
                    MapleGlass(shape = CircleShape) {
                        Text(
                            "${group.label.uppercase()}  │  ${fieldLabel(armedField).uppercase()}  ${displayValue(armedField, armedValue)}",
                            Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                            fontSize = 10.sp,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                }
            FloatingPhotoHeader(
                model = model,
                state = state,
                histogram = histogram,
                adjustments = adjustments && showInspector,
                onAdjustments = onToggleAdjustments,
                onInfo = onInfo,
                onExport = onExport,
                modifier = Modifier.align(Alignment.TopCenter).padding(top = 8.dp),
                zoomState = zoomState,
            )
        }
        Spacer(
            Modifier.height(posture.hingeSpanDp)
                .fillMaxWidth()
                .testTag("tabletop-hinge-spacer"),
        )
        Column(
            Modifier.height(posture.secondaryPaneSpanDp)
                .fillMaxWidth()
                .background(MapleColors.surface)
                .testTag("tabletop-bottom-pane"),
            verticalArrangement = Arrangement.SpaceBetween,
        ) {
            if (state.showFilmstrip)
                MapleGlass(Modifier.fillMaxWidth()) { HorizontalFilmstrip(model, state) }
            if (editing && showInspector && adjustments) {
                if (posture.windowWidthDp >= 600.dp) {
                    Row(
                        Modifier.weight(1f).fillMaxWidth().padding(12.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        MapleGlass(
                            Modifier.weight(1f).fillMaxHeight().testTag("adjustments-panel"),
                            RoundedCornerShape(16.dp),
                        ) {
                            ControlsInspector(
                                model,
                                state,
                                group,
                                Modifier.fillMaxSize(),
                                activeSubTool = subTool,
                                onSubToolChange = onSubTool,
                            )
                        }
                        ToolDock(group, selectGroup, Modifier.fillMaxHeight())
                    }
                } else {
                    MapleGlass(
                        Modifier.fillMaxWidth(),
                        RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
                    ) {
                        PhoneEditorControls(
                            model,
                            state,
                            group,
                            armed,
                            selectGroup,
                            onSelectArmed,
                            onMore,
                            activeSubTool = subTool,
                            onSubToolChange = onSubTool,
                        )
                    }
                }
            } else if (!showInspector) {
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    InfoPanel(state, model.library, onExportSidecar = onExportSidecar)
                }
            } else if (!editing) {
                Box(
                    Modifier.weight(1f).fillMaxWidth().padding(16.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    MapleGlass(
                        Modifier.widthIn(max = 348.dp).fillMaxWidth(),
                        CircleShape,
                    ) {
                        PreviewActions(model, state)
                    }
                }
            }
        }
    }
}
