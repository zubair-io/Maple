package app.justmaple.aperture

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.*
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.cloud.CloudLibrary
import app.justmaple.aperture.cloud.PanoConfigState
import app.justmaple.aperture.cloud.PanoPreviewRun
import app.justmaple.aperture.cloud.PanoSeamKind
import app.justmaple.aperture.cloud.PanoSeamRegion
import app.justmaple.aperture.cloud.PanoStitchRun
import app.justmaple.aperture.cloud.PanoramaSession
import app.justmaple.aperture.data.Folder
import app.justmaple.aperture.data.Photo
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain

/**
 * A real server merge (#5994): `scripts/with-cloud-api.sh` provisions a classical maple-cli and
 * three overlapping synthetic frames under `pano/`, and the app drives preview, named refusal,
 * cancellation, alignment reuse, the full stitch and opening its output through the merge sheet.
 */
class PanoramaIntegrationTest {
    private lateinit var api: MapleApiFixture
    private val compose = mainThreadComposeRule<MainActivity>()
    private val session = object : ExternalResource() {
        override fun before() {
            assumeTrue(
                "Run with MAPLE_ANDROID_PANO_CLI and MAPLE_ANDROID_PANO_FIXTURES so the fixture server can merge",
                InstrumentationRegistry.getArguments().getString("mapleApiPano") == "1",
            )
            api = MapleApiFixture()
        }

        override fun after() = api.close()
    }

    @get:Rule val rules: RuleChain = RuleChain.outerRule(session).around(compose)

    private fun model() = ViewModelProvider(compose.activity)[MapleViewModel::class.java]

    private fun panoFolder(cloud: CloudLibrary): Pair<Folder, List<Photo>> {
        val root = runBlocking { cloud.list(cloud.sources.single { it.uri.host == api.server.id }.uri) }
            .folders.single { it.uri.getQueryParameter("address") == "${api.slug}:" }
        val folder = runBlocking { cloud.list(root.uri) }.folders.single { it.name == "pano" }
        val photos = runBlocking { cloud.list(folder.uri) }.photos
        assertEquals(listOf("frame_0000.dng", "frame_0001.dng", "frame_0002.dng"), photos.map { it.name }.sorted())
        return folder to photos
    }

    private fun job(id: String): JSONObject {
        val (status, text) = api.request("GET", "/api/pano/jobs/$id")
        assertEquals(text, 200, status)
        return JSONObject(text)
    }

    private fun awaitInactive(id: String) {
        val deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(5)
        while (job(id).getString("status") in setOf("queued", "running")) {
            assertTrue("Job $id never finished", System.nanoTime() < deadline)
            Thread.sleep(250)
        }
    }

    /** The sheet scrolls, so its lower controls sit below the viewport on a tablet. */
    private fun tap(tag: String) = compose.onNodeWithTag(tag).performScrollTo().assertIsEnabled().performClick()

    private fun shown(tag: String) = compose.onNodeWithTag(tag).performScrollTo().assertIsDisplayed()

    @Test
    fun realServerPreviewsRefusesCancelsStitchesAndOpensThePanorama() {
        val cloud = CloudLibrary(api.context)
        val (folder, photos) = panoFolder(cloud)
        val model = model()
        compose.runOnIdle { model.browse(folder) }
        compose.waitUntil(60_000) { !model.state.value.loading && model.state.value.photos.size == 3 }
        compose.onNodeWithTag("browse-selection-enter").performClick()
        compose.onNodeWithTag("browse-select-all").performClick()
        compose.onNodeWithTag("browse-merge-panorama").assertIsEnabled().performClick()

        val panorama = model.panorama
        compose.waitUntil(300_000) { panorama.state.value.image != null && panorama.state.value.previewCurrent }
        val ready = panorama.state.value.config as PanoConfigState.Ready
        assertTrue(ready.capabilities.ready && ready.capabilities.preview)
        val preview = panorama.state.value.image!!
        assertTrue(preview.width > 0 && preview.height > 0)
        val serverPaths = photos.map { it.uri.getQueryParameter("path")!! }.sorted()
        assertEquals(serverPaths, preview.frames.map { it.path })
        assertTrue(preview.frames.all { it.assetId.length == 24 })
        compose.waitUntil(30_000) { compose.onAllNodesWithTag("pano-preview-image").fetchSemanticsNodes().isNotEmpty() }
        shown("pano-preview-image")
        compose.onNodeWithTag("pano-preview-size").performScrollTo().assertTextContains("${preview.width} × ${preview.height} px", substring = true)
        compose.onNodeWithTag("pano-frame-0").performScrollTo().assertTextEquals("1. ${preview.frames[0].name}")
        val persisted = job(preview.jobId)
        assertEquals("done", persisted.getString("status"))
        assertEquals(preview.width, persisted.getJSONObject("result").getInt("width"))

        tap("pano-local-align-Off")
        compose.onNodeWithTag("pano-preview-size").performScrollTo().assertTextContains("out of date", substring = true)
        compose.waitUntil(300_000) {
            panorama.state.value.previewCurrent && panorama.state.value.image!!.jobId != preview.jobId
        }
        val current = panorama.state.value.image!!

        val blocking = api.request("POST", "/api/pano/stitch", JSONObject()
            .put("assetPaths", JSONArray(serverPaths)).put("libraryId", api.libraryId)
            .put("options", JSONObject().put("retention", "strict").put("localAlign", "mesh"))
            .toString().toByteArray(), mapOf("Content-Type" to "application/json"))
        assertTrue(blocking.second, blocking.first in 200..299)
        val blockingId = JSONObject(blocking.second).getString("id")
        tap("pano-create")
        compose.waitUntil(60_000) { panorama.state.value.stitch is PanoStitchRun.Failed }
        assertEquals("pano_job_running", (panorama.state.value.stitch as PanoStitchRun.Failed).code)
        shown("pano-stitch-error")
        assertEquals(200, api.request("DELETE", "/api/pano/jobs/$blockingId").first)
        awaitInactive(blockingId)

        tap("pano-stitch-retry")
        compose.waitUntil(60_000) { panorama.state.value.stitch is PanoStitchRun.Running }
        val cancelled = (panorama.state.value.stitch as PanoStitchRun.Running).jobId
        tap("pano-cancel")
        compose.waitUntil(300_000) { panorama.state.value.stitch == PanoStitchRun.Cancelled }
        assertEquals("cancelled", job(cancelled).getString("status"))
        shown("pano-stitch-cancelled")

        tap("pano-create")
        compose.waitUntil(60_000) { panorama.state.value.stitch is PanoStitchRun.Running }
        val stitchId = (panorama.state.value.stitch as PanoStitchRun.Running).jobId
        compose.activityRule.scenario.recreate()
        assertSame("Recreation keeps following the same merge", panorama, model().panorama)
        compose.waitUntil(600_000) { panorama.state.value.stitch !is PanoStitchRun.Running }
        val done = panorama.state.value.stitch as? PanoStitchRun.Done
        assertNotNull("Stitch ended as ${panorama.state.value.stitch}", done)
        assertEquals(stitchId, done!!.job.id)
        val stitched = job(stitchId)
        assertEquals("done", stitched.getString("status"))
        val result = stitched.getJSONObject("result")
        val outputPath = result.getString("outputPath")
        assertEquals(outputPath, done.job.outputPath)
        assertEquals(24, result.getString("outputAssetId").length)
        assertEquals("reused", result.getJSONObject("alignment").getString("status"))
        assertTrue(outputPath.endsWith(".png") && "/Panoramas/" in outputPath)
        assertNotEquals("The stitch's output is not the preview", current.jobId, stitchId)

        shown("pano-stitch-done")
        tap("pano-view-result")
        compose.waitUntil(120_000) {
            model.state.value.mode == PhotoMode.Preview && !model.state.value.loading &&
                model.state.value.selected?.uri?.getQueryParameter("path") == outputPath
        }
        assertNull(model.state.value.error)
        compose.waitUntil(60_000) { model.state.value.folders.any { it.name == "Panoramas" } }
        assertFalse(panorama.state.value.open)
        compose.onNodeWithTag("pano-sheet").assertDoesNotExist()
        compose.onNodeWithTag("photo-viewport").assertIsDisplayed()
    }

    private fun openMerge(): PanoramaSession {
        val (folder, _) = panoFolder(CloudLibrary(api.context))
        val model = model()
        compose.runOnIdle { model.browse(folder) }
        compose.waitUntil(60_000) { !model.state.value.loading && model.state.value.photos.size == 3 }
        compose.onNodeWithTag("browse-selection-enter").performClick()
        compose.onNodeWithTag("browse-select-all").performClick()
        compose.onNodeWithTag("browse-merge-panorama").performClick()
        return model.panorama
    }

    private fun PanoramaSession.awaitCurrent(not: String? = null) =
        compose.waitUntil(300_000) { state.value.previewCurrent && state.value.image!!.jobId != not }

    /** Typed through the field's SetText action, so no keyboard or IME key is involved. */
    private fun enterRegion(x: Int, y: Int, width: Int, height: Int) {
        listOf("x" to x, "y" to y, "width" to width, "height" to height).forEach { (field, value) ->
            compose.onNodeWithTag("pano-seam-$field").performScrollTo().performTextReplacement(value.toString())
        }
        tap("pano-seam-add")
    }

    @Test
    fun realServerAuthorsSeamRegionsRefusesContradictionsAndStitchesWithThem() {
        val panorama = openMerge()
        panorama.awaitCurrent()
        val ready = panorama.state.value.config as PanoConfigState.Ready
        assertTrue("The fixture maple-cli takes seam regions", ready.capabilities.seamConstraints)
        if (ready.capabilities.strategy) {
            val auto = panorama.state.value.image!!.jobId
            tap("pano-strategy-Tile")
            compose.onNodeWithTag("pano-seam-blocked").performScrollTo().assertTextContains("Tile", substring = true)
            compose.onNodeWithTag("pano-seam-add").assertIsNotEnabled()
            tap("pano-strategy-Auto")
            panorama.awaitCurrent(not = auto)
        }

        val preview = panorama.state.value.image!!
        val (centerX, centerY) = preview.width / 2 to preview.height / 2
        tap("pano-seam-frame-1")
        tap("pano-seam-mode-Include")
        enterRegion(centerX - 8, centerY - 8, 16, 16)
        compose.onNodeWithTag("pano-seam-region-0").assertTextContains("Include frame 2", substring = true)
        compose.onNodeWithTag("pano-seam-canvas").performScrollTo().performTouchInput {
            swipe(Offset(width * 0.45f, height * 0.45f), Offset(width * 0.55f, height * 0.55f), 400)
        }
        compose.waitUntil(5_000) { panorama.state.value.seams?.regions?.size == 2 }
        val dragged = panorama.state.value.seams!!.regions[1]
        assertEquals(1, dragged.frame)
        assertTrue(dragged.width > 0 && dragged.height > 0)
        tap("pano-seam-remove-1")
        compose.onNodeWithTag("pano-seam-region-1").assertDoesNotExist()
        val authored = panorama.state.value.seams!!
        assertEquals(listOf(PanoSeamRegion(PanoSeamKind.Include, 1, centerX - 8, centerY - 8, 16, 16)), authored.regions)
        assertEquals(preview.width to preview.height, authored.width to authored.height)

        tap("pano-seam-preview")
        panorama.awaitCurrent(not = preview.jobId)
        val constrained = panorama.state.value.image!!
        assertEquals(authored, constrained.seams)
        val persisted = job(constrained.jobId).getJSONObject("result").getJSONObject("seamConstraints")
        assertEquals(authored.json().toString(), persisted.toString())
        compose.onNodeWithTag("pano-seam-previewed").performScrollTo().assertIsDisplayed()

        tap("pano-seam-mode-Exclude")
        enterRegion(centerX - 8, centerY - 8, 16, 16)
        tap("pano-seam-preview")
        compose.waitUntil(300_000) { panorama.state.value.preview is PanoPreviewRun.Failed }
        assertEquals("invalid_seam_constraints", (panorama.state.value.preview as PanoPreviewRun.Failed).code)
        compose.onNodeWithTag("pano-preview-error").performScrollTo()
            .assertTextContains("refused these seam regions", substring = true)
        tap("pano-seam-remove-1")
        assertEquals(authored, panorama.state.value.seams)

        tap("pano-create")
        compose.waitUntil(60_000) { panorama.state.value.stitch is PanoStitchRun.Running }
        val stitchId = (panorama.state.value.stitch as PanoStitchRun.Running).jobId
        compose.onNodeWithTag("pano-seam-add").assertIsNotEnabled()
        compose.waitUntil(600_000) { panorama.state.value.stitch !is PanoStitchRun.Running }
        assertTrue("Stitch ended as ${panorama.state.value.stitch}", panorama.state.value.stitch is PanoStitchRun.Done)
        val result = job(stitchId).getJSONObject("result")
        assertEquals(authored.json().toString(), result.getJSONObject("seamConstraints").toString())
        assertEquals("reused", result.getJSONObject("alignment").getString("status"))
        compose.onNodeWithTag("pano-close").performScrollTo().performClick()
        assertFalse(panorama.state.value.open)
    }
}
