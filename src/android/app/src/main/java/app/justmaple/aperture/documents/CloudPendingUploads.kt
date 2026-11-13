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
 * keyed by account (server origin and signed-in user), never by origin alone: signing
 * back in as the same user resumes them, and another account never sends or sees them.
 */
internal class CloudPendingUploads(private val root: File) {
    data class Upload(
        val token: String,
        val account: String,
        val library: String,
        val slug: String,
        val path: String,
        val ready: Boolean,
        val failure: String?,
        val generation: Int = 0,
        /** Persisted before a writer touches the bytes; only its clean close clears it. */
        val writing: Boolean = false,
        /** A document created here: it publishes only into a free name, never over a server file. */
        val creates: Boolean = false,
    ) {
        fun document(server: String) = CloudDocumentId.file(server, library, slug, path)

        /**
         * Holds a complete save: not torn, and not the first writer of a server file still
         * copying or rewriting it (the server copy is the last complete version then).
         */
        val readable: Boolean
            get() = failure != INTERRUPTED && !(writing && generation == 0)
    }

    private val writers = mutableMapOf<String, Int>()

    /** Records being sent, or held while a rename or delete reconciles them with the server. */
    private val busy = mutableSetOf<String>()

    fun create(account: String, file: CloudDocumentId, writing: Boolean = false, creates: Boolean = false): Upload =
        synchronized(this) {
            val upload =
                Upload(
                    UUID.randomUUID().toString(),
                    account,
                    file.library!!,
                    file.slug!!,
                    file.path,
                    ready = false,
                    failure = null,
                    writing = writing,
                    creates = creates,
                )
            check(data(upload).createNewFile()) { "Could not stage ${file.name}" }
            if (writing) writers[upload.token] = 1
            write(upload)
            upload
        }

    fun find(account: String, file: CloudDocumentId): Upload? =
        all(account).find { it.library == file.library && it.path == file.path }

    fun children(account: String, folder: CloudDocumentId): List<Upload> =
        all(account).filter {
            it.library == folder.library && it.path.substringBeforeLast('/', "") == folder.path
        }

    /**
     * Every record; one still marked as written with no writer in this process was torn
     * by a process death and is recorded as interrupted, so it never uploads by itself.
     */
    fun all(account: String): List<Upload> =
        synchronized(this) {
            folder(account).listFiles().orEmpty().filter { it.name.endsWith(".json") }.mapNotNull(::read).map {
                if (it.writing && it.token !in writers)
                    it.copy(ready = false, failure = INTERRUPTED, writing = false).also(::write)
                else it
            }
        }

    fun data(upload: Upload) = File(folder(upload.account), "${upload.token}.data")

    /** A new writer makes any upload already in flight stale: its success must not drop these bytes. */
    fun opened(upload: Upload): Upload =
        synchronized(this) {
            writers[upload.token] = (writers[upload.token] ?: 0) + 1
            val current = read(record(upload)) ?: upload
            current.copy(generation = current.generation + 1, writing = true).also(::write)
        }

    /** A clean last close publishes; a writer that failed leaves torn bytes that never upload. */
    fun closed(upload: Upload, clean: Boolean) =
        synchronized(this) {
            val remaining = (writers[upload.token] ?: 1) - 1
            if (remaining <= 0) writers.remove(upload.token) else writers[upload.token] = remaining
            val current = read(record(upload)) ?: return@synchronized
            val next =
                when {
                    !clean -> current.copy(ready = false, failure = INTERRUPTED)
                    remaining <= 0 -> current.copy(ready = true, failure = null)
                    else -> current
                }
            write(next.copy(writing = remaining > 0))
        }

    /** Ready records plus created documents that no writer has touched for a minute, oldest first. */
    fun due(account: String): List<Upload> =
        synchronized(this) {
            val idle = System.currentTimeMillis() - IDLE_MILLIS
            all(account)
                .filter { upload ->
                    upload.failure == null &&
                        upload.token !in writers &&
                        upload.token !in busy &&
                        (upload.ready || data(upload).lastModified() < idle)
                }
                .sortedBy { data(it).lastModified() }
        }

    /**
     * Takes [upload] for sending: the current record, or null once a writer, another send,
     * a rename/delete or a failure got to it after [due] listed it.
     */
    fun claim(upload: Upload): Upload? =
        synchronized(this) {
            val current = read(record(upload))
            if (current == null || current.failure != null || current.writing || upload.token in writers)
                return@synchronized null
            current.takeIf { busy.add(it.token) }
        }

    fun release(upload: Upload) = synchronized(this) { busy.remove(upload.token) }

    /**
     * Runs a server rename or delete with the records it affects held: none is mid-send,
     * and none starts sending until [action] has moved or dropped them.
     */
    fun <T> holding(account: String, affected: (Upload) -> Boolean, action: (List<Upload>) -> T): T {
        val held =
            synchronized(this) {
                val records = all(account).filter(affected)
                check(records.none { it.token in busy }) { "Maple is uploading this item. Try again shortly." }
                records.also { busy += it.map(Upload::token) }
            }
        try {
            return action(held)
        } finally {
            synchronized(this) { busy -= held.map(Upload::token).toSet() }
        }
    }

    fun moved(upload: Upload, path: String): Upload =
        synchronized(this) {
            val current = read(record(upload)) ?: upload
            current.copy(path = path, generation = current.generation + 1).also(::write)
        }

    /** Drops the record unless a writer reopened it while [upload] was being sent. */
    fun sent(upload: Upload): Boolean =
        synchronized(this) {
            val current = read(record(upload)) ?: return@synchronized true
            if (upload.token in writers || current.generation != upload.generation) return@synchronized false
            remove(upload)
            true
        }

    fun failed(upload: Upload, reason: String) =
        synchronized(this) {
            val current = read(record(upload)) ?: return@synchronized
            if (upload.token !in writers && current.generation == upload.generation)
                write(current.copy(failure = reason))
        }

    fun remove(upload: Upload) =
        synchronized(this) {
            data(upload).delete()
            record(upload).delete()
        }

    private fun folder(account: String) =
        File(root, PhotoLibrary.digest("documents-uploads-v2:$account")).apply { mkdirs() }

    private fun record(upload: Upload) = File(folder(upload.account), "${upload.token}.json")

    private fun write(upload: Upload) {
        val target = record(upload)
        val temporary = File(target.parentFile, "${upload.token}.tmp")
        temporary.writeText(
            JSONObject()
                .put("token", upload.token)
                .put("account", upload.account)
                .put("library", upload.library)
                .put("slug", upload.slug)
                .put("path", upload.path)
                .put("ready", upload.ready)
                .put("failure", upload.failure ?: JSONObject.NULL)
                .put("generation", upload.generation)
                .put("writing", upload.writing)
                .put("creates", upload.creates)
                .toString()
        )
        check(temporary.renameTo(target)) { "Could not record pending upload" }
    }

    private fun read(file: File): Upload? =
        runCatching {
                val value = JSONObject(file.readText())
                Upload(
                    value.getString("token"),
                    value.getString("account"),
                    value.getString("library"),
                    value.getString("slug"),
                    value.getString("path"),
                    value.getBoolean("ready"),
                    if (value.isNull("failure")) null else value.getString("failure"),
                    value.optInt("generation"),
                    value.optBoolean("writing"),
                    value.optBoolean("creates"),
                )
            }
            .getOrNull()

    companion object {
        const val IDLE_MILLIS = 60_000L
        const val INTERRUPTED = "The app writing this file stopped before it finished; nothing was uploaded"
    }
}
