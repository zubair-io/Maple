package app.justmaple.aperture.cloud

import android.net.Uri
import app.justmaple.aperture.data.Folder
import java.time.LocalDate
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
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
class CloudStackQueriesTest {
    private val server = Folder(Uri.parse("maple-cloud://server"), "Photos")
    private val date = LocalDate.of(2026, 3, 10)
    private val configs = listOf(
        "{}" to false,
        """{"stack_raw_jpeg":true}""" to false,
        """{"stack_pair_ops_supported":true,"stack_raw_jpeg":false}""" to false,
        """{"stack_pair_ops_supported":true,"stack_raw_jpeg":true}""" to true,
    )

    private fun response(body: JSONObject) = CloudResponse(200, body.toString().toByteArray(), null, null)

    private fun policy(body: String) = CloudStackPolicy(fetch = { id, path ->
        assertEquals("server", id)
        assertEquals("/api/display/config", path)
        response(JSONObject(body))
    })

    private fun entry(name: String, id: String) = JSONObject()
        .put("id", id).put("name", name).put("address", "lib:2026/$name")
        .put("path", "/photos/2026/$name").put("size", 2048)
        .put("mtime", "2026-03-10T12:00:00Z")

    private fun raw() = entry("photo.dng", "raw-id").put("stack", JSONObject().put("companion",
        entry("photo.JPG", "jpeg-id").put("stack", JSONObject().put("companion", entry("nested.jpg", "nested-id")))))

    private fun searchRow() = raw().put("_id", "raw-id").put("id", "fs:/photos/2026/photo.dng")
        .put("filename", "photo.dng").put("abs_path", "/photos/2026/photo.dng")
        .put("mtime", 1_773_144_000_000).put("captured_at", "2026-03-10T12:00:00Z")

    private fun page(next: String? = null) = JSONObject().put("results", JSONArray().put(searchRow()))
        .put("total", 1).put("cursorPaging", true).put("nextCursor", next ?: JSONObject.NULL)

    private fun stack(path: String) = Uri.parse("https://photos$path").getQueryParameter("stack")

    @Test
    fun browseOnlyOptsInWithCapabilityAndSettingAndRetainsBothFiles() {
        for ((config, expected) in configs) {
            val fold = policy(config).config("server").fold
            val query = CloudBrowseWire.query(fold, "next +/=&")
            assertEquals(if (expected) "1" else null, stack("/api/folder/lib/2026$query"))
            assertEquals("next +/=&", Uri.parse("https://photos/$query").getQueryParameter("cursor"))
            val photo = CloudBrowseWire.photo("server", raw(), server.uri, fold)
            assertEquals("raw-id", photo.assetId)
            assertEquals("photo.xmp", photo.sidecarName)
            assertEquals(expected, photo.companion != null)
            if (expected) {
                val jpeg = photo.companion!!
                assertEquals("jpeg-id", jpeg.assetId)
                assertEquals("photo.JPG", jpeg.name)
                assertEquals(2048L, jpeg.size)
                assertEquals(1_773_144_000_000L, jpeg.modified)
                assertEquals("/photos/2026/photo.JPG", jpeg.uri.getQueryParameter("path"))
                assertEquals("/api/image/lib/2026/photo.JPG", CloudLibrary.mediaPath("image", jpeg.uri))
                assertEquals("lib:2026", jpeg.parent!!.getQueryParameter("address"))
                assertNull(jpeg.companion)
            }
        }
    }

    @Test
    fun searchSharesOnePolicyAcrossResultsFacetsAndCursorPages() = runTest {
        for ((config, expected) in configs) {
            val policy = policy(config)
            val requests = mutableListOf<String>()
            var decisions = 0
            val model = CloudSearchModel(this, { date }, fold = {
                decisions++
                policy.config(it).fold
            }) { _, path ->
                requests += path
                response(if (path.startsWith("/api/search?")) page(if ("cursor=" in path) null else "next") else JSONObject())
            }
            model.selectServer(server)
            advanceUntilIdle()
            model.loadMore()
            advanceUntilIdle()
            assertEquals(3, requests.size)
            assertEquals(1, decisions)
            requests.forEach { assertEquals(if (expected) "1" else null, stack(it)) }
            assertEquals(expected, model.state.value.results.single().companion != null)
            assertEquals("raw-id", model.state.value.results.single().assetId)
        }
    }

    @Test
    fun timelineSharesPolicyAcrossPagesBucketsAndUnfilteredOwnerFacets() = runTest {
        for ((config, expected) in configs) {
            val policy = policy(config)
            val requests = mutableListOf<String>()
            var decisions = 0
            val model = CloudTimelineModel(this, { "me" }, fold = {
                decisions++
                policy.config(it).fold
            }) { _, path ->
                requests += path
                response(if (path.startsWith("/api/search?")) page(if ("cursor=" in path) null else "next") else JSONObject())
            }
            model.selectServer(server)
            advanceUntilIdle()
            model.loadMore()
            advanceUntilIdle()
            assertEquals(4, requests.size)
            assertEquals(1, decisions)
            requests.forEach { assertEquals(if (expected) "1" else null, stack(it)) }
            assertEquals(expected, model.state.value.photos.single().companion != null)
            assertEquals("raw-id", model.state.value.photos.single().assetId)
            assertEquals(1, model.state.value.months.single().count)
            model.setOwner("me")
            advanceUntilIdle()
            val owners = requests.last { it.startsWith("/api/search/facets") }
            assertNull(Uri.parse("https://photos$owners").getQueryParameter("owner"))
            assertEquals(if (expected) "1" else null, stack(owners))
            assertEquals(2, decisions)
        }
    }

    @Test
    fun accountSwitchReevaluatesSearchAndTimelinePolicy() = runTest {
        var enabled = true
        val search = CloudSearchModel(this, fold = { enabled }) { _, path ->
            response(if (path.startsWith("/api/search?")) page() else JSONObject())
        }
        val timeline = CloudTimelineModel(this, { "me" }, fold = { enabled }) { _, path ->
            response(if (path.startsWith("/api/search?")) page() else JSONObject())
        }
        search.selectServer(server)
        timeline.selectServer(server)
        advanceUntilIdle()
        assertNotNull(search.state.value.results.single().companion)
        assertNotNull(timeline.state.value.photos.single().companion)
        enabled = false
        search.signedIn(server)
        timeline.signedIn(server)
        advanceUntilIdle()
        assertNull(search.state.value.results.single().companion)
        assertNull(timeline.state.value.photos.single().companion)
    }
}
