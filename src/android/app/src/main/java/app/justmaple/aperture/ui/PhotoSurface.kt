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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import app.justmaple.aperture.*
import app.justmaple.aperture.R
import app.justmaple.aperture.data.XmpDocument
import app.justmaple.aperture.generated.AdjustmentField
import app.justmaple.aperture.generated.AdjustmentFields
import app.justmaple.aperture.generated.FilmCatalog
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
    val field = AdjustmentFields.byName[armed] ?: AdjustmentFields.byName.getValue("exposure")
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
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    if (editing) {
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
                                Modifier.fillMaxWidth(.94f)
                                    .aspectRatio(state.values["_aspect"] ?: (3f / 2f))
                                    .semantics { contentDescription = "Photo canvas" },
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
                if (editing) {
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
                            group.tools.filter { it.field in AdjustmentFields.byName },
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
                } else
                    Row(
                        Modifier.fillMaxWidth().padding(8.dp),
                        horizontalArrangement = Arrangement.SpaceEvenly,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        val picked = state.document.attribute("papp:Flag") == "pick"
                        MuiIconButton("Pick photo", Icons.Outlined.Flag, selected = picked) {
                            model.attribute("papp:Flag", if (picked) null else "pick")
                        }
                        for (rating in 1..5) MuiIconButton(
                            "Rate $rating stars",
                            Icons.Outlined.Star,
                            selected =
                                (state.document.attribute("xmp:Rating")?.toIntOrNull() ?: 0) >=
                                    rating,
                        ) {
                            model.attribute("xmp:Rating", rating.toString())
                        }
                        Button(model::edit, shape = CircleShape, enabled = !state.loading) {
                            Text("Edit")
                        }
                    }
            }
            if (tablet && editing && showInspector)
                ControlsInspector(model, state, group, Modifier.width(280.dp).fillMaxHeight())
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
private fun ControlsInspector(
    model: MapleViewModel,
    state: MapleState,
    group: EditorGroup,
    modifier: Modifier,
) {
    var filmsOpen by remember { mutableStateOf(false) }
    val filmId = state.document.attribute("papp:FilmLook").orEmpty()
    val bw = state.document.attribute("crs:ConvertToGrayscale")
    val monochrome = bw == "1" || bw.equals("True", ignoreCase = true)
    val effectiveProfile =
        state.document.attribute("papp:Profile")
            ?: if (state.document.attribute("papp:Look") == "Neutral") "Neutral" else "Auto"
    Column(modifier.background(MapleColors.surface)) {
        MuiSection("Profile") {
            Row {
                for (profile in listOf("Auto", "Neutral")) FilterChip(
                    selected = effectiveProfile == profile,
                    onClick = { model.attribute("papp:Profile", profile) },
                    label = { Text(profile) },
                    modifier = Modifier.padding(end = 8.dp),
                )
            }
        }
        if (group == EditorGroup.Color)
            Row(
                Modifier.padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Black & white", Modifier.weight(1f))
                Switch(
                    monochrome,
                    { model.attribute("crs:ConvertToGrayscale", if (it) "True" else null) },
                )
            }
        if (group == EditorGroup.Effects)
            Box(Modifier.padding(horizontal = 16.dp)) {
                TextButton({ filmsOpen = true }) {
                    Text(
                        "Film · ${FilmCatalog.all.find { it.id == filmId }?.label ?: filmId.ifEmpty { "None" }}"
                    )
                }
                DropdownMenu(
                    filmsOpen,
                    { filmsOpen = false },
                    modifier = Modifier.heightIn(max = 320.dp),
                ) {
                    DropdownMenuItem(
                        text = { Text("None") },
                        onClick = {
                            model.attribute("papp:FilmLook", null)
                            filmsOpen = false
                        },
                    )
                    FilmCatalog.all.forEach { film ->
                        DropdownMenuItem(
                            text = { Text(film.label) },
                            onClick = {
                                model.attribute("papp:FilmLook", film.id)
                                filmsOpen = false
                            },
                        )
                    }
                }
            }
        LazyColumn(Modifier.weight(1f)) {
            items(group.fields, key = { it.name }) { field ->
                Column(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
                    Row {
                        Text(fieldLabel(field), Modifier.weight(1f))
                        Text(
                            displayValue(field, state.values[field.name] ?: field.initial),
                            color = MapleColors.muted,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                    Slider(
                        state.values[field.name] ?: field.initial,
                        { model.setField(field.name, it) },
                        valueRange = field.minimum..field.maximum,
                        onValueChangeFinished = model::commitGesture,
                        enabled =
                            !state.rendering &&
                                (field.name != "film_strength" || filmId.isNotEmpty()) &&
                                (!field.name.startsWith("gray_mixer_") || monochrome),
                    )
                }
            }
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

private fun displayValue(field: AdjustmentField, value: Float) =
    when (field.name) {
        "temperature" -> "${value.toInt()} K"
        "exposure" -> "${XmpDocument.format(value)} EV"
        else -> XmpDocument.format(value)
    }

private fun toolGlyph(field: String): Int =
    when (field) {
        "exposure" -> R.drawable.tool_exposure
        "brightness" -> R.drawable.tool_brightness
        "contrast" -> R.drawable.tool_contrast
        "highlights" -> R.drawable.tool_highlights
        "shadows" -> R.drawable.tool_shadows
        "whites" -> R.drawable.tool_whites
        "blacks" -> R.drawable.tool_blacks
        "temperature" -> R.drawable.tool_temp
        "tint" -> R.drawable.tool_tint
        "vibrance" -> R.drawable.tool_vibrance
        "saturation" -> R.drawable.tool_saturation
        "clarity" -> R.drawable.tool_clarity
        "texture" -> R.drawable.tool_texture
        "dehaze" -> R.drawable.tool_dehaze
        "vignette_amount" -> R.drawable.tool_vignette
        "grain_amount" -> R.drawable.tool_grain
        "sharpen_amount" -> R.drawable.tool_sharpen
        "nr_luminance" -> R.drawable.tool_noise
        "nr_color" -> R.drawable.tool_color_nr
        "capture_sharpening_amount",
        "capture_sharpening_sigma" -> R.drawable.tool_capture_sharpen
        else -> R.drawable.tool_presets
    }
