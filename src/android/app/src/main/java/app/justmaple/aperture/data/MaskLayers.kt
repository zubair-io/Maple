package app.justmaple.aperture.data

import org.json.JSONArray
import org.json.JSONObject

/** Normalised full-frame point: `x` across the oriented image, `y` down from its top. */
data class MaskPoint(val x: Float, val y: Float)

/** raw-core's mask shapes that Android authors (`mask_model.rs`). */
sealed interface MaskShape {
    val feather: Float
}

data class LinearMask(val start: MaskPoint, val end: MaskPoint, override val feather: Float) : MaskShape

data class RadialMask(
    val center: MaskPoint,
    val radii: MaskPoint,
    val angle: Float,
    override val feather: Float,
    val invert: Boolean,
) : MaskShape

enum class MaskCombine(val label: String) { Add("Add"), Subtract("Subtract"), Intersect("Intersect") }

/** One ordered group component; [source] is the mask leaf it was read from. */
data class MaskComponent(val shape: MaskShape, val combine: MaskCombine, val invert: Boolean, val source: Int? = null)

data class MaskGroup(val components: List<MaskComponent>, val opacity: Float, val invert: Boolean) : MaskShape {
    override val feather: Float
        get() = components.first().shape.feather
}

/**
 * One local-adjustment layer. [adjustments] and [range] are keyed by raw-core's field
 * names (`LocalMaskControls`); [slot] is the source correction it was read from, so
 * its unknown metadata travels with it when it is written back.
 */
data class MaskLayer(
    val shape: MaskShape,
    val adjustments: Map<String, Float> = emptyMap(),
    val range: Map<String, Float>? = null,
    val slot: Int? = null,
) {
    val edited: Int
        get() = adjustments.size
}

private fun JSONObject.point(key: String): MaskPoint =
    getJSONArray(key).let { MaskPoint(it.getDouble(0).toFloat(), it.getDouble(1).toFloat()) }

private fun MaskPoint.json() = JSONArray().put(x.toDouble()).put(y.toDouble())

private fun leaf(json: JSONObject): MaskShape =
    when (val kind = json.getString("kind")) {
        "linear" -> LinearMask(json.point("start"), json.point("end"), json.getDouble("feather").toFloat())
        "radial" -> RadialMask(json.point("center"), json.point("radii"), json.getDouble("angle").toFloat(),
            json.getDouble("feather").toFloat(), json.getBoolean("invert"))
        else -> error("Unsupported mask shape $kind")
    }

private fun numbers(json: JSONObject?): Map<String, Float>? =
    json?.let { values -> values.keys().asSequence().associateWith { values.getDouble(it).toFloat() } }

fun parseMaskLayers(json: String): List<MaskLayer> {
    val layers = JSONObject(json).getJSONArray("layers")
    return (0 until layers.length()).map { index ->
        val layer = layers.getJSONObject(index)
        val mask = layer.getJSONObject("mask")
        val shape =
            if (mask.getString("kind") == "group") {
                val components = mask.getJSONArray("components")
                MaskGroup(
                    (0 until components.length()).map {
                        val component = components.getJSONObject(it)
                        MaskComponent(
                            leaf(component.getJSONObject("mask")),
                            MaskCombine.valueOf(component.getString("combine")),
                            component.getBoolean("invert"),
                            if (component.isNull("source")) null else component.getInt("source"),
                        )
                    },
                    mask.getDouble("opacity").toFloat(),
                    mask.getBoolean("invert"),
                )
            } else leaf(mask)
        MaskLayer(
            shape,
            numbers(layer.optJSONObject("adjustments")).orEmpty(),
            numbers(layer.optJSONObject("range")),
            if (layer.isNull("slot")) null else layer.getInt("slot"),
        )
    }
}

private fun MaskShape.json(): JSONObject =
    when (this) {
        is LinearMask -> JSONObject().put("kind", "linear").put("start", start.json()).put("end", end.json())
            .put("feather", feather.toDouble())
        is RadialMask -> JSONObject().put("kind", "radial").put("center", center.json()).put("radii", radii.json())
            .put("angle", angle.toDouble()).put("feather", feather.toDouble()).put("invert", invert)
        is MaskGroup -> JSONObject().put("kind", "group").put("opacity", opacity.toDouble()).put("invert", invert)
            .put("components", JSONArray(components.map {
                JSONObject().put("combine", it.combine.name).put("invert", it.invert)
                    .put("source", it.source ?: JSONObject.NULL).put("mask", it.shape.json())
            }))
    }

private fun Map<String, Float>.json() = JSONObject().also { json -> forEach { (k, v) -> json.put(k, v.toDouble()) } }

fun MaskLayer.toJson(): JSONObject =
    JSONObject().put("slot", slot ?: JSONObject.NULL).put("mask", shape.json()).put("adjustments", adjustments.json())
        .put("range", range?.json() ?: JSONObject.NULL)

fun List<MaskLayer>.toJson(): JSONArray = JSONArray(map { it.toJson() })
