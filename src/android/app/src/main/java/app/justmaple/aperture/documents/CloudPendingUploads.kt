package app.justmaple.aperture.documents

import app.justmaple.aperture.data.PhotoLibrary
import java.io.File
import java.util.UUID
import org.json.JSONObject

/**
 * Durable journal of documents written through the provider but not yet on the server.
 *
 * SAF writers close their descriptor before Maple can report an upload failure, so the
 * bytes live here (app files, never evicted) until the server accepts them. Records are
 * keyed by server origin, not connection ID: signing out keeps them, and reconnecting to
 * the same server resumes the upload.
 */
internal class CloudPendingUploads(private val root: File) {
    data class Upload(
        val token: String,
        val origin: String,
        val library: String,
        val slug: String,
        val path: String,
        val ready: Boolean,
        val failure: String?,
    ) {
        fun document(server: String) = CloudDocumentId.file(server, library, slug, path)
    }

    private val writers = mutableMapOf<String, Int>()

    fun create(origin: String, file: CloudDocumentId, writing: Boolean = false): Upload =
        synchronized(this) {
            val upload =
                Upload(
                    UUID.randomUUID().toString(),
                    origin,
                    file.library!!,
                    file.slug!!,
                    file.path,
                    ready = false,
                    failure = null,
                )
            check(data(upload).createNewFile()) { "Could not stage ${file.name}" }
            if (writing) writers[upload.token] = 1
            write(upload)
            upload
        }

    fun find(origin: String, file: CloudDocumentId): Upload? =
        all(origin).find { it.library == file.library && it.path == file.path }

    fun children(origin: String, folder: CloudDocumentId): List<Upload> =
        all(origin).filter {
            it.library == folder.library && it.path.substringBeforeLast('/', "") == folder.path
        }

    fun all(origin: String): List<Upload> =
        synchronized(this) {
            folder(origin).listFiles().orEmpty().filter { it.name.endsWith(".json") }.mapNotNull(::read)
        }

    fun data(upload: Upload) = File(folder(upload.origin), "${upload.token}.data")

    fun opened(upload: Upload) {
        synchronized(this) { writers[upload.token] = (writers[upload.token] ?: 0) + 1 }
    }

    /** A clean close publishes; a failed writer leaves the staged bytes pending. */
    fun closed(upload: Upload, clean: Boolean) =
        synchronized(this) {
            val remaining = (writers[upload.token] ?: 1) - 1
            if (remaining <= 0) writers.remove(upload.token) else writers[upload.token] = remaining
            val current = read(record(upload)) ?: return@synchronized
            if (clean && remaining <= 0) write(current.copy(ready = true, failure = null))
        }

    /** Ready records plus created documents that no writer has touched for a minute. */
    fun due(origin: String): List<Upload> =
        synchronized(this) {
            val idle = System.currentTimeMillis() - IDLE_MILLIS
            all(origin).filter { upload ->
                upload.failure == null &&
                    upload.token !in writers &&
                    (upload.ready || data(upload).lastModified() < idle)
            }
        }

    fun moved(upload: Upload, path: String): Upload =
        synchronized(this) { upload.copy(path = path).also(::write) }

    fun failed(upload: Upload, reason: String) =
        synchronized(this) { write(upload.copy(failure = reason)) }

    fun remove(upload: Upload) =
        synchronized(this) {
            data(upload).delete()
            record(upload).delete()
        }

    private fun folder(origin: String) =
        File(root, PhotoLibrary.digest("documents-uploads-v1:$origin")).apply { mkdirs() }

    private fun record(upload: Upload) = File(folder(upload.origin), "${upload.token}.json")

    private fun write(upload: Upload) {
        val target = record(upload)
        val temporary = File(target.parentFile, "${upload.token}.tmp")
        temporary.writeText(
            JSONObject()
                .put("token", upload.token)
                .put("origin", upload.origin)
                .put("library", upload.library)
                .put("slug", upload.slug)
                .put("path", upload.path)
                .put("ready", upload.ready)
                .put("failure", upload.failure ?: JSONObject.NULL)
                .toString()
        )
        check(temporary.renameTo(target)) { "Could not record pending upload" }
    }

    private fun read(file: File): Upload? =
        runCatching {
                val value = JSONObject(file.readText())
                Upload(
                    value.getString("token"),
                    value.getString("origin"),
                    value.getString("library"),
                    value.getString("slug"),
                    value.getString("path"),
                    value.getBoolean("ready"),
                    if (value.isNull("failure")) null else value.getString("failure"),
                )
            }
            .getOrNull()

    companion object {
        const val IDLE_MILLIS = 60_000L
    }
}
