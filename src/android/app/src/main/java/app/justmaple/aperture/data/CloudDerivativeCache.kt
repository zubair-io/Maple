package app.justmaple.aperture.data

import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import app.justmaple.aperture.cloud.CloudDerivativePending
import app.justmaple.aperture.cloud.CloudLibrary
import app.justmaple.aperture.cloud.CloudResponse
import app.justmaple.aperture.cloud.CloudTransport
import java.io.File
import java.io.FileInputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.security.MessageDigest
import org.json.JSONObject

internal data class CachedDerivative(
    val image: OpenThumbnail,
    val index: File,
    val inserted: Boolean,
)

/** The PNG conversion failed; the cached [payload] and [index] still count toward the budget. */
internal class CloudDerivativeUnconverted(
    val payload: File,
    val index: File,
    val inserted: Boolean,
    cause: Throwable,
) : Exception("Could not convert the cloud thumbnail to PNG", cause)

/** Immutable payloads and an atomic validator index keep concurrent responses paired; below Android 12 callers get a private PNG. */
internal class CloudDerivativeCache(
    private val http: CloudTransport,
    private val folder: File,
    private val convertToPng: (source: FileInputStream, destination: String) -> Unit =
        { source, destination ->
            ParcelFileDescriptor.dup(source.fd).use { pinned ->
                NativeBridge.cachePng(pinned.fd, destination)
            }
        },
    private val sdk: Int = Build.VERSION.SDK_INT,
) {
    private data class Entry(
        val image: OpenThumbnail,
        val content: String,
        val etag: String?,
        val token: String?,
    )

    fun serves(edge: Int) = sdk >= 31 || edge <= THUMBNAIL_EDGE

    fun load(photo: Photo, edge: Int): CachedDerivative? {
        val derivative = revalidated(photo, edge) ?: return null
        return if (sdk >= 31) derivative else legacyPng(derivative)
    }

    private fun fetch(photo: Photo, edge: Int, etag: String?, token: String?): CloudResponse? {
        fun get(route: String) =
            http.request(
                photo.uri.host!!,
                CloudLibrary.mediaPath(route, photo.uri) + token?.let { "?v=${Uri.encode(it)}" }.orEmpty(),
                headers = etag?.let { mapOf("If-None-Match" to it) } ?: emptyMap(),
            )
        val primary = get(if (edge > THUMBNAIL_EDGE) "preview" else "thumb")
        val response = if (primary.status == 404 && edge > THUMBNAIL_EDGE) get("thumb") else primary
        if (response.status == 202) {
            val seconds = response.retryAfter?.toLongOrNull()?.coerceIn(1, 60) ?: 2
            throw CloudDerivativePending(seconds * 1_000)
        }
        return when (response.status) {
            404 -> null
            304 -> response
            else -> response.requireSuccess()
        }
    }

    private fun legacyPng(derivative: CachedDerivative): CachedDerivative {
        val payload = checkNotNull(derivative.image.file) { "Thumbnail payload is not addressable" }
        val target = File(folder, "png-${payload.nameWithoutExtension}.png")
        try {
            synchronized(OpenThumbnail.lock) {
                if (target.isFile) {
                    target.setLastModified(System.currentTimeMillis())
                    return CachedDerivative(OpenThumbnail(target), derivative.index, derivative.inserted)
                }
            }
            val temporary = File.createTempFile("cloud-", ".tmp", folder)
            try {
                convertToPng(derivative.image.input, temporary.absolutePath)
                return synchronized(OpenThumbnail.lock) {
                    check(temporary.renameTo(target)) { "Could not cache cloud thumbnail" }
                    CachedDerivative(OpenThumbnail(target), derivative.index, true)
                }
            } catch (failure: Exception) {
                throw CloudDerivativeUnconverted(payload, derivative.index, derivative.inserted, failure)
            } finally {
                temporary.delete()
            }
        } finally {
            derivative.image.close()
        }
    }

    private fun revalidated(photo: Photo, edge: Int): CachedDerivative? {
        folder.mkdirs()
        val key =
            digest("cloud-derivative-v1:${photo.key}:$edge".toByteArray())
        val index = File(folder, "cloud-$key.json")
        val token = photo.thumbToken?.takeIf { edge <= THUMBNAIL_EDGE }
        val cached =
            synchronized(OpenThumbnail.lock) {
                runCatching {
                    val record = JSONObject(index.readText())
                    val content = record.getString("content")
                    require(content.matches(Regex("[0-9a-f]{64}")))
                    val file = File(folder, "cloud-$key-$content.avif")
                    require(file.isFile && file.length() > 0)
                    Entry(
                        OpenThumbnail(file),
                        content,
                        record.optString("etag").takeIf { it.isNotEmpty() },
                        record.optString("token").takeIf { it.isNotEmpty() },
                    )
                }
                    .getOrNull()
            }
        if (cached != null && token != null && cached.token == token) {
            touch(cached.image, index)
            return CachedDerivative(cached.image, index, false)
        }
        val response =
            try {
                fetch(photo, edge, cached?.etag, token)
            } catch (failure: Throwable) {
                cached?.image?.close()
                throw failure
            }
        if (response?.status == 304) {
            val previous = checkNotNull(cached) { "Cloud returned 304 without a cached image" }
            synchronized(OpenThumbnail.lock) {
                if (token != null) publishIndex(index, previous.content, previous.etag, token)
                touch(previous.image, index)
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
            publishIndex(index, content, response.etag, token)
            payload.setLastModified(System.currentTimeMillis())
            CachedDerivative(OpenThumbnail(payload), index, true)
        }
    }

    private fun touch(image: OpenThumbnail, index: File) =
        synchronized(OpenThumbnail.lock) {
            image.file?.setLastModified(System.currentTimeMillis())
            index.setLastModified(System.currentTimeMillis())
        }

    private fun publishIndex(index: File, content: String, etag: String?, token: String?) =
        publish(index) { output ->
            output.write(
                JSONObject()
                    .put("content", content)
                    .put("etag", etag.orEmpty())
                    .apply { token?.let { put("token", it) } }
                    .toString()
                    .toByteArray()
            )
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

    private companion object {
        const val THUMBNAIL_EDGE = 512
    }
}
