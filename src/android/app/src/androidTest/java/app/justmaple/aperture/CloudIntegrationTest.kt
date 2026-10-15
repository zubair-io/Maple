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
            val cancelledBrowser = library.cloud.begin(server.origin)
            server.expectedChallenge = cancelledBrowser.getQueryParameter("code_challenge")!!
            val cancelledCallback =
                Uri.parse("maple-app://auth-success")
                    .buildUpon()
                    .appendQueryParameter("state", cancelledBrowser.getQueryParameter("state"))
                    .appendQueryParameter("code", "fixture-code")
                    .build()
            val redeemEntered = java.util.concurrent.CountDownLatch(1)
            val releaseRedeem = java.util.concurrent.CountDownLatch(1)
            server.redeemEntered = redeemEntered
            server.releaseRedeem = releaseRedeem
            val signIn = java.util.concurrent.Executors.newSingleThreadExecutor()
            try {
                val cancelled =
                    signIn.submit<app.justmaple.aperture.data.Folder> {
                        runBlocking { library.cloud.complete(cancelledCallback) }
                    }
                assertTrue(redeemEntered.await(10, java.util.concurrent.TimeUnit.SECONDS))
                library.cloud.cancelLogin()
                releaseRedeem.countDown()
                assertTrue(
                    runCatching { cancelled.get(30, java.util.concurrent.TimeUnit.SECONDS) }
                        .isFailure
                )
                assertFalse(
                    "Cancelled sign-in must not persist credentials",
                    library.sources.any { it.name.startsWith("127.0.0.1:") },
                )
            } finally {
                releaseRedeem.countDown()
                signIn.shutdownNow()
            }
            server.redeemEntered = null
            server.releaseRedeem = null
            server.logoutEntered = java.util.concurrent.CountDownLatch(1)
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
                val pendingPreview = android.os.Build.VERSION.SDK_INT >= 31
                val previewStart = compose.mainClock.currentTime
                val initialThumbs = server.thumbCount
                if (pendingPreview) server.previewPendingResponses = 2
                compose.runOnIdle { model.open(photo) }
                compose.waitUntil(30_000) {
                    !model.state.value.loading && model.state.value.selected != null
                }
                if (pendingPreview) {
                    compose.waitUntil(30_000) { server.previewSuccesses > 0 }
                    assertEquals(3, server.previewCount)
                    assertTrue(server.thumbCount > initialThumbs)
                    assertTrue(compose.mainClock.currentTime - previewStart >= 2_000)
                    assertEquals(PhotoMode.Preview, model.state.value.mode)
                    assertEquals(photo, model.state.value.selected)
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
                for (back in listOf(true, false)) {
                    compose.waitForIdle()
                    compose.waitUntil(30_000) { !model.state.value.rendering }
                    val entered = java.util.concurrent.CountDownLatch(1)
                    val release = java.util.concurrent.CountDownLatch(1)
                    val previousSaves = server.saveCount
                    server.saveEntered = entered
                    server.releaseSave = release
                    try {
                        compose.runOnIdle {
                            model.setField("exposure", .5f)
                            model.commitGesture()
                            assertEquals(.5f, model.state.value.values.getValue("exposure"))
                            assertTrue(model.state.value.dirty)
                            if (back) model.back() else model.open(photo)
                        }
                        assertTrue(entered.await(10, java.util.concurrent.TimeUnit.SECONDS))
                        compose.runOnIdle {
                            assertTrue(model.state.value.saving)
                            model.setField("exposure", .75f)
                            model.commitGesture()
                            assertEquals(.75f, model.state.value.values.getValue("exposure"))
                            assertTrue(model.state.value.dirty)
                        }
                    } finally {
                        release.countDown()
                    }
                    compose.waitUntil(30_000) {
                        !model.state.value.loading &&
                            !model.state.value.saving &&
                            model.state.value.mode ==
                                if (back) PhotoMode.Preview else PhotoMode.Edit
                    }
                    assertTrue(
                        "Navigation must save the late edit",
                        server.sidecar.readText().contains("crs:Exposure2012=\"0.75\""),
                    )
                    assertEquals(previousSaves + 2, server.saveCount)
                    assertFalse(model.state.value.dirty)
                    assertNull(model.state.value.error)
                    assertArrayEquals(bytes, server.original.readBytes())
                    server.saveEntered = null
                    server.releaseSave = null
                    if (back) compose.runOnIdle { model.edit() }
                    compose.waitUntil(60_000) {
                        model.state.value.values.isNotEmpty() && !model.state.value.rendering
                    }
                    compose.waitForIdle()
                    compose.waitUntil(30_000) { !model.state.value.rendering }
                    assertEquals(.75f, model.state.value.values.getValue("exposure"))
                }
                for (editing in listOf(false, true)) {
                    if (!editing) {
                        compose.runOnIdle { model.back() }
                        compose.waitUntil(30_000) { model.state.value.mode == PhotoMode.Preview }
                    }
                    val xml = server.sidecar.readBytes()
                    val entered = java.util.concurrent.CountDownLatch(1)
                    val release = java.util.concurrent.CountDownLatch(1)
                    server.loadEntered = entered
                    server.releaseLoad = release
                    try {
                        compose.runOnIdle { model.open(photo) }
                        assertTrue(entered.await(10, java.util.concurrent.TimeUnit.SECONDS))
                        compose.runOnIdle {
                            assertTrue(model.state.value.loading)
                            assertTrue(model.state.value.values.isEmpty())
                            model.setField("exposure", 2f)
                            model.attribute("xmp:Rating", "5")
                            model.undo()
                            model.redo()
                            model.edit()
                            assertFalse(model.state.value.dirty)
                            assertFalse(model.state.value.canUndo)
                            assertNull(model.state.value.document.attribute("xmp:Rating"))
                        }
                        if (!editing)
                            compose
                                .onNodeWithContentDescription("Rate 5 stars")
                                .assertIsNotEnabled()
                        compose.onNodeWithContentDescription("More photo actions").performClick()
                        compose.onNodeWithText("Photo Info").performClick()
                        compose.onNodeWithText("Export XMP sidecar…").assertIsNotEnabled()
                        compose.onNodeWithContentDescription("More photo actions").performClick()
                        compose.onNodeWithText("Photo Info").performClick()
                    } finally {
                        release.countDown()
                    }
                    compose.waitUntil(60_000) {
                        !model.state.value.loading && !model.state.value.rendering
                    }
                    assertEquals("0.75", model.state.value.document.attribute("crs:Exposure2012"))
                    assertArrayEquals(xml, server.sidecar.readBytes())
                    assertArrayEquals(bytes, server.original.readBytes())
                    server.loadEntered = null
                    server.releaseLoad = null
                    if (!editing) compose.runOnIdle { model.edit() }
                    compose.waitUntil(60_000) {
                        model.state.value.values.isNotEmpty() && !model.state.value.rendering
                    }
                    compose.waitForIdle()
                    compose.waitUntil(30_000) { !model.state.value.rendering }
                }
                compose.runOnIdle { model.back() }
                compose.waitUntil(30_000) { model.state.value.mode == PhotoMode.Preview }
                val abandonedLoad = java.util.concurrent.CountDownLatch(1)
                val releaseAbandoned = java.util.concurrent.CountDownLatch(1)
                server.loadEntered = abandonedLoad
                server.releaseLoad = releaseAbandoned
                try {
                    compose.runOnIdle { model.open(photo) }
                    assertTrue(abandonedLoad.await(10, java.util.concurrent.TimeUnit.SECONDS))
                    compose.runOnIdle { model.back() }
                    compose.waitUntil(30_000) { model.state.value.mode == PhotoMode.Browse }
                    assertFalse("Back must clear the abandoned spinner", model.state.value.loading)
                    assertTrue(model.state.value.photos.contains(photo))
                } finally {
                    releaseAbandoned.countDown()
                    server.loadEntered = null
                    server.releaseLoad = null
                }
                compose.runOnIdle { model.open(photo) }
                compose.waitUntil(30_000) {
                    !model.state.value.loading && model.state.value.mode == PhotoMode.Preview
                }
                assertNull(model.state.value.error)
                compose.runOnIdle { model.edit() }
                compose.waitUntil(60_000) {
                    model.state.value.values.isNotEmpty() && !model.state.value.rendering
                }
                compose.waitForIdle()
                compose.waitUntil(30_000) { !model.state.value.rendering }
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
                compose.waitForIdle()
                compose.waitUntil(30_000) { !model.state.value.rendering }
                compose.runOnIdle {
                    model.setField("exposure", 1.5f)
                    model.commitGesture()
                    assertEquals(1.5f, model.state.value.values.getValue("exposure"))
                    assertTrue(model.state.value.dirty)
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
                val refreshEntered = java.util.concurrent.CountDownLatch(1)
                val releaseRefresh = java.util.concurrent.CountDownLatch(1)
                server.refreshEntered = refreshEntered
                server.releaseRefresh = releaseRefresh
                server.forceRefresh = true
                val network = java.util.concurrent.Executors.newSingleThreadExecutor()
                try {
                    val refresh = network.submit { runBlocking { library.list(source.uri) } }
                    assertTrue(refreshEntered.await(10, java.util.concurrent.TimeUnit.SECONDS))
                    compose.runOnIdle { model.disconnectCloud(source) }
                    assertFalse(
                        "Logout must wait for the in-flight refresh",
                        server.logoutEntered.await(250, java.util.concurrent.TimeUnit.MILLISECONDS),
                    )
                    releaseRefresh.countDown()
                    refresh.get(30, java.util.concurrent.TimeUnit.SECONDS)
                } finally {
                    releaseRefresh.countDown()
                    network.shutdownNow()
                }
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
