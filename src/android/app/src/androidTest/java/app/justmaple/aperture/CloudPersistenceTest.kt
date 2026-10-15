package app.justmaple.aperture

import android.app.Application
import android.net.Uri
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.cloud.CloudCredentials
import app.justmaple.aperture.cloud.CloudServer
import app.justmaple.aperture.data.Photo
import app.justmaple.aperture.data.PhotoLibrary
import app.justmaple.aperture.data.XmpDocument
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test

class CloudPersistenceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext

    @Test
    fun stopTimeFlushSurvivesModelTeardownWhileAnEarlierSaveOwnsTheLock() =
        runBlocking<Unit> {
            withCloud { server, photo ->
                val store = ViewModelStore()
                val owner =
                    object : ViewModelStoreOwner {
                        override val viewModelStore = store
                    }
                lateinit var model: MapleViewModel
                val entered = CountDownLatch(1)
                val release = CountDownLatch(1)
                val original = server.original.readBytes()
                try {
                    instrumentation.runOnMainSync {
                        model =
                            ViewModelProvider(
                                owner,
                                ViewModelProvider.AndroidViewModelFactory.getInstance(
                                    context.applicationContext as Application
                                ),
                            )[MapleViewModel::class.java]
                        model.open(photo)
                    }
                    withTimeout(30_000) {
                        model.state.first { it.selected == photo && !it.loading }
                    }
                    assertNull(model.state.value.error)
                    server.saveEntered = entered
                    server.releaseSave = release
                    instrumentation.runOnMainSync { model.attribute("xmp:Rating", "1") }
                    // Let the ordinary debounce start a single save of the first snapshot.
                    assertTrue(entered.await(10, TimeUnit.SECONDS))
                    instrumentation.runOnMainSync {
                        model.attribute("xmp:Rating", "5")
                        model.saveOnStop()
                        store.clear()
                    }
                    release.countDown()
                    withTimeout(30_000) { model.state.first { !it.dirty && !it.saving } }
                    assertEquals(2, server.saveCount)
                    assertEquals(5, XmpDocument(server.sidecar.readText()).rating)
                    assertArrayEquals(original, server.original.readBytes())
                    assertTrue(model.flush())
                } finally {
                    release.countDown()
                    instrumentation.runOnMainSync { store.clear() }
                }
            }
        }

    @Test
    fun largeCloudSidecarsKeepOpaqueBytesThroughMetadataSaves() =
        runBlocking<Unit> {
            withCloud { server, photo ->
                val opaque = "<!--" + "x".repeat(17 * 1024 * 1024) + "-->"
                val source =
                    XmpDocument.EMPTY.replace("<rdf:Description", "$opaque<rdf:Description")
                server.sidecar.writeText(source)
                // Close-delimited bodies have spare buffer capacity; only received bytes are XML.
                server.sidecarLengthHeader = false
                val original = server.original.readBytes()
                val library = PhotoLibrary(context)
                val first = library.loadSidecar(photo)
                server.sidecarLengthHeader = true
                assertEquals(source, first.baseline)
                val saved =
                    library.save(
                        photo,
                        first.document.withAttribute("xmp:Rating", "3"),
                        first.baseline,
                    )
                assertEquals(3, saved.document.rating)
                assertTrue(saved.document.original.contains(opaque))
                assertTrue(server.sidecar.length() > 16 * 1024 * 1024)
                assertEquals(saved.baseline, library.loadSidecar(photo).baseline)
                assertArrayEquals(original, server.original.readBytes())
            }
        }

    @Test
    fun oversizedDeclaredSidecarsFailBeforeAllocatingTheirBody() =
        runBlocking<Unit> {
            withCloud { server, photo ->
                val original = server.original.readBytes()
                java.io.RandomAccessFile(server.sidecar, "rw").use {
                    it.setLength(128L * 1024 * 1024 + 1)
                }
                val failure = runCatching {
                    PhotoLibrary(context).loadSidecar(photo)
                }.exceptionOrNull()
                assertTrue(failure?.message.orEmpty().contains("exceeded 128 MiB"))
                assertArrayEquals(original, server.original.readBytes())
            }
        }

    private suspend fun withCloud(test: suspend (FileCloudServer, Photo) -> Unit) {
        val directory =
            File(context.cacheDir, "cloud-persistence-${java.util.UUID.randomUUID()}").apply {
                mkdirs()
            }
        val credentials = CloudCredentials(context)
        val id = java.util.UUID.randomUUID().toString()
        try {
            FileCloudServer(directory).use { server ->
                instrumentation.context.assets.open("rgb-gradient.png").use { input ->
                    server.original.outputStream().use { input.copyTo(it) }
                }
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
                test(server, Photo(uri, server.original.name, server.original.length(), 1, null))
            }
        } finally {
            credentials.remove(id)
            directory.deleteRecursively()
        }
    }
}
