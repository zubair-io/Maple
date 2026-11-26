package app.justmaple.aperture.ui

import android.graphics.Bitmap
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.junit4.createComposeRule
import app.justmaple.aperture.data.Photo
import app.justmaple.aperture.data.ThumbnailBitmapCache
import app.justmaple.aperture.data.ThumbnailTiles
import app.justmaple.aperture.data.TileKey
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class TileImageTest {
    @get:Rule val compose = createComposeRule()

    private val photo =
        Photo(Uri.parse("content://docs/tree/a/document/IMG_1.DNG"), "IMG_1.DNG", 10, 20, Uri.parse("content://docs/tree/a"))

    private fun bitmap(side: Int) = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888)

    private class Harness(val cache: ThumbnailBitmapCache, val gate: CompletableDeferred<Bitmap?>) {
        val decodes = AtomicInteger()
        val seen = mutableListOf<Bitmap?>()
        val tiles = ThumbnailTiles(cache) { _, _ -> decodes.incrementAndGet(); gate.await() }
    }

    private fun harness() = Harness(ThumbnailBitmapCache(10_000_000), CompletableDeferred())

    @Test
    fun aTileThatComesBackShowsItsRememberedBitmapOnTheFirstFrameAndStillRunsTheLoad() {
        val harness = harness()
        val remembered = bitmap(10)
        harness.cache.put(TileKey(photo.uri.toString(), photo.key, 512, null), remembered)
        var mounted by mutableStateOf(true)
        compose.setContent {
            if (mounted) {
                val tile = rememberTileImage(photo, harness.tiles, fit = false, revision = null)
                harness.seen += tile.image?.asAndroidBitmap()
            }
        }
        compose.waitForIdle()

        assertSame("first frame", remembered, harness.seen.first())
        assertEquals("the load ran although the bitmap was remembered", 1, harness.decodes.get())

        val newer = bitmap(20)
        harness.gate.complete(newer)
        compose.waitForIdle()

        assertSame("the load's result replaces the remembered bitmap", newer, harness.seen.last())
        assertSame(newer, harness.cache[TileKey(photo.uri.toString(), photo.key, 512, null)])
    }

    @Test
    fun aTileWithNothingRememberedStartsBlankAsBefore() {
        val harness = harness()
        compose.setContent {
            val tile = rememberTileImage(photo, harness.tiles, fit = false, revision = null)
            harness.seen += tile.image?.asAndroidBitmap()
        }
        compose.waitForIdle()

        assertNull(harness.seen.first())
    }

    @Test
    fun aRememberedBitmapNeverFillsAFitTile() {
        val harness = harness()
        harness.cache.put(TileKey(photo.uri.toString(), photo.key, 512, null), bitmap(10))
        compose.setContent {
            val tile = rememberTileImage(photo, harness.tiles, fit = true, revision = null)
            harness.seen += tile.image?.asAndroidBitmap()
        }
        compose.waitForIdle()

        assertNull(harness.seen.first())
    }

    @Test
    fun aFailedLoadDropsTheRememberedBitmapSoTheCellShowsTheFailureAsBefore() {
        val harness = harness()
        harness.cache.put(TileKey(photo.uri.toString(), photo.key, 512, null), bitmap(10))
        var failed = false
        compose.setContent {
            val tile = rememberTileImage(photo, harness.tiles, fit = false, revision = null)
            failed = tile.failed
            harness.seen += tile.image?.asAndroidBitmap()
        }
        compose.waitForIdle()
        assertNotNull(harness.seen.first())

        harness.gate.completeExceptionally(java.io.IOException("the photo is gone"))
        compose.waitForIdle()

        assertTrue(failed)
        assertNull(harness.seen.last())
    }

    @Test
    fun aTileRevisionIsADifferentRememberedTile() {
        val harness = harness()
        harness.cache.put(TileKey(photo.uri.toString(), photo.key, 512, "job-1"), bitmap(10))
        compose.setContent {
            val tile = rememberTileImage(photo, harness.tiles, fit = false, revision = "job-2")
            harness.seen += tile.image?.asAndroidBitmap()
        }
        compose.waitForIdle()

        assertNull(harness.seen.first())
    }
}
