package app.justmaple.aperture.cloud

import android.net.Uri
import app.justmaple.aperture.data.Folder
import java.time.YearMonth
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class CloudTimelineTest {
    private val server = Folder(Uri.parse("maple-cloud://server-1"), "photos.example.com")
    private val otherServer = Folder(Uri.parse("maple-cloud://server-2"), "other.example.com")

    private fun row(name: String, captured: String = "2026-03-10T12:00:00Z") =
        JSONObject()
            .put("address", "lib:2026/$name")
            .put("abs_path", "/srv/photos/2026/$name")
            .put("filename", name)
            .put("size", 2048)
            .put("mtime", 1_700_000_000_000)
            .put("captured_at", captured)

    private fun page(vararg rows: JSONObject, next: String? = null) =
        JSONObject().put("results", JSONArray(rows.toList()))
            .put("cursorPaging", true).put("nextCursor", next ?: JSONObject.NULL)

    private fun response(body: JSONObject = JSONObject(), status: Int = 200) =
        CloudResponse(status, body.toString().toByteArray(), null, null)

    private fun params(path: String) = Uri.parse("https://x$path").let { uri ->
        uri.queryParameterNames.associateWith { uri.getQueryParameter(it)!! }
    }

    private fun isPage(path: String) = path.substringBefore('?') == "/api/search"

    @Test
    fun requestsNewestCapturedPhotosAndUnfilteredOwnerFacetsWithoutStacking() = runTest {
        val requests = mutableListOf<String>()
        val model = CloudTimelineModel(this, { "me" }) { id, path ->
            assertEquals("server-1", id)
            requests += path
            response(if (isPage(path)) page(row("a.dng")) else JSONObject())
        }
        model.selectServer(server)
        advanceUntilIdle()
        assertEquals(3, requests.size)
        val query = params(requests.single(::isPage))
        assertEquals("captured_desc", query["sort"])
        assertEquals("true", query["hasCapturedAt"])
        assertEquals("200", query["limit"])
        assertNull(query["cursor"])
        requests.forEach {
            assertEquals("true", params(it)["hasCapturedAt"])
            assertNull(params(it)["stack"])
            assertNull(params(it)["owner"])
        }
        val photo = model.state.value.photos.single()
        assertEquals("server-1", photo.uri.host)
        assertEquals("/api/image/lib/2026/a.dng", CloudLibrary.mediaPath("image", photo.uri))
        assertEquals("/srv/photos/2026/a.dng", photo.uri.getQueryParameter("path"))
        assertEquals("lib:2026", photo.parent!!.getQueryParameter("address"))
        assertFalse(model.state.value.loading)
        assertNull(model.state.value.error)
    }

    @Test
    fun cursorPagesAppendUniquePhotosAndStopWithoutNextCursorDespiteTotalOrMore() = runTest {
        val searches = mutableListOf<String>()
        val model = CloudTimelineModel(this, { "me" }) { _, path ->
            if (!isPage(path)) response() else {
                searches += path
                response(if (params(path)["cursor"] == null)
                    page(row("a.dng"), next = "capture +/=&")
                else page(row("a.dng"), row("b.jpg"))
                    .put("total", 999).put("more", true))
            }
        }
        model.selectServer(server)
        advanceUntilIdle()
        assertTrue(model.state.value.canLoadMore)
        model.loadMore()
        advanceUntilIdle()
        assertEquals("capture +/=&", params(searches.last())["cursor"])
        assertNull(params(searches.last())["page"])
        assertEquals(listOf("a.dng", "b.jpg"), model.state.value.photos.map { it.name })
        assertEquals(2, model.state.value.months.single().count)
        assertFalse(model.state.value.canLoadMore)
        model.loadMore()
        advanceUntilIdle()
        assertEquals(2, searches.size)
    }

    @Test
    fun nonCursorResponsesFallBackToPageNumbersUsingTotalAndMore() = runTest {
        val searches = mutableListOf<String>()
        val model = CloudTimelineModel(this, { null }) { _, path ->
            if (!isPage(path)) response() else {
                searches += path
                val number = params(path)["page"]?.toInt() ?: 0
                response(page(row("p$number.dng")).put("cursorPaging", false)
                    .put("total", if (number == 0) 201 else 0)
                    .put("more", number == 1))
            }
        }
        model.selectServer(server)
        advanceUntilIdle()
        assertTrue(model.state.value.canLoadMore)
        model.loadMore()
        advanceUntilIdle()
        assertEquals("1", params(searches.last())["page"])
        assertTrue(model.state.value.canLoadMore)
        model.loadMore()
        advanceUntilIdle()
        assertEquals("2", params(searches.last())["page"])
        assertTrue(searches.all { params(it)["cursor"] == null })
        assertEquals(listOf("p0.dng", "p1.dng", "p2.dng"), model.state.value.photos.map { it.name })
        assertFalse(model.state.value.canLoadMore)
    }

    @Test
    fun emptyPageStopsEvenWhenServerClaimsMore() = runTest {
        var searches = 0
        val model = CloudTimelineModel(this, { null }) { _, path ->
            response(if (isPage(path)) {
                searches++
                page(next = "again").put("more", true).put("total", 500)
            } else JSONObject())
        }
        model.selectServer(server)
        advanceUntilIdle()
        model.loadMore()
        advanceUntilIdle()
        assertEquals(1, searches)
        assertFalse(model.state.value.canLoadMore)
        assertTrue(model.state.value.months.isEmpty())
    }

    @Test
    fun utcMonthBoundariesUseServerCountsAndNewestFirstLoadedMonthOrder() = runTest {
        val model = CloudTimelineModel(this, { null }) { _, path ->
            response(when {
                isPage(path) -> page(
                    row("march.dng", "2026-03-01T00:30:00-02:00"),
                    row("february.dng", "2026-03-01T00:30:00+02:00"),
                    row("february-local.jpg", "2026-02-15T12:00:00"),
                    row("january.jpg", "2026-01-31T23:59:59Z"),
                )
                path.startsWith("/api/search/buckets") -> JSONObject("""{"buckets":[
                    {"year":2026,"month":1,"count":0},
                    {"year":2026,"month":2,"count":12},
                    {"year":2026,"month":3,"count":5}] }""")
                else -> JSONObject()
            })
        }
        model.selectServer(server)
        advanceUntilIdle()
        val months = model.state.value.months
        assertEquals(listOf(YearMonth.of(2026, 3), YearMonth.of(2026, 2), YearMonth.of(2026, 1)), months.map { it.month })
        assertEquals(listOf(5, 12, 1), months.map { it.count })
        assertEquals(listOf("february.dng", "february-local.jpg"), months[1].photos.map { it.name })
        assertEquals(model.state.value.photos, months.flatMap { it.photos })
    }

    @Test
    fun missingInvalidCaptureAndUnopenableRowsAreDroppedWithoutStoppingCursor() = runTest {
        val model = CloudTimelineModel(this, { null }) { _, path ->
            response(if (isPage(path)) page(
                row("missing.dng").put("captured_at", JSONObject.NULL),
                row("invalid.dng", "not-a-date"),
                row("unaddressed.dng").put("address", JSONObject.NULL),
                row("clip.mov"),
                row("good.jpg"), next = "next",
            ) else JSONObject())
        }
        model.selectServer(server)
        advanceUntilIdle()
        assertEquals(listOf("good.jpg"), model.state.value.photos.map { it.name })
        assertEquals(1, model.state.value.months.single().count)
        assertTrue(model.state.value.canLoadMore)
    }

    @Test
    fun ownerFiltersRestartPagesAndOnlyMineUsesCurrentAccount() = runTest {
        val requests = mutableListOf<String>()
        val model = CloudTimelineModel(this, { "me" }) { _, path ->
            requests += path
            response(when {
                isPage(path) -> page(row("${params(path)["owner"] ?: "all"}.dng"), next = "next")
                path.startsWith("/api/search/facets") -> JSONObject("""{"owners":[
                    {"id":"me","email":"my@example.com"},
                    {"id":"other +&","email":"other@example.com"},
                    {"id":"no-email"},{"id":null}]}""")
                else -> JSONObject()
            })
        }
        model.selectServer(server)
        advanceUntilIdle()
        assertEquals(listOf(
            TimelineOwner("me", "Only my uploads"),
            TimelineOwner("other +&", "other@example.com"),
            TimelineOwner("no-email", "no-email"),
        ), model.state.value.owners)
        requests.clear()
        model.setOwner("other +&")
        assertTrue(model.state.value.photos.isEmpty())
        advanceUntilIdle()
        assertEquals("other +&", model.state.value.owner)
        assertTrue(requests.filter { isPage(it) || it.startsWith("/api/search/buckets") }
            .all { params(it)["owner"] == "other +&" })
        assertNull(params(requests.single(::isPage))["cursor"])
        assertEquals(listOf("other +&.dng"), model.state.value.photos.map { it.name })
        model.onlyMine()
        advanceUntilIdle()
        assertEquals("me", model.state.value.owner)
        assertEquals(listOf("me.dng"), model.state.value.photos.map { it.name })
        model.setOwner(null)
        advanceUntilIdle()
        assertNull(model.state.value.owner)
        assertEquals(listOf("all.dng"), model.state.value.photos.map { it.name })
        assertTrue(requests.filter { it.startsWith("/api/search/facets") }.all { params(it)["owner"] == null })
    }

    @Test
    fun onlyMineWithoutAnAccountDoesNotInventAnOwner() = runTest {
        val model = CloudTimelineModel(this, { null }) { _, path ->
            response(if (isPage(path)) page(row("all.dng")) else JSONObject())
        }
        model.selectServer(server)
        advanceUntilIdle()
        model.onlyMine()
        advanceUntilIdle()
        assertNull(model.state.value.owner)
        assertTrue(model.state.value.owners.isEmpty())
        assertEquals(listOf("all.dng"), model.state.value.photos.map { it.name })
    }

    @Test
    fun serverAndAccountRestartsResetOwnerAndRefetchAccountFacets() = runTest {
        var account = "ann"
        var searches = 0
        val model = CloudTimelineModel(this, { account }) { id, path ->
            response(when {
                isPage(path) -> {
                    searches++
                    page(row("$id-$account.dng"), next = "next")
                }
                path.startsWith("/api/search/facets") -> JSONObject().put("owners", JSONArray()
                    .put(JSONObject().put("id", account).put("email", "$account@example.com")))
                else -> JSONObject()
            })
        }
        model.selectServer(server)
        advanceUntilIdle()
        model.onlyMine()
        advanceUntilIdle()
        val previousSearches = searches
        model.selectServer(server)
        model.signedIn(otherServer)
        advanceUntilIdle()
        assertEquals(previousSearches, searches)
        account = "bob"
        model.signedIn(server)
        assertTrue(model.state.value.photos.isEmpty())
        advanceUntilIdle()
        assertNull(model.state.value.owner)
        assertEquals(listOf(TimelineOwner("bob", "Only my uploads")), model.state.value.owners)
        assertEquals(listOf("server-1-bob.dng"), model.state.value.photos.map { it.name })
        model.onlyMine()
        advanceUntilIdle()
        model.selectServer(otherServer)
        assertTrue(model.state.value.photos.isEmpty())
        advanceUntilIdle()
        assertNull(model.state.value.owner)
        assertEquals(listOf("server-2-bob.dng"), model.state.value.photos.map { it.name })
        assertEquals(otherServer, model.state.value.server)
        model.selectServer(null)
        assertEquals(CloudTimelineState(), model.state.value)
        model.loadMore()
        model.refresh()
        advanceUntilIdle()
        assertEquals(CloudTimelineState(), model.state.value)
    }

    @Test
    fun staleUncancellablePageCannotOverwriteRestartedTimelineOrItsContinuation() = runTest {
        lateinit var stale: Continuation<CloudResponse>
        var first = true
        val searches = mutableListOf<Pair<String, String>>()
        val model = CloudTimelineModel(this, { "me" }) { id, path ->
            if (!isPage(path)) response() else {
                searches += id to path
                if (first) {
                    first = false
                    suspendCoroutine { stale = it }
                } else response(page(row("new.dng")))
            }
        }
        model.selectServer(server)
        runCurrent()
        assertTrue(model.state.value.loading)
        model.selectServer(otherServer)
        runCurrent()
        assertEquals(listOf("new.dng"), model.state.value.photos.map { it.name })
        stale.resume(response(page(row("stale.dng"), next = "stale-cursor")))
        advanceUntilIdle()
        assertEquals(otherServer, model.state.value.server)
        assertEquals(listOf("new.dng"), model.state.value.photos.map { it.name })
        assertEquals(listOf("server-2"), model.state.value.photos.map { it.uri.host })
        assertFalse(model.state.value.canLoadMore)
        assertFalse(model.state.value.loading)
        assertNull(model.state.value.error)
        model.loadMore()
        advanceUntilIdle()
        assertEquals(2, searches.size)
    }

    @Test
    fun signingOutWhileAnUncancellableRequestFinishesKeepsStateEmpty() = runTest {
        lateinit var pending: Continuation<CloudResponse>
        val model = CloudTimelineModel(this, { "me" }) { _, path ->
            if (isPage(path)) suspendCoroutine { pending = it } else response()
        }
        model.selectServer(server)
        runCurrent()
        model.selectServer(null)
        pending.resume(response(page(row("private.dng"), next = "private")))
        advanceUntilIdle()
        assertEquals(CloudTimelineState(), model.state.value)
    }

    @Test
    fun loadingGuardsAgainstDuplicateMoreRequestsAndRefreshStartsAtFirstPage() = runTest {
        val pending = CompletableDeferred<CloudResponse>()
        val searches = mutableListOf<String>()
        val model = CloudTimelineModel(this, { "me" }) { _, path ->
            if (!isPage(path)) response() else {
                searches += path
                if (params(path)["cursor"] != null) pending.await()
                else response(page(row("first.dng"), next = "next"))
            }
        }
        model.selectServer(server)
        advanceUntilIdle()
        model.loadMore()
        runCurrent()
        assertTrue(model.state.value.loading)
        model.loadMore()
        runCurrent()
        assertEquals(2, searches.size)
        pending.complete(response(page(row("second.dng"))))
        advanceUntilIdle()
        assertEquals(2, model.state.value.photos.size)
        model.refresh()
        advanceUntilIdle()
        assertNull(params(searches.last())["cursor"])
        assertNull(params(searches.last())["page"])
        assertEquals(listOf("first.dng"), model.state.value.photos.map { it.name })
    }

    @Test
    fun failedInitialRequestExposesErrorAndRefreshRetriesTheSameOwner() = runTest {
        var unavailable = true
        val searches = mutableListOf<String>()
        val model = CloudTimelineModel(this, { "me" }) { _, path ->
            if (!isPage(path)) response() else {
                searches += path
                if (unavailable) response(status = 401) else response(page(row("mine.dng")))
            }
        }
        model.selectServer(server)
        model.onlyMine()
        advanceUntilIdle()
        assertEquals("Cloud session expired. Reconnect this server in Settings.", model.state.value.error)
        assertFalse(model.state.value.loading)
        assertFalse(model.state.value.canLoadMore)
        assertTrue(model.state.value.photos.isEmpty())
        unavailable = false
        model.refresh()
        advanceUntilIdle()
        assertEquals("me", params(searches.last())["owner"])
        assertEquals(listOf("mine.dng"), model.state.value.photos.map { it.name })
        assertNull(model.state.value.error)
    }

    @Test
    fun failedMoreKeepsLoadedPhotosAndRetryUsesTheSameCursor() = runTest {
        var failMore = true
        val cursors = mutableListOf<String?>()
        val model = CloudTimelineModel(this, { null }) { _, path ->
            if (!isPage(path)) response() else {
                val cursor = params(path)["cursor"]
                cursors += cursor
                when {
                    cursor == null -> response(page(row("first.dng"), next = "next"))
                    failMore -> response(status = 503)
                    else -> response(page(row("second.dng")))
                }
            }
        }
        model.selectServer(server)
        advanceUntilIdle()
        model.loadMore()
        advanceUntilIdle()
        assertNotNull(model.state.value.error)
        assertFalse(model.state.value.loading)
        assertEquals(listOf("first.dng"), model.state.value.photos.map { it.name })
        assertTrue(model.state.value.canLoadMore)
        failMore = false
        model.retry()
        advanceUntilIdle()
        assertEquals(listOf(null, "next", "next"), cursors)
        assertEquals(listOf("first.dng", "second.dng"), model.state.value.photos.map { it.name })
        assertNull(model.state.value.error)
    }

    @Test
    fun decorationFailuresKeepPhotosAndFailedOwnerRestartClearsOldPhotos() = runTest {
        var failPage = false
        val model = CloudTimelineModel(this, { "me" }) { _, path ->
            when {
                !isPage(path) -> response(status = 500)
                failPage -> response(status = 503)
                else -> response(page(row("old.dng")))
            }
        }
        model.selectServer(server)
        advanceUntilIdle()
        assertEquals(listOf("old.dng"), model.state.value.photos.map { it.name })
        assertEquals(1, model.state.value.months.single().count)
        assertNull(model.state.value.error)
        failPage = true
        model.setOwner("other")
        advanceUntilIdle()
        assertEquals("other", model.state.value.owner)
        assertTrue(model.state.value.photos.isEmpty())
        assertTrue(model.state.value.months.isEmpty())
        assertFalse(model.state.value.canLoadMore)
        assertNotNull(model.state.value.error)
    }
}
