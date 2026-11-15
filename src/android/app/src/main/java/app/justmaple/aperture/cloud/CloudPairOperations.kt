package app.justmaple.aperture.cloud

import android.net.Uri
import app.justmaple.aperture.data.Photo
import org.json.JSONObject

internal class CloudPairOperations(
    private val http: CloudTransport,
    private val policy: CloudStackPolicy,
) {
    fun rename(photo: Photo, name: String): JSONObject =
        post(photo, "rename", JSONObject().put("new_filename", name).put("collision", "skip"))

    fun relocate(photo: Photo, destination: String, copy: Boolean = false): JSONObject =
        post(photo, "relocate", JSONObject()
            .put("mode", if (copy) "copy" else "move")
            .put("destination_path", destination)
            .put("collision", "skip"))

    fun trash(photo: Photo): JSONObject? {
        val target = target(photo)
        val companion = target.companion?.let { "&companion=${Uri.encode(it)}" }.orEmpty()
        val response = http.request(target.server,
            "/api/assets/${Uri.encode(target.id)}?intent=trash$companion", "DELETE")
        if (response.status == 204) return null
        return result(response, photo)
    }

    private data class Target(val server: String, val id: String, val companion: String?)

    private fun target(photo: Photo): Target {
        check(CloudLibrary.isCloud(photo.uri)) { "Choose a photo on a Maple Cloud server" }
        val server = requireNotNull(photo.uri.host) { "The photo has no Maple Cloud server" }
        val companion = photo.companion
        if (companion != null) {
            check(policy.config(server).pairOpsSupported) {
                "This server cannot safely change a RAW+JPEG pair. Upgrade the server; neither file was changed."
            }
            check(companion.uri.host == server && companion.companion == null) {
                "The RAW+JPEG pair is invalid. Reload the folder; neither file was changed."
            }
        }
        fun id(member: Photo): String {
            member.assetId?.takeIf { it.isNotBlank() }?.let { return it }
            val address = member.uri.getQueryParameter("address")
                ?: error("The photo has no server address. Reload the folder.")
            val response = http.request(server, "/api/assets/by-address?address=${Uri.encode(address)}")
            if (response.status == 404)
                error("Maple is still indexing ${member.name}. Try again shortly; neither file was changed.")
            return JSONObject(response.requireSuccess().text()).getString("id")
        }
        val primary = id(photo)
        val jpeg = companion?.let(::id)
        check(jpeg == null || jpeg != primary) { "The RAW+JPEG pair has duplicate asset IDs. Reload the folder." }
        return Target(server, primary, jpeg)
    }

    private fun post(photo: Photo, action: String, body: JSONObject): JSONObject {
        val target = target(photo)
        photo.uri.getQueryParameter("address")?.let { body.put("source_address", it) }
        target.companion?.let { body.put("companion_id", it).put("companion_collision", "skip") }
        return result(http.request(target.server, "/api/assets/${Uri.encode(target.id)}/$action",
            "POST", body.toString(), mapOf("Content-Type" to "application/json")), photo)
    }

    private fun result(response: CloudResponse, photo: Photo): JSONObject {
        val body = response.text().takeIf(String::isNotBlank)?.let(::JSONObject) ?: JSONObject()
        if (response.status == 404 && body.optString("missing") == "companion")
            error("${photo.companion?.name ?: "The JPEG"} is no longer beside the RAW. Reload the folder; neither file was changed.")
        response.requireSuccess()
        check(!body.optBoolean("skipped")) {
            "An item named \"${body.optString("collision_filename").ifEmpty { photo.name }}\" already exists. Neither file was changed."
        }
        return body
    }
}
