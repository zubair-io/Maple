package app.justmaple.aperture.ui

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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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
    var columns by rememberSaveable { mutableIntStateOf(3) }
    val directories = folders.filter { it.name != ".." }
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
                        "${photos.size} ${if (photos.size == 1) "photo" else "photos"}",
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
                Modifier.fillMaxSize().testTag("browse-grid"),
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
                items(photos, key = { "photo:${it.uri}" }) { photo ->
                    PhotoThumbnail(
                        photo,
                        model.library,
                        Modifier.aspectRatio(1f).clickable { model.open(photo) },
                        revision = state.document.original.takeIf { photo == state.selected },
                    )
                }
            }
        }
    }
}

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
