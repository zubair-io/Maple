package app.justmaple.aperture.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChevronLeft
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.justmaple.aperture.*
import app.justmaple.aperture.generated.AdjustmentFields
import kotlinx.coroutines.delay

/** Floating chrome shares one bounded canvas; reflow never recreates the editor model. */
@Composable
fun PhotoSurface(
    model: MapleViewModel,
    state: MapleState,
    tablet: Boolean,
    showInspector: Boolean,
    onInfo: () -> Unit,
    onExport: () -> Unit,
    posture: FoldablePosture = rememberFoldablePosture(),
    onExportSidecar: () -> Unit = {},
) {
    var group by rememberSaveable { mutableStateOf(EditorGroup.Light) }
    var subTool by rememberSaveable { mutableStateOf("basic") }
    var armed by rememberSaveable { mutableStateOf("exposure") }
    var more by rememberSaveable { mutableStateOf(false) }
    var adjustments by rememberSaveable { mutableStateOf(true) }
    var histogram by remember { mutableStateOf<Result<RgbHistogram>?>(null) }
    var hud by remember { mutableStateOf(false) }
    val zoomState = rememberCanvasZoomState()
    val field =
        AdjustmentFields.byName[armed]?.takeIf(state::supportsField)
            ?: AdjustmentFields.byName.getValue("exposure")
    val value = state.values[field.name] ?: field.initial
    val editing = state.mode == PhotoMode.Edit
    val cropActive = editing && group == EditorGroup.Detail && subTool == "crop"
    if (state.selected == null) return
    val selectGroup: (EditorGroup) -> Unit = {
        group = it
        subTool = subToolsFor(it).first().id
        armed = it.tools.first().field
    }
    val toggleAdjustments: () -> Unit = {
        if (!showInspector) {
            onInfo()
            adjustments = true
        } else adjustments = !adjustments
    }
    LaunchedEffect(armed, value) {
        if (!state.loading && state.values.isNotEmpty()) {
            hud = true
            delay(1_000)
            hud = false
        }
    }
    when (posture.kind) {
        PostureKind.BookVerticalSplit ->
            BookSplitPhotoSurface(
                model = model,
                state = state,
                posture = posture,
                zoomState = zoomState,
                group = group,
                subTool = subTool,
                onSubTool = { subTool = it },
                selectGroup = selectGroup,
                armedField = field,
                armedValue = value,
                hud = hud,
                histogram = histogram,
                onHistogram = { histogram = it },
                adjustments = adjustments,
                showInspector = showInspector,
                onToggleAdjustments = toggleAdjustments,
                onInfo = onInfo,
                onExport = onExport,
                onExportSidecar = onExportSidecar,
            )
        PostureKind.TabletopHorizontalSplit ->
            TabletopSplitPhotoSurface(
                model = model,
                state = state,
                posture = posture,
                zoomState = zoomState,
                group = group,
                subTool = subTool,
                onSubTool = { subTool = it },
                armed = armed,
                selectGroup = selectGroup,
                onSelectArmed = { armed = it },
                onMore = { more = true },
                armedField = field,
                armedValue = value,
                hud = hud,
                histogram = histogram,
                onHistogram = { histogram = it },
                adjustments = adjustments,
                showInspector = showInspector,
                onToggleAdjustments = toggleAdjustments,
                onInfo = onInfo,
                onExport = onExport,
                onExportSidecar = onExportSidecar,
            )
        PostureKind.Normal ->
            BoxWithConstraints(Modifier.fillMaxSize().background(MapleColors.canvas)) {
                val regular = (tablet || posture.isWideLayout) && maxWidth >= 600.dp
                val dockMaxHeight = (maxHeight - 84.dp).coerceAtLeast(1.dp)
                val badgeStart =
                    if (regular && state.showFilmstrip) 136.dp else 12.dp
                val badgeBottom =
                    when {
                        regular -> 12.dp
                        editing && adjustments && state.showFilmstrip -> 220.dp
                        editing && adjustments -> 156.dp
                        editing && state.showFilmstrip -> 76.dp
                        !editing && state.showFilmstrip -> 132.dp
                        !editing -> 72.dp
                        else -> 12.dp
                    }
                PhotoCanvas(
                    model = model,
                    state = state,
                    onHistogram = { histogram = it },
                    modifier = Modifier.fillMaxSize(),
                    zoomState = zoomState,
                    badgeStartPadding = badgeStart,
                    badgeBottomPadding = badgeBottom,
                    showCropOverlay = cropActive,
                )
                if (regular && state.showFilmstrip)
                    FloatingFilmstrip(
                        model,
                        state,
                        Modifier.align(Alignment.CenterStart)
                            .padding(start = 12.dp)
                            .heightIn(max = (maxHeight - 96.dp).coerceAtLeast(1.dp)),
                    )
                if (editing && regular && showInspector && adjustments) {
                    Row(
                        Modifier.align(Alignment.TopEnd)
                            .padding(top = 72.dp, bottom = 12.dp, end = 12.dp)
                            .fillMaxHeight(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        MapleGlass(
                            Modifier.width(320.dp).fillMaxHeight().testTag("adjustments-panel"),
                            RoundedCornerShape(16.dp),
                        ) {
                            ControlsInspector(
                                model,
                                state,
                                group,
                                Modifier.fillMaxSize(),
                                activeSubTool = subTool,
                                onSubToolChange = { subTool = it },
                            )
                        }
                        ToolDock(group, selectGroup, Modifier.heightIn(max = dockMaxHeight))
                    }
                }
                if (!regular)
                    Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth()) {
                        if (state.showFilmstrip)
                            MapleGlass(
                                Modifier.fillMaxWidth(),
                                RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp),
                            ) {
                                HorizontalFilmstrip(model, state)
                            }
                        if (editing && adjustments)
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
                                    { armed = it },
                                    { more = true },
                                    activeSubTool = subTool,
                                    onSubToolChange = { subTool = it },
                                )
                            }
                    }
                if (!editing)
                    MapleGlass(
                        Modifier.align(Alignment.BottomCenter)
                            .padding(bottom = if (!regular && state.showFilmstrip) 76.dp else 16.dp)
                            .widthIn(max = 348.dp)
                            .fillMaxWidth(),
                        CircleShape,
                    ) {
                        PreviewActions(model, state)
                    }
                if (editing)
                    AnimatedVisibility(hud, Modifier.align(Alignment.Center)) {
                        MapleGlass(shape = CircleShape) {
                            Text(
                                "${group.label.uppercase()}  │  ${fieldLabel(field).uppercase()}  ${displayValue(field, value)}",
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
                    onAdjustments = toggleAdjustments,
                    onInfo = onInfo,
                    onExport = onExport,
                    modifier = Modifier.align(Alignment.TopCenter).padding(top = 8.dp),
                    zoomState = zoomState,
                )
            }
    }
    if (more) {
        @OptIn(ExperimentalMaterial3Api::class)
        ModalBottomSheet(
            onDismissRequest = { more = false },
            containerColor = MapleColors.surface,
        ) {
            ControlsInspector(
                model,
                state,
                group,
                Modifier.fillMaxWidth().heightIn(max = 540.dp).height(460.dp),
                activeSubTool = subTool,
                onSubToolChange = { subTool = it },
            )
        }
    }
}

@Composable
internal fun ToolDock(group: EditorGroup, onSelect: (EditorGroup) -> Unit, modifier: Modifier) {
    MapleGlass(modifier.width(64.dp).testTag("editor-tool-dock"), RoundedCornerShape(18.dp)) {
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(vertical = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            for (next in EditorGroup.entries) Column(
                Modifier.fillMaxWidth()
                    .selectable(next == group, role = Role.Tab, onClick = { onSelect(next) })
                    .padding(vertical = 6.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Box(
                    Modifier.size(40.dp)
                        .clip(CircleShape)
                        .background(
                            if (next == group) MapleColors.primaryDim else MapleColors.canvas
                        )
                        .border(
                            .5.dp,
                            if (next == group) MapleColors.primary else MapleColors.border,
                            CircleShape,
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        painterResource(toolGlyph(next.tools.first().field)),
                        next.label,
                        Modifier.size(20.dp),
                        tint = if (next == group) MapleColors.primary else MapleColors.text,
                    )
                }
                Text(
                    next.label,
                    fontSize = 10.sp,
                    color = if (next == group) MapleColors.primary else MapleColors.muted,
                )
            }
        }
    }
}

@Composable
private fun FloatingFilmstrip(model: MapleViewModel, state: MapleState, modifier: Modifier) {
    var collapsed by rememberSaveable { mutableStateOf(false) }
    Row(modifier.testTag("photo-filmstrip"), verticalAlignment = Alignment.CenterVertically) {
        if (!collapsed)
            MapleGlass(Modifier.width(110.dp), RoundedCornerShape(14.dp)) {
                LazyColumn(
                    Modifier.padding(8.dp).heightIn(max = 460.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    items(state.navigationPhotos, key = { it.uri.toString() }) { photo ->
                        PhotoThumbnail(
                            photo,
                            model.library,
                            Modifier.width(94.dp)
                                .height(63.dp)
                                .clip(RoundedCornerShape(6.dp))
                                .border(
                                    if (photo.uri == state.selected?.uri) 2.dp else 0.dp,
                                    MapleColors.primary,
                                    RoundedCornerShape(6.dp),
                                )
                                .clickable { model.open(photo) },
                            revision = state.document.original.takeIf { photo == state.selected },
                        )
                    }
                }
            }
        MapleGlass(shape = RoundedCornerShape(8.dp)) {
            MuiIconButton(
                if (collapsed) "Expand filmstrip" else "Collapse filmstrip",
                if (collapsed) Icons.Outlined.ChevronRight else Icons.Outlined.ChevronLeft,
            ) {
                collapsed = !collapsed
            }
        }
    }
}

@Composable
internal fun HorizontalFilmstrip(model: MapleViewModel, state: MapleState) {
    LazyRow(
        Modifier.fillMaxWidth().height(64.dp).padding(5.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        items(state.navigationPhotos, key = { it.uri.toString() }) { photo ->
            PhotoThumbnail(
                photo,
                model.library,
                Modifier.size(54.dp)
                    .clip(RoundedCornerShape(4.dp))
                    .border(
                        if (photo.uri == state.selected?.uri) 2.dp else 0.dp,
                        MapleColors.primary,
                        RoundedCornerShape(4.dp),
                    )
                    .clickable { model.open(photo) },
                revision = state.document.original.takeIf { photo == state.selected },
            )
        }
    }
}
