package app.justmaple.aperture.cloud

import app.justmaple.aperture.data.Folder
import app.justmaple.aperture.data.Photo
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.YearMonth
import java.time.ZoneOffset
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.json.JSONObject

data class TimelineOwner(val id: String, val label: String)
data class TimelineMonth(val month: YearMonth, val count: Int, val photos: List<Photo>)

data class CloudTimelineState(
    val server: Folder? = null,
    val owner: String? = null,
    val owners: List<TimelineOwner> = emptyList(),
    val months: List<TimelineMonth> = emptyList(),
    val photos: List<Photo> = emptyList(),
    val canLoadMore: Boolean = false,
    val loading: Boolean = false,
    val error: String? = null,
    val ownersError: String? = null,
)

internal data class TimelinePage(val rows: List<Pair<Photo, YearMonth>>, val next: SearchContinuation?)

internal object CloudTimelineWire {
    private fun owner(owner: String?) = listOfNotNull(owner?.let { "owner" to it })

    fun pagePath(owner: String?, from: SearchContinuation?, fold: Boolean = false): String =
        CloudSearchWire.path(
            "/api/search",
            listOf(
                "sort" to "captured_desc",
                "hasCapturedAt" to "true",
                "limit" to CloudSearchWire.LIMIT.toString(),
            ) + owner(owner) + CloudSearchWire.stack(fold) + when {
                from == null -> emptyList()
                from.cursor != null -> listOf("cursor" to from.cursor)
                else -> listOf("page" to from.page.toString())
            },
        )

    fun bucketsPath(owner: String?, fold: Boolean = false): String =
        CloudSearchWire.path("/api/search/buckets", listOf("hasCapturedAt" to "true") + owner(owner) + CloudSearchWire.stack(fold))

    fun ownersPath(fold: Boolean = false): String =
        CloudSearchWire.path("/api/search/facets", listOf("hasCapturedAt" to "true", "limit" to "200") + CloudSearchWire.stack(fold))

    // Capture buckets use UTC, not the phone's timezone or the timestamp's original offset.
    fun captureMonth(value: String): YearMonth? =
        runCatching { YearMonth.from(OffsetDateTime.parse(value).withOffsetSameInstant(ZoneOffset.UTC)) }
            .recoverCatching { YearMonth.from(LocalDateTime.parse(value)) }
            .getOrNull()

    fun parsePage(serverId: String, json: JSONObject, page: Int = 0, fold: Boolean = false): TimelinePage {
        val rows = json.optJSONArray("results")
        val count = rows?.length() ?: 0
        val photos = (0 until count).mapNotNull { index ->
            val row = rows!!.getJSONObject(index)
            val month = captureMonth(row.optString("captured_at"))
            val photo = CloudSearchWire.photo(serverId, row, fold)
            if (month == null || photo == null) null else photo to month
        }
        val next = CloudSearchWire.continuation(json, page, count)
        return TimelinePage(photos, next)
    }

    fun parseBuckets(json: JSONObject): Map<YearMonth, Int> {
        val rows = json.optJSONArray("buckets") ?: return emptyMap()
        return (0 until rows.length()).associate { index ->
            val row = rows.getJSONObject(index)
            YearMonth.of(row.getInt("year"), row.getInt("month")) to row.optInt("count")
        }
    }

    fun parseOwners(json: JSONObject, me: String?): List<TimelineOwner> {
        val rows = json.optJSONArray("owners")
        val members = (0 until (rows?.length() ?: 0)).mapNotNull { index ->
            val row = rows!!.getJSONObject(index)
            val id = row.optString("id").takeIf { it.isNotEmpty() && it != "null" && it != me }
            id?.let { TimelineOwner(it, row.optString("email").takeIf { email -> email.isNotEmpty() && email != "null" } ?: it) }
        }
        return listOfNotNull(me?.takeIf(String::isNotEmpty)?.let { TimelineOwner(it, "Only my uploads") }) + members
    }

    fun months(rows: List<Pair<Photo, YearMonth>>, counts: Map<YearMonth, Int>): List<TimelineMonth> =
        rows.groupBy({ it.second }, { it.first }).toSortedMap(compareByDescending { it }).map { (month, photos) ->
            TimelineMonth(month, maxOf(counts[month] ?: 0, photos.size), photos)
        }
}

internal class CloudTimelineModel(
    private val scope: CoroutineScope,
    private val userId: (server: String) -> String?,
    private val fold: suspend (server: String) -> Boolean = { false },
    private val fetch: suspend (server: String, path: String) -> CloudResponse,
) {
    private val mutable = MutableStateFlow(CloudTimelineState())
    val state: StateFlow<CloudTimelineState> = mutable.asStateFlow()
    private var job: Job? = null
    private var generation = 0
    private var rows: List<Pair<Photo, YearMonth>> = emptyList()
    private var counts: Map<YearMonth, Int> = emptyMap()
    private var next: SearchContinuation? = null
    private var folded = false

    fun selectServer(server: Folder?) {
        if (server?.uri != mutable.value.server?.uri) start(server, null)
    }

    fun signedIn(server: Folder) {
        if (server.uri == mutable.value.server?.uri) start(server, null)
    }

    fun setOwner(owner: String?) {
        if (owner != mutable.value.owner) start(mutable.value.server, owner)
    }

    fun onlyMine() {
        mutable.value.server?.uri?.host?.let(userId)?.takeIf(String::isNotEmpty)?.let(::setOwner)
    }

    fun refresh() = start(mutable.value.server, mutable.value.owner)

    fun retry() {
        if (rows.isNotEmpty() && next != null) run(next) else refresh()
    }

    fun loadMore() {
        if (!mutable.value.loading) next?.let(::run)
    }

    private fun start(server: Folder?, owner: String?) {
        ++generation
        job?.cancel()
        rows = emptyList()
        counts = emptyMap()
        next = null
        val me = server?.uri?.host?.let(userId)
        mutable.value = CloudTimelineState(server = server, owner = owner,
            owners = CloudTimelineWire.parseOwners(JSONObject(), me))
        if (server != null) run(null)
    }

    private fun run(from: SearchContinuation?) {
        val serverId = mutable.value.server?.uri?.host ?: return
        val owner = mutable.value.owner
        val request = ++generation
        job?.cancel()
        mutable.update { it.copy(loading = true, error = null) }
        job = scope.launch {
            try {
                if (from == null) folded = fold(serverId)
                val page = CloudTimelineWire.parsePage(serverId,
                    JSONObject(fetch(serverId, CloudTimelineWire.pagePath(owner, from, folded)).requireSuccess().text()), from?.page ?: 0, folded)
                val buckets = if (from == null) optional(serverId, CloudTimelineWire.bucketsPath(owner, folded)) else null
                val owners = if (from == null) optional(serverId, CloudTimelineWire.ownersPath(folded)) else null
                if (request != generation) return@launch
                if (from == null) counts = buckets?.let(CloudTimelineWire::parseBuckets).orEmpty()
                rows = (rows + page.rows).distinctBy { it.first.uri }
                next = page.next
                mutable.update {
                    it.copy(
                        months = CloudTimelineWire.months(rows, counts),
                        photos = rows.map { row -> row.first },
                        canLoadMore = next != null,
                        loading = false,
                        owners = if (from == null) CloudTimelineWire.parseOwners(owners ?: JSONObject(), userId(serverId)) else it.owners,
                        ownersError = if (from == null && owners == null) "Could not load owners" else it.ownersError,
                    )
                }
            } catch (failure: Exception) {
                if (failure is CancellationException) throw failure
                if (request == generation)
                    mutable.update { it.copy(loading = false, error = failure.message ?: "Could not load Timeline") }
            }
        }
    }

    private suspend fun optional(serverId: String, path: String): JSONObject? =
        try {
            JSONObject(fetch(serverId, path).requireSuccess().text())
        } catch (failure: Exception) {
            if (failure is CancellationException) throw failure
            null
        }
}
