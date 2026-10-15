package app.justmaple.aperture.ui

import android.view.SurfaceHolder
import android.view.SurfaceView
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Redo
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import app.justmaple.aperture.*
import app.justmaple.aperture.generated.AdjustmentFields
import app.justmaple.aperture.generated.UiTokens

@Composable
fun PhotoSurface(
    model: MapleViewModel,
    state: MapleState,
    tablet: Boolean,
    showInspector: Boolean,
    onInfo: () -> Unit,
    onExport: () -> Unit,
) {
    var group by rememberSaveable { mutableStateOf(EditorGroup.Light) }
    var armed by rememberSaveable { mutableStateOf("exposure") }
    var more by rememberSaveable { mutableStateOf(false) }
    val field =
        (AdjustmentFields.byName[armed]?.takeIf(state::supportsField)
            ?: AdjustmentFields.byName.getValue("exposure"))
    val value = state.values[field.name] ?: field.initial
    val editing = state.mode == PhotoMode.Edit
    val photo = state.selected ?: return
    Column(Modifier.fillMaxSize().background(MapleColors.canvas)) {
        MuiHeader(
            photo.name,
            leading = {
                MuiIconButton("Back", Icons.AutoMirrored.Outlined.ArrowBack, onClick = model::back)
            },
            actions = {
                if (editing) {
                    MuiIconButton(
                        "Undo",
                        Icons.AutoMirrored.Outlined.Undo,
                        enabled = state.canUndo,
                        onClick = model::undo,
                    )
                    MuiIconButton(
                        "Redo",
                        Icons.AutoMirrored.Outlined.Redo,
                        enabled = state.canRedo,
                        onClick = model::redo,
                    )
                }
                MuiIconButton(
                    "Export photo",
                    Icons.Outlined.IosShare,
                    enabled = !state.loading && !state.rendering,
                    onClick = onExport,
                )
                MuiIconButton("Info", Icons.Outlined.Info, onClick = onInfo)
            },
        )
        Row(Modifier.weight(1f)) {
            if (tablet && state.showFilmstrip) Filmstrip(model, state, vertical = true)
            Column(Modifier.weight(1f)) {
                BoxWithConstraints(
                    Modifier.weight(1f).fillMaxWidth().clipToBounds().testTag("photo-viewport"),
                    contentAlignment = Alignment.Center,
                ) {
                    if (editing) {
                        val aspect =
                            state.values["_aspect"]?.takeIf { it.isFinite() && it > 0f }
                                ?: (3f / 2f)
                        // A width fixed before aspectRatio can exceed this viewport's height.
                        // Fit both axes before sizing the separate SurfaceView layer.
                        val canvasWidth = minOf(maxWidth * .94f, maxHeight * aspect)
                        AndroidView(
                            factory = { context ->
                                SurfaceView(context).apply {
                                    holder.addCallback(
                                        object : SurfaceHolder.Callback {
                                            override fun surfaceCreated(holder: SurfaceHolder) {
                                                /* Dimensions arrive in surfaceChanged. */
                                            }

                                            override fun surfaceChanged(
                                                holder: SurfaceHolder,
                                                format: Int,
                                                width: Int,
                                                height: Int,
                                            ) {
                                                model.surface(holder.surface, width, height)
                                            }

                                            override fun surfaceDestroyed(holder: SurfaceHolder) {
                                                model.surface(null, 0, 0)
                                            }
                                        }
                                    )
                                }
                            },
                            modifier =
                                Modifier.size(canvasWidth, canvasWidth / aspect).semantics {
                                    contentDescription = "Photo canvas"
                                },
                        )
                        Surface(
                            Modifier.align(Alignment.TopCenter).padding(top = 14.dp),
                            shape = CircleShape,
                            color = MapleColors.surface.copy(alpha = .9f),
                        ) {
                            Text(
                                "${group.label.uppercase()}  │  ${fieldLabel(field).uppercase()}  ${displayValue(field, value)}",
                                Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                                fontSize = 10.sp,
                                fontFamily = FontFamily.Monospace,
                                color = MapleColors.primary,
                            )
                        }
                    } else
                        PhotoThumbnail(
                            photo,
                            model.library,
                            Modifier.fillMaxSize().padding(16.dp),
                            fit = true,
                            revision = state.document.original,
                        )
                    if (state.loading || state.rendering)
                        Surface(shape = CircleShape, color = MapleColors.surface) {
                            Row(
                                Modifier.padding(16.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                CircularProgressIndicator(
                                    Modifier.size(20.dp),
                                    color = MapleColors.primary,
                                    strokeWidth = 2.dp,
                                )
                                Spacer(Modifier.width(12.dp))
                                Text(if (state.rendering) "Developing…" else "Opening…")
                            }
                        }
                }
                if (!tablet && state.showFilmstrip) Filmstrip(model, state)
                if (editing && !tablet) {
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
                                group = next
                                armed = next.tools.first().field
                            },
                            Modifier.weight(1f),
                        ) {
                            Text(
                                next.label,
                                color =
                                    if (group == next) MapleColors.primary else MapleColors.muted,
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
                                Modifier.width(54.dp).clickable { armed = tool.field },
                                horizontalAlignment = Alignment.CenterHorizontally,
                            ) {
                                Box(
                                    Modifier.size(40.dp)
                                        .clip(CircleShape)
                                        .background(
                                            if (armed == tool.field)
                                                MapleColors.primary.copy(alpha = .15f)
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
                                            if (armed == tool.field) MapleColors.primary
                                            else MapleColors.text,
                                    )
                                }
                                Text(
                                    tool.label,
                                    fontSize = 9.sp,
                                    color =
                                        if (armed == tool.field) MapleColors.primary
                                        else MapleColors.muted,
                                )
                            }
                        }
                        if (!tablet)
                            item {
                                Column(
                                    Modifier.width(54.dp).clickable { more = true },
                                    horizontalAlignment = Alignment.CenterHorizontally,
                                ) {
                                    MuiIconButton(
                                        "All ${group.label} controls",
                                        Icons.Outlined.Tune,
                                    ) {
                                        more = true
                                    }
                                    Text("More", fontSize = 9.sp)
                                }
                            }
                    }
                } else if (!editing) {
                    PreviewActions(model, state)
                }
            }
            if (tablet && editing && showInspector) {
                ControlsInspector(model, state, group, Modifier.width(280.dp).fillMaxHeight())
                Column(
                    Modifier.width(64.dp)
                        .fillMaxHeight()
                        .background(MapleColors.canvas)
                        .verticalScroll(rememberScrollState())
                        .padding(vertical = 12.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    for (next in EditorGroup.entries) {
                        Column(
                            Modifier.fillMaxWidth()
                                .clickable {
                                    group = next
                                    armed = next.tools.first().field
                                }
                                .padding(vertical = 8.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Icon(
                                painterResource(toolGlyph(next.tools.first().field)),
                                next.label,
                                Modifier.size(22.dp),
                                tint =
                                    if (group == next) MapleColors.primary else MapleColors.muted,
                            )
                            Text(
                                next.label,
                                fontSize = 10.sp,
                                color =
                                    if (group == next) MapleColors.primary else MapleColors.muted,
                            )
                        }
                    }
                }
            }
        }
    }
    if (more && !tablet) {
        @OptIn(ExperimentalMaterial3Api::class)
        ModalBottomSheet(
            onDismissRequest = { more = false },
            containerColor = MapleColors.surface,
        ) {
            ControlsInspector(model, state, group, Modifier.fillMaxWidth().fillMaxHeight(.7f))
        }
    }
}

@Composable
private fun Filmstrip(model: MapleViewModel, state: MapleState, vertical: Boolean = false) {
    val tile: @Composable (app.justmaple.aperture.data.Photo) -> Unit = { photo ->
        PhotoThumbnail(
            photo,
            model.library,
            Modifier.size(54.dp)
                .border(
                    if (photo.uri == state.selected?.uri) 2.dp else 0.dp,
                    MapleColors.primary,
                    RoundedCornerShape(UiTokens.radius_xs.dp),
                )
                .padding(3.dp)
                .clip(RoundedCornerShape(UiTokens.radius_xs.dp))
                .clickable { model.open(photo) },
            revision = state.document.original.takeIf { photo == state.selected },
        )
    }
    if (vertical)
        LazyColumn(
            Modifier.width(66.dp).fillMaxHeight().padding(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            items(state.photos, key = { it.uri.toString() }, itemContent = { tile(it) })
        }
    else
        LazyRow(
            Modifier.fillMaxWidth().height(64.dp).padding(5.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            items(state.photos, key = { it.uri.toString() }, itemContent = { tile(it) })
        }
}
