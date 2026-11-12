package app.justmaple.aperture.ui

import android.net.Uri
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import app.justmaple.aperture.cloud.CloudSearchQuery
import app.justmaple.aperture.cloud.CloudSearchState
import app.justmaple.aperture.cloud.SearchDatePreset
import app.justmaple.aperture.cloud.SearchFacet
import app.justmaple.aperture.data.Folder
import org.junit.Assert.assertEquals
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
}
