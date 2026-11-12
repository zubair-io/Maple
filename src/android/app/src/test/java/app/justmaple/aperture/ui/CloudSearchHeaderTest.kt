package app.justmaple.aperture.ui

import android.net.Uri
import androidx.compose.material3.Text
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import app.justmaple.aperture.cloud.CloudResponse
import app.justmaple.aperture.cloud.CloudSearchModel
import app.justmaple.aperture.cloud.CloudSearchQuery
import app.justmaple.aperture.cloud.CloudSearchState
import app.justmaple.aperture.cloud.SearchDatePreset
import app.justmaple.aperture.cloud.SearchFacet
import app.justmaple.aperture.data.Folder
import app.justmaple.aperture.data.Photo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class CloudSearchHeaderTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun filtersAndPagingReportThroughTheirCallbacksAndTheFirstServerIsSelected() {
        val home = Folder(Uri.parse("maple-cloud://home"), "home.example.com")
        val work = Folder(Uri.parse("maple-cloud://work"), "work.example.com")
        val events = mutableListOf<String>()
        val state =
            CloudSearchState(
                query = CloudSearchQuery(places = setOf("Paris, France")),
                total = 5000,
                openEnded = true,
                canLoadMore = true,
                people = listOf(SearchFacet("Ann", 4)),
                places = listOf(SearchFacet("Kyoto, Kansai", 2)),
            )
        compose.setContent {
            CloudSearchHeader(
                state,
                listOf(home, work),
                onServer = { events += "server:${it.name}" },
                onText = { events += "text:$it" },
                onDate = { events += "date:$it" },
                onPerson = { events += "person:$it" },
                onPlace = { events += "place:$it" },
                onMore = { events += "more" },
            )
        }
        compose.onNodeWithTag("cloud-search-count").assertTextEquals("5,000+ photos")
        compose.onNodeWithTag("cloud-search-query").performTextInput("barn")
        compose.onNodeWithTag("cloud-search-date-${SearchDatePreset.Last30.name}").performClick()
        compose.onNodeWithTag("cloud-search-people-Ann").performClick()
        compose.onNodeWithTag("cloud-search-places-Paris, France").performClick()
        compose.onNodeWithTag("cloud-search-server-work.example.com").performClick()
        compose.onNodeWithTag("cloud-search-more").performClick()
        compose.runOnIdle {
            assertEquals(
                listOf("server:home.example.com", "text:barn", "date:Last30", "person:Ann",
                    "place:Paris, France", "server:work.example.com", "more"),
                events,
            )
        }
    }

    @Test
    fun countsAreExactWhenTheWindowIsClosed() {
        assertEquals("1 photo", searchCountLabel(CloudSearchState(total = 1)))
        assertEquals("1,234 photos", searchCountLabel(CloudSearchState(total = 1234)))
    }

    @Test
    fun loadingAndFailedSearchesNeverLookLikeAnEmptyLibrary() {
        val server = Folder(Uri.parse("maple-cloud://home"), "home.example.com")
        var search by mutableStateOf(CloudSearchState(server = server, loading = true))
        compose.setContent {
            CloudSearchBody(search) { Text("grid", Modifier.testTag("results")) }
        }
        compose.onNodeWithTag("cloud-search-loading").assertExists()
        compose.onNodeWithText("No photos here").assertDoesNotExist()
        search = CloudSearchState(server = server, error = "Cloud session expired. Reconnect this server in Settings.")
        compose.onNodeWithTag("cloud-search-error").assertTextEquals("Cloud session expired. Reconnect this server in Settings.")
        compose.onNodeWithTag("results").assertDoesNotExist()
        search = CloudSearchState(server = server)
        compose.onNodeWithTag("cloud-search-empty").assertExists()
        search = CloudSearchState(server = server, results = listOf(photo("b.dng"), photo("a.dng")))
        compose.onNodeWithTag("results").assertExists()
    }

    @Test
    fun searchResultsKeepTheServersOrderUntilTheUserSorts() {
        val ranked = listOf(photo("zebra.dng"), photo("apple.dng"), photo("mango.dng"))
        assertEquals(ranked, applyBrowseCulling(ranked, emptyMap(), BrowseFilter.All, SEARCH_SORTS.first()))
        var sort by mutableStateOf(SEARCH_SORTS.first())
        compose.setContent { BrowseFilterBar(BrowseFilter.All, {}, sort, { sort = it }, sorts = SEARCH_SORTS) }
        compose.onNodeWithTag("grid-sort-toggle").performClick()
        compose.runOnIdle { assertEquals(BrowseSort.Name, sort) }
        compose.onNodeWithTag("grid-sort-toggle").performClick()
        compose.onNodeWithTag("grid-sort-toggle").performClick()
        compose.runOnIdle { assertEquals(BrowseSort.Server, sort) }
    }

    @Test
    fun aRestoredSearchBoxSearchesItsTextNotTheWholeLibrary() {
        val home = Folder(Uri.parse("maple-cloud://home"), "home.example.com")
        val paths = mutableListOf<String>()
        fun model() =
            CloudSearchModel(CoroutineScope(Dispatchers.Unconfined)) { _, path ->
                synchronized(paths) { paths += path }
                CloudResponse(404, "{}".toByteArray(), null, null)
            }
        var search by mutableStateOf(model())
        val restoration = StateRestorationTester(compose)
        restoration.setContent {
            val state by search.state.collectAsState()
            CloudSearchHeader(state, listOf(home), search::selectServer, search::setText, {}, {}, {}, {})
        }
        compose.onNodeWithTag("cloud-search-query").performTextInput("red barn")
        // Process death: the activity restores its saved state over a brand-new model.
        search = model()
        compose.runOnIdle { paths.clear() }
        restoration.emulateSavedInstanceStateRestore()
        compose.runOnIdle {
            assertEquals("red barn", search.state.value.query.text)
            assertTrue(paths.isNotEmpty())
            assertTrue(paths.all { "placeQuery=red%20barn" in it })
        }
    }

    private fun photo(name: String) =
        Photo(Uri.parse("maple-cloud://home/$name"), name, 1, 1, null)
}
