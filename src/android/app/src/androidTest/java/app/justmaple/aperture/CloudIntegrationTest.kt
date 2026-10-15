package app.justmaple.aperture

import android.net.Uri
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.PhotoLibrary
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class CloudIntegrationTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun pkceConnectionRefreshBrowseEditAndConflictUseRealHttpAndSidecars() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val directory =
            File(context.cacheDir, "cloud-fixture-${java.util.UUID.randomUUID()}").apply {
                mkdirs()
            }
        FileCloudServer(directory).use { server ->
            instrumentation.context.assets.open("rgb-gradient.png").use { input ->
                server.original.outputStream().use { input.copyTo(it) }
            }
            val bytes = server.original.readBytes()
            val model = ViewModelProvider(compose.activity)[MapleViewModel::class.java]
            val library = model.library
            val browser = library.cloud.begin(server.origin)
            server.expectedChallenge = browser.getQueryParameter("code_challenge")!!
            val callback =
                Uri.parse("maple-app://auth-success")
                    .buildUpon()
                    .appendQueryParameter("state", browser.getQueryParameter("state"))
                    .appendQueryParameter("code", "fixture-code")
                    .build()
            runBlocking {
                val invalid =
                    callback
                        .buildUpon()
                        .clearQuery()
                        .appendQueryParameter("state", "wrong")
                        .appendQueryParameter("code", "fixture-code")
                        .build()
                assertTrue(runCatching { library.cloud.complete(invalid) }.isFailure)
            }
            server.forceRefresh = true
            compose.runOnIdle { model.completeCloud(callback) }
            compose.waitUntil(30_000) {
                !model.state.value.loading &&
                    model.state.value.folders.any { it.name == "Fixture photos" }
            }
            assertNull(model.state.value.error)
            assertEquals(1, server.refreshCount)
            val source = model.state.value.sources.single { it.name.startsWith("127.0.0.1:") }
            assertTrue(PhotoLibrary(context).sources.any { it.uri == source.uri })
            val savedPreferences =
                context.getSharedPreferences("maple-cloud", 0).all.values.joinToString()
            assertFalse(savedPreferences.contains("fixture-refresh"))
            assertFalse(savedPreferences.contains("fixture-access"))
            runBlocking { assertTrue(runCatching { library.cloud.complete(callback) }.isFailure) }
            try {
                val root = model.state.value.folders.single { it.name == "Fixture photos" }
                compose.runOnIdle { model.browse(root) }
                compose.waitUntil(30_000) {
                    !model.state.value.loading &&
                        model.state.value.folders.any { it.name == "2026" }
                }
                val nested = model.state.value.folders.single { it.name == "2026" }
                compose.runOnIdle { model.browse(nested) }
                compose.waitUntil(30_000) {
                    !model.state.value.loading && model.state.value.photos.size == 1
                }
                val photo = model.state.value.photos.single()
                assertEquals(server.original.name, photo.name)
                assertEquals(123, photo.modified % 1000)
                compose.runOnIdle { model.open(photo) }
                compose.waitUntil(30_000) {
                    !model.state.value.loading && model.state.value.selected != null
                }
                compose.runOnIdle { model.edit() }
                compose.waitUntil(60_000) {
                    model.state.value.mode == PhotoMode.Edit &&
                        model.state.value.values.isNotEmpty() &&
                        !model.state.value.rendering
                }
                // Publishing the decoded aspect ratio schedules the final SurfaceView layout.
                // Let Compose finish that layout, then wait for its replacement buffer.
                compose.waitForIdle()
                compose.waitUntil(30_000) { !model.state.value.rendering }
                assertNull(model.state.value.error)
                compose.runOnIdle {
                    assertFalse(
                        "Renderer became busy before the interaction",
                        model.state.value.rendering,
                    )
                    assertFalse(model.state.value.values.isEmpty())
                    model.setField("exposure", .75f)
                    model.commitGesture()
                    assertEquals(.75f, model.state.value.values.getValue("exposure"), .001f)
                    assertTrue("Exposure must create a pending save", model.state.value.dirty)
                }
                compose.waitUntil(30_000) { !model.state.value.dirty && !model.state.value.saving }
                assertTrue(server.sidecar.readText().contains("crs:Exposure2012=\"0.75\""))
                val baseline = runBlocking { library.loadSidecar(photo) }
                val external =
                    server.sidecar
                        .readText()
                        .replace("crs:Exposure2012=\"0.75\"", "crs:Exposure2012=\"1\"")
                server.sidecar.writeText(external)
                runBlocking {
                    assertTrue(
                        runCatching { library.save(photo, baseline.document, baseline.baseline) }
                            .isFailure
                    )
                }
                assertEquals(external, server.sidecar.readText())
                assertArrayEquals(bytes, server.original.readBytes())
                compose.runOnIdle {
                    model.setField("exposure", 1.5f)
                    model.commitGesture()
                }
                compose.waitUntil(30_000) {
                    model.state.value.error?.contains("changed outside Maple") == true
                }
                assertTrue(model.state.value.dirty)
                assertEquals(1.5f, model.state.value.values.getValue("exposure"))
                compose.onNodeWithText("Reload saved edits").performClick()
                compose.onNodeWithText("Continue").performClick()
                compose.waitUntil(60_000) {
                    !model.state.value.dirty &&
                        !model.state.value.rendering &&
                        model.state.value.values["exposure"] == 1f
                }
                assertNull(model.state.value.error)
                assertEquals(external, server.sidecar.readText())
                compose.runOnIdle { model.disconnectCloud(source) }
                compose.waitUntil(30_000) {
                    model.state.value.sources.none { it.uri == source.uri }
                }
                assertNull(model.state.value.selected)
                assertFalse(PhotoLibrary(context).sources.any { it.uri == source.uri })
            } finally {
                runBlocking { runCatching { library.cloud.disconnect(source) } }
            }
        }
        directory.deleteRecursively()
    }
}
