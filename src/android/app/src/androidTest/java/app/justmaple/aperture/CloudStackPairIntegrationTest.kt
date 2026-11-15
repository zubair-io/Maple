package app.justmaple.aperture

import android.app.Application
import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.lifecycle.viewModelScope
import app.justmaple.aperture.cloud.CloudLibrary
import app.justmaple.aperture.data.Folder
import app.justmaple.aperture.data.Photo
import app.justmaple.aperture.ui.BrowseGrid
import app.justmaple.aperture.ui.MapleTheme
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class CloudStackPairIntegrationTest {
    @get:Rule val compose = mainThreadComposeRule<ComponentActivity>()

    @Test
    fun realRawJpegPairRendersOneTileRenamesAndTrashesBothOriginals() {
        val api = MapleApiFixture()
        var model: MapleViewModel? = null
        try {
            assertTrue(
                "Pair rename requires the real native engine; build src/api/native/libraw_ffi before running",
                api.nativeEngine,
            )
            val cloud = CloudLibrary(api.context)
            val root = runBlocking { cloud.list(cloud.sources.single { it.uri.host == api.server.id }.uri) }
                .folders.single { it.uri.getQueryParameter("address") == "${api.slug}:" }
            val folder = runBlocking { cloud.list(root.uri) }.folders.single { it.name == "stack-pair" }
            val rawHash = hash(requireNotNull(api.serverBytes("stack-pair/capture.dng")))
            val jpegHash = hash(requireNotNull(api.serverBytes("stack-pair/capture.jpg")))
            val photo = awaitPair(cloud, folder, "capture")
            assertPair(photo, "capture")

            val gridModel = MapleViewModel(api.context.applicationContext as Application)
            model = gridModel
            val displayed = mutableStateOf(listOf(photo))
            compose.setContent {
                MapleTheme {
                    BrowseGrid(
                        gridModel,
                        MapleState(folder = folder, photos = displayed.value),
                        displayed.value,
                        emptyList(),
                        folderPicker = {},
                    )
                }
            }
            assertGridPair("capture")

            val renamedStem = "renamed-${UUID.randomUUID().toString().take(8)}"
            cloud.pairOperations.rename(photo, "$renamedStem.dng")
            val renamed = awaitPair(cloud, folder, renamedStem)
            assertPair(renamed, renamedStem)
            assertEquals(photo.assetId, renamed.assetId)
            assertEquals(photo.companion!!.assetId, renamed.companion!!.assetId)
            assertNull(api.serverBytes("stack-pair/capture.dng"))
            assertNull(api.serverBytes("stack-pair/capture.jpg"))
            assertArrayEquals(rawHash, hash(requireNotNull(api.serverBytes("stack-pair/$renamedStem.dng"))))
            assertArrayEquals(jpegHash, hash(requireNotNull(api.serverBytes("stack-pair/$renamedStem.jpg"))))
            compose.runOnIdle { displayed.value = listOf(renamed) }
            assertGridPair(renamedStem)
            compose.onNodeWithTag("browse-photo-capture.dng").assertDoesNotExist()

            cloud.pairOperations.trash(renamed)
            assertTrue(runBlocking { cloud.list(folder.uri) }.photos.isEmpty())
            assertNull(api.serverBytes("stack-pair/capture.dng"))
            assertNull(api.serverBytes("stack-pair/capture.jpg"))
            assertNull(api.serverBytes("stack-pair/$renamedStem.dng"))
            assertNull(api.serverBytes("stack-pair/$renamedStem.jpg"))
            val trashed = api.trashedNames()
            assertEquals(1, trashed.count { it == "$renamedStem.dng" })
            assertEquals(1, trashed.count { it == "$renamedStem.jpg" })
        } finally {
            model?.viewModelScope?.cancel()
            model?.renderer?.close()
            compose.activityRule.scenario.close()
            api.close()
        }
    }

    private fun awaitPair(cloud: CloudLibrary, folder: Folder, stem: String): Photo {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(120)
        while (true) {
            val photos = runBlocking { cloud.list(folder.uri) }.photos
            val photo = photos.singleOrNull()
            if (photo?.name == "$stem.dng" && !photo.assetId.isNullOrBlank() &&
                !photo.companion?.assetId.isNullOrBlank()
            ) return photo
            assertTrue(
                "Expected one indexed RAW+JPEG stack for $stem, got ${photos.map { it.name to it.companion?.name }}",
                System.nanoTime() < deadline,
            )
            Thread.sleep(250)
        }
    }

    private fun assertPair(photo: Photo, stem: String) {
        assertEquals("$stem.dng", photo.name)
        assertFalse(photo.assetId.isNullOrBlank())
        val companion = requireNotNull(photo.companion)
        assertEquals("$stem.jpg", companion.name)
        assertFalse(companion.assetId.isNullOrBlank())
        assertNotEquals(photo.assetId, companion.assetId)
        assertNull(companion.companion)
    }

    private fun assertGridPair(stem: String) {
        compose.onNodeWithTag("browse-grid").assertIsDisplayed()
        compose.onAllNodesWithTag("browse-photo-$stem.dng").assertCountEquals(1)
        compose.onNodeWithTag("browse-photo-$stem.dng").assertIsDisplayed()
        compose.onNodeWithTag("browse-photo-$stem.jpg").assertDoesNotExist()
        compose.onAllNodesWithContentDescription("RAW+JPEG", useUnmergedTree = true).assertCountEquals(1)
        compose.onNodeWithContentDescription("RAW+JPEG", useUnmergedTree = true).assertIsDisplayed()
        compose.onAllNodesWithText("$stem.dng", useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithText("$stem.jpg", useUnmergedTree = true).assertCountEquals(0)
    }

    private fun hash(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)
}
