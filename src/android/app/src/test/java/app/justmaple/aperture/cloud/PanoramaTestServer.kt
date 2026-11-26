package app.justmaple.aperture.cloud

import android.os.CancellationSignal
import app.justmaple.aperture.data.LibraryListing
import app.justmaple.aperture.data.Photo
import java.io.File
import java.io.OutputStream
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*

internal data class Call(val method: String, val path: String, val body: JSONObject?)

/** The panorama and folder routes, answered in-process. */
internal class FakeServer : CloudTransport {
    val calls = mutableListOf<Call>()
    var capabilities = JSONObject()
        .put("enabled", true).put("maple_cli_path", "/opt/maple-cli")
        .put("strategy_supported", true).put("preview_supported", true)
        .put("edges_supported", true).put("seamConstraintsSupported", true)
    val jobs = mutableMapOf<String, JSONObject>()
    var next = 0
    var refuse: Pair<Int, JSONObject>? = null
    var onPost: (String) -> Unit = {}

    fun job(id: String, status: String, result: JSONObject? = null, current: Int = 0) {
        jobs[id] = JSONObject().put("id", id).put("kind", if (id.startsWith("p")) "pano_preview" else "pano_stitch")
            .put("status", status).put("progress", JSONObject().put("current", current).put("total", 600))
            .put("result", result ?: JSONObject.NULL).put("error", if (status == "failed") "Not enough overlap" else JSONObject.NULL)
            .put("cancel_requested", false)
    }

    private fun json(value: Any, status: Int = 200) = CloudResponse(status, value.toString().toByteArray(), null, null)

    var failJobs = false
    var failDelete = false
    val accounts = mutableSetOf<String>()

    override fun request(id: String, path: String, method: String, body: String?, headers: Map<String, String>): CloudResponse =
        error("Panorama requests must name the account that started them")

    override fun request(id: String, path: String, method: String, body: String?, headers: Map<String, String>, account: String): CloudResponse {
        assertEquals("s1", id)
        accounts += account
        if (failDelete && method == "DELETE") throw java.io.IOException("unreachable")
        if (failJobs && method == "GET" && path.startsWith("/api/pano/jobs/")) throw java.io.IOException("unreachable")
        calls += Call(method, path, body?.let(::JSONObject))
        if (body != null) assertEquals("application/json", headers["Content-Type"])
        return when {
            path == "/api/pano/config" -> json(capabilities)
            path == "/api/folders" -> json(JSONArray()
                .put(JSONObject().put("id", "a".repeat(24)).put("slug", "lib").put("path", "/srv/lib"))
                .put(JSONObject().put("id", "b".repeat(24)).put("slug", "nested").put("path", "/srv/lib/nested")))
            method == "POST" -> {
                refuse?.let { (status, error) -> return json(error, status) }
                val created = (if (path.endsWith("preview")) "p" else "s") + ++next
                job(created, "queued")
                onPost(created)
                json(JSONObject().put("id", created), 201)
            }
            method == "DELETE" -> {
                val target = path.substringAfterLast('/')
                jobs[target]?.put("cancel_requested", true)
                json(JSONObject().put("ok", true))
            }
            path.endsWith("/preview") -> CloudResponse(200, byteArrayOf(0x89.toByte(), 'P'.code.toByte()), null, null)
            else -> jobs[path.substringAfterLast('/')]?.let(::json) ?: json(JSONObject().put("error", "Pano job not found"), 404)
        }
    }

    override fun download(id: String, path: String, output: OutputStream, signal: CancellationSignal?) = error("unused")
    override fun upload(id: String, path: String, file: File, headers: Map<String, String>, account: String) = error("unused")

    fun posts(kind: String) = calls.filter { it.method == "POST" && it.path == "/api/pano/$kind" }
    fun deletes() = calls.filter { it.method == "DELETE" }.map { it.path.substringAfterLast('/') }
}

internal fun photo(name: String, server: String = "s1", folder: String = "2026") =
    Photo(CloudLibrary.address(server, "lib:$folder/$name", "/srv/lib/$folder/$name"), name, 1, 0, null)

internal val selection = listOf(photo("c.dng"), photo("a.dng"), photo("b.dng"))
internal val previewResult = JSONObject().put("width", 2047).put("height", 722)
    .put("frames", JSONArray()
        .put(JSONObject().put("assetId", "1".repeat(24)).put("path", "/srv/lib/2026/a.dng"))
        .put(JSONObject().put("assetId", "2".repeat(24)).put("path", "/srv/lib/2026/b.dng"))
        .put(JSONObject().put("assetId", "3".repeat(24)).put("path", "/srv/lib/2026/c.dng")))

internal fun TestScope.panoramaSession(
    server: FakeServer,
    listing: LibraryListing = LibraryListing(emptyList(), emptyList()),
    signedIn: () -> String? = { "https://photos.example.com#me" },
) =
    PanoramaSession(this, PanoramaClient(server), { if (it == "s1") signedIn() else null }, { listing }, coroutineContext[kotlin.coroutines.ContinuationInterceptor]!!)

internal fun TestScope.finishPreview(server: FakeServer, session: PanoramaSession, id: String) {
    advanceTimeBy(PanoramaSession.PREVIEW_DEBOUNCE_MS + 1)
    runCurrent()
    server.job(id, "done", previewResult)
    advanceTimeBy(PanoramaSession.PREVIEW_POLL_MS + 1)
    runCurrent()
    assertNotNull(session.state.value.image)
}
