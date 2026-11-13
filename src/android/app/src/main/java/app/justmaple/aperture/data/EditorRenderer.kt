package app.justmaple.aperture.data

import android.view.Surface
import app.justmaple.aperture.generated.AdjustmentFields
import java.util.concurrent.Executors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.withContext
import org.json.JSONObject
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** The handle, GPU and ANativeWindow belong to exactly one serial worker. */
class EditorRenderer(library: PhotoLibrary, private val onPresented: (Int) -> Unit) : PreviewRenderer {
    private val nativeDetail = NativeDetailRenderer(library) { expectedEpoch ->
        withContext(NonCancellable + dispatcher) {
            check(handle != 0L && epoch == expectedEpoch) { "The photo changed before native detail could start" }
            val source = if (values["_raw"] == 1f) NativeBridge.copyNativeDetail(handle) else 0L
            source to NativeBridge.outputPrimaries(handle)
        }
    }
    override suspend fun nativeDimensions(photo: Photo) = nativeDetail.dimensions(photo)
    override suspend fun nativeDetail(request: NativeDetailRequest) = nativeDetail.render(request)
    override fun cancelNativeDetail() = nativeDetail.invalidate()

    private val analysisLock = Mutex()
    private val dispatcher =
        Executors.newSingleThreadExecutor { task ->
                Thread(null, task, "Maple render", 16L * 1024 * 1024)
            }
            .asCoroutineDispatcher()
    private val preparationDispatcher =
        Executors.newSingleThreadExecutor { task ->
                Thread(null, task, "Maple refine", 16L * 1024 * 1024)
            }
            .asCoroutineDispatcher()
    private var handle = 0L
    private var renderer = 0L
    private val drawLock = Any()
    private var cancellation = NativeBridge.createCancellation()
    private var refinementCancellation = 0L
    private var appliedRevision = -1

    data class SurfaceBinding(
        val surface: Surface?,
        val width: Int,
        val height: Int,
        val wideColor: Boolean = false,
    )

    @Volatile private var currentSurface = SurfaceBinding(null, 0, 0)
    private var attachedSurface: SurfaceBinding? = null
    private var epoch = 0
    @Volatile
    override var hasPresented = false
        private set

    @Volatile
    override var revision = 0
        private set

    override fun invalidateDraws(): Int =
        synchronized(drawLock) {
            revision += 1
            NativeBridge.setCancellation(cancellation, true)
            NativeBridge.setCancellation(refinementCancellation, true)
            revision
        }

    private fun beginDraw(expectedRevision: Int): Boolean =
        synchronized(drawLock) {
            if (cancellation == 0L || expectedRevision != revision) false
            else {
                NativeBridge.setCancellation(cancellation, false)
                true
            }
        }

    private var modelXml = ""
    // Counted, not flagged: a draw already running when a restore arrives
    // reloads for the invalidation it saw and leaves the newer one pending.
    @Volatile private var invalidations = 0
    private var reloadedInvalidation = 0
    private var values = emptyMap<String, Float>()

    override fun invalidateModel() {
        invalidations += 1
    }

    override suspend fun open(
        path: String,
        document: String,
        edge: Int,
        generation: Int,
    ): Map<String, Float> =
        withContext(dispatcher) {
            release()
            epoch = generation
            if (renderer == 0L) renderer = NativeBridge.createRenderer()
            handle = NativeBridge.open(path, document, edge, renderer)
            modelXml = document
            reloadedInvalidation = invalidations
            values = readValues()
            appliedRevision = revision
            applySurface(currentSurface)
            values
        }

    // Called synchronously inside SurfaceHolder callbacks, before Android can
    // abandon the old BufferQueue. Pending worker jobs see the new identity.
    override fun recordSurface(next: Surface?, w: Int, h: Int, wideColor: Boolean): SurfaceBinding =
        SurfaceBinding(next, w, h, wideColor).also {
            currentSurface = it
            hasPresented = false
        }

    override suspend fun attach(binding: SurfaceBinding) =
        withContext(dispatcher) {
            if (handle != 0L) applySurface(binding)
        }

    private fun applySurface(binding: SurfaceBinding) {
        if (binding !== currentSurface) return
        if (
            binding.surface != null &&
                (!binding.surface.isValid || binding.width <= 0 || binding.height <= 0)
        )
            return
        try {
            NativeBridge.attach(
                handle,
                binding.surface,
                binding.width,
                binding.height,
                binding.wideColor,
            )
            attachedSurface = binding.takeIf { it.surface != null }
            renderCurrent(revision)
        } catch (failure: Exception) {
            // A replaced SurfaceView can lose its queue during configuration.
            // Only that retired binding is discarded; current failures surface.
            if (binding === currentSurface) throw failure
        }
    }

    private fun renderCurrent(expectedRevision: Int) {
        val binding = attachedSurface ?: return
        if (binding !== currentSurface || binding.surface?.isValid != true) return
        if (!beginDraw(expectedRevision)) return
        try {
            val presented = NativeBridge.render(handle, cancellation)
            if (
                presented &&
                    expectedRevision == revision &&
                    binding === currentSurface &&
                    !hasPresented
            ) {
                hasPresented = true
                onPresented(epoch)
            }
        } catch (failure: Exception) {
            if (expectedRevision == revision && binding === currentSurface) throw failure
        }
    }

    override suspend fun draw(
        next: Map<String, Float>,
        expectedRevision: Int,
        xml: String,
    ) =
        withContext(dispatcher) {
            if (handle == 0L || expectedRevision != revision) return@withContext
            val seenInvalidation = invalidations
            if (EditorDrawPlan.needsReload(xml, modelXml, seenInvalidation, reloadedInvalidation)) {
                NativeBridge.setModel(handle, xml)
                modelXml = xml
                reloadedInvalidation = seenInvalidation
                values = readValues()
            }
            EditorDrawPlan.forEachFieldToApply(values, next) { field, value ->
                NativeBridge.setField(handle, field.index, value)
            }
            values = next
            appliedRevision = expectedRevision
            renderCurrent(expectedRevision)
        }

    override suspend fun refine(expectedRevision: Int) {
        var work = 0L
        var flag = 0L
        try {
            withContext(dispatcher) {
                if (
                    handle != 0L &&
                        expectedRevision == revision &&
                        appliedRevision == expectedRevision
                )
                    work = NativeBridge.createPreparation(handle)
            }
            if (work == 0L) return
            synchronized(drawLock) {
                if (expectedRevision == revision && cancellation != 0L) {
                    flag = NativeBridge.createCancellation()
                    refinementCancellation = flag
                }
            }
            if (flag == 0L) return
            val ready =
                withContext(preparationDispatcher) { NativeBridge.runPreparation(work, flag) }
            if (ready)
                withContext(dispatcher) {
                    if (
                        handle != 0L &&
                            expectedRevision == revision &&
                            appliedRevision == expectedRevision &&
                            NativeBridge.applyPreparation(handle, work, flag)
                    )
                        renderCurrent(expectedRevision)
                }
        } finally {
            // withContext does not leave a synchronous JNI call running behind
            // this cleanup, including prompt coroutine cancellation on return.
            withContext(NonCancellable + Dispatchers.Default) {
                NativeBridge.closePreparation(work)
                synchronized(drawLock) {
                    if (refinementCancellation == flag) refinementCancellation = 0L
                    NativeBridge.closeCancellation(flag)
                }
            }
        }
    }

    override suspend fun autoWhiteBalance(document: String): app.justmaple.aperture.WhiteBalanceRecommendation =
        analysisLock.withLock {
            // Keep allocation, CPU use and release in one cancellation-safe
            // lifetime. Waiting analyses acquire no extra RAW reference.
            withContext(NonCancellable) {
                val work = withContext(dispatcher) {
                    check(handle != 0L) { "Open a RAW photo before Auto white balance" }
                    NativeBridge.createAutoWhiteBalance(handle, document)
                }
                // The work owns immutable RAW data; navigation and GPU draws
                // remain free to use/release the live renderer independently.
                withContext(Dispatchers.Default) {
                    try {
                        val result = JSONObject(NativeBridge.runAutoWhiteBalance(work))
                        app.justmaple.aperture.WhiteBalanceRecommendation(
                            result.getDouble("temperature").toFloat(), result.getDouble("tint").toFloat(),
                            result.getDouble("algorithmVersion").toFloat(),
                        )
                    } finally { NativeBridge.closeAutoWhiteBalance(work) }
                }
            }
        }

    override suspend fun shutdown() = withContext(dispatcher) { release() }

    private fun readValues(): Map<String, Float> {
        val objectValues = JSONObject(NativeBridge.values(handle))
        return AdjustmentFields.all.associate {
            it.name to objectValues.optDouble(it.name, it.initial.toDouble()).toFloat()
        } +
            mapOf(
                "_uncropped_aspect" to objectValues.getDouble("_uncropped_aspect").toFloat(),
                "_aspect" to objectValues.optDouble("_aspect", 1.5).toFloat(),
                "_raw" to objectValues.optDouble("_raw", 0.0).toFloat(),
                "_shot_temperature" to objectValues.getDouble("_shot_temperature").toFloat(),
                "_shot_tint" to objectValues.getDouble("_shot_tint").toFloat(),
            )
    }

    private fun release() {
        nativeDetail.clear()
        if (handle != 0L) NativeBridge.close(handle)
        handle = 0L
        attachedSurface = null
        hasPresented = false
        values = emptyMap()
    }

    override fun close() {
        nativeDetail.close()
        invalidateDraws()
        // Enqueue teardown behind any native call; never close a rendering handle.
        dispatcher.executor.execute {
            try {
                release()
            } finally {
                if (renderer != 0L) NativeBridge.closeRenderer(renderer)
                renderer = 0L
                synchronized(drawLock) {
                    NativeBridge.closeCancellation(cancellation)
                    cancellation = 0L
                }
            }
        }
        dispatcher.close()
        preparationDispatcher.close()
    }
}
