package app.justmaple.aperture.data

import org.json.JSONArray
import org.json.JSONObject

/** raw-core's `RetouchKind`, by its `crs:SpotType` spelling. */
enum class RepairKind(val wire: String, val label: String) { Heal("heal", "Heal"), Clone("clone", "Clone") }

/**
 * One clone / heal spot (`types::retouch`). [center] and [source] are normalised over the
 * upright full frame, like a mask point; [radius] is a fraction of the frame WIDTH (the disc
 * is a circle in pixels); [feather] is a fraction of the radius. [slot] is the sidecar entry
 * the spot was read from, so its unknown metadata travels with it when it is written back.
 */
data class RepairSpot(
    val kind: RepairKind,
    val center: MaskPoint,
    val source: MaskPoint,
    val radius: Float,
    val feather: Float,
    val opacity: Float,
    val slot: Int? = null,
)

/** raw-core's default spot size: 2 % of the frame width (`types::retouch::DEFAULT_RADIUS`). */
const val DEFAULT_REPAIR_RADIUS = .02f
/** raw-core's default soft edge: half the radius (`types::retouch::DEFAULT_FEATHER`). */
const val DEFAULT_REPAIR_FEATHER = .5f

private fun JSONObject.point(key: String): MaskPoint =
    getJSONArray(key).let { MaskPoint(it.getDouble(0).toFloat(), it.getDouble(1).toFloat()) }

private fun MaskPoint.json() = JSONArray().put(x.toDouble()).put(y.toDouble())

fun parseRepairSpots(json: String): List<RepairSpot> {
    val spots = JSONObject(json).getJSONArray("spots")
    return (0 until spots.length()).map { index ->
        val spot = spots.getJSONObject(index)
        val wire = spot.getString("kind")
        RepairSpot(
            RepairKind.entries.firstOrNull { it.wire == wire } ?: error("Unsupported repair spot kind $wire"),
            spot.point("center"),
            spot.point("source"),
            spot.getDouble("radius").toFloat(),
            spot.getDouble("feather").toFloat(),
            spot.getDouble("opacity").toFloat(),
            if (spot.isNull("slot")) null else spot.getInt("slot"),
        )
    }
}

fun RepairSpot.toJson(): JSONObject =
    JSONObject().put("kind", kind.wire).put("center", center.json()).put("source", source.json())
        .put("radius", radius.toDouble()).put("feather", feather.toDouble()).put("opacity", opacity.toDouble())
        .put("slot", slot ?: JSONObject.NULL)

fun List<RepairSpot>.toJson(): JSONArray = JSONArray(map { it.toJson() })
