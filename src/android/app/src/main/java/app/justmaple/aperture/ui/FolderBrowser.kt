package app.justmaple.aperture.ui

import android.net.Uri
import android.content.Context
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.*
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import app.justmaple.aperture.*
import app.justmaple.aperture.R
import app.justmaple.aperture.data.Folder
import app.justmaple.aperture.data.Photo

@Composable
internal fun BrowseGrid(
    model: MapleViewModel,
    state: MapleState,
    photos: List<Photo>,
    folders: List<Folder>,
    folderPicker: () -> Unit,
) {
    val context = LocalContext.current.applicationContext
    val gridPreferences = remember(context) { context.getSharedPreferences("browse-grid", Context.MODE_PRIVATE) }
    var columns by rememberSaveable { mutableIntStateOf(gridPreferences.getInt("columns", 3).coerceIn(1, 7)) }
    LaunchedEffect(columns) { gridPreferences.edit().putInt("columns", columns).apply() }
    var filter by rememberSaveable { mutableStateOf(BrowseFilter.All) }
    var sort by rememberSaveable { mutableStateOf(BrowseSort.Name) }
    var culling by remember { mutableStateOf(emptyMap<String, PhotoCulling>()) }
    val gridState = rememberFolderGridState(state.folder?.uri)
    val directories = folders.filter { it.name != ".." }
    LaunchedEffect(photos, state.selected?.uri, state.document, state.documentLoaded) {
        culling =
            withContext(Dispatchers.IO) {
                photos.associate { photo ->
                    val marks =
                        if (state.documentLoaded && photo.uri == state.selected?.uri)
                            cullingOf(state.document)
                        else
                            runCatching { cullingOf(model.library.loadSidecar(photo).document) }
                                .getOrDefault(PhotoCulling())
                    photo.uri.toString() to marks
                }
            }
    }
    val visible = remember(photos, culling, filter, sort) {
        applyBrowseCulling(photos, culling, filter, sort)
    }
    val pinchColumns = Modifier.gridPinch(gridState, columns) { columns = it }
    if (state.loading) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(color = MapleColors.primary)
        }
        return
    }
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (state.folderTrail.size > 1)
                MuiIconButton("Parent folder", Icons.Outlined.ArrowBack) {
                    model.browse(state.folderTrail[state.folderTrail.lastIndex - 1])
                }
            val count =
                listOfNotNull(
                        "${directories.size} ${if (directories.size == 1) "folder" else "folders"}"
                            .takeIf { directories.isNotEmpty() },
                        "${visible.size} ${if (visible.size == 1) "photo" else "photos"}",
                    )
                    .joinToString(" · ")
            Text(
                count,
                Modifier.weight(1f),
                color = MapleColors.muted,
                fontFamily = FolderFont,
                fontSize = 14.sp,
            )
            MuiIconButton("Larger thumbnails", Icons.Outlined.Add, enabled = columns > 1) {
                columns--
            }
            MuiIconButton("Smaller thumbnails", Icons.Outlined.Remove, enabled = columns < 7) {
                columns++
            }
        }
        BrowseFilterBar(filter, { filter = it }, sort, { sort = it })
        if (photos.isEmpty() && directories.isEmpty()) {
            MuiEmptyState(
                if (state.folder == null) "Your library, in Maple" else "No photos here",
                "Open a folder of photos to browse, rate, and develop.",
                "Open folder",
                folderPicker,
            )
            return@Column
        }
        BoxWithConstraints(Modifier.weight(1f)) {
            // Fixed 180×64 Maple folder tiles wrap independently of photo sizing.
            val folderColumns = ((maxWidth - 4.dp) / 184.dp).toInt().coerceAtLeast(1)
            val rows = directories.chunked(folderColumns)
            LazyVerticalGrid(
                GridCells.Fixed(columns),
                Modifier.fillMaxSize().testTag("browse-grid").then(pinchColumns),
                state = gridState,
                contentPadding = PaddingValues(4.dp),
                horizontalArrangement = Arrangement.spacedBy(3.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                itemsIndexed(
                    rows,
                    key = { _, row -> "folders:${row.first().uri}" },
                    span = { _, _ -> GridItemSpan(maxLineSpan) },
                ) { index, row ->
                    Row(
                        Modifier.fillMaxWidth()
                            .padding(bottom = if (index == rows.lastIndex) 12.dp else 1.dp),
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        row.forEach { folder -> FolderTile(folder) { model.browse(folder) } }
                    }
                }
                items(visible, key = { "photo:${it.uri}" }) { photo ->
                    val marks = culling[photo.uri.toString()] ?: PhotoCulling()
                    PhotoThumbnail(
                        photo,
                        model.library,
                        Modifier.aspectRatio(1f).clickable { model.openFromBrowse(photo, visible) },
                        revision = state.document.original.takeIf { photo == state.selected },
                        pick = marks.pick,
                        rating = marks.rating,
                    )
                }
            }
        }
    }
}

@Composable
internal fun rememberFolderGridState(folder: Uri?): LazyGridState =
    rememberSaveable(folder, saver = LazyGridState.Saver) { LazyGridState() }

@Composable
private fun FolderTile(folder: Folder, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) .97f else 1f, tween(120))
    Row(
        Modifier.width(180.dp)
            .height(64.dp)
            .scale(scale)
            .clip(RoundedCornerShape(4.dp))
            .background(if (pressed) MapleColors.raised else MapleColors.surface)
            .clickable(
                interactionSource = interaction,
                indication = null,
                role = Role.Button,
                onClick = onClick,
            )
            .semantics { contentDescription = "Folder ${folder.name}" }
            .testTag("folder-tile:${folder.uri}")
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(
            painterResource(R.drawable.nav_folder),
            null,
            Modifier.size(24.dp),
            tint = MapleColors.primary,
        )
        Text(
            folder.name,
            fontFamily = FolderFont,
            fontSize = 14.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
