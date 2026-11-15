package app.justmaple.aperture

import android.graphics.Bitmap
import android.graphics.Color
import android.media.ExifInterface
import androidx.compose.ui.test.*
import androidx.lifecycle.ViewModelProvider
import app.justmaple.aperture.cloud.CloudLibrary
import app.justmaple.aperture.cloud.CloudTimelineViewModel
import java.io.File
import java.time.YearMonth
import java.util.UUID
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain

class CloudTimelineIntegrationTest {
    private lateinit var api: MapleApiFixture
    private val suffix = UUID.randomUUID().toString().take(8)
    private val newest = "timeline-march-$suffix.jpg"
    private val older = "timeline-february-$suffix.jpg"
    private val unowned = "timeline-unowned.jpg"
    private val compose = mainThreadComposeRule<MainActivity>()
    private val session = object : ExternalResource() {
        override fun before() {
            api = MapleApiFixture()
            try {
                seedPhoto(newest, "2099:03:15 12:00:00", Color.RED)
                seedPhoto(older, "2099:02:15 12:00:00", Color.BLUE)
                awaitIndexedPhotos()
            } catch (failure: Throwable) {
                api.close()
                throw failure
            }
        }

        override fun after() = api.close()
    }

    @get:Rule val rules: RuleChain = RuleChain.outerRule(session).around(compose)

    @Test
    fun realTimelineGroupsCaptureMonthsFiltersUploadsAndOpensPreview() {
        val model = ViewModelProvider(compose.activity)[MapleViewModel::class.java]
        val timeline = ViewModelProvider(compose.activity)[CloudTimelineViewModel::class.java].timeline
        val source = model.state.value.sources.single { it.uri.host == api.server.id }
        assertTrue(CloudLibrary(api.context).sources.any { it.uri == source.uri })
        compose.onNode(hasText("Timeline") or hasContentDescription("Timeline")).performClick()
        compose.waitUntil(60_000) {
            !timeline.state.value.loading &&
                timeline.state.value.photos.any { it.name == newest }
        }
        assertNull(timeline.state.value.error)
        compose.onNodeWithTag("timeline-grid").assertIsDisplayed()
        val months = timeline.state.value.months.map { it.month }
        assertEquals(listOf(YearMonth.of(2099, 3), YearMonth.of(2099, 2), YearMonth.of(2099, 1)), months.take(3))
        compose.onNodeWithTag("timeline-month-2099-03").assertIsDisplayed()
        assertTrue(
            compose.onNodeWithTag("timeline-month-2099-03").fetchSemanticsNode().boundsInRoot.top <
                compose.onNodeWithTag("timeline-month-2099-02").fetchSemanticsNode().boundsInRoot.top,
        )
        compose.onNodeWithTag("timeline-photo-$newest").assertIsDisplayed()
        compose.onNodeWithTag("timeline-grid").performScrollToNode(hasTestTag("timeline-month-2099-02"))
        compose.onNodeWithTag("timeline-month-2099-02").assertIsDisplayed()
        compose.onNodeWithTag("timeline-grid").performScrollToNode(hasTestTag("timeline-photo-$older"))
        compose.onNodeWithTag("timeline-photo-$older").assertIsDisplayed()
        compose.onNodeWithTag("timeline-grid").performScrollToNode(hasTestTag("timeline-photo-$unowned"))
        compose.onNodeWithTag("timeline-photo-$unowned").assertIsDisplayed()

        compose.onNodeWithContentDescription("Timeline owner").performClick()
        compose.onNodeWithText("Only my uploads").performClick()
        compose.waitUntil(60_000) {
            val loaded = timeline.state.value
            !loaded.loading && loaded.owner == api.current().userId &&
                loaded.photos.any { it.name == newest } && loaded.photos.none { it.name == unowned }
        }
        assertNull(timeline.state.value.error)
        val ownedNames = timeline.state.value.photos.map { it.name }
        assertTrue(newest in ownedNames)
        assertTrue(older in ownedNames)
        assertFalse(unowned in ownedNames)
        compose.onNodeWithTag("timeline-photo-$unowned").assertDoesNotExist()
        compose.onNodeWithTag("timeline-grid").performScrollToNode(hasTestTag("timeline-photo-$newest"))
        compose.onNodeWithTag("timeline-photo-$newest").performClick()
        compose.waitUntil(60_000) {
            model.state.value.mode == PhotoMode.Preview && !model.state.value.loading &&
                model.state.value.selected?.name == newest
        }
        assertNull(model.state.value.error)
        assertTrue(model.state.value.documentLoaded)
        compose.onNodeWithTag("photo-viewport").assertIsDisplayed()
        compose.onNodeWithContentDescription("Edit").assertIsEnabled()
        val navigation = model.state.value.navigationPhotos.map { it.name }
        assertTrue(navigation.indexOf(newest) < navigation.indexOf(older))
        assertFalse(unowned in navigation)
        compose.onNodeWithTag("photo-viewport").performTouchInput { swipeLeft() }
        compose.waitUntil(60_000) {
            !model.state.value.loading && model.state.value.selected?.name == older
        }
        assertEquals(PhotoMode.Preview, model.state.value.mode)
        assertNull(model.state.value.error)
        compose.onNodeWithContentDescription("Back").performClick()
        compose.waitUntil(30_000) { model.state.value.mode == PhotoMode.Browse }
        compose.onNodeWithTag("timeline-grid").assertIsDisplayed()

        val previous = api.current()
        val invalidAccess = previous.access.substringBeforeLast('.') + ".invalid"
        api.credentials.save(previous.copy(access = invalidAccess))
        compose.onNodeWithContentDescription("Refresh timeline").performClick()
        compose.waitUntil(60_000) {
            !timeline.state.value.loading && api.current().access != invalidAccess
        }
        assertNull(timeline.state.value.error)
        assertEquals(previous.userId, api.current().userId)
        assertNotEquals(previous.refresh, api.current().refresh)
        assertEquals(previous.userId, timeline.state.value.owner)
        assertTrue(timeline.state.value.photos.any { it.name == newest })
        compose.onNodeWithTag("timeline-grid").performScrollToNode(hasTestTag("timeline-photo-$newest"))
        compose.onNodeWithTag("timeline-photo-$newest").assertIsDisplayed()
    }

    private fun seedPhoto(name: String, date: String, color: Int) {
        val file = File(api.context.cacheDir, name)
        try {
            val bitmap = Bitmap.createBitmap(32, 24, Bitmap.Config.ARGB_8888)
            try {
                bitmap.eraseColor(color)
                file.outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it)) }
            } finally {
                bitmap.recycle()
            }
            ExifInterface(file.path).apply {
                setAttribute(ExifInterface.TAG_DATETIME_ORIGINAL, date)
                saveAttributes()
            }
            api.upload(name, file.readBytes())
        } finally {
            file.delete()
        }
    }

    private fun awaitIndexedPhotos() {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(120)
        while (true) {
            val (status, body) = api.request("GET", "/api/search?sort=captured_desc&hasCapturedAt=true&limit=100")
            assertEquals(body, 200, status)
            val results = JSONObject(body).getJSONArray("results")
            val rows = (0 until results.length()).map { results.getJSONObject(it) }
            val march = rows.firstOrNull { it.optString("filename") == newest }
            val february = rows.firstOrNull { it.optString("filename") == older }
            val january = rows.firstOrNull { it.optString("filename") == unowned }
            if (march?.optString("captured_at")?.startsWith("2099-03") == true &&
                february?.optString("captured_at")?.startsWith("2099-02") == true &&
                january?.optString("captured_at")?.startsWith("2099-01") == true
            ) {
                assertEquals(api.current().userId, march.getString("owner_id"))
                assertEquals(api.current().userId, february.getString("owner_id"))
                assertTrue(january.isNull("owner_id"))
                return
            }
            assertTrue("Timeline capture metadata was not indexed: $body", System.nanoTime() < deadline)
            Thread.sleep(250)
        }
    }
}
