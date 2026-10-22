package app.justmaple.aperture

import app.justmaple.aperture.generated.AdjustmentFields

/** Values and persisted provenance come from raw-core's one-shot illuminant analysis. */
data class WhiteBalanceRecommendation(val temperature: Float, val tint: Float, val algorithmVersion: Float) {
    init { require(temperature.isFinite() && tint.isFinite() && algorithmVersion.isFinite()) }
}

internal fun EditSnapshot.withAutoWhiteBalance(result: WhiteBalanceRecommendation): EditSnapshot {
    val recommended = mapOf(
        "temperature" to result.temperature, "tint" to result.tint,
        "wb_algorithm_version" to result.algorithmVersion, "wb_sample_x" to 0f, "wb_sample_y" to 0f,
    ).mapValues { (name, value) ->
        val field = AdjustmentFields.byName.getValue(name)
        value.coerceIn(field.minimum, field.maximum)
    }
    val updated = recommended.entries.fold(document) { doc, (name, value) ->
        doc.withField(AdjustmentFields.byName.getValue(name), value)
    }.withAttribute("crs:WhiteBalance", "Auto").withAttribute("papp:WbSource", "Auto")
    return copy(values = values + recommended, document = updated)
}
