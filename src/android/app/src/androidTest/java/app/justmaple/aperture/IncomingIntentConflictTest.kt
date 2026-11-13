package app.justmaple.aperture

import android.content.ContentValues
import android.content.Intent
import android.provider.MediaStore
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.cloud.CloudCredentials
import app.justmaple.aperture.cloud.CloudServer
import app.justmaple.aperture.data.XmpDocument
import java.io.File
import java.util.UUID
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test

class IncomingIntentConflictTest {
    @Test
    fun externalOpensPreserveTheCurrentFolderWhenItsDirtySidecarConflicts() =
        runBlocking<Unit> {
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            val context = instrumentation.targetContext
            val resolver = context.contentResolver
            val directory =
                File(context.cacheDir, "incoming-conflict-${UUID.randomUUID()}").apply { mkdirs() }
            val bytes =
                instrumentation.context.assets.open("rgb-gradient.png").use { it.readBytes() }
            val incoming =
                resolver.insert(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                    ContentValues().apply {
                        put(
                            MediaStore.Images.Media.DISPLAY_NAME,
                            "incoming-${UUID.randomUUID()}.png",
                        )
                        put(MediaStore.Images.Media.MIME_TYPE, "image/png")
                        put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/MapleVerification")
                    },
                )!!
            resolver.openOutputStream(incoming)!!.use { it.write(bytes) }
            val credentials = CloudCredentials(context)
            val id = UUID.randomUUID().toString()
            try {
                FileCloudServer(directory).use { server ->
                    server.original.writeBytes(bytes)
                    credentials.save(
                        CloudServer(id, server.origin, "fixture-access-1", "fixture-refresh-1")
                    )
                    ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java))
                        .use { scenario ->
                            lateinit var model: MapleViewModel
                            scenario.onActivity {
                                model = ViewModelProvider(it)[MapleViewModel::class.java]
                            }
                            val source = model.library.cloud.sources.single { it.uri.host == id }
                            scenario.onActivity { model.browse(source) }
                            withTimeout(30_000) {
                                model.state.first {
                                    !it.loading && it.folder == source && it.folders.isNotEmpty()
                                }
                            }
                            val library =
                                model.state.value.folders.single { it.name == "Fixture photos" }
                            scenario.onActivity { model.browse(library) }
                            withTimeout(30_000) {
                                model.state.first {
                                    !it.loading &&
                                        it.folder == library &&
                                        it.folders.any { it.name == "2026" }
                                }
                            }
                            val folder = model.state.value.folders.single { it.name == "2026" }
                            scenario.onActivity { model.browse(folder) }
                            withTimeout(30_000) {
                                model.state.first {
                                    !it.loading && it.folder == folder && it.photos.isNotEmpty()
                                }
                            }
                            val photo = model.state.value.photos.single()
                            scenario.onActivity { model.open(photo) }
                            withTimeout(30_000) {
                                model.state.first { it.selected == photo && it.canChangeMetadata }
                            }
                            val external =
                                XmpDocument()
                                    .withAttribute("xmp:Label", "External change")
                                    .serialize()
                            server.sidecar.writeText(external)
                            val before = model.state.value
                            assertEquals(3, before.folderTrail.size)
                            repeat(2) {
                                lateinit var opening: Job
                                scenario.onActivity {
                                    model.clearError()
                                    model.attribute("xmp:Rating", "5")
                                    // MainActivity routes VIEW and SEND through this same
                                    // operation.
                                    opening = model.openSingle(incoming)
                                }
                                withTimeout(30_000) { opening.join() }
                                // Await the complete open, including its failed save guard.
                                val failed = model.state.value
                                assertNotNull(failed.error)
                                assertFalse(failed.saving)
                                assertEquals(before.folder, failed.folder)
                                assertEquals(before.folderTrail, failed.folderTrail)
                                assertEquals(before.folders, failed.folders)
                                assertEquals(before.photos, failed.photos)
                                assertEquals(photo, failed.selected)
                                assertEquals(before.mode, failed.mode)
                                assertTrue(failed.dirty)
                                assertEquals(5, failed.document.rating)
                                assertEquals(external, server.sidecar.readText())
                            }
                            scenario.onActivity { model.reloadSavedEdits() }
                            withTimeout(30_000) {
                                model.state.first {
                                    !it.loading &&
                                        !it.dirty &&
                                        it.error == null &&
                                        it.document.attribute("xmp:Label") == "External change"
                                }
                            }
                            scenario.onActivity { model.back() }
                            withTimeout(30_000) {
                                model.state.first { it.mode == PhotoMode.Browse }
                            }
                            assertEquals(before.folder, model.state.value.folder)
                            assertEquals(before.photos, model.state.value.photos)
                            scenario.onActivity { model.openSingle(incoming) }
                            withTimeout(30_000) {
                                model.state.first {
                                    it.selected?.uri == incoming && it.canChangeMetadata
                                }
                            }
                            val opened = model.state.value
                            assertNull(opened.folder)
                            assertTrue(opened.folderTrail.isEmpty())
                            assertTrue(opened.folders.isEmpty())
                            assertEquals(listOf(opened.selected), opened.photos)
                            assertArrayEquals(bytes, server.original.readBytes())
                            assertArrayEquals(
                                bytes,
                                resolver.openInputStream(incoming)!!.use { it.readBytes() },
                            )
                        }
                }
            } finally {
                credentials.remove(id)
                resolver.delete(incoming, null, null)
                directory.deleteRecursively()
            }
        }
}
