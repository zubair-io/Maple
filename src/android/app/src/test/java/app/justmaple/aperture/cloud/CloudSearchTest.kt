package app.justmaple.aperture.cloud

import android.net.Uri
import app.justmaple.aperture.data.Folder
import java.time.LocalDate
import java.util.Locale
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class CloudSearchTest {
    private val today = LocalDate.of(2026, 3, 10)

    private fun row(address: String?, name: String) =
        JSONObject()
            .put("address", address ?: JSONObject.NULL)
            .put("abs_path", "/srv/photos/2026/$name")
            .put("filename", name)
            .put("size", 2048)
            .put("mtime", 1_700_000_000_000)

    private fun response(status: Int, body: JSONObject) =
        CloudResponse(status, body.toString().toByteArray(), null, null)

    private fun params(path: String) = Uri.parse("https://x$path").let { uri ->
        uri.queryParameterNames.associateWith { uri.getQueryParameter(it)!! }
    }

    @Test
    fun presetsAndFiltersMatchTheApplePanelsWireShape() {
        assertEquals("2026-03-10" to "2026-03-10", SearchDatePreset.Today.range(today))
        assertEquals("2026-03-04" to "2026-03-10", SearchDatePreset.Last7.range(today))
        assertEquals("2026-02-09" to "2026-03-10", SearchDatePreset.Last30.range(today))
        assertEquals("2026-01-01" to "2026-03-10", SearchDatePreset.ThisYear.range(today))
        val query =
            CloudSearchQuery(" red barn ", SearchDatePreset.Last7, setOf("Zoe", "Ann"), setOf("Kyoto, Kansai", "Albany, New York"))
        val first = params(CloudSearchWire.searchPath(query, today, null))
        assertEquals("The search box reaches the ranked natural-language path", "red barn", first["placeQuery"])
        assertNull("`q` is only a filename substring", first["q"])
        assertNull("Android never asks the server to fold RAW+JPEG pairs", first["stack"])
        assertEquals("2026-03-04", first["from"])
        assertEquals("2026-03-10", first["to"])
        assertEquals("Ann,Zoe", first["people"])
        assertEquals("Albany, New York|Kyoto, Kansai", first["place"])
        assertNull(first["page"])
        val ranked = params(CloudSearchWire.searchPath(query, today, SearchContinuation(null, 2, "pin")))
        assertEquals("2" to "pin", ranked["page"] to ranked["rankPin"])
        assertEquals("c1", params(CloudSearchWire.searchPath(CloudSearchQuery(), today, SearchContinuation("c1", 0, null)))["cursor"])
        assertTrue(CloudSearchWire.facetsPath(query, today).startsWith("/api/search/facets?placeQuery=red%20barn"))
    }

    @Test
    fun dateBoundariesUseIsoDigitsWhateverTheDeviceLocale() {
        val device = Locale.getDefault()
        // Arabic (Egypt) formats numbers with Arabic-Indic digits.
        Locale.setDefault(Locale.forLanguageTag("ar-EG"))
        try {
            for (preset in SearchDatePreset.entries)
                preset.range(today).toList().forEach { assertTrue("$preset: $it", it.matches(Regex("\\d{4}-\\d{2}-\\d{2}")) && it.all { c -> c.code < 0x80 }) }
            assertEquals("2026-01-01" to "2026-03-10", SearchDatePreset.ThisYear.range(today))
        } finally {
            Locale.setDefault(device)
        }
    }

    @Test
    fun resultsBecomeOpenableCloudPhotosAndUnaddressableRowsAreDropped() {
        val page =
            CloudSearchWire.parsePage(
                "server-1",
                JSONObject()
                    .put("results", org.json.JSONArray()
                        .put(row("lib:2026/a.dng", "a.dng")
                            .put("stack", JSONObject().put("companion", JSONObject().put("name", "a.jpg").put("address", "lib:2026/a.jpg"))))
                        .put(row(null, "b.dng"))
                        .put(row("lib:2026/clip.mov", "clip.mov"))
                        .put(row("lib:top.jpg", "top.jpg")))
                    .put("total", 450)
                    .put("cursorPaging", true)
                    .put("nextCursor", "next"),
                0,
            )
        assertEquals("A folded row's companion is ignored, never invented", listOf("a.dng", "top.jpg"), page.photos.map { it.name })
        assertEquals(2, page.dropped)
        val photo = page.photos.first()
        assertEquals("server-1", photo.uri.host)
        assertEquals("/api/image/lib/2026/a.dng", CloudLibrary.mediaPath("image", photo.uri))
        assertEquals("/srv/photos/2026/a.dng", photo.uri.getQueryParameter("path"))
        assertEquals("lib:2026", photo.parent!!.getQueryParameter("address"))
        assertEquals("lib:", page.photos[1].parent!!.getQueryParameter("address"))
        assertEquals(1_700_000_000_000, photo.modified)
        assertEquals(SearchContinuation("next", 0, null), page.next)
        assertFalse(page.openEnded)

        val ranked =
            CloudSearchWire.parsePage("s", JSONObject().put("results", org.json.JSONArray().put(row("l:x.dng", "x.dng")))
                .put("total", 5000).put("more", true).put("cursorPaging", false).put("rankPin", "p0"), 0)
        assertTrue(ranked.openEnded)
        assertEquals(SearchContinuation(null, 1, "p0"), ranked.next)
        assertEquals(listOf(SearchFacet("Ann", 3)),
            CloudSearchWire.parseFacets(JSONObject("""{"people":[{"value":"Ann","count":3},{"value":null,"count":1}]}"""), "people"))
    }

    @Test
    fun filtersRestartPagingMoreAppendsAndAChangedRankEngineRestartsWithoutThePin() = runTest {
        val requests = mutableListOf<String>()
        var engineChanged = true
        val dispatcher = StandardTestDispatcher(testScheduler)
        val model =
            CloudSearchModel(TestScope(dispatcher), { today }) { server, path ->
                assertEquals("server-1", server)
                requests += path
                val query = params(path)
                when {
                    path.startsWith("/api/search/facets") ->
                        response(200, JSONObject("""{"people":[{"value":"Ann","count":2}],"places":[{"value":"Kyoto, Kansai","count":1}]}"""))
                    query["rankPin"] != null && engineChanged -> {
                        engineChanged = false
                        response(409, JSONObject().put("code", "rank_engine_changed"))
                    }
                    else -> {
                        val page = query["page"]?.toInt() ?: 0
                        response(200, JSONObject()
                            .put("results", org.json.JSONArray().put(row("lib:p$page.dng", "p$page.dng")))
                            .put("total", 5000).put("more", true).put("cursorPaging", false).put("rankPin", "pin$page"))
                    }
                }
            }
        model.selectServer(Folder(Uri.parse("maple-cloud://server-1"), "photos.example.com"))
        advanceUntilIdle()
        assertEquals(listOf("p0.dng"), model.state.value.results.map { it.name })
        assertEquals(listOf(SearchFacet("Ann", 2)), model.state.value.people)

        model.setText("barn")
        advanceUntilIdle()
        assertTrue(requests.any { params(it)["placeQuery"] == "barn" })
        assertTrue(model.state.value.canLoadMore)
        assertTrue(model.state.value.openEnded)

        requests.clear()
        model.loadMore()
        advanceUntilIdle()
        assertTrue(requests.any { params(it)["rankPin"] == "pin0" })
        assertNull("A 409 for a pinned page restarts at page 0 without the pin",
            params(requests.last { !it.startsWith("/api/search/facets") })["rankPin"])
        assertEquals(listOf("p0.dng"), model.state.value.results.map { it.name })

        model.loadMore()
        advanceUntilIdle()
        assertEquals(listOf("p0.dng", "p1.dng"), model.state.value.results.map { it.name })

        model.togglePerson("Ann")
        advanceUntilIdle()
        assertEquals("Ann", params(requests.last { !it.startsWith("/api/search/facets") })["people"])
        assertEquals(listOf("p0.dng"), model.state.value.results.map { it.name })
        model.setDate(SearchDatePreset.ThisYear)
        advanceUntilIdle()
        assertEquals("2026-01-01", params(requests.last())["from"])
        assertNull(model.state.value.error)
    }

    @Test
    fun aFailedSearchReportsTheServerError() = runTest {
        val model =
            CloudSearchModel(TestScope(StandardTestDispatcher(testScheduler)), { today }) { _, _ ->
                response(401, JSONObject())
            }
        model.selectServer(Folder(Uri.parse("maple-cloud://server-1"), "photos.example.com"))
        advanceUntilIdle()
        assertEquals("Cloud session expired. Reconnect this server in Settings.", model.state.value.error)
        assertFalse(model.state.value.loading)
    }

    @Test
    fun aFailedFacetsFetchKeepsThePageAndAFailedRestartClearsTheOldResults() = runTest {
        var failSearch = false
        val model =
            CloudSearchModel(TestScope(StandardTestDispatcher(testScheduler)), { today }) { _, path ->
                when {
                    path.startsWith("/api/search/facets") -> response(500, JSONObject())
                    failSearch -> response(503, JSONObject())
                    else ->
                        response(200, JSONObject()
                            .put("results", org.json.JSONArray()
                                .put(row("lib:a.dng", "a.dng")).put(row(null, "gone.dng")).put(row("lib:b.dng", "b.dng")))
                            .put("total", 3).put("cursorPaging", true))
                }
            }
        model.selectServer(Folder(Uri.parse("maple-cloud://server-1"), "photos.example.com"))
        advanceUntilIdle()
        assertEquals(listOf("a.dng", "b.dng"), model.state.value.results.map { it.name })
        assertNull("Facets decorate the filters; their failure is not a search failure", model.state.value.error)
        assertTrue(model.state.value.people.isEmpty())
        assertEquals("The count excludes rows this client cannot open", 2, model.state.value.total)

        failSearch = true
        model.setText("barn")
        advanceUntilIdle()
        assertNotNull(model.state.value.error)
        assertTrue("A failed new search never shows the previous query's results", model.state.value.results.isEmpty())
        assertEquals(0, model.state.value.total)
        assertFalse(model.state.value.canLoadMore)
    }

    @Test
    fun submittingTheUnchangedQueryRetriesAFailedSearch() = runTest {
        var unavailable = true
        val searches = mutableListOf<String>()
        val model =
            CloudSearchModel(TestScope(StandardTestDispatcher(testScheduler)), { today }) { _, path ->
                when {
                    path.startsWith("/api/search/facets") -> response(200, JSONObject())
                    unavailable -> response(503, JSONObject()).also { searches += path }
                    else -> response(200, JSONObject().put("results", org.json.JSONArray().put(row("lib:a.dng", "a.dng"))))
                        .also { searches += path }
                }
            }
        model.selectServer(Folder(Uri.parse("maple-cloud://server-1"), "photos.example.com"))
        model.setText("barn")
        advanceUntilIdle()
        assertNotNull(model.state.value.error)
        unavailable = false
        model.setText("barn")
        advanceUntilIdle()
        assertNotNull("Retyping the same text alone does not search again", model.state.value.error)
        model.submit("barn")
        advanceUntilIdle()
        assertNull(model.state.value.error)
        assertEquals(listOf("a.dng"), model.state.value.results.map { it.name })
        assertTrue(params(searches.last())["placeQuery"] == "barn")
    }

    @Test
    fun anOpenWindowCountsTheServerTotalLessTheRowsItDropped() = runTest {
        val model =
            CloudSearchModel(TestScope(StandardTestDispatcher(testScheduler)), { today }) { _, path ->
                if (path.startsWith("/api/search/facets")) response(200, JSONObject())
                else
                    response(200, JSONObject()
                        .put("results", org.json.JSONArray().put(row("lib:a.dng", "a.dng")).put(row("lib:clip.mov", "clip.mov")))
                        .put("total", 450).put("cursorPaging", true).put("nextCursor", "c2"))
            }
        model.selectServer(Folder(Uri.parse("maple-cloud://server-1"), "photos.example.com"))
        advanceUntilIdle()
        assertEquals(449, model.state.value.total)
        assertTrue(model.state.value.canLoadMore)
    }

    @Test
    fun anotherAccountSigningInToTheSearchedServerSearchesAgain() = runTest {
        var account = "ann"
        val model =
            CloudSearchModel(TestScope(StandardTestDispatcher(testScheduler)), { today }) { _, path ->
                if (path.startsWith("/api/search/facets"))
                    response(200, JSONObject().put("people", org.json.JSONArray()
                        .put(JSONObject().put("value", account).put("count", 1))))
                else response(200, JSONObject().put("results", org.json.JSONArray().put(row("lib:$account.dng", "$account.dng"))))
            }
        val server = Folder(Uri.parse("maple-cloud://server-1"), "photos.example.com")
        model.selectServer(server)
        advanceUntilIdle()
        assertEquals(listOf("ann.dng"), model.state.value.results.map { it.name })
        account = "bob"
        model.selectServer(server)
        model.signedIn(Folder(Uri.parse("maple-cloud://server-2"), "other.example.com"))
        advanceUntilIdle()
        assertEquals("Another server's sign-in leaves this search alone", listOf("ann.dng"), model.state.value.results.map { it.name })
        // Signing in again keeps the server id; what was shown belongs to the previous account.
        model.signedIn(server)
        advanceUntilIdle()
        assertEquals(listOf("bob.dng"), model.state.value.results.map { it.name })
        assertEquals(listOf("bob"), model.state.value.people.map { it.value })
    }
}
