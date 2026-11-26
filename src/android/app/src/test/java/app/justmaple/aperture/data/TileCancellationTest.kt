package app.justmaple.aperture.data

import android.net.Uri
import java.io.File
import java.io.InputStream
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class TileCancellationTest {
    private val context = RuntimeEnvironment.getApplication()

    @Test
    fun aLoadCancelledDuringItsFirstFolderSnapshotStartsNoFurtherStep() = runBlocking {
        val photo =
            Photo(Uri.parse("content://docs/tree/a/document/IMG_1.DNG"), "IMG_1.DNG", 10, 20, Uri.parse("content://docs/tree/a"))
        val source = FolderCacheSource(photo, null, null)
        val snapshots = AtomicInteger()
        val renders = AtomicInteger()

        val load =
            launch(Dispatchers.IO) {
                FolderDerivativeCache(context).load(
                    512,
                    {
                        snapshots.incrementAndGet()
                        currentCoroutineContext().job.cancel()
                        source
                    },
                    { _, _, _ -> renders.incrementAndGet() },
                )
            }
        load.join()

        assertTrue(load.isCancelled)
        println("JVM host, unit level: steps run after the cancellation point in a tile load: snapshots after the first ${snapshots.get() - 1}, renders ${renders.get()} (before the change: renders 1)")
        assertEquals("no second snapshot", 1, snapshots.get())
        assertEquals("no render", 0, renders.get())
    }

    @Test
    fun aCopyOfTheOriginalStopsAtTheNextChunkAfterCancellationAndLeavesNoFiles() = runBlocking {
        val uri = Uri.parse("content://docs/tree/a/document/IMG_2.DNG")
        val photo = Photo(uri, "IMG_2.DNG", 8L * 1024 * 1024, 20, Uri.parse("content://docs/tree/a"))
        val reads = AtomicInteger()
        lateinit var copying: Job
        val stream =
            object : InputStream() {
                private var left = 8 * 1024 * 1024

                override fun read() = error("chunked reads only")

                override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                    if (reads.incrementAndGet() == 2) copying.cancel()
                    if (left == 0) return -1
                    val count = minOf(length, left)
                    left -= count
                    return count
                }
            }
        shadowOf(context.contentResolver).registerInputStream(uri, stream)

        copying = launch(Dispatchers.IO) { PhotoLibrary(context).withOriginal(photo) { } }
        copying.join()

        println("JVM host, unit level: reads of an 8 MiB original after cancelling at the second chunk: ${reads.get() - 2} (before the change: about 1000, a copy to the end)")
        assertTrue(copying.isCancelled)
        assertEquals(2, reads.get())
        val staged = File(context.cacheDir, "originals").listFiles().orEmpty().toList()
        assertEquals("no partial copy left behind", emptyList<File>(), staged)
    }
}
