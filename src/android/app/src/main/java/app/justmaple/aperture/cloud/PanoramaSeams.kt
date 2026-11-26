package app.justmaple.aperture.cloud

import app.justmaple.aperture.generated.SeamConstraintsSchema
import kotlin.math.ceil
import kotlin.math.floor
import org.json.JSONArray
import org.json.JSONObject

enum class PanoSeamKind(val wire: String, val label: String) {
    Include("include", "Include"),
    Exclude("exclude", "Exclude"),
}

/** One rectangle in uncropped preview pixels; [frame] indexes the preview's server-ordered frames. */
data class PanoSeamRegion(
    val kind: PanoSeamKind,
    val frame: Int,
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int,
)

/**
 * SeamConstraintsRequest v1 (#5991): regions on the uncropped preview canvas they were drawn on.
 * The server and Rust map them proportionally onto the full-resolution stitch, so the client never
 * rescales them.
 */
data class PanoSeamConstraints(val width: Int, val height: Int, val regions: List<PanoSeamRegion>) {
    fun fits(region: PanoSeamRegion): Boolean =
        region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0 &&
            region.x.toLong() + region.width <= width && region.y.toLong() + region.height <= height

    fun json(): JSONObject =
        JSONObject()
            .put("version", SeamConstraintsSchema.VERSION)
            .put("canvas", JSONObject().put("width", width).put("height", height))
            .put(
                "regions",
                JSONArray(
                    regions.map { region ->
                        JSONObject()
                            .put("kind", region.kind.wire)
                            .put("frame", region.frame)
                            .put("x", region.x)
                            .put("y", region.y)
                            .put("width", region.width)
                            .put("height", region.height)
                    }
                ),
            )

    companion object {
        const val INVALID = "invalid_seam_constraints"

        /** The constraints a finished job echoes in its result, or null when it had none. */
        fun parse(json: JSONObject?): PanoSeamConstraints? {
            if (json == null || json.optInt("version") != SeamConstraintsSchema.VERSION) return null
            val canvas = json.optJSONObject("canvas") ?: return null
            val regions = json.optJSONArray("regions") ?: return null
            return PanoSeamConstraints(
                canvas.optInt("width"),
                canvas.optInt("height"),
                (0 until regions.length()).map { index ->
                    val region = regions.optJSONObject(index) ?: return null
                    PanoSeamRegion(
                        PanoSeamKind.entries.firstOrNull { it.wire == region.optString("kind") } ?: return null,
                        region.optInt("frame"),
                        region.optInt("x"),
                        region.optInt("y"),
                        region.optInt("width"),
                        region.optInt("height"),
                    )
                },
            )
        }

        /** A drag between two canvas points as whole pixels covering both, or null when it has no area. */
        fun dragRegion(
            startX: Float,
            startY: Float,
            endX: Float,
            endY: Float,
            width: Int,
            height: Int,
            kind: PanoSeamKind,
            frame: Int,
        ): PanoSeamRegion? {
            if (startX == endX || startY == endY) return null
            val left = floor(minOf(startX, endX)).toInt().coerceIn(0, width)
            val top = floor(minOf(startY, endY)).toInt().coerceIn(0, height)
            val right = ceil(maxOf(startX, endX)).toInt().coerceIn(0, width)
            val bottom = ceil(maxOf(startY, endY)).toInt().coerceIn(0, height)
            val region = PanoSeamRegion(kind, frame, left, top, right - left, bottom - top)
            return region.takeIf { PanoSeamConstraints(width, height, emptyList()).fits(it) }
        }

        /** The user-facing text for a named refusal from the route or from the CLI's report. */
        fun refusalMessage(detail: String): String {
            val reason = detail.removePrefix("$INVALID:").trim()
            return if (reason.isEmpty()) "The server refused these seam regions."
            else "The server refused these seam regions: $reason"
        }
    }
}
