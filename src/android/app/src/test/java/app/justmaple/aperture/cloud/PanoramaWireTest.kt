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
}
