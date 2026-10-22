package app.justmaple.aperture.ui

import android.app.Application
import android.net.Uri
import android.view.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.justmaple.aperture.MapleState
import app.justmaple.aperture.MapleViewModel
import app.justmaple.aperture.data.EditorRenderer
import app.justmaple.aperture.data.Photo
import app.justmaple.aperture.data.PhotoLibrary
import app.justmaple.aperture.data.PreviewRenderer
import app.justmaple.aperture.data.XmpDocument
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class BrowseCullingAndPinchTest {
    private fun photo(name: String) = Photo(Uri.parse("file:///photos/$name"), name, 1, 1, null)

    @Test
    fun columnTiersCoverOneTwoThreeFourFiveAndSeven() {
        assertEquals(listOf(1, 2, 3, 4, 5, 7), GRID_COLUMN_TIERS)
    }

    @Test
    fun pinchOutZoomsInToFewerColumns() {
        assertEquals(2, nextGridColumnsForPinch(3, 1.3f))
        assertEquals(1, nextGridColumnsForPinch(2, 1.5f))
        assertEquals(1, nextGridColumnsForPinch(1, 2f))
    }

    @Test
    fun pinchInZoomsOutToMoreColumns() {
        assertEquals(4, nextGridColumnsForPinch(3, 0.7f))
        assertEquals(7, nextGridColumnsForPinch(5, 0.5f))
        assertEquals(7, nextGridColumnsForPinch(7, 0.5f))
    }

    @Test
    fun smallZoomJitterKeepsTheCurrentTier() {
        assertEquals(3, nextGridColumnsForPinch(3, 1f))
        assertEquals(4, nextGridColumnsForPinch(4, 1.1f))
        assertEquals(4, nextGridColumnsForPinch(4, 0.9f))
        assertEquals(3, nextGridColumnsForPinch(3, 1.19f))
        assertEquals(3, nextGridColumnsForPinch(3, 0.86f))
    }

    @Test
    fun thresholdsStepExactlyOneTier() {
        assertEquals(2, nextGridColumnsForPinch(3, 1.2f))
        assertEquals(4, nextGridColumnsForPinch(3, 0.85f))
    }

    @Test
    fun offTierCountsStepToTheNeighbouringTier() {
        assertEquals(5, nextGridColumnsForPinch(6, 1.3f))
        assertEquals(7, nextGridColumnsForPinch(6, 0.7f))
        assertEquals(6, nextGridColumnsForPinch(6, 1f))
    }

    @Test
    fun flagsMapToCullIntegersAndBack() {
        assertEquals(1, flagToPick("pick"))
        assertEquals(-1, flagToPick("reject"))
        assertEquals(0, flagToPick(null))
        assertEquals(0, flagToPick("unflagged"))
        assertEquals("pick", pickToFlag(1))
        assertEquals("reject", pickToFlag(-1))
        assertNull(pickToFlag(0))
    }

    @Test
    fun cullingReadsFlagAndRatingFromTheSidecar() {
        val picked =
            cullingOf(
                XmpDocument().withAttribute("papp:Flag", "pick").withAttribute("xmp:Rating", "4")
            )
        assertEquals(PhotoCulling(1, 4), picked)
        val rejected = cullingOf(XmpDocument().withAttribute("papp:Flag", "reject"))
        assertEquals(PhotoCulling(-1, 0), rejected)
        assertEquals(PhotoCulling(), cullingOf(XmpDocument()))
    }

    @Test
    fun filtersKeepOnlyMatchingPhotos() {
        val picked = photo("a.dng")
        val rejected = photo("b.dng")
        val rated = photo("c.dng")
        val plain = photo("d.dng")
        val culling =
            mapOf(
                picked.uri.toString() to PhotoCulling(1, 5),
                rejected.uri.toString() to PhotoCulling(-1, 4),
                rated.uri.toString() to PhotoCulling(0, 3),
                plain.uri.toString() to PhotoCulling(),
            )
        val photos = listOf(picked, rejected, rated, plain)
        assertEquals(photos, applyBrowseCulling(photos, culling, BrowseFilter.All, BrowseSort.Name))
        assertEquals(
            listOf(picked),
            applyBrowseCulling(photos, culling, BrowseFilter.Picks, BrowseSort.Name),
        )
        assertEquals(
            listOf(picked, rated, plain).sortedBy { it.name },
            applyBrowseCulling(photos, culling, BrowseFilter.Unrejected, BrowseSort.Name),
        )
        assertEquals(
            listOf(picked, rejected, rated).sortedBy { it.name },
            applyBrowseCulling(photos, culling, BrowseFilter.ThreePlus, BrowseSort.Name),
        )
        assertEquals(
            listOf(picked, rejected).sortedBy { it.name },
            applyBrowseCulling(photos, culling, BrowseFilter.FourPlus, BrowseSort.Name),
        )
    }

    @Test
    fun missingCullingDefaultsToUnratedAndUnflagged() {
        val known = photo("a.dng")
        val unknown = photo("z.dng")
        val culling = mapOf(known.uri.toString() to PhotoCulling(1, 5))
        assertEquals(
            listOf(known),
            applyBrowseCulling(
                listOf(known, unknown),
                culling,
                BrowseFilter.Picks,
                BrowseSort.Name,
            ),
        )
        assertEquals(
            listOf(known, unknown),
            applyBrowseCulling(
                listOf(unknown, known),
                culling,
                BrowseFilter.Unrejected,
                BrowseSort.Name,
            ),
        )
    }

    @Test
    fun nameSortIsCaseInsensitive() {
        val photos = listOf(photo("B.dng"), photo("a.dng"), photo("C.dng"))
        val sorted = applyBrowseCulling(photos, emptyMap(), BrowseFilter.All, BrowseSort.Name)
        assertEquals(listOf("a.dng", "B.dng", "C.dng"), sorted.map { it.name })
    }

    @Test
    fun ratingSortFallsBackToNameOnTies() {
        val mid = photo("b.dng")
        val top = photo("c.dng")
        val tie = photo("a.dng")
        val low = photo("d.dng")
        val culling =
            mapOf(
                mid.uri.toString() to PhotoCulling(0, 4),
                top.uri.toString() to PhotoCulling(0, 5),
                tie.uri.toString() to PhotoCulling(0, 4),
                low.uri.toString() to PhotoCulling(0, 1),
            )
        val sorted =
            applyBrowseCulling(
                listOf(mid, top, tie, low),
                culling,
                BrowseFilter.All,
                BrowseSort.Rating,
            )
        assertEquals(listOf(top, tie, mid, low), sorted)
    }
}

@RunWith(RobolectricTestRunner::class)
class BrowseFilterBarTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun filterBarExposesEveryChipAndTheSortToggle() {
        var selected by mutableStateOf(BrowseFilter.All)
        var sort by mutableStateOf(BrowseSort.Name)
        compose.setContent { BrowseFilterBar(selected, { selected = it }, sort, { sort = it }) }

        for (tag in
            listOf(
                "grid-filter-all",
                "grid-filter-picks",
                "grid-filter-unrejected",
                "grid-filter-3plus",
                "grid-filter-4plus",
                "grid-sort-toggle",
            )) compose.onNodeWithTag(tag).assertIsDisplayed()

        compose.onNodeWithTag("grid-filter-3plus").performClick()
        assertEquals(BrowseFilter.ThreePlus, selected)

        compose.onNodeWithTag("grid-filter-picks").performClick()
        assertEquals(BrowseFilter.Picks, selected)

        compose.onNodeWithTag("grid-sort-toggle").performClick()
        assertEquals(BrowseSort.Rating, sort)
    }

    @Test
    fun rejectedBadgeShowsOnlyForRejectedPhotos() {
        var pick by mutableStateOf(-1)
        var rating by mutableStateOf(2)
        compose.setContent { CullingBadges(pick = pick, rating = rating) }
        compose.onNodeWithText("Rejected").assertIsDisplayed()
        compose.onNodeWithText("★ 2").assertIsDisplayed()

        compose.runOnIdle {
            pick = 0
            rating = 0
        }
        compose.onAllNodesWithText("Rejected").assertCountEquals(0)

        compose.runOnIdle {
            pick = 1
            rating = 5
        }
        compose.onAllNodesWithText("Rejected").assertCountEquals(0)
        compose.onNodeWithText("★ 5").assertIsDisplayed()
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class RejectButtonTest {
    private class IdleRenderer : PreviewRenderer {
        override val hasPresented = false
        override var revision = 0
        override fun invalidateDraws() = ++revision
        override fun invalidateModel() {}
        override suspend fun open(path: String, document: String, edge: Int, generation: Int) =
            emptyMap<String, Float>()
        override suspend fun autoWhiteBalance(document: String): app.justmaple.aperture.WhiteBalanceRecommendation = error("White balance analysis is not expected in this test")
        override suspend fun nativeDimensions(photo: app.justmaple.aperture.data.Photo): app.justmaple.aperture.data.NativeImageSize? = null
        override suspend fun nativeDetail(request: app.justmaple.aperture.data.NativeDetailRequest): android.graphics.Bitmap = error("Native detail is not requested by this fixture")
        override fun cancelNativeDetail() {}
        override fun recordSurface(next: Surface?, w: Int, h: Int, wideColor: Boolean) =
            EditorRenderer.SurfaceBinding(next, w, h, wideColor)
        override suspend fun attach(binding: EditorRenderer.SurfaceBinding) {}
        override suspend fun draw(next: Map<String, Float>, expectedRevision: Int, xml: String) {}
        override suspend fun refine(expectedRevision: Int) {}
        override suspend fun shutdown() {}
        override fun close() {}
    }

    @get:Rule val compose = createComposeRule()

    private val photo = Photo(Uri.parse("file:///photos/photo.dng"), "photo.dng", 1, 1, null)
    private lateinit var application: Application
    private lateinit var model: MapleViewModel
    private lateinit var sidecars: File

    private fun await(what: String, predicate: (MapleState) -> Boolean): MapleState =
        runBlocking { withTimeout(10_000) { model.state.first(predicate) } }
            .also { assertTrue(what, predicate(it)) }

    @org.junit.Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        application = RuntimeEnvironment.getApplication()
        sidecars = File(application.filesDir, "sidecars")
        model = MapleViewModel(application, PhotoLibrary(application), IdleRenderer())
        model.open(photo)
        await("document loads") { it.documentLoaded && !it.loading }
    }

    @org.junit.After
    fun tearDown() {
        Dispatchers.resetMain()
        sidecars.deleteRecursively()
    }

    @Test
    fun rejectButtonTogglesTheFlagOffAndOn() {
        compose.setContent {
            val state by model.state.collectAsState()
            PreviewActions(model, state)
        }
        compose.onNodeWithTag("reject-button").assertIsDisplayed()

        compose.onNodeWithTag("reject-button").performClick()
        compose.runOnIdle { assertEquals("reject", model.state.value.document.attribute("papp:Flag")) }

        compose.onNodeWithTag("reject-button").performClick()
        compose.runOnIdle { assertNull(model.state.value.document.attribute("papp:Flag")) }
    }

    @Test
    fun toggleRejectPersistsTheCanonicalFlagToXmp() {
        model.toggleReject()
        assertEquals("reject", model.state.value.document.attribute("papp:Flag"))
        assertTrue(runBlocking { model.flush() })
        val saved =
            sidecars.listFiles { file -> file.name.endsWith(".xmp") }?.singleOrNull()
                ?: fail("expected exactly one saved sidecar in $sidecars") as File
        assertTrue(
            "reject must serialize as papp:Flag=\"reject\"",
            saved.readText().contains("papp:Flag=\"reject\""),
        )

        model.toggleReject()
        assertNull(model.state.value.document.attribute("papp:Flag"))
    }
}
