package app.justmaple.aperture.cloud

import android.net.Uri
import app.justmaple.aperture.data.Folder
import app.justmaple.aperture.data.Photo
import app.justmaple.aperture.data.PhotoLibrary
import java.time.LocalDate
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.json.JSONObject

/** Single-select date presets with the from/to strings `SearchFilterPanel+VM.swift` sends. */
enum class SearchDatePreset(val label: String) {
    Today("Today"),
    Last7("Last 7 days"),
    Last30("Last 30 days"),
    ThisYear("This year");

    fun range(today: LocalDate): Pair<String, String> =
        when (this) {
            Today -> today.toString() to today.toString()
            Last7 -> today.minusDays(6).toString() to today.toString()
            Last30 -> today.minusDays(29).toString() to today.toString()
            ThisYear -> "%04d-01-01".format(today.year) to today.toString()
        }
}

data class CloudSearchQuery(
    val text: String = "",
    val date: SearchDatePreset? = null,
    val people: Set<String> = emptySet(),
    val places: Set<String> = emptySet(),
)

data class SearchFacet(val value: String, val count: Int)

/** Where the next page starts: a capture-time cursor, or a ranked page with its pin. */
internal data class SearchContinuation(val cursor: String?, val page: Int, val rankPin: String?)

internal data class CloudSearchPage(
    val photos: List<Photo>,
    val total: Int,
    val dropped: Int,
    val openEnded: Boolean,
    val next: SearchContinuation?,
)

/**
 * Never sends `stack=1`: the server answers unfolded, so a RAW+JPEG pair is two
 * results here and a row's `stack.companion` (present only on folded answers) is ignored.
 */
internal object CloudSearchWire {
    const val LIMIT = 200

    private fun filters(query: CloudSearchQuery, today: LocalDate): List<Pair<String, String>> =
        buildList {
            // `placeQuery` is the search box's natural-language field (ranked, dates, places),
            // as on Apple; `q` is only a filename substring.
            query.text.trim().takeIf { it.isNotEmpty() }?.let { add("placeQuery" to it) }
            query.date?.range(today)?.let { (from, to) ->
                add("from" to from)
                add("to" to to)
            }
            if (query.people.isNotEmpty()) add("people" to query.people.sorted().joinToString(","))
            if (query.places.isNotEmpty()) add("place" to query.places.sorted().joinToString("|"))
        }

    private fun path(route: String, params: List<Pair<String, String>>) =
        route + params.joinToString("&", "?") { (key, value) -> "$key=${Uri.encode(value)}" }

    fun searchPath(query: CloudSearchQuery, today: LocalDate, from: SearchContinuation?): String =
        path(
            "/api/search",
            filters(query, today) +
                ("limit" to LIMIT.toString()) +
                when {
                    from == null -> emptyList()
                    from.cursor != null -> listOf("cursor" to from.cursor)
                    else -> listOfNotNull("page" to from.page.toString(), from.rankPin?.let { "rankPin" to it })
                },
        )

    fun facetsPath(query: CloudSearchQuery, today: LocalDate): String =
        path("/api/search/facets", filters(query, today) + ("limit" to LIMIT.toString()))

    /** Rows without a registered library address cannot be opened and are dropped. */
    fun parsePage(serverId: String, json: JSONObject, page: Int): CloudSearchPage {
        val rows = json.optJSONArray("results")
        val count = rows?.length() ?: 0
        val photos =
            (0 until count).mapNotNull { index ->
                val row = rows!!.getJSONObject(index)
                val address = row.optString("address").takeIf { it.isNotEmpty() && it != "null" && ':' in it }
                val name = row.optString("filename")
                val path = row.optString("abs_path")
                if (address == null || path.isEmpty() ||
                    name.substringAfterLast('.', "").lowercase() !in PhotoLibrary.EXTENSIONS
                ) return@mapNotNull null
                val folderAddress =
                    address.substringBeforeLast('/', "").ifEmpty { address.substringBefore(':') + ":" }
                Photo(
                    CloudLibrary.address(serverId, address, path),
                    name,
                    row.optLong("size"),
                    row.optLong("mtime"),
                    CloudLibrary.address(serverId, folderAddress, path.substringBeforeLast('/')),
                )
            }
        val cursorPaging = json.optBoolean("cursorPaging")
        val cursor = json.optString("nextCursor").takeIf { it.isNotEmpty() && it != "null" }
        val more = json.optBoolean("more") || json.optBoolean("capped")
        val total = json.optInt("total")
        val ranked = json.optString("rankPin").takeIf { it.isNotEmpty() && it != "null" }
        val next =
            when {
                cursorPaging -> cursor?.let { SearchContinuation(it, 0, null) }
                (page + 1) * LIMIT < total || more -> SearchContinuation(null, page + 1, ranked)
                else -> null
            }
        return CloudSearchPage(photos, total, count - photos.size, ranked != null && more, next?.takeIf { count > 0 })
    }

    fun parseFacets(json: JSONObject, key: String): List<SearchFacet> {
        val rows = json.optJSONArray(key) ?: return emptyList()
        return (0 until rows.length()).mapNotNull { index ->
            val row = rows.getJSONObject(index)
            row.optString("value").takeIf { it.isNotEmpty() && it != "null" }?.let { SearchFacet(it, row.optInt("count")) }
        }
    }
}

data class CloudSearchState(
    val server: Folder? = null,
    val query: CloudSearchQuery = CloudSearchQuery(),
    val results: List<Photo> = emptyList(),
    val total: Int = 0,
    val openEnded: Boolean = false,
    val canLoadMore: Boolean = false,
    val loading: Boolean = false,
    val people: List<SearchFacet> = emptyList(),
    val places: List<SearchFacet> = emptyList(),
    val error: String? = null,
)

/**
 * The account-wide search behind the Search tab for one connected server.
 * Typing debounces; filter taps search immediately. A ranked page whose engine
 * changed (409 `rank_engine_changed`) restarts from page 0 without its pin.
 */
internal class CloudSearchModel(
    private val scope: CoroutineScope,
    private val today: () -> LocalDate = LocalDate::now,
    private val fetch: suspend (server: String, path: String) -> CloudResponse,
) {
    private val mutable = MutableStateFlow(CloudSearchState())
    val state: StateFlow<CloudSearchState> = mutable.asStateFlow()
    private var job: Job? = null
    private var next: SearchContinuation? = null
    private var dropped = 0

    fun selectServer(server: Folder?) {
        if (server?.uri == mutable.value.server?.uri) return
        job?.cancel()
        next = null
        mutable.value = CloudSearchState(server = server, query = mutable.value.query)
        if (server != null) restart(0)
    }

    fun setText(text: String) = update(mutable.value.query.copy(text = text), debounceMillis = 350)

    fun setDate(date: SearchDatePreset?) = update(mutable.value.query.copy(date = date))

    fun togglePerson(name: String) =
        mutable.value.query.let { update(it.copy(people = it.people.toggle(name))) }

    fun togglePlace(label: String) =
        mutable.value.query.let { update(it.copy(places = it.places.toggle(label))) }

    fun loadMore() {
        val from = next ?: return
        if (mutable.value.loading) return
        run(from, debounceMillis = 0)
    }

    private fun Set<String>.toggle(value: String) = if (value in this) this - value else this + value

    private fun update(query: CloudSearchQuery, debounceMillis: Long = 0) {
        if (query == mutable.value.query) return
        mutable.update { it.copy(query = query) }
        restart(debounceMillis)
    }

    private fun restart(debounceMillis: Long) {
        next = null
        run(null, debounceMillis)
    }

    private fun run(from: SearchContinuation?, debounceMillis: Long) {
        val server = mutable.value.server ?: return
        val serverId = server.uri.host ?: return
        job?.cancel()
        job = scope.launch {
            if (debounceMillis > 0) delay(debounceMillis)
            mutable.update { it.copy(loading = true, error = null) }
            val query = mutable.value.query
            try {
                val response = fetch(serverId, CloudSearchWire.searchPath(query, today(), from))
                if (from?.rankPin != null && response.status == 409 &&
                    JSONObject(response.text()).optString("code") == "rank_engine_changed"
                ) {
                    next = null
                    mutable.update { it.copy(results = emptyList()) }
                    job = null
                    run(null, 0)
                    return@launch
                }
                val page = CloudSearchWire.parsePage(serverId, JSONObject(response.requireSuccess().text()), from?.page ?: 0)
                val facets = if (from == null) facets(serverId, query) else null
                next = page.next
                dropped = (if (from == null) 0 else dropped) + page.dropped
                mutable.update {
                    val results =
                        if (from == null) page.photos else (it.results + page.photos).distinctBy { photo -> photo.uri }
                    it.copy(
                        results = results,
                        // The server counts rows this client cannot open; once every page is in, the list is the count.
                        total = if (page.next == null) results.size else (page.total - dropped).coerceAtLeast(results.size),
                        openEnded = page.openEnded,
                        canLoadMore = page.next != null,
                        loading = false,
                        people = if (from == null) facets?.let { json -> CloudSearchWire.parseFacets(json, "people") }.orEmpty() else it.people,
                        places = if (from == null) facets?.let { json -> CloudSearchWire.parseFacets(json, "places") }.orEmpty() else it.places,
                    )
                }
            } catch (failure: Exception) {
                if (failure is CancellationException) throw failure
                if (from == null) next = null
                mutable.update {
                    val failed = it.copy(loading = false, error = failure.message ?: "Search failed")
                    // A failed new search must not leave the previous query's results under it.
                    if (from == null) failed.copy(results = emptyList(), total = 0, openEnded = false, canLoadMore = false)
                    else failed
                }
            }
        }
    }

    /** Facets only decorate the filters: their failure never discards a page that arrived. */
    private suspend fun facets(serverId: String, query: CloudSearchQuery): JSONObject? =
        try {
            JSONObject(fetch(serverId, CloudSearchWire.facetsPath(query, today())).requireSuccess().text())
        } catch (failure: Exception) {
            if (failure is CancellationException) throw failure
            null
        }
}
