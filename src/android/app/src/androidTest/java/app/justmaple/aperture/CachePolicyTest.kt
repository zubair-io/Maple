package app.justmaple.aperture

import android.net.Uri
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.PhotoLibrary
import java.io.File
import java.io.RandomAccessFile
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class CachePolicyTest {
    @Test
    fun cacheHitsAvoidEvictionAndNewInsertionsEnforceBounds() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val bytes = instrumentation.context.assets.open("rgb-gradient.png").use { it.readBytes() }
        val first =
            File.createTempFile("cache-first-", ".png", context.filesDir).apply {
                writeBytes(bytes)
            }
        val second =
            File.createTempFile("cache-second-", ".png", context.filesDir).apply {
                writeBytes(bytes)
            }
        val library = PhotoLibrary(context)
        val photo = library.single(Uri.fromFile(first))
        val warm = library.thumbnail(photo)
        val thumbSentinel = oversized(File(context.cacheDir, "thumbnails"), 65)
        val originalSentinel = oversized(File(context.cacheDir, "originals"), 513)
        try {
            repeat(5) {
                assertEquals(warm, library.thumbnail(photo))
                assertTrue(
                    "Hits must not scan and evict the shared thumbnail cache",
                    thumbSentinel.exists(),
                )
                library.withOriginal(photo) { assertArrayEquals(bytes, it.readBytes()) }
                assertTrue(
                    "Staged original hits must not rescan their cache",
                    originalSentinel.exists(),
                )
            }
            val added = library.thumbnail(photo, 256)
            assertTrue(added.isFile)
            assertTrue(warm.isFile)
            assertFalse(
                "Inserting new thumbnail bytes must enforce its budget",
                thumbSentinel.exists(),
            )
            library.withOriginal(library.single(Uri.fromFile(second))) {
                assertArrayEquals(bytes, it.readBytes())
            }
            assertFalse(
                "Inserting a new original must enforce its budget",
                originalSentinel.exists(),
            )
            assertArrayEquals(bytes, first.readBytes())
            assertArrayEquals(bytes, second.readBytes())
        } finally {
            thumbSentinel.delete()
            originalSentinel.delete()
            first.delete()
            second.delete()
        }
    }

    private fun oversized(folder: File, mib: Long): File =
        File(folder, "cache-policy-${java.util.UUID.randomUUID()}.bin").apply {
            // Sparse files make eviction observable without writing hundreds of MiB.
            RandomAccessFile(this, "rw").use { it.setLength(mib * 1024 * 1024) }
            check(setLastModified(1))
        }
}
