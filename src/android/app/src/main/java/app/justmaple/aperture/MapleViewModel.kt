package app.justmaple.aperture

import android.app.Application
import android.net.Uri
import android.view.Surface
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.justmaple.aperture.data.*
import app.justmaple.aperture.generated.AdjustmentFields
import java.io.File
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

enum class PhotoMode {
    Browse,
    Preview,
    Edit,
}

data class MapleState(
    val sources: List<Folder> = emptyList(),
    val folder: Folder? = null,
    val folders: List<Folder> = emptyList(),
    val photos: List<Photo> = emptyList(),
    val selected: Photo? = null,
    val mode: PhotoMode = PhotoMode.Browse,
    val document: XmpDocument = XmpDocument(),
    val values: Map<String, Float> = emptyMap(),
    val loading: Boolean = false,
    val rendering: Boolean = false,
    val saving: Boolean = false,
    val dirty: Boolean = false,
    val error: String? = null,
    val canUndo: Boolean = false,
    val canRedo: Boolean = false,
    val showFilmstrip: Boolean = true,
)

private data class EditSnapshot(val values: Map<String, Float>, val document: XmpDocument)

private data class DrawRequest(val generation: Int, val values: Map<String, Float>)

/** Incremental Android parity work is tracked by #4623. No simulated sources. */
class MapleViewModel(application: Application) : AndroidViewModel(application) {
    val library = PhotoLibrary(application)
    val renderer = EditorRenderer(::framePresented)
    private val preferences = application.getSharedPreferences("maple-ui", 0)
    private val mutable =
        MutableStateFlow(
            MapleState(
                sources = library.sources,
                showFilmstrip = preferences.getBoolean("filmstrip", true),
            )
        )
    val state = mutable.asStateFlow()
    private var generation = 0
    private var baseline: String? = null
    private var saveJob: Job? = null
    private val saveLock = kotlinx.coroutines.sync.Mutex()
    private val undo = ArrayDeque<EditSnapshot>()
    private val redo = ArrayDeque<EditSnapshot>()
    private var gesture: EditSnapshot? = null
    private val draws = Channel<DrawRequest>(Channel.CONFLATED)

    init {
        viewModelScope.launch {
            for (request in draws) {
                if (request.generation != generation) continue
                try {
                    renderer.draw(request.values)
                } catch (failure: Exception) {
                    if (failure is CancellationException) throw failure
                    fail(failure)
                }
            }
        }
        library.sources.firstOrNull()?.let(::browse)
    }

    fun report(failure: Throwable) = fail(failure)

    private fun fail(failure: Throwable) {
        mutable.update {
            it.copy(
                error = failure.message ?: "The operation failed",
                loading = false,
                rendering = false,
                saving = false,
            )
        }
    }

    fun clearError() {
        mutable.update { it.copy(error = null) }
    }

    fun remember(uri: Uri) {
        runCatching { library.remember(uri) }
            .onSuccess {
                val sources = library.sources
                mutable.update { it.copy(sources = sources) }
                sources
                    .find {
                        android.provider.DocumentsContract.getTreeDocumentId(it.uri) ==
                            android.provider.DocumentsContract.getTreeDocumentId(uri)
                    }
                    ?.let(::browse)
            }
            .onFailure(::fail)
    }

    fun browse(folder: Folder) {
        viewModelScope.launch {
            if (!flush()) return@launch
            val token = ++generation
            mutable.update {
                it.copy(
                    loading = true,
                    folder = folder,
                    mode = PhotoMode.Browse,
                    selected = null,
                    error = null,
                )
            }
            try {
                renderer.shutdown()
                val listing = library.list(folder.uri)
                if (token == generation)
                    mutable.update {
                        it.copy(loading = false, photos = listing.photos, folders = listing.folders)
                    }
            } catch (failure: Exception) {
                if (token == generation) fail(failure)
            }
        }
    }

    fun openSingle(uri: Uri) {
        viewModelScope.launch {
            try {
                val photo = library.single(uri)
                mutable.update { it.copy(photos = listOf(photo)) }
                open(photo)
            } catch (failure: Exception) {
                fail(failure)
            }
        }
    }

    fun open(photo: Photo) {
        viewModelScope.launch {
            if (!flush()) return@launch
            val nextMode =
                if (state.value.mode == PhotoMode.Edit) PhotoMode.Edit else PhotoMode.Preview
            val token = ++generation
            mutable.update {
                it.copy(
                    selected = photo,
                    mode = nextMode,
                    loading = true,
                    rendering = false,
                    dirty = false,
                    error = null,
                )
            }
            undo.clear()
            redo.clear()
            gesture = null
            try {
                renderer.shutdown()
                val loaded = library.loadSidecar(photo)
                if (token != generation) return@launch
                baseline = loaded.baseline
                mutable.update {
                    it.copy(
                        document = loaded.document,
                        loading = false,
                        values = emptyMap(),
                        canUndo = false,
                        canRedo = false,
                    )
                }
                if (nextMode == PhotoMode.Edit) startEditor(token)
            } catch (failure: Exception) {
                if (token == generation) fail(failure)
            }
        }
    }

    fun edit() {
        viewModelScope.launch {
            mutable.update { it.copy(mode = PhotoMode.Edit) }
            startEditor(generation)
        }
    }

    private suspend fun startEditor(token: Int) {
        val snapshot = state.value
        val photo = snapshot.selected ?: return
        mutable.update { it.copy(rendering = true, values = emptyMap()) }
        try {
            val values =
                library.withOriginal(photo) { input ->
                    renderer.open(input.absolutePath, snapshot.document.serialize(), 2048, token)
                }
            if (token == generation)
                mutable.update { it.copy(values = values, rendering = !renderer.hasPresented) }
        } catch (failure: Exception) {
            if (token == generation) fail(failure)
        }
    }

    fun back() {
        viewModelScope.launch {
            if (!flush()) return@launch
            ++generation
            renderer.shutdown()
            mutable.update {
                it.copy(
                    mode = if (it.mode == PhotoMode.Edit) PhotoMode.Preview else PhotoMode.Browse,
                    rendering = false,
                )
            }
        }
    }

    fun surface(surface: Surface?, width: Int, height: Int) {
        val binding = renderer.recordSurface(surface, width, height)
        if (state.value.mode == PhotoMode.Edit) mutable.update { it.copy(rendering = true) }
        viewModelScope.launch {
            try {
                renderer.attach(binding)
            } catch (failure: Exception) {
                fail(failure)
            }
        }
    }

    fun beginGesture() {
        if (gesture == null) gesture = snapshot()
    }

    private fun framePresented(epoch: Int) {
        viewModelScope.launch {
            if (epoch == generation && state.value.values.isNotEmpty())
                mutable.update { it.copy(rendering = false) }
        }
    }

    fun setField(name: String, value: Float) {
        val field = AdjustmentFields.byName[name] ?: return
        val next = value.coerceIn(field.minimum, field.maximum)
        val current = state.value
        if (current.rendering || current.values.isEmpty() || current.values[name] == next) return
        beginGesture()
        val manualWb = name == "temperature" || name == "tint"
        val values =
            (current.values + (name to next)).mapValues { (key, value) ->
                if (manualWb && (key == "temperature" || key == "tint")) {
                    val spec = AdjustmentFields.byName.getValue(key)
                    value.coerceIn(spec.minimum, spec.maximum)
                } else value
            }
        val document =
            if (manualWb)
                listOf("temperature", "tint").fold(current.document) { doc, key ->
                    doc.withField(AdjustmentFields.byName.getValue(key), values.getValue(key))
                }
            else current.document.withField(field, next)
        mutable.update {
            it.copy(values = values, document = document, dirty = true)
        }
        draws.trySend(DrawRequest(generation, values))
        scheduleSave()
    }

    fun commitGesture() {
        val before = gesture ?: return
        gesture = null
        if (before != snapshot()) {
            undo.addLast(before)
            while (undo.size > 32) undo.removeFirst()
            redo.clear()
            historyState()
        }
    }

    private fun snapshot() = EditSnapshot(state.value.values, state.value.document)

    private fun historyState() {
        mutable.update { it.copy(canUndo = undo.isNotEmpty(), canRedo = redo.isNotEmpty()) }
    }

    private fun restore(value: EditSnapshot) {
        mutable.update { it.copy(values = value.values, document = value.document, dirty = true) }
        viewModelScope.launch {
            try {
                renderer.model(value.document.serialize())
                renderer.draw(value.values)
            } catch (failure: Exception) {
                fail(failure)
            }
        }
        historyState()
        scheduleSave()
    }

    fun undo() {
        commitGesture()
        if (undo.isNotEmpty()) {
            redo.addLast(snapshot())
            restore(undo.removeLast())
        }
    }

    fun redo() {
        if (redo.isNotEmpty()) {
            undo.addLast(snapshot())
            restore(redo.removeLast())
        }
    }

    fun resetField(name: String) {
        beginGesture()
        AdjustmentFields.byName[name]?.let { setField(name, it.initial) }
        commitGesture()
    }

    fun attribute(name: String, value: String?) {
        beginGesture()
        mutable.update { it.copy(document = it.document.withAttribute(name, value), dirty = true) }
        commitGesture()
        scheduleSave()
        if (state.value.mode == PhotoMode.Edit)
            viewModelScope.launch {
                try {
                    renderer.model(state.value.document.serialize())
                } catch (failure: Exception) {
                    fail(failure)
                }
            }
    }

    fun setFilmstrip(value: Boolean) {
        preferences.edit().putBoolean("filmstrip", value).apply()
        mutable.update { it.copy(showFilmstrip = value) }
    }

    private fun scheduleSave() {
        saveJob?.cancel()
        saveJob = viewModelScope.launch {
            delay(750)
            // Once persistence starts it must finish and advance its baseline.
            // Subsequent gestures may cancel only a pending debounce timer.
            saveJob = null
            persist()
        }
    }

    fun saveOnStop() {
        viewModelScope.launch { flush() }
    }

    suspend fun flush(): Boolean {
        saveJob?.cancel()
        saveJob = null
        return persist()
    }

    private suspend fun persist(): Boolean {
        saveLock.lock()
        try {
            val snapshot = state.value
            val photo = snapshot.selected ?: return true
            if (!snapshot.dirty) return true
            mutable.update { it.copy(saving = true) }
            withContext(NonCancellable) {
                val result = library.save(photo, snapshot.document, baseline)
                baseline = result.baseline
                mutable.update { current ->
                    if (current.selected == photo)
                        current.copy(
                            saving = false,
                            dirty = current.document != snapshot.document,
                            document =
                                if (current.document == snapshot.document) result.document
                                else current.document,
                        )
                    else current
                }
            }
            return true
        } catch (failure: Exception) {
            fail(failure)
            return false
        } finally {
            saveLock.unlock()
        }
    }

    suspend fun export(destination: Uri, xmp: Boolean) {
        check(flush()) { "Save the sidecar before exporting" }
        val snapshot = state.value
        val photo = snapshot.selected ?: error("Choose a photo")
        check(destination != photo.uri) { "Choose an export destination other than the original" }
        if (destination.scheme == "file" && photo.uri.scheme == "file") {
            check(File(destination.path!!).canonicalPath != File(photo.uri.path!!).canonicalPath) {
                "Originals cannot be overwritten"
            }
        }
        if (
            android.provider.DocumentsContract.isDocumentUri(getApplication(), destination) &&
                android.provider.DocumentsContract.isDocumentUri(getApplication(), photo.uri)
        ) {
            check(
                destination.authority != photo.uri.authority ||
                    android.provider.DocumentsContract.getDocumentId(destination) !=
                        android.provider.DocumentsContract.getDocumentId(photo.uri)
            ) {
                "Originals cannot be overwritten"
            }
        }
        val context = getApplication<Application>()
        withContext(Dispatchers.IO) {
            context.contentResolver.openOutputStream(destination, "wt")?.use { output ->
                if (xmp) output.write(snapshot.document.serialize().toByteArray(Charsets.UTF_8))
                else {
                    val temp = File(context.cacheDir, "export-${java.util.UUID.randomUUID()}.jpg")
                    try {
                        library.withOriginal(photo) { source ->
                            NativeBridge.export(
                                source.absolutePath,
                                snapshot.document.serialize(),
                                temp.absolutePath,
                            )
                        }
                        temp.inputStream().use { it.copyTo(output) }
                    } finally {
                        temp.delete()
                    }
                }
            } ?: error("Export destination is unavailable")
        }
    }

    override fun onCleared() {
        draws.close()
        renderer.close()
    }
}
