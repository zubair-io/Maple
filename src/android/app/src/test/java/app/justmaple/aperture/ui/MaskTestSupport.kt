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
 * The JNI renderer is the only seam in the mask and heal tests. raw-core's mask and
 * repair codecs sit behind it, so this one keeps each family's JSON inside a single
 * container element: the real `XmpDocument` splice, history, ViewModel and sidecar
 * writer carry it. Weights are a constant full weight and the frame map is the identity
 * unless a test sets [frame]; the eyedropper answers with a fixed seed at the point it is
 * given. [raw] is the photo's source kind; [invalidations] counts native model reloads.
 */
internal class MaskTestRenderer(private val raw: Boolean = true) : PreviewRenderer {
    override val hasPresented = true
    override var revision = 0
    var latest: EditSnapshot? = null
    /** Counted on the tint's background dispatcher, read from the test thread. */
    @Volatile var weightRequests = 0
    var invalidations = 0
    val samples = mutableListOf<Pair<Float, Float>>()
    /** When set, a sample stays in flight until the test completes it. */
    var sampleGate: CompletableDeferred<Unit>? = null
    /** The RAW's EXIF orientation code the session reports. */
    var orientation = 1f
    /** The codec's answer whether written repairs still render; by default, whether any spot was written. */
    var repairsRemain: Boolean? = null
    /** The last input the repair codec read. */
    var repairRead: JSONObject? = null

    override fun invalidateDraws() = ++revision
    override fun invalidateModel() {
        invalidations++
    }
    override suspend fun open(path: String, document: String, edge: Int, generation: Int) =
        mapOf("exposure" to 0f, "_raw" to if (raw) 1f else 0f, "_uncropped_aspect" to 1.5f, "_orientation" to orientation)
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

    override fun readMasks(input: String): String =
        JSONObject().put("layers", stored(input, MASKS) ?: JSONArray()).toString()

    override fun writeMasks(input: String): String = written(input, MASKS, "layers")

    /** Each stored spot reads back with its position as the entry it was read from. */
    override fun readRepairs(input: String): String {
        repairRead = JSONObject(input)
        val spots = stored(input, REPAIRS) ?: JSONArray()
        for (index in 0 until spots.length()) spots.getJSONObject(index).put("slot", index)
        return JSONObject().put("spots", spots).toString()
    }

    override fun writeRepairs(input: String): String =
        JSONObject(written(input, REPAIRS, "spots"))
            .put("spots", repairsRemain ?: (JSONObject(input).getJSONArray("spots").length() > 0)).toString()

    override fun maskWeights(layer: String, width: Int, height: Int): ByteArray {
        weightRequests++
        return ByteArray(width * height) { -1 }
    }

    /** Every `(crop, geometry)` the overlay asked to map, in order. */
    val frameRequests = mutableListOf<Pair<CropRect, List<Float>>>()
    /** The presented → frame projection the native map would return; identity unless a test sets it. */
    var frame: (CropRect, List<Float>) -> DoubleArray = { _, _ -> doubleArrayOf(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0) }

    override fun maskFrame(size: NativeImageSize, crop: CropRect, geometry: List<Float>): DoubleArray {
        frameRequests += crop to geometry
        return frame(crop, geometry)
    }

    override suspend fun sampleMaskRange(document: String, x: Float, y: Float): String {
        samples += x to y
        sampleGate?.await()
        return JSONObject().put("seed", JSONObject().put("hue_deg", 40.0).put("chroma_min", .05).put("l_min", .2)
            .put("l_max", .8)).toString()
    }

    private companion object {
        const val MASKS = "crs:MaskGroupBasedCorrections"
        const val REPAIRS = "crs:RetouchAreas"

        fun container(tag: String) = Regex("<$tag>(.*)</$tag>", RegexOption.DOT_MATCHES_ALL)

        fun stored(input: String, tag: String): JSONArray? {
            val containers = JSONObject(input).getJSONArray("containers")
            return (0 until containers.length()).firstNotNullOfOrNull {
                container(tag).find(containers.getJSONObject(it).getString("xml"))?.groupValues?.get(1)
            }?.let { JSONArray(unescape(it)) }
        }

        fun written(input: String, tag: String, key: String): String {
            val json = JSONObject(input)
            val count = json.getJSONArray("containers").length()
            val items = json.getJSONArray(key)
            val text = if (items.length() == 0) "" else "<$tag>${escape(items.toString())}</$tag>"
            val containers = JSONArray((0 until count).map { if (it == 0) text else "" })
            val appended = JSONArray(if (count == 0 && text.isNotEmpty()) listOf(text) else emptyList())
            return JSONObject().put("containers", containers).put("appended", appended).toString()
        }

        fun escape(text: String) = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

        fun unescape(text: String) = text.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
    }
}

/**
 * A real ViewModel and PhotoLibrary over a temp photo, open for editing; [sidecar] is saved
 * first and [orientation] is the EXIF orientation the session reports.
 */
internal class MaskFixture(prefix: String, rawSource: Boolean = true, sidecar: String? = null, orientation: Float = 1f) {
    val app = RuntimeEnvironment.getApplication()
    val raw: File = File.createTempFile(prefix, ".dng", app.cacheDir).apply { writeText("renderer seam") }
    val photo = Photo(Uri.fromFile(raw), raw.name, raw.length(), raw.lastModified(), null)
    val library = PhotoLibrary(app)
    val renderer = MaskTestRenderer(rawSource)
    val model = MapleViewModel(app, library, renderer)

    init {
        renderer.orientation = orientation
        runBlocking {
            sidecar?.let { library.save(photo, XmpDocument(it), null) }
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
