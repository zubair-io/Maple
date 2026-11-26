package app.justmaple.aperture.data

import android.content.ComponentCallbacks2
import android.graphics.Bitmap
import android.net.Uri
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class ThumbnailBitmapCacheTest {
    private fun bitmap(side: Int = 100) = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888)

    private fun photo(folder: String, name: String = "IMG_0001.DNG") =
        Photo(Uri.parse("content://docs/tree/$folder/document/$name"), name, 10, 20, Uri.parse("content://docs/tree/$folder"))

    private fun key(photo: Photo, revision: String? = null, edge: Int = 512) =
        TileKey(photo.uri.toString(), photo.key, edge, revision)

    @Test
    fun neverExceedsItsByteBoundAndEvictsLeastRecentlyUsedFirst() {
        val each = bitmap().byteCount
        val cache = ThumbnailBitmapCache(each * 5L)
        val photos = (0 until 20).map { photo("a", "IMG_$it.DNG") }
        val first = bitmap()
        cache.put(key(photos[0]), first)

        for (index in 1 until 20) {
            cache.put(key(photos[index]), bitmap())
            assertTrue("cache holds ${cache.bytes} of ${cache.maxBytes}", cache.bytes <= cache.maxBytes)
            cache[key(photos[0])]
        }

        assertSame("the tile read most recently survives", first, cache[key(photos[0])])
        assertNull("the oldest unread tile is gone", cache[key(photos[1])])
        assertNotNull(cache[key(photos[19])])
        assertEquals(5 * each, cache.bytes)
    }

    @Test
    fun twoFoldersWithTheSameFileNameNeverShareATile() {
        val cache = ThumbnailBitmapCache(10_000_000)
        val inA = photo("a")
        val inB = photo("b")
        val aBitmap = bitmap(10)
        val bBitmap = bitmap(20)

        cache.put(key(inA), aBitmap)
        assertNull(cache[key(inB)])
        cache.put(key(inB), bBitmap)

        assertSame(aBitmap, cache[key(inA)])
        assertSame(bBitmap, cache[key(inB)])
    }

    @Test
    fun aDifferentRevisionOrSizeIsADifferentTile() {
        val cache = ThumbnailBitmapCache(10_000_000)
        val photo = photo("a")
        cache.put(key(photo, revision = "job-1"), bitmap())

        assertNull(cache[key(photo, revision = null)])
        assertNull(cache[key(photo, revision = "job-2")])
        assertNull(cache[key(photo, revision = "job-1", edge = 2048)])
        assertNotNull(cache[key(photo, revision = "job-1")])
    }

    @Test
    fun savingAPhotoDropsEveryTileOfThatPhotoOnly() {
        val cache = ThumbnailBitmapCache(10_000_000)
        val edited = photo("a")
        val other = photo("a", "IMG_0002.DNG")
        cache.put(key(edited), bitmap())
        cache.put(key(edited, revision = "job-1"), bitmap())
        cache.put(key(other), bitmap())

        cache.drop(edited.uri.toString())

        assertNull(cache[key(edited)])
        assertNull(cache[key(edited, revision = "job-1")])
        assertNotNull(cache[key(other)])
    }

    @Test
    fun memoryPressureClearsTheCacheButAModerateWarningDoesNot() {
        val cache = ThumbnailBitmapCache(10_000_000)
        val photo = photo("a")
        cache.put(key(photo), bitmap())

        @Suppress("DEPRECATION")
        cache.onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE)
        assertNotNull(cache[key(photo)])

        @Suppress("DEPRECATION")
        cache.onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW)
        assertNull(cache[key(photo)])
        assertEquals(0, cache.bytes)
    }

    @Test
    fun theBoundIsAnEighthOfTheMemoryClass() {
        val context = RuntimeEnvironment.getApplication()
        val memoryClass =
            (context.getSystemService(android.content.Context.ACTIVITY_SERVICE) as android.app.ActivityManager).memoryClass
        val cache = ThumbnailBitmapCache.forDevice(context)

        assertEquals(memoryClass * 1024L * 1024 / 8, cache.maxBytes)
        println("tile cache bound: memory class 256 MB -> ${256 * 1024 * 1024L / 8 / 1048576} MiB, 512 MB -> ${512 * 1024 * 1024L / 8 / 1048576} MiB; one 512x384 ARGB_8888 tile = ${512 * 384 * 4 / 1024} KiB")
    }

    @Test
    fun aLoadCancelledAfterItsDecodeCachesAndPublishesNothing() = runBlocking {
        val cache = ThumbnailBitmapCache(10_000_000)
        val decoded = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val decodes = AtomicInteger()
        val tiles =
            ThumbnailTiles(cache) { _, _ ->
                decodes.incrementAndGet()
                decoded.complete(Unit)
                withContext(NonCancellable) { release.await() }
                bitmap()
            }
        val photo = photo("a")

        val load = async(start = CoroutineStart.UNDISPATCHED) { runCatching { tiles.load(photo, 512, null) } }
        decoded.await()
        load.cancel()
        release.complete(Unit)
        load.join()

        assertEquals(1, decodes.get())
        assertNull("a cancelled load must not enter the cache", cache[key(photo)])
        assertEquals(0, cache.bytes)
    }

    @Test
    fun aCompletedLoadIsRememberedOnlyAtTileSize() = runBlocking {
        val cache = ThumbnailBitmapCache(100_000_000)
        val tiles = ThumbnailTiles(cache) { _, _ -> bitmap() }
        val photo = photo("a")

        tiles.load(photo, 2048, null)
        assertNull(tiles.cached(photo, null))
        val loaded = tiles.load(photo, 512, null)

        assertSame(loaded, tiles.cached(photo, null))
    }

    @Test
    fun tilesOfTwoFoldersWithTheSameFileNameStayApartThroughTheLoader() = runBlocking {
        val cache = ThumbnailBitmapCache(10_000_000)
        val tiles = ThumbnailTiles(cache) { photo, _ -> bitmap(if (photo.parent.toString().endsWith("/a")) 10 else 20) }
        val inA = photo("a")
        val inB = photo("b")

        val loadedA = tiles.load(inA, 512, null)
        assertNull(tiles.cached(inB, null))
        val loadedB = tiles.load(inB, 512, null)

        assertSame(loadedA, tiles.cached(inA, null))
        assertSame(loadedB, tiles.cached(inB, null))
        assertNotSame(loadedA, loadedB)
    }

    @Test
    fun savingAPhotoThroughTheLibraryDropsItsRememberedTile() = runBlocking {
        val library = PhotoLibrary(RuntimeEnvironment.getApplication())
        val photo = Photo(Uri.parse("file:///photos/edited.dng"), "edited.dng", 1, 1, null)
        val other = Photo(Uri.parse("file:///photos/other.dng"), "other.dng", 1, 1, null)
        library.tiles.cache.put(key(photo), bitmap())
        library.tiles.cache.put(key(other), bitmap())

        library.save(photo, XmpDocument(), null)

        assertNull(library.tiles.cache[key(photo)])
        assertNotNull(library.tiles.cache[key(other)])
    }
}
