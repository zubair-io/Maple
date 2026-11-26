package app.justmaple.aperture.cloud

import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject

/**
 * The server's panorama routes over the authenticated cloud transport. Blocking calls, each
 * carried only by the account that started the merge, so a sign-in change never sends one.
 */
internal class PanoramaClient(private val transport: CloudTransport) {
    private fun call(
        server: String,
        account: String,
        path: String,
        method: String = "GET",
        body: String? = null,
    ): CloudResponse {
        val headers = if (body == null) emptyMap() else mapOf("Content-Type" to "application/json")
        val response = transport.request(server, path, method, body, headers, account)
        PanoramaWire.refusal(response)?.let { throw it }
        return response
    }

    private fun jobPath(id: String) = "/api/pano/jobs/${Uri.encode(id)}"

    fun capabilities(server: String, account: String): PanoCapabilities =
        PanoramaWire.capabilities(JSONObject(call(server, account, "/api/pano/config").text()))

    fun libraries(server: String, account: String): List<PanoLibrary> =
        PanoramaWire.libraries(JSONArray(call(server, account, "/api/folders").text()))

    /** A newer preview supersedes the server's running one. */
    fun preview(server: String, account: String, request: PanoRequest): String =
        PanoramaWire.createdId(JSONObject(call(server, account, "/api/pano/preview", "POST", PanoramaWire.body(request)).text()))

    /** The server cancels any active preview when a stitch is queued. */
    fun stitch(server: String, account: String, request: PanoRequest): String =
        PanoramaWire.createdId(JSONObject(call(server, account, "/api/pano/stitch", "POST", PanoramaWire.body(request)).text()))

    fun job(server: String, account: String, id: String): PanoJob = PanoramaWire.job(JSONObject(call(server, account, jobPath(id)).text()))

    /** The finished panorama preview PNG, not a library photo's preview. */
    fun previewPng(server: String, account: String, id: String): ByteArray {
        val buffer = call(server, account, jobPath(id) + "/preview").bytes()
        return ByteArray(buffer.remaining()).also(buffer::get)
    }

    fun cancel(server: String, account: String, id: String) {
        call(server, account, jobPath(id), "DELETE")
    }
}
