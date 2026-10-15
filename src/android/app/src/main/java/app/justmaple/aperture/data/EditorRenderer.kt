package app.justmaple.aperture.data

import android.view.Surface
import app.justmaple.aperture.generated.AdjustmentFields
import java.io.Closeable
import java.util.concurrent.Executors
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** The handle, GPU and ANativeWindow belong to exactly one serial worker. */
class EditorRenderer(private val onPresented: (Int) -> Unit) : Closeable {
    private val dispatcher =
        Executors.newSingleThreadExecutor { task ->
                Thread(null, task, "Maple render", 16L * 1024 * 1024)
            }
            .asCoroutineDispatcher()
    private var handle = 0L

    data class SurfaceBinding(val surface: Surface?, val width: Int, val height: Int)

    @Volatile private var currentSurface = SurfaceBinding(null, 0, 0)
    private var attachedSurface: SurfaceBinding? = null
    private var epoch = 0
    @Volatile
    var hasPresented = false
        private set

    @Volatile
    var revision = 0
        private set

    fun invalidateDraws(): Int = ++revision

    private var modelXml = ""
    private var values = emptyMap<String, Float>()

    suspend fun open(
        path: String,
        document: String,
        edge: Int,
        generation: Int,
    ): Map<String, Float> =
        withContext(dispatcher) {
            release()
            epoch = generation
            handle = NativeBridge.open(path, document, edge)
            modelXml = document
            values = readValues()
            applySurface(currentSurface)
            values
        }

    // Called synchronously inside SurfaceHolder callbacks, before Android can
    // abandon the old BufferQueue. Pending worker jobs see the new identity.
    fun recordSurface(next: Surface?, w: Int, h: Int): SurfaceBinding =
        SurfaceBinding(next, w, h).also {
            currentSurface = it
            hasPresented = false
        }

    suspend fun attach(binding: SurfaceBinding) =
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
            NativeBridge.attach(handle, binding.surface, binding.width, binding.height)
            attachedSurface = binding.takeIf { it.surface != null }
            renderCurrent()
        } catch (failure: Exception) {
            // A replaced SurfaceView can lose its queue during configuration.
            // Only that retired binding is discarded; current failures surface.
            if (binding === currentSurface) throw failure
        }
    }

    private fun renderCurrent() {
        val binding = attachedSurface ?: return
        if (binding !== currentSurface || binding.surface?.isValid != true) return
        try {
            NativeBridge.render(handle)
            if (binding === currentSurface && !hasPresented) {
                hasPresented = true
                onPresented(epoch)
            }
        } catch (failure: Exception) {
            if (binding === currentSurface) throw failure
        }
    }

    suspend fun draw(next: Map<String, Float>, expectedRevision: Int, xml: String) =
        withContext(dispatcher) {
            if (handle == 0L || expectedRevision != revision) return@withContext
            if (xml != modelXml) {
                NativeBridge.setModel(handle, xml)
                modelXml = xml
                values = readValues()
            }
            if (values["temperature"] != next["temperature"] || values["tint"] != next["tint"]) {
                for (name in listOf("temperature", "tint")) {
                    next[name]?.let {
                        NativeBridge.setField(
                            handle,
                            AdjustmentFields.byName.getValue(name).index,
                            it,
                        )
                    }
                }
            }
            for (field in AdjustmentFields.all) {
                if (field.name == "temperature" || field.name == "tint") continue
                val value = next[field.name] ?: continue
                if (values[field.name] != value) NativeBridge.setField(handle, field.index, value)
            }
            values = next
            renderCurrent()
        }

    suspend fun shutdown() = withContext(dispatcher) { release() }

    private fun readValues(): Map<String, Float> {
        val objectValues = JSONObject(NativeBridge.values(handle))
        return AdjustmentFields.all.associate {
            it.name to objectValues.optDouble(it.name, it.initial.toDouble()).toFloat()
        } +
            mapOf(
                "_aspect" to objectValues.optDouble("_aspect", 1.5).toFloat(),
                "_raw" to objectValues.optDouble("_raw", 0.0).toFloat(),
            )
    }

    private fun release() {
        if (handle != 0L) NativeBridge.close(handle)
        handle = 0L
        attachedSurface = null
        hasPresented = false
        values = emptyMap()
    }

    override fun close() {
        // Enqueue teardown behind any native call; never close a rendering handle.
        dispatcher.executor.execute { release() }
        dispatcher.close()
    }
}
