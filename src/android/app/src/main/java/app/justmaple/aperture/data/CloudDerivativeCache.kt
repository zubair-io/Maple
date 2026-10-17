package app.justmaple.aperture.data

import app.justmaple.aperture.cloud.CloudLibrary
import java.io.File
import java.io.OutputStream
import java.nio.ByteBuffer
import java.security.MessageDigest
import org.json.JSONObject

internal data class CachedDerivative(
    val image: OpenThumbnail,
    val index: File,
    val inserted: Boolean,
)

/** Immutable payloads and an atomic validator index keep concurrent responses paired. */
internal class CloudDerivativeCache(private val cloud: CloudLibrary, private val folder: File) {
    private data class Entry(val image: OpenThumbnail, val etag: String?)

    fun load(photo: Photo, edge: Int): CachedDerivative? {
        folder.mkdirs()
        val key =
            digest("cloud-derivative-v1:${photo.key}:$edge".toByteArray())
        val index = File(folder, "cloud-$key.json")
        val cached =
            synchronized(OpenThumbnail.lock) {
                runCatching {
                    val record = JSONObject(index.readText())
                    val content = record.getString("content")
                    require(content.matches(Regex("[0-9a-f]{64}")))
                    val file = File(folder, "cloud-$key-$content.avif")
                    require(file.isFile && file.length() > 0)
                    Entry(OpenThumbnail(file), record.optString("etag").takeIf { it.isNotEmpty() })
                }
                    .getOrNull()
            }
        val response =
            try {
                cloud.derivative(photo, edge, cached?.etag)
            } catch (failure: Throwable) {
                cached?.image?.close()
                throw failure
            }
        if (response?.status == 304) {
            val previous = checkNotNull(cached) { "Cloud returned 304 without a cached image" }
            synchronized(OpenThumbnail.lock) {
                previous.image.file.setLastModified(System.currentTimeMillis())
                index.setLastModified(System.currentTimeMillis())
            }
            return CachedDerivative(previous.image, index, false)
        }
        cached?.image?.close()
        if (response == null) return null
        response.requireSuccess()
        check(response.size > 0) { "Cloud derivative is empty" }
        val content = digest(response.bytes())
        val payload = File(folder, "cloud-$key-$content.avif")
        return synchronized(OpenThumbnail.lock) {
            if (!payload.isFile) publish(payload, response::writeTo)
            publish(index) { output ->
                output.write(
                    JSONObject()
                        .put("content", content)
                        .put("etag", response.etag.orEmpty())
                        .toString()
                        .toByteArray()
                )
            }
            payload.setLastModified(System.currentTimeMillis())
            CachedDerivative(OpenThumbnail(payload), index, true)
        }
    }

    private fun publish(target: File, write: (OutputStream) -> Unit) {
        val temporary = File.createTempFile("cloud-", ".tmp", folder)
        try {
            temporary.outputStream().use(write)
            check(temporary.renameTo(target)) { "Could not cache cloud derivative" }
        } finally {
            temporary.delete()
        }
    }

    private fun digest(bytes: ByteArray) = digest(ByteBuffer.wrap(bytes))

    private fun digest(bytes: ByteBuffer) =
        MessageDigest.getInstance("SHA-256")
            .apply { update(bytes) }
            .digest()
            .joinToString("") { "%02x".format(it) }
}
