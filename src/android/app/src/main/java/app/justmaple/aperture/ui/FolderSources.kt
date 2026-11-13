package app.justmaple.aperture.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.justmaple.aperture.MapleState
import app.justmaple.aperture.R
import app.justmaple.aperture.cloud.CloudLibrary
import app.justmaple.aperture.data.Folder

internal val FolderFont = FontFamily(Font(R.font.lato_regular))

@Composable
internal fun FolderSources(
    state: MapleState,
    tree: FolderTree,
    onSelect: (FolderTreeEntry) -> Unit,
    onFolder: () -> Unit,
    onPhoto: () -> Unit,
    onCloud: () -> Unit,
    onClose: () -> Unit,
) {
    var localOpen by rememberSaveable { mutableStateOf(true) }
    val local = state.sources.filterNot { CloudLibrary.isCloud(it.uri) }
    val servers = state.sources.filter { CloudLibrary.isCloud(it.uri) }
    LaunchedEffect(state.folderTrail) {
        if (state.folderTrail.any { folder -> local.any { it.uri == folder.uri } }) localOpen = true
    }
    Column(Modifier.fillMaxSize().testTag("folder-navigation")) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            MuiIconButton("Collapse sources", Icons.Outlined.Menu, onClick = onClose)
        }
        LazyColumn(Modifier.weight(1f)) {
            servers.forEach { server ->
                val serverKey = server.uri.toString()
                val open = tree.expanded[serverKey] != false
                item("server:$serverKey") {
                    FolderSectionHeader(server.name, open, { tree.expanded[serverKey] = !open })
                    FolderLoadError(tree, server)
                }
                if (open)
                    items(
                        tree.entries(tree.children[serverKey].orEmpty(), listOf(server)),
                        key = { it.rowKey },
                    ) { entry ->
                        SourceFolderRow(entry, state, tree, onSelect)
                    }
                item("separator:$serverKey") { SourceSeparator() }
            }
            if (local.isNotEmpty()) {
                item("folders-heading") {
                    FolderSectionHeader("Folders", localOpen, { localOpen = !localOpen }, onFolder)
                }
                if (localOpen)
                    items(tree.entries(local), key = { it.rowKey }) { entry ->
                        SourceFolderRow(entry, state, tree, onSelect)
                    }
                item("folders-separator") { SourceSeparator() }
            }
        }
        // Only implemented source actions are shown; device-library/Timeline remains #4623.
        SourceAction("Open photo…", Icons.Outlined.Image, onPhoto)
        if (local.isEmpty()) SourceAction("Add folder…", Icons.Outlined.CreateNewFolder, onFolder)
        SourceAction("Add Maple Cloud server", Icons.Outlined.Cloud, onCloud)
        Spacer(Modifier.height(8.dp))
    }
}

@Composable
private fun SourceFolderRow(
    entry: FolderTreeEntry,
    state: MapleState,
    tree: FolderTree,
    onSelect: (FolderTreeEntry) -> Unit,
) {
    val selected = entry.folder.uri == state.folder?.uri
    val open = tree.expanded[entry.key] == true
    val expandable = tree.children[entry.key]?.isNotEmpty() != false
    // Cloud server itself is a section header, not another level of folder indentation.
    val depth =
        entry.ancestors.count {
            it.uri.getQueryParameter("address") != null || !CloudLibrary.isCloud(it.uri)
        }
    Row(
        Modifier.fillMaxWidth()
            .testTag("folder-row:${entry.folder.uri}")
            .background(if (selected) MapleColors.raised else MapleColors.sidebar)
            .drawBehind {
                if (selected) drawRect(MapleColors.primary, size = Size(2.dp.toPx(), size.height))
            }
            .padding(start = 8.dp + 16.dp * depth, end = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (expandable)
            IconButton(
                { tree.toggle(entry.folder) },
                Modifier.width(28.dp).height(44.dp).semantics {
                    stateDescription = if (open) "Expanded" else "Collapsed"
                },
            ) {
                Icon(
                    painterResource(
                        if (open) R.drawable.nav_expand_more else R.drawable.nav_chevron_right
                    ),
                    "${if (open) "Collapse" else "Expand"} folder ${entry.folder.name}",
                    Modifier.size(16.dp),
                    tint = MapleColors.muted,
                )
            }
        else Spacer(Modifier.width(28.dp))
        Row(
            Modifier.weight(1f)
                .heightIn(min = 44.dp)
                .selectable(selected, role = Role.Button) {
                    tree.open(entry.folder)
                    onSelect(entry)
                }
                .padding(vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Icon(
                painterResource(R.drawable.nav_folder),
                null,
                Modifier.size(16.dp),
                tint = MapleColors.muted,
            )
            Text(
                entry.folder.name,
                Modifier.weight(1f),
                fontFamily = FolderFont,
                fontSize = 14.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (tree.loading[entry.key] == true)
                CircularProgressIndicator(
                    Modifier.size(12.dp),
                    strokeWidth = 1.dp,
                    color = MapleColors.muted,
                )
        }
    }
    if (open) FolderLoadError(tree, entry.folder)
}

@Composable
private fun FolderSectionHeader(
    label: String,
    open: Boolean,
    onToggle: () -> Unit,
    onAdd: (() -> Unit)? = null,
) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Row(
            Modifier.weight(1f)
                .heightIn(min = 44.dp)
                .clickable(
                    onClickLabel = "${if (open) "Collapse" else "Expand"} $label",
                    onClick = onToggle,
                )
                .padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(
                painterResource(
                    if (open) R.drawable.nav_expand_more else R.drawable.nav_chevron_right
                ),
                null,
                Modifier.size(14.dp),
                tint = MapleColors.muted,
            )
            Text(
                label.uppercase(),
                fontSize = 10.sp,
                letterSpacing = 1.4.sp,
                color = MapleColors.muted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (onAdd != null) MuiIconButton("Add folder", Icons.Outlined.Add, onClick = onAdd)
    }
}

@Composable
private fun FolderLoadError(tree: FolderTree, folder: Folder) {
    val message = tree.errors[folder.uri.toString()] ?: return
    TextButton({ tree.load(folder) }, Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        Text("Retry folders in ${folder.name}: $message", fontFamily = FolderFont, fontSize = 12.sp)
    }
}

@Composable
private fun SourceAction(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    onClick: () -> Unit,
) {
    TextButton(
        onClick,
        Modifier.fillMaxWidth().heightIn(min = 44.dp),
        contentPadding = PaddingValues(horizontal = 16.dp),
    ) {
        Icon(icon, null, Modifier.size(16.dp), tint = MapleColors.muted)
        Spacer(Modifier.width(10.dp))
        Text(
            label,
            Modifier.weight(1f),
            fontFamily = FolderFont,
            fontSize = 14.sp,
            color = MapleColors.text,
        )
    }
}

@Composable
private fun SourceSeparator() {
    HorizontalDivider(
        Modifier.padding(vertical = 4.dp),
        thickness = .5.dp,
        color = MapleColors.border,
    )
}
