package app.justmaple.aperture.ui

import android.net.Uri
import android.view.Surface
import app.justmaple.aperture.EditSnapshot
import app.justmaple.aperture.MapleViewModel
import app.justmaple.aperture.data.EditorRenderer
import app.justmaple.aperture.data.NativeDetailRequest
import app.justmaple.aperture.data.NativeImageSize
import app.justmaple.aperture.data.Photo
import app.justmaple.aperture.data.PhotoLibrary
import app.justmaple.aperture.data.PreviewRenderer
import app.justmaple.aperture.data.XmpDocument
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import org.robolectric.RuntimeEnvironment

/**
 * The JNI renderer is the only seam in the mask tests. raw-core's mask codec sits
 * behind it, so this one keeps the layer JSON inside a single container element:
 * the real `XmpDocument` splice, history, ViewModel and sidecar writer carry it.
 * Weights are a constant full weight and the crop map is the identity (the tests
 * do not crop); the eyedropper answers with a fixed seed at the point it is given.
 */
internal class MaskTestRenderer : PreviewRenderer {
    override val hasPresented = true
    override var revision = 0
    var latest: EditSnapshot? = null
    var weightRequests = 0
    val samples = mutableListOf<Pair<Float, Float>>()
    /** When set, a sample stays in flight until the test completes it. */
    var sampleGate: CompletableDeferred<Unit>? = null

    override fun invalidateDraws() = ++revision
    override fun invalidateModel() {}
    override suspend fun open(path: String, document: String, edge: Int, generation: Int) =
        mapOf("exposure" to 0f, "_raw" to 1f, "_uncropped_aspect" to 1.5f)
    override suspend fun modelValues(document: String): Map<String, Float> = error("Settings paste is not exercised by this test")
    override suspend fun autoWhiteBalance(document: String): app.justmaple.aperture.WhiteBalanceRecommendation =
        error("White balance analysis is not expected in this test")
    override suspend fun nativeDimensions(photo: Photo): NativeImageSize? = null
    override suspend fun nativeDetail(request: NativeDetailRequest): android.graphics.Bitmap =
        error("Native detail is not requested by this fixture")
    override fun cancelNativeDetail() {}
    override fun recordSurface(next: Surface?, w: Int, h: Int, wideColor: Boolean) =
        EditorRenderer.SurfaceBinding(next, w, h, wideColor)
    override suspend fun attach(binding: EditorRenderer.SurfaceBinding) {}
    override suspend fun draw(next: Map<String, Float>, expectedRevision: Int, xml: String) {
        latest = EditSnapshot(next, XmpDocument(xml))
    }
    override suspend fun refine(expectedRevision: Int) {}
    override suspend fun shutdown() {}
    override fun close() {}

    override fun readMasks(input: String): String {
        val containers = JSONObject(input).getJSONArray("containers")
        val stored =
            (0 until containers.length()).firstNotNullOfOrNull {
                CONTAINER.find(containers.getJSONObject(it).getString("xml"))?.groupValues?.get(1)
            }
        return JSONObject().put("layers", stored?.let { JSONArray(unescape(it)) } ?: JSONArray()).toString()
    }

    override fun writeMasks(input: String): String {
        val json = JSONObject(input)
        val count = json.getJSONArray("containers").length()
        val layers = json.getJSONArray("layers")
        val text = if (layers.length() == 0) "" else "<$TAG>${escape(layers.toString())}</$TAG>"
        val containers = JSONArray((0 until count).map { if (it == 0) text else "" })
        val appended = JSONArray(if (count == 0 && text.isNotEmpty()) listOf(text) else emptyList())
        return JSONObject().put("containers", containers).put("appended", appended).toString()
    }

    override fun maskWeights(layer: String, width: Int, height: Int): ByteArray {
        weightRequests++
        return ByteArray(width * height) { -1 }
    }

    override fun maskFrame(size: NativeImageSize, crop: CropRect): DoubleArray =
        doubleArrayOf(1.0, 0.0, 0.0, 0.0, 1.0, 0.0)

    override suspend fun sampleMaskRange(document: String, x: Float, y: Float): String {
        samples += x to y
        sampleGate?.await()
        return JSONObject().put("seed", JSONObject().put("hue_deg", 40.0).put("chroma_min", .05).put("l_min", .2)
            .put("l_max", .8)).toString()
    }

    private companion object {
        const val TAG = "crs:MaskGroupBasedCorrections"
        val CONTAINER = Regex("<$TAG>(.*)</$TAG>", RegexOption.DOT_MATCHES_ALL)

        fun escape(text: String) = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

        fun unescape(text: String) = text.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
    }
}

/** A real ViewModel and PhotoLibrary over a temp photo, open for editing. */
internal class MaskFixture(prefix: String) {
    val app = RuntimeEnvironment.getApplication()
    val raw: File = File.createTempFile(prefix, ".dng", app.cacheDir).apply { writeText("renderer seam") }
    val photo = Photo(Uri.fromFile(raw), raw.name, raw.length(), raw.lastModified(), null)
    val library = PhotoLibrary(app)
    val renderer = MaskTestRenderer()
    val model = MapleViewModel(app, library, renderer)

    init {
        runBlocking {
            model.open(photo)
            withTimeout(10_000) { model.state.first { it.documentLoaded && !it.loading } }
            model.edit()
            withTimeout(10_000) { model.state.first { it.canEdit } }
        }
    }

    fun close() {
        raw.delete()
    }
}
