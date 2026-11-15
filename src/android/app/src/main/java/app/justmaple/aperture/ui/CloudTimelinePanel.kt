package app.justmaple.aperture.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.MapleState
import app.justmaple.aperture.MapleViewModel
import app.justmaple.aperture.cloud.CloudTimelineModel
import app.justmaple.aperture.cloud.CloudTimelineState
import app.justmaple.aperture.data.Folder
import java.time.format.DateTimeFormatter
import java.util.Locale

@Composable
internal fun CloudTimelinePanel(
    timeline: CloudTimelineModel,
    state: CloudTimelineState,
    servers: List<Folder>,
    model: MapleViewModel,
    photoState: MapleState,
    onConnect: () -> Unit,
) {
    if (servers.isEmpty()) {
        MuiEmptyState("Your cloud Timeline", "Connect a Maple server to browse photos by capture date.",
            "Add Maple Cloud server", onConnect)
        return
    }
    Column(Modifier.fillMaxSize()) {
        FlowRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (servers.size > 1)
                TimelineSelect("Timeline server", state.server?.name ?: "Select server",
                    servers.map { it.uri.toString() to it.name }) { value ->
                    servers.find { it.uri.toString() == value }?.let(timeline::selectServer)
                }
            TimelineSelect("Timeline owner", state.owners.find { it.id == state.owner }?.label ?: state.owner ?: "All owners",
                listOf("" to "All owners") + state.owners.map { it.id to it.label }) {
                timeline.setOwner(it.takeIf(String::isNotEmpty))
            }
            MuiIconButton("Refresh timeline", Icons.Outlined.Refresh, enabled = !state.loading,
                testTag = "timeline-refresh", onClick = timeline::refresh)
        }
        state.ownersError?.let {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(it, Modifier.weight(1f), color = MapleColors.error)
                TextButton(timeline::refresh, enabled = !state.loading) { Text("Retry owners") }
            }
        }
        state.error?.let {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(it, Modifier.weight(1f).testTag("timeline-error"), color = MapleColors.error)
                TextButton(timeline::retry, Modifier.testTag("timeline-retry"), enabled = !state.loading) {
                    Text("Retry timeline")
                }
            }
        }
        if (state.photos.isEmpty()) {
            Box(Modifier.weight(1f).fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                when {
                    state.loading || state.server == null -> CircularProgressIndicator(
                        Modifier.testTag("timeline-loading").semantics { contentDescription = "Loading timeline" },
                        color = MapleColors.primary)
                    state.error == null -> Text(if (state.owner == null) "No photos" else "No photos match this owner",
                        Modifier.testTag("timeline-empty"), color = MapleColors.muted)
                }
            }
            if (state.canLoadMore && !state.loading && state.error == null)
                TextButton(timeline::loadMore, Modifier.align(Alignment.CenterHorizontally).testTag("timeline-more")) {
                    Text("Show more photos")
                }
        } else {
            val grid = rememberSaveable(state.server?.uri, state.owner, saver = LazyGridState.Saver) { LazyGridState() }
            val format = remember(Locale.getDefault()) { DateTimeFormatter.ofPattern("MMMM yyyy") }
            LazyVerticalGrid(GridCells.Adaptive(100.dp), Modifier.weight(1f).testTag("timeline-grid"),
                state = grid, contentPadding = PaddingValues(4.dp),
                horizontalArrangement = Arrangement.spacedBy(3.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                state.months.forEach { month ->
                    item(key = "month:${month.month}", span = { GridItemSpan(maxLineSpan) }) {
                        Text("${month.month.format(format)} · ${month.count} photos",
                            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 12.dp)
                                .testTag("timeline-month-${month.month}").semantics { heading() },
                            color = MapleColors.text, style = MaterialTheme.typography.titleMedium)
                    }
                    items(month.photos, key = { it.uri.toString() }) { photo ->
                        PhotoThumbnail(photo, model.library,
                            Modifier.aspectRatio(1f).testTag("timeline-photo-${photo.name}")
                                .semantics { contentDescription = "Open ${photo.name}" }
                                .clickable(role = Role.Button, onClickLabel = "Open photo") {
                                    model.openFromBrowse(photo, state.photos)
                                },
                            revision = photoState.document.original.takeIf { photo == photoState.selected })
                    }
                }
                item(key = "paging", span = { GridItemSpan(maxLineSpan) }) {
                    Box(Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) {
                        if (state.loading) CircularProgressIndicator(
                            Modifier.size(24.dp).semantics { contentDescription = "Loading more photos" }, color = MapleColors.primary)
                        else if (state.canLoadMore && state.error == null)
                            TextButton(timeline::loadMore, Modifier.testTag("timeline-more")) { Text("Show more photos") }
                    }
                }
            }
        }
    }
}

@Composable
private fun TimelineSelect(label: String, selected: String, choices: List<Pair<String, String>>, onSelect: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        OutlinedButton({ expanded = true }, Modifier.semantics { contentDescription = label }) { Text(selected) }
        DropdownMenu(expanded, { expanded = false }) {
            choices.forEach { (value, name) ->
                DropdownMenuItem(text = { Text(name) }, onClick = { expanded = false; onSelect(value) })
            }
        }
    }
}
