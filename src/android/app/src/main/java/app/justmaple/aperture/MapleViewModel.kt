package app.justmaple.aperture

import android.app.Application
import android.net.Uri
import android.view.Surface
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.justmaple.aperture.data.*
import app.justmaple.aperture.generated.AdjustmentFields
import app.justmaple.aperture.ui.EditorGroup
import app.justmaple.aperture.ui.CropAspectId
import app.justmaple.aperture.ui.forCropPreview
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** Incremental Android parity work is tracked by #4623. No simulated sources. */
class MapleViewModel
internal constructor(
    application: Application,
    val library: PhotoLibrary,
    rendererOverride: PreviewRenderer?,
) : AndroidViewModel(application) {
    constructor(application: Application) : this(application, PhotoLibrary(application), null)

    // The one seam the recovery tests (#4765) substitute — the JNI renderer;
    // the sidecar layer is always the real one (CLAUDE.md: no mocks there).
    val renderer: PreviewRenderer = rendererOverride ?: EditorRenderer(::framePresented)
    private val preferences = application.getSharedPreferences("maple-ui", 0)
    private val mutable =
        MutableStateFlow(
            MapleState(
                sources = library.sources,
                showFilmstrip = preferences.getBoolean("filmstrip", true),
                cloudSigningIn = library.cloud.signingIn,
            )
        )
    val state = mutable.asStateFlow()
    internal var initialIntentHandled = false
    private var generation = 0
    private var singleRequest = 0
    private var renderXml = ""
    private var openingEdit: EditSnapshot? = null
    private var autoWhiteBalanceRequest = 0
    private var autoWhiteBalanceJob: Job? = null
    private var baseline: String? = null
    private var saveJob: Job? = null
    private val saveLock = kotlinx.coroutines.sync.Mutex()
    private val history = EditHistory()
    private val draws = Channel<DrawRequest>(Channel.CONFLATED)
    private var refineJob: Job? = null

    init {
        viewModelScope.launch {
            for (request in draws) {
                if (request.generation != generation) continue
                try {
                    renderer.draw(request.values, request.revision, request.xml)
                    if (request.generation == generation && request.revision == renderer.revision)
                        scheduleRefine(request)
                } catch (failure: Exception) {
                    if (failure is CancellationException) throw failure
                    if (request.generation == generation && request.revision == renderer.revision)
                        fail(failure, "Could not render photo")
                }
            }
        }
        library.sources.firstOrNull()?.let(::browse)
    }

    fun report(failure: Throwable) = fail(failure)

    private fun fail(failure: Throwable, operation: String = "Operation failed") {
        mutable.update { it.failed(failure, operation) }
    }

    fun clearError() {
        mutable.update { it.copy(error = null, canResetRawOnlySliders = false) }
    }

    fun beginCloud(input: String): Uri? = runCatching {
        library.cloud.begin(input)
    }
        .onSuccess {
            mutable.update { it.copy(cloudSigningIn = true, error = null) }
        }
        .onFailure(::fail)
        .getOrNull()

    fun cancelCloudLogin() {
        library.cloud.cancelLogin()
        mutable.update { it.copy(cloudSigningIn = false) }
    }

    fun completeCloud(callback: Uri) = connectCloud { library.cloud.complete(callback) }

    private fun connectCloud(connect: suspend () -> Folder?) {
        viewModelScope.launch {
            try {
                val source = connect() ?: return@launch
                mutable.update {
                    it.copy(
                        sources = library.sources,
                        cloudSigningIn = false,
                        cloudConnectionsVersion = it.cloudConnectionsVersion + 1,
                    )
                }
                browse(source)
            } catch (failure: Exception) {
                if (failure is CancellationException) return@launch
                library.cloud.cancelLogin()
                mutable.update { it.copy(cloudSigningIn = false) }
                fail(failure, "Could not connect to Maple Cloud")
            }
        }
    }

    fun disconnectCloud(source: Folder) {
        viewModelScope.launch {
            // Edits on this server cannot be saved once it is gone; a failing
            // save there must not hold the disconnect hostage (#4765).
            if (!flush()) {
                if (state.value.selected?.uri?.host != source.uri.host) return@launch
                discardUnsavedEditsNow()
            }
            val active = state.value.folder?.uri?.host == source.uri.host
            if (active) {
                ++generation
                renderer.shutdown()
                mutable.update {
                    it.copy(
                        mode = PhotoMode.Browse,
                        folder = null,
                        folderTrail = emptyList(),
                        photos = emptyList(),
                        folders = emptyList(),
                        selected = null,
                    )
                }
            }
            try {
                library.cloud.disconnect(source)
            } catch (failure: Exception) {
                fail(failure)
            } finally {
                mutable.update { it.copy(sources = library.sources) }
            }
        }
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

    fun browse(folder: Folder, ancestors: List<Folder>? = null) {
        viewModelScope.launch {
            if (!flush()) return@launch
            val token = ++generation
            mutable.update {
                it.copy(
                    loading = true,
                    folder = folder,
                    folderTrail = it.trailTo(folder, ancestors),
                    folders = emptyList(),
                    photos = emptyList(),
                    mode = PhotoMode.Browse,
                    selected = null,
                    error = null,
                    canResetRawOnlySliders = false,
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

    fun openSingle(uri: Uri) = viewModelScope.launch {
        val request = ++singleRequest
        if (!flush() || request != singleRequest) return@launch
        val token = generation
        mutable.update { it.copy(loading = true, error = null) }
        try {
            val photo = library.single(uri)
            if (token == generation && request == singleRequest) open(photo, single = true)
        } catch (failure: Exception) {
            if (token == generation && request == singleRequest) fail(failure)
        }
    }

    fun open(photo: Photo) = viewModelScope.launch { open(photo, single = false) }

    fun openAdjacent(delta: Int): Boolean {
        val snapshot = state.value
        val current = snapshot.selected ?: return false
        val index = snapshot.photos.indexOfFirst { it.uri == current.uri }
        if (index < 0) return false
        val target = snapshot.photos.getOrNull(index + delta) ?: return false
        open(target)
        return true
    }

    private suspend fun open(photo: Photo, single: Boolean) {
        if (!flush()) return
        val nextMode = if (state.value.mode == PhotoMode.Edit) PhotoMode.Edit else PhotoMode.Preview
        val token = ++generation
        baseline = null
        openingEdit = null
        ++autoWhiteBalanceRequest
        autoWhiteBalanceJob?.cancel()
        mutable.update {
            it.copy(
                cropAspect = CropAspectId.Free,
                cropAspectSwapped = false,
                selected = photo,
                photos = if (single) listOf(photo) else it.photos,
                folder = if (single) null else it.folder,
                folderTrail = if (single) emptyList() else it.folderTrail,
                folders = if (single) emptyList() else it.folders,
                documentLoaded = false,
                mode = nextMode,
                canResetRawOnlySliders = false,
                comparingBefore = false,
                autoWhiteBalanceInFlight = false,
                loading = true,
                rendering = false,
                document = XmpDocument(),
                values = emptyMap(),
                canUndo = false,
                canRedo = false,
                dirty = false,
                error = null,
            )
        }
        history.clear()
        try {
            renderer.shutdown()
            val loaded = library.loadSidecar(photo)
            if (token != generation) return
            baseline = loaded.baseline
            mutable.update {
                it.copy(
                    document = loaded.document,
                    documentLoaded = true,
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

    fun edit() {
        if (!state.value.documentLoaded || state.value.loading) return
        viewModelScope.launch {
            mutable.update { it.copy(mode = PhotoMode.Edit) }
            startEditor(generation)
        }
    }

    private suspend fun startEditor(token: Int) {
        renderer.invalidateDraws()
        val snapshot = state.value
        val photo = snapshot.selected ?: return
        mutable.update {
            it.copy(rendering = true, values = emptyMap(), canResetRawOnlySliders = false)
        }
        try {
            renderXml = presentedXml(snapshot.document)
            val values =
                library.withPreview(photo, 2048) { input ->
                    renderer.open(input.absolutePath, renderXml, 2048, token)
                }
            if (token == generation) {
                if (openingEdit == null) openingEdit = EditSnapshot(values, snapshot.document)
                mutable.update { it.copy(values = values, rendering = !renderer.hasPresented) }
                scheduleRefine(DrawRequest(token, renderer.revision, values, renderXml))
            }
        } catch (failure: Exception) {
            val canReset =
                generateSequence<Throwable>(failure) { it.cause }
                    .any {
                        it.message?.contains("raster image:") == true
                    } &&
                    withContext(Dispatchers.Default) {
                        NativeBridge.rasterCompatible(
                            snapshot.document.withoutRawOnlySliders().serialize()
                        )
                    }
            if (token == generation) {
                fail(failure)
                mutable.update { it.copy(canResetRawOnlySliders = canReset) }
            }
        }
    }

    fun back() {
        viewModelScope.launch {
            if (!flush()) return@launch
            ++generation
            ++autoWhiteBalanceRequest
            autoWhiteBalanceJob?.cancel()
            renderer.shutdown()
            mutable.update {
                it.copy(
                    mode = if (it.mode == PhotoMode.Edit) PhotoMode.Preview else PhotoMode.Browse,
                    comparingBefore = false,
                    autoWhiteBalanceInFlight = false,
                    rendering = false,
                    loading = false,
                )
            }
        }
    }

    private fun presentedXml(document: XmpDocument): String =
        (if (state.value.cropToolActive) document.forCropPreview() else document).serialize()

    fun setCropToolActive(active: Boolean) {
        if (state.value.cropToolActive == active) return
        commitGesture()
        mutable.update { it.copy(cropToolActive = active, comparingBefore = false) }
        renderXml = presentedXml(state.value.document)
        renderer.invalidateModel()
        if (state.value.mode == PhotoMode.Edit && state.value.values.isNotEmpty())
            queueDraw(state.value.values)
    }

    fun setCropAspect(id: CropAspectId, swapped: Boolean = false) {
        mutable.update { it.copy(cropAspect = id, cropAspectSwapped = swapped) }
    }

    fun setComparingBefore(before: Boolean) {
        val current = state.value
        if (current.mode != PhotoMode.Edit || current.values.isEmpty()) return
        if (current.comparingBefore == before) return
        val comparison = if (before) (openingEdit ?: return).withCurrentCrop(current.document) else snapshot()
        mutable.update { it.copy(comparingBefore = before) }
        val drawValues = comparison.values
        renderXml = presentedXml(comparison.document)
        renderer.invalidateModel()
        queueDraw(drawValues)
    }

    fun autoWhiteBalance() {
        val current = state.value
        if (!current.canEdit || current.values["_raw"] != 1f || current.autoWhiteBalanceInFlight) return
        commitGesture()
        val before = snapshot()
        val token = generation
        val revision = renderer.revision
        val request = ++autoWhiteBalanceRequest
        mutable.update { it.copy(autoWhiteBalanceInFlight = true) }
        autoWhiteBalanceJob = viewModelScope.launch {
            try {
                val result = renderer.autoWhiteBalance(before.document.serialize())
                if (token != generation || revision != renderer.revision || snapshot() != before || !state.value.canEdit) return@launch
                val next = before.withAutoWhiteBalance(result)
                if (next.values == before.values && next.document.serialize() == before.document.serialize()) return@launch
                beginGesture()
                restore(next)
                commitGesture()
            } catch (failure: Exception) {
                if (failure is CancellationException) throw failure
                if (token == generation && revision == renderer.revision) fail(failure, "Could not analyze white balance")
            } finally {
                if (request == autoWhiteBalanceRequest) mutable.update { it.copy(autoWhiteBalanceInFlight = false) }
            }
        }
    }

    fun surface(surface: Surface?, width: Int, height: Int, wideColor: Boolean = false) {
        val binding = renderer.recordSurface(surface, width, height, wideColor)
        val token = generation
        if (state.value.mode == PhotoMode.Edit) mutable.update { it.copy(rendering = true) }
        viewModelScope.launch {
            try {
                renderer.attach(binding)
            } catch (failure: Exception) {
                if (failure is CancellationException) throw failure
                if (token == generation) fail(failure)
            }
        }
    }

    fun beginGesture() {
        history.begin(snapshot())
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
        if (!current.canEdit || current.values[name] == next) return
        if (current.values["_raw"] == 0f && !field.rasterSupported) return
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
            it.copy(values = values, document = document, comparingBefore = false, dirty = true)
        }
        renderXml = presentedXml(document)
        queueDraw(values)
        scheduleSave()
    }

    fun commitGesture() {
        history.commit(snapshot())
        historyState()
    }

    private fun snapshot() = EditSnapshot(state.value.values, state.value.document)

    private fun historyState() {
        mutable.update { it.copy(canUndo = history.canUndo, canRedo = history.canRedo) }
    }

    private fun restore(value: EditSnapshot) {
        mutable.update {
            it.copy(
                values = value.values,
                document = value.document,
                comparingBefore = false,
                dirty = true,
            )
        }
        renderXml = presentedXml(value.document)
        // Field pushes drifted the native model (wb_source = Manual); an
        // identical XML string must still reload it (#4766).
        renderer.invalidateModel()
        queueDraw(value.values)
        historyState()
        scheduleSave()
    }

    fun undo() {
        if (!state.value.canEdit) return
        commitGesture()
        history.undo(snapshot())?.let(::restore)
    }

    fun redo() {
        if (!state.value.canEdit) return
        history.redo(snapshot())?.let(::restore)
    }

    fun resetFields(names: List<String>) = resetControls(names, emptyList())

    fun resetGroup(group: EditorGroup) {
        val extraNames =
            when (group) {
                EditorGroup.Light -> app.justmaple.aperture.ui.toneCurveFieldNames
                EditorGroup.Color ->
                    app.justmaple.aperture.ui.HslBand.entries
                        .flatMap { app.justmaple.aperture.ui.hslBandFields(it) }
                        .map { it.name }
                else -> emptyList()
            }
        resetControls(group.fields.map { it.name } + extraNames, group.resetAttributes)
    }

    private fun resetControls(names: List<String>, attributes: List<String>) {
        val current = state.value
        if (!current.canEdit) return
        val fields =
            names.mapNotNull(AdjustmentFields.byName::get).filter {
                current.values["_raw"] == 1f || it.rasterSupported
            }
        if (fields.isEmpty() && attributes.isEmpty()) return
        beginGesture()
        restore(snapshot().reset(fields, attributes))
        commitGesture()
    }

    fun resetField(name: String) = resetFields(listOf(name))

    fun togglePick() {
        val picked = state.value.document.attribute("papp:Flag") == "pick"
        attribute("papp:Flag", if (picked) null else "pick")
    }

    fun toggleReject() {
        val rejected = state.value.document.attribute("papp:Flag") == "reject"
        attribute("papp:Flag", if (rejected) null else "reject")
    }

    fun attribute(name: String, value: String?) = setAttributes(mapOf(name to value), commit = true)

    fun setAttributes(updates: Map<String, String?>, commit: Boolean = true) {
        if (!state.value.canChangeMetadata || updates.isEmpty()) return
        val editing = state.value.mode == PhotoMode.Edit && state.value.values.isNotEmpty()
        if (editing) beginGesture()
        mutable.update { current ->
            val nextDoc =
                updates.entries.fold(current.document) { doc, (k, v) -> doc.withAttribute(k, v) }
            current.copy(document = nextDoc, comparingBefore = false, dirty = true)
        }
        if (editing && commit) commitGesture()
        scheduleSave()
        if (state.value.mode == PhotoMode.Edit) {
            renderXml = presentedXml(state.value.document)
            renderer.invalidateModel()
            queueDraw(state.value.values)
        }
    }

    fun reloadSavedEdits() {
        viewModelScope.launch {
            saveJob?.cancel()
            saveLock.lock()
            try {
                val photo = state.value.selected ?: return@launch
                mutable.update { it.copy(loading = true) }
                val loaded =
                    try {
                        library.loadSidecar(photo)
                    } catch (failure: Exception) {
                        if (failure is CancellationException) throw failure
                        // Unsaved edits stay loaded, so they remain saveable or
                        // discardable instead of wedging every flush (#4765).
                        // With nothing to lose the photo reverts to unloaded
                        // until a reload confirms what is on disk, so no write
                        // can start from a document storage may have replaced.
                        if (!state.value.dirty) {
                            baseline = null
                            mutable.update { it.copy(documentLoaded = false) }
                        }
                        fail(failure, "Could not reload saved edits")
                        return@launch
                    }
                replaceDocument(loaded)
            } catch (failure: Exception) {
                fail(failure)
            } finally {
                saveLock.unlock()
            }
        }
    }

    /** Drops unsaved edits without touching storage, so a photo whose sidecar
     * can no longer be written stops blocking navigation (#4765). */
    fun discardUnsavedEdits() {
        viewModelScope.launch { discardUnsavedEditsNow() }
    }

    /** Completes before returning, so a caller that goes on to clear the
     * selection (disconnecting the server) never races the discard. */
    private suspend fun discardUnsavedEditsNow() {
        saveJob?.cancel()
        saveJob = null
        saveLock.lock()
        try {
            val snapshot = state.value
            if (snapshot.selected == null || !snapshot.dirty) return
            val saved = runCatching { XmpDocument(baseline ?: XmpDocument.EMPTY) }.getOrDefault(XmpDocument())
            replaceDocument(LoadedSidecar(saved, baseline))
        } catch (failure: Exception) {
            fail(failure, "Could not discard edits")
        } finally {
            saveLock.unlock()
        }
    }

    private suspend fun replaceDocument(loaded: LoadedSidecar) {
        val token = ++generation
        renderer.invalidateDraws()
        renderer.shutdown()
        baseline = loaded.baseline
        history.clear()
        mutable.update {
            it.copy(
                document = loaded.document,
                documentLoaded = true,
                comparingBefore = false,
                loading = false,
                dirty = false,
                error = null,
                canUndo = false,
                canRedo = false,
            )
        }
        if (state.value.mode == PhotoMode.Edit) startEditor(token)
    }

    fun resetRawOnlySliders() {
        viewModelScope.launch {
            if (!state.value.canResetRawOnlySliders) return@launch
            val document = state.value.document.withoutRawOnlySliders()
            // Imported structured edits must survive untouched. Only offer this
            // numeric recovery when the core accepts the entire candidate XMP.
            if (!NativeBridge.rasterCompatible(document.serialize())) return@launch
            mutable.update {
                it.copy(
                    document = document,
                    dirty = true,
                    error = null,
                    canResetRawOnlySliders = false,
                )
            }
            if (flush() && state.value.mode == PhotoMode.Edit) startEditor(generation)
        }
    }

    fun setFilmstrip(value: Boolean) {
        preferences.edit().putBoolean("filmstrip", value).apply()
        mutable.update { it.copy(showFilmstrip = value) }
    }

    private fun queueDraw(values: Map<String, Float>) {
        refineJob?.cancel()
        draws.trySend(DrawRequest(generation, renderer.invalidateDraws(), values, renderXml))
    }

    private fun scheduleRefine(request: DrawRequest) {
        refineJob = viewModelScope.launch {
            delay(150)
            try {
                renderer.refine(request.revision)
            } catch (failure: Exception) {
                if (failure is CancellationException) throw failure
                if (request.generation == generation && request.revision == renderer.revision)
                    fail(failure, "Could not refine photo")
            }
        }
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
        viewModelScope.launch(NonCancellable) { flush() }
    }

    suspend fun flush(): Boolean {
        while (true) {
            saveJob?.cancel()
            saveJob = null
            if (!persist()) return false
            // A gesture can arrive while provider I/O is suspended. Navigation
            // may leave this document only after its newest revision is saved.
            if (!state.value.dirty) return true
        }
    }

    private suspend fun persist(): Boolean {
        saveLock.lock()
        try {
            val snapshot = state.value
            val photo = snapshot.selected ?: return true
            if (!snapshot.dirty) return true
            check(snapshot.documentLoaded) { "Reload the photo before saving edits" }
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
            // A failed background save must not blank the preview (#4765).
            mutable.update { it.saveFailed(failure) }
            return false
        } finally {
            saveLock.unlock()
        }
    }

    suspend fun export(
        destination: Uri,
        xmp: Boolean,
        options: app.justmaple.aperture.ui.ExportOptions = app.justmaple.aperture.ui.ExportOptions(),
    ) {
        check(flush()) { "Save the sidecar before exporting" }
        val snapshot = state.value
        check(snapshot.documentLoaded && !snapshot.loading) { "Load the photo before exporting" }
        val photo = snapshot.selected ?: error("Choose a photo")
        PhotoExport(getApplication(), library)
            .write(photo, snapshot.document, destination, xmp, options)
    }

    override fun onCleared() {
        refineJob?.cancel()
        draws.close()
        renderer.close()
    }
}
