package app.justmaple.aperture.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.justmaple.aperture.cloud.CloudSearchState
import app.justmaple.aperture.cloud.SearchDatePreset
import app.justmaple.aperture.cloud.SearchFacet
import app.justmaple.aperture.data.Folder
import java.text.NumberFormat

/** Result count label; a ranked text window is open-ended ("5,000+"), as on iPad. */
internal fun searchCountLabel(state: CloudSearchState): String {
    val count = NumberFormat.getIntegerInstance().format(state.total)
    return if (state.openEnded) "$count+ photos" else if (state.total == 1) "1 photo" else "$count photos"
}

/**
 * The iPhone Search tab's server half: query, Date/People/Places filters and the
 * result count over the shared browse grid, for the selected connected server.
 */
@Composable
internal fun CloudSearchHeader(
    search: CloudSearchState,
    servers: List<Folder>,
    onServer: (Folder) -> Unit,
    onText: (String) -> Unit,
    onDate: (SearchDatePreset?) -> Unit,
    onPerson: (String) -> Unit,
    onPlace: (String) -> Unit,
    onMore: () -> Unit,
) {
    var text by rememberSaveable { mutableStateOf(search.query.text) }
    LaunchedEffect(servers.map { it.uri }) {
        // After a process death the box restores its text but the new model's query is empty:
        // hand it the text before the server selection searches, never an unfiltered library.
        if (text != search.query.text) onText(text)
        if (search.server == null || servers.none { it.uri == search.server.uri }) servers.firstOrNull()?.let(onServer)
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("cloud-search")) {
        OutlinedTextField(
            text,
            {
                text = it
                onText(it)
            },
            Modifier.fillMaxWidth().padding(top = 12.dp).testTag("cloud-search-query"),
            placeholder = { Text("Search your library") },
            singleLine = true,
            leadingIcon = { Icon(Icons.Outlined.Search, null) },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { onText(text) }),
        )
        if (servers.size > 1)
            ChipRow("Server") {
                servers.forEach { server ->
                    FilterChip(server.uri == search.server?.uri, { onServer(server) }, { Text(server.name) },
                        Modifier.testTag("cloud-search-server-${server.name}"))
                }
            }
        ChipRow("Date") {
            SearchDatePreset.entries.forEach { preset ->
                FilterChip(
                    search.query.date == preset,
                    { onDate(if (search.query.date == preset) null else preset) },
                    { Text(preset.label) },
                    Modifier.testTag("cloud-search-date-${preset.name}"),
                )
            }
        }
        FacetRow("People", search.people, search.query.people, onPerson)
        FacetRow("Places", search.places, search.query.places, onPlace)
        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                when {
                    search.error != null -> search.error
                    search.loading && search.results.isEmpty() -> "Searching…"
                    else -> searchCountLabel(search)
                },
                Modifier.weight(1f).testTag("cloud-search-count"),
                color = if (search.error != null) MapleColors.error else MapleColors.muted,
                fontSize = 12.sp,
            )
            if (search.loading) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 1.5.dp, color = MapleColors.primary)
            if (search.canLoadMore && !search.loading)
                TextButton(onMore, Modifier.testTag("cloud-search-more")) { Text("Show more") }
        }
    }
}

/**
 * Results, or what stands in for them: a search that is loading or failed never
 * looks like an empty library (the browse grid's "Open folder" state).
 */
@Composable
internal fun CloudSearchBody(search: CloudSearchState, results: @Composable () -> Unit) {
    if (search.results.isNotEmpty()) {
        results()
        return
    }
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        when {
            search.loading || search.server == null ->
                CircularProgressIndicator(Modifier.testTag("cloud-search-loading"), color = MapleColors.primary)
            search.error != null ->
                Text(search.error, Modifier.testTag("cloud-search-error"), color = MapleColors.error)
            else -> Text("No matching photos", Modifier.testTag("cloud-search-empty"), color = MapleColors.muted)
        }
    }
}

@Composable
private fun ChipRow(label: String, chips: @Composable RowScope.() -> Unit) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label.uppercase(), fontSize = 10.sp, color = MapleColors.muted, modifier = Modifier.width(56.dp))
        chips()
    }
}

/** Facets in count order; a selected value missing from the current facets stays removable. */
@Composable
private fun FacetRow(label: String, facets: List<SearchFacet>, selected: Set<String>, onToggle: (String) -> Unit) {
    val orphans = selected.filter { value -> facets.none { it.value == value } }.map { SearchFacet(it, 0) }
    val rows = orphans + facets
    if (rows.isEmpty()) return
    ChipRow(label) {
        rows.forEach { facet ->
            FilterChip(
                facet.value in selected,
                { onToggle(facet.value) },
                { Text(if (facet.count > 0) "${facet.value} · ${facet.count}" else facet.value) },
                Modifier.testTag("cloud-search-${label.lowercase()}-${facet.value}"),
            )
        }
    }
}
