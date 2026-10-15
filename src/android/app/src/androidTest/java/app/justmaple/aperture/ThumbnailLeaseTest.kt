package app.justmaple.aperture

import android.graphics.BitmapFactory
import android.net.Uri
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.cloud.CloudCredentials
import app.justmaple.aperture.cloud.CloudServer
import app.justmaple.aperture.data.Photo
import app.justmaple.aperture.data.PhotoLibrary
import java.io.File
import java.io.FileDescriptor
import java.io.RandomAccessFile
import java.util.UUID
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class ThumbnailLeaseTest {
    @Test
    fun concurrentEvictionCannotInvalidateAnOpenDecoderAndCancellationClosesItsDescriptor() =
        runBlocking<Unit> {
            val i = InstrumentationRegistry.getInstrumentation()
            val context = i.targetContext
            val directory =
                File(context.cacheDir, "thumbnail-lease-${UUID.randomUUID()}").apply { mkdirs() }
            val credentials = CloudCredentials(context)
            val id = UUID.randomUUID().toString()
            val release = CompletableDeferred<Unit>()
            val pressure =
                File(context.cacheDir, "thumbnails/reader-pressure-${UUID.randomUUID()}.bin")
            try {
                FileCloudServer(directory).use { server ->
                    i.context.assets.open("rgb-gradient.png").use { input ->
                        server.original.outputStream().use { input.copyTo(it) }
                    }
                    val original = server.original.readBytes()
                    credentials.save(
                        CloudServer(id, server.origin, "fixture-access-1", "fixture-refresh-1")
                    )
                    val uri =
                        Uri.Builder()
                            .scheme("maple-cloud")
                            .authority(id)
                            .appendQueryParameter("address", "photos:2026/${server.original.name}")
                            .appendQueryParameter("path", server.original.path)
                            .build()
                    val photo = Photo(uri, server.original.name, server.original.length(), 1, null)
                    val library = PhotoLibrary(context)
                    val warm = library.thumbnailPath(photo)
                    val index = File(warm.parentFile, warm.name.substringBeforeLast('-') + ".json")
                    val pairSize = warm.length() + index.length()
                    val opened = CompletableDeferred<FileDescriptor>()
                    val reader =
                        async(Dispatchers.IO) {
                            library.withThumbnail(photo) { file, input ->
                                assertEquals(warm, file)
                                assertTrue(file.setLastModified(1))
                                assertTrue(index.setLastModified(1))
                                opened.complete(input.fd)
                                release.await()
                                assertFalse(
                                    "The test must actually evict the path before decoding",
                                    file.exists(),
                                )
                                val bitmap =
                                    checkNotNull(BitmapFactory.decodeFileDescriptor(input.fd))
                                try {
                                    bitmap.width to bitmap.height
                                } finally {
                                    bitmap.recycle()
                                }
                            }
                        }
                    val descriptor = withTimeout(30_000) { opened.await() }
                    RandomAccessFile(pressure, "rw").use {
                        it.setLength(64L * 1024 * 1024 - pairSize)
                    }
                    assertTrue(pressure.setLastModified(System.currentTimeMillis() + 60_000))
                    // A second library instance inserts the same-sized image under another edge.
                    // Its fresh pair plus pressure fills the budget, evicting the old pair.
                    val dimensions =
                        withTimeout(30_000) {
                            PhotoLibrary(context).withThumbnail(photo, 2048) { _, input ->
                                val bitmap =
                                    checkNotNull(BitmapFactory.decodeFileDescriptor(input.fd))
                                try {
                                    bitmap.width to bitmap.height
                                } finally {
                                    bitmap.recycle()
                                }
                            }
                        }
                    assertFalse(warm.exists())
                    assertFalse(index.exists())
                    release.complete(Unit)
                    assertEquals(dimensions, reader.await())
                    assertFalse(
                        "Completed decoders must release their descriptor",
                        descriptor.valid(),
                    )
                    assertEquals(2, server.derivativeTransfers)
                    assertEquals(1, server.derivativeNotModified)
                    assertArrayEquals(original, server.original.readBytes())

                    val cancellationEntered = CompletableDeferred<FileDescriptor>()
                    val cancelled =
                        launch(Dispatchers.IO) {
                            library.withThumbnail(photo, 256) { _, input ->
                                cancellationEntered.complete(input.fd)
                                awaitCancellation()
                            }
                        }
                    val cancelledDescriptor = withTimeout(30_000) { cancellationEntered.await() }
                    cancelled.cancelAndJoin()
                    assertFalse(
                        "Cancellation must release the descriptor",
                        cancelledDescriptor.valid(),
                    )
                }
            } finally {
                release.complete(Unit)
                pressure.delete()
                credentials.remove(id)
                directory.deleteRecursively()
            }
        }
}
