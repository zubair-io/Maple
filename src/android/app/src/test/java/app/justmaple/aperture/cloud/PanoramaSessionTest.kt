package app.justmaple.aperture.cloud

import app.justmaple.aperture.data.LibraryListing
import app.justmaple.aperture.data.Photo
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class PanoramaSessionTest {
    private var signedIn: String? = "https://photos.example.com#me"

    private fun TestScope.session(server: FakeServer, listing: LibraryListing = LibraryListing(emptyList(), emptyList())) =
        panoramaSession(server, listing) { signedIn }

    @Test
    fun refusesSelectionsThatNoServerCanMerge() {
        assertNotNull(PanoramaSession.refusal(listOf(photo("a.dng"))))
        assertNotNull(PanoramaSession.refusal(listOf(photo("a.dng"), photo("b.dng", server = "s2"))))
        assertNotNull(PanoramaSession.refusal(listOf(photo("a.dng"), photo("a.dng"))))
        val local = Photo(android.net.Uri.parse("content://tree/a.dng"), "a.dng", 1, 0, null)
        assertNotNull(PanoramaSession.refusal(listOf(local, photo("b.dng"))))
        assertNull(PanoramaSession.refusal(selection))
    }

    @Test
    fun previewSendsServerPathsAndShowsTheServerOrderedFrames() = runTest {
        val server = FakeServer()
        val session = session(server)
        assertNull(session.open(selection))
        runCurrent()
        assertTrue(session.state.value.preview is PanoPreviewRun.Running)
        assertTrue("Preview waits for the debounce", server.posts("preview").isEmpty())
        finishPreview(server, session, "p1")
        val body = server.posts("preview").single().body!!
        assertEquals(listOf("/srv/lib/2026/a.dng", "/srv/lib/2026/b.dng", "/srv/lib/2026/c.dng"),
            body.getJSONArray("assetPaths").let { paths -> (0 until paths.length()).map(paths::getString) })
        assertFalse("Paths are fresh; no cached ids beside them", body.has("assetIds"))
        assertEquals("a".repeat(24), body.getString("libraryId"))
        assertEquals("""{"retention":"keep","localAlign":"mesh","strategy":"auto"}""", body.getJSONObject("options").toString())
        assertFalse(body.has("alignmentFrom"))
        val image = session.state.value.image!!
        assertEquals(2047 to 722, image.width to image.height)
        assertEquals(listOf("a.dng", "b.dng", "c.dng"), image.frames.map { it.name })
        assertEquals("1".repeat(24), image.frames.first().assetId)
        assertTrue(session.state.value.previewCurrent)
        assertTrue(server.calls.any { it.path == "/api/pano/jobs/p1/preview" })
    }

    @Test
    fun anOptionChangeMakesThePreviewStaleAndReusesItsAlignment() = runTest {
        val server = FakeServer()
        val session = session(server)
        session.open(selection)
        finishPreview(server, session, "p1")
        session.setOptions(session.state.value.options.copy(strategy = PanoStrategy.Rotation, boundaryWarp = 40, autoCrop = true))
        assertFalse(session.state.value.previewCurrent)
        assertEquals("p1", session.state.value.image!!.jobId)
        finishPreview(server, session, "p2")
        val second = server.posts("preview").last().body!!
        assertEquals("p1", second.getString("alignmentFrom"))
        assertEquals("""{"retention":"keep","localAlign":"mesh","strategy":"rotation","boundaryWarp":40,"autoCrop":true}""",
            second.getJSONObject("options").toString())
        assertEquals("p2", session.state.value.image!!.jobId)
        assertTrue(session.state.value.previewCurrent)
    }

    @Test
    fun optionsTheBinaryLacksAreNeverSent() = runTest {
        val server = FakeServer()
        server.capabilities.put("strategy_supported", false).put("edges_supported", false)
        val session = session(server)
        session.open(selection)
        runCurrent()
        session.setOptions(PanoOptions(retention = PanoRetention.Strict, localAlign = PanoLocalAlign.Off,
            strategy = PanoStrategy.Tile, boundaryWarp = 50, autoCrop = true))
        finishPreview(server, session, "p1")
        assertEquals("""{"retention":"strict","localAlign":"off"}""",
            server.posts("preview").single().body!!.getJSONObject("options").toString())
    }

    @Test
    fun aPreviewSupersededWhileItsRequestIsInFlightIsCancelledOnTheServer() = runTest {
        val server = FakeServer()
        val session = session(server)
        session.open(selection)
        server.onPost = { id ->
            server.onPost = {}
            if (id == "p1") session.setOptions(session.state.value.options.copy(retention = PanoRetention.Strict))
        }
        advanceTimeBy(PanoramaSession.PREVIEW_DEBOUNCE_MS + 1)
        runCurrent()
        assertEquals(listOf("p1"), server.deletes())
        finishPreview(server, session, "p2")
        assertEquals("p2", session.state.value.image!!.jobId)
        assertEquals(PanoRetention.Strict, session.state.value.image!!.options.retention)
    }

    @Test
    fun stitchReusesThePreviewAlignmentAndFollowsTheJobToItsOutput() = runTest {
        val server = FakeServer()
        val output = Photo(CloudLibrary.address("s1", "lib:2026/Panoramas/a-pano-1.png", "/srv/lib/2026/Panoramas/a-pano-1.png"),
            "a-pano-1.png", 1, 0, null)
        val session = session(server, LibraryListing(emptyList(), listOf(output)))
        session.open(selection)
        finishPreview(server, session, "p1")
        session.stitch()
        runCurrent()
        val body = server.posts("stitch").single().body!!
        assertEquals("p1", body.getString("alignmentFrom"))
        assertEquals("a".repeat(24), body.getString("libraryId"))
        val running = session.state.value.stitch as PanoStitchRun.Running
        assertEquals("s2", running.jobId)
        server.job("s2", "running", current = 300)
        advanceTimeBy(PanoramaSession.STITCH_POLL_MS + 1)
        runCurrent()
        assertEquals("Refining matches · 50%", (session.state.value.stitch as PanoStitchRun.Running).progress!!.label)
        server.job("s2", "done", JSONObject().put("outputAssetId", "f".repeat(24))
            .put("outputPath", "/srv/lib/2026/Panoramas/a-pano-1.png").put("error", JSONObject.NULL))
        advanceTimeBy(PanoramaSession.STITCH_POLL_MS + 1)
        runCurrent()
        val done = session.state.value.stitch as PanoStitchRun.Done
        assertEquals("f".repeat(24), done.job.outputAssetId)
        val (photo, order) = session.output()!!
        assertEquals(output.uri, photo.uri)
        assertEquals(listOf(output), order)
        advanceUntilIdle()
        assertTrue("Nothing still polling once done", server.calls.count { it.path == "/api/pano/jobs/s2" } == 3)
    }

    @Test
    fun cancellingAStitchAsksTheServerAndWaitsForItsVerdict() = runTest {
        val server = FakeServer()
        server.capabilities.put("preview_supported", false)
        val session = session(server)
        session.open(selection)
        runCurrent()
        session.stitch()
        runCurrent()
        assertFalse(server.posts("stitch").single().body!!.has("alignmentFrom"))
        session.cancelStitch()
        runCurrent()
        assertEquals(listOf("s1"), server.deletes())
        assertTrue((session.state.value.stitch as PanoStitchRun.Running).cancelRequested)
        server.job("s1", "cancelled")
        advanceTimeBy(PanoramaSession.STITCH_POLL_MS + 1)
        runCurrent()
        assertEquals(PanoStitchRun.Cancelled, session.state.value.stitch)
        session.retryStitch()
        runCurrent()
        assertEquals(2, server.posts("stitch").size)
        session.close()
        runCurrent()
    }

    @Test
    fun namedRefusalsSurfaceAndRetrySubmitsAgain() = runTest {
        val server = FakeServer()
        val session = session(server)
        session.open(selection)
        runCurrent()
        server.refuse = 409 to JSONObject().put("error", "pano_not_provisioned").put("message", "Panorama stitching is not configured.")
        session.stitch()
        runCurrent()
        val failed = session.state.value.stitch as PanoStitchRun.Failed
        assertEquals("pano_not_provisioned", failed.code)
        assertEquals("Panorama stitching is not configured.", failed.message)
        assertNull(failed.jobId)
        server.refuse = 409 to JSONObject().put("error", "pano_job_running").put("jobId", "x")
        session.retryStitch()
        runCurrent()
        assertEquals("pano_job_running", (session.state.value.stitch as PanoStitchRun.Failed).code)
        server.refuse = null
        session.retryStitch()
        runCurrent()
        assertTrue(session.state.value.stitch is PanoStitchRun.Running)
        session.close()
        runCurrent()
    }

    @Test
    fun cancellingWhileQueuingWaitsForTheIdAndCancelsThatJob() = runTest {
        val server = FakeServer()
        server.capabilities.put("preview_supported", false)
        val session = session(server)
        session.open(selection)
        runCurrent()
        server.onPost = {
            session.cancelStitch()
            assertTrue("Create stays unavailable until the id is cancelled", session.state.value.stitching)
            session.stitch()
        }
        session.stitch()
        runCurrent()
        assertEquals(1, server.posts("stitch").size)
        assertEquals(listOf("s1"), server.deletes())
        assertTrue((session.state.value.stitch as PanoStitchRun.Running).cancelRequested)
        server.job("s1", "cancelled")
        advanceTimeBy(PanoramaSession.STITCH_POLL_MS + 1)
        runCurrent()
        assertEquals(PanoStitchRun.Cancelled, session.state.value.stitch)
        assertEquals(setOf("https://photos.example.com#me"), server.accounts)
    }

    @Test
    fun aFailedDeferredCancelCanBeRetried() = runTest {
        val server = FakeServer()
        server.capabilities.put("preview_supported", false)
        val session = session(server)
        session.open(selection)
        runCurrent()
        server.failDelete = true
        server.onPost = { session.cancelStitch() }
        session.stitch()
        runCurrent()
        val running = session.state.value.stitch as PanoStitchRun.Running
        assertFalse("Cancel is offered again", running.cancelRequested)
        assertEquals("unreachable", session.state.value.outputError)
        server.failDelete = false
        session.cancelStitch()
        runCurrent()
        assertEquals(listOf("s1"), server.deletes().filter { it == "s1" }.distinct())
        assertTrue((session.state.value.stitch as PanoStitchRun.Running).cancelRequested)
        assertNull(session.state.value.outputError)
        session.close()
        runCurrent()
    }

    @Test
    fun closingAfterLostContactStillCancelsTheJob() = runTest {
        val server = FakeServer()
        server.capabilities.put("preview_supported", false)
        val session = session(server)
        session.open(selection)
        runCurrent()
        server.failJobs = true
        session.stitch()
        advanceTimeBy(PanoramaSession.STITCH_POLL_MS * 3)
        runCurrent()
        val failed = session.state.value.stitch as PanoStitchRun.Failed
        assertEquals("s1", failed.jobId)
        session.close()
        runCurrent()
        assertEquals(listOf("s1"), server.deletes())
    }

    @Test
    fun aCancelTheServerNeverConfirmsStillLetsTheMergeClose() = runTest {
        val server = FakeServer()
        server.capabilities.put("preview_supported", false)
        val session = session(server)
        session.open(selection)
        runCurrent()
        session.stitch()
        runCurrent()
        assertFalse(session.state.value.closable)
        session.cancelStitch()
        advanceTimeBy(PanoramaSession.STITCH_POLL_MS * 10)
        runCurrent()
        val waiting = session.state.value
        assertEquals("queued", server.jobs.getValue("s1").getString("status"))
        assertTrue(waiting.stitching)
        assertTrue(waiting.cancelling)
        assertTrue(waiting.closable)
        session.close()
        runCurrent()
        assertFalse(session.state.value.open)
        assertEquals(listOf("s1", "s1"), server.deletes())
    }

    @Test
    fun aCancelPressedWhileQueuingLetsTheMergeCloseAndStillCancelsThatJob() = runTest {
        val server = FakeServer()
        server.capabilities.put("preview_supported", false)
        val session = session(server)
        session.open(selection)
        runCurrent()
        server.onPost = {
            session.cancelStitch()
            assertTrue(session.state.value.closable)
            session.close()
        }
        session.stitch()
        runCurrent()
        assertFalse(session.state.value.open)
        assertEquals(listOf("s1"), server.deletes())
    }

    @Test
    fun closingAsTheStitchRequestReturnsStillCancelsItsJob() = runTest {
        val server = FakeServer()
        server.capabilities.put("preview_supported", false)
        val offMain = ArrayDeque<Runnable>()
        val queuedIo = object : kotlinx.coroutines.CoroutineDispatcher() {
            override fun dispatch(context: kotlin.coroutines.CoroutineContext, block: Runnable) {
                offMain += block
            }
        }
        fun settle() {
            runCurrent()
            while (offMain.isNotEmpty()) {
                offMain.removeFirst().run()
                runCurrent()
            }
        }
        val session = PanoramaSession(this, PanoramaClient(server), { signedIn }, { LibraryListing(emptyList(), emptyList()) }, queuedIo)
        session.open(selection)
        settle()
        session.stitch()
        runCurrent()
        session.cancelStitch()
        offMain.removeFirst().run()
        assertEquals(1, server.posts("stitch").size)
        session.close()
        settle()
        assertFalse(session.state.value.open)
        assertEquals(listOf("s1"), server.deletes())
    }

    @Test
    fun createAfterLostContactFollowsTheRetainedJobInsteadOfReplacingIt() = runTest {
        val server = FakeServer()
        server.capabilities.put("preview_supported", false)
        val session = session(server)
        session.open(selection)
        runCurrent()
        server.failJobs = true
        session.stitch()
        advanceTimeBy(PanoramaSession.STITCH_POLL_MS * 3)
        runCurrent()
        assertEquals("s1", (session.state.value.stitch as PanoStitchRun.Failed).jobId)
        session.setOptions(session.state.value.options.copy(localAlign = PanoLocalAlign.Off))
        server.failJobs = false
        server.job("s1", "running", current = 300)
        session.stitch()
        runCurrent()
        assertEquals("s1", (session.state.value.stitch as PanoStitchRun.Running).jobId)
        assertEquals(1, server.posts("stitch").size)
        session.close()
        runCurrent()
        assertEquals(listOf("s1"), server.deletes())
    }

    @Test
    fun aPreviewWhoseStatusCannotBeReadIsCancelledOnTheServer() = runTest {
        val server = FakeServer()
        val session = session(server)
        session.open(selection)
        runCurrent()
        server.failJobs = true
        advanceTimeBy(PanoramaSession.PREVIEW_DEBOUNCE_MS + 1)
        runCurrent()
        assertTrue(session.state.value.preview is PanoPreviewRun.Failed)
        assertEquals(listOf("p1"), server.deletes())
        session.close()
        runCurrent()
        assertEquals("Nothing is left to cancel on close", listOf("p1"), server.deletes())
    }

    @Test
    fun aFailedJobShowsTheServerError() = runTest {
        val server = FakeServer()
        server.capabilities.put("preview_supported", false)
        val session = session(server)
        session.open(selection)
        runCurrent()
        session.stitch()
        runCurrent()
        server.job("s1", "failed")
        advanceTimeBy(PanoramaSession.STITCH_POLL_MS + 1)
        runCurrent()
        assertEquals("Not enough overlap", (session.state.value.stitch as PanoStitchRun.Failed).message)
    }

    @Test
    fun closingWhileAStitchIsQueuedCancelsTheJobWhenItsIdArrives() = runTest {
        val server = FakeServer()
        server.capabilities.put("preview_supported", false)
        val session = session(server)
        session.open(selection)
        runCurrent()
        server.onPost = { session.close() }
        session.stitch()
        runCurrent()
        assertEquals(listOf("s1"), server.deletes())
        assertFalse(session.state.value.open)
    }

    @Test
    fun closingARunningStitchCancelsItOnTheServer() = runTest {
        val server = FakeServer()
        server.capabilities.put("preview_supported", false)
        val session = session(server)
        session.open(selection)
        runCurrent()
        session.stitch()
        runCurrent()
        session.close()
        runCurrent()
        assertEquals(listOf("s1"), server.deletes())
        advanceUntilIdle()
        assertEquals("Polling stops with the sheet", 1, server.calls.count { it.path == "/api/pano/jobs/s1" && it.method == "GET" })
    }

    @Test
    fun anAccountChangeDropsTheMergeWithoutPublishingOrCancelling() = runTest {
        val server = FakeServer()
        val session = session(server)
        session.open(selection)
        finishPreview(server, session, "p1")
        session.stitch()
        runCurrent()
        signedIn = "https://photos.example.com#someone-else"
        server.job("s2", "done", JSONObject().put("outputPath", "/srv/lib/2026/Panoramas/x.png"))
        advanceTimeBy(PanoramaSession.STITCH_POLL_MS + 1)
        runCurrent()
        assertFalse(session.state.value.open)
        assertNull(session.state.value.image)
        assertTrue("The other account's token never cancels this job", server.deletes().isEmpty())
        signedIn = null
        assertEquals("This server is no longer connected.", session.open(selection))
    }

    @Test
    fun theConfigFailureAndNotProvisionedStatesAreDistinct() = runTest {
        val server = FakeServer()
        server.capabilities.put("enabled", false)
        val session = session(server)
        session.open(selection)
        runCurrent()
        val ready = session.state.value.config as PanoConfigState.Ready
        assertFalse(ready.capabilities.ready)
        session.stitch()
        runCurrent()
        assertTrue(server.posts("stitch").isEmpty())
        assertTrue("No preview without a provisioned binary", server.posts("preview").isEmpty())
    }
}
