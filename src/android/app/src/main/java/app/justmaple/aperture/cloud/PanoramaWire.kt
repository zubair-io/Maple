package app.justmaple.aperture.cloud

import java.io.IOException
import org.json.JSONArray
import org.json.JSONObject

enum class PanoRetention(val wire: String, val label: String) {
    Keep("keep", "Keep all"),
    Strict("strict", "Strict"),
}

enum class PanoLocalAlign(val wire: String, val label: String) {
    Mesh("mesh", "Mesh"),
    Off("off", "Off"),
}

enum class PanoStrategy(val wire: String, val label: String) {
    Auto("auto", "Auto"),
    Rotation("rotation", "Rotation"),
    Tile("tile", "Tile"),
}

/** The merge options the server accepts (`StitchBody.options` in `routes/pano.ts`). */
data class PanoOptions(
    val retention: PanoRetention = PanoRetention.Keep,
    val localAlign: PanoLocalAlign = PanoLocalAlign.Mesh,
    val strategy: PanoStrategy = PanoStrategy.Auto,
    val boundaryWarp: Int = 0,
    val autoCrop: Boolean = false,
)

/** What `GET /api/pano/config` says this server's binary can do. */
data class PanoCapabilities(
    val enabled: Boolean,
    val provisioned: Boolean,
    val strategy: Boolean,
    val preview: Boolean,
    val edges: Boolean,
    val seamConstraints: Boolean,
) {
    val ready: Boolean
        get() = enabled && provisioned
}

/** One CLI input, in the server's sorted input-path order; seam regions index this list. */
data class PanoFrame(val assetId: String, val path: String) {
    val name: String
        get() = path.substringAfterLast('/')
}

data class PanoProgress(val current: Int, val total: Int) {
    val fraction: Float?
        get() = if (total > 0) (current.toFloat() / total).coerceIn(0f, 1f) else null

    /** The six stage ordinals the server reports 100 units each for (`pano-progress.ts`). */
    val label: String
        get() {
            val value = fraction ?: return "Starting…"
            val stage = minOf((value * STAGES.size).toInt(), STAGES.lastIndex)
            return "${STAGES[stage]} · ${Math.round(value * 100)}%"
        }

    private companion object {
        val STAGES =
            listOf(
                "Decoding frames",
                "Detecting features",
                "Matching frames",
                "Refining matches",
                "Solving alignment",
                "Compositing",
            )
    }
}

enum class PanoJobStatus(val wire: String) {
    Queued("queued"),
    Running("running"),
    Done("done"),
    Failed("failed"),
    Cancelled("cancelled");

    val active: Boolean
        get() = this == Queued || this == Running
}

/** `GET /api/pano/jobs/:id`, with the preview and stitch result fields this client reads. */
data class PanoJob(
    val id: String,
    val kind: String,
    val status: PanoJobStatus,
    val progress: PanoProgress,
    val error: String?,
    val cancelRequested: Boolean,
    val width: Int? = null,
    val height: Int? = null,
    val frames: List<PanoFrame> = emptyList(),
    val outputAssetId: String? = null,
    val outputPath: String? = null,
    val matcherNote: String? = null,
    val alignment: String? = null,
    val seamConstraints: PanoSeamConstraints? = null,
)

/** One registered library of `GET /api/folders`. */
data class PanoLibrary(val id: String, val slug: String, val path: String)

data class PanoRequest(
    val assetPaths: List<String>,
    val libraryId: String,
    val options: PanoOptions,
    val capabilities: PanoCapabilities,
    val alignmentFrom: String? = null,
    val seamConstraints: PanoSeamConstraints? = null,
)

/** A refusal the server named (`{ error, message }`), such as `pano_not_provisioned`. */
class PanoRefusal(val status: Int, val code: String, message: String) : IOException(message) {
    /** Fixed from the server's Settings → Pano page, not by retrying here. */
    val settingsFixable: Boolean
        get() = code == "pano_not_provisioned" || code == "pano_cli_outdated"
}

internal object PanoramaWire {
    private fun JSONObject.text(name: String): String? =
        optString(name).takeIf { has(name) && !isNull(name) && it.isNotEmpty() }

    private fun JSONObject.count(name: String): Int? =
        if (has(name) && !isNull(name)) optInt(name) else null

    fun capabilities(json: JSONObject) =
        PanoCapabilities(
            enabled = json.optBoolean("enabled"),
            provisioned = json.text("maple_cli_path") != null,
            strategy = json.optBoolean("strategy_supported"),
            preview = json.optBoolean("preview_supported"),
            edges = json.optBoolean("edges_supported"),
            seamConstraints = json.optBoolean("seamConstraintsSupported"),
        )

    /** Options are sent only where the binary supports them, as the Web dialog does. */
    fun body(request: PanoRequest): String {
        val options = request.options
        val wire =
            JSONObject()
                .put("retention", options.retention.wire)
                .put("localAlign", options.localAlign.wire)
        if (request.capabilities.strategy) wire.put("strategy", options.strategy.wire)
        if (request.capabilities.edges && options.boundaryWarp > 0)
            wire.put("boundaryWarp", options.boundaryWarp.coerceIn(0, 100))
        if (request.capabilities.edges && options.autoCrop) wire.put("autoCrop", true)
        val body =
            JSONObject()
                .put("assetPaths", JSONArray(request.assetPaths))
                .put("libraryId", request.libraryId)
                .put("options", wire)
        request.alignmentFrom?.let { body.put("alignmentFrom", it) }
        request.seamConstraints?.takeIf { request.capabilities.seamConstraints }?.let { body.put("seamConstraints", it.json()) }
        return body.toString()
    }

    fun createdId(json: JSONObject): String =
        json.text("id") ?: throw IOException("The server did not name the panorama job")

    fun job(json: JSONObject): PanoJob {
        val status =
            json.optString("status").let { wire ->
                PanoJobStatus.entries.firstOrNull { it.wire == wire }
                    ?: throw IOException("Unknown panorama job status: $wire")
            }
        val progress = json.optJSONObject("progress")
        val result = json.optJSONObject("result")
        val frames = result?.optJSONArray("frames")
        return PanoJob(
            id = json.getString("id"),
            kind = json.optString("kind"),
            status = status,
            progress = PanoProgress(progress?.optInt("current") ?: 0, progress?.optInt("total") ?: 0),
            error = json.text("error"),
            cancelRequested = json.optBoolean("cancel_requested"),
            width = result?.count("width"),
            height = result?.count("height"),
            frames =
                (0 until (frames?.length() ?: 0)).map { index ->
                    val frame = frames!!.getJSONObject(index)
                    PanoFrame(frame.getString("assetId"), frame.getString("path"))
                },
            outputAssetId = result?.text("outputAssetId"),
            outputPath = result?.text("outputPath"),
            matcherNote = result?.text("matcherNote"),
            alignment = result?.optJSONObject("alignment")?.text("status"),
            seamConstraints = PanoSeamConstraints.parse(result?.optJSONObject("seamConstraints")),
        )
    }

    fun libraries(json: JSONArray): List<PanoLibrary> =
        (0 until json.length()).mapNotNull { index ->
            val row = json.getJSONObject(index)
            val id = row.text("id")
            val slug = row.text("slug")
            val path = row.text("path")
            if (id == null || slug == null || path == null) null else PanoLibrary(id, slug, path)
        }

    /** The registered library holding [path]: the longest root that contains it. */
    fun libraryHolding(libraries: List<PanoLibrary>, path: String): PanoLibrary? =
        libraries
            .filter { path == it.path || path.startsWith(it.path.trimEnd('/') + "/") }
            .maxByOrNull { it.path.length }

    /** A failed job's named code and message; the CLI's seam refusal arrives as its prefix. */
    fun failure(error: String?, fallback: String): Pair<String, String> =
        if (error != null && error.startsWith(PanoSeamConstraints.INVALID))
            PanoSeamConstraints.INVALID to PanoSeamConstraints.refusalMessage(error)
        else "" to (error ?: fallback)

    fun refusal(response: CloudResponse): PanoRefusal? {
        if (response.status in 200..299) return null
        val body = runCatching { JSONObject(response.text()) }.getOrNull()
        val code = body?.text("error").orEmpty()
        val message =
            when {
                response.status == 409 && code == "pano_job_running" ->
                    "A panorama is already being merged on this server. Wait for it to finish, then try again."
                response.status == 401 -> "Cloud session expired. Reconnect this server in Settings."
                code == PanoSeamConstraints.INVALID -> PanoSeamConstraints.refusalMessage(body?.text("message").orEmpty())
                else -> body?.text("message") ?: "Panorama request failed (HTTP ${response.status})."
            }
        return PanoRefusal(response.status, code, message)
    }
}
