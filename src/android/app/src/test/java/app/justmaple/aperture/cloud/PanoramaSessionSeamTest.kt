package app.justmaple.aperture.cloud

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class PanoramaSessionSeamTest {
    private val seams = PanoSeamConstraints(2047, 722, listOf(
        PanoSeamRegion(PanoSeamKind.Include, 1, 1000, 300, 40, 30),
        PanoSeamRegion(PanoSeamKind.Exclude, 2, 1800, 10, 200, 100),
    ))

    @Test
    fun seamRegionsPreviewAndStitchAsV1WithTheirAlignment() = runTest {
        val server = FakeServer()
        val session = panoramaSession(server)
        session.open(selection)
        finishPreview(server, session, "p1")
        seams.regions.forEach { assertNull(session.addSeam(it)) }
        assertEquals(seams, session.state.value.seams)
        session.previewSeams()
        advanceTimeBy(PanoramaSession.PREVIEW_DEBOUNCE_MS + 1)
        runCurrent()
        val constrained = server.posts("preview").last().body!!
        assertEquals("p1", constrained.getString("alignmentFrom"))
        assertEquals(seams.json().toString(), constrained.getJSONObject("seamConstraints").toString())
        assertEquals(
            """{"version":1,"canvas":{"width":2047,"height":722},"regions":[""" +
                """{"kind":"include","frame":1,"x":1000,"y":300,"width":40,"height":30},""" +
                """{"kind":"exclude","frame":2,"x":1800,"y":10,"width":200,"height":100}]}""",
            constrained.getJSONObject("seamConstraints").toString(),
        )
        server.job("p2", "done", JSONObject(previewResult.toString()).put("seamConstraints", seams.json()))
        advanceTimeBy(PanoramaSession.PREVIEW_POLL_MS + 1)
        runCurrent()
        assertEquals("p2", session.state.value.image!!.jobId)
        assertEquals("The finished preview echoes its regions", seams, session.state.value.image!!.seams)
        assertNull(session.state.value.seamBlocked)

        session.stitch()
        runCurrent()
        val stitch = server.posts("stitch").single().body!!
        assertEquals("p2", stitch.getString("alignmentFrom"))
        assertEquals(seams.json().toString(), stitch.getJSONObject("seamConstraints").toString())
        assertEquals("Regions lock while merging", session.state.value.seamBlocked,
            "Seam regions are locked while the panorama is merging.")
        session.removeSeam(0)
        assertEquals(seams, session.state.value.seams)
        session.cancelStitch()
        runCurrent()
        assertEquals(listOf("s3"), server.deletes())
        server.job("s3", "cancelled")
        advanceTimeBy(PanoramaSession.STITCH_POLL_MS + 1)
        runCurrent()
        assertEquals(PanoStitchRun.Cancelled, session.state.value.stitch)
        assertEquals("Cancelling keeps the authored regions", seams, session.state.value.seams)
        session.removeSeam(0)
        assertEquals(listOf(seams.regions[1]), session.state.value.seams!!.regions)
        session.clearSeams()
        assertNull(session.state.value.seams)
        session.close()
        runCurrent()
    }

    @Test
    fun seamRegionsNeedACurrentRotationPreviewOnASupportingServer() = runTest {
        val server = FakeServer()
        val session = panoramaSession(server)
        session.open(selection)
        finishPreview(server, session, "p1")
        val region = seams.regions[0]
        assertNotNull("Outside the canvas", session.addSeam(region.copy(x = 2040)))
        assertNotNull("No such frame", session.addSeam(region.copy(frame = 3)))
        assertNotNull("No area", session.addSeam(region.copy(width = 0)))
        assertNull(session.addSeam(region))
        session.setOptions(session.state.value.options.copy(localAlign = PanoLocalAlign.Off))
        assertNull("New geometry clears the regions", session.state.value.seams)
        assertEquals("Wait for a current preview before authoring or submitting seam regions.", session.addSeam(region))
        finishPreview(server, session, "p2")
        assertNull(session.addSeam(region))
        session.setOptions(session.state.value.options.copy(strategy = PanoStrategy.Tile))
        finishPreview(server, session, "p3")
        assertEquals("Seam regions are not supported for Tile. Choose Rotation, or Auto for a rotation panorama.",
            session.addSeam(region))
        session.previewSeams()
        runCurrent()
        assertEquals(3, server.posts("preview").size)
        assertTrue(server.posts("preview").none { it.body!!.has("seamConstraints") })
        session.close()

        val unsupported = FakeServer()
        unsupported.capabilities.put("seamConstraintsSupported", false)
        val older = panoramaSession(unsupported)
        older.open(selection)
        finishPreview(unsupported, older, "p1")
        assertEquals("This server's maple-cli cannot take seam regions.", older.addSeam(region))
        older.stitch()
        runCurrent()
        assertFalse(unsupported.posts("stitch").single().body!!.has("seamConstraints"))
        older.close()
        runCurrent()
    }

    @Test
    fun refusedSeamRegionsSurfaceTheNamedError() = runTest {
        val server = FakeServer()
        val session = panoramaSession(server)
        session.open(selection)
        finishPreview(server, session, "p1")
        assertNull(session.addSeam(seams.regions[0]))
        server.refuse = 422 to JSONObject().put("error", "invalid_seam_constraints")
            .put("message", "invalid_seam_constraints: Every region must lie wholly inside its reference canvas.")
        session.previewSeams()
        advanceTimeBy(PanoramaSession.PREVIEW_DEBOUNCE_MS + 1)
        runCurrent()
        val refused = session.state.value.preview as PanoPreviewRun.Failed
        assertEquals("invalid_seam_constraints", refused.code)
        assertEquals("The server refused these seam regions: Every region must lie wholly inside its reference canvas.",
            refused.message)
        server.refuse = null
        session.previewSeams()
        advanceTimeBy(PanoramaSession.PREVIEW_DEBOUNCE_MS + 1)
        runCurrent()
        server.jobs["p2"]!!.put("status", "failed")
            .put("error", "invalid_seam_constraints: frame 1 is both force-included and force-excluded near canvas pixel (1000, 300)")
        advanceTimeBy(PanoramaSession.PREVIEW_POLL_MS + 1)
        runCurrent()
        val contradicted = session.state.value.preview as PanoPreviewRun.Failed
        assertEquals("invalid_seam_constraints", contradicted.code)
        assertTrue(contradicted.message, contradicted.message.startsWith("The server refused these seam regions: frame 1 is both"))
        session.stitch()
        runCurrent()
        assertTrue("A failed preview leaves the shown one current", server.posts("stitch").isNotEmpty())
        server.jobs["s3"]!!.put("status", "failed").put("error", "invalid_seam_constraints: Conflicting regions")
        advanceTimeBy(PanoramaSession.STITCH_POLL_MS + 1)
        runCurrent()
        assertEquals("invalid_seam_constraints", (session.state.value.stitch as PanoStitchRun.Failed).code)
        session.close()
        runCurrent()
    }

}
