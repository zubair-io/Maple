package app.justmaple.aperture.cloud

import java.io.IOException
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class PanoramaWireTest {
    private fun response(status: Int, body: String) = CloudResponse(status, body.toByteArray(), null, null)

    @Test
    fun decodesAPreviewJobWithItsCanvasAndOrderedFrames() {
        val job = PanoramaWire.job(JSONObject("""
            {"id":"6650a1","kind":"pano_preview","status":"done","progress":{"current":500,"total":600},
             "result":{"width":2047,"height":722,"matcherNote":"ML models missing; classical ran",
               "alignment":{"status":"solved","stale_reason":null},
               "frames":[{"assetId":"b","path":"/srv/lib/b.dng"},{"assetId":"a","path":"/srv/lib/z.dng"}]},
             "error":null,"cancel_requested":false}"""))
        assertEquals(PanoJobStatus.Done, job.status)
        assertEquals(2047 to 722, job.width to job.height)
        assertEquals(listOf("b", "a"), job.frames.map { it.assetId })
        assertEquals("z.dng", job.frames[1].name)
        assertEquals("solved", job.alignment)
        assertEquals("ML models missing; classical ran", job.matcherNote)
        assertNull(job.error)
        assertEquals("Compositing · 83%", job.progress.label)
        assertEquals("Starting…", PanoProgress(0, 0).label)
    }

    @Test
    fun aJobWithoutAResultAndAnUnknownStatusAreHandled() {
        val queued = PanoramaWire.job(JSONObject("""{"id":"x","kind":"pano_stitch","status":"queued","result":null}"""))
        assertTrue(queued.status.active)
        assertTrue(queued.frames.isEmpty())
        assertNull(queued.outputPath)
        assertThrows(IOException::class.java) {
            PanoramaWire.job(JSONObject("""{"id":"x","status":"paused"}"""))
        }
    }

    @Test
    fun namedRefusalsKeepTheirCodeAndServerMessage() {
        assertNull(PanoramaWire.refusal(response(201, """{"id":"x"}""")))
        val unprovisioned = PanoramaWire.refusal(response(409,
            """{"error":"pano_not_provisioned","message":"Go to Settings > Pano."}"""))!!
        assertEquals("pano_not_provisioned", unprovisioned.code)
        assertEquals("Go to Settings > Pano.", unprovisioned.message)
        assertTrue(unprovisioned.settingsFixable)
        val running = PanoramaWire.refusal(response(409, """{"error":"pano_job_running","jobId":"y"}"""))!!
        assertFalse(running.settingsFixable)
        assertTrue(running.message!!.contains("already being merged"))
        val opaque = PanoramaWire.refusal(response(502, "<html>"))!!
        assertEquals("", opaque.code)
        assertEquals("Panorama request failed (HTTP 502).", opaque.message)
    }

    @Test
    fun theOutputBelongsToTheLongestContainingLibrary() {
        val libraries = listOf(PanoLibrary("1", "lib", "/srv/lib"), PanoLibrary("2", "nested", "/srv/lib/nested/"),
            PanoLibrary("3", "other", "/srv/library"))
        assertEquals("2", PanoramaWire.libraryHolding(libraries, "/srv/lib/nested/Panoramas/a.png")?.id)
        assertEquals("1", PanoramaWire.libraryHolding(libraries, "/srv/lib/Panoramas/a.png")?.id)
        assertEquals("3", PanoramaWire.libraryHolding(libraries, "/srv/library/a.png")?.id)
        assertNull(PanoramaWire.libraryHolding(libraries, "/tmp/a.png"))
    }

    @Test
    fun seamDragsSnapToWholePixelsInsideTheCanvasAndDecodeFromResults() {
        assertEquals(PanoSeamRegion(PanoSeamKind.Exclude, 2, 9, 0, 12, 6),
            PanoSeamConstraints.dragRegion(20.4f, 5.2f, 9.7f, -3f, 100, 50, PanoSeamKind.Exclude, 2))
        assertEquals(PanoSeamRegion(PanoSeamKind.Include, 0, 90, 40, 10, 10),
            PanoSeamConstraints.dragRegion(90f, 40f, 140f, 80f, 100, 50, PanoSeamKind.Include, 0))
        assertNull(PanoSeamConstraints.dragRegion(5f, 5f, 5f, 30f, 100, 50, PanoSeamKind.Include, 0))
        val canvas = PanoSeamConstraints(100, 50, emptyList())
        assertFalse(canvas.fits(PanoSeamRegion(PanoSeamKind.Include, 0, Int.MAX_VALUE, 0, Int.MAX_VALUE, 1)))
        val job = PanoramaWire.job(JSONObject("""
            {"id":"s","kind":"pano_stitch","status":"done","result":{"outputPath":"/srv/lib/Panoramas/a.png",
             "seamConstraints":{"version":1,"canvas":{"width":100,"height":50},
               "regions":[{"kind":"exclude","frame":1,"x":2,"y":3,"width":4,"height":5}]}}}"""))
        assertEquals(PanoSeamConstraints(100, 50, listOf(PanoSeamRegion(PanoSeamKind.Exclude, 1, 2, 3, 4, 5))),
            job.seamConstraints)
        assertNull(PanoSeamConstraints.parse(JSONObject("""{"version":2,"canvas":{},"regions":[]}""")))
        assertNull(PanoSeamConstraints.parse(JSONObject(
            """{"version":1,"canvas":{"width":1,"height":1},"regions":[{"kind":"blend"}]}""")))
        val refused = PanoramaWire.refusal(response(422,
            """{"error":"invalid_seam_constraints","message":"invalid_seam_constraints: regions must be an array."}"""))!!
        assertEquals("The server refused these seam regions: regions must be an array.", refused.message)
        assertEquals("invalid_seam_constraints" to "The server refused these seam regions: Conflicting regions",
            PanoramaWire.failure("invalid_seam_constraints: Conflicting regions", "x"))
        assertEquals("" to "Not enough overlap", PanoramaWire.failure("Not enough overlap", "x"))
    }

    @Test
    fun seamRegionsAreSentOnlyWhereTheServerSupportsThem() {
        val regions = PanoSeamConstraints(100, 50, listOf(PanoSeamRegion(PanoSeamKind.Include, 1, 2, 3, 4, 5)))
        fun body(supported: Boolean) = JSONObject(PanoramaWire.body(PanoRequest(
            listOf("/srv/lib/a.dng"), "lib", PanoOptions(), PanoCapabilities(true, true, true, true, true, supported),
            seamConstraints = regions)))
        assertFalse(body(supported = false).has("seamConstraints"))
        assertEquals(regions.json().toString(), body(supported = true).getJSONObject("seamConstraints").toString())
    }
}
