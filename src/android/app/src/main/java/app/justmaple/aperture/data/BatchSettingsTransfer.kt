package app.justmaple.aperture.data

import android.content.Context
import android.net.Uri
import app.justmaple.aperture.generated.AdjustmentTransfer
import app.justmaple.aperture.generated.AdjustmentTransferGroup
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

private val rasterTransferExtensions = setOf("jpg", "jpeg", "png", "webp", "tif", "tiff", "heic", "heif", "avif")

fun isRawTransferTarget(photo: Photo): Boolean = photo.extension !in rasterTransferExtensions

enum class BatchPasteStatus { Pending, Prepared, Applied, Failed }

data class BatchPasteEntry(val photo: Photo, val status: BatchPasteStatus, val error: String? = null)

data class BatchPasteState(val running: Boolean = false, val entries: List<BatchPasteEntry> = emptyList()) {
    val completed: Int = entries.count { it.status == BatchPasteStatus.Applied }
    val pending: Int = entries.count { it.status == BatchPasteStatus.Pending || it.status == BatchPasteStatus.Prepared }
    val failed: Int = entries.count { it.status == BatchPasteStatus.Failed }
    val hasJob: Boolean = entries.isNotEmpty()
}

class BatchSettingsTransfer internal constructor(
    private val file: File,
    private val load: suspend (Photo) -> LoadedSidecar,
    private val save: suspend (Photo, XmpDocument, String?) -> LoadedSidecar,
) {
    constructor(context: Context, library: PhotoLibrary) : this(
        File(context.filesDir, "batch-settings-transfer.json"), library::loadSidecar, library::save,
    )

    private val operation = Mutex()
    @Volatile private var cancelled = false
    private var ledger = readLedger()
    private val mutableState = MutableStateFlow(view())
    val state: StateFlow<BatchPasteState> = mutableState.asStateFlow()
    val hasJob: Boolean get() = state.value.hasJob

    suspend fun prepare(photos: List<Photo>, copied: CopiedSettings, groups: List<AdjustmentTransferGroup>) {
        check(operation.tryLock()) { "A batch paste is already running" }
        try {
            check(state.value.pending == 0 && state.value.failed == 0) { "Resume or retry the existing batch paste first" }
            require(photos.isNotEmpty() && groups.isNotEmpty()) { "Select photos and settings to paste" }
            cancelled = false
            mutableState.value = view(running = true)
            withContext(Dispatchers.IO) {
                val source = CopiedSettings(copied.sourceName, copied.document)
                val selected = groups.map { it.copy(fields = it.fields.toList()) }
                val entries = photos.distinctBy { it.uri.toString() }.map { photo ->
                    currentCoroutineContext().ensureActive()
                    try {
                        planned(photo, load(photo).document, source, selected)
                    } catch (failure: Exception) {
                        if (failure is CancellationException) throw failure
                        Record(photo, BatchPasteStatus.Failed, reason(failure))
                    }
                }
                commit(Ledger(source.document.original, selected, entries))
            }
        } finally {
            mutableState.value = view()
            operation.unlock()
        }
    }

    suspend fun run(retryFailed: Boolean = false) {
        check(operation.tryLock()) { "A batch paste is already running" }
        try {
            val job = ledger ?: return
            if (cancelled) return
            mutableState.value = view(running = true)
            withContext(Dispatchers.IO) {
                val targets = job.entries.indices.filter { index ->
                    val status = job.entries[index].status
                    if (retryFailed) status == BatchPasteStatus.Failed
                    else status == BatchPasteStatus.Pending || status == BatchPasteStatus.Prepared
                }
                for (index in targets) {
                    currentCoroutineContext().ensureActive()
                    if (cancelled) break
                    // Once a write starts, its read-back and ledger commit must survive scope cancellation.
                    withContext(NonCancellable) { attempt(index) }
                }
            }
        } finally {
            cancelled = false
            mutableState.value = view()
            operation.unlock()
        }
    }

    fun cancel() { cancelled = true }

    suspend fun discard() {
        check(operation.tryLock()) { "Stop the batch paste before dismissing it" }
        try {
            withContext(Dispatchers.IO) {
                check(!file.exists() || file.delete()) { "Cannot remove the batch paste ledger" }
                val previous = ledger
                ledger = null
                cancelled = false
                mutableState.value = view()
                previous?.let { recordFile(it, 0).parentFile!!.deleteRecursively() }
            }
        } finally {
            operation.unlock()
        }
    }

    private suspend fun attempt(index: Int) {
        val job = checkNotNull(ledger)
        var entry = job.entries[index]
        try {
            if (entry.before == null) {
                entry = planned(entry.photo, load(entry.photo).document, CopiedSettings("", XmpDocument(job.source)), job.groups)
            }
        } catch (failure: Exception) {
            if (failure is CancellationException) throw failure
            update(index, entry.copy(status = BatchPasteStatus.Failed, error = reason(failure)))
            return
        }
        entry = entry.copy(status = BatchPasteStatus.Prepared, error = null)
        // The frozen prior values and replacement values reach disk before any sidecar is touched.
        update(index, entry)
        val result = try {
            val current = load(entry.photo)
            if (cancelled) return
            val before = checkNotNull(entry.before)
            val after = checkNotNull(entry.after)
            val matchesBefore = before.matches(current.document)
            val matchesAfter = after.matches(current.document)
            check(matchesBefore || matchesAfter) { "Settings changed after this paste was prepared; newer edits were kept" }
            if (matchesBefore) {
                val patched = after.apply(current.document)
                val expected = patched.serialize()
                save(entry.photo, patched, current.baseline)
                val confirmed = load(entry.photo)
                check(confirmed.baseline == expected && after.matches(confirmed.document)) {
                    "Could not confirm the saved sidecar; resume or retry to check it again"
                }
            }
            entry.copy(status = BatchPasteStatus.Applied)
        } catch (failure: Exception) {
            if (failure is CancellationException) throw failure
            entry.copy(status = BatchPasteStatus.Failed, error = reason(failure))
        }
        update(index, result)
    }

    private fun update(index: Int, entry: Record) {
        val job = checkNotNull(ledger)
        persist(recordFile(job, index), encode(entry))
        ledger = job.copy(entries = job.entries.mapIndexed { position, old -> if (position == index) entry else old })
        mutableState.value = view(running = state.value.running)
    }

    private fun commit(next: Ledger) {
        val previous = ledger
        persist(file, encode(next))
        ledger = next
        mutableState.value = view(running = state.value.running)
        previous?.let { recordFile(it, 0).parentFile!!.deleteRecursively() }
    }

    // Per-photo records overlay the frozen manifest instead of rewriting the whole selection after every write.
    private fun recordFile(job: Ledger, index: Int) = File(File(file.parentFile, "batch-settings-${job.id}"), "$index.json")

    private fun readLedger(): Ledger? {
        if (!file.exists()) return null
        val job = decode(JSONObject(file.readText()))
        return job.copy(entries = job.entries.mapIndexed { index, original ->
            val record = recordFile(job, index)
            if (record.exists()) decodeEntry(JSONObject(record.readText())) else original
        })
    }

    private fun persist(target: File, value: JSONObject) {
        val bytes = value.toString().toByteArray(Charsets.UTF_8)
        val parent = checkNotNull(target.parentFile)
        check(parent.isDirectory || parent.mkdirs()) { "Cannot create the batch paste ledger folder" }
        val temporary = File.createTempFile("batch-paste-", ".tmp", parent)
        try {
            FileOutputStream(temporary).use { stream ->
                stream.write(bytes)
                stream.fd.sync()
            }
            check(temporary.renameTo(target)) { "Cannot commit the batch paste ledger" }
        } finally {
            temporary.delete()
        }
    }

    private fun view(running: Boolean = false) = BatchPasteState(
        running, ledger?.entries.orEmpty().map { BatchPasteEntry(it.photo, it.status, it.error) },
    )

    private data class Ledger(
        val source: String,
        val groups: List<AdjustmentTransferGroup>,
        val entries: List<Record>,
        val id: String = UUID.randomUUID().toString(),
    )
    private data class Record(
        val photo: Photo,
        val status: BatchPasteStatus,
        val error: String? = null,
        val before: Values? = null,
        val after: Values? = null,
    )

    private data class Values(val attributes: Map<String, String?>, val curves: Map<PointCurve, List<CurveKnot>>) {
        fun matches(document: XmpDocument): Boolean =
            attributes.all { (key, value) -> document.attribute(key) == value } &&
                curves.all { (curve, knots) -> document.curve(curve) == knots }

        fun apply(document: XmpDocument): XmpDocument {
            val scalars = attributes.entries.fold(document) { doc, (key, value) ->
                if (doc.attribute(key) == value) doc else doc.withAttribute(key, value)
            }
            return curves.entries.fold(scalars) { doc, (curve, knots) -> doc.withCurve(curve, knots) }
        }

        fun json(): JSONObject = JSONObject().put("attributes", JSONObject(attributes.mapValues { it.value ?: JSONObject.NULL }))
            .put("curves", JSONObject(curves.mapKeys { it.key.element }.mapValues { (_, knots) ->
                JSONArray(knots.map { JSONArray(listOf(it.x, it.y)) })
            }))
    }

    companion object {
        private fun reason(failure: Exception): String = failure.message?.takeIf { it.isNotBlank() } ?: failure.javaClass.simpleName

        private fun planned(photo: Photo, target: XmpDocument, source: CopiedSettings, groups: List<AdjustmentTransferGroup>): Record {
            val raw = isRawTransferTarget(photo)
            val fields = groups.flatMap { it.transferredFields(raw) }.distinct()
            val attributes = fields.flatMap { field ->
                AdjustmentTransfer.xmpAttributes[field].orEmpty() +
                    if (field == "temperature") listOf("crs:WhiteBalance") else emptyList()
            }.distinct()
            val curves = fields.mapNotNull { AdjustmentTransfer.xmpElements[it]?.let(PointCurve.byElement::getValue) }.distinct()
            fun values(document: XmpDocument) = Values(
                attributes.associateWith(document::attribute), curves.associateWith(document::curve),
            )
            val pasted = XmpDocument(target.pasting(source, groups, raw).serialize())
            return Record(photo, BatchPasteStatus.Prepared, before = values(target), after = values(pasted))
        }

        private fun encode(job: Ledger): JSONObject = JSONObject().put("version", 1).put("id", job.id).put("source", job.source)
            .put("groups", JSONArray(job.groups.map { group ->
                JSONObject().put("id", group.id).put("label", group.label).put("fields", JSONArray(group.fields))
            }))
            .put("entries", JSONArray(job.entries.map(::encode)))

        private fun encode(entry: Record): JSONObject = JSONObject().put("photo", JSONObject()
            .put("uri", entry.photo.uri.toString()).put("name", entry.photo.name)
            .put("size", entry.photo.size).put("modified", entry.photo.modified)
            .put("parent", entry.photo.parent?.toString() ?: JSONObject.NULL)
            .put("contentDigest", entry.photo.contentDigest ?: JSONObject.NULL))
            .put("status", entry.status.name).put("error", entry.error ?: JSONObject.NULL)
            .put("before", entry.before?.json() ?: JSONObject.NULL)
            .put("after", entry.after?.json() ?: JSONObject.NULL)

        private fun decode(json: JSONObject): Ledger {
            require(json.getInt("version") == 1) { "Unsupported batch paste ledger version" }
            val groups = json.getJSONArray("groups")
            val entries = json.getJSONArray("entries")
            return Ledger(json.getString("source"), List(groups.length()) { index ->
                val group = groups.getJSONObject(index)
                val fields = group.getJSONArray("fields")
                AdjustmentTransferGroup(group.getString("id"), group.getString("label"), List(fields.length(), fields::getString))
            }, List(entries.length()) { index -> decodeEntry(entries.getJSONObject(index)) }, json.getString("id"))
        }

        private fun decodeEntry(entry: JSONObject): Record {
            val photo = entry.getJSONObject("photo")
            return Record(
                Photo(Uri.parse(photo.getString("uri")), photo.getString("name"), photo.getLong("size"),
                    photo.getLong("modified"), nullable(photo, "parent")?.let(Uri::parse), nullable(photo, "contentDigest")),
                BatchPasteStatus.valueOf(entry.getString("status")), nullable(entry, "error"),
                if (entry.isNull("before")) null else values(entry.getJSONObject("before")),
                if (entry.isNull("after")) null else values(entry.getJSONObject("after")),
            )
        }

        private fun nullable(json: JSONObject, key: String): String? = if (json.isNull(key)) null else json.getString(key)

        private fun values(json: JSONObject): Values {
            val attributes = json.getJSONObject("attributes")
            val curves = json.getJSONObject("curves")
            return Values(attributes.keys().asSequence().associateWith { nullable(attributes, it) },
                curves.keys().asSequence().associate { element ->
                    val knots = curves.getJSONArray(element)
                    PointCurve.byElement.getValue(element) to List(knots.length()) { index ->
                        val knot = knots.getJSONArray(index)
                        CurveKnot(knot.getDouble(0).toFloat(), knot.getDouble(1).toFloat())
                    }
                })
        }
    }
}
