package app.justmaple.aperture.data

import app.justmaple.aperture.cloud.CloudLibrary
import app.justmaple.aperture.generated.AdjustmentFields
import java.io.File
import java.security.MessageDigest
import org.json.JSONObject

internal data class CachedDerivative(val file: File, val inserted: Boolean)

/** Immutable payloads and an atomic validator index keep concurrent responses paired. */
internal class CloudDerivativeCache(private val cloud: CloudLibrary, private val folder: File) {
    private data class Entry(val file: File, val etag: String?)

    fun load(photo: Photo, edge: Int): CachedDerivative? {
        folder.mkdirs()
        val key =
            digest(
                "cloud-derivative-v1:${AdjustmentFields.pipelineOutputVersion}:${photo.key}:$edge"
                    .toByteArray()
            )
        val index = File(folder, "cloud-$key.json")
        val cached = runCatching {
            val record = JSONObject(index.readText())
            val content = record.getString("content")
            require(content.matches(Regex("[0-9a-f]{64}")))
            val file = File(folder, "cloud-$key-$content.avif")
            require(file.isFile && file.length() > 0)
            Entry(file, record.optString("etag").takeIf { it.isNotEmpty() })
        }
            .getOrNull()
        val fetched = cloud.derivative(photo, edge, cached?.etag)
        val response =
            if (fetched?.status == 304 && cached?.file?.isFile != true) {
                // Shared LRU eviction can race validation; retry without a missing body.
                cloud.derivative(photo, edge, null)
            } else fetched
        if (response == null) return null
        if (response.status == 304) {
            val file = checkNotNull(cached).file
            check(file.isFile && file.length() > 0) { "Cloud cache was evicted during validation" }
            file.setLastModified(System.currentTimeMillis())
            index.setLastModified(System.currentTimeMillis())
            return CachedDerivative(file, false)
        }
        val bytes = response.requireSuccess().body
        check(bytes.isNotEmpty()) { "Cloud derivative is empty" }
        val content = digest(bytes)
        val payload = File(folder, "cloud-$key-$content.avif")
        if (!payload.isFile) publish(payload, bytes)
        publish(
            index,
            JSONObject()
                .put("content", content)
                .put("etag", response.etag.orEmpty())
                .toString()
                .toByteArray(),
        )
        payload.setLastModified(System.currentTimeMillis())
        return CachedDerivative(payload, true)
    }

    private fun publish(target: File, bytes: ByteArray) {
        val temporary = File.createTempFile("cloud-", ".tmp", folder)
        try {
            temporary.writeBytes(bytes)
            check(temporary.renameTo(target)) { "Could not cache cloud derivative" }
        } finally {
            temporary.delete()
        }
    }

    private fun digest(bytes: ByteArray) =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
